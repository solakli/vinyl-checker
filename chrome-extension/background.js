'use strict';

// Keep items in memory (don't store giant array in chrome.storage)
var _items   = [];
var _running = false;

// ── Keep-alive alarm (only create if not already registered) ─────────────────
chrome.alarms.getAll(function (existing) {
    if (!existing.find(function (a) { return a.name === 'keepAlive'; })) {
        chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
    }
});
chrome.alarms.onAlarm.addListener(function () { /* just wakes the worker */ });

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'startSync') {
        if (_running) { sendResponse({ ok: true, alreadyRunning: true }); return; }
        sendResponse({ ok: true });
        startSync(msg.server, msg.username);
    }
    // Triggered by content-script when app page triggers a sync
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

    console.log('[WaxDigger] Fetching wantlist for', username, 'from', server);

    // Fetch wantlist
    try {
        var res  = await fetch(server + '/api/results/' + encodeURIComponent(username));
        var data = await res.json();
        _items   = (data.results || []).filter(function (r) { return r.item && r.item.id; });
    } catch (e) {
        console.error('[WaxDigger] Failed to fetch wantlist:', e.message);
        await setProgress({ running: false, error: 'Could not reach server: ' + e.message });
        _running = false;
        return;
    }

    console.log('[WaxDigger] Got', _items.length, 'wantlist items');
    await setProgress({ running: true, done: 0, total: _items.length, found: 0 });

    // Get Discogs cookies once
    var cookieHeader = await getDiscogsCookieHeader();
    console.log('[WaxDigger] Cookie header length:', cookieHeader.length);

    if (!cookieHeader) {
        await setProgress({ running: false, error: 'Not logged into Discogs — open discogs.com and log in first.' });
        _running = false;
        return;
    }

    // Fetch each release and batch-post every 25 so the UI shows progressive results.
    // saveDiscogsListings() is per-wantlist-item (DELETEs+INSERTs per item), so
    // partial batches are safe — subsequent batches just add more items.
    var BATCH_SIZE = 25;
    var allListings = [];
    var pendingBatch = [];

    async function flushBatch() {
        if (!pendingBatch.length) return;
        var toSend = pendingBatch.slice();
        pendingBatch = [];
        console.log('[WaxDigger] Flushing batch of', toSend.length, 'listings');
        try {
            var r = await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listings: toSend })
            });
            console.log('[WaxDigger] Batch POST result:', r.status);
        } catch (e) {
            console.error('[WaxDigger] Batch POST failed:', e.message);
        }
    }

    for (var i = 0; i < _items.length; i++) {
        var item    = _items[i];
        var sellers = await fetchMarketplacePage(item.item.id, item.wantlistId, cookieHeader);
        allListings = allListings.concat(sellers);
        pendingBatch = pendingBatch.concat(sellers);

        await setProgress({ running: true, done: i + 1, total: _items.length, found: allListings.length });

        // Flush every BATCH_SIZE releases so the UI shows progressive results
        if (pendingBatch.length >= BATCH_SIZE || (i === _items.length - 1)) {
            await flushBatch();
        }

        // Discogs rate limit: 60 req/min authenticated → 1 req/sec safe ceiling
        await sleep(1100);
    }

    await setProgress({ running: false, done: _items.length, total: _items.length,
                        found: allListings.length, completedAt: Date.now() });
    _running = false;
    console.log('[WaxDigger] Sync complete');
}

// ── Discogs cookies ───────────────────────────────────────────────────────────
async function getDiscogsCookieHeader() {
    return new Promise(function (resolve) {
        chrome.cookies.getAll({ domain: 'discogs.com' }, function (cookies) {
            console.log('[WaxDigger] Cookies found:', cookies ? cookies.length : 0);
            if (!cookies || !cookies.length) { resolve(''); return; }
            resolve(cookies.map(function (c) { return c.name + '=' + c.value; }).join('; '));
        });
    });
}

// ── Fetch + parse Discogs marketplace page ────────────────────────────────────
// Uses HTML scraping of the authenticated Discogs marketplace page.
// The browser cookies give us the user's logged-in session, so ships_from and
// personalized shipping prices are visible in the HTML.
// NOTE: The Discogs REST API was tried previously but it doesn't auth via browser
// cookies (needs OAuth tokens), so it returned listings without ships_from data.
async function fetchMarketplacePage(discogsId, wantlistId, cookieHeader) {

    // ── HTML scraping (authenticated via browser session cookies) ─────────────
    try {
        var url = 'https://www.discogs.com/sell/release/' + discogsId;
        var res = await fetch(url, {
            headers: {
                'Cookie':          cookieHeader,
                'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        console.log('[WaxDigger] HTML fallback', discogsId, '→', res.status);
        if (!res.ok) return [];
        var html   = await res.text();
        var parsed = parseHtml(html, wantlistId);
        console.log('[WaxDigger] HTML fallback parsed', parsed.length, 'listings for', discogsId);
        return parsed;
    } catch (e) {
        console.error('[WaxDigger] HTML fallback error for', discogsId, ':', e.message);
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
            var json = JSON.parse(match[1]);
            var page = json && json.props && json.props.pageProps;
            var results = (page && page.listings) ||
                          (page && page.data && page.data.listings) ||
                          (page && page.initialListings) || [];

            results.forEach(function (l, idx) {
                if (!l.seller || !l.seller.username) return;

                // ── Debug: log structure of first listing once per page ───────
                if (idx === 0) {
                    console.log('[WaxDigger] listing[0] keys:', JSON.stringify(Object.keys(l)));
                    if (l.seller) console.log('[WaxDigger] listing[0].seller keys:', JSON.stringify(Object.keys(l.seller)));
                    var shipFields = ['ships_from','shipsFrom','location','shipping_price',
                                      'shippingPrice','original_shipping_price','shipping'];
                    var found = {};
                    shipFields.forEach(function(k) { if (l[k] !== undefined) found[k] = l[k]; });
                    console.log('[WaxDigger] shipping-related fields:', JSON.stringify(found));
                }

                // ── ships_from: try every field name Discogs has used ─────────
                // Discogs REST API uses "ships_from" (full country name e.g. "Germany").
                // Their Next.js builds have varied this over time.
                var shipsFrom = l.ships_from         // REST API / older Next.js
                             || l.location            // some Next.js builds
                             || l.shipsFrom           // camelCase variant
                             || (l.seller && (l.seller.location || l.seller.ships_from))
                             || '';

                // ── shipping price to buyer (personalized — we're authenticated) ─
                // When logged in, Discogs shows the shipping cost to the buyer's
                // registered location. This is more accurate than our estimate table.
                var shipPrice = null;
                var shipCur   = (l.price && l.price.currency) || 'USD';

                var sp = l.shipping_price || l.shippingPrice || l.original_shipping_price;
                if (sp && typeof sp === 'object' && sp.value != null) {
                    shipPrice = sp.value;
                    shipCur   = sp.currency || shipCur;
                } else if (sp != null && typeof sp === 'number') {
                    shipPrice = sp;
                } else if (typeof l.shipping === 'number') {
                    shipPrice = l.shipping;
                }

                listings.push({
                    wantlistId:       wantlistId,
                    listingId:        l.id,
                    sellerUsername:   l.seller.username,
                    sellerRating:     l.seller.stats && parseFloat(l.seller.stats.rating),
                    sellerNumRatings: l.seller.stats && l.seller.stats.total,
                    priceOriginal:    l.price && l.price.value,
                    currency:         (l.price && l.price.currency) || 'USD',
                    condition:        l.condition || '',
                    shipsFrom:        shipsFrom,
                    shippingPrice:    shipPrice,     // actual cost to buyer (null = not on page)
                    shippingCurrency: shipCur,
                    listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                });
            });
            if (listings.length) return listings;
        } catch (e) {
            console.error('[WaxDigger] __NEXT_DATA__ parse error:', e.message);
        }
    }

    // Fallback: regex on HTML rows (legacy Discogs layout)
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
            // Try to grab ships_from from the row HTML.
            // Pattern 1 (current layout): <span class="mplabel">Ships From:</span>Norway</li>
            // Pattern 2: data-country="DE" attribute
            // Pattern 3: Ships From: inside a tag (older layout)
            var fromM  = cell.match(/Ships From:<\/span>\s*([A-Za-z][A-Za-z ,]+?)(?:\s*<)/i)
                      || cell.match(/data-country="([^"]+)"/i)
                      || cell.match(/Ships\s+From[^<]*<[^>]+>\s*([A-Za-z][A-Za-z ]{1,30}?)\s*</i);
            listings.push({
                wantlistId:      wantlistId,
                listingId:       listId ? parseInt(listId) : null,
                sellerUsername:  seller,
                priceOriginal:   price || null,
                currency:        'USD',
                condition:       cond.trim(),
                shipsFrom:       fromM ? fromM[1].trim() : '',
                shippingPrice:   null,
                shippingCurrency:'USD',
                listingUrl:      listId ? 'https://www.discogs.com/sell/item/' + listId : ''
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
