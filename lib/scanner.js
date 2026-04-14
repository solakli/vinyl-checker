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
            var wantlist = await discogs.fetchWantlist(user.username);
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

module.exports = {
    runScan,
    backgroundSync,
    sendNotifications,
    createWorkerPages,
    get activeScans() { return activeScans; },
    set activeScans(v) { activeScans = v; },
    get scanProgress() { return scanProgress; },
    set scanProgress(v) { scanProgress = v; }
};
