/**
 * Generic WooCommerce Store API helpers.
 *
 * Many independent record stores run on WordPress + WooCommerce. WooCommerce
 * exposes a fully-public, no-auth Store API at:
 *
 *     /wp-json/wc/store/v1/products?per_page=100&page=N
 *
 * This is the WooCommerce equivalent of Shopify's `/products.json`. It returns
 * up to 100 products per page (WooCommerce's hard cap; lower than Shopify's
 * 250 but with no 25k-offset cap), reports the total count via the
 * `X-WP-Total` and `X-WP-TotalPages` response headers, and exposes a clean
 * structured shape: `id`, `name`, `sku`, `description`, `prices`,
 * `is_in_stock`, `permalink`, `categories`, `images`, etc.
 *
 * Each store's description schema is slightly different (label/year/format
 * are often packed into the description prose), so callers supply
 * `parseLabel` and (optionally) `parseArtistTitle` callbacks the same way as
 * the Shopify helper. WooCommerce stores generally don't include the artist
 * name as a structured field — `name` is just the release title — so the
 * default behaviour is `artist = ''`, which works in tandem with the
 * catno-first matcher in lib/scrapers.js.
 *
 * Usage:
 *     var wc = require('./woocommerce');
 *     var products = await wc.fetchAllProducts('https://www.example.com');
 *     var rows = products.map(function (p) {
 *         return wc.parseWcProduct(p, {
 *             storeKey: 'example',
 *             baseUrl: 'https://www.example.com',
 *             parseLabel: myLabelExtractor
 *         });
 *     });
 */

const https = require('https');
const http = require('http');
const url = require('url');

// WooCommerce Store API caps per_page at 100. Going higher returns a 400.
const DEFAULT_PER_PAGE = 100;
// 100 max pages × 100 per page = 10,000 products. Indie record stores rarely
// approach this (Octopus ~6k as of 2026). Override per caller via opts.maxPages
// if a larger catalog ever shows up.
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Fetch a JSON document from a URL and ALSO surface a few useful response
 * headers (WooCommerce reports total counts via X-WP-Total / X-WP-TotalPages).
 * Resolves with `{ body, headers }`, rejects on network/timeout/non-2xx.
 */
function fetchJsonWithHeaders(targetUrl, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
        var parsed = url.parse(targetUrl);
        var lib = parsed.protocol === 'http:' ? http : https;
        var reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path,
            method: 'GET',
            headers: {
                'User-Agent': opts.userAgent ||
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json,text/plain,*/*',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS
        };

        var req = lib.request(reqOpts, function (res) {
            var chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('end', function () {
                var body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('HTTP ' + res.statusCode + ' for ' + targetUrl));
                    return;
                }
                try {
                    resolve({ body: JSON.parse(body), headers: res.headers });
                } catch (e) {
                    reject(new Error('Invalid JSON from ' + targetUrl + ': ' + e.message));
                }
            });
        });

        req.on('error', function (e) { reject(e); });
        req.on('timeout', function () {
            req.destroy();
            reject(new Error('Timeout fetching ' + targetUrl));
        });
        req.end();
    });
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Paginate through `${baseUrl}/wp-json/wc/store/v1/products` and collect
 * every product. Stops as soon as a page returns fewer than `perPage` items
 * (last page) or the total page count from `X-WP-TotalPages` is reached.
 *
 * @param {string} baseUrl - e.g. 'https://www.octopusrecords.nyc'
 * @param {object} [opts]
 * @param {number} [opts.perPage=100]      - WC Store API hard-caps this at 100
 * @param {number} [opts.maxPages=100]     - safety cap to prevent runaway loops
 * @param {number} [opts.delayMs=250]      - polite delay between pages
 * @param {number} [opts.timeoutMs=20000]  - per-request timeout
 * @param {function} [opts.onProgress]     - called as fn({page, count, total, totalPages})
 * @returns {Promise<object[]>} array of raw WooCommerce product objects
 */
async function fetchAllProducts(baseUrl, opts) {
    opts = opts || {};
    var perPage = opts.perPage || DEFAULT_PER_PAGE;
    var maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
    var delayMs = opts.delayMs != null ? opts.delayMs : DEFAULT_DELAY_MS;
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var onProgress = opts.onProgress || function () {};

    var all = [];
    var base = baseUrl.replace(/\/+$/, '');
    var totalPagesHint = null;

    for (var page = 1; page <= maxPages; page++) {
        var pageUrl = base + '/wp-json/wc/store/v1/products?per_page=' + perPage + '&page=' + page;
        var res = await fetchJsonWithHeaders(pageUrl, { timeoutMs: timeoutMs });
        var batch = Array.isArray(res.body) ? res.body : [];

        if (totalPagesHint === null) {
            var hdr = res.headers && (res.headers['x-wp-totalpages'] || res.headers['X-WP-TotalPages']);
            var n = parseInt(hdr, 10);
            if (!isNaN(n) && n > 0) totalPagesHint = n;
        }

        if (batch.length === 0) {
            break;
        }

        all.push.apply(all, batch);
        onProgress({
            page: page,
            count: batch.length,
            total: all.length,
            totalPages: totalPagesHint
        });

        if (batch.length < perPage) {
            break;
        }
        if (totalPagesHint !== null && page >= totalPagesHint) {
            break;
        }

        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }

    return all;
}

/**
 * Decode common HTML entities (named + numeric). WordPress / WooCommerce
 * descriptions routinely contain encoded characters that Shopify's stripHtml
 * doesn't handle (e.g. `&#215;` for ×, `&#8243;` for ″, curly quotes, etc.)
 * because they're emitted by WordPress's wp_specialchars() filter.
 */
function decodeEntities(str) {
    if (!str) return '';
    return String(str)
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
            return String.fromCodePoint(parseInt(hex, 16));
        })
        .replace(/&#(\d+);/g, function (_, dec) {
            return String.fromCodePoint(parseInt(dec, 10));
        });
}

/**
 * Strip HTML tags, decode entities, and collapse whitespace. Mirrors
 * shopify.stripHtml but with the broader entity decoder above.
 */
function stripHtml(html) {
    if (!html) return '';
    return decodeEntities(
        String(html)
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<\/?[^>]+(>|$)/g, ' ')
    ).replace(/\s+/g, ' ').trim();
}

/**
 * Pull just the inner text of the first <p>...</p> block (or fall back to the
 * full stripped description if no <p> exists). Handy for stores like Octopus
 * that pack the structured "year, format, label" metadata into the opening
 * paragraph and use later paragraphs for prose.
 */
function firstParagraphText(html) {
    if (!html) return '';
    var m = String(html).match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (m) {
        return stripHtml(m[1]);
    }
    return stripHtml(html);
}

/**
 * Parse the lowest available USD price from a WooCommerce product.
 *
 * The Store API reports prices as integer minor-unit strings:
 *   "prices": { "price": "1850", "currency_minor_unit": 2, ... }
 *
 * meaning $18.50. This function returns a JS number in the major unit, or
 * null if the product has no usable price (free, private, etc).
 */
function parsePrice(product) {
    var prices = product.prices || {};
    var raw = prices.price;
    if (raw == null || raw === '') return null;
    var minor = parseInt(raw, 10);
    if (isNaN(minor) || minor <= 0) return null;
    var unit = prices.currency_minor_unit;
    var divisor = Math.pow(10, typeof unit === 'number' ? unit : 2);
    return minor / divisor;
}

function parseCurrency(product) {
    var prices = product.prices || {};
    return prices.currency_code || 'USD';
}

/**
 * Convert a WooCommerce product into the canonical `store_inventory` row.
 *
 * Defaults assume:
 *   - product.name is the release title (no embedded artist)
 *   - product.sku is the catalog number
 *   - artist is unknown (most WC record stores don't expose it as a field)
 *
 * Stores that DO expose artist (via custom meta or a parseable description
 * pattern) supply `ctx.parseArtistTitle({product, descriptionText})` returning
 * `{artist, title}`. Stores that pack label/year into the description supply
 * `ctx.parseLabel({product, descriptionText, firstParagraphText})` returning
 * `{label, catno?}`. The default catno is `product.sku`; parseLabel can
 * override it but typically doesn't need to.
 *
 * @param {object} product - raw WC Store API product
 * @param {object} ctx
 * @param {string} ctx.storeKey - short store identifier, e.g. 'octopus'
 * @param {string} ctx.baseUrl  - e.g. 'https://www.octopusrecords.nyc'
 * @param {function} [ctx.parseLabel]
 * @param {function} [ctx.parseArtistTitle]
 * @returns {object} normalized inventory row ready for upsertInventoryItem
 */
function parseWcProduct(product, ctx) {
    var descriptionText = stripHtml(product.description);
    var firstP = firstParagraphText(product.description);

    var artist = '';
    var title = product.name || '';
    if (typeof ctx.parseArtistTitle === 'function') {
        try {
            var override = ctx.parseArtistTitle({
                product: product,
                descriptionText: descriptionText,
                firstParagraphText: firstP
            });
            if (override && (override.artist || override.title)) {
                artist = (override.artist || artist || '').trim();
                title = (override.title || title || '').trim();
            }
        } catch (e) {
            // Bad override shouldn't kill the sync; keep defaults.
        }
    }
    // Always decode entities in the chosen title (product.name is HTML-encoded).
    title = decodeEntities(title);
    artist = decodeEntities(artist);

    var labelInfo = { label: null, catno: null };
    if (typeof ctx.parseLabel === 'function') {
        try {
            labelInfo = ctx.parseLabel({
                product: product,
                descriptionText: descriptionText,
                firstParagraphText: firstP
            }) || labelInfo;
        } catch (e) {
            labelInfo = { label: null, catno: null };
        }
    }

    var image = (product.images && product.images[0] && product.images[0].src) || null;
    var permalink = product.permalink || (
        ctx.baseUrl.replace(/\/+$/, '') + '/product/' + (product.slug || product.id)
    );

    var categories = (product.categories || []).map(function (c) {
        return decodeEntities(c.name || '');
    }).filter(Boolean);

    return {
        store: ctx.storeKey,
        productId: String(product.id),
        titleRaw: decodeEntities(product.name || ''),
        artist: artist,
        title: title,
        label: labelInfo.label,
        catno: labelInfo.catno || product.sku || null,
        vendor: null,
        productType: product.type || null,
        tags: categories,
        priceUsd: parsePrice(product),
        currency: parseCurrency(product),
        available: product.is_in_stock === true,
        url: permalink,
        imageUrl: image,
        storeUpdatedAt: null
    };
}

module.exports = {
    fetchJsonWithHeaders: fetchJsonWithHeaders,
    fetchAllProducts: fetchAllProducts,
    parseWcProduct: parseWcProduct,
    decodeEntities: decodeEntities,
    stripHtml: stripHtml,
    firstParagraphText: firstParagraphText,
    parsePrice: parsePrice,
    parseCurrency: parseCurrency
};
