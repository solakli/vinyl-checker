/**
 * Discogs Marketplace API client with SQLite caching + rate limiting.
 *
 * The Discogs API allows 60 authenticated requests/minute. A full wantlist
 * of 200 items × ~2 pages of listings = 400 requests = ~7 minutes if naive.
 * We solve this with:
 *
 *   1. SQLite cache with a configurable TTL (default 6 hours) — re-running
 *      the optimizer doesn't re-fetch if listings are fresh.
 *   2. A token-bucket rate limiter (55 req/min, leaving headroom for other
 *      API calls the server makes).
 *   3. Parallel fetching in batches of 5 with inter-batch delay.
 *
 * Each Discogs wantlist item has a `discogs_id` (release ID). We call:
 *   GET /marketplace/search?release_id={id}&status=For+Sale&sort=price&sort_order=asc
 * and collect all pages of listings, filtered to the caller's min condition.
 */

const https = require('https');
const db = require('../db');

// Discogs API rate limit: 60/min authenticated. We stay at 55 to leave
// headroom for other concurrent API calls (wantlist fetch, etc).
const RATE_LIMIT_PER_MIN = 55;
const MIN_DELAY_MS = Math.ceil(60000 / RATE_LIMIT_PER_MIN); // ~1091ms between requests

// How long to consider cached listings fresh. 6 hours is a good trade-off:
// prices won't change dramatically but we don't re-fetch constantly.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Discogs condition ordering (worst → best). Used to filter by minimum.
const CONDITION_ORDER = ['Poor', 'Fair', 'Good', 'Good+', 'VG', 'VG+', 'NM or M-', 'Mint'];
const CONDITION_ABBREV = {
    'P': 'Poor', 'F': 'Fair', 'G': 'Good', 'G+': 'Good+',
    'VG': 'VG', 'VG+': 'VG+', 'NM': 'NM or M-', 'M-': 'NM or M-', 'M': 'Mint'
};

function conditionRank(cond) {
    if (!cond) return -1;
    var c = CONDITION_ABBREV[cond.trim()] || cond.trim();
    var idx = CONDITION_ORDER.indexOf(c);
    return idx === -1 ? CONDITION_ORDER.indexOf(cond.trim()) : idx;
}

function meetsMinCondition(listingCondition, minCondition) {
    if (!minCondition) return true;
    return conditionRank(listingCondition) >= conditionRank(minCondition);
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
var _lastRequestAt = 0;

function rateDelay() {
    var now = Date.now();
    var elapsed = now - _lastRequestAt;
    var wait = Math.max(0, MIN_DELAY_MS - elapsed);
    _lastRequestAt = now + wait;
    if (wait > 0) return new Promise(function (r) { setTimeout(r, wait); });
    return Promise.resolve();
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function fetchJson(targetUrl, userToken, userSecret) {
    return new Promise(function (resolve, reject) {
        var urlObj = new URL(targetUrl);
        var options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'VinylChecker/1.0 +https://github.com/solakli/vinyl-checker',
                'Accept': 'application/json'
            },
            timeout: 15000
        };

        if (userToken) {
            options.headers['Authorization'] =
                'OAuth oauth_consumer_key="' + (process.env.DISCOGS_CONSUMER_KEY || '') + '"' +
                ', oauth_token="' + userToken + '"' +
                ', oauth_signature_method="PLAINTEXT"' +
                ', oauth_signature="' + (process.env.DISCOGS_CONSUMER_SECRET || '') + '&' + (userSecret || '') + '"' +
                ', oauth_timestamp="' + Math.floor(Date.now() / 1000) + '"' +
                ', oauth_nonce="' + Math.random().toString(36).slice(2) + '"' +
                ', oauth_version="1.0"';
        } else {
            // Unauthenticated: use key+secret as query params for higher limits
            var sep = targetUrl.includes('?') ? '&' : '?';
            urlObj.searchParams.set('key', process.env.DISCOGS_CONSUMER_KEY || '');
            urlObj.searchParams.set('secret', process.env.DISCOGS_CONSUMER_SECRET || '');
            options.path = urlObj.pathname + urlObj.search;
        }

        var req = https.request(options, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                var body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode === 429) {
                    reject(new Error('RATE_LIMITED'));
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('HTTP ' + res.statusCode + ' for ' + targetUrl));
                    return;
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

// ─── Currency conversion (simple, rates updated periodically) ─────────────────
// We store prices in both native currency and USD equivalent. For most releases
// the native price IS in USD (US sellers dominate Discogs). For EU sellers we
// need approximate EUR→USD conversion. These rates are deliberately conservative
// approximations — the optimizer uses them only for ranking, not final billing.
const FX_TO_USD = {
    USD: 1.0, EUR: 1.09, GBP: 1.27, JPY: 0.0067, CAD: 0.74,
    AUD: 0.65, CHF: 1.12, SEK: 0.097, DKK: 0.146, NOK: 0.096,
    NZD: 0.61, MXN: 0.058, BRL: 0.20, ZAR: 0.055
};

function toUsd(amount, currency) {
    if (!amount || isNaN(amount)) return null;
    var rate = FX_TO_USD[currency] || FX_TO_USD[currency && currency.toUpperCase()] || 1.0;
    return Math.round(amount * rate * 100) / 100;
}

// ─── Fetch listings for one release ──────────────────────────────────────────
/**
 * Fetch all "For Sale" listings for a Discogs release ID, filtered to the
 * minimum condition. Returns normalized listing objects.
 *
 * Checks the SQLite cache first (per-release TTL). Only hits the API if
 * the cache is empty or expired.
 *
 * @param {number} releaseId - Discogs release ID
 * @param {object} opts
 * @param {string} [opts.minCondition='VG+']
 * @param {string} [opts.userToken]   - OAuth access token
 * @param {string} [opts.userSecret]  - OAuth access secret
 * @param {boolean} [opts.forceRefresh=false]
 * @returns {Promise<object[]>} normalized listing rows
 */
async function fetchListingsForRelease(releaseId, opts) {
    opts = opts || {};
    var minCondition = opts.minCondition || 'VG+';

    // Check cache first
    if (!opts.forceRefresh) {
        var cacheAge = db.getListingCacheAge(releaseId);
        if (cacheAge && new Date(cacheAge.expires_at) > new Date()) {
            var cached = db.getMarketListings(releaseId);
            return cached.filter(function (l) {
                return meetsMinCondition(l.condition, minCondition);
            }).map(normalizeDbRow);
        }
    }

    // Fetch from API
    var allListings = [];
    var page = 1;
    var perPage = 100;

    while (true) {
        await rateDelay();

        var url = 'https://api.discogs.com/marketplace/search' +
            '?release_id=' + releaseId +
            '&status=For+Sale' +
            '&sort=price&sort_order=asc' +
            '&per_page=' + perPage +
            '&page=' + page;

        var data;
        try {
            data = await fetchJson(url, opts.userToken, opts.userSecret);
        } catch (e) {
            if (e.message === 'RATE_LIMITED') {
                // Back off 30s and retry once
                await new Promise(function (r) { setTimeout(r, 30000); });
                data = await fetchJson(url, opts.userToken, opts.userSecret);
            } else {
                throw e;
            }
        }

        var listings = (data && data.listings) || [];
        allListings.push.apply(allListings, listings);

        var pagination = data && data.pagination;
        if (!pagination || page >= pagination.pages || listings.length === 0) break;
        page++;
    }

    // Normalize + cache
    var now = new Date();
    var expiresAt = new Date(now.getTime() + CACHE_TTL_MS).toISOString();
    var fetchedAt = now.toISOString();

    var rows = allListings.map(function (l) {
        return {
            releaseId: releaseId,
            listingId: l.id,
            sellerUsername: l.seller && l.seller.username,
            sellerCountry: l.ships_from || null,
            sellerRating: l.seller && l.seller.stats && l.seller.stats.rating
                ? parseFloat(l.seller.stats.rating) : null,
            sellerNumRatings: l.seller && l.seller.stats && l.seller.stats.total
                ? parseInt(l.seller.stats.total, 10) : 0,
            price: l.price && l.price.value ? parseFloat(l.price.value) : null,
            currency: l.price && l.price.currency || 'USD',
            priceUsd: l.price ? toUsd(parseFloat(l.price.value), l.price.currency) : null,
            condition: l.condition || null,
            sleeveCondition: l.sleeve_condition || null,
            comments: l.comments || null,
            listingUrl: 'https://www.discogs.com/sell/item/' + l.id,
            fetchedAt: fetchedAt,
            expiresAt: expiresAt
        };
    }).filter(function (r) { return r.listingId && r.price != null; });

    if (rows.length > 0) {
        db.upsertMarketListings(rows);
    }

    return rows.filter(function (l) {
        return meetsMinCondition(l.condition, minCondition);
    });
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

/**
 * Fetch listings for multiple release IDs concurrently (up to 5 at a time)
 * while respecting the rate limit. Returns a map of releaseId → listings[].
 *
 * @param {number[]} releaseIds
 * @param {object} opts  (same as fetchListingsForRelease)
 * @param {function} [opts.onProgress] - fn({done, total, releaseId})
 */
async function fetchListingsForReleases(releaseIds, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var results = {};
    var total = releaseIds.length;
    var done = 0;

    // Process in batches of 5 to balance parallelism vs rate limit
    var BATCH = 5;
    for (var i = 0; i < releaseIds.length; i += BATCH) {
        var batch = releaseIds.slice(i, i + BATCH);
        var batchResults = await Promise.all(batch.map(function (id) {
            return fetchListingsForRelease(id, opts).then(function (listings) {
                done++;
                onProgress({ done: done, total: total, releaseId: id });
                return { id: id, listings: listings };
            }).catch(function (e) {
                done++;
                onProgress({ done: done, total: total, releaseId: id, error: e.message });
                return { id: id, listings: [], error: e.message };
            });
        }));
        batchResults.forEach(function (r) { results[r.id] = r.listings; });
    }

    return results;
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
