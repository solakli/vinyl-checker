/**
 * Store-only cart optimizer.
 *
 * Reads in-stock scan results from the DB and builds source profiles for each
 * retail store, then runs the greedy optimizeCart algorithm to find the
 * cheapest combination of stores — shipping included.
 *
 * No Playwright, no Discogs marketplace, no job queue. Pure computation on
 * data we already have. Typical run: < 50ms.
 */

'use strict';

const { optimizeCart } = require('./optimizer');
const shippingLib = require('./shipping-rates');
const db = require('../db');

// ─── Store metadata ───────────────────────────────────────────────────────────
// Each entry: { name, country (ISO-2), currency, linkOnly? }
const STORE_META = {
    'HHV':                { name: 'HHV',               country: 'DE', currency: 'EUR' },
    'Deejay.de':          { name: 'Deejay.de',          country: 'DE', currency: 'EUR' },
    'Hardwax':            { name: 'Hardwax',            country: 'DE', currency: 'EUR' },
    'Juno':               { name: 'Juno',               country: 'GB', currency: 'GBP' },
    'Turntable Lab':      { name: 'Turntable Lab',      country: 'US', currency: 'USD' },
    'Underground Vinyl':  { name: 'Underground Vinyl',  country: 'US', currency: 'USD' },
    'Decks.de':           { name: 'Decks.de',           country: 'DE', currency: 'EUR' },
    'Phonica':            { name: 'Phonica',            country: 'GB', currency: 'GBP', linkOnly: true },
    'Yoyaku':             { name: 'Yoyaku',             country: 'JP', currency: 'JPY', linkOnly: true },
    'Gramaphone':         { name: 'Gramaphone Records', country: 'US', currency: 'USD' },
    'Further Records':    { name: 'Further Records',    country: 'US', currency: 'USD' },
    'Octopus Records NYC':{ name: 'Octopus Records NYC',country: 'US', currency: 'USD' },
};

// Approximate exchange rates → USD (April 2026). Good enough for optimizer ranking.
const TO_USD = { USD: 1.0, EUR: 1.09, GBP: 1.27, JPY: 0.0067 };

// ─── Price parsing ────────────────────────────────────────────────────────────
// Store price strings arrive in many formats:
//   "$19.95"  "19,66 €"  "£12.99"  "€15.00"  "¥2,000"  "13.50"
function parsePrice(raw, currency) {
    if (!raw) return null;
    var s = String(raw).replace(/[^\d.,]/g, '').replace(',', '.');
    // If two dots, the first is likely a thousands separator: "1.234.56" → "1234.56"
    var parts = s.split('.');
    if (parts.length === 3) s = parts[0] + parts[1] + '.' + parts[2];
    var n = parseFloat(s);
    if (isNaN(n) || n <= 0) return null;
    var rate = TO_USD[currency] || 1.0;
    return Math.round(n * rate * 100) / 100; // round to cents
}

// ─── Build source profiles from store_results ────────────────────────────────
/**
 * @param {object[]} wantlistItems  from db.getActiveWantlist(userId)
 * @param {object[]} storeResults   rows from store_results where in_stock=1
 * @param {object}   opts
 * @param {string}   opts.buyerCountry  ISO-2 (e.g. 'TR')
 * @param {number}   [opts.maxPriceUsd]
 * @returns {object[]} source profiles ready for optimizeCart()
 */
function buildStoreSources(wantlistItems, storeResults, opts) {
    opts = opts || {};
    var buyerCountry = opts.buyerCountry || 'US';
    var maxPrice = opts.maxPriceUsd || Infinity;

    // Index wantlist by id for quick lookup
    var itemById = {};
    wantlistItems.forEach(function(w) { itemById[w.id] = w; });

    // Group results by store
    var byStore = {};
    storeResults.forEach(function(row) {
        if (!byStore[row.store]) byStore[row.store] = [];
        byStore[row.store].push(row);
    });

    var sources = [];

    Object.keys(byStore).forEach(function(storeName) {
        var meta = STORE_META[storeName];
        if (!meta || meta.linkOnly) return; // skip link-only or unknown stores

        var rows = byStore[storeName];
        var currency = meta.currency;

        // Compute shipping cost from this store to buyer's country
        var originCountry = meta.country;
        var shippingCostUsd = shippingLib.estimateShipping(originCountry, buyerCountry);

        // Build listings: one per wantlist item (cheapest match from this store)
        var listingMap = {}; // itemId → listing

        rows.forEach(function(row) {
            var wantlistId = row.wantlist_id;
            var item = itemById[wantlistId];
            if (!item) return;

            var matches = [];
            try { matches = JSON.parse(row.matches || '[]'); } catch(e) {}
            if (!matches.length) return;

            // Find cheapest match from this store for this item
            var cheapest = null;
            matches.forEach(function(m) {
                var priceUsd = parsePrice(m.price, currency);
                if (priceUsd === null) return;
                if (priceUsd > maxPrice) return;
                if (!cheapest || priceUsd < cheapest.priceUsd) {
                    cheapest = {
                        itemId: wantlistId,
                        artist: item.artist || m.artist || '',
                        title: item.title || m.title || '',
                        catno: item.catno || m.catno || '',
                        priceUsd: priceUsd,
                        condition: 'New/NM',
                        url: m.url || row.search_url || ''
                    };
                }
            });

            if (cheapest && (!listingMap[wantlistId] || cheapest.priceUsd < listingMap[wantlistId].priceUsd)) {
                listingMap[wantlistId] = cheapest;
            }
        });

        var listings = Object.values(listingMap);
        if (listings.length === 0) return;

        // Some stores have free-shipping thresholds — compute after optimizer assigns items
        // For now use flat rate; re-computed in shippingPolicyFn after assignment
        var shippingPolicyFn = null;
        if (storeName === 'Gramaphone') {
            shippingPolicyFn = function(items) {
                var subtotal = items.reduce(function(s, i) { return s + i.priceUsd; }, 0);
                return subtotal >= 50 ? 0 : 5.99;
            };
            shippingCostUsd = 5.99; // initial estimate for greedy scoring
        } else if (storeName === 'Further Records') {
            shippingPolicyFn = function(items) {
                var subtotal = items.reduce(function(s, i) { return s + i.priceUsd; }, 0);
                return subtotal >= 100 ? 0 : 7.99;
            };
            shippingCostUsd = 7.99;
        }

        var source = {
            sourceId: 'store:' + storeName.toLowerCase().replace(/\s+/g, '_'),
            sourceName: meta.name,
            sourceType: 'store',
            country: originCountry,
            sellerRating: null,
            sellerNumRatings: null,
            shippingCostUsd: shippingCostUsd,
            shippingPolicyFn: shippingPolicyFn,
            listings: listings
        };

        sources.push(source);
    });

    return sources;
}

/**
 * Build Discogs seller source profiles from discogs_listings rows.
 * Groups listings by seller — each seller is a source with one shipping fee.
 */
function buildDiscogsSources(wantlistItems, discogsListings, opts) {
    opts = opts || {};
    var buyerCountry = opts.buyerCountry || 'US';
    var maxPrice = opts.maxPriceUsd || Infinity;

    var itemById = {};
    wantlistItems.forEach(function(w) { itemById[w.id] = w; });

    // Group by seller
    var bySeller = {};
    discogsListings.forEach(function(row) {
        var seller = row.seller_username;
        if (!seller) return;
        if (!bySeller[seller]) bySeller[seller] = { rows: [], shipsFrom: row.ships_from, rating: row.seller_rating, numRatings: row.seller_num_ratings };
        bySeller[seller].rows.push(row);
    });

    var sources = [];
    Object.keys(bySeller).forEach(function(seller) {
        var meta = bySeller[seller];

        // Cheapest listing per wantlist item from this seller
        var listingMap = {};
        meta.rows.forEach(function(row) {
            var wid = row.wantlist_id;
            var item = itemById[wid];
            if (!item) return;
            var priceUsd = row.price_usd;
            if (!priceUsd || priceUsd > maxPrice) return;
            if (!listingMap[wid] || priceUsd < listingMap[wid].priceUsd) {
                listingMap[wid] = {
                    itemId: wid,
                    artist: item.artist || '',
                    title: item.title || '',
                    catno: item.catno || '',
                    priceUsd: priceUsd,
                    condition: row.condition || '',
                    url: row.listing_url || ''
                };
            }
        });

        var listings = Object.values(listingMap);
        if (!listings.length) return;

        var shippingCostUsd = shippingLib.estimateShipping(meta.shipsFrom || 'US', buyerCountry);

        sources.push({
            sourceId: 'discogs:' + seller,
            sourceName: seller,
            sourceType: 'discogs_seller',
            country: meta.shipsFrom || 'US',
            sellerRating: meta.rating || null,
            sellerNumRatings: meta.numRatings || null,
            shippingCostUsd: shippingCostUsd,
            shippingPolicyFn: null,
            listings: listings
        });
    });

    return sources;
}

/**
 * Run the full cart optimization for a user — retail stores + Discogs sellers.
 *
 * @param {string} username
 * @param {object} opts
 * @param {string} opts.buyerCountry
 * @param {number} [opts.maxPriceUsd]
 * @returns {object} optimizer result
 */
function optimizeStoreCart(username, opts) {
    var user = db.getOrCreateUser(username);
    if (!user) throw new Error('User not found: ' + username);

    var wantlistItems = db.getActiveWantlist(user.id);
    if (!wantlistItems.length) throw new Error('No wantlist items found for ' + username);

    // Retail store sources
    var storeResults  = db.getLatestInStockResults(user.id);
    var storeSources  = buildStoreSources(wantlistItems, storeResults, opts);

    // Discogs seller sources (if marketplace sync has been run)
    var discogsListings = db.getDiscogsListings(user.id);
    var discogsSources  = buildDiscogsSources(wantlistItems, discogsListings, opts);

    var sources = storeSources.concat(discogsSources);
    if (!sources.length) throw new Error('No in-stock items found. Run a scan first.');

    return optimizeCart(sources, wantlistItems);
}

module.exports = {
    optimizeStoreCart: optimizeStoreCart,
    buildStoreSources: buildStoreSources,
    buildDiscogsSources: buildDiscogsSources,
    parsePrice: parsePrice
};
