/**
 * Scan orchestration: worker management, browser lifecycle, background sync
 */

const puppeteer = require('puppeteer');
const db = require('../db');
const discogs = require('./discogs');
const scrapers = require('./scrapers');

const NUM_WORKERS = 2; // 2 items checked simultaneously
const STORES_PER_WORKER = 3; // 3 scraped stores: Deejay.de, HHV, Juno

let activeScans = {}; // track scans per username

// In-memory scan progress for resume on refresh
// scanProgress[username] = { events: [{type, data}], listeners: [sendEvent, ...], done: bool }
let scanProgress = {};

// ═══════════════════════════════════════════════════════════════
// BROWSER PAGE SETUP
// ═══════════════════════════════════════════════════════════════

async function createWorkerPages(browser) {
    var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var workers = [];

    for (var w = 0; w < NUM_WORKERS; w++) {
        var pages = [];
        for (var p = 0; p < STORES_PER_WORKER; p++) pages.push(await browser.newPage());

        for (var pi = 0; pi < pages.length; pi++) {
            pages[pi].setDefaultNavigationTimeout(10000);
            pages[pi].setDefaultTimeout(10000);
            await pages[pi].setUserAgent(UA);
            await pages[pi].setRequestInterception(true);
        }
        // pages[0] = Deejay.de - block stylesheets
        pages[0].on('request', function (req) {
            var type = req.resourceType();
            (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') ? req.abort() : req.continue();
        });
        // pages[1] = HHV - keep stylesheets (SPA needs CSS)
        pages[1].on('request', function (req) {
            var type = req.resourceType();
            (type === 'image' || type === 'media' || type === 'font') ? req.abort() : req.continue();
        });
        // pages[2] = Juno
        pages[2].on('request', function (req) {
            var type = req.resourceType();
            (type === 'image' || type === 'media' || type === 'font') ? req.abort() : req.continue();
        });
        workers.push(pages);
    }
    return workers;
}

// ═══════════════════════════════════════════════════════════════
// SCAN LOGIC (with DB caching)
// ═══════════════════════════════════════════════════════════════

async function runScan(username, initialSendEvent, force, userDiscogsHeaders) {
    // Check if scan is running or recently finished -- replay + attach
    if (scanProgress[username]) {
        // If the cached scan had an error, and we now have OAuth or force, clear and retry
        var cachedHadError = scanProgress[username].done && scanProgress[username].events.some(function(ev) { return ev.type === 'error' || ev.type === 'scan-error'; });
        if (cachedHadError && (force || userDiscogsHeaders)) {
            console.log('[scan] Clearing cached error for', username, '- retrying with', userDiscogsHeaders ? 'OAuth' : 'force');
            delete scanProgress[username];
        } else {
            // Replay all past events
            scanProgress[username].events.forEach(function (ev) {
                initialSendEvent(ev.type, ev.data);
            });
            // If not done yet, subscribe to future events
            if (!scanProgress[username].done) {
                scanProgress[username].listeners.push(initialSendEvent);
            }
            return;
        }
    }
    if (activeScans[username]) {
        // If it's a background/daily scan, load cached results instead of blocking
        if (activeScans[username] === 'bg' || activeScans[username] === 'daily') {
            initialSendEvent('status', { phase: 'background', message: 'Background scan in progress. Loading cached results...' });
            try {
                var bgUser = db.getOrCreateUser(username);
                var bgResults = db.getFullResults(bgUser.id);
                var bgInStock = bgResults.filter(function(r) { return r.stores.some(function(s) { return s.inStock; }); }).length;
                bgResults.forEach(function(r, idx) {
                    initialSendEvent('item-done', {
                        index: idx, total: bgResults.length,
                        item: r.item, stores: r.stores, discogsPrice: r.discogsPrice,
                        inStock: r.stores.some(function(s) { return s.inStock; }),
                        totalInStock: bgInStock, fromCache: true
                    });
                });
                initialSendEvent('done', { message: 'Loaded cached results (background scan running)', total: bgResults.length, inStock: bgInStock, username: username, checked: 0, cached: bgResults.length });
            } catch(e) {
                initialSendEvent('scan-error', { message: 'Background scan in progress. Please try again later.' });
            }
            return;
        }
        initialSendEvent('error', { message: 'A scan is already running for ' + username });
        return;
    }
    activeScans[username] = true;

    // Set up progress tracking with broadcast
    scanProgress[username] = { events: [], listeners: [initialSendEvent], done: false };

    function sendEvent(type, data) {
        // Store event for replay
        if (scanProgress[username]) {
            scanProgress[username].events.push({ type: type, data: data });
            // Broadcast to all connected listeners
            scanProgress[username].listeners.forEach(function (fn) {
                try { fn(type, data); } catch (e) {}
            });
        }
    }

    try {
        // Step 1: Fetch wantlist from Discogs
        sendEvent('status', { phase: 'fetching', message: 'Fetching wantlist for ' + username + '...' });
        // Use user's OAuth headers if available (for private wantlists)
        var wantlist = await discogs.fetchWantlist(username, userDiscogsHeaders || undefined);

        if (wantlist.length === 0) {
            sendEvent('done', { message: 'Wantlist is empty', total: 0, inStock: 0, results: [] });
            delete activeScans[username];
            if (scanProgress[username]) {
                scanProgress[username].done = true;
                setTimeout(function () { delete scanProgress[username]; }, 30000);
            }
            return;
        }

        // Step 2: Sync to database
        var user = db.getOrCreateUser(username);
        var syncResult = db.syncWantlistItems(user.id, wantlist);
        console.log('Synced wantlist: ' + syncResult.totalActive + ' active, ' + syncResult.newItems.length + ' new, ' + syncResult.removedCount + ' removed');

        // Step 3: Determine what needs checking
        var allDbItems = db.getActiveWantlist(user.id);
        var itemsToCheck = force ? allDbItems : db.getItemsNeedingCheck(user.id);
        var cachedCount = allDbItems.length - itemsToCheck.length;

        sendEvent('wantlist', {
            total: allDbItems.length,
            toCheck: itemsToCheck.length,
            cached: cachedCount,
            username: username
        });

        // Send cached items immediately
        if (cachedCount > 0) {
            sendEvent('status', { phase: 'cached', message: 'Loaded ' + cachedCount + ' cached results' });
            var cachedItems = allDbItems.filter(function (w) {
                return !itemsToCheck.some(function (tc) { return tc.id === w.id; });
            });
            cachedItems.forEach(function (w, idx) {
                var stores = db.getStoreResults(w.id);
                var price = db.getDiscogsPrice(w.id);
                var hasStock = stores.some(function (s) { return s.inStock; });
                sendEvent('item-done', {
                    index: idx,
                    total: allDbItems.length,
                    item: {
                        id: w.discogs_id, artist: w.artist, title: w.title,
                        year: w.year, label: w.label, catno: w.catno,
                        thumb: w.thumb, genres: w.genres || '', styles: w.styles || '', searchQuery: w.search_query
                    },
                    stores: stores,
                    discogsPrice: price ? {
                        lowestPrice: price.lowest_price,
                        currency: price.currency,
                        numForSale: price.num_for_sale,
                        shipping: price.shipping || null,
                        marketplaceUrl: price.marketplace_url
                    } : null,
                    inStock: hasStock,
                    totalInStock: 0, // will be recalculated
                    fromCache: true
                });
            });
        }

        if (itemsToCheck.length === 0) {
            // Everything is cached
            var fullResults = db.getFullResults(user.id);
            var totalInStock = fullResults.filter(function (r) { return r.stores.some(function (s) { return s.inStock; }); }).length;
            sendEvent('done', {
                message: 'All results loaded from cache',
                total: allDbItems.length,
                inStock: totalInStock,
                username: username
            });
            delete activeScans[username];
            return;
        }

        // Step 4: Launch browser for items that need checking
        sendEvent('status', { phase: 'launching', message: 'Checking ' + itemsToCheck.length + ' items...' });
        var browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 60000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-gpu', '--disable-extensions']
        });
        var workers = await createWorkerPages(browser);

        // Step 5: Process unchecked items
        sendEvent('status', { phase: 'checking', message: 'Checking ' + itemsToCheck.length + ' items across stores...' });
        var completedCount = cachedCount;
        var itemIndex = 0;

        async function workerLoop(workerIdx) {
            var pages = workers[workerIdx];
            while (true) {
                var myIdx = itemIndex++;
                if (myIdx >= itemsToCheck.length) break;

                var w = itemsToCheck[myIdx];
                var item = {
                    id: w.discogs_id, artist: w.artist, title: w.title,
                    year: w.year, label: w.label, catno: w.catno,
                    thumb: w.thumb, searchQuery: w.search_query
                };

                // Stagger workers slightly to avoid simultaneous HHV requests
                if (workerIdx > 0) {
                    await new Promise(function (r) { setTimeout(r, 1000 * workerIdx); });
                }

                try {
                    var results = await scrapers.checkItem(pages, item);

                    // Save to DB
                    db.saveStoreResults(w.id, results);

                    // Fetch Discogs marketplace price
                    if (w.discogs_id) {
                        try {
                            var priceData = await discogs.fetchMarketplaceStats(w.discogs_id);
                            db.saveDiscogsPrice(w.id, priceData);
                        } catch (e) { /* price fetch failed, not critical */ }
                    }

                    var hasStock = results.some(function (r) { return r.inStock; });
                    completedCount++;

                    var price = db.getDiscogsPrice(w.id);
                    sendEvent('item-done', {
                        index: completedCount - 1,
                        total: allDbItems.length,
                        item: item,
                        stores: results,
                        discogsPrice: price ? {
                            lowestPrice: price.lowest_price,
                            currency: price.currency,
                            numForSale: price.num_for_sale,
                            marketplaceUrl: price.marketplace_url
                        } : null,
                        inStock: hasStock,
                        totalInStock: 0,
                        fromCache: false
                    });
                } catch (e) {
                    completedCount++;
                    sendEvent('item-done', {
                        index: completedCount - 1,
                        total: allDbItems.length,
                        item: item,
                        stores: [],
                        inStock: false,
                        totalInStock: 0,
                        fromCache: false
                    });
                }
            }
        }

        var workerPromises = [];
        for (var w = 0; w < NUM_WORKERS; w++) {
            workerPromises.push(workerLoop(w));
        }
        await Promise.all(workerPromises);

        await browser.close();

        db.updateUserFullScanTime(user.id);

        var fullResults = db.getFullResults(user.id);
        var totalInStock = fullResults.filter(function (r) { return r.stores.some(function (s) { return s.inStock; }); }).length;

        sendEvent('done', {
            message: 'Scan complete!',
            total: allDbItems.length,
            inStock: totalInStock,
            username: username,
            checked: itemsToCheck.length,
            cached: cachedCount
        });

    } catch (e) {
        sendEvent('scan-error', { message: e.message });
    } finally {
        delete activeScans[username];
        // Keep progress for 30s so late-refreshers can still get results
        if (scanProgress[username]) {
            scanProgress[username].done = true;
            setTimeout(function () { delete scanProgress[username]; }, 30000);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// BACKGROUND SYNC
// ═══════════════════════════════════════════════════════════════

async function backgroundSync() {
    var d = db.getDb();
    var users = d.prepare('SELECT * FROM users WHERE last_full_scan IS NOT NULL').all();
    if (users.length === 0) return;

    for (var i = 0; i < users.length; i++) {
        var user = users[i];
        if (activeScans[user.username]) { console.log('[sync] Scan in progress, skipping ' + user.username); continue; }

        console.log('[sync] Syncing wantlist for ' + user.username + '...');
        try {
            // Use OAuth token if available (for private wantlists)
            var oauthSync = require('./oauth');
            var syncOAuthToken = db.getOAuthToken(user.id, 'discogs');
            var syncHeadersFn = undefined;
            if (syncOAuthToken && syncOAuthToken.access_token && syncOAuthToken.access_secret) {
                syncHeadersFn = function(method, path) {
                    var url = 'https://api.discogs.com' + path;
                    return {
                        'User-Agent': 'VinylWantlistChecker/1.0',
                        'Authorization': oauthSync.discogsAuthHeader(method, url, syncOAuthToken.access_token, syncOAuthToken.access_secret)
                    };
                };
            }
            var wantlist = await discogs.fetchWantlist(user.username, syncHeadersFn);
            var syncResult = db.syncWantlistItems(user.id, wantlist);

            if (syncResult.newItems.length === 0) {
                console.log('[sync] ' + user.username + ': no new items');
                continue;
            }

            console.log('[sync] ' + user.username + ': ' + syncResult.newItems.length + ' new items, checking stores...');

            // Check new items
            activeScans[user.username] = 'bg';
            var browser = await puppeteer.launch({
                headless: 'new',
                protocolTimeout: 60000,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });
            var workers = await createWorkerPages(browser);

            var newDbItems = db.getActiveWantlist(user.id).filter(function (w) {
                return syncResult.newItems.some(function (n) { return n.id === w.discogs_id; });
            });

            var notifications = [];
            var itemIdx = 0;

            async function bgWorker(workerIdx) {
                var pages = workers[workerIdx];
                while (true) {
                    var myIdx = itemIdx++;
                    if (myIdx >= newDbItems.length) break;
                    var w = newDbItems[myIdx];
                    var item = {
                        id: w.discogs_id, artist: w.artist, title: w.title,
                        year: w.year, label: w.label, catno: w.catno,
                        thumb: w.thumb, searchQuery: w.search_query
                    };
                    try {
                        var results = await scrapers.checkItem(pages, item);
                        db.saveStoreResults(w.id, results);

                        if (w.discogs_id) {
                            try {
                                var priceData = await discogs.fetchMarketplaceStats(w.discogs_id);
                                db.saveDiscogsPrice(w.id, priceData);
                            } catch (e) {}
                        }

                        var inStockStores = results.filter(function (r) { return r.inStock && !r.linkOnly; });
                        if (inStockStores.length > 0) {
                            var dp = db.getDiscogsPrice(w.id);
                            notifications.push({
                                artist: w.artist, title: w.title,
                                stores: inStockStores.map(function (s) {
                                    var cheapest = s.matches && s.matches[0] ? s.matches[0].price : '';
                                    return { name: s.store, price: cheapest, url: s.searchUrl };
                                }),
                                discogsPrice: dp ? '$' + (dp.lowest_price || '?') : null
                            });
                        }
                    } catch (e) { console.log('[sync] Error checking ' + w.artist + ': ' + e.message); }
                }
            }

            var bgPromises = [];
            for (var w = 0; w < NUM_WORKERS; w++) bgPromises.push(bgWorker(w));
            await Promise.all(bgPromises);
            await browser.close();
            delete activeScans[user.username];

            // Send notifications if any items found in stock
            if (notifications.length > 0) {
                await sendNotifications(user.username, notifications);
            }

            console.log('[sync] ' + user.username + ': done, ' + notifications.length + ' new items in stock');
        } catch (e) {
            console.log('[sync] Error syncing ' + user.username + ': ' + e.message);
            delete activeScans[user.username];
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

async function sendNotifications(username, items) {
    var lines = items.map(function (item) {
        var storeList = item.stores.map(function (s) {
            return s.name + ' ' + s.price + ' ' + s.url;
        }).join('\n  ');
        var discogsStr = item.discogsPrice ? ' (Discogs: ' + item.discogsPrice + ')' : '';
        return item.artist + ' - ' + item.title + discogsStr + '\n  ' + storeList;
    });

    var message = 'Vinyl Checker: ' + items.length + ' new item(s) in stock for ' + username + '!\n\n' + lines.join('\n\n');
    console.log('[notify]\n' + message);

    var NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || '';

    // Discord/Slack webhook
    if (NOTIFICATION_WEBHOOK) {
        try {
            var url = new URL(NOTIFICATION_WEBHOOK);
            var payload = JSON.stringify({ content: message });
            var options = {
                hostname: url.hostname, path: url.pathname, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            };
            await new Promise(function (resolve) {
                var req = (url.protocol === 'https:' ? require('https') : require('http')).request(options, resolve);
                req.write(payload);
                req.end();
            });
            console.log('[notify] Webhook sent');
        } catch (e) { console.log('[notify] Webhook error: ' + e.message); }
    }
}

// ═══════════════════════════════════════════════════════════════
// DAILY FULL RESCAN — re-check all items, detect changes
// ═══════════════════════════════════════════════════════════════

function detectChanges(userId, wantlistId, store, oldInStock, oldMatches, newResult) {
    var newInStock = newResult.inStock && !newResult.linkOnly;
    var wasInStock = !!oldInStock;

    if (!wasInStock && newInStock) {
        // Newly in stock!
        var bestPrice = newResult.matches && newResult.matches[0] ? newResult.matches[0].price : null;
        db.insertScanChange(userId, wantlistId, 'now_in_stock', store,
            { inStock: false },
            { inStock: true, price: bestPrice, url: newResult.searchUrl }
        );
        return 'now_in_stock';
    }
    if (wasInStock && !newInStock) {
        // Went out of stock
        db.insertScanChange(userId, wantlistId, 'out_of_stock', store,
            { inStock: true },
            { inStock: false }
        );
        return 'out_of_stock';
    }
    // Price change detection for items that stayed in stock
    if (wasInStock && newInStock) {
        var oldPrice = null;
        try {
            var oldM = JSON.parse(oldMatches || '[]');
            if (oldM[0]) oldPrice = oldM[0].price;
        } catch(e) {}
        var newPrice = newResult.matches && newResult.matches[0] ? newResult.matches[0].price : null;
        if (oldPrice && newPrice && oldPrice !== newPrice) {
            var oldNum = parseFloat(String(oldPrice).replace(/[^0-9.]/g, ''));
            var newNum = parseFloat(String(newPrice).replace(/[^0-9.]/g, ''));
            if (!isNaN(oldNum) && !isNaN(newNum) && Math.abs(oldNum - newNum) > 0.5) {
                db.insertScanChange(userId, wantlistId,
                    newNum < oldNum ? 'price_drop' : 'price_increase', store,
                    { price: oldPrice },
                    { price: newPrice }
                );
                return newNum < oldNum ? 'price_drop' : 'price_increase';
            }
        }
    }
    return null;
}

async function dailyFullRescan() {
    var users = db.getUsersDueForRescan();
    if (users.length === 0) return;

    console.log('[daily] ' + users.length + ' user(s) due for rescan');

    for (var u = 0; u < users.length; u++) {
        var user = users[u];
        if (activeScans[user.username]) {
            console.log('[daily] Skipping ' + user.username + ' (scan in progress)');
            continue;
        }

        console.log('[daily] Starting full rescan for ' + user.username);
        activeScans[user.username] = 'daily';

        try {
            // 1. Sync wantlist first (pick up any new additions)
            var oauth = require('./oauth');
            var oauthToken = db.getOAuthToken(user.id, 'discogs');
            var headersFn = null;
            if (oauthToken && oauthToken.access_token && oauthToken.access_secret) {
                headersFn = function(method, path) {
                    var url = 'https://api.discogs.com' + path;
                    return {
                        'User-Agent': 'VinylWantlistChecker/1.0',
                        'Authorization': oauth.discogsAuthHeader(method, url, oauthToken.access_token, oauthToken.access_secret)
                    };
                };
            }

            var wantlist = await discogs.fetchWantlist(user.username, headersFn || undefined);
            db.syncWantlistItems(user.id, wantlist);

            // 2. Snapshot current results BEFORE rescanning
            var snapshot = db.snapshotStoreResults(user.id);
            var snapshotMap = {};
            snapshot.forEach(function(s) {
                var key = s.wantlist_id + ':' + s.store;
                snapshotMap[key] = s;
            });

            // 3. Get all active items and check them
            var allItems = db.getActiveWantlist(user.id);
            console.log('[daily] ' + user.username + ': checking ' + allItems.length + ' items');

            var browser = await puppeteer.launch({
                headless: 'new',
                protocolTimeout: 60000,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });
            var workers = await createWorkerPages(browser);

            var itemIdx = 0;
            var changesFound = 0;

            async function dailyWorker(workerIdx) {
                var pages = workers[workerIdx];
                while (true) {
                    var myIdx = itemIdx++;
                    if (myIdx >= allItems.length) break;
                    var w = allItems[myIdx];
                    var item = {
                        id: w.discogs_id, artist: w.artist, title: w.title,
                        year: w.year, label: w.label, catno: w.catno,
                        thumb: w.thumb, searchQuery: w.search_query
                    };

                    try {
                        var results = await scrapers.checkItem(pages, item);
                        db.saveStoreResults(w.id, results);

                        // Detect changes per store
                        results.forEach(function(r) {
                            if (r.linkOnly) return;
                            var key = w.id + ':' + r.store;
                            var old = snapshotMap[key];
                            var change = detectChanges(user.id, w.id, r.store,
                                old ? old.in_stock : 0,
                                old ? old.matches : '[]',
                                r
                            );
                            if (change) changesFound++;
                        });

                        // Update Discogs price
                        if (w.discogs_id) {
                            try {
                                var priceData = await discogs.fetchMarketplaceStats(w.discogs_id);
                                db.saveDiscogsPrice(w.id, priceData);
                            } catch(e) {}
                        }
                    } catch(e) {
                        console.log('[daily] Error checking ' + w.artist + ' - ' + w.title + ': ' + e.message);
                    }

                    // Log progress every 20 items
                    if ((myIdx + 1) % 20 === 0) {
                        console.log('[daily] ' + user.username + ': ' + (myIdx + 1) + '/' + allItems.length);
                    }
                }
            }

            var dailyPromises = [];
            for (var w = 0; w < NUM_WORKERS; w++) dailyPromises.push(dailyWorker(w));
            await Promise.all(dailyPromises);
            await browser.close();

            // 4. Update timestamps
            db.updateUserDailyRescan(user.id);
            db.updateUserFullScanTime(user.id);

            console.log('[daily] ' + user.username + ': done! ' + changesFound + ' changes detected');

            // 5. Send notifications for items newly in stock
            var newInStock = db.getUndismissedChanges(user.id, null)
                .filter(function(c) { return c.change_type === 'now_in_stock' && c.detected_at > new Date(Date.now() - 3600000).toISOString(); });
            if (newInStock.length > 0) {
                var notifications = newInStock.map(function(c) {
                    var nv = JSON.parse(c.new_value || '{}');
                    return {
                        artist: c.artist, title: c.title,
                        stores: [{ name: c.store, price: nv.price || '', url: nv.url || '' }]
                    };
                });
                await sendNotifications(user.username, notifications);
            }

        } catch(e) {
            console.log('[daily] Error rescanning ' + user.username + ': ' + e.message);
        } finally {
            delete activeScans[user.username];
        }

        // 6. Wait between users to avoid hammering stores
        if (u < users.length - 1) {
            console.log('[daily] Waiting 3 minutes before next user...');
            await new Promise(function(r) { setTimeout(r, 180000); });
        }
    }
}

module.exports = {
    runScan,
    backgroundSync,
    dailyFullRescan,
    sendNotifications,
    createWorkerPages,
    get activeScans() { return activeScans; },
    set activeScans(v) { activeScans = v; },
    get scanProgress() { return scanProgress; },
    set scanProgress(v) { scanProgress = v; }
};
