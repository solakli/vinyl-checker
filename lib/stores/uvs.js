/**
 * Underground Vinyl Source (UVS) — US independent record store on Shopify.
 *
 * Architecture: catalog-mirror (same pattern as Gramaphone).
 *   1. Once a day, syncUVS() pulls the full /products.json catalog into
 *      the `store_inventory` table.
 *   2. Per-scan, checkUVS() does a fast local SQLite lookup — no HTTP per
 *      item, no Puppeteer.
 *
 * UVS product titles follow the "Artist - Title" convention so splitArtistTitle
 * handles the split cleanly. Their Shopify descriptions don't have a structured
 * label/catno field, so we skip label parsing and rely solely on artist/title
 * fuzzy matching.
 */

const shopify = require('./shopify');
const db = require('../../db');

const STORE_KEY = 'uvs';
const STORE_NAME = 'Underground Vinyl';
const BASE_URL = 'https://undergroundvinylsource.com';
const US_SHIPPING = '$5.00';

// Product types we know are NOT vinyl records.
// UVS's product_type field tends to be sparse / blank for records, so we err
// on the side of inclusion and only exclude things that are clearly non-vinyl.
const NON_RECORD_TYPES = new Set([
    'Slipmat',
    'Books',
    'T-Shirt',
    'Shirt',
    'Hoodie',
    'Sweatshirt',
    'Vinyl Care',
    'Cleaning',
    'Record Bag',
    'Bag',
    'Decor',
    'Gift Card',
    'CD',
    'Cassette',
    'DVD',
    'Accessories',
    'Apparel'
]);

function shouldInclude(rawProduct) {
    var type = (rawProduct.product_type || '').trim();
    if (!type) return true; // blank product_type → assume it's a record
    return !NON_RECORD_TYPES.has(type);
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Pull the full UVS catalog and upsert it into `store_inventory`.
 * Items not seen during this sync are marked unavailable (not deleted).
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress] - fn({phase, page, count, total, stats})
 * @returns {Promise<object>} stats { seen, added, updated, markedUnavailable, durationMs }
 */
async function syncUVS(opts) {
    opts = opts || {};
    var startedIso = new Date().toISOString();
    var startedAt = Date.now();
    var syncId = db.startStoreSync(STORE_KEY);
    var onProgress = opts.onProgress || function () {};

    try {
        var rawProducts = await shopify.fetchAllProducts(BASE_URL, {
            perPage: 250,
            delayMs: 300,
            onProgress: function (p) {
                onProgress({ phase: 'fetch', page: p.page, count: p.count, total: p.total });
            }
        });

        var rows = [];
        for (var i = 0; i < rawProducts.length; i++) {
            if (!shouldInclude(rawProducts[i])) continue;
            rows.push(shopify.parseShopifyProduct(rawProducts[i], {
                storeKey: STORE_KEY,
                baseUrl: BASE_URL
                // No parseLabel — UVS descriptions don't have structured label/catno
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

// Lazy load to avoid circular require with lib/scrapers.js
var _scrapers = null;
function getScrapers() {
    if (!_scrapers) _scrapers = require('../scrapers');
    return _scrapers;
}

function buildSearchUrl(item) {
    var q = item.searchQuery || ((item.artist || '') + ' ' + (item.title || '')).trim();
    return BASE_URL + '/search?q=' + encodeURIComponent(q) + '&type=product';
}

/**
 * Match a single wantlist item against the locally-synced UVS inventory.
 *
 * Follows the same (page, item) signature as all other store checkers so the
 * orchestrator in checkItem() can call it uniformly. `page` is ignored.
 */
async function checkUVS(_page, item) {
    var searchUrl = buildSearchUrl(item);

    try {
        var s = getScrapers();
        var inventory = db.getInStockInventory(STORE_KEY);

        // Fast path: catalog not yet synced → surface a link-only result
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
            if (matchesItem(s, item, row)) {
                matches.push(toMatch(row));
            }
        }

        console.log('[UVS] "' + (item.searchQuery || item.title) + '" → '
            + inventory.length + ' in-stock indexed, ' + matches.length + ' matches');

        return {
            store: STORE_NAME,
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl,
            usShipping: US_SHIPPING
        };
    } catch (e) {
        console.log('[UVS] ERROR "' + (item.searchQuery || item.title) + '": ' + e.message);
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

/**
 * Try structured match first (if we have a split artist/title from the Shopify
 * title). Fall back to combined matching against the raw Shopify title so that
 * format info appended by the store ("(12\" Vinyl)", "LP") is tolerated.
 */
function matchesItem(scrapers, wanted, row) {
    if (row.artist && row.title) {
        if (scrapers.recordsMatch(wanted, { artist: row.artist, title: row.title })) {
            return true;
        }
    }
    var combined = row.title_raw || ((row.artist || '') + ' - ' + (row.title || '')).trim();
    return scrapers.recordsMatchCombined(wanted, combined);
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
    syncUVS: syncUVS,
    checkUVS: checkUVS,
    shouldInclude: shouldInclude
};
