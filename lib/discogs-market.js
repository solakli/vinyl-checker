/**
 * Discogs Marketplace client using discogs-marketplace-api-nodejs (Playwright-based).
 *
 * The official Discogs API removed the /marketplace/search endpoint. Instead we
 * use a community library that calls Discogs' internal JSON API via a headless
 * Chromium browser, bypassing Cloudflare bot-protection.
 *
 * Strategy:
 *   - Batch up to BATCH_SIZE release IDs per browser call (one Playwright page).
 *   - Cache results in SQLite for CACHE_TTL_MS (6 hours).
 *   - Stream per-release progress via an onProgress callback.
 *
 * Condition ordering matches Discogs' own display labels (short form).
 */

const db = require('../db');
const { DiscogsMarketplace } = require('discogs-marketplace-api-nodejs');

// How long to consider cached listings fresh.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// How many release IDs to bundle per browser call.  Larger = fewer launches
// but potentially sparser coverage per release.
const BATCH_SIZE = 15;

// How many listings to request per batch call.  250 is the Discogs max.
const PER_BATCH_LIMIT = 250;

// ─── Condition helpers ────────────────────────────────────────────────────────
// Discogs conditions, worst → best. The library returns short forms (e.g. "VG+").
const CONDITION_ORDER = ['P', 'F', 'G', 'G+', 'VG', 'VG+', 'NM or M-', 'M'];

// Full-form → short-form aliases for anything that slips through
const CONDITION_FULL_TO_SHORT = {
    'Poor (P)': 'P',
    'Fair (F)': 'F',
    'Good (G)': 'G',
    'Good Plus (G+)': 'G+',
    'Very Good (VG)': 'VG',
    'Very Good Plus (VG+)': 'VG+',
    'Near Mint (NM or M-)': 'NM or M-',
    'Mint (M)': 'M',
    'NM': 'NM or M-',
    'M-': 'NM or M-',
};

function normalizeCondition(raw) {
    if (!raw) return null;
    return CONDITION_FULL_TO_SHORT[raw.trim()] || raw.trim();
}

function conditionRank(cond) {
    var c = normalizeCondition(cond);
    if (!c) return -1;
    return CONDITION_ORDER.indexOf(c);
}

function meetsMinCondition(listingCondition, minCondition) {
    if (!minCondition) return true;
    return conditionRank(listingCondition) >= conditionRank(minCondition);
}

// ─── Currency conversion ──────────────────────────────────────────────────────
const FX_TO_USD = {
    USD: 1.0, EUR: 1.09, GBP: 1.27, JPY: 0.0067, CAD: 0.74,
    AUD: 0.65, CHF: 1.12, SEK: 0.097, DKK: 0.146, NOK: 0.096,
    NZD: 0.61, MXN: 0.058, BRL: 0.20, ZAR: 0.055
};

function toUsd(amount, currency) {
    if (!amount || isNaN(amount)) return null;
    var rate = FX_TO_USD[(currency || '').toUpperCase()] || 1.0;
    return Math.round(amount * rate * 100) / 100;
}

// Parse the library's price string "12.34 GBP" → { amount: 12.34, currency: "GBP" }
function parsePrice(priceStr) {
    if (!priceStr) return { amount: null, currency: 'USD' };
    var parts = priceStr.trim().split(' ');
    var amount = parseFloat(parts[0]);
    var currency = (parts[1] || 'USD').toUpperCase();
    return { amount: isNaN(amount) ? null : amount, currency: currency };
}

// ─── Fetch listings for a batch of release IDs ────────────────────────────────
/**
 * Use the Playwright-based library to fetch marketplace listings for a batch
 * of release IDs in one browser session.  Returns a map of releaseId → rows[].
 */
async function fetchBatch(releaseIds, opts) {
    opts = opts || {};
    var minCondition = opts.minCondition || 'VG';

    var allItems = [];
    var page = 1;

    while (true) {
        var result;
        try {
            result = await DiscogsMarketplace.search({
                api: 'v2',
                releaseIds: releaseIds,
                sort: 'price,asc',
                limit: PER_BATCH_LIMIT,
                page: page,
                formats: ['Vinyl'],
            });
        } catch (e) {
            // Browser/Cloudflare hiccup — log and return what we have
            console.error('[discogs-market] batch error page', page, ':', e.message);
            break;
        }

        allItems.push.apply(allItems, result.items || []);

        // Stop when we've covered all pages OR we have plenty per release
        if (page >= (result.page && result.page.total || 1)) break;
        if (allItems.length >= releaseIds.length * 20) break;  // ~20 listings/release is enough
        page++;
    }

    // Group by release ID
    var byRelease = {};
    releaseIds.forEach(function (id) { byRelease[id] = []; });

    var now = new Date();
    var fetchedAt = now.toISOString();
    var expiresAt = new Date(now.getTime() + CACHE_TTL_MS).toISOString();

    allItems.forEach(function (item) {
        var rid = item.release && item.release.id;
        if (!rid || !byRelease[rid]) return;

        var priceInfo = parsePrice(item.price && item.price.base);
        var condition = item.condition && normalizeCondition(item.condition.media && item.condition.media.full || item.condition.media && item.condition.media.short);
        var sleeveCondition = item.condition && item.condition.sleeve && normalizeCondition(item.condition.sleeve.full || item.condition.sleeve.short);

        // Parse seller rating from "98.2%" string
        var ratingStr = item.seller && item.seller.score;
        var sellerRating = ratingStr ? parseFloat(ratingStr.replace('%', '')) : null;

        var row = {
            releaseId: rid,
            listingId: item.id,
            sellerUsername: item.seller && item.seller.name,
            sellerCountry: item.country && item.country.code,   // already ISO-2
            sellerRating: sellerRating,
            sellerNumRatings: item.seller && item.seller.notes || 0,
            price: priceInfo.amount,
            currency: priceInfo.currency,
            priceUsd: toUsd(priceInfo.amount, priceInfo.currency),
            condition: condition,
            sleeveCondition: sleeveCondition,
            comments: item.description || null,
            listingUrl: item.url || ('https://www.discogs.com/sell/item/' + item.id),
            fetchedAt: fetchedAt,
            expiresAt: expiresAt
        };

        if (row.listingId && row.price != null) {
            byRelease[rid].push(row);
        }
    });

    return byRelease;
}

// ─── Public: fetch listings for one release ───────────────────────────────────
/**
 * Returns normalized listing rows for a single Discogs release ID, using cache.
 */
async function fetchListingsForRelease(releaseId, opts) {
    opts = opts || {};
    var minCondition = opts.minCondition || 'VG';

    if (!opts.forceRefresh) {
        var cacheAge = db.getListingCacheAge(releaseId);
        if (cacheAge && new Date(cacheAge.expires_at) > new Date()) {
            var cached = db.getMarketListings(releaseId);
            return cached.filter(function (l) {
                return meetsMinCondition(l.condition, minCondition);
            }).map(normalizeDbRow);
        }
    }

    var byRelease = await fetchBatch([releaseId], opts);
    var rows = byRelease[releaseId] || [];

    if (rows.length > 0) {
        db.upsertMarketListings(rows);
    }

    return rows.filter(function (l) {
        return meetsMinCondition(l.condition, minCondition);
    });
}

// ─── Public: fetch listings for many releases ─────────────────────────────────
/**
 * Fetch listings for multiple release IDs, batching browser calls.
 * Returns a map of releaseId → listing[].
 *
 * @param {number[]} releaseIds
 * @param {object} opts
 * @param {string}   [opts.minCondition='VG']
 * @param {boolean}  [opts.forceRefresh=false]
 * @param {function} [opts.onProgress] - called with { done, total, releaseId }
 */
async function fetchListingsForReleases(releaseIds, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var minCondition = opts.minCondition || 'VG';
    var results = {};
    var total = releaseIds.length;
    var done = 0;

    // Separate into cached vs needs-fetching
    var toFetch = [];
    releaseIds.forEach(function (id) {
        if (!opts.forceRefresh) {
            var cacheAge = db.getListingCacheAge(id);
            if (cacheAge && new Date(cacheAge.expires_at) > new Date()) {
                var cached = db.getMarketListings(id);
                results[id] = cached.filter(function (l) {
                    return meetsMinCondition(l.condition, minCondition);
                }).map(normalizeDbRow);
                done++;
                onProgress({ done: done, total: total, releaseId: id, fromCache: true });
                return;
            }
        }
        toFetch.push(id);
    });

    // Fetch uncached IDs in batches
    for (var i = 0; i < toFetch.length; i += BATCH_SIZE) {
        var batch = toFetch.slice(i, i + BATCH_SIZE);

        var byRelease;
        try {
            byRelease = await fetchBatch(batch, opts);
        } catch (e) {
            // Treat whole batch as empty on catastrophic failure
            console.error('[discogs-market] batch fetch failed:', e.message);
            byRelease = {};
            batch.forEach(function (id) { byRelease[id] = []; });
        }

        // Persist all rows to cache in bulk, then report progress
        var allRows = [];
        batch.forEach(function (id) {
            allRows.push.apply(allRows, byRelease[id] || []);
        });
        if (allRows.length > 0) {
            try { db.upsertMarketListings(allRows); } catch (e) {
                console.error('[discogs-market] cache write error:', e.message);
            }
        }

        batch.forEach(function (id) {
            results[id] = (byRelease[id] || []).filter(function (l) {
                return meetsMinCondition(l.condition, minCondition);
            });
            done++;
            onProgress({ done: done, total: total, releaseId: id });
        });
    }

    return results;
}

function normalizeDbRow(row) {
    return {
        releaseId: row.discogs_release_id,
        listingId: row.listing_id,
        sellerUsername: row.seller_username,
        sellerCountry: row.seller_country,
        sellerRating: row.seller_rating,
        sellerNumRatings: row.seller_num_ratings,
        price: row.price,
        currency: row.currency,
        priceUsd: row.price_usd,
        condition: row.condition,
        sleeveCondition: row.sleeve_condition,
        comments: row.comments,
        listingUrl: row.listing_url
    };
}

module.exports = {
    fetchListingsForRelease: fetchListingsForRelease,
    fetchListingsForReleases: fetchListingsForReleases,
    meetsMinCondition: meetsMinCondition,
    conditionRank: conditionRank,
    toUsd: toUsd,
    CONDITION_ORDER: CONDITION_ORDER,
    CACHE_TTL_MS: CACHE_TTL_MS
};
