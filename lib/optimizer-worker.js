/**
 * Optimizer Job Worker
 *
 * Polls the optimizer_jobs table every 3 seconds, claims one pending job at a
 * time, runs the full cart optimization pipeline, and writes results back.
 * Sequential processing ensures only one Playwright/Chromium instance runs at
 * a time — the right trade-off for a residential server with limited RAM.
 */

'use strict';

const db = require('../db');
const discogsMarket = require('./discogs-market');
const optimizer = require('./optimizer');
const storeOptimizer = require('./store-optimizer');
const shippingLib = require('./shipping-rates');

const POLL_INTERVAL_MS = 3000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // every hour

let isProcessing = false;

// ─── Result shape (mirrors what the old SSE endpoint sent) ────────────────────
function buildResult(optimizerResult, buyerCountry, minCondition) {
    return {
        cart: optimizerResult.cart.map(function (c) {
            return {
                sourceId: c.source.sourceId,
                sourceName: c.source.sourceName,
                sellerUsername: c.source.sellerUsername || null,
                sourceType: c.source.sourceType,
                country: c.source.country,
                sellerRating: c.source.sellerRating,
                sellerNumRatings: c.source.sellerNumRatings,
                shippingCostUsd: c.shippingCostUsd,
                subtotalUsd: c.subtotalUsd,
                totalUsd: c.totalUsd,
                items: c.assignedListings.map(function (l) {
                    return {
                        itemId: l.itemId,
                        artist: l.artist || '',
                        title: l.title || '',
                        catno: l.catno || '',
                        priceUsd: l.priceUsd,
                        condition: l.condition,
                        sleeveCondition: l.sleeveCondition,
                        url: l.url
                    };
                })
            };
        }),
        covered: optimizerResult.covered,
        total: optimizerResult.total,
        uncoveredItems: optimizerResult.uncoveredItems.map(function (w) {
            return {
                artist: w.artist,
                title: w.title,
                catno: w.catno,
                discogsId: w.discogs_id
            };
        }),
        grandTotalUsd: optimizerResult.grandTotalUsd,
        grandShippingUsd: optimizerResult.grandShippingUsd,
        grandRecordsUsd: optimizerResult.grandRecordsUsd,
        numSellers: optimizerResult.numSellers,
        buyerCountry: buyerCountry,
        minCondition: minCondition
    };
}

// ─── Process one job ───────────────────────────────────────────────────────────
async function processJob(job) {
    var params = {};
    try { params = JSON.parse(job.params || '{}'); } catch(e) {}

    var username = job.username;
    var user = db.getOrCreateUser(username);

    function progress(phase, done, total, message, extra) {
        db.updateJobProgress(job.id, Object.assign(
            { phase: phase, done: done, total: total, message: message },
            extra || {}
        ));
    }

    // Resolve buyer location early — needed for shipping estimates in all source types
    var postcode        = params.postcode      || '';
    var countryFromPostcode = postcode ? shippingLib.postcodeToCountry(postcode).countryCode : null;
    var buyerCountry    = params.countryCode   || countryFromPostcode || 'US';
    var minCondition    = params.minCondition  || 'VG';
    var minSellerRating = parseFloat(params.minSellerRating || 98);
    var maxPriceUsd     = params.maxPriceUsd   ? parseFloat(params.maxPriceUsd) : null;

    var sourceOpts = { buyerCountry: buyerCountry, maxPriceUsd: maxPriceUsd };

    // Step 1: Wantlist
    progress('wantlist', 0, 0, 'Loading your hit list…', {});
    var wantlist = db.getActiveWantlist(user.id);
    if (wantlist.length === 0) {
        throw new Error('No wantlist items found. Run a scan first.');
    }
    progress('wantlist', wantlist.length, wantlist.length, wantlist.length + ' records on your hit list', {});

    // Step 2: Store inventories — catalog-synced stores + per-item scan results
    progress('stores', 0, 0, 'Raiding every store we\'ve got…', {});

    // 2a. Catalog-synced stores (Gramaphone, Further, Octopus)
    var storeInventory = {
        gramaphone: db.getInStockInventory('gramaphone'),
        further:    db.getInStockInventory('further'),
        octopus:    db.getInStockInventory('octopus')
    };
    var catalogTotal = Object.values(storeInventory).reduce(function(s, a) { return s + a.length; }, 0);

    // 2b. Per-item scan results (HHV, Deejay, Hardwax, Juno, Turntable Lab, etc.)
    var scanResults   = db.getLatestInStockResults(user.id);
    var scanSources   = storeOptimizer.buildStoreSources(wantlist, scanResults, sourceOpts);

    // 2c. Chrome extension synced Discogs listings
    var extListings   = db.getDiscogsListings(user.id);
    var extSources    = storeOptimizer.buildDiscogsSources(wantlist, extListings, sourceOpts);

    var storeTotal = catalogTotal + scanResults.filter(function(r) { return r.in_stock; }).length;
    progress('stores', storeTotal, storeTotal,
        catalogTotal + ' catalog · ' + scanSources.length + ' scan stores · ' +
        extSources.length + ' Discogs ext sellers', {});

    // Step 3: Discogs marketplace listings (Playwright)
    var releaseIds = wantlist.map(function(w) { return w.discogs_id; }).filter(Boolean);
    progress('discogs', 0, releaseIds.length, 'Hitting up the Discogs marketplace…', { listingsFound: 0 });

    var oauthToken = db.getOAuthToken(user.id, 'discogs');

    var listingsFound = 0;
    var sellerSet = {};
    var marketListings = await discogsMarket.fetchListingsForReleases(releaseIds, {
        minCondition:  minCondition,
        userToken:     oauthToken ? oauthToken.access_token  : null,
        userSecret:    oauthToken ? oauthToken.access_secret : null,
        forceRefresh:  params.forceRefresh  || false,
        onProgress: function(p) {
            listingsFound += (p.listingsForRelease || 0);
            var stats = p.done + ' / ' + p.total + ' releases' +
                (listingsFound ? ' · ' + listingsFound + ' listings' : '') +
                (p.fromCache ? ' ⚡' : '');
            progress('discogs', p.done, p.total, stats, { listingsFound: listingsFound });
        }
    });

    // Step 4: Optimize — all source types combined
    var totalListings = Object.values(marketListings).reduce(function(s, a) { return s + a.length; }, 0);
    Object.values(marketListings).forEach(function(listings) {
        listings.forEach(function(l) { if (l.sellerUsername) sellerSet[l.sellerUsername] = 1; });
    });
    var totalSellers = Object.keys(sellerSet).length + extSources.length;
    progress('optimize', 0, 0,
        totalListings + ' marketplace listings · ' + scanSources.length + ' stores · ' +
        totalSellers + ' sellers — building best cart…',
        { listingsFound: totalListings, sellersFound: totalSellers });

    // Extra sources = scan stores + Chrome extension Discogs sellers
    var extraSources = scanSources.concat(extSources);

    var raw = optimizer.runOptimizer(wantlist, storeInventory, marketListings, {
        buyerCountry:    buyerCountry,
        minCondition:    minCondition,
        minSellerRating: minSellerRating,
        maxPriceUsd:     maxPriceUsd
    }, extraSources);

    // Save prefs
    db.saveUserPreferences(user.id, {
        postcode:        postcode,
        countryCode:     buyerCountry,
        minCondition:    minCondition,
        minSellerRating: minSellerRating,
        maxPriceUsd:     maxPriceUsd
    });

    return buildResult(raw, buyerCountry, minCondition);
}

// ─── Worker loop ──────────────────────────────────────────────────────────────
async function tick() {
    if (isProcessing) return;

    var job = db.claimNextJob();
    if (!job) return;

    isProcessing = true;
    console.log('[optimizer-worker] Starting job', job.id, 'for', job.username);

    try {
        var result = await processJob(job);
        db.completeOptimizerJob(job.id, result);
        console.log('[optimizer-worker] Job', job.id, 'done.');
    } catch (e) {
        console.error('[optimizer-worker] Job', job.id, 'failed:', e.message);
        db.failOptimizerJob(job.id, e.message);
    } finally {
        isProcessing = false;
    }
}

function start() {
    setInterval(tick, POLL_INTERVAL_MS);
    // Periodic cleanup of stale completed jobs
    setInterval(function() {
        var n = db.cleanupOldOptimizerJobs();
        if (n > 0) console.log('[optimizer-worker] Cleaned up', n, 'old jobs');
    }, CLEANUP_INTERVAL_MS);
    console.log('[optimizer-worker] Started — polling every ' + (POLL_INTERVAL_MS / 1000) + 's');
}

module.exports = { start: start };
