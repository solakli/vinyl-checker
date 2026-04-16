/**
 * Scan orchestration: worker management, browser lifecycle, background sync
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const db = require('../db');
const discogs = require('./discogs');
const scrapers = require('./scrapers');

const NUM_WORKERS = 3; // 3 items checked simultaneously
const STORES_PER_WORKER = 5; // 5 browser pages per worker → 2 batches instead of 3

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
            pages[pi].setDefaultNavigationTimeout(15000);
            pages[pi].setDefaultTimeout(15000);
            await pages[pi].setUserAgent(UA);

            // Block media/fonts/images to prevent audio players and heavy assets from hanging pages
            await pages[pi].setRequestInterception(true);
            (function(pg, pageIdx) {
                pg.on('request', function(req) {
                    var rt = req.resourceType();
                    // Block media on all pages (Deejay.de audio player causes protocol timeouts)
                    // Block images/fonts everywhere for speed
                    // Allow stylesheets only for HHV (page index 1) — its SPA needs CSS to render
                    if (rt === 'media' || rt === 'font' || rt === 'image') {
                        req.abort();
                    } else if (rt === 'stylesheet' && pageIdx !== 1) {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
            })(pages[pi], pi);
        }
        // Warm up HHV page with homepage visit (establishes cookies to bypass bot detection)
        await pages[1].goto('https://www.hhv.de/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(function () {});
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
        // If force=true (Rescan All), clear cached progress and start fresh
        if (force && scanProgress[username].done) {
            console.log('[scan] Force rescan — clearing cached progress for', username);
            delete scanProgress[username];
        }
        // If the cached scan had an error, and we now have OAuth, clear and retry
        else if (scanProgress[username].done && scanProgress[username].events.some(function(ev) { return ev.type === 'error' || ev.type === 'scan-error'; }) && userDiscogsHeaders) {
            console.log('[scan] Clearing cached error for', username, '- retrying with OAuth');
            delete scanProgress[username];
        } else if (scanProgress[username]) {
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
        // If it's a background/daily scan and user wants force rescan, wait for it to finish
        if ((activeScans[username] === 'bg' || activeScans[username] === 'daily') && force) {
            initialSendEvent('status', { phase: 'waiting', message: 'Background scan finishing up, please wait...' });
            // Poll until background scan finishes, then start fresh
            var waitCount = 0;
            var waitTimer = setInterval(async function() {
                waitCount++;
                if (!activeScans[username] || waitCount > 60) {
                    clearInterval(waitTimer);
                    if (!activeScans[username]) {
                        // Background scan finished, now start fresh force scan
                        runScan(username, initialSendEvent, force, userDiscogsHeaders);
                    } else {
                        initialSendEvent('scan-error', { message: 'Background scan still running. Try again in a minute.' });
                    }
                }
            }, 5000);
            return;
        }
        // If it's a background/daily scan (no force), load cached results
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
                setTimeout(function () { delete scanProgress[username]; }, 300000);
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
                        thumb: w.thumb, genres: w.genres || '', styles: w.styles || '', searchQuery: w.search_query,
                        dateAdded: w.date_added || null
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
                    thumb: w.thumb, searchQuery: w.search_query,
                    dateAdded: w.date_added || null
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
        // Keep progress for 5 min so users returning from other apps can resume
        if (scanProgress[username]) {
            scanProgress[username].done = true;
            setTimeout(function () { delete scanProgress[username]; }, 300000);
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
                        thumb: w.thumb, searchQuery: w.search_query,
                        dateAdded: w.date_added || null
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
                        thumb: w.thumb, searchQuery: w.search_query,
                        dateAdded: w.date_added || null
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

// ═══════════════════════════════════════════════════════════════
// STOCK VALIDATION JOB — Per-store confusion matrix
//
// Confusion matrix per store:
//   TP: We said in stock  → validator confirms in stock
//   FP: We said in stock  → validator says NOT in stock (false positive)
//   FN: We said not stock → validator finds it IS in stock (missed sale!)
//   TN: We said not stock → validator confirms not in stock
//
// 3-step verification per check:
//   Step 1: Page load & search results exist
//     1a: URL resolves (no timeout/error)
//     1b: Product elements found in DOM (selectors work)
//   Step 2: Record matching
//     2a: Artist name matches (fuzzy)
//     2b: Title matches (fuzzy)
//     2c: Not a recommendation/promoted item
//   Step 3: Stock status
//     3a: No "sold out" text
//     3b: No "out of stock" text
//     3c: Store-specific checks (price present, add-to-cart visible, etc.)
// ═══════════════════════════════════════════════════════════════

// Store-specific out-of-stock indicators
var STORE_OOS_SIGNALS = {
    'Deejay.de':         ['sold out', 'out of stock', 'ausverkauft', 'nicht verfügbar', 'not available'],
    'HHV':               ['sold out', 'out of stock', 'nicht verfügbar', 'ausverkauft', 'currently unavailable'],
    'Hardwax':           ['sold out', 'out of stock'],
    'Juno':              ['sold out', 'out of stock', 'pre-order', 'deleted'],
    'Turntable Lab':     ['sold out', 'out of stock'],
    'Underground Vinyl': ['sold out', 'out of stock'],
    'Decks.de':          ['sold out', 'out of stock', 'ausverkauft'],
    'Phonica':           ['sold out', 'out of stock'],
    'Yoyaku':            ['out of stock', 'sold out', 'épuisé']
};

// Store-specific positive stock signals (if present, likely in stock)
var STORE_IN_STOCK_SIGNALS = {
    'Deejay.de':         ['in den warenkorb', 'add to cart', 'kaufen'],
    'HHV':               ['in den warenkorb', 'add to cart', 'add to basket'],
    'Hardwax':           ['add', 'order'],
    'Juno':              ['add to cart', 'buy'],
    'Turntable Lab':     ['add to cart'],
    'Underground Vinyl': ['add to cart'],
    'Decks.de':          ['add to cart', 'in den warenkorb'],
    'Phonica':           ['add to cart', 'buy'],
    'Yoyaku':            ['add to cart', 'ajouter au panier']
};

var validationStats = {
    lastRun: null,
    runCount: 0,
    // Per-store confusion matrix
    perStore: {},
    // Last run details
    lastResults: [],
    lastSummary: {}
};

function ensureStoreStats(store) {
    if (!validationStats.perStore[store]) {
        validationStats.perStore[store] = {
            tp: 0, fp: 0, fn: 0, tn: 0,
            errors: 0, checked: 0,
            // Sub-step failure counts
            step1a_fail: 0, step1b_fail: 0,
            step2a_fail: 0, step2b_fail: 0,
            step3a_fail: 0, step3b_fail: 0, step3c_fail: 0
        };
    }
    return validationStats.perStore[store];
}

async function validateInStockResults() {
    if (activeScans['_validator']) {
        console.log('[validator] Already running, skipping');
        return;
    }
    activeScans['_validator'] = 'validate';

    try {
        var d = db.getDb();

        // ── Phase 1: Validate items we claim are IN STOCK (detect FP) ──
        var inStockRows = d.prepare(`
            SELECT sr.id, sr.wantlist_id, sr.store, sr.search_url, sr.matches, sr.checked_at,
                   w.artist, w.title, w.catno, w.label
            FROM store_results sr
            JOIN wantlist w ON w.id = sr.wantlist_id
            WHERE sr.in_stock = 1 AND sr.link_only = 0
            ORDER BY sr.checked_at ASC
            LIMIT 25
        `).all();

        // ── Phase 2: Sample items we claim are NOT IN STOCK (detect FN) ──
        // Pick 10 random "not in stock" items per run to check if we missed any
        var notInStockRows = d.prepare(`
            SELECT sr.id, sr.wantlist_id, sr.store, sr.search_url, sr.checked_at,
                   w.artist, w.title, w.catno, w.label
            FROM store_results sr
            JOIN wantlist w ON w.id = sr.wantlist_id
            WHERE sr.in_stock = 0 AND sr.link_only = 0 AND sr.error IS NULL
            ORDER BY RANDOM()
            LIMIT 10
        `).all();

        var totalToCheck = inStockRows.length + notInStockRows.length;
        if (totalToCheck === 0) {
            console.log('[validator] Nothing to validate');
            delete activeScans['_validator'];
            return;
        }

        console.log('[validator] Phase 1: ' + inStockRows.length + ' in-stock (FP check) | Phase 2: ' + notInStockRows.length + ' not-in-stock (FN check)');

        // Launch browser
        var browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-gpu', '--single-process']
        });

        var page = await browser.newPage();
        page.setDefaultNavigationTimeout(12000);
        page.setDefaultTimeout(12000);
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        var results = [];
        var summary = { tp: 0, fp: 0, fn: 0, tn: 0, errors: 0 };

        // ── Phase 1: Check in-stock items (TP or FP) ──
        for (var i = 0; i < inStockRows.length; i++) {
            var row = inStockRows[i];
            var item = { artist: row.artist, title: row.title, searchQuery: (row.artist + ' ' + row.title).trim(), catno: row.catno, label: row.label };
            var ss = ensureStoreStats(row.store);
            ss.checked++;

            try {
                var r = await validateSingleResult(page, row.store, row.search_url, item);

                if (r.verdict) {
                    // TP: We said in stock, confirmed in stock
                    ss.tp++;
                    summary.tp++;
                    results.push({ artist: row.artist, title: row.title, store: row.store, phase: 'FP-check',
                                   status: 'TP', steps: r.steps, productsFound: r.productsFound });
                } else {
                    // FP: We said in stock, actually NOT in stock — flip it
                    ss.fp++;
                    summary.fp++;
                    d.prepare('UPDATE store_results SET in_stock = 0, matches = ?, checked_at = ? WHERE id = ?')
                        .run('[]', new Date().toISOString(), row.id);
                    // Track which sub-step failed
                    if (r.failedStep) {
                        var stepKey = r.failedStep + '_fail';
                        if (ss[stepKey] !== undefined) ss[stepKey]++;
                    }
                    console.log('[validator] FP: ' + row.artist + ' - ' + row.title + ' @ ' + row.store + ' → ' + r.reason);
                    results.push({ artist: row.artist, title: row.title, store: row.store, phase: 'FP-check',
                                   status: 'FP', reason: r.reason, failedStep: r.failedStep, steps: r.steps });
                }
                await new Promise(function(resolve) { setTimeout(resolve, 1500); });
            } catch (e) {
                ss.errors++;
                summary.errors++;
                results.push({ artist: row.artist, title: row.title, store: row.store, phase: 'FP-check',
                               status: 'ERROR', error: e.message });
            }
        }

        // ── Phase 2: Check not-in-stock items (TN or FN) ──
        for (var j = 0; j < notInStockRows.length; j++) {
            var row2 = notInStockRows[j];
            var item2 = { artist: row2.artist, title: row2.title, searchQuery: (row2.artist + ' ' + row2.title).trim(), catno: row2.catno, label: row2.label };
            var ss2 = ensureStoreStats(row2.store);
            ss2.checked++;

            try {
                var r2 = await validateSingleResult(page, row2.store, row2.search_url, item2);

                if (!r2.verdict) {
                    // TN: We said not in stock, confirmed not in stock
                    ss2.tn++;
                    summary.tn++;
                    results.push({ artist: row2.artist, title: row2.title, store: row2.store, phase: 'FN-check',
                                   status: 'TN', steps: r2.steps });
                } else {
                    // FN: We said not in stock, but it IS in stock — flip it!
                    ss2.fn++;
                    summary.fn++;
                    // Re-scrape to get proper match data
                    d.prepare('UPDATE store_results SET in_stock = 1, checked_at = ? WHERE id = ?')
                        .run(new Date().toISOString(), row2.id);
                    console.log('[validator] FN: ' + row2.artist + ' - ' + row2.title + ' @ ' + row2.store + ' → ACTUALLY IN STOCK (missed!)');
                    results.push({ artist: row2.artist, title: row2.title, store: row2.store, phase: 'FN-check',
                                   status: 'FN', steps: r2.steps, productsFound: r2.productsFound });
                }
                await new Promise(function(resolve) { setTimeout(resolve, 1500); });
            } catch (e) {
                ss2.errors++;
                summary.errors++;
                results.push({ artist: row2.artist, title: row2.title, store: row2.store, phase: 'FN-check',
                               status: 'ERROR', error: e.message });
            }
        }

        await browser.close().catch(function() {});

        validationStats.lastRun = new Date().toISOString();
        validationStats.runCount++;
        validationStats.lastResults = results;
        validationStats.lastSummary = summary;

        console.log('[validator] Done — TP:' + summary.tp + ' FP:' + summary.fp + ' FN:' + summary.fn + ' TN:' + summary.tn + ' ERR:' + summary.errors);

    } catch (e) {
        console.error('[validator] Fatal error:', e.message);
    } finally {
        delete activeScans['_validator'];
    }
}

// ── 3-step validation with per-store sub-steps ──
async function validateSingleResult(page, store, searchUrl, item) {
    var steps = {
        '1a_url_resolves': false, '1b_products_in_dom': false,
        '2a_artist_match': false, '2b_title_match': false,
        '3a_no_soldout': false, '3b_no_oos': false, '3c_stock_signals': false
    };

    var oosSignals = STORE_OOS_SIGNALS[store] || ['sold out', 'out of stock'];
    var stockSignals = STORE_IN_STOCK_SIGNALS[store] || ['add to cart'];

    // ── STEP 1a: URL resolves ──
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        steps['1a_url_resolves'] = true;
    } catch (e) {
        return { verdict: false, steps: steps, failedStep: 'step1a', reason: 'Page failed to load: ' + e.message, productsFound: 0 };
    }

    // ── STEP 1b: Product elements exist in DOM ──
    var allProducts = await extractProducts(page, store);

    if (allProducts.length > 0) {
        steps['1b_products_in_dom'] = true;
    } else {
        return { verdict: false, steps: steps, failedStep: 'step1b', reason: 'No product elements found in DOM', productsFound: 0 };
    }

    // ── STEP 2a & 2b: Artist and title matching ──
    var matchingProducts = [];
    for (var i = 0; i < allProducts.length; i++) {
        var p = allProducts[i];
        var artistMatch = false;
        var titleMatch = false;

        if (p.artist && item.artist) {
            artistMatch = scrapers.normalize(p.artist).indexOf(scrapers.normalize(item.artist)) !== -1 ||
                          scrapers.normalize(item.artist).indexOf(scrapers.normalize(p.artist)) !== -1;
        }
        if (p.title && item.title) {
            titleMatch = scrapers.normalize(p.title).indexOf(scrapers.normalize(item.title)) !== -1 ||
                         scrapers.normalize(item.title).indexOf(scrapers.normalize(p.title)) !== -1;
        }

        // Use full match logic as fallback
        var fullMatch = p.artist ? scrapers.recordsMatch(item, p) : scrapers.recordsMatchCombined(item, (p.artist + ' ' + p.title).trim());

        if (fullMatch || (artistMatch && titleMatch)) {
            if (artistMatch) steps['2a_artist_match'] = true;
            if (titleMatch) steps['2b_title_match'] = true;
            matchingProducts.push(p);
        }
    }

    if (matchingProducts.length === 0) {
        return { verdict: false, steps: steps, failedStep: 'step2b', reason: 'Products found (' + allProducts.length + ') but none match record',
                 productsFound: allProducts.length };
    }
    // Ensure both steps marked if fullMatch triggered
    if (matchingProducts.length > 0 && !steps['2a_artist_match']) steps['2a_artist_match'] = true;
    if (matchingProducts.length > 0 && !steps['2b_title_match']) steps['2b_title_match'] = true;

    // ── STEP 3a, 3b, 3c: Stock status sub-checks ──
    var inStockMatches = [];
    for (var j = 0; j < matchingProducts.length; j++) {
        var mp = matchingProducts[j];
        var text = mp.pageText || '';

        // 3a: Check for "sold out" specifically
        var hasSoldOut = text.indexOf('sold out') !== -1;
        // 3b: Check for "out of stock" and other OOS signals
        var hasOOS = oosSignals.some(function(sig) { return text.indexOf(sig) !== -1; });
        // 3c: Check for positive stock signals (add to cart, buy, etc.)
        var hasStockSignal = stockSignals.some(function(sig) { return text.indexOf(sig) !== -1; });

        if (!hasSoldOut && !hasOOS) {
            steps['3a_no_soldout'] = true;
            steps['3b_no_oos'] = true;
            if (hasStockSignal) steps['3c_stock_signals'] = true;
            inStockMatches.push(mp);
        }
    }

    if (inStockMatches.length === 0) {
        var failedSub = 'step3b';
        if (matchingProducts.some(function(mp) { return (mp.pageText || '').indexOf('sold out') !== -1; })) failedSub = 'step3a';
        return { verdict: false, steps: steps, failedStep: failedSub,
                 reason: 'Record found but out of stock', productsFound: allProducts.length, matchCount: matchingProducts.length };
    }

    return { verdict: true, steps: steps, productsFound: allProducts.length,
             matchCount: matchingProducts.length, inStockCount: inStockMatches.length };
}

// ── Per-store product extraction ──
async function extractProducts(page, store) {
    if (store === 'Deejay.de') {
        await page.waitForSelector('.product h2.artist, .product h3.title', { timeout: 4000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product').forEach(function(el) {
                if (el.classList.contains('equip')) return;
                items.push({ artist: (el.querySelector('h2.artist') || {}).textContent || '',
                             title: (el.querySelector('h3.title') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'HHV') {
        await page.waitForSelector('.items--shared--gallery-entry--base-component', { timeout: 5000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.items--shared--gallery-entry--base-component:not(.overlay)').forEach(function(el) {
                items.push({ artist: (el.querySelector('span.artist') || {}).textContent || '',
                             title: (el.querySelector('span.title') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Hardwax') {
        await page.waitForSelector('.product, .searchresult', { timeout: 4000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product, .searchresult').forEach(function(el) {
                items.push({ artist: (el.querySelector('.artist, .catlink') || {}).textContent || '',
                             title: (el.querySelector('.title, .linklist a') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Juno') {
        await page.waitForSelector('.product-card, .product_info', { timeout: 4000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product-card, .product_info').forEach(function(el) {
                items.push({ artist: (el.querySelector('.product-artist, .product_info_artist') || {}).textContent || '',
                             title: (el.querySelector('.product-title, .product_info_title') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Turntable Lab') {
        await page.waitForSelector('.product-card, .grid-item', { timeout: 4000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product-card, .grid-item').forEach(function(el) {
                items.push({ artist: '', title: (el.querySelector('.product-card__title, h2, h3') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Underground Vinyl') {
        await page.waitForSelector('.product-card.product-grid', { timeout: 4000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product-card.product-grid').forEach(function(el) {
                var combined = (el.querySelector('h6.product-card__name, .product-card__name') || {}).textContent || '';
                var artist = '', title = '';
                if (combined.indexOf(' - ') !== -1) { var p = combined.split(' - '); artist = p[0].trim(); title = p.slice(1).join(' - ').trim(); }
                else { title = combined.trim(); }
                items.push({ artist: artist, title: title, pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Phonica') {
        // Phonica uses a JSON API — for validation we load the search page
        await page.waitForSelector('.product-place-holder, .archive-artist', { timeout: 5000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product-place-holder').forEach(function(el) {
                items.push({ artist: (el.querySelector('.archive-artist') || {}).textContent || '',
                             title: (el.querySelector('.archive-title') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Yoyaku') {
        await page.waitForSelector('li.product', { timeout: 5000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('li.product').forEach(function(el) {
                var titleEl = el.querySelector('.wd-entities-title a, h2 a, .product-title a');
                var combined = titleEl ? titleEl.textContent.trim() : '';
                items.push({ artist: '', title: combined,
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    } else if (store === 'Decks.de') {
        await page.waitForSelector('.product_container, .product', { timeout: 4000 }).catch(function() {});
        return page.evaluate(function() {
            var items = [];
            document.querySelectorAll('.product_container, .product').forEach(function(el) {
                items.push({ artist: (el.querySelector('.artist') || {}).textContent || '',
                             title: (el.querySelector('.title') || {}).textContent || '',
                             pageText: el.textContent.toLowerCase() });
            });
            return items;
        });
    }
    return [];
}

function getValidationStats() {
    return validationStats;
}

// Job health tracking
var jobHealth = {
    lastBackgroundSync: null,
    lastDailyRescan: null,
    lastValidation: null,
    backgroundSyncCount: 0,
    dailyRescanCount: 0,
    validationCount: 0,
    backgroundSyncErrors: 0,
    dailyRescanErrors: 0,
    validationErrors: 0,
    lastError: null,
    startedAt: new Date().toISOString()
};

function trackJobRun(jobType, success, error) {
    var now = new Date().toISOString();
    if (jobType === 'sync') {
        jobHealth.lastBackgroundSync = now;
        jobHealth.backgroundSyncCount++;
        if (!success) { jobHealth.backgroundSyncErrors++; jobHealth.lastError = { job: 'sync', error: error, at: now }; }
    } else if (jobType === 'daily') {
        jobHealth.lastDailyRescan = now;
        jobHealth.dailyRescanCount++;
        if (!success) { jobHealth.dailyRescanErrors++; jobHealth.lastError = { job: 'daily', error: error, at: now }; }
    } else if (jobType === 'validate') {
        jobHealth.lastValidation = now;
        jobHealth.validationCount++;
        if (!success) { jobHealth.validationErrors++; jobHealth.lastError = { job: 'validate', error: error, at: now }; }
    }
}

function getActiveScans() {
    var result = {};
    Object.keys(activeScans).forEach(function(k) {
        result[k] = { type: activeScans[k], running: true };
    });
    return result;
}

function getJobHealth() {
    return jobHealth;
}

function getScanStatus(username) {
    var sp = scanProgress[username];
    var isActive = !!activeScans[username];
    if (!sp && !isActive) return { active: false, progress: null };

    // Count progress from stored events
    var completed = 0;
    var total = 0;
    var lastItem = null;
    if (sp) {
        sp.events.forEach(function(ev) {
            if (ev.type === 'wantlist' && ev.data.total) total = ev.data.total;
            if (ev.type === 'item-done') {
                completed++;
                lastItem = ev.data.item ? (ev.data.item.artist + ' \u2014 ' + ev.data.item.title) : null;
            }
        });
    }

    return {
        active: isActive,
        done: sp ? sp.done : false,
        completed: completed,
        total: total,
        lastItem: lastItem
    };
}

module.exports = {
    runScan,
    backgroundSync,
    dailyFullRescan,
    validateInStockResults,
    getValidationStats,
    sendNotifications,
    createWorkerPages,
    getActiveScans,
    getJobHealth,
    getScanStatus,
    trackJobRun,
    get activeScans() { return activeScans; },
    set activeScans(v) { activeScans = v; },
    get scanProgress() { return scanProgress; },
    set scanProgress(v) { scanProgress = v; }
};
