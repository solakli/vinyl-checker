/**
 * Octopus Records NYC — independent vinyl store on WooCommerce/WordPress.
 *
 * Architecture mirrors ./gramaphone.js and ./further.js: nightly sync of the
 * full catalog into `store_inventory`, per-scan checks are pure SQLite lookups
 * + the existing fuzzy matchers from lib/scrapers.js (with catno-first
 * semantics — see lib/scrapers.js#matchInventoryRow).
 *
 * Catalog is ~6k products (as of 2026), well within WooCommerce's 100-per-page
 * pagination and free of any offset cap, so a full sync takes ~1 minute.
 *
 * Per-product data shape (from /wp-json/wc/store/v1/products):
 *   - name        → release title only (no embedded artist)
 *   - sku         → catalog number (always populated; ~1% are EAN barcodes)
 *   - description → first <p> is "YEAR[ reissue], FORMAT, LABEL." then prose
 *   - is_in_stock → boolean
 *   - prices.price → minor units (cents)
 *
 * KEY DIFFERENCE FROM SHOPIFY STORES: Octopus does NOT expose the artist as a
 * structured field. The artist appears in an <h2> on the product page or
 * embedded in the description prose. We deliberately ship without artist
 * data and rely on the catno-first matcher (see option A in the design
 * discussion) — catno is a stronger signal than artist+title for Discogs
 * wantlist items, which always include the catno. ~1% of items without a
 * Discogs catno will fall back to title-only fuzzy matching, which is
 * acceptable given the alternative (per-product HTML scraping) takes 10x
 * longer per sync.
 */

const wc = require('./woocommerce');
const db = require('../../db');

const STORE_KEY = 'octopus';
const STORE_NAME = 'Octopus Records NYC';
const BASE_URL = 'https://www.octopusrecords.nyc';
// Brooklyn, NY. USPS Media Mail single-LP from NYC is roughly $5-7. Real
// shipping cost depends on quantity and destination — we display this as a
// per-LP estimate for the UI's cost-comparison column. Refine if needed.
const US_SHIPPING = '$6.00';

// Categories whose products are not vinyl records and should be excluded from
// the inventory mirror. Discovered via reconnaissance — the only non-vinyl
// category in active use is the CD/8-track grab-bag.
const EXCLUDE_CATEGORY_NAMES = new Set([
    'Other Media / CD / 8 Track'
]);

// Decoded entity form of the same name (some categories surface with HTML
// entities still in them). We compare against the decoded category name in
// shouldInclude so this stays robust to either shape.
EXCLUDE_CATEGORY_NAMES.add(wc.decodeEntities('Other Media / CD / 8 Track'));

// ─── Description parsing ─────────────────────────────────────────────────────

// First paragraph of every Octopus description follows the pattern:
//
//   YEAR[ qualifier], FORMAT, LABEL[. ...]
//
// Examples (from live recon):
//   "2026, 2×12″ LP, Mister Saturday Night Records."
//   "2026 reissue, 2×12″ LP, Nonesuch."
//   "2025, 12″ EP, Phantasy Sound"          (no trailing period)
//   "2025, 12″ compilation EP, Brooklyn Sway. NYC house/techno label."
//   "2020 reissue, 12″ LP, Mutant/Masterworks/Proximity Media."
//
// The label is the third comma-separated chunk, terminated by either a period
// or the end of the string (handles both punctuated and unpunctuated forms).
const FIRST_P_REGEX = /^(\d{4})(?:\s+[a-zA-Z]+)?\s*,\s*([^,]+?)\s*,\s*([^.]+?)\s*(?:\.|$)/;

function parseLabel(ctx) {
    var firstP = ctx.firstParagraphText || '';
    var m = firstP.match(FIRST_P_REGEX);
    if (m) {
        return {
            label: cleanField(m[3]),
            // catno comes from product.sku — woocommerce.parseWcProduct uses
            // it as the fallback when we return null here. Keeping it null
            // also means a future label-formatting change can't accidentally
            // overwrite the more authoritative SKU.
            catno: null
        };
    }
    return { label: null, catno: null };
}

function parseYear(firstP) {
    if (!firstP) return null;
    var m = firstP.match(/^(\d{4})\b/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    if (n < 1900 || n > 2100) return null;
    return n;
}

function cleanField(s) {
    if (!s) return null;
    var trimmed = String(s).replace(/\s+/g, ' ').trim();
    if (!trimmed) return null;
    trimmed = trimmed.replace(/[\s.,;:]+$/, '');
    return trimmed || null;
}

function shouldInclude(rawProduct) {
    // Skip variable products defensively — Octopus only uses 'simple' as of
    // 2026 (confirmed across 230 sampled products), but if they ever start
    // selling configurable items we'd want to revisit before mirroring.
    if (rawProduct.type && rawProduct.type !== 'simple') return false;

    // Must have a SKU to be useful for catno-first matching.
    if (!rawProduct.sku) return false;

    var cats = rawProduct.categories || [];
    for (var i = 0; i < cats.length; i++) {
        if (EXCLUDE_CATEGORY_NAMES.has(cats[i].name)) return false;
    }
    return true;
}

// ─── Sync ────────────────────────────────────────────────────────────────────
/**
 * Pull the full Octopus Records catalog and upsert into `store_inventory`.
 * Items not seen during this sync are marked unavailable (not deleted).
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress] - fn({phase, page, count, total, ...})
 * @returns {Promise<object>} stats { seen, added, updated, markedUnavailable, durationMs }
 */
async function syncOctopus(opts) {
    opts = opts || {};
    var startedIso = new Date().toISOString();
    var startedAt = Date.now();
    var syncId = db.startStoreSync(STORE_KEY);
    var onProgress = opts.onProgress || function () {};

    try {
        var rawProducts = await wc.fetchAllProducts(BASE_URL, {
            perPage: 100,
            maxPages: 100,
            delayMs: 250,
            onProgress: function (p) {
                onProgress({
                    phase: 'fetch',
                    page: p.page,
                    count: p.count,
                    total: p.total,
                    totalPages: p.totalPages || null
                });
            }
        });

        var rows = [];
        for (var i = 0; i < rawProducts.length; i++) {
            if (!shouldInclude(rawProducts[i])) continue;
            rows.push(wc.parseWcProduct(rawProducts[i], {
                storeKey: STORE_KEY,
                baseUrl: BASE_URL,
                parseLabel: parseLabel
            }));
        }

        onProgress({ phase: 'upsert', count: rows.length });
        var upsertStats = db.upsertInventoryBatch(rows);
        var marked = db.markStaleInventoryUnavailable(STORE_KEY, startedIso);

        var stats = {
            seen: upsertStats.seen,
            added: upsertStats.added,
            updated: upsertStats.updated,
            markedUnavailable: marked,
            durationMs: Date.now() - startedAt
        };
        db.finishStoreSync(syncId, stats);
        onProgress({ phase: 'done', stats: stats });
        return stats;
    } catch (e) {
        db.finishStoreSync(syncId, {
            seen: 0, added: 0, updated: 0, markedUnavailable: 0,
            error: e.message
        });
        throw e;
    }
}

// ─── Per-item check ──────────────────────────────────────────────────────────
// Lazy require to avoid a circular import with lib/scrapers.js.
var _scrapers = null;
function getScrapers() {
    if (!_scrapers) _scrapers = require('../scrapers');
    return _scrapers;
}

function buildSearchUrl(item) {
    var q = item.searchQuery || ((item.artist || '') + ' ' + (item.title || '')).trim();
    return BASE_URL + '/?s=' + encodeURIComponent(q) + '&post_type=product';
}

/**
 * Match a single wantlist item against our locally-synced Octopus inventory.
 * `_page` is ignored — pure DB lookup, signature kept consistent with the
 * Puppeteer-backed checkers so checkItem() in lib/scrapers.js can call it
 * uniformly.
 */
async function checkOctopus(_page, item) {
    var searchUrl = buildSearchUrl(item);

    try {
        var s = getScrapers();
        var inventory = db.getInStockInventory(STORE_KEY);

        if (inventory.length === 0) {
            return {
                store: STORE_NAME,
                inStock: false,
                matches: [],
                searchUrl: searchUrl,
                linkOnly: true,
                usShipping: US_SHIPPING
            };
        }

        var matches = [];
        for (var i = 0; i < inventory.length; i++) {
            var row = inventory[i];
            if (s.matchInventoryRow(item, row)) {
                matches.push(toMatch(row));
            }
        }

        console.log('[Octopus] "' + (item.searchQuery || item.title) + '" → '
            + inventory.length + ' in-stock indexed, ' + matches.length + ' matches');

        return {
            store: STORE_NAME,
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl,
            usShipping: US_SHIPPING
        };
    } catch (e) {
        console.log('[Octopus] ERROR "' + (item.searchQuery || item.title) + '": ' + e.message);
        return {
            store: STORE_NAME,
            inStock: false,
            matches: [],
            error: e.message,
            searchUrl: searchUrl,
            usShipping: US_SHIPPING
        };
    }
}

function toMatch(row) {
    return {
        artist: row.artist || '',
        title: row.title || row.title_raw || '',
        price: row.price_usd != null ? '$' + row.price_usd.toFixed(2) : '',
        label: row.label || '',
        catno: row.catno || '',
        url: row.url || ''
    };
}

module.exports = {
    STORE_KEY: STORE_KEY,
    STORE_NAME: STORE_NAME,
    BASE_URL: BASE_URL,
    syncOctopus: syncOctopus,
    checkOctopus: checkOctopus,
    parseLabel: parseLabel,
    parseYear: parseYear,
    shouldInclude: shouldInclude
};
