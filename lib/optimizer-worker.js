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

    function progress(phase, done, total, message) {
        db.updateJobProgress(job.id, { phase: phase, done: done, total: total, message: message });
    }

    // Step 1: Wantlist
    progress('wantlist', 0, 0, 'Loading wantlist...');
    var wantlist = db.getActiveWantlist(user.id);
    if (wantlist.length === 0) {
        throw new Error('No wantlist items found. Run a scan first.');
    }
    progress('wantlist', wantlist.length, wantlist.length, wantlist.length + ' items loaded');

    // Step 2: Store inventories
    progress('stores', 0, 0, 'Loading store inventories...');
    var storeInventory = {
        gramaphone: db.getInStockInventory('gramaphone'),
        further:    db.getInStockInventory('further'),
        octopus:    db.getInStockInventory('octopus')
    };
    var storeTotal = Object.values(storeInventory).reduce(function(s, a) { return s + a.length; }, 0);
    progress('stores', storeTotal, storeTotal, storeTotal + ' store listings loaded');

    // Step 3: Discogs marketplace listings
    var releaseIds = wantlist.map(function(w) { return w.discogs_id; }).filter(Boolean);
    progress('discogs', 0, releaseIds.length, 'Fetching Discogs marketplace listings...');

    var oauthToken = db.getOAuthToken(user.id, 'discogs');

    var marketListings = await discogsMarket.fetchListingsForReleases(releaseIds, {
        minCondition:  params.minCondition  || 'VG',
        userToken:     oauthToken ? oauthToken.access_token  : null,
        userSecret:    oauthToken ? oauthToken.access_secret : null,
        forceRefresh:  params.forceRefresh  || false,
        onProgress: function(p) {
            progress('discogs', p.done, p.total,
                'Fetched ' + p.done + ' / ' + p.total + ' releases' + (p.fromCache ? ' (cached)' : ''));
        }
    });

    // Step 4: Optimize
    var totalListings = Object.values(marketListings).reduce(function(s, a) { return s + a.length; }, 0);
    progress('optimize', 0, 0, 'Running optimizer across ' + totalListings + ' listings...');

    var postcode      = params.postcode      || '';
    var countryFromPostcode = postcode ? shippingLib.postcodeToCountry(postcode).countryCode : null;
    var buyerCountry  = params.countryCode   || countryFromPostcode || 'US';
    var minCondition  = params.minCondition  || 'VG';
    var minSellerRating = parseFloat(params.minSellerRating  || 98);
    var maxPriceUsd   = params.maxPriceUsd   ? parseFloat(params.maxPriceUsd) : null;

    var raw = optimizer.runOptimizer(wantlist, storeInventory, marketListings, {
        buyerCountry:    buyerCountry,
        minCondition:    minCondition,
        minSellerRating: minSellerRating,
        maxPriceUsd:     maxPriceUsd
    });

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
