'use strict';

var serverUrlInput = document.getElementById('serverUrl');
var usernameInput  = document.getElementById('username');
var syncBtn        = document.getElementById('syncBtn');
var progressWrap   = document.getElementById('progressWrap');
var progressFill   = document.getElementById('progressFill');
var progressText   = document.getElementById('progressText');
var statusEl       = document.getElementById('status');
var lastSyncedEl   = document.getElementById('lastSynced');
var openAppBtn     = document.getElementById('openApp');

// ── Load saved settings ───────────────────────────────────────
chrome.storage.local.get(['serverUrl', 'username', 'lastSynced'], function (data) {
    if (data.serverUrl) serverUrlInput.value = data.serverUrl;
    if (data.username)  usernameInput.value  = data.username;
    if (data.lastSynced) {
        lastSyncedEl.textContent = 'Last synced: ' + new Date(data.lastSynced).toLocaleString();
    }
    updateOpenBtn();
});

serverUrlInput.addEventListener('change', save);
usernameInput.addEventListener('change', save);

function save() {
    chrome.storage.local.set({
        serverUrl: serverUrlInput.value.trim().replace(/\/$/, ''),
        username:  usernameInput.value.trim()
    });
    updateOpenBtn();
}

function updateOpenBtn() {
    var url = serverUrlInput.value.trim().replace(/\/$/, '');
    openAppBtn.onclick = function () {
        chrome.tabs.create({ url: url || 'https://stream.ronautradio.la/vinyl' });
    };
}

// ── Sync button ───────────────────────────────────────────────
syncBtn.addEventListener('click', async function () {
    var server   = serverUrlInput.value.trim().replace(/\/$/, '');
    var username = usernameInput.value.trim();

    if (!server || !username) {
        showStatus('Fill in server URL and username.', 'error');
        return;
    }

    save();
    syncBtn.disabled = true;
    statusEl.style.display = 'none';
    progressWrap.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'Fetching wantlist...';

    try {
        // Step 1: get wantlist release IDs from our server
        var wlRes  = await fetch(server + '/api/results/' + encodeURIComponent(username));
        var wlData = await wlRes.json();
        var items  = (wlData.results || []).filter(function (r) { return r.item && r.item.id; });

        if (!items.length) {
            throw new Error('No wantlist items found. Run a scan first.');
        }

        progressText.textContent = '0 / ' + items.length + ' releases';

        // Step 2: for each release, fetch discogs.com/sell/release/{id} and parse sellers
        var allListings = [];
        for (var i = 0; i < items.length; i++) {
            var item    = items[i];
            var sellers = await fetchDiscogsMarketplacePage(item.item.id, item.wantlistId);
            allListings = allListings.concat(sellers);

            var pct = Math.round(((i + 1) / items.length) * 100);
            progressFill.style.width = pct + '%';
            progressText.textContent = (i + 1) + ' / ' + items.length + ' releases · ' + allListings.length + ' listings found';

            // Small delay to avoid hammering Discogs
            await sleep(400);
        }

        // Step 3: post all listings to our server
        progressText.textContent = 'Saving ' + allListings.length + ' listings...';
        var postRes = await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ listings: allListings })
        });
        var postData = await postRes.json();
        if (!postRes.ok) throw new Error(postData.error || 'Failed to save listings');

        // Done
        var now = Date.now();
        chrome.storage.local.set({ lastSynced: now });
        lastSyncedEl.textContent = 'Last synced: ' + new Date(now).toLocaleString();
        progressFill.style.width = '100%';
        progressText.textContent = 'Done!';
        showStatus('✓ Synced ' + allListings.length + ' seller listings across ' + items.length + ' releases.', 'success');
        syncBtn.disabled = false;

    } catch (e) {
        showStatus('Error: ' + e.message, 'error');
        progressWrap.style.display = 'none';
        syncBtn.disabled = false;
    }
});

// ── Parse Discogs marketplace page ───────────────────────────
async function fetchDiscogsMarketplacePage(discogsId, wantlistId) {
    try {
        var res = await fetch('https://www.discogs.com/sell/release/' + discogsId + '?output=json', {
            credentials: 'include'  // send user's Discogs session cookie
        });

        // Try JSON first (Discogs sometimes supports ?output=json)
        if (res.ok) {
            var ct = res.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                var data = await res.json();
                return parseDiscogsJson(data, wantlistId);
            }

            // Otherwise parse HTML
            var html = await res.text();
            return parseDiscogsHtml(html, wantlistId);
        }
    } catch (e) {
        // Network error or parse failure — skip this release
    }
    return [];
}

function parseDiscogsJson(data, wantlistId) {
    var listings = data.listings || data.results || [];
    return listings.map(function (l) {
        return {
            wantlistId:       wantlistId,
            listingId:        l.id,
            sellerUsername:   l.seller && l.seller.username,
            sellerRating:     l.seller && l.seller.stats && parseFloat(l.seller.stats.rating),
            sellerNumRatings: l.seller && l.seller.stats && l.seller.stats.total,
            priceOriginal:    l.price && l.price.value,
            currency:         l.price && l.price.currency,
            condition:        l.condition || '',
            shipsFrom:        l.ships_from || '',
            listingUrl:       l.uri || ('https://www.discogs.com/sell/item/' + l.id)
        };
    }).filter(function (l) { return l.sellerUsername; });
}

function parseDiscogsHtml(html, wantlistId) {
    var parser   = new DOMParser();
    var doc      = parser.parseFromString(html, 'text/html');
    var listings = [];

    // Discogs renders listings in <tr> rows inside the main table
    // Look for seller links, prices, conditions, and ships-from
    var rows = doc.querySelectorAll('tr.shortcut_navigable');
    if (!rows.length) {
        // Fallback: try to extract from embedded JSON (Next.js __NEXT_DATA__)
        var nextData = doc.getElementById('__NEXT_DATA__');
        if (nextData) {
            try {
                var json    = JSON.parse(nextData.textContent);
                var page    = json && json.props && json.props.pageProps;
                var results = (page && page.listings) || (page && page.data && page.data.listings) || [];
                results.forEach(function (l) {
                    listings.push({
                        wantlistId:       wantlistId,
                        listingId:        l.id,
                        sellerUsername:   l.seller && l.seller.username,
                        sellerRating:     l.seller && l.seller.stats && parseFloat(l.seller.stats.rating),
                        sellerNumRatings: l.seller && l.seller.stats && l.seller.stats.total,
                        priceOriginal:    l.price && l.price.value,
                        currency:         l.price && l.price.currency,
                        condition:        l.condition || '',
                        shipsFrom:        l.ships_from || '',
                        listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                    });
                });
            } catch (e) {}
        }
        return listings;
    }

    rows.forEach(function (row) {
        try {
            var sellerEl    = row.querySelector('a[href*="/seller/"]') || row.querySelector('.seller_info a');
            var priceEl     = row.querySelector('.price') || row.querySelector('[class*="price"]');
            var condEl      = row.querySelector('.condition-label-mobile') || row.querySelector('[class*="condition"]');
            var shipsEl     = row.querySelector('.ships_from') || row.querySelector('[class*="ships"]');
            var listingLink = row.querySelector('a[href*="/sell/item/"]');

            if (!sellerEl) return;

            var price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '')) : null;
            var listingId = null;
            if (listingLink) {
                var m = listingLink.href.match(/\/sell\/item\/(\d+)/);
                if (m) listingId = parseInt(m[1]);
            }

            listings.push({
                wantlistId:       wantlistId,
                listingId:        listingId,
                sellerUsername:   sellerEl.textContent.trim(),
                sellerRating:     null,
                sellerNumRatings: null,
                priceOriginal:    price,
                currency:         'USD',
                condition:        condEl ? condEl.textContent.trim() : '',
                shipsFrom:        shipsEl ? shipsEl.textContent.trim() : '',
                listingUrl:       listingLink ? listingLink.href : ''
            });
        } catch (e) {}
    });

    return listings;
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

function showStatus(msg, type) {
    statusEl.textContent   = msg;
    statusEl.className     = 'status ' + type;
    statusEl.style.display = 'block';
}
