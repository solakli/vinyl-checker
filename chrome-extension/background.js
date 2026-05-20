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

    // Fetch each release
    var allListings = [];
    for (var i = 0; i < _items.length; i++) {
        var item    = _items[i];
        var sellers = await fetchMarketplacePage(item.item.id, item.wantlistId, cookieHeader);
        allListings = allListings.concat(sellers);

        await setProgress({ running: true, done: i + 1, total: _items.length, found: allListings.length });
        // Discogs API rate limit: 60 req/min authenticated → 1 req/sec safe ceiling
        await sleep(1100);
    }

    // Post to server
    console.log('[WaxDigger] Posting', allListings.length, 'listings to server');
    try {
        var postRes = await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ listings: allListings })
        });
        console.log('[WaxDigger] POST result:', postRes.status);
    } catch (e) {
        console.error('[WaxDigger] Failed to post listings:', e.message);
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
// Primary: REST API → stable field names, personalized shipping_price when logged in.
// Fallback: HTML scraping (parseHtml) in case the API is down or returns 0 listings.
async function fetchMarketplacePage(discogsId, wantlistId, cookieHeader) {

    // ── 1. Discogs REST API ───────────────────────────────────────────────────
    try {
        var apiUrl = 'https://api.discogs.com/marketplace/search' +
                     '?release_id=' + discogsId +
                     '&type=listing&currency=USD&per_page=100&sort=price&sort_order=asc';
        var apiRes = await fetch(apiUrl, {
            headers: {
                'Cookie':          cookieHeader,
                'User-Agent':      'WaxDigger/1.0 +https://waxdigger.ai',
                'Accept':          'application/json',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        var remaining = apiRes.headers.get('X-Discogs-Ratelimit-Remaining') || '?';
        console.log('[WaxDigger] API', discogsId, '→', apiRes.status, '| rate-limit remaining:', remaining);

        if (apiRes.status === 429) {
            // Rate-limited — log and return [] (sync will resume next time)
            console.warn('[WaxDigger] Rate limited by Discogs API for', discogsId, '— skipping');
            return [];
        }

        if (apiRes.ok) {
            var apiData    = await apiRes.json();
            // /marketplace/search returns { results: [...] }, not { listings: [...] }
            var apiListings = (apiData.results || []).filter(function (l) {
                return l.seller && l.seller.username;
            });

            if (apiListings.length > 0) {
                var results = apiListings.map(function (l) {
                    // ships_from is a top-level string in the REST API ("Germany", "United States", …)
                    var shipsFrom = l.ships_from || (l.seller && l.seller.location) || '';

                    // shipping_price is personalised to the logged-in buyer's registered address.
                    // With currency=USD the value is already converted to USD.
                    var shipPrice = null;
                    var shipCur   = (l.price && l.price.currency) || 'USD';
                    if (l.shipping_price && typeof l.shipping_price === 'object' &&
                        l.shipping_price.value != null) {
                        shipPrice = l.shipping_price.value;
                        shipCur   = l.shipping_price.currency || shipCur;
                    } else if (typeof l.shipping_price === 'number') {
                        shipPrice = l.shipping_price;
                    }

                    return {
                        wantlistId:       wantlistId,
                        listingId:        l.id,
                        sellerUsername:   l.seller.username,
                        sellerRating:     l.seller.stats && parseFloat(l.seller.stats.rating),
                        sellerNumRatings: l.seller.stats && l.seller.stats.total,
                        priceOriginal:    l.price && l.price.value,
                        currency:         (l.price && l.price.currency) || 'USD',
                        condition:        l.condition || '',
                        shipsFrom:        shipsFrom,
                        shippingPrice:    shipPrice,     // personalised cost to buyer (null = not returned)
                        shippingCurrency: shipCur,
                        listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                    };
                });

                // Debug: show first listing's shipping data so we can verify it's working
                if (results[0]) {
                    console.log('[WaxDigger] API sample —',
                        'shipsFrom:', results[0].shipsFrom,
                        'shippingPrice:', results[0].shippingPrice,
                        'shippingCurrency:', results[0].shippingCurrency);
                }
                console.log('[WaxDigger] API got', results.length, 'listings for', discogsId);
                return results;
            }
            // API returned ok but 0 listings — fall through to HTML
            console.log('[WaxDigger] API returned 0 listings for', discogsId, '— trying HTML fallback');
        }
    } catch (apiErr) {
        console.error('[WaxDigger] API error for', discogsId, ':', apiErr.message);
    }

    // ── 2. Fallback: HTML scraping ────────────────────────────────────────────
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
            // Try to grab ships_from from the row HTML
            var fromM  = cell.match(/data-country="([^"]+)"/i)
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
