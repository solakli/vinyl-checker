/**
 * Hardwax (Berlin) — new arrivals scraper.
 *
 * Hardwax serves plain server-rendered HTML — no Puppeteer needed.
 * We scrape their genre section pages (house, techno, ambient, etc.)
 * and store results in store_inventory so the recommendation engine
 * and optimizer pick them up automatically.
 *
 * Genre is inferred from which section page the item appeared on.
 * ~15 genre pages × ~50 items per page = ~750 fresh records per sync.
 * Average sync time: 15–30s (network-bound).
 *
 * HTML selectors (verified April 2026):
 *   Record ID   : div.ps.pv[id]              e.g. "record-87666"
 *   Product URL : div.ae > a.an[href]         relative
 *   Artist      : h2.rm span.ro a.rn          (strip trailing colon)
 *   Title       : h2.rm span.ro span.rp
 *   Label       : div.qu div.qv > a:first     (text)
 *   Catno       : div.qu div.qv > a:last      (text = catalog number)
 *   Price       : span.qq.tv                  "€ 12"
 *   Format      : span.rf                     "12\"" / "Do LP" / "EP"
 *   Cover image : div.ae img.aj:first src     media.hardwax.com/images/{id}x.jpg
 *   Description : p.qt                        short editorial blurb
 */

'use strict';

const https = require('https');
const db    = require('../../db');

const STORE_KEY  = 'hardwax';
const STORE_NAME = 'Hardwax';
const BASE_URL   = 'https://hardwax.com';

// EUR → USD approximate rate (updated in store-optimizer.js too)
const EUR_TO_USD = 1.09;

// Genre section pages to scrape.  Key = URL path, value = tag labels to store.
const GENRE_SECTIONS = [
    { path: '/',              tags: ['New'] },
    { path: '/house/',        tags: ['House', 'Electronic'] },
    { path: '/techno/',       tags: ['Techno', 'Electronic'] },
    { path: '/electro/',      tags: ['Electro', 'Electronic'] },
    { path: '/ambient/',      tags: ['Ambient', 'Electronic'] },
    { path: '/hiphop/',       tags: ['Hip-Hop'] },
    { path: '/jazz/',         tags: ['Jazz'] },
    { path: '/soul-funk/',    tags: ['Soul', 'Funk'] },
    { path: '/experimental/', tags: ['Experimental', 'Electronic'] },
    { path: '/industrial/',   tags: ['Industrial', 'Electronic'] },
    { path: '/drum-bass/',    tags: ['Drum & Bass', 'Electronic'] },
    { path: '/reggae/',       tags: ['Reggae'] },
    { path: '/disco/',        tags: ['Disco', 'Electronic'] },
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function fetchPage(path) {
    return new Promise(function (resolve, reject) {
        var opts = {
            hostname: 'hardwax.com',
            path:     path,
            headers:  {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
                'Accept':     'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        };
        https.get(opts, function (res) {
            if (res.statusCode === 301 || res.statusCode === 302) {
                // follow redirect
                return fetchPage(res.headers.location || path).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + path));
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
        }).on('error', reject);
    });
}

// ─── HTML parser ─────────────────────────────────────────────────────────────
// No cheerio — use targeted regex on Hardwax's clean, stable HTML structure.

function extractText(html, openTag, closeTag) {
    var start = html.indexOf(openTag);
    if (start === -1) return '';
    start += openTag.length;
    var end = html.indexOf(closeTag, start);
    if (end === -1) return '';
    // Strip any remaining HTML tags from the extracted fragment
    return html.slice(start, end).replace(/<[^>]+>/g, '').trim();
}

function extractAttr(html, tag, attr) {
    // Find tag like <a href="..."> and return attr value
    var re = new RegExp('<' + tag + '[^>]*\\s' + attr + '=["\']([^"\']*)["\']', 'i');
    var m  = html.match(re);
    return m ? m[1] : '';
}

function decodeEntities(s) {
    return s
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g,  "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—')
        .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

/**
 * Parse all product articles from a Hardwax page HTML string.
 * Returns an array of normalised record objects.
 */
function parseProducts(html, sectionTags) {
    var products = [];

    // Split into article blocks — each record lives in <article class="co cq px">
    var articleRe = /<article[^>]*class="[^"]*px[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
    var match;

    while ((match = articleRe.exec(html)) !== null) {
        var art = match[1];

        try {
            // Record ID from div.ps.pv[id="record-XXXXX"]
            var idMatch = art.match(/id="record-(\d+)"/);
            if (!idMatch) continue;
            var recordId = idMatch[1];

            // Product URL from div.ae > a.an
            var urlMatch = art.match(/class="an"\s+href="([^"]+)"|href="([^"]+)"\s+class="an"/);
            var relPath  = urlMatch ? (urlMatch[1] || urlMatch[2]) : ('/'+recordId+'/');
            var productUrl = BASE_URL + relPath;

            // Cover image: first img.aj inside div.ae
            var imgMatch = art.match(/<img[^>]*class="[^"]*aj[^"]*"[^>]*src="([^"]+)"/);
            var imageUrl = imgMatch ? imgMatch[1] : '';
            // Prefer the "x" variant (larger) over "a" variant
            if (imageUrl && imageUrl.match(/\/images\/\d+a\.jpg/)) {
                imageUrl = imageUrl.replace(/\/images\/(\d+)a\.jpg/, '/images/$1x.jpg');
            }

            // Artist: h2.rm span.ro a.rn text (strip trailing colon+space)
            var artistMatch = art.match(/class="rn"[^>]*>([^<]+)<\/a>/);
            var artist = artistMatch ? decodeEntities(artistMatch[1].replace(/:$/, '').trim()) : '';

            // Title: span.rp text
            var titleMatch = art.match(/class="rp">([^<]+)<\/span>/);
            var title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';

            if (!artist && !title) continue;

            // Label + Catno: first and last <a> inside div.qu div.qv
            var quMatch = art.match(/class="qu"[^>]*>([\s\S]*?)(?=<\/div>\s*<\/div>)/);
            var label = '', catno = '';
            if (quMatch) {
                var qvHtml = quMatch[1];
                // all <a> tags in qv
                var links = [];
                var linkRe = /<a[^>]*>([^<]*)<\/a>/g;
                var lm;
                while ((lm = linkRe.exec(qvHtml)) !== null) {
                    var t = lm[1].trim();
                    if (t && t !== 'Label Catalog') links.push(t);
                }
                if (links.length >= 1) label = decodeEntities(links[0]);
                if (links.length >= 2) catno = decodeEntities(links[1]);
            }

            // Price: span.qq.tv text like "€ 12"
            var priceMatch = art.match(/class="[^"]*qq[^"]*tv[^"]*">([^<]+)<\/span>/);
            var priceRaw   = priceMatch ? priceMatch[1].trim() : '';
            var priceEur   = parseFloat(priceRaw.replace(/[^0-9.,]/g, '').replace(',', '.')) || null;
            var priceUsd   = priceEur !== null ? Math.round(priceEur * EUR_TO_USD * 100) / 100 : null;

            // Format: span.rf text
            var fmtMatch = art.match(/class="[^"]*rf[^"]*">([^<]+)<\/span>/);
            var format   = fmtMatch ? fmtMatch[1].trim() : '';

            // Description blurb: p.qt
            var descMatch = art.match(/class="qt">([^<]*)<\/p>/);
            var blurb     = descMatch ? decodeEntities(descMatch[1].trim()) : '';

            // Tags: from section + format
            var tags = sectionTags.slice();
            if (format && format !== '—') tags.push(format);

            products.push({
                store:        STORE_KEY,
                product_id:   recordId,
                title_raw:    artist + ' - ' + title,
                artist:       artist,
                title:        title,
                label:        label,
                catno:        catno,
                vendor:       '',
                product_type: 'Vinyl',
                tags:         JSON.stringify(tags),
                price_usd:    priceUsd,
                currency:     'EUR',
                available:    1,
                url:          productUrl,
                image_url:    imageUrl,
                store_updated_at: new Date().toISOString(),
            });
        } catch (e) {
            // Skip malformed articles
        }
    }

    return products;
}

// ─── Sync ─────────────────────────────────────────────────────────────────────
/**
 * Scrape all genre sections and upsert results into store_inventory.
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress]  fn({ section, done, total, count })
 * @returns {Promise<object>} stats
 */
async function syncHardwax(opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var startedAt  = Date.now();
    var startedIso = new Date().toISOString();
    var syncId     = db.startStoreSync(STORE_KEY);

    try {
        var sections = GENRE_SECTIONS;
        var allProducts = {};   // keyed by product_id for dedup
        var done = 0;

        for (var i = 0; i < sections.length; i++) {
            var section = sections[i];
            onProgress({ phase: 'fetch', section: section.path, done: done, total: sections.length });
            try {
                var html     = await fetchPage(section.path);
                var products = parseProducts(html, section.tags);

                // Merge tags if product appears in multiple genre sections
                products.forEach(function (p) {
                    if (allProducts[p.product_id]) {
                        var existing = allProducts[p.product_id];
                        var existingTags = JSON.parse(existing.tags || '[]');
                        var newTags      = JSON.parse(p.tags || '[]');
                        var merged = Array.from(new Set(existingTags.concat(newTags)));
                        existing.tags = JSON.stringify(merged);
                    } else {
                        allProducts[p.product_id] = p;
                    }
                });

                console.log('[Hardwax] ' + section.path + ' → ' + products.length + ' products');
            } catch (e) {
                console.error('[Hardwax] Failed to fetch ' + section.path + ':', e.message);
            }
            done++;
            // Be polite to Hardwax
            await new Promise(function (r) { setTimeout(r, 800); });
        }

        var rows = Object.values(allProducts);
        onProgress({ phase: 'upsert', count: rows.length });

        var upsertStats = db.upsertInventoryBatch(rows);
        // Mark anything we didn't see this sync as unavailable
        var marked = db.markStaleInventoryUnavailable(STORE_KEY, startedIso);

        var stats = {
            seen:               upsertStats.seen,
            added:              upsertStats.added,
            updated:            upsertStats.updated,
            markedUnavailable:  marked,
            durationMs:         Date.now() - startedAt,
        };
        db.finishStoreSync(syncId, stats);
        onProgress({ phase: 'done', stats: stats });
        return stats;

    } catch (e) {
        db.finishStoreSync(syncId, { seen: 0, added: 0, updated: 0, markedUnavailable: 0, error: e.message });
        throw e;
    }
}

// ─── Per-item check (local lookup) ───────────────────────────────────────────
var _scrapers = null;
function getScrapers() {
    if (!_scrapers) _scrapers = require('../scrapers');
    return _scrapers;
}

function buildSearchUrl(item) {
    var q = item.searchQuery || ((item.artist || '') + ' ' + (item.title || '')).trim();
    return BASE_URL + '/search/?q=' + encodeURIComponent(q);
}

async function checkHardwax(_page, item) {
    var searchUrl = buildSearchUrl(item);
    try {
        var s         = getScrapers();
        var inventory = db.getInStockInventory(STORE_KEY);
        if (inventory.length === 0) {
            return { store: STORE_NAME, inStock: false, matches: [], searchUrl: searchUrl, linkOnly: true };
        }
        var matches = inventory.filter(function (row) { return s.matchInventoryRow(item, row); })
            .map(function (row) {
                return {
                    artist: row.artist || '',
                    title:  row.title  || row.title_raw || '',
                    price:  row.price_usd != null ? '€' + (row.price_usd / EUR_TO_USD).toFixed(0) : '',
                    label:  row.label  || '',
                    catno:  row.catno  || '',
                    url:    row.url    || '',
                };
            });
        return { store: STORE_NAME, inStock: matches.length > 0, matches: matches, searchUrl: searchUrl };
    } catch (e) {
        return { store: STORE_NAME, inStock: false, matches: [], error: e.message, searchUrl: searchUrl };
    }
}

module.exports = {
    STORE_KEY:    STORE_KEY,
    STORE_NAME:   STORE_NAME,
    BASE_URL:     BASE_URL,
    syncHardwax:  syncHardwax,
    checkHardwax: checkHardwax,
};
