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

    // Step 2: fetch release marketplace pages in parallel batches
    var allListings  = [];
    var pendingBatch = [];   // accumulated since last flush
    var FETCH_SIZE   = 4;   // concurrent Discogs requests per round
    var POST_EVERY   = 40;  // flush to server every N releases processed
    var done         = 0;

    async function flushToServer(isLast) {
        if (!pendingBatch.length) return;
        var toSend = pendingBatch.slice();
        pendingBatch = [];
        var attempt = isLast ? 'Saving' : 'Flushing batch';
        console.log('[WaxDigger sync-window] ' + attempt + ': ' + toSend.length + ' listings');
        try {
            var r = await fetch(server + '/api/discogs-listings/' + encodeURIComponent(username), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listings: toSend })
            });
            if (!r.ok) {
                var errData = await r.json().catch(function() { return {}; });
                throw new Error(errData.error || ('HTTP ' + r.status));
            }
        } catch (e) {
            // On error: re-queue for retry on next flush rather than losing data
            pendingBatch = toSend.concat(pendingBatch);
            console.error('[WaxDigger sync-window] Flush failed (will retry):', e.message);
        }
    }

    for (var i = 0; i < items.length; i += FETCH_SIZE) {
        var batch = items.slice(i, i + FETCH_SIZE);

        // Fire all in batch simultaneously
        var batchResults = await Promise.all(batch.map(function (item) {
            return fetchMarketplacePage(item.item.id, item.wantlistId);
        }));

        batchResults.forEach(function (sellers) {
            allListings  = allListings.concat(sellers);
            pendingBatch = pendingBatch.concat(sellers);
        });
        done += batch.length;

        var pct = Math.round((done / items.length) * 100);
        fill.style.width  = pct + '%';
        label.textContent = done + ' / ' + items.length + ' releases · ' + allListings.length + ' listings found';

        // Save progress so popup + site can read it
        chrome.storage.local.set({ syncState: {
            running: true, startedAt: syncStartedAt, done: done, total: items.length, found: allListings.length
        }});

        // Flush every POST_EVERY releases so the server receives progressive updates
        // and we don't lose everything if the window closes early
        var isLast = (i + FETCH_SIZE >= items.length);
        if (pendingBatch.length >= POST_EVERY || isLast) {
            label.textContent = done + ' / ' + items.length + ' · saving batch...';
            await flushToServer(isLast);
            label.textContent = done + ' / ' + items.length + ' releases · ' + allListings.length + ' listings found';
        }

        // Brief pause between fetch batches
        if (!isLast) await sleep(120);
    }

    // Final flush (anything left that didn't make a full batch)
    if (pendingBatch.length) {
        label.textContent = 'Saving final batch...';
        await flushToServer(true);
    }

    // Done
    fill.style.width = '100%';
    label.textContent = items.length + ' releases · ' + allListings.length + ' listings synced';
    showStatus('✓ Done! You can now close this window and run the optimizer.', 'ok');
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

// Extract clean grade label from a messy condition string
function extractGrade(raw) {
    if (!raw) return '';
    var s = raw.replace(/\s+/g, ' ');
    // Try to find full canonical form first
    var canonical = s.match(/(Mint \(M\)|Near Mint \(NM or M-\)|Very Good Plus \(VG\+\)|Very Good \(VG\)|Good Plus \(G\+\)|Good \(G\)|Fair \(F\)|Poor \(P\))/);
    if (canonical) return canonical[1];
    // Shorter fallbacks
    if (/Near Mint|NM or M-/i.test(s)) return 'Near Mint (NM or M-)';
    if (/Very Good Plus|VG\+/i.test(s)) return 'Very Good Plus (VG+)';
    if (/Very Good/i.test(s)) return 'Very Good (VG)';
    if (/Mint/i.test(s)) return 'Mint (M)';
    if (/Good Plus|G\+/i.test(s)) return 'Good Plus (G+)';
    if (/Good/i.test(s)) return 'Good (G)';
    return raw.substring(0, 40);
}

// Dig through __NEXT_DATA__ trying multiple possible listing paths
function extractListingsFromJson(json) {
    var page = json && json.props && json.props.pageProps;
    if (!page) return [];
    // Try known paths in order
    var candidates = [
        page.listings,
        page.data && page.data.listings,
        page.initialState && page.initialState.marketplace && page.initialState.marketplace.listings,
        page.marketplace && page.marketplace.listings,
        page.results,
        page.data && page.data.results
    ];
    for (var i = 0; i < candidates.length; i++) {
        if (Array.isArray(candidates[i]) && candidates[i].length > 0) return candidates[i];
    }
    return [];
}

function parseHtml(html, wantlistId) {
    var listings = [];

    // ── Step 1: Build listing-id → ships_from map from raw HTML ─────────────────
    // Current Discogs Next.js build omits ships_from from __NEXT_DATA__ JSON, but
    // the rendered HTML rows always contain "Ships From: <Country>" text.
    // Build this map first so it can enrich JSON-parsed listings as a fallback.
    var htmlCountryMap = {};
    var rowRe = /<tr[^>]*class="[^"]*shortcut_navigable[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    var rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null) {
        try {
            var cell   = rowMatch[1];
            var listId = (cell.match(/\/sell\/item\/(\d+)/) || [])[1];
            if (!listId) continue;
            var fromM  = cell.match(/Ships\s*From\s*:<\/span>\s*([A-Za-z][A-Za-z ,\-]{1,40}?)(?:\s*<)/i)
                      || cell.match(/data-country="([^"]+)"/i)
                      || cell.match(/Ships\s+From[^<]*<[^>]+>\s*([A-Za-z][A-Za-z ]{1,30}?)\s*</i);
            if (fromM) htmlCountryMap[listId] = fromM[1].trim();
        } catch (e) {}
    }
    console.log('[WaxDigger sync-window] HTML country map entries:', Object.keys(htmlCountryMap).length);

    // ── Step 2: Try __NEXT_DATA__ JSON for structured listing data ───────────────
    var match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
        try {
            var json    = JSON.parse(match[1]);
            var results = extractListingsFromJson(json);
            results.forEach(function (l) {
                if (!l.seller || !l.seller.username) return;
                var stats = l.seller.stats || l.seller.seller_stats || {};
                // Discogs rate stored as "99.9" (%) or 0.999 (fraction) — normalise to %
                var rating = parseFloat(stats.rating || stats.average || 0);
                if (rating > 0 && rating <= 1) rating = rating * 100; // fraction → percent

                // ships_from: try all known JSON field variants, then fall back to HTML map
                var shipsFrom = l.ships_from
                             || l.location
                             || l.shipsFrom
                             || l.country
                             || l.country_code
                             || l.countryCode
                             || (l.seller && (
                                    l.seller.location
                                 || l.seller.ships_from
                                 || l.seller.shipsFrom
                                 || l.seller.country
                                 || l.seller.countryCode
                                ))
                             || (l.shipping && (l.shipping.ships_from || l.shipping.location || l.shipping.country))
                             // Last resort: HTML map by listing id
                             || (l.id && htmlCountryMap[String(l.id)])
                             || '';

                // shipping price
                var shipPrice = null;
                var shipCur   = (l.price && l.price.currency) || 'USD';
                var sp = l.shipping_price || l.shippingPrice || l.original_shipping_price;
                if (sp && typeof sp === 'object' && sp.value != null) {
                    shipPrice = sp.value;
                    shipCur   = sp.currency || shipCur;
                } else if (typeof sp === 'number') {
                    shipPrice = sp;
                } else if (typeof l.shipping === 'number') {
                    shipPrice = l.shipping;
                }

                listings.push({
                    wantlistId:       wantlistId,
                    listingId:        l.id,
                    sellerUsername:   l.seller.username,
                    sellerRating:     rating || null,
                    sellerNumRatings: stats.total || stats.count || null,
                    priceOriginal:    l.price && l.price.value,
                    currency:         (l.price && l.price.currency) || 'USD',
                    condition:        extractGrade(l.condition || l.sleeve_condition || ''),
                    shipsFrom:        shipsFrom,
                    shippingPrice:    shipPrice,
                    shippingCurrency: shipCur,
                    listingUrl:       'https://www.discogs.com/sell/item/' + l.id
                });
            });
            if (listings.length) {
                var withCountry = listings.filter(function(l) { return !!l.shipsFrom; }).length;
                console.log('[WaxDigger sync-window] __NEXT_DATA__: ' + listings.length + ' listings, ' + withCountry + ' with ships_from');
                return listings;
            }
        } catch (e) {
            console.error('[WaxDigger sync-window] __NEXT_DATA__ parse error:', e.message);
        }
    }

    // ── Step 3: Full DOMParser fallback (legacy Discogs layout) ─────────────────
    var parser = new DOMParser();
    var doc    = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('tr.shortcut_navigable').forEach(function (row) {
        try {
            var sellerLink  = row.querySelector('a[href*="/seller/"]');
            var priceEl     = row.querySelector('.price') || row.querySelector('[class*="price"]');
            var condEl      = row.querySelector('[class*="condition"]');
            var listingLink = row.querySelector('a[href*="/sell/item/"]');
            if (!sellerLink) return;

            var listId = null;
            if (listingLink) {
                var m = listingLink.href.match(/\/sell\/item\/(\d+)/);
                if (m) listId = parseInt(m[1]);
            }

            // Seller rating
            var sellerCell = sellerLink.closest('td') || row;
            var sellerCellText = sellerCell.textContent || '';
            var ratingMatch    = sellerCellText.match(/(\d{2,3}\.?\d*)\s*%/);
            var sellerRating   = ratingMatch ? parseFloat(ratingMatch[1]) : null;
            var numRatMatch    = sellerCellText.match(/\(?\s*(\d{1,6})\s*ratings?\)?/i);
            var sellerNumRatings = numRatMatch ? parseInt(numRatMatch[1]) : null;

            // ships_from: search innerHTML for "Ships From:" text, fall back to HTML map
            var shipsFromText = '';
            var rowHtml = row.innerHTML;
            var sfM = rowHtml.match(/Ships\s*From\s*[^<]*<[^>]*>\s*([A-Za-z][A-Za-z ,\-]{1,40}?)(?:\s*<)/i)
                   || rowHtml.match(/Ships\s*From\s*:<\/span>\s*([A-Za-z][A-Za-z ,\-]{1,40}?)(?:\s*<)/i)
                   || rowHtml.match(/data-country="([^"]+)"/i);
            if (sfM) {
                shipsFromText = sfM[1].trim();
            } else if (listId && htmlCountryMap[String(listId)]) {
                shipsFromText = htmlCountryMap[String(listId)];
            } else {
                // Plain text search for "Ships From:"
                var rowText = row.textContent || '';
                var sfTextM = rowText.match(/Ships\s+From[:\s]+([A-Za-z][A-Za-z ,\-]{1,30}?)(?:\s{2,}|$)/i);
                if (sfTextM) shipsFromText = sfTextM[1].trim();
            }

            listings.push({
                wantlistId:       wantlistId,
                listingId:        listId,
                sellerUsername:   sellerLink.textContent.trim(),
                sellerRating:     sellerRating,
                sellerNumRatings: sellerNumRatings,
                priceOriginal:    priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '')) : null,
                currency:         'USD',
                condition:        extractGrade(condEl ? condEl.textContent : ''),
                shipsFrom:        shipsFromText,
                shippingPrice:    null,
                shippingCurrency: 'USD',
                listingUrl:       listingLink ? listingLink.href : ''
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
