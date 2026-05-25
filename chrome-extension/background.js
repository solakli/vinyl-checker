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

    // ── Step 1: Build a listing-id → ships_from map from the raw HTML ─────────
    // The HTML always contains "Ships From:" text in each row regardless of
    // which JSON structure Discogs uses.  We build this map first so it can
    // enrich listings found via __NEXT_DATA__ (which often lacks ships_from).
    var htmlCountryMap = {};
    var rowRe = /<tr[^>]*class="[^"]*shortcut_navigable[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    var row;
    while ((row = rowRe.exec(html)) !== null) {
        try {
            var cell   = row[1];
            var listId = (cell.match(/\/sell\/item\/(\d+)/) || [])[1];
            if (!listId) continue;
            var fromM  = cell.match(/Ships\s*From\s*:<\/span>\s*([A-Za-z][A-Za-z ,\-]{1,40}?)(?:\s*<)/i)
                      || cell.match(/data-country="([^"]+)"/i)
                      || cell.match(/Ships\s+From[^<]*<[^>]+>\s*([A-Za-z][A-Za-z ]{1,30}?)\s*</i);
            if (fromM) htmlCountryMap[listId] = fromM[1].trim();
        } catch (e) {}
    }
    console.log('[WaxDigger] HTML country map entries:', Object.keys(htmlCountryMap).length);

    // ── Step 2: Try __NEXT_DATA__ JSON for structured listing data ────────────
    var match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
        try {
            var json = JSON.parse(match[1]);
            var page = json && json.props && json.props.pageProps;

            // Debug: log top-level pageProps keys once
            if (page) {
                console.log('[WaxDigger] pageProps keys:', JSON.stringify(Object.keys(page)));
            }

            var results = (page && page.listings) ||
                          (page && page.data && page.data.listings) ||
                          (page && page.initialListings) ||
                          (page && page.release && page.release.forSale) ||
                          (page && page.releaseMarketplace && page.releaseMarketplace.listings) ||
                          [];

            results.forEach(function (l, idx) {
                if (!l.seller || !l.seller.username) return;

                // ── Debug: log full first listing for field discovery ─────────
                if (idx === 0) {
                    console.log('[WaxDigger] listing[0] full:', JSON.stringify(l).substring(0, 800));
                    console.log('[WaxDigger] listing[0].seller:', JSON.stringify(l.seller).substring(0, 400));
                }

                // ── ships_from: try all known field variants, then fall back to HTML map ──
                var shipsFrom = l.ships_from                            // REST API / older Next.js
                             || l.location                              // some Next.js builds
                             || l.shipsFrom                             // camelCase
                             || l.country                               // possible top-level
                             || l.country_code                          // ISO code variant
                             || l.countryCode                           // camelCase ISO
                             || (l.seller && (
                                    l.seller.location
                                 || l.seller.ships_from
                                 || l.seller.shipsFrom
                                 || l.seller.country
                                 || l.seller.countryCode
                                 || l.seller.country_code
                                ))
                             || (l.shipping && (l.shipping.ships_from || l.shipping.location || l.shipping.country))
                             // Last resort: look it up in the HTML country map by listing id
                             || (l.id && htmlCountryMap[String(l.id)])
                             || '';

                // ── shipping price to buyer (personalized — we're authenticated) ─
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
                    shippingPrice:    shipPrice,
                    shippingCurrency: shipCur,
                    listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                });
            });

            if (listings.length) {
                var withCountry = listings.filter(function(l) { return !!l.shipsFrom; }).length;
                console.log('[WaxDigger] __NEXT_DATA__: ' + listings.length + ' listings, ' + withCountry + ' with ships_from');
                return listings;
            }
        } catch (e) {
            console.error('[WaxDigger] __NEXT_DATA__ parse error:', e.message);
        }
    }

    // ── Step 3: Full HTML fallback (legacy Discogs layout) ───────────────────
    // Only reaches here when __NEXT_DATA__ has no listings at all.
    var rowRe2 = /<tr[^>]*class="[^"]*shortcut_navigable[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    while ((row = rowRe2.exec(html)) !== null) {
        try {
            var cell   = row[1];
            var seller = (cell.match(/\/seller\/([^"/?]+)/) || [])[1];
            if (!seller) continue;
            var price  = parseFloat(((cell.match(/[\$£€¥]([\d,]+\.?\d*)/) || ['','0'])[1]).replace(/,/g,''));
            var listId = (cell.match(/\/sell\/item\/(\d+)/) || [])[1];
            var cond   = (cell.match(/title="([^"]+)"[^>]*>[^<]*<\/span>\s*<\/td>\s*<td/) || [])[1] || '';
            var fromM  = cell.match(/Ships\s*From\s*:<\/span>\s*([A-Za-z][A-Za-z ,\-]{1,40}?)(?:\s*<)/i)
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
