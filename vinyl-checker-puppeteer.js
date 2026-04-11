#!/usr/bin/env node

/**
 * Vinyl Wantlist Checker with Puppeteer
 *
 * Checks: HHV, Deejay.de, Hardwax, Juno, Decks.de, Turntable Lab,
 *         Underground Vinyl Source, Phonica (link), Yoyaku (link)
 *
 * Install: npm install puppeteer
 * Run: node vinyl-checker-puppeteer.js <discogs-username>
 */

const puppeteer = require('puppeteer');
const https = require('https');

// Fuzzy matching
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
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

function normalize(str) {
    return str
        .toLowerCase()
        .replace(/^the\s+/i, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function recordsMatch(wanted, found, threshold) {
    threshold = threshold || 0.7;
    const artistSim = similarity(normalize(wanted.artist), normalize(found.artist));
    const titleSim = similarity(normalize(wanted.title), normalize(found.title));

    // Lower threshold for title if artist matches well
    if (artistSim >= 0.85) {
        return titleSim >= 0.65;
    }

    return artistSim >= threshold && titleSim >= threshold;
}

// For stores where artist+title are combined in one string (e.g. "Ryo Fukui: Scenery")
function recordsMatchCombined(wanted, combinedTitle) {
    var norm = normalize(combinedTitle);
    var wantedArtist = normalize(wanted.artist);
    var wantedTitle = normalize(wanted.title);

    // Check if combined string contains both artist and title
    var artistSim = similarity(wantedArtist, norm.substring(0, wantedArtist.length + 5));
    if (norm.indexOf(wantedArtist) !== -1 || artistSim >= 0.7) {
        // Artist found — check title in remainder
        var remainder = norm.replace(wantedArtist, '').trim();
        var titleSim = similarity(wantedTitle, remainder);
        if (titleSim >= 0.5) return true;
    }

    // Fallback: check similarity against full combined string
    var fullWanted = normalize(wanted.artist + ' ' + wanted.title);
    return similarity(fullWanted, norm) >= 0.75;
}

// Helper to safely access nested properties
function getArtistName(w) {
    var artists = w.basic_information && w.basic_information.artists;
    return (artists && artists[0] && artists[0].name) || 'Unknown';
}

function getLabelName(w) {
    var labels = w.basic_information && w.basic_information.labels;
    return (labels && labels[0] && labels[0].name) || '';
}

function getCatno(w) {
    var labels = w.basic_information && w.basic_information.labels;
    return (labels && labels[0] && labels[0].catno) || '';
}

// Fetch Discogs wantlist
async function fetchWantlist(username) {
    return new Promise(function (resolve, reject) {
        var fetchPage = function (page, allWants) {
            allWants = allWants || [];
            https.get({
                hostname: 'api.discogs.com',
                path: '/users/' + username + '/wants?per_page=100&page=' + page,
                headers: { 'User-Agent': 'VinylWantlistChecker/1.0' }
            }, function (res) {
                if (res.statusCode === 404) {
                    return reject(new Error('Username "' + username + '" not found on Discogs'));
                }
                if (res.statusCode === 429) {
                    return reject(new Error('Discogs API rate limit reached. Try again later.'));
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error('Discogs API error: HTTP ' + res.statusCode));
                }

                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    var json;
                    try {
                        json = JSON.parse(data);
                    } catch (e) {
                        return reject(new Error('Failed to parse Discogs API response'));
                    }

                    if (!json.wants || json.wants.length === 0) {
                        return resolve(allWants);
                    }

                    var wants = json.wants.map(function (w) {
                        var artist = getArtistName(w);
                        return {
                            id: w.id,
                            artist: artist,
                            title: w.basic_information.title,
                            year: w.basic_information.year,
                            label: getLabelName(w),
                            catno: getCatno(w),
                            searchQuery: (artist + ' ' + w.basic_information.title).trim()
                        };
                    });

                    allWants = allWants.concat(wants);

                    if (page < json.pagination.pages) {
                        setTimeout(function () { fetchPage(page + 1, allWants); }, 500);
                    } else {
                        resolve(allWants);
                    }
                });
            }).on('error', reject);
        };

        fetchPage(1);
    });
}

// ═══════════════════════════════════════════════════════════════
// LINK-ONLY STORES (no scraping, just generate search URLs)
// ═══════════════════════════════════════════════════════════════

function getPhonicaLink(item) {
    return {
        store: 'Phonica',
        inStock: false,
        matches: [],
        searchUrl: 'https://www.phonicarecords.com/search/' + encodeURIComponent(item.searchQuery),
        linkOnly: true
    };
}

function getYoyakuLink(item) {
    return {
        store: 'Yoyaku',
        inStock: false,
        matches: [],
        searchUrl: 'https://yoyaku.co/search?q=' + encodeURIComponent(item.searchQuery),
        linkOnly: true
    };
}

// ═══════════════════════════════════════════════════════════════
// SCRAPED STORES
// ═══════════════════════════════════════════════════════════════

// Check Deejay.de
async function checkDeejay(page, item) {
    var searchUrl = 'https://www.deejay.de/' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return {
            store: 'Deejay.de',
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl
        };
    } catch (e) {
        return { store: 'Deejay.de', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// Check HHV
async function checkHHV(page, item) {
    var searchUrl = 'https://www.hhv.de/katalog/filter/suche-S11?af=true&term=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return {
            store: 'HHV',
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl
        };
    } catch (e) {
        return { store: 'HHV', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// Check Hardwax
async function checkHardwax(page, item) {
    var searchUrl = 'https://hardwax.com/?search=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('article a[href*="/act/"]', { timeout: 5000 }).catch(function () {});

        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('article').forEach(function (art) {
                // Artist from /act/ link
                var actLink = art.querySelector('a[href*="/act/"]');
                if (!actLink) return;
                var artist = actLink.textContent.replace(/:$/, '').trim();

                // Title from product URL pattern: /number/artist-slug/title-slug/
                var title = '';
                var recordLinks = [];
                art.querySelectorAll('a').forEach(function (a) {
                    if (a.href.match(/hardwax\.com\/\d+\//)) recordLinks.push(a);
                });
                if (recordLinks.length > 0) {
                    var m = recordLinks[0].href.match(/\/\d+\/[^/]+\/([^/?]+)/);
                    if (m) title = m[1].replace(/-/g, ' ');
                }

                // Stock check
                var text = art.textContent;
                var outOfStock = text.indexOf('out of stock') !== -1;

                // Price: prefer vinyl price (not MP3/AIFF)
                var price = '';
                art.querySelectorAll('a[href*="#add/"]').forEach(function (pl) {
                    var t = pl.textContent;
                    if (t.indexOf('€') !== -1 && t.indexOf('MP3') === -1 && t.indexOf('AIFF') === -1) {
                        var pm = t.match(/€\s*([\d.]+)/);
                        if (pm) price = '€' + pm[1];
                    }
                });
                // Fallback: any price
                if (!price) {
                    art.querySelectorAll('a[href*="#add/"]').forEach(function (pl) {
                        var pm = pl.textContent.match(/€\s*([\d.]+)/);
                        if (pm && !price) price = '€' + pm[1];
                    });
                }

                if ((artist || title) && !outOfStock) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });

        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return {
            store: 'Hardwax',
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl
        };
    } catch (e) {
        return { store: 'Hardwax', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// Check Juno
async function checkJuno(page, item) {
    var searchUrl = 'https://www.juno.co.uk/search/?q%5Ball%5D%5B%5D=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.dv-item .vi-text', { timeout: 8000 }).catch(function () {});

        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.dv-item').forEach(function (el) {
                // vi-text elements: 0=artist, 1=title, rest=label/cat/genre
                var viTexts = el.querySelectorAll('.vi-text');
                var artist = viTexts[0] ? viTexts[0].textContent.trim() : '';
                var title = viTexts[1] ? viTexts[1].textContent.trim() : '';
                // Clean title: remove format info like (12"), (LP)
                title = title.replace(/\s*\([^)]*\)\s*$/, '').trim();

                var priceEl = el.querySelector('.pl-big-price');
                var price = '';
                if (priceEl) {
                    var priceText = priceEl.textContent.trim();
                    var m = priceText.match(/[\$£€][\d.]+/);
                    price = m ? m[0] : priceText.replace('in stock', '').trim();
                }

                // Check if in stock
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('out of stock') !== -1 || text.indexOf('sold out') !== -1;

                if ((artist || title) && !isSoldOut) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });

        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return {
            store: 'Juno',
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl
        };
    } catch (e) {
        return { store: 'Juno', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// Decks.de - link only (search results don't render in headless mode)
function getDecksLink(item) {
    return {
        store: 'Decks.de',
        inStock: false,
        matches: [],
        searchUrl: 'https://www.decks.de/decks/workfloor/search_db.php?such=' + encodeURIComponent(item.searchQuery) + '&wosuch=vi&wassuch=atl',
        linkOnly: true
    };
}

// Check Turntable Lab
async function checkTurntableLab(page, item) {
    var searchUrl = 'https://www.turntablelab.com/search?type=product&q=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.product-item, .product-item__product-title', { timeout: 8000 }).catch(function () {});

        var products = await page.evaluate(function () {
            var items = [];
            document.querySelectorAll('.product-item').forEach(function (el) {
                var titleEl = el.querySelector('.product-item__product-title, h3');
                var priceEl = el.querySelector('.product-item__price-main span, .product-item__price');
                var combined = titleEl ? titleEl.textContent.trim() : '';
                var price = priceEl ? priceEl.textContent.trim() : '';

                // Turntable Lab combines "Artist: Title Format" or "Artist - Title"
                var artist = '';
                var title = '';
                if (combined.indexOf(':') !== -1) {
                    var parts = combined.split(':');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(':').trim();
                } else if (combined.indexOf(' - ') !== -1) {
                    var parts2 = combined.split(' - ');
                    artist = parts2[0].trim();
                    title = parts2.slice(1).join(' - ').trim();
                } else {
                    title = combined;
                }
                // Remove format suffixes like "Vinyl LP", "Vinyl 12"", "CD"
                title = title.replace(/\s*(Vinyl\s*(LP|12"|7"|10"|2xLP|2LP|3xLP)?)$/i, '').trim();

                // Check sold out
                var text = el.textContent.toLowerCase();
                var isSoldOut = text.indexOf('sold out') !== -1;

                if (combined && !isSoldOut) items.push({ artist: artist, title: title, price: price });
            });
            return items;
        });

        var matches = products.filter(function (p) {
            if (p.artist) return recordsMatch(item, p);
            // If no artist parsed, use combined matching
            return recordsMatchCombined(item, p.title);
        });
        return {
            store: 'Turntable Lab',
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl
        };
    } catch (e) {
        return { store: 'Turntable Lab', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// Check Underground Vinyl Source (Shopify)
async function checkUndergroundVinyl(page, item) {
    var searchUrl = 'https://undergroundvinylsource.com/search?q=' + encodeURIComponent(item.searchQuery) + '&type=product';
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.product-card, .product-title, [class*="product"]', { timeout: 8000 }).catch(function () {});

        var products = await page.evaluate(function () {
            var items = [];
            var cards = document.querySelectorAll('.product-card.product-grid');
            cards.forEach(function (el) {
                var titleEl = el.querySelector('h6.product-card__name, .product-card__name');
                var priceEl = el.querySelector('.product-price');
                var combined = titleEl ? titleEl.textContent.trim() : '';
                var price = priceEl ? priceEl.textContent.trim().replace(/\s+/g, ' ') : '';

                // Parse "Artist - Title" format
                var artist = '';
                var title = '';
                if (combined.indexOf(' - ') !== -1) {
                    var parts = combined.split(' - ');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(' - ').trim();
                } else {
                    title = combined;
                }

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
        return {
            store: 'Underground Vinyl',
            inStock: matches.length > 0,
            matches: matches,
            searchUrl: searchUrl
        };
    } catch (e) {
        return { store: 'Underground Vinyl', inStock: false, error: e.message, searchUrl: searchUrl };
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    var username = process.argv[2];
    if (!username) {
        console.error('Usage: node vinyl-checker-puppeteer.js <discogs-username>');
        process.exit(1);
    }

    console.log('🎵 Fetching wantlist for ' + username + '...');
    var wantlist = await fetchWantlist(username);
    console.log('✓ Loaded ' + wantlist.length + ' items\n');

    if (wantlist.length === 0) {
        console.log('No items in wantlist. Nothing to check.');
        return;
    }

    console.log('🚀 Launching browser...');
    var browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 120000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    // Create pages for each scraped store
    // pages[0] = Deejay.de
    // pages[1] = HHV
    // pages[2] = Hardwax
    // pages[3] = Juno
    // pages[4] = Turntable Lab
    // pages[5] = Underground Vinyl Source
    var NUM_PAGES = 6;
    var pages = [];
    for (var p = 0; p < NUM_PAGES; p++) {
        pages.push(await browser.newPage());
    }

    var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    for (var pi = 0; pi < pages.length; pi++) {
        pages[pi].setDefaultNavigationTimeout(30000);
        pages[pi].setDefaultTimeout(60000);
        await pages[pi].setUserAgent(UA);
        await pages[pi].setRequestInterception(true);
    }

    // Deejay.de (pages[0]) - block stylesheets too
    pages[0].on('request', function (req) {
        var type = req.resourceType();
        if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
            req.abort();
        } else {
            req.continue();
        }
    });

    // HHV (pages[1]) - keep stylesheets (SPA needs CSS to render)
    pages[1].on('request', function (req) {
        var type = req.resourceType();
        if (type === 'image' || type === 'media' || type === 'font') {
            req.abort();
        } else {
            req.continue();
        }
    });

    // Hardwax, Juno, Turntable Lab, Underground Vinyl (pages 2-5) - block images/media/fonts
    for (var si = 2; si < NUM_PAGES; si++) {
        pages[si].on('request', function (req) {
            var type = req.resourceType();
            if (type === 'image' || type === 'media' || type === 'font') {
                req.abort();
            } else {
                req.continue();
            }
        });
    }

    var storeNames = ['Deejay.de', 'HHV', 'Hardwax', 'Juno', 'Decks.de', 'Turntable Lab', 'Underground Vinyl', 'Phonica', 'Yoyaku'];
    console.log('🔍 Checking ' + storeNames.length + ' stores...\n');

    var allItems = [];
    var inStockItems = [];

    for (var i = 0; i < wantlist.length; i++) {
        var item = wantlist[i];
        var label = 'Checking ' + (i + 1) + '/' + wantlist.length + ': ' + item.artist + ' - ' + item.title;
        process.stdout.write('\r' + label.substring(0, 100).padEnd(100));

        // Check all scraped stores in parallel
        var results = await Promise.all([
            checkDeejay(pages[0], item),
            checkHHV(pages[1], item),
            checkHardwax(pages[2], item),
            checkJuno(pages[3], item),
            checkTurntableLab(pages[4], item),
            checkUndergroundVinyl(pages[5], item)
        ]);

        // Add link-only stores
        results.push(getDecksLink(item));
        results.push(getPhonicaLink(item));
        results.push(getYoyakuLink(item));

        var entry = { item: item, stores: results };
        allItems.push(entry);

        var hasStock = results.some(function (r) { return r.inStock; });
        if (hasStock) {
            inStockItems.push(entry);
        }

        // Small delay between items
        await new Promise(function (resolve) { setTimeout(resolve, 300); });
    }

    await browser.close();

    console.log('\n\n' + '='.repeat(80));
    console.log('\n🎉 Found ' + inStockItems.length + ' items in stock!\n');

    inStockItems.forEach(function (entry) {
        var item = entry.item;
        var stores = entry.stores;
        console.log('\n📀 ' + item.artist + ' - ' + item.title + ' (' + (item.year || 'N/A') + ')');
        console.log('   ' + item.label + ' ' + item.catno);

        stores.forEach(function (store) {
            if (store.inStock) {
                console.log('   ✓ ' + store.store + ': ' + (store.matches ? store.matches.length : 0) + ' matches found');
                if (store.matches) {
                    store.matches.forEach(function (match, idx) {
                        if (idx < 2) {
                            console.log('     - ' + (match.artist ? match.artist + ' - ' : '') + match.title + ' ' + (match.price || ''));
                        }
                    });
                }
                console.log('     ' + store.searchUrl);
            }
        });

        // Show link-only stores
        stores.forEach(function (store) {
            if (store.linkOnly) {
                console.log('   🔗 ' + store.store + ': ' + store.searchUrl);
            }
        });
    });

    console.log('\n' + '='.repeat(80));
    console.log('\n💾 Saving results to results.json...');

    require('fs').writeFileSync('results.json', JSON.stringify(allItems, null, 2));
    console.log('✓ Saved ' + allItems.length + ' items (' + inStockItems.length + ' in stock)\n');
}

main().catch(console.error);
