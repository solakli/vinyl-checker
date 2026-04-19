/**
 * Generic Shopify storefront helpers.
 *
 * Most independent record stores in the US run on Shopify. They expose their
 * full product catalog via a public `/products.json` endpoint that paginates
 * up to 250 products per page. We use this to maintain a local mirror of each
 * store's catalog and match wantlist items against it without hitting the
 * store on every scan.
 *
 * Each store's body_html schema is slightly different, so callers supply
 * `parseLabel` and (optionally) `parseArtistTitle` callbacks. For stores that
 * format body_html as a list of "Field: value" entries (Further Records, etc.),
 * use `parseStructuredFields` to pluck the values cleanly.
 *
 * Usage:
 *     var shopify = require('./shopify');
 *     var products = await shopify.fetchAllProducts('https://example.com');
 *     var rows = products.map(function (p) {
 *         return shopify.parseShopifyProduct(p, {
 *             storeKey: 'example',
 *             baseUrl: 'https://example.com',
 *             parseLabel: myLabelExtractor
 *         });
 *     });
 */

const https = require('https');
const http = require('http');
const url = require('url');

const DEFAULT_PER_PAGE = 250;
// 250 max pages × 250 per page = 62,500 product safety cap. Far above any
// indie record store's catalog (Gramaphone ~6k, Further ~25k). Override per
// caller via opts.maxPages if a larger store ever shows up.
const DEFAULT_MAX_PAGES = 250;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 20000;

// Shopify's storefront /products.json caps total offset (page * limit) at
// 25,000 products. Past that the API responds with HTTP 400 and the body
// `{"errors":"Page * Limit exceeds the 25000 limit."}`. We treat that as a
// graceful end-of-catalog (e.g. for stores like Further that resell larger
// distributor feeds), not as a fatal error. A future enhancement would be
// `since_id` cursor pagination which bypasses the cap.
function isShopifyOffsetCapError(statusCode, body) {
    if (statusCode !== 400) return false;
    return /Page\s*\*\s*Limit\s*exceeds/i.test(body || '');
}

class OffsetCapError extends Error {
    constructor() {
        super('Shopify 25,000-product offset cap reached');
        this.name = 'OffsetCapError';
        this.offsetCap = true;
    }
}

class RateLimitError extends Error {
    constructor(retryAfter, targetUrl) {
        super('HTTP 429 for ' + targetUrl);
        this.name = 'RateLimitError';
        this.rateLimit = true;
        // Shopify sends Retry-After in seconds; default to 60 if missing.
        this.retryAfterMs = (retryAfter || 60) * 1000;
    }
}

/**
 * Fetch a JSON document from a URL with realistic browser headers.
 * Resolves with the parsed JSON body, rejects on network/timeout/non-2xx errors.
 *
 * Shopify's "offset cap" 400 is rejected with an `OffsetCapError` (caller can
 * inspect `err.offsetCap === true`) so pagination loops can stop cleanly.
 */
function fetchJson(targetUrl, opts) {
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
                    if (isShopifyOffsetCapError(res.statusCode, body)) {
                        reject(new OffsetCapError());
                        return;
                    }
                    if (res.statusCode === 429) {
                        var retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
                        reject(new RateLimitError(retryAfter, targetUrl));
                        return;
                    }
                    if (res.statusCode === 503) {
                        // Transient Shopify overload — treat like a rate limit but
                        // shorter wait (30 s) since 503 rarely comes with Retry-After.
                        var ra503 = parseInt(res.headers['retry-after'] || '30', 10);
                        reject(new RateLimitError(ra503, targetUrl));
                        return;
                    }
                    reject(new Error('HTTP ' + res.statusCode + ' for ' + targetUrl));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
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
 * Paginate through `${baseUrl}/products.json` and collect every product.
 *
 * @param {string} baseUrl - e.g. 'https://gramaphonerecords.com'
 * @param {object} [opts]
 * @param {number} [opts.perPage=250]      - Shopify hard-caps this at 250
 * @param {number} [opts.maxPages=50]      - safety cap to prevent runaway loops
 * @param {number} [opts.delayMs=250]      - polite delay between pages
 * @param {number} [opts.timeoutMs=20000]  - per-request timeout
 * @param {function} [opts.onProgress]     - called as fn({page, count, total})
 * @returns {Promise<object[]>} array of raw Shopify product objects
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

    for (var page = 1; page <= maxPages; page++) {
        var pageUrl = base + '/products.json?limit=' + perPage + '&page=' + page;
        var data;

        // Retry up to 3 times on 429 rate-limit responses, honouring Retry-After.
        var maxRetries = 3;
        for (var attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                data = await fetchJson(pageUrl, { timeoutMs: timeoutMs });
                break; // success
            } catch (e) {
                if (e && e.offsetCap) {
                    // Shopify's 25k-offset cap — stop cleanly.
                    onProgress({ page: page, count: 0, total: all.length, offsetCap: true });
                    return all;
                }
                if (e && e.rateLimit && attempt < maxRetries) {
                    console.warn('[shopify] 429 on ' + pageUrl +
                        ' — waiting ' + (e.retryAfterMs / 1000) + 's (attempt ' + (attempt + 1) + '/' + maxRetries + ')');
                    await sleep(e.retryAfterMs);
                    continue;
                }
                throw e;
            }
        }
        var batch = (data && data.products) || [];

        if (batch.length === 0) {
            break;
        }

        all.push.apply(all, batch);
        onProgress({ page: page, count: batch.length, total: all.length });

        if (batch.length < perPage) {
            // Last page is partial — we're done.
            break;
        }

        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }

    return all;
}

/**
 * Split a "Artist - Title" combined string into separate fields.
 *
 * Splits on the FIRST " - " separator (with surrounding spaces). This handles
 * titles where the track or release name itself contains a hyphen, e.g.
 * "ex_libris - ex_libris - 003" → artist="ex_libris", title="ex_libris - 003".
 *
 * Strings without " - " (e.g. "Slipmat Pack") return artist="" and title=full.
 */
function splitArtistTitle(combined) {
    if (!combined || typeof combined !== 'string') {
        return { artist: '', title: '' };
    }
    var trimmed = combined.trim();
    var idx = trimmed.indexOf(' - ');
    if (idx === -1) {
        return { artist: '', title: trimmed };
    }
    return {
        artist: trimmed.substring(0, idx).trim(),
        title: trimmed.substring(idx + 3).trim()
    };
}

/**
 * Strip HTML tags from a string and collapse whitespace.
 * Used to make Shopify body_html searchable / loggable.
 */
function stripHtml(html) {
    if (!html) return '';
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract structured "Field: value" pairs from a stripped body_text.
 *
 * Many Shopify record stores format their product descriptions as a list of
 * fields delimited by either commas, semicolons, or HTML <br> tags (which
 * collapse to spaces in stripHtml). This walks the text once and pulls every
 * requested field's value, stopping at the next field keyword.
 *
 * Example:
 *   parseStructuredFields(
 *     "Artist: Foo Title: Bar Label: Baz Catalog: BAZ001 Format: 12\"",
 *     ['Artist', 'Title', 'Label', 'Catalog', 'Format']
 *   )
 *   => { Artist: 'Foo', Title: 'Bar', Label: 'Baz', Catalog: 'BAZ001', Format: '12"' }
 *
 * Fields that aren't found are omitted from the returned object. Field names
 * are matched case-insensitively but returned with the casing the caller passed.
 *
 * @param {string} text - already stripped via stripHtml
 * @param {string[]} fieldNames - names to extract, e.g. ['Artist', 'Label']
 * @returns {Object<string,string>} map of fieldName -> trimmed value
 */
function parseStructuredFields(text, fieldNames) {
    if (!text || !Array.isArray(fieldNames) || fieldNames.length === 0) {
        return {};
    }
    var escaped = fieldNames.map(function (n) {
        return n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    });
    // Build "(?:Field1|Field2|...):" lookahead so each capture stops at the
    // next known field (or end of string).
    var stopGroup = '(?:' + escaped.join('|') + ')\\s*:';
    var result = {};
    fieldNames.forEach(function (name, idx) {
        var pattern = new RegExp(
            '\\b' + escaped[idx] + '\\s*:\\s*([\\s\\S]*?)(?=\\s+' + stopGroup + '|$)',
            'i'
        );
        var m = text.match(pattern);
        if (m && m[1]) {
            var value = m[1].trim().replace(/[,;]+$/, '').trim();
            if (value) {
                result[name] = value;
            }
        }
    });
    return result;
}

/**
 * Parse the lowest available USD price from a Shopify product's variants.
 * Shopify reports prices as strings (e.g. "16.50"). Returns null if unset.
 */
function parsePrice(product) {
    var variants = product.variants || [];
    if (variants.length === 0) return null;
    var prices = variants
        .map(function (v) { return parseFloat(v.price); })
        .filter(function (p) { return !isNaN(p) && p > 0; });
    if (prices.length === 0) return null;
    return Math.min.apply(null, prices);
}

/**
 * Determine whether ANY variant of a product is in stock.
 * Shopify exposes `available` per variant and on the product itself. We trust
 * the variant-level field because some stores leave the product-level cached.
 */
function isAvailable(product) {
    var variants = product.variants || [];
    return variants.some(function (v) { return v.available === true; });
}

/**
 * Convert a Shopify product into the canonical `store_inventory` row shape.
 *
 * The `parseLabel` callback is store-specific because each Shopify store
 * formats label/catno differently (some put it in tags, some in body_html,
 * some in a metafield). It receives `{ product, bodyText }` and should
 * return `{ label, catno }` (either may be null).
 *
 * @param {object} product - raw Shopify product
 * @param {object} ctx
 * @param {string} ctx.storeKey - short store identifier, e.g. 'gramaphone'
 * @param {string} ctx.baseUrl  - e.g. 'https://gramaphonerecords.com'
 * @param {function} [ctx.parseLabel] - returns {label, catno}
 * @param {function} [ctx.parseArtistTitle] - returns {artist, title} when the
 *   store has a more authoritative source than splitting the combined title
 *   (e.g. structured `Artist:` / `Title:` fields in body_html). Falls back to
 *   the default split if the callback returns null/undefined or throws.
 * @returns {object} normalized inventory row ready for upsertInventoryItem
 */
function parseShopifyProduct(product, ctx) {
    var bodyText = stripHtml(product.body_html);

    var split = splitArtistTitle(product.title);
    if (typeof ctx.parseArtistTitle === 'function') {
        try {
            var override = ctx.parseArtistTitle({ product: product, bodyText: bodyText });
            if (override && (override.artist || override.title)) {
                split = {
                    artist: (override.artist || split.artist || '').trim(),
                    title: (override.title || split.title || '').trim()
                };
            }
        } catch (e) {
            // Bad override shouldn't kill the sync; keep the default split.
        }
    }

    var labelInfo = { label: null, catno: null };
    if (typeof ctx.parseLabel === 'function') {
        try {
            labelInfo = ctx.parseLabel({ product: product, bodyText: bodyText }) || labelInfo;
        } catch (e) {
            // Don't let a bad label parser kill the whole sync.
            labelInfo = { label: null, catno: null };
        }
    }

    var image = (product.images && product.images[0] && product.images[0].src) ||
        (product.image && product.image.src) || null;

    return {
        store: ctx.storeKey,
        productId: String(product.id),
        titleRaw: product.title,
        artist: split.artist,
        title: split.title,
        label: labelInfo.label,
        catno: labelInfo.catno,
        vendor: product.vendor || null,
        productType: product.product_type || null,
        tags: Array.isArray(product.tags)
            ? product.tags
            : (product.tags ? String(product.tags).split(',').map(function (t) { return t.trim(); }) : []),
        priceUsd: parsePrice(product),
        currency: 'USD',
        available: isAvailable(product),
        url: ctx.baseUrl.replace(/\/+$/, '') + '/products/' + product.handle,
        imageUrl: image,
        storeUpdatedAt: product.updated_at || null
    };
}

module.exports = {
    fetchJson: fetchJson,
    fetchAllProducts: fetchAllProducts,
    parseShopifyProduct: parseShopifyProduct,
    splitArtistTitle: splitArtistTitle,
    stripHtml: stripHtml,
    parseStructuredFields: parseStructuredFields,
    parsePrice: parsePrice,
    isAvailable: isAvailable
};
