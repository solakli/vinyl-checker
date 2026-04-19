/**
 * Further Records (Seattle) — independent vinyl store on Shopify.
 *
 * Same architecture as ./gramaphone.js: nightly /products.json sync into
 * `store_inventory`, per-scan checks are pure SQLite lookups + the existing
 * fuzzy matchers from lib/scrapers.js.
 *
 * Catalog is large (~25k products as of 2026; Further also resells the Juno
 * distribution feed) so we bump the Shopify pagination cap accordingly.
 *
 * body_html comes in TWO shapes — both handled here:
 *
 *   1. Structured (≈70%): one field per `<br>` line.
 *        Artist: Foo
 *        Title:  Bar
 *        Label:  Baz
 *        Catalog: BAZ001
 *        Format:  12"
 *
 *   2. Free-form / curated (≈30%): single prose blob.
 *        Hideo Shiraki - Plays Bossa Nova (LP) Jazz Room Records - JAZZR-025 2023 Jazz, ...
 *
 * Both flow through the same parseLabel + parseArtistTitle helpers below.
 */

const shopify = require('./shopify');
const db = require('../../db');

const STORE_KEY = 'further';
const STORE_NAME = 'Further Records';
const BASE_URL = 'https://furtherrecords.com';
// Free shipping over $100; otherwise USPS Standard / UPS Ground (variable).
const US_SHIPPING = 'Free over $100';

// product_type on Further is the FORMAT (12", LP, Cassette, Box Set, ...).
// Across 6,500+ products sampled the only non-listening type that surfaced
// was "Magazine"; everything else is media we can match against. Add to the
// blacklist if more merch types appear.
const NON_RECORD_TYPES = new Set([
    'Magazine'
]);

// Fields we try to pluck out of structured body_html. Keep this list aligned
// with the shopify.parseStructuredFields stop-keyword behaviour.
const STRUCTURED_FIELDS = ['Artist', 'Title', 'Label', 'Catalog', 'Format', 'Date', 'Genres', 'Styles'];

// ─── Label / catalog number extraction ────────────────────────────────────────

// Free-form pattern. Anchored on `)` (closing the format suffix in the title)
// then captures `<Label> - <CATNO> <YEAR>`. The year acts as a hard terminator
// so we don't bleed into genre / tracklist text.
//
//     ...(LP) Jazz Room Records - JAZZR-025 2023 Jazz, Latin Bossa Nova A1 ...
//             └─── label ────┘   └── catno ──┘ └yr┘
//
// Label uses lazy `(.+?)` so it stops at the FIRST ` - ` boundary (works for
// labels containing hyphens too, e.g. "Self-Released" — the regex engine
// gives the smallest possible match before the catno+year suffix).
const FREEFORM_LABEL_REGEX = /\)\s+(.+?)\s+-\s+([A-Za-z0-9][A-Za-z0-9 \-]*?)\s+((?:19|20)\d{2})\b/;

function parseLabel(ctx) {
    var text = ctx.bodyText || '';

    // 1. Structured form: pluck `Label:` and `Catalog:` fields.
    var fields = shopify.parseStructuredFields(text, STRUCTURED_FIELDS);
    if (fields.Label || fields.Catalog) {
        return {
            label: cleanField(fields.Label),
            catno: cleanField(fields.Catalog)
        };
    }

    // 2. Free-form / curated description: regex with year as the terminator.
    var m = text.match(FREEFORM_LABEL_REGEX);
    if (m) {
        return {
            label: cleanField(m[1]),
            catno: cleanField(m[2])
        };
    }

    return { label: null, catno: null };
}

// Override artist/title from structured body fields when present. The combined
// Shopify `title` is "Artist1/Artist2 - Title (Format)" which is fine for
// matching but the structured Artist/Title fields are more authoritative
// (they preserve the canonical Discogs spelling).
function parseArtistTitle(ctx) {
    var text = ctx.bodyText || '';
    var fields = shopify.parseStructuredFields(text, STRUCTURED_FIELDS);
    if (fields.Artist || fields.Title) {
        return {
            artist: cleanField(fields.Artist) || '',
            title: cleanField(fields.Title) || ''
        };
    }
    // Free-form mode: let the default splitArtistTitle handle product.title.
    return null;
}

function cleanField(s) {
    if (!s) return null;
    var trimmed = String(s).replace(/\s+/g, ' ').trim();
    if (!trimmed) return null;
    trimmed = trimmed.replace(/[\s.,;:]+$/, '');
    return trimmed || null;
}

function shouldInclude(rawProduct) {
    var type = rawProduct.product_type || '';
    return !NON_RECORD_TYPES.has(type);
}

// ─── Sync ────────────────────────────────────────────────────────────────────
/**
 * Pull the full Further Records catalog and upsert into `store_inventory`.
 * Items not seen during this sync are marked unavailable (not deleted).
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress] - fn({phase, page, count, total, ...})
 * @returns {Promise<object>} stats { seen, added, updated, markedUnavailable, durationMs }
 */
async function syncFurther(opts) {
    opts = opts || {};
    var startedIso = new Date().toISOString();
    var startedAt = Date.now();
    var syncId = db.startStoreSync(STORE_KEY);
    var onProgress = opts.onProgress || function () {};

    try {
        var rawProducts = await shopify.fetchAllProducts(BASE_URL, {
            perPage: 250,
            // Further's catalog tops out around 25k; allow generous headroom.
            maxPages: 200,
            delayMs: 750,
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
                parseLabel: parseLabel,
                parseArtistTitle: parseArtistTitle
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
    return BASE_URL + '/search?q=' + encodeURIComponent(q) + '&type=product';
}

/**
 * Match a single wantlist item against our locally-synced Further inventory.
 * `_page` is ignored — pure DB lookup, signature kept consistent with the
 * Puppeteer-backed checkers so checkItem() in lib/scrapers.js can call it
 * uniformly.
 */
async function checkFurther(_page, item) {
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

        console.log('[Further] "' + (item.searchQuery || item.title) + '" → '
            + inventory.length + ' in-stock indexed, ' + matches.length + ' matches');

        return {
            store: STORE_NAME,
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl,
            usShipping: US_SHIPPING
        };
    } catch (e) {
        console.log('[Further] ERROR "' + (item.searchQuery || item.title) + '": ' + e.message);
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
    syncFurther: syncFurther,
    checkFurther: checkFurther,
    parseLabel: parseLabel,
    parseArtistTitle: parseArtistTitle,
    shouldInclude: shouldInclude
};
