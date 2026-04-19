'use strict';

// ── Keep-alive alarm (MV3 service workers die after ~30s of inactivity) ───────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === 'keepAlive') {
        // Just waking up — check if a sync is running and continue if needed
        chrome.storage.local.get('syncState', function (data) {
            var state = data.syncState;
            if (state && state.running && !state.workerActive) {
                // Worker was killed mid-sync — resume
                resumeSync(state);
            }
        });
    }
});

// ── Message handler from popup ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'startSync') {
        startSync(msg.server, msg.username);
        sendResponse({ ok: true });
    }
    if (msg.action === 'getStatus') {
        chrome.storage.local.get('syncState', function (data) {
            sendResponse(data.syncState || { running: false });
        });
        return true; // async
    }
});

// ── Sync orchestration ────────────────────────────────────────────────────────
async function startSync(server, username) {
    // Fetch wantlist from server
    var items = [];
    try {
        var res  = await fetch(server + '/api/results/' + encodeURIComponent(username));
        var data = await res.json();
        items = (data.results || []).filter(function (r) { return r.item && r.item.id; });
    } catch (e) {
        setState({ running: false, error: 'Could not reach server: ' + e.message });
        return;
    }

    if (!items.length) {
        setState({ running: false, error: 'No wantlist items found. Run a scan first.' });
        return;
    }

    setState({ running: true, workerActive: true, done: 0, total: items.length,
               found: 0, server: server, username: username, items: items, cursor: 0 });

    await runSyncLoop();
}

async function resumeSync(state) {
    setState({ workerActive: true });
    await runSyncLoop();
}

async function runSyncLoop() {
    var data  = await getState();
    var state = data.syncState;
    if (!state || !state.running) return;

    var items    = state.items;
    var server   = state.server;
    var username = state.username;
    var cursor   = state.cursor || 0;
    var found    = state.found  || 0;
    var allListings = [];

    for (var i = cursor; i < items.length; i++) {
        var item    = items[i];
        var sellers = await fetchMarketplacePage(item.item.id, item.wantlistId);
        allListings = allListings.concat(sellers);
        found += sellers.length;

        setState({ running: true, workerActive: true, done: i + 1,
                   total: items.length, found: found, cursor: i + 1,
                   server: server, username: username, items: items });

        await sleep(400);
    }

    // Post all listings to server
    try {
        await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ listings: allListings })
        });
    } catch (e) {}

    setState({ running: false, workerActive: false, done: items.length,
               total: items.length, found: found, completedAt: Date.now() });
}

// ── Fetch + parse Discogs marketplace page ────────────────────────────────────
async function fetchMarketplacePage(discogsId, wantlistId) {
    try {
        var res = await fetch('https://www.discogs.com/sell/release/' + discogsId, {
            credentials: 'include'
        });
        if (!res.ok) return [];
        var html = await res.text();
        return parseHtml(html, wantlistId);
    } catch (e) {
        return [];
    }
}

function parseHtml(html, wantlistId) {
    var listings = [];

    // Try __NEXT_DATA__ JSON first (most reliable)
    var match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
        try {
            var json    = JSON.parse(match[1]);
            var page    = json && json.props && json.props.pageProps;
            var results = (page && page.listings) ||
                          (page && page.data && page.data.listings) || [];
            results.forEach(function (l) {
                if (!l.seller || !l.seller.username) return;
                listings.push({
                    wantlistId:       wantlistId,
                    listingId:        l.id,
                    sellerUsername:   l.seller.username,
                    sellerRating:     l.seller.stats && parseFloat(l.seller.stats.rating),
                    sellerNumRatings: l.seller.stats && l.seller.stats.total,
                    priceOriginal:    l.price && l.price.value,
                    currency:         l.price && l.price.currency || 'USD',
                    condition:        l.condition || '',
                    shipsFrom:        l.ships_from || '',
                    listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                });
            });
            if (listings.length) return listings;
        } catch (e) {}
    }

    // Fallback: parse HTML table rows
    var rowMatches = html.matchAll(/<tr[^>]*class="[^"]*shortcut_navigable[^"]*"[^>]*>([\s\S]*?)<\/tr>/g);
    for (var row of rowMatches) {
        try {
            var cell    = row[1];
            var seller  = (cell.match(/\/seller\/([^"/?]+)/) || [])[1];
            var price   = parseFloat((cell.match(/[\$£€¥]([\d,]+\.?\d*)/) || ['', '0'])[1].replace(',', ''));
            var listId  = (cell.match(/\/sell\/item\/(\d+)/) || [])[1];
            var cond    = (cell.match(/class="[^"]*condition[^"]*"[^>]*>([^<]+)/) || [])[1] || '';
            var ships   = (cell.match(/Ships From.*?<.*?>([^<]+)/) || [])[1] || '';
            if (!seller) continue;
            listings.push({
                wantlistId:     wantlistId,
                listingId:      listId ? parseInt(listId) : null,
                sellerUsername: seller,
                priceOriginal:  price || null,
                currency:       'USD',
                condition:      cond.trim(),
                shipsFrom:      ships.trim(),
                listingUrl:     listId ? 'https://www.discogs.com/sell/item/' + listId : ''
            });
        } catch (e) {}
    }

    return listings;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setState(patch) {
    return new Promise(function (resolve) {
        chrome.storage.local.get('syncState', function (data) {
            var current = data.syncState || {};
            var next    = Object.assign({}, current, patch);
            chrome.storage.local.set({ syncState: next }, resolve);
        });
    });
}

function getState() {
    return new Promise(function (resolve) {
        chrome.storage.local.get('syncState', resolve);
    });
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}
