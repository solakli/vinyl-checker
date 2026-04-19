'use strict';

var fill    = document.getElementById('fill');
var label   = document.getElementById('label');
var statusEl= document.getElementById('status');
var closeBtn= document.getElementById('closeBtn');

// Read config passed via storage
chrome.storage.local.get(['serverUrl', 'username'], async function (data) {
    var server   = (data.serverUrl || '').replace(/\/$/, '');
    var username = data.username || '';

    if (!server || !username) {
        showStatus('Missing server URL or username.', 'err');
        closeBtn.style.display = 'block';
        return;
    }

    await runSync(server, username);
});

var syncStartedAt = Date.now();

async function runSync(server, username) {
    // Step 1: fetch wantlist
    label.textContent = 'Fetching wantlist...';
    var items;
    try {
        var res  = await fetch(server + '/api/results/' + encodeURIComponent(username));
        var data = await res.json();
        items = (data.results || []).filter(function (r) { return r.item && r.item.id; });
    } catch (e) {
        showStatus('Cannot reach server: ' + e.message, 'err');
        closeBtn.style.display = 'block';
        return;
    }

    if (!items.length) {
        showStatus('No wantlist items found. Run a scan first.', 'err');
        closeBtn.style.display = 'block';
        return;
    }

    // Step 2: fetch each release marketplace page (credentials:include works here!)
    var allListings = [];
    for (var i = 0; i < items.length; i++) {
        var item    = items[i];
        var sellers = await fetchMarketplacePage(item.item.id, item.wantlistId);
        allListings = allListings.concat(sellers);

        var pct = Math.round(((i + 1) / items.length) * 100);
        fill.style.width  = pct + '%';
        label.textContent = (i + 1) + ' / ' + items.length + ' releases · ' + allListings.length + ' listings found';

        // Save progress so popup can read it
        chrome.storage.local.set({ syncState: {
            running: true, startedAt: syncStartedAt, done: i + 1, total: items.length, found: allListings.length
        }});

        await sleep(350);
    }

    // Step 3: post to server
    label.textContent = 'Saving ' + allListings.length + ' listings...';
    try {
        var postRes = await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ listings: allListings })
        });
        var postData = await postRes.json();
        if (!postRes.ok) throw new Error(postData.error || 'Server error');
    } catch (e) {
        showStatus('Failed to save: ' + e.message, 'err');
        closeBtn.style.display = 'block';
        chrome.storage.local.set({ syncState: { running: false, error: e.message } });
        return;
    }

    // Done
    fill.style.width = '100%';
    label.textContent = items.length + ' releases · ' + allListings.length + ' listings synced';
    showStatus('✓ Done! You can now close this window and run Dig For Gold.', 'ok');
    closeBtn.style.display = 'block';
    chrome.storage.local.set({ syncState: {
        running: false, done: items.length, total: items.length,
        found: allListings.length, completedAt: Date.now()
    }});
}

async function fetchMarketplacePage(discogsId, wantlistId) {
    try {
        var res = await fetch('https://www.discogs.com/sell/release/' + discogsId, {
            credentials: 'include'   // works in extension windows!
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

    // Best: __NEXT_DATA__ JSON embedded in the page
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

    // Fallback: parse HTML rows via DOMParser
    var parser = new DOMParser();
    var doc    = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('tr.shortcut_navigable').forEach(function (row) {
        try {
            var sellerLink  = row.querySelector('a[href*="/seller/"]');
            var priceEl     = row.querySelector('.price') || row.querySelector('[class*="price"]');
            var condEl      = row.querySelector('[class*="condition"]');
            var shipsEl     = row.querySelector('[class*="ships"]');
            var listingLink = row.querySelector('a[href*="/sell/item/"]');
            if (!sellerLink) return;
            var listId = null;
            if (listingLink) {
                var m = listingLink.href.match(/\/sell\/item\/(\d+)/);
                if (m) listId = parseInt(m[1]);
            }
            listings.push({
                wantlistId:     wantlistId,
                listingId:      listId,
                sellerUsername: sellerLink.textContent.trim(),
                priceOriginal:  priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '')) : null,
                currency:       'USD',
                condition:      condEl ? condEl.textContent.trim() : '',
                shipsFrom:      shipsEl ? shipsEl.textContent.trim() : '',
                listingUrl:     listingLink ? listingLink.href : ''
            });
        } catch (e) {}
    });

    return listings;
}

function showStatus(msg, type) {
    statusEl.textContent   = msg;
    statusEl.className     = 'status ' + type;
    statusEl.style.display = 'block';
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
