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
    var artistSim = similarity(normalize(wanted.artist), normalize(found.artist));
    var titleSim = similarity(normalize(wanted.title), normalize(found.title));
    if (artistSim >= 0.85) return titleSim >= 0.65;
    return artistSim >= threshold && titleSim >= threshold;
}

function recordsMatchCombined(wanted, combinedTitle) {
    var norm = normalize(combinedTitle);
    var wantedArtist = normalize(wanted.artist);
    var wantedTitle = normalize(wanted.title);
    var artistSim = similarity(wantedArtist, norm.substring(0, wantedArtist.length + 5));
    if (norm.indexOf(wantedArtist) !== -1 || artistSim >= 0.7) {
        var remainder = norm.replace(wantedArtist, '').trim();
        var titleSim = similarity(wantedTitle, remainder);
        if (titleSim >= 0.5) return true;
    }
    var fullWanted = normalize(wanted.artist + ' ' + wanted.title);
    return similarity(fullWanted, norm) >= 0.75;
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
        // HHV is an SPA -- navigate to about:blank first to ensure clean state
        await page.goto('about:blank', { waitUntil: 'load', timeout: 3000 }).catch(function () {});
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        // Wait for SPA to render products
        await page.waitForSelector('.items--shared--gallery-entry--base-component span.artist', { timeout: 8000 }).catch(function () {});
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
        });
        console.log('[HHV] "' + item.searchQuery + '" \u2192 ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'HHV', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '\u20ac11.99' };
    } catch (e) {
        console.log('[HHV] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'HHV', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '\u20ac11.99' };
    }
}

// Hardwax
async function checkHardwax(page, item) {
    var searchUrl = 'https://hardwax.com/?search=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await page.waitForSelector('article a[href*="/act/"]', { timeout: 3000 }).catch(function () {});
        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('article').forEach(function (art) {
                var actLink = art.querySelector('a[href*="/act/"]');
                if (!actLink) return;
                var artist = actLink.textContent.replace(/:$/, '').trim();
                var title = '';
                var recordLinks = [];
                art.querySelectorAll('a').forEach(function (a) { if (a.href.match(/hardwax\.com\/\d+\//)) recordLinks.push(a); });
                if (recordLinks.length > 0) {
                    var m = recordLinks[0].href.match(/\/\d+\/[^/]+\/([^/?]+)/);
                    if (m) title = m[1].replace(/-/g, ' ');
                }
                var text = art.textContent;
                var outOfStock = text.indexOf('out of stock') !== -1;
                var price = '';
                art.querySelectorAll('a[href*="#add/"]').forEach(function (pl) {
                    var t = pl.textContent;
                    if (t.indexOf('\u20AC') !== -1 && t.indexOf('MP3') === -1 && t.indexOf('AIFF') === -1) {
                        var pm = t.match(/\u20AC\s*([\d.]+)/);
                        if (pm) price = '\u20AC' + pm[1];
                    }
                });
                if (!price) {
                    art.querySelectorAll('a[href*="#add/"]').forEach(function (pl) {
                        var pm = pl.textContent.match(/\u20AC\s*([\d.]+)/);
                        if (pm && !price) price = '\u20AC' + pm[1];
                    });
                }
                if ((artist || title) && !outOfStock) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'Hardwax', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl };
    } catch (e) {
        return { store: 'Hardwax', inStock: false, error: e.message, searchUrl: searchUrl };
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
                var priceEl = el.querySelector('.product-item__price-main span, .product-item__price');
                var combined = titleEl ? titleEl.textContent.trim() : '';
                var price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';
                var pm = price.match(/\$[\d.]+/);
                price = pm ? pm[0] : price.substring(0, 20);
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
        return { store: 'Turntable Lab', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl };
    } catch (e) {
        return { store: 'Turntable Lab', inStock: false, error: e.message, searchUrl: searchUrl };
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
        return { store: 'Underground Vinyl', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl };
    } catch (e) {
        return { store: 'Underground Vinyl', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// ═══════════════════════════════════════════════════════════════
// CHECK ITEM (all stores for one wantlist item)
// ═══════════════════════════════════════════════════════════════

async function checkItem(workerPages, item) {
    // Scrape 3 stores in parallel
    var results = await Promise.all([
        checkDeejay(workerPages[0], item),
        checkHHV(workerPages[1], item),
        checkJuno(workerPages[2], item)
    ]);
    // Add 6 link-only stores (instant, no scraping)
    results.push(getHardwaxLink(item));
    results.push(getTurntableLabLink(item));
    results.push(getUndergroundVinylLink(item));
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
    checkItem
};
