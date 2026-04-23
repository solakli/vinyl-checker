/**
 * Store scraping functions and fuzzy matching utilities
 */

// ═══════════════════════════════════════════════════════════════
// FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════

function similarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    const editDistance = levenshtein(longer.toLowerCase(), shorter.toLowerCase());
    return (longer.length - editDistance) / longer.length;
}

function levenshtein(s1, s2) {
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) { costs[j] = j; }
            else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1))
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

function normalize(str) {
    // Replace non-word chars (hyphens, dashes, punctuation) with spaces instead
    // of deleting them. This prevents "Lawrence-Gravity Hill" collapsing into
    // "lawrencegravity hill" where "gravity" becomes a substring of "lawrence".
    return str.toLowerCase().replace(/^the\s+/i, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Catalog numbers are the strongest signal we have for matching a vinyl
// release. Discogs assigns one to nearly every entry (~99% of wantlist items),
// labels print them on the sleeve, and stores almost always store them as a
// dedicated SKU/catno field. The only friction is cosmetic formatting — the
// same release can show up as "MSNLP005", "MSN-LP-005", "MSN LP 005", or
// "msnlp 005" depending on the source. We strip everything except letters and
// digits and then compare case-insensitively, which folds all those forms
// together without false positives (different releases on the same label
// always have different alphanumeric tails).
function normalizeCatno(str) {
    if (str == null) return '';
    var s = String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
    // Placeholder strings that scrapers or Discogs sometimes return for missing
    // catalog numbers — treat them as absent so they never match each other.
    if (s === 'none' || s === 'na' || s === 'notavailable' || s === 'unknown' || s === 'promo') return '';
    return s;
}

function catnosMatch(a, b) {
    var na = normalizeCatno(a);
    var nb = normalizeCatno(b);
    // Require at least 3 characters on each side. Sub-3-char catnos
    // ("EP", "LP", "1") are too generic to be definitive on their own and
    // collide too easily across labels.
    if (na.length < 3 || nb.length < 3) return false;
    // Pure-numeric strings (e.g. "010", "001", "2310716") are sequential
    // release counters with no label prefix — far too collision-prone to be a
    // reliable identifier.  Require at least one letter on both sides so that
    // e.g. "∞010" (normalized "010") doesn't false-match wantlist catno "010".
    if (!/[a-z]/.test(na) || !/[a-z]/.test(nb)) return false;
    return na === nb;
}

/**
 * Decide whether a wantlist item matches a row from `store_inventory`.
 *
 * Order of operations (strongest signal first):
 *   1. Catno match — if both sides have a catalog number and they normalise
 *      to the same alphanumeric, accept. This is a definitive identifier and
 *      catches cases where the artist or title differs cosmetically (curly
 *      vs straight quotes, "&" vs "and", missing "EP" suffix, etc).
 *   2. Structured artist+title fuzzy match — when the inventory row has an
 *      artist field (Gramaphone, Further when structured), use the existing
 *      bigram fuzzy matcher.
 *   3. Combined-title fallback — when artist isn't available on the row
 *      (most WooCommerce stores including Octopus, free-form Further items),
 *      fall back to matching the wanted artist+title against the combined
 *      title text.
 *
 * Used by all catalog-mirror stores (Gramaphone, Further, Octopus) so they
 * benefit from the same matching semantics and any future improvements live
 * in one place.
 */
function matchInventoryRow(wanted, row) {
    // Catno is the strongest signal. If both sides have one:
    //   • They match  → definitive accept.
    //   • They differ → definitive reject (different releases on the same label
    //     always have different alphanumeric tails, so a mismatch is never a
    //     cosmetic issue). Skip fuzzy entirely so "Uncanny Valley 001" can't
    //     fuzzy-match "Uncanny Valley 50.2", "Audio Soul Project Community" can't
    //     fuzzy-match "Audio Soul Project Simurgh", etc.
    if (wanted && row && wanted.catno && row.catno) {
        return catnosMatch(wanted.catno, row.catno);
    }
    if (row.artist && row.title) {
        if (recordsMatch(wanted, { artist: row.artist, title: row.title })) {
            return true;
        }
    }
    var combined = row.title_raw || ((row.artist || '') + ' - ' + (row.title || '')).trim();
    return recordsMatchCombined(wanted, combined);
}

// True if `needle` appears in `haystack` aligned to word boundaries.
// Prevents "material" from matching inside "immaterial", while still allowing
// "since then" to match inside "since then. (25 years anniversary edition)".
function wordContains(haystack, needle) {
    if (!needle || needle.length < 4) return false;
    var idx = haystack.indexOf(needle);
    if (idx === -1) return false;
    var before = idx === 0 || haystack[idx - 1] === ' ';
    var after  = (idx + needle.length) >= haystack.length || haystack[idx + needle.length] === ' ';
    return before && after;
}

function recordsMatch(wanted, found, threshold) {
    threshold = threshold || 0.7;
    var wantedArtist = normalize(wanted.artist);
    var foundArtist = normalize(found.artist);
    var wantedTitle = normalize(wanted.title);
    var foundTitle = normalize(found.title);
    var artistSim = similarity(wantedArtist, foundArtist);
    var titleSim = similarity(wantedTitle, foundTitle);
    // If found title contains the wanted title at a word boundary (store appends
    // variant/format info like "(25 Years)" or "(12\")"), boost match.
    // Word-boundary check prevents "material" boosting inside "immaterial".
    // Guard: don't boost if found title is wanted title + bare trailing number —
    // "Hutson 1" vs "Hutson" are different releases, not format variants.
    if (wordContains(foundTitle, wantedTitle)) {
        var extra = foundTitle.slice(wantedTitle.length).trim();
        var wantedHasNums = /\d/.test(wantedTitle);
        if (wantedHasNums || !/^\d+$/.test(extra)) {
            titleSim = Math.max(titleSim, 0.85);
        }
    }
    // Also check if wanted title contains found title (truncated listing)
    if (wordContains(wantedTitle, foundTitle)) {
        titleSim = Math.max(titleSim, 0.85);
    }
    // "Various" / "Various Artists" gives zero artist discrimination — don't let
    // a perfect artist match lower the title threshold, and also require number
    // alignment so "Uncanny Valley 001" can't fuzzy-match "Uncanny Valley 50.4".
    var isVarious = /^various(\s+artists?)?$/.test(wantedArtist);
    if (isVarious) return titleSim >= threshold && numbersMatch(wantedTitle, foundTitle);
    if (artistSim >= 0.85) {
        if (titleSim < 0.65) return false;
        // Extra guard: if found title = wanted title + a bare volume number and
        // the wanted title has no numbers, they're almost certainly different releases
        // (e.g., "Hutson 1" ≠ "Hutson"). Reject to prevent false positives.
        var wantedTitleNums = wantedTitle.match(/\d+/g) || [];
        var foundTitleNums  = foundTitle.match(/\d+/g)  || [];
        if (wantedTitleNums.length === 0 && foundTitleNums.length > 0) {
            var tailAfterWanted = foundTitle.slice(wantedTitle.length).trim();
            if (/^\d+$/.test(tailAfterWanted)) return false;
        }
        return true;
    }
    return artistSim >= threshold && titleSim >= threshold;
}

function numbersMatch(a, b) {
    // Extract all number sequences from both strings
    var numsA = a.match(/\d+/g) || [];
    var numsB = b.match(/\d+/g) || [];
    if (numsA.length === 0 || numsB.length === 0) return true; // no numbers to compare
    // Check that at least one number from A appears in B
    for (var i = 0; i < numsA.length; i++) {
        for (var j = 0; j < numsB.length; j++) {
            if (numsA[i] === numsB[j]) return true;
        }
    }
    return false;
}

function recordsMatchCombined(wanted, combinedTitle) {
    var norm = normalize(combinedTitle);
    var wantedArtist = normalize(wanted.artist);
    var wantedTitle = normalize(wanted.title);
    // "Various" / "Various Artists" provides no artist signal — "Various - Uncanny
    // Valley 001" must not fuzzy-match "Various - Uncanny Valley 50.4" just because
    // they share a long common prefix. Require 85% title similarity for VA releases.
    var isVarious = /^various(\s+artists?)?$/.test(wantedArtist);
    var fuzzyTitleThreshold = isVarious ? 0.85 : 0.65;
    var fuzzyFullThreshold  = isVarious ? 0.90 : 0.75;
    // Check if artist + title appear together
    var artistSim = similarity(wantedArtist, norm.substring(0, wantedArtist.length + 5));
    if (norm.indexOf(wantedArtist) !== -1 || artistSim >= 0.7) {
        var remainder = norm.replace(wantedArtist, '').trim();
        var titleSim = similarity(wantedTitle, remainder);
        if (titleSim >= fuzzyTitleThreshold && numbersMatch(wantedTitle, remainder)) return true;
    }
    var fullWanted = normalize(wanted.artist + ' ' + wanted.title);
    if (similarity(fullWanted, norm) >= fuzzyFullThreshold && numbersMatch(fullWanted, norm)) return true;
    // Title-only containment: some stores omit the artist in their listing text.
    // When the wanted title (≥6 chars) appears verbatim in the combined string,
    // accept — but ONLY if the artist also appears, or the wantlist item has no
    // artist. This prevents "Gravity" in "Lawrence Gravity Hill" from matching
    // a wantlist entry for "BRS – Gravity" (completely different release).
    if (wantedTitle.length >= 6 && norm.indexOf(wantedTitle) !== -1) {
        if (!wantedArtist || wantedArtist.length < 2) return true; // no artist to validate
        if (norm.indexOf(wantedArtist) !== -1) return true;        // artist also present
        // Artist absent from combined text → coincidental title overlap, not a match
    }
    // Also check if the combined title starts with the wanted title (ignoring appended format info).
    // Apply the same artist-presence guard.
    if (wantedTitle.length >= 6 && similarity(wantedTitle, norm.substring(0, wantedTitle.length + 5)) >= 0.85 && numbersMatch(wantedTitle, norm)) {
        if (!wantedArtist || wantedArtist.length < 2) return true;
        if (norm.indexOf(wantedArtist) !== -1) return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════
// LINK-ONLY STORES (with known US shipping rates)
// ═══════════════════════════════════════════════════════════════

function getPhonicaLink(item) {
    return { store: 'Phonica', inStock: false, matches: [], searchUrl: 'https://www.phonicarecords.com/search/' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '\u00a36.50' };
}
function getYoyakuLink(item) {
    return { store: 'Yoyaku', inStock: false, matches: [], searchUrl: 'https://yoyaku.io/?s=' + encodeURIComponent(item.searchQuery) + '&post_type=product', linkOnly: true, usShipping: '\u20ac15.00' };
}
function getDecksLink(item) {
    return { store: 'Decks.de', inStock: false, matches: [], searchUrl: 'https://www.decks.de/decks/workfloor/search_db.php?such=' + encodeURIComponent(item.searchQuery) + '&wosuch=vi&wassuch=atl', linkOnly: true, usShipping: '\u20ac9.90' };
}
function getHardwaxLink(item) {
    return { store: 'Hardwax', inStock: false, matches: [], searchUrl: 'https://hardwax.com/?search=' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '\u20ac12.00' };
}
function getTurntableLabLink(item) {
    return { store: 'Turntable Lab', inStock: false, matches: [], searchUrl: 'https://www.turntablelab.com/search?type=product&q=' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '$5.99' };
}
function getUndergroundVinylLink(item) {
    return { store: 'Underground Vinyl', inStock: false, matches: [], searchUrl: 'https://undergroundvinylsource.com/search?q=' + encodeURIComponent(item.searchQuery) + '&type=product', linkOnly: true, usShipping: '$5.00' };
}

// ═══════════════════════════════════════════════════════════════
// SCRAPED STORE CHECKERS
// ═══════════════════════════════════════════════════════════════

// Deejay.de
//
// Their audio player can hang page.evaluate() indefinitely. We race against an
// 8-second timeout and, on timeout, navigate the page to about:blank (which
// kills the hanging JS), wait 1s, then retry the full search once before giving
// up. This recovers the 5-10% of items where the first attempt hangs.

function _deejayExtract(page) {
    // Returns a Promise that resolves to an array of products, or rejects with
    // Error('evaluate timeout') after 8 s. Caller decides what to do on timeout.
    return Promise.race([
        page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.product').forEach(function (el) {
                if (el.classList.contains('equip')) return;
                var artistEl = el.querySelector('h2.artist');
                var titleEl  = el.querySelector('h3.title');
                var kaufenEl = el.querySelector('.kaufen');
                var artist   = artistEl ? artistEl.textContent.trim() : '';
                var title    = titleEl  ? titleEl.textContent.trim()  : '';
                var priceText = kaufenEl ? kaufenEl.textContent : '';
                var priceMatch = priceText.match(/([\d,.]+)\s*\u20AC/);
                var price = priceMatch ? '\u20AC' + priceMatch[1] : '';
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('sold out') !== -1 ||
                                text.indexOf('ausverkauft') !== -1 ||
                                text.indexOf('out of stock') !== -1;
                if ((artist || title) && !isSoldOut) {
                    items.push({ artist: artist, title: title, price: price });
                }
            });
            return items;
        }),
        new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('evaluate timeout')); }, 8000);
        })
    ]);
}

async function checkDeejay(page, item) {
    var searchUrl = 'https://www.deejay.de/' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('.product h2.artist, .product h3.title', { timeout: 5000 }).catch(function () {});

        var products;
        try {
            products = await _deejayExtract(page);
        } catch (evalErr) {
            if (evalErr.message === 'evaluate timeout') {
                console.log('[Deejay] evaluate timeout for "' + item.searchQuery + '", resetting page and retrying once...');
                // Navigate away — kills the hanging audio-player JS
                await page.goto('about:blank', { timeout: 5000 }).catch(function () {});
                await new Promise(function (r) { setTimeout(r, 1000); });
                // Second attempt
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
                await page.waitForSelector('.product h2.artist, .product h3.title', { timeout: 5000 }).catch(function () {});
                products = await _deejayExtract(page).catch(function (e2) {
                    console.log('[Deejay] second timeout for "' + item.searchQuery + '", giving up: ' + e2.message);
                    return [];
                });
            } else {
                products = [];
            }
        }

        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        console.log('[Deejay] "' + item.searchQuery + '" \u2192 ' + products.length + ' products, ' + matches.length + ' matches');
        return { store: 'Deejay.de', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '\u20ac12.99' };
    } catch (e) {
        console.log('[Deejay] ERROR "' + item.searchQuery + '": ' + e.message);
        // Always reset the page on hard error so the next item gets a clean slate
        await page.goto('about:blank', { timeout: 5000 }).catch(function () {});
        return { store: 'Deejay.de', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '\u20ac12.99' };
    }
}

// HHV
function getSmartSearchQuery(item) {
    var artist = (item.artist || '').trim();
    var artistLower = artist.toLowerCase();
    // Generic/useless artist names that return too many results
    var genericArtists = ['unknown artist', 'various artists', 'various', 'va', 'unknown', 'n/a', 'no artist'];
    var isGeneric = genericArtists.indexOf(artistLower) !== -1 || artistLower === '';
    if (isGeneric) {
        // Prefer catno (e.g. "OMM 005"), fall back to label + title
        if (item.catno && item.catno.trim()) return item.catno.trim();
        if (item.label && item.label.trim()) return (item.label + ' ' + item.title).trim();
        return item.title;
    }
    return item.searchQuery;
}

async function checkHHV(page, item) {
    var smartQuery = getSmartSearchQuery(item);
    var searchUrl = 'https://www.hhv.de/katalog/filter/suche-S11?af=true&term=' + encodeURIComponent(smartQuery);
    try {
        // Small random delay to avoid workers hitting HHV simultaneously
        await new Promise(function (r) { setTimeout(r, Math.floor(Math.random() * 800)); });

        // HHV's React SPA needs to be the active tab to render properly
        await page.bringToFront();
        await page.goto(searchUrl, { waitUntil: 'load', timeout: 20000 });

        // Debug: check if we landed on the right page
        var pageUrl = page.url();
        var pageTitle = await page.title().catch(function() { return 'unknown'; });
        if (pageUrl.indexOf('katalog') === -1) {
            console.log('[HHV] WARNING: landed on wrong page: ' + pageUrl + ' title: ' + pageTitle);
        }

        // Wait for SPA product elements to appear
        await page.waitForSelector('.items--shared--gallery-entry--base-component span.artist', { timeout: 10000 }).catch(function () {});
        // Brief settle time after selector found
        await new Promise(function (r) { setTimeout(r, 800); });

        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.items--shared--gallery-entry--base-component:not(.overlay)').forEach(function (el) {
                var artistEl = el.querySelector('span.artist');
                var titleEl = el.querySelector('span.title');
                var priceEl = el.querySelector('span.price');
                var artist = artistEl ? artistEl.textContent.trim() : '';
                var title = titleEl ? titleEl.textContent.trim() : '';
                var price = priceEl ? priceEl.textContent.trim() : '';
                // Extract product page URL from the link wrapping the product
                var linkEl = el.querySelector('a[href*="/records/"], a[href*="/artikel/"]');
                if (!linkEl) linkEl = el.querySelector('a[href]');
                var url = linkEl ? linkEl.href : '';
                if (artist || title) items.push({ artist: artist, title: title, price: price, url: url });
            });
            return items;
        }).catch(function () { return []; });

        // Retry once if context was destroyed (SPA navigation)
        if (products.length === 0) {
            await new Promise(function (r) { setTimeout(r, 1500); });
            products = await page.evaluate(function () {
                var items = [];
                document.querySelectorAll('.items--shared--gallery-entry--base-component:not(.overlay)').forEach(function (el) {
                    var artistEl = el.querySelector('span.artist');
                    var titleEl = el.querySelector('span.title');
                    var priceEl = el.querySelector('span.price');
                    var artist = artistEl ? artistEl.textContent.trim() : '';
                    var title = titleEl ? titleEl.textContent.trim() : '';
                    var price = priceEl ? priceEl.textContent.trim() : '';
                    var linkEl = el.querySelector('a[href*="/records/"], a[href*="/artikel/"]');
                    if (!linkEl) linkEl = el.querySelector('a[href]');
                    var url = linkEl ? linkEl.href : '';
                    if (artist || title) items.push({ artist: artist, title: title, price: price, url: url });
                });
                return items;
            }).catch(function () { return []; });
        }

        // Debug: log what products HHV actually returned
        if (products.length > 0 && products.length <= 5) {
            console.log('[HHV] "' + smartQuery + '" products: ' + JSON.stringify(products.map(function(p) { return p.artist + ' - ' + p.title; })));
        }
        console.log('[HHV] "' + smartQuery + '" → ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        // Use direct product page URL if we have a match, otherwise fall back to search URL
        var resultUrl = (matches.length > 0 && matches[0].url) ? matches[0].url : searchUrl;
        return { store: 'HHV', inStock: matches.length > 0, matches: matches, searchUrl: resultUrl, usShipping: '€11.99' };
    } catch (e) {
        console.log('[HHV] ERROR "' + smartQuery + '": ' + e.message);
        return { store: 'HHV', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '€11.99' };
    }
}

// Hardwax
async function checkHardwax(page, item) {
    var searchUrl = 'https://hardwax.com/?search=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('article div[id^="record-"]', { timeout: 4000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('article').forEach(function (art) {
                var recordDiv = art.querySelector('div[id^="record-"]');
                if (!recordDiv) return;
                var text = art.textContent;
                var outOfStock = text.toLowerCase().indexOf('out of stock') !== -1;
                // Extract artist and title from product URL: /12345/artist-name/title-name/
                var artist = '', title = '';
                var links = art.querySelectorAll('a[href]');
                var productUrl = '';
                links.forEach(function (a) {
                    if (a.href && a.href.match(/hardwax\.com\/\d+\//)) productUrl = a.href;
                });
                if (productUrl) {
                    var urlMatch = productUrl.match(/\/\d+\/([^/]+)\/([^/#?]+)/);
                    if (urlMatch) {
                        artist = decodeURIComponent(urlMatch[1]).replace(/-/g, ' ');
                        title = decodeURIComponent(urlMatch[2]).replace(/-/g, ' ');
                    }
                }
                // Also try to get artist from "Artist:" pattern in text (more accurate)
                var cleanText = text.replace(/\s+/g, ' ');
                var colonMatch = cleanText.match(/(?:Label\s*Catalog\s*)([^:]+):\s*(.+?)(?:\s{2,}|$)/);
                if (colonMatch) {
                    artist = colonMatch[1].trim();
                    // Title from colon pattern may include description, prefer URL title
                }
                // Extract price (EUR, skip MP3/AIFF/digital)
                var price = '';
                links.forEach(function (a) {
                    if (price) return;
                    var t = a.textContent.trim();
                    if (t.indexOf('MP3') !== -1 || t.indexOf('AIFF') !== -1) return;
                    var pm = t.match(/€\s*([\d.]+)/);
                    if (pm) price = '€' + pm[1];
                });
                if ((artist || title) && !outOfStock) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });
        console.log('[Hardwax] "' + item.searchQuery + '" → ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'Hardwax', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '€12.00' };
    } catch (e) {
        console.log('[Hardwax] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Hardwax', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '€12.00' };
    }
}

// Juno
async function checkJuno(page, item) {
    var searchUrl = 'https://www.juno.co.uk/search/?q%5Ball%5D%5B%5D=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('.dv-item .vi-text', { timeout: 3000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.dv-item').forEach(function (el) {
                var viTexts = el.querySelectorAll('.vi-text');
                var artist = viTexts[0] ? viTexts[0].textContent.trim() : '';
                var title = viTexts[1] ? viTexts[1].textContent.trim() : '';
                // Strip format suffixes: (12"), (2xLP), (Deluxe Edition), etc.
                title = title.replace(/\s*\((?:12"|7"|10"|LP|2xLP|2LP|3xLP|CD|Vinyl|Reissue|Repress)[^)]*\)\s*$/i, '').trim();
                title = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
                var priceEl = el.querySelector('.pl-big-price');
                var price = '';
                if (priceEl) {
                    var priceText = priceEl.textContent.trim();
                    var m = priceText.match(/[\$\u00A3\u20AC][\d.]+/);
                    price = m ? m[0] : priceText.replace('in stock', '').trim();
                }
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('out of stock') !== -1 || text.indexOf('sold out') !== -1;
                if ((artist || title) && !isSoldOut) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });
        console.log('[Juno] "' + item.searchQuery + '" \u2192 ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'Juno', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '\u00a37.99' };
    } catch (e) {
        console.log('[Juno] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Juno', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '\u00a37.99' };
    }
}

// Turntable Lab
async function checkTurntableLab(page, item) {
    var searchUrl = 'https://www.turntablelab.com/search?type=product&q=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('.product-item, .product-item__product-title', { timeout: 3000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.product-item').forEach(function (el) {
                var titleEl = el.querySelector('.product-item__product-title, h3');
                var combined = titleEl ? titleEl.textContent.trim() : '';
                // Price: try sale price first, then regular price
                var salePriceEl = el.querySelector('.product-item__price--sale, .price--sale, [class*="sale"]');
                var regPriceEl = el.querySelector('.product-item__price-main span, .product-item__price, .price');
                var priceText = '';
                if (salePriceEl) priceText = salePriceEl.textContent.trim();
                else if (regPriceEl) priceText = regPriceEl.textContent.trim();
                priceText = priceText.replace(/\s+/g, ' ');
                // Extract all dollar amounts and pick the last one (sale price comes after regular)
                var allPrices = priceText.match(/\$[\d.]+/g);
                var price = allPrices ? allPrices[allPrices.length - 1] : '';
                var artist = '', title = '';
                if (combined.indexOf(':') !== -1) {
                    var parts = combined.split(':');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(':').trim();
                } else if (combined.indexOf(' - ') !== -1) {
                    var parts2 = combined.split(' - ');
                    artist = parts2[0].trim();
                    title = parts2.slice(1).join(' - ').trim();
                } else { title = combined; }
                title = title.replace(/\s*(Vinyl\s*(LP|12"|7"|10"|2xLP|2LP|3xLP)?)$/i, '').trim();
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('sold out') !== -1 || text.indexOf('out of stock') !== -1 ||
                                text.indexOf('get alert') !== -1 || text.indexOf('notify me') !== -1 ||
                                text.indexOf('coming soon') !== -1 || text.indexOf('pre-order') !== -1;
                // Also check for OOS badge/label elements
                var badgeEl = el.querySelector('.badge, .product-item__badge, [class*="sold-out"], [class*="out-of-stock"]');
                if (badgeEl) {
                    var badgeText = badgeEl.textContent.toLowerCase();
                    if (badgeText.indexOf('out') !== -1 || badgeText.indexOf('sold') !== -1 || badgeText.indexOf('alert') !== -1) isSoldOut = true;
                }
                if (combined && !isSoldOut) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });
        var matches = products.filter(function (p) {
            if (p.artist) return recordsMatch(item, p);
            return recordsMatchCombined(item, p.title);
        });
        console.log('[TTLab] "' + item.searchQuery + '" → ' + products.length + ' products, ' + matches.length + ' matches');
        return { store: 'Turntable Lab', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '$5.99' };
    } catch (e) {
        console.log('[TTLab] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Turntable Lab', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '$5.99' };
    }
}

// Underground Vinyl Source
async function checkUndergroundVinyl(page, item) {
    var searchUrl = 'https://undergroundvinylsource.com/search?q=' + encodeURIComponent(item.searchQuery) + '&type=product';
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('.product-card.product-grid, .product-card__name', { timeout: 3000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.product-card.product-grid').forEach(function (el) {
                var titleEl = el.querySelector('h6.product-card__name, .product-card__name');
                var priceEl = el.querySelector('.product-price');
                var combined = titleEl ? titleEl.textContent.trim() : '';
                var price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';
                var pm = price.match(/\$[\d.]+/);
                price = pm ? pm[0] : price.substring(0, 20);
                var artist = '', title = '';
                if (combined.indexOf(' - ') !== -1) {
                    var parts = combined.split(' - ');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(' - ').trim();
                } else { title = combined; }
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('sold out') !== -1 || text.indexOf('out of stock') !== -1;
                if (combined && !isSoldOut) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });
        var matches = products.filter(function (p) {
            if (p.artist) return recordsMatch(item, p);
            return recordsMatchCombined(item, p.title);
        });
        console.log('[UVS] "' + item.searchQuery + '" → ' + products.length + ' products, ' + matches.length + ' matches');
        return { store: 'Underground Vinyl', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '$5.00' };
    } catch (e) {
        console.log('[UVS] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Underground Vinyl', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '$5.00' };
    }
}

// Decks.de
async function checkDecks(page, item) {
    var searchUrl = 'https://www.decks.de/decks/workfloor/search_db.php?such=' + encodeURIComponent(item.searchQuery) + '&wosuch=vi&wassuch=atl';
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('[data-code]', { timeout: 3000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            var text = document.body ? document.body.innerText : '';
            // Decks.de renders products in blocks with data-code attributes
            var codeEls = document.querySelectorAll('[data-code]');
            if (codeEls.length > 0) {
                codeEls.forEach(function (el) {
                    var block = el.closest('div') || el.parentElement;
                    if (!block) return;
                    var blockText = block.innerText || '';
                    var lc = blockText.toLowerCase();
                    var outOfStock = lc.indexOf('out of stock') !== -1 || lc.indexOf('sold out') !== -1 || lc.indexOf('ausverkauft') !== -1 || lc.indexOf('nicht verfügbar') !== -1;
                    // Find all links in this block
                    var links = block.querySelectorAll('a');
                    var artist = '', title = '', price = '';
                    links.forEach(function (a) {
                        var href = a.href || '';
                        var linkText = a.textContent.trim();
                        // Artist links contain search params with artist name
                        if (href.indexOf('wassuch=atl') !== -1 && href.indexOf('where=1st') !== -1 && !artist) {
                            artist = linkText;
                        }
                        // Title links are typically uppercase product names linking to detail pages
                        if (href.indexOf('/track/') !== -1 && !title && linkText.length > 2) {
                            title = linkText;
                        }
                    });
                    // Price: look for "XX.XX EUR" pattern
                    var priceMatch = blockText.match(/([\d.]+)\s*EUR/);
                    if (priceMatch) price = '€' + priceMatch[1];
                    if ((artist || title) && !outOfStock) items.push({ artist: artist, title: title, price: price });
                });
            }
            // Fallback: parse text blocks if no data-code elements
            if (items.length === 0) {
                var allLinks = document.querySelectorAll('a');
                var currentArtist = '', currentTitle = '', currentPrice = '';
                allLinks.forEach(function (a) {
                    var href = a.href || '';
                    var linkText = a.textContent.trim();
                    if (href.indexOf('wassuch=atl') !== -1 && href.indexOf('where=1st') !== -1) {
                        currentArtist = linkText;
                    }
                    if (href.indexOf('/track/') !== -1 && linkText.length > 2) {
                        currentTitle = linkText;
                    }
                });
                // Check surrounding text for price/stock
                var bodyText = document.body.innerText;
                var priceMatches = bodyText.match(/([\d.]+)\s*EUR/g);
                var hasStock = bodyText.toLowerCase().indexOf('in stock') !== -1;
                if (currentArtist && hasStock && priceMatches) {
                    currentPrice = '€' + priceMatches[0].replace(' EUR', '');
                    items.push({ artist: currentArtist, title: currentTitle, price: currentPrice });
                }
            }
            return items;
        });
        console.log('[Decks] "' + item.searchQuery + '" → ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p) || recordsMatchCombined(item, p.artist + ' ' + p.title); }).length + ' matches');
        var matches = products.filter(function (p) {
            if (p.artist) return recordsMatch(item, p);
            return recordsMatchCombined(item, p.title);
        });
        return { store: 'Decks.de', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '€9.90' };
    } catch (e) {
        console.log('[Decks] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Decks.de', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '€9.90' };
    }
}

// Phonica — JSON API via HTTP (no browser page needed)
var https = require('https');
var phonicaCookie = ''; // cached Sucuri cookie

function phonicaFetch(url) {
    return new Promise(function (resolve, reject) {
        var opts = require('url').parse(url);
        opts.headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html',
            'Cookie': phonicaCookie
        };
        opts.timeout = 10000;
        var req = https.get(opts, function (res) {
            // Handle Sucuri redirect — extract cookie from set-cookie
            if (res.statusCode === 307 || res.statusCode === 302) {
                var setCookie = res.headers['set-cookie'];
                if (setCookie) {
                    phonicaCookie = setCookie.map(function (c) { return c.split(';')[0]; }).join('; ');
                    console.log('[Phonica] Got Sucuri cookie, retrying...');
                }
                // Retry with new cookie
                resolve(null);
                return;
            }
            var body = '';
            res.on('data', function (d) { body += d; });
            res.on('end', function () { resolve(body); });
        });
        req.on('error', function (e) { reject(e); });
        req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
    });
}

async function checkPhonica(page, item) {
    var searchUrl = 'https://www.phonicarecords.com/search/' + encodeURIComponent(item.searchQuery);
    var apiUrl = 'https://www.phonicarecords.com/api/product/json_category_search/' + encodeURIComponent(item.searchQuery) + '/0';
    try {
        var text = await phonicaFetch(apiUrl);
        // If first attempt failed (Sucuri redirect), retry with cookie (up to 2 retries)
        if (!text) {
            await new Promise(function(r) { setTimeout(r, 500); });
            text = await phonicaFetch(apiUrl);
        }
        if (!text) {
            await new Promise(function(r) { setTimeout(r, 1000); });
            text = await phonicaFetch(apiUrl);
        }
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data) {
            console.log('[Phonica] "' + item.searchQuery + '" → no data from API');
            return { store: 'Phonica', inStock: false, matches: [], searchUrl: searchUrl, usShipping: '£6.50' };
        }
        var products = [];
        var keys = Object.keys(data).filter(function (k) { return k !== 'pagination_links' && k !== 'href' && k !== 'archive_name'; });
        keys.forEach(function (k) {
            var p = data[k];
            if (p && p.artist) {
                var inStock = p.has_stock === '1' || parseInt(p.units) > 0;
                var outOfStock = p.has_stock === '0' && parseInt(p.units) === 0;
                if (!outOfStock) {
                    products.push({ artist: p.artist, title: p.album || '', price: p.price ? '£' + p.price : '', label: p.label || '' });
                }
            }
        });
        var matches = products.filter(function (p) {
            if (p.artist) return recordsMatch(item, p);
            return recordsMatchCombined(item, (p.artist + ' ' + p.title).trim());
        });
        console.log('[Phonica] "' + item.searchQuery + '" → ' + keys.length + ' products, ' + matches.length + ' matches');
        return { store: 'Phonica', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '£6.50' };
    } catch (e) {
        console.log('[Phonica] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Phonica', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '£6.50' };
    }
}

// Yoyaku — WooCommerce store at yoyaku.io
//
// Product titles on Yoyaku follow "Artist - Title" or "Artist – Title" (en-dash)
// format. We now split those properly so we can use the higher-precision
// recordsMatch() instead of the combined-title fallback for every item.
// WooCommerce hydrates after DOMContentLoaded, so we wait for the first product
// element rather than sleeping a fixed 2 s.
async function checkYoyaku(page, item) {
    var searchUrl = 'https://yoyaku.io/?s=' + encodeURIComponent(item.searchQuery) + '&post_type=product';
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        // Wait for products — fall back to a 1.5 s sleep if none appear (e.g. zero results page)
        await page.waitForSelector('li.product', { timeout: 5000 }).catch(function () {
            return new Promise(function (r) { setTimeout(r, 1500); });
        });

        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('li.product').forEach(function (el) {
                var text = el.textContent || '';
                var isOOS = text.toLowerCase().indexOf('out of stock') !== -1 ||
                            el.classList.contains('outofstock') ||
                            el.querySelector('.out-of-stock-badge, [class*="out-of-stock"]') !== null;

                var titleEl = el.querySelector('.wd-entities-title a, h2 a, .product-title a, .woocommerce-loop-product__title a');
                var combined = titleEl ? titleEl.textContent.trim() : '';

                var priceEl = el.querySelector('.price .amount, .price ins .amount, .price');
                var price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';

                if (!combined || isOOS) return;

                // Split "Artist – Title" (en-dash U+2013) or "Artist - Title" (hyphen)
                // Try en-dash first (more common in European record shop titles)
                var artist = '', title = combined;
                var enDashIdx = combined.indexOf(' \u2013 ');
                var hyphenIdx = combined.indexOf(' - ');
                if (enDashIdx !== -1) {
                    artist = combined.substring(0, enDashIdx).trim();
                    title  = combined.substring(enDashIdx + 3).trim();
                } else if (hyphenIdx !== -1) {
                    artist = combined.substring(0, hyphenIdx).trim();
                    title  = combined.substring(hyphenIdx + 3).trim();
                }

                // Keep combined so the fallback matcher can still use it
                items.push({ artist: artist, title: title, combined: combined, price: price });
            });
            return items;
        });

        var matches = products.filter(function (p) {
            // Use artist+title match when we successfully split, combined fallback otherwise
            if (p.artist) return recordsMatch(item, p);
            return recordsMatchCombined(item, p.combined);
        });

        console.log('[Yoyaku] "' + item.searchQuery + '" \u2192 ' + products.length + ' products, ' + matches.length + ' matches');
        return { store: 'Yoyaku', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '\u20ac15.00' };
    } catch (e) {
        console.log('[Yoyaku] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Yoyaku', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '\u20ac15.00' };
    }
}

// ═══════════════════════════════════════════════════════════════
// CHECK ITEM (all stores for one wantlist item)
// ═══════════════════════════════════════════════════════════════

// Locally-synced US stores (no Puppeteer page required, no per-item HTTP).
// Each does a fast SQLite lookup against its daily-synced catalog.
var gramaphoneStore = require('./stores/gramaphone');
var checkGramaphone = gramaphoneStore.checkGramaphone;
var uvsStore = require('./stores/uvs');
var checkUVS = uvsStore.checkUVS;
var furtherStore = require('./stores/further');
var checkFurther = furtherStore.checkFurther;
var octopusStore = require('./stores/octopus');
var checkOctopus = octopusStore.checkOctopus;

async function checkItem(workerPages, item) {
    // HTTP / local-DB stores fire immediately — they complete while the browser
    // stores are loading pages, so they add essentially zero wall-clock time.
    var phonicaPromise    = checkPhonica(null, item);
    var gramaphonePromise = checkGramaphone(null, item);
    var uvsPromise        = checkUVS(null, item);
    var furtherPromise    = checkFurther(null, item);
    var octopusPromise    = checkOctopus(null, item);

    // All 7 browser stores in ONE parallel batch.
    // Previously Decks (page 0) and Yoyaku (page 4) ran in a sequential Batch 2
    // after Batch 1 finished, adding ~7 s of dead wait per item.  With dedicated
    // pages[5] and pages[6] they now run alongside the others from the start,
    // cutting per-item wall-clock time by ~25 % (HHV still dominates at ~20 s).
    // STORES_PER_WORKER in scanner.js must be 7 for this to work.
    var browserResults = await Promise.all([
        checkDeejay(workerPages[0], item),       // page 0 — blocks stylesheets
        checkHHV(workerPages[1], item),           // page 1 — allows stylesheets (SPA)
        checkJuno(workerPages[2], item),          // page 2
        checkHardwax(workerPages[3], item),       // page 3
        checkTurntableLab(workerPages[4], item),  // page 4
        checkDecks(workerPages[5], item),         // page 5 (was sequential Batch 2)
        checkYoyaku(workerPages[6], item)         // page 6 (was sequential Batch 2)
    ]);

    return browserResults.concat([
        await phonicaPromise,
        await gramaphonePromise,
        await uvsPromise,
        await furtherPromise,
        await octopusPromise
    ]);
}

module.exports = {
    similarity,
    levenshtein,
    normalize,
    normalizeCatno,
    catnosMatch,
    matchInventoryRow,
    numbersMatch,
    recordsMatch,
    recordsMatchCombined,
    getSmartSearchQuery,
    getPhonicaLink,
    getYoyakuLink,
    getDecksLink,
    getHardwaxLink,
    getTurntableLabLink,
    getUndergroundVinylLink,
    checkDeejay,
    checkHHV,
    checkHardwax,
    checkJuno,
    checkTurntableLab,
    checkUndergroundVinyl, // kept for /api/test-stores and /api/validate (live Puppeteer test)
    checkUVS,              // catalog-mirror version used by checkItem
    checkDecks,
    checkPhonica,
    checkYoyaku,
    checkGramaphone,
    checkFurther,
    checkOctopus,
    checkItem
};
