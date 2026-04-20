'use strict';

// Keep items in memory (don't store giant array in chrome.storage)
var _items   = [];
var _running = false;

// ── Keep-alive alarm ──────────────────────────────────────────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function () { /* just wakes the worker */ });

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'startSync') {
        if (_running) { sendResponse({ ok: true, alreadyRunning: true }); return; }
        sendResponse({ ok: true });
        startSync(msg.server, msg.username);
    }
    // Triggered by content-script when app page clicks "Dig For Gold"
    if (msg.action === 'openSyncWindow') {
        chrome.windows.create({
            url: chrome.runtime.getURL('sync-window.html'),
            type: 'popup',
            width: 380,
            height: 220,
            focused: false   // runs in background — app shows progress inline
        });
    }
    return false;
});

// ── Main sync entry point ─────────────────────────────────────────────────────
async function startSync(server, username) {
    _running = true;

    // Reset progress
    await setProgress({ running: true, done: 0, total: 0, found: 0, error: null, completedAt: null });

    console.log('[GoldDigger] Fetching wantlist for', username, 'from', server);

    // Fetch wantlist
    try {
        var res  = await fetch(server + '/api/results/' + encodeURIComponent(username));
        var data = await res.json();
        _items   = (data.results || []).filter(function (r) { return r.item && r.item.id; });
    } catch (e) {
        console.error('[GoldDigger] Failed to fetch wantlist:', e.message);
        await setProgress({ running: false, error: 'Could not reach server: ' + e.message });
        _running = false;
        return;
    }

    console.log('[GoldDigger] Got', _items.length, 'wantlist items');
    await setProgress({ running: true, done: 0, total: _items.length, found: 0 });

    // Get Discogs cookies once
    var cookieHeader = await getDiscogsCookieHeader();
    console.log('[GoldDigger] Cookie header length:', cookieHeader.length);

    if (!cookieHeader) {
        await setProgress({ running: false, error: 'Not logged into Discogs — open discogs.com and log in first.' });
        _running = false;
        return;
    }

    // Fetch each release
    var allListings = [];
    for (var i = 0; i < _items.length; i++) {
        var item    = _items[i];
        var sellers = await fetchMarketplacePage(item.item.id, item.wantlistId, cookieHeader);
        allListings = allListings.concat(sellers);

        await setProgress({ running: true, done: i + 1, total: _items.length, found: allListings.length });
        await sleep(400);
    }

    // Post to server
    console.log('[GoldDigger] Posting', allListings.length, 'listings to server');
    try {
        var postRes = await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ listings: allListings })
        });
        console.log('[GoldDigger] POST result:', postRes.status);
    } catch (e) {
        console.error('[GoldDigger] Failed to post listings:', e.message);
    }

    await setProgress({ running: false, done: _items.length, total: _items.length,
                        found: allListings.length, completedAt: Date.now() });
    _running = false;
    console.log('[GoldDigger] Sync complete');
}

// ── Discogs cookies ───────────────────────────────────────────────────────────
async function getDiscogsCookieHeader() {
    return new Promise(function (resolve) {
        chrome.cookies.getAll({ domain: 'discogs.com' }, function (cookies) {
            console.log('[GoldDigger] Cookies found:', cookies ? cookies.length : 0);
            if (!cookies || !cookies.length) { resolve(''); return; }
            resolve(cookies.map(function (c) { return c.name + '=' + c.value; }).join('; '));
        });
    });
}

// ── Fetch + parse Discogs marketplace page ────────────────────────────────────
async function fetchMarketplacePage(discogsId, wantlistId, cookieHeader) {
    try {
        var url = 'https://www.discogs.com/sell/release/' + discogsId;
        var res = await fetch(url, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        console.log('[GoldDigger]', url, '→', res.status);
        if (!res.ok) return [];
        var html    = await res.text();
        var parsed  = parseHtml(html, wantlistId);
        console.log('[GoldDigger] parsed', parsed.length, 'listings for', discogsId);
        return parsed;
    } catch (e) {
        console.error('[GoldDigger] fetch error for', discogsId, ':', e.message);
        return [];
    }
}

// ── HTML parser ───────────────────────────────────────────────────────────────
function parseHtml(html, wantlistId) {
    var listings = [];

    // Try __NEXT_DATA__ JSON (most reliable)
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
                    currency:         (l.price && l.price.currency) || 'USD',
                    condition:        l.condition || '',
                    shipsFrom:        l.ships_from || '',
                    listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                });
            });
            if (listings.length) return listings;
        } catch (e) {}
    }

    // Fallback: regex on HTML rows
    var rowRe = /<tr[^>]*class="[^"]*shortcut_navigable[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    var row;
    while ((row = rowRe.exec(html)) !== null) {
        try {
            var cell   = row[1];
            var seller = (cell.match(/\/seller\/([^"/?]+)/) || [])[1];
            if (!seller) continue;
            var price  = parseFloat(((cell.match(/[\$£€¥]([\d,]+\.?\d*)/) || ['','0'])[1]).replace(/,/g,''));
            var listId = (cell.match(/\/sell\/item\/(\d+)/) || [])[1];
            var cond   = (cell.match(/title="([^"]+)"[^>]*>[^<]*<\/span>\s*<\/td>\s*<td/) || [])[1] || '';
            listings.push({
                wantlistId:     wantlistId,
                listingId:      listId ? parseInt(listId) : null,
                sellerUsername: seller,
                priceOriginal:  price || null,
                currency:       'USD',
                condition:      cond.trim(),
                shipsFrom:      '',
                listingUrl:     listId ? 'https://www.discogs.com/sell/item/' + listId : ''
            });
        } catch (e) {}
    }

    return listings;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setProgress(patch) {
    return new Promise(function (resolve) {
        chrome.storage.local.get('syncState', function (data) {
            var next = Object.assign({}, data.syncState || {}, patch);
            chrome.storage.local.set({ syncState: next }, resolve);
        });
    });
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}
