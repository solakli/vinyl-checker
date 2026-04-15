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
    return str.toLowerCase().replace(/^the\s+/i, '').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function recordsMatch(wanted, found, threshold) {
    threshold = threshold || 0.7;
    var wantedArtist = normalize(wanted.artist);
    var foundArtist = normalize(found.artist);
    var wantedTitle = normalize(wanted.title);
    var foundTitle = normalize(found.title);
    var artistSim = similarity(wantedArtist, foundArtist);
    var titleSim = similarity(wantedTitle, foundTitle);
    // If found title contains the wanted title (store appends variant/format info), boost match
    if (foundTitle.indexOf(wantedTitle) !== -1 && wantedTitle.length >= 4) {
        titleSim = Math.max(titleSim, 0.85);
    }
    // Also check if wanted title contains found title (truncated listing)
    if (wantedTitle.indexOf(foundTitle) !== -1 && foundTitle.length >= 4) {
        titleSim = Math.max(titleSim, 0.85);
    }
    if (artistSim >= 0.85) return titleSim >= 0.65;
    return artistSim >= threshold && titleSim >= threshold;
}

function recordsMatchCombined(wanted, combinedTitle) {
    var norm = normalize(combinedTitle);
    var wantedArtist = normalize(wanted.artist);
    var wantedTitle = normalize(wanted.title);
    // Check if artist + title appear together
    var artistSim = similarity(wantedArtist, norm.substring(0, wantedArtist.length + 5));
    if (norm.indexOf(wantedArtist) !== -1 || artistSim >= 0.7) {
        var remainder = norm.replace(wantedArtist, '').trim();
        var titleSim = similarity(wantedTitle, remainder);
        if (titleSim >= 0.5) return true;
    }
    var fullWanted = normalize(wanted.artist + ' ' + wanted.title);
    if (similarity(fullWanted, norm) >= 0.75) return true;
    // Stores sometimes omit the artist name (e.g. TT Lab, UVS)
    // If the wanted title is contained in (or starts) the combined title, it's a match
    if (wantedTitle.length >= 4 && norm.indexOf(wantedTitle) !== -1) return true;
    // Also check if the combined title starts with the wanted title (ignoring appended format info)
    if (wantedTitle.length >= 4 && similarity(wantedTitle, norm.substring(0, wantedTitle.length + 5)) >= 0.8) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════
// LINK-ONLY STORES (with known US shipping rates)
// ═══════════════════════════════════════════════════════════════

function getPhonicaLink(item) {
    return { store: 'Phonica', inStock: false, matches: [], searchUrl: 'https://www.phonicarecords.com/search/' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '\u00a36.50' };
}
function getYoyakuLink(item) {
    return { store: 'Yoyaku', inStock: false, matches: [], searchUrl: 'https://yoyaku.co/search?q=' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '\u20ac15.00' };
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
async function checkDeejay(page, item) {
    var searchUrl = 'https://www.deejay.de/' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForSelector('.product h2.artist, .product h3.title', { timeout: 5000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.product').forEach(function (el) {
                if (el.classList.contains('equip')) return;
                var artistEl = el.querySelector('h2.artist');
                var titleEl = el.querySelector('h3.title');
                var kaufenEl = el.querySelector('.kaufen');
                var artist = artistEl ? artistEl.textContent.trim() : '';
                var title = titleEl ? titleEl.textContent.trim() : '';
                var priceText = kaufenEl ? kaufenEl.textContent : '';
                var priceMatch = priceText.match(/([\d,]+)\s*\u20AC/);
                var price = priceMatch ? priceMatch[0].trim() : '';
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('sold out') !== -1 || text.indexOf('ausverkauft') !== -1;
                if ((artist || title) && !isSoldOut) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });
        console.log('[Deejay] "' + item.searchQuery + '" \u2192 ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'Deejay.de', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '\u20ac12.99' };
    } catch (e) {
        console.log('[Deejay] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Deejay.de', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '\u20ac12.99' };
    }
}

// HHV
async function checkHHV(page, item) {
    var searchUrl = 'https://www.hhv.de/katalog/filter/suche-S11?af=true&term=' + encodeURIComponent(item.searchQuery);
    try {
        // Small random delay to avoid both workers hitting HHV at the exact same time
        await new Promise(function (r) { setTimeout(r, Math.floor(Math.random() * 2000)); });

        // HHV's React SPA needs to be the active tab to render properly
        await page.bringToFront();
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        // Wait for SPA product elements to appear
        await page.waitForSelector('.items--shared--gallery-entry--base-component span.artist', { timeout: 10000 }).catch(function () {});
        // Brief settle time after selector found
        await new Promise(function (r) { setTimeout(r, 1500); });

        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.items--shared--gallery-entry--base-component:not(.overlay)').forEach(function (el) {
                var artistEl = el.querySelector('span.artist');
                var titleEl = el.querySelector('span.title');
                var priceEl = el.querySelector('span.price');
                var artist = artistEl ? artistEl.textContent.trim() : '';
                var title = titleEl ? titleEl.textContent.trim() : '';
                var price = priceEl ? priceEl.textContent.trim() : '';
                if (artist || title) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        }).catch(function () { return []; });

        // Retry once if context was destroyed (SPA navigation)
        if (products.length === 0) {
            await new Promise(function (r) { setTimeout(r, 3000); });
            products = await page.evaluate(function () {
                var items = [];
                document.querySelectorAll('.items--shared--gallery-entry--base-component:not(.overlay)').forEach(function (el) {
                    var artistEl = el.querySelector('span.artist');
                    var titleEl = el.querySelector('span.title');
                    var priceEl = el.querySelector('span.price');
                    var artist = artistEl ? artistEl.textContent.trim() : '';
                    var title = titleEl ? titleEl.textContent.trim() : '';
                    var price = priceEl ? priceEl.textContent.trim() : '';
                    if (artist || title) items.push({ artist: artist, title: title, price: price });
                });
                return items;
            }).catch(function () { return []; });
        }

        console.log('[HHV] "' + item.searchQuery + '" → ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'HHV', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '€11.99' };
    } catch (e) {
        console.log('[HHV] ERROR "' + item.searchQuery + '": ' + e.message);
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
                var isSoldOut = text.indexOf('sold out') !== -1;
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
                var isSoldOut = text.indexOf('sold out') !== -1;
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
        // Wait for content to load
        await new Promise(function (r) { setTimeout(r, 1500); });
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
                    var outOfStock = blockText.toLowerCase().indexOf('out of stock') !== -1;
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

// ═══════════════════════════════════════════════════════════════
// CHECK ITEM (all stores for one wantlist item)
// ═══════════════════════════════════════════════════════════════

async function checkItem(workerPages, item) {
    // Batch 1: Deejay.de, HHV, Juno in parallel
    // HHV uses bringToFront() internally to ensure its React SPA renders
    var results = await Promise.all([
        checkDeejay(workerPages[0], item),
        checkHHV(workerPages[1], item),
        checkJuno(workerPages[2], item)
    ]);
    // Batch 2: Hardwax, Turntable Lab, UVS (reuse same 3 pages)
    var batch2 = await Promise.all([
        checkHardwax(workerPages[0], item),
        checkTurntableLab(workerPages[1], item),
        checkUndergroundVinyl(workerPages[2], item)
    ]);
    results = results.concat(batch2);
    // Link-only stores (can't scrape: frameset/AJAX/anti-bot)
    results.push(getDecksLink(item));
    results.push(getPhonicaLink(item));
    results.push(getYoyakuLink(item));
    return results;
}

module.exports = {
    similarity,
    levenshtein,
    normalize,
    recordsMatch,
    recordsMatchCombined,
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
    checkUndergroundVinyl,
    checkDecks,
    checkItem
};
