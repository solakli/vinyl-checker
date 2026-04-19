/**
 * Gramaphone Records (Chicago) — independent vinyl store on Shopify.
 *
 * Architecture differs from the EU Puppeteer scrapers:
 *   1. Once a day, syncGramaphone() pulls the entire /products.json catalog
 *      (~6k products, ~25 paginated requests) into the `store_inventory` table.
 *   2. Per-scan, checkGramaphone() does a fast local SQLite lookup + reuses
 *      the existing fuzzy-match utilities. No HTTP per item, no Puppeteer.
 *
 * The same pattern will scale to other Shopify stores (Underground Vinyl,
 * Further Records, etc.) by adding a thin module like this one alongside
 * the generic ./shopify.js helpers.
 */

const shopify = require('./shopify');
const db = require('../../db');

const STORE_KEY = 'gramaphone';
const STORE_NAME = 'Gramaphone';
const BASE_URL = 'https://gramaphonerecords.com';
const US_SHIPPING = '$5.50';

// Shopify `product_type` values that we know are NOT records.
// Anything else (including "Records & LPs", "Mail Order", "Classics", or
// label-named buckets like "Sushitech Records") is treated as vinyl.
const NON_RECORD_TYPES = new Set([
    'Slipmat',
    'Books',
    'T-Shirt',
    'Vinyl Care + Cleaning',
    'Sweaters + Hoodies',
    'Record Bag',
    'Decor',
    'Gift Card',
    'CD'
]);

// ─── Label / catalog number extraction ────────────────────────────────────────
// Gramaphone product descriptions are structured with `<br>`-separated fields:
//
//     <p>Label: Rush Hour Store Jams – RH-StoreJams031<br>
//        Format: Vinyl, 12"<br>
//        Released: Mar 12, 2026<br>
//        Style: House</p>
//
// After stripHtml the `<br>` tags collapse to spaces, so we anchor on the next
// known field keyword (Format, Released, Style, etc.) rather than trying to
// guess catno boundaries character-by-character.

// Other known field keys that follow "Label: ..." in Gramaphone descriptions.
// Add new ones here when you spot them — order doesn't matter.
const NEXT_FIELD_KEYWORDS = [
    'Format', 'Released', 'Style', 'Genre', 'Catno', 'Cat#', 'Catalog',
    'Country', 'Tracklist', 'Type', 'Year', 'Tag', 'Tags', 'Pressed',
    'Distribution'
];

const LABEL_REGEX = new RegExp(
    'Label:\\s*([^\\n\\r.]+?)(?=\\s+(?:' + NEXT_FIELD_KEYWORDS.join('|') + '):|[\\n\\r.]|$)',
    'i'
);

// Within the label chunk, split on the first em-dash (with optional spaces) or
// the first " - " (ASCII hyphen with required spaces around it). Em-dash gets
// looser whitespace because it's an unambiguous separator; ASCII hyphen needs
// surrounding spaces so we don't split inside names like "X-Press 2".
const LABEL_CATNO_SPLIT_REGEX = /^(.+?)(?:\s*–\s*|\s+-\s+)(.+)$/;

function parseLabel(ctx) {
    var text = ctx.bodyText || '';
    var m = text.match(LABEL_REGEX);
    if (!m) return { label: null, catno: null };

    var chunk = m[1].trim();
    var split = chunk.match(LABEL_CATNO_SPLIT_REGEX);
    if (split) {
        return {
            label: cleanField(split[1]),
            catno: cleanField(split[2])
        };
    }
    return { label: cleanField(chunk), catno: null };
}

function cleanField(s) {
    if (!s) return null;
    var trimmed = String(s).replace(/\s+/g, ' ').trim();
    if (!trimmed) return null;
    // Strip trailing punctuation that often leaks in from the body text.
    trimmed = trimmed.replace(/[\s.,;:]+$/, '');
    return trimmed || null;
}

function shouldInclude(rawProduct) {
    var type = rawProduct.product_type || '';
    return !NON_RECORD_TYPES.has(type);
}

// ─── Sync ────────────────────────────────────────────────────────────────────
/**
 * Pull the full Gramaphone catalog and upsert it into `store_inventory`.
 * Items not seen during this sync are marked unavailable (not deleted) so
 * historical refs and `scan_changes` stay valid.
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress] - fn({page, count, total}) for live logs
 * @returns {Promise<object>} stats { seen, added, updated, markedUnavailable, durationMs }
 */
async function syncGramaphone(opts) {
    opts = opts || {};
    var startedIso = new Date().toISOString();
    var startedAt = Date.now();
    var syncId = db.startStoreSync(STORE_KEY);
    var onProgress = opts.onProgress || function () {};

    try {
        var rawProducts = await shopify.fetchAllProducts(BASE_URL, {
            perPage: 250,
            delayMs: 250,
            onProgress: function (p) {
                onProgress({
                    phase: 'fetch',
                    page: p.page,
                    count: p.count,
                    total: p.total,
                    offsetCap: p.offsetCap || false
                });
            }
        });

        var rows = [];
        for (var i = 0; i < rawProducts.length; i++) {
            if (!shouldInclude(rawProducts[i])) continue;
            rows.push(shopify.parseShopifyProduct(rawProducts[i], {
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
// Loaded lazily to avoid a hard circular require with lib/scrapers.js
// (scrapers requires this module to wire it into checkItem).
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
 * Match a single wantlist item against our locally-synced Gramaphone inventory.
 *
 * Signature follows the same `(page, item)` shape as the other store checkers
 * so the orchestrator in lib/scrapers.js can call it uniformly. The `page`
 * argument is ignored — Gramaphone is pure DB lookup.
 */
async function checkGramaphone(_page, item) {
    var searchUrl = buildSearchUrl(item);

    try {
        var s = getScrapers();
        var inventory = db.getInStockInventory(STORE_KEY);

        // Fast path: if the catalog is empty (never synced), surface a link-only
        // result so the UI still renders a search button instead of a hard error.
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

        console.log('[Gramaphone] "' + (item.searchQuery || item.title) + '" → '
            + inventory.length + ' in-stock indexed, ' + matches.length + ' matches');

        return {
            store: STORE_NAME,
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl,
            usShipping: US_SHIPPING
        };
    } catch (e) {
        console.log('[Gramaphone] ERROR "' + (item.searchQuery || item.title) + '": ' + e.message);
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
    syncGramaphone: syncGramaphone,
    checkGramaphone: checkGramaphone,
    parseLabel: parseLabel,
    shouldInclude: shouldInclude
};
