#!/usr/bin/env node

/**
 * Vinyl Checker Web App
 *
 * Serves a web UI where users enter a Discogs username,
 * then checks 9 stores in batches with real-time progress via SSE.
 *
 * Run: node server.js
 * Open: http://localhost:3000
 */

const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');
const db = require('./db');

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', function (e) { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', function (e) { console.error('Unhandled:', e && e.message); });
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// FUZZY MATCHING (same as vinyl-checker-puppeteer.js)
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
// DISCOGS WANTLIST
// ═══════════════════════════════════════════════════════════════

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

async function fetchWantlist(username) {
    return new Promise(function (resolve, reject) {
        var fetchPage = function (page, allWants) {
            allWants = allWants || [];
            https.get({
                hostname: 'api.discogs.com',
                path: '/users/' + username + '/wants?per_page=100&page=' + page,
                headers: { 'User-Agent': 'VinylWantlistChecker/1.0' }
            }, function (res) {
                if (res.statusCode === 404) return reject(new Error('Username not found'));
                if (res.statusCode === 429) return reject(new Error('Rate limit reached'));
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('API error: ' + res.statusCode));
                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    try { var json = JSON.parse(data); } catch (e) { return reject(new Error('Parse error')); }
                    if (!json.wants || json.wants.length === 0) return resolve(allWants);
                    var wants = json.wants.map(function (w) {
                        var artist = getArtistName(w);
                        var bi = w.basic_information;
                        return {
                            id: w.id, artist: artist, title: bi.title,
                            year: bi.year, label: getLabelName(w), catno: getCatno(w),
                            thumb: bi.thumb || '',
                            genres: (bi.genres || []).join(', '),
                            styles: (bi.styles || []).join(', '),
                            searchQuery: (artist + ' ' + bi.title).trim()
                        };
                    });
                    allWants = allWants.concat(wants);
                    if (page < json.pagination.pages) setTimeout(function () { fetchPage(page + 1, allWants); }, 500);
                    else resolve(allWants);
                });
            }).on('error', reject);
        };
        fetchPage(1);
    });
}

// ═══════════════════════════════════════════════════════════════
// STORE CHECKERS
// ═══════════════════════════════════════════════════════════════

// Link-only stores (with known US shipping rates)
function getPhonicaLink(item) {
    return { store: 'Phonica', inStock: false, matches: [], searchUrl: 'https://www.phonicarecords.com/search/' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '£6.50' };
}
function getYoyakuLink(item) {
    return { store: 'Yoyaku', inStock: false, matches: [], searchUrl: 'https://yoyaku.co/search?q=' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '€15.00' };
}
function getDecksLink(item) {
    return { store: 'Decks.de', inStock: false, matches: [], searchUrl: 'https://www.decks.de/decks/workfloor/search_db.php?such=' + encodeURIComponent(item.searchQuery) + '&wosuch=vi&wassuch=atl', linkOnly: true, usShipping: '€9.90' };
}

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
        console.log('[Deejay] "' + item.searchQuery + '" → ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'Deejay.de', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '€12.99' };
    } catch (e) {
        console.log('[Deejay] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Deejay.de', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '€12.99' };
    }
}

// HHV
async function checkHHV(page, item) {
    var searchUrl = 'https://www.hhv.de/katalog/filter/suche-S11?af=true&term=' + encodeURIComponent(item.searchQuery);
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await page.waitForSelector('.items--shared--gallery-entry--base-component span.artist', { timeout: 5000 }).catch(function () {});
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
        console.log('[Juno] "' + item.searchQuery + '" → ' + products.length + ' products, ' + products.filter(function (p) { return recordsMatch(item, p); }).length + ' matches');
        var matches = products.filter(function (p) { return recordsMatch(item, p); });
        return { store: 'Juno', inStock: matches.length > 0, matches: matches, searchUrl: searchUrl, usShipping: '£7.99' };
    } catch (e) {
        console.log('[Juno] ERROR "' + item.searchQuery + '": ' + e.message);
        return { store: 'Juno', inStock: false, error: e.message, searchUrl: searchUrl, usShipping: '£7.99' };
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
                // Extract just the price amount
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
// PARALLEL WORKER PROCESSOR
// ═══════════════════════════════════════════════════════════════

const NUM_WORKERS = 2; // 2 items checked simultaneously
const STORES_PER_WORKER = 3; // 3 scraped stores: Deejay.de, HHV, Juno
let activeScan = null;

// ═══════════════════════════════════════════════════════════════
// LINK-ONLY STORES — click goes directly to search results page
// ═══════════════════════════════════════════════════════════════

function getHardwaxLink(item) {
    return { store: 'Hardwax', inStock: false, matches: [], searchUrl: 'https://hardwax.com/?search=' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '€12.00' };
}
function getTurntableLabLink(item) {
    return { store: 'Turntable Lab', inStock: false, matches: [], searchUrl: 'https://www.turntablelab.com/search?type=product&q=' + encodeURIComponent(item.searchQuery), linkOnly: true, usShipping: '$5.99' };
}
function getUndergroundVinylLink(item) {
    return { store: 'Underground Vinyl', inStock: false, matches: [], searchUrl: 'https://undergroundvinylsource.com/search?q=' + encodeURIComponent(item.searchQuery) + '&type=product', linkOnly: true, usShipping: '$5.00' };
}

async function createWorkerPages(browser) {
    var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var workers = [];

    for (var w = 0; w < NUM_WORKERS; w++) {
        var pages = [];
        for (var p = 0; p < STORES_PER_WORKER; p++) pages.push(await browser.newPage());

        for (var pi = 0; pi < pages.length; pi++) {
            pages[pi].setDefaultNavigationTimeout(10000);
            pages[pi].setDefaultTimeout(10000);
            await pages[pi].setUserAgent(UA);
            await pages[pi].setRequestInterception(true);
        }
        // pages[0] = Deejay.de - block stylesheets
        pages[0].on('request', function (req) {
            var type = req.resourceType();
            (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') ? req.abort() : req.continue();
        });
        // pages[1] = HHV - keep stylesheets (SPA needs CSS)
        pages[1].on('request', function (req) {
            var type = req.resourceType();
            (type === 'image' || type === 'media' || type === 'font') ? req.abort() : req.continue();
        });
        // pages[2] = Juno
        pages[2].on('request', function (req) {
            var type = req.resourceType();
            (type === 'image' || type === 'media' || type === 'font') ? req.abort() : req.continue();
        });
        workers.push(pages);
    }
    return workers;
}

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

// ═══════════════════════════════════════════════════════════════
// DISCOGS MARKETPLACE PRICES (via API)
// ═══════════════════════════════════════════════════════════════

function fetchMarketplaceStats(discogsId) {
    var marketplaceUrl = 'https://www.discogs.com/sell/release/' + discogsId + '?ev=rb&destination=United+States&sort=price%2Casc';
    return new Promise(function (resolve, reject) {
        // Scrape the marketplace page directly — gives us price + shipping for US-available listings
        https.get({
            hostname: 'www.discogs.com',
            path: '/sell/release/' + discogsId + '?destination=United+States&sort=price%2Casc',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        }, function (res) {
            if (res.statusCode === 429) return reject(new Error('Rate limit'));
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve({ lowestPrice: null, numForSale: 0, marketplaceUrl: marketplaceUrl });
            }
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                try {
                    // Extract number for sale
                    var numMatch = data.match(/of\s+(\d+)\s+for sale/i) || data.match(/(\d+)\s+for sale/i);
                    var numForSale = numMatch ? parseInt(numMatch[1]) : 0;

                    // Find listings that are available (have "Add to Cart" or price, NOT "Unavailable")
                    // Look for price items in the shortcut_navigable items
                    var prices = [];
                    // Match price spans like €6.50 or $10.00 or £8.00
                    var itemBlocks = data.split(/class="shortcut_navigable/g);
                    for (var i = 1; i < itemBlocks.length; i++) {
                        var block = itemBlocks[i];
                        // Skip if unavailable in US
                        if (block.indexOf('Unavailable') !== -1) continue;

                        // Extract item price — look for the price value in span.price
                        var priceMatch = block.match(/class="price"[^>]*>([^<]+)</);
                        if (!priceMatch) priceMatch = block.match(/about\s*([€$£¥][\d,.]+)/);
                        if (!priceMatch) continue;

                        var priceText = priceMatch[1].trim();

                        // Extract shipping price
                        var shippingMatch = block.match(/\+([€$£¥][\d,.]+)\s*shipping/i) || block.match(/\+([\d,.]+)\s*shipping/i);
                        var shippingText = shippingMatch ? shippingMatch[1].trim() : null;
                        // Add currency symbol if missing
                        if (shippingText && !shippingText.match(/^[€$£¥]/)) {
                            var curr = priceText.match(/^[€$£¥]/);
                            if (curr) shippingText = curr[0] + shippingText;
                        }

                        // Extract "about" total if present (Discogs shows "about €29.86" for converted total)
                        var aboutMatch = block.match(/about\s*([€$£¥][\d,.]+)/);
                        var aboutTotal = aboutMatch ? aboutMatch[1].trim() : null;

                        prices.push({
                            price: priceText,
                            shipping: shippingText,
                            aboutTotal: aboutTotal
                        });
                    }

                    if (prices.length > 0) {
                        var best = prices[0];
                        // Parse numeric value from price
                        var numericPrice = parseFloat(best.price.replace(/[^0-9.,]/g, '').replace(',', '.'));
                        var currency = best.price.match(/^[€$£¥]/) ? best.price[0] : '€';
                        var currName = currency === '$' ? 'USD' : currency === '£' ? 'GBP' : currency === '¥' ? 'JPY' : 'EUR';

                        resolve({
                            lowestPrice: numericPrice || null,
                            currency: currName,
                            numForSale: numForSale,
                            shipping: best.shipping || null,
                            marketplaceUrl: marketplaceUrl
                        });
                    } else {
                        resolve({ lowestPrice: null, numForSale: numForSale, marketplaceUrl: marketplaceUrl });
                    }
                } catch (e) {
                    console.log('[Discogs] Parse error for ' + discogsId + ': ' + e.message);
                    resolve({ lowestPrice: null, numForSale: 0, marketplaceUrl: marketplaceUrl });
                }
            });
        }).on('error', function () { resolve({ lowestPrice: null, numForSale: 0, marketplaceUrl: marketplaceUrl }); });
    });
}

// ═══════════════════════════════════════════════════════════════
// SCAN LOGIC (with DB caching)
// ═══════════════════════════════════════════════════════════════

async function runScan(username, sendEvent) {
    if (activeScan) {
        sendEvent('error', { message: 'A scan is already in progress' });
        return;
    }
    activeScan = username;

    try {
        // Step 1: Fetch wantlist from Discogs
        sendEvent('status', { phase: 'fetching', message: 'Fetching wantlist for ' + username + '...' });
        var wantlist = await fetchWantlist(username);

        if (wantlist.length === 0) {
            sendEvent('done', { message: 'Wantlist is empty', total: 0, inStock: 0, results: [] });
            activeScan = null;
            return;
        }

        // Step 2: Sync to database
        var user = db.getOrCreateUser(username);
        var syncResult = db.syncWantlistItems(user.id, wantlist);
        console.log('Synced wantlist: ' + syncResult.totalActive + ' active, ' + syncResult.newItems.length + ' new, ' + syncResult.removedCount + ' removed');

        // Step 3: Determine what needs checking
        var allDbItems = db.getActiveWantlist(user.id);
        var itemsToCheck = db.getItemsNeedingCheck(user.id);
        var cachedCount = allDbItems.length - itemsToCheck.length;

        sendEvent('wantlist', {
            total: allDbItems.length,
            toCheck: itemsToCheck.length,
            cached: cachedCount,
            username: username
        });

        // Send cached items immediately
        if (cachedCount > 0) {
            sendEvent('status', { phase: 'cached', message: 'Loaded ' + cachedCount + ' cached results' });
            var cachedItems = allDbItems.filter(function (w) {
                return !itemsToCheck.some(function (tc) { return tc.id === w.id; });
            });
            cachedItems.forEach(function (w, idx) {
                var stores = db.getStoreResults(w.id);
                var price = db.getDiscogsPrice(w.id);
                var hasStock = stores.some(function (s) { return s.inStock; });
                sendEvent('item-done', {
                    index: idx,
                    total: allDbItems.length,
                    item: {
                        id: w.discogs_id, artist: w.artist, title: w.title,
                        year: w.year, label: w.label, catno: w.catno,
                        thumb: w.thumb, genres: w.genres || '', styles: w.styles || '', searchQuery: w.search_query
                    },
                    stores: stores,
                    discogsPrice: price ? {
                        lowestPrice: price.lowest_price,
                        currency: price.currency,
                        numForSale: price.num_for_sale,
                        shipping: price.shipping || null,
                        marketplaceUrl: price.marketplace_url
                    } : null,
                    inStock: hasStock,
                    totalInStock: 0, // will be recalculated
                    fromCache: true
                });
            });
        }

        if (itemsToCheck.length === 0) {
            // Everything is cached
            var fullResults = db.getFullResults(user.id);
            var totalInStock = fullResults.filter(function (r) { return r.stores.some(function (s) { return s.inStock; }); }).length;
            sendEvent('done', {
                message: 'All results from cache (checked within 24h)',
                total: allDbItems.length,
                inStock: totalInStock,
                username: username
            });
            activeScan = null;
            return;
        }

        // Step 4: Launch browser for items that need checking
        sendEvent('status', { phase: 'launching', message: 'Checking ' + itemsToCheck.length + ' items...' });
        var browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 60000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-gpu', '--disable-extensions']
        });
        var workers = await createWorkerPages(browser);

        // Step 5: Process unchecked items
        sendEvent('status', { phase: 'checking', message: 'Checking ' + itemsToCheck.length + ' items across stores...' });
        var completedCount = cachedCount;
        var itemIndex = 0;

        async function workerLoop(workerIdx) {
            var pages = workers[workerIdx];
            while (true) {
                var myIdx = itemIndex++;
                if (myIdx >= itemsToCheck.length) break;

                var w = itemsToCheck[myIdx];
                var item = {
                    id: w.discogs_id, artist: w.artist, title: w.title,
                    year: w.year, label: w.label, catno: w.catno,
                    thumb: w.thumb, searchQuery: w.search_query
                };

                try {
                    var results = await checkItem(pages, item);

                    // Save to DB
                    db.saveStoreResults(w.id, results);

                    // Fetch Discogs marketplace price
                    if (w.discogs_id) {
                        try {
                            var priceData = await fetchMarketplaceStats(w.discogs_id);
                            db.saveDiscogsPrice(w.id, priceData);
                        } catch (e) { /* price fetch failed, not critical */ }
                    }

                    var hasStock = results.some(function (r) { return r.inStock; });
                    completedCount++;

                    var price = db.getDiscogsPrice(w.id);
                    sendEvent('item-done', {
                        index: completedCount - 1,
                        total: allDbItems.length,
                        item: item,
                        stores: results,
                        discogsPrice: price ? {
                            lowestPrice: price.lowest_price,
                            currency: price.currency,
                            numForSale: price.num_for_sale,
                            marketplaceUrl: price.marketplace_url
                        } : null,
                        inStock: hasStock,
                        totalInStock: 0,
                        fromCache: false
                    });
                } catch (e) {
                    completedCount++;
                    sendEvent('item-done', {
                        index: completedCount - 1,
                        total: allDbItems.length,
                        item: item,
                        stores: [],
                        inStock: false,
                        totalInStock: 0,
                        fromCache: false
                    });
                }
            }
        }

        var workerPromises = [];
        for (var w = 0; w < NUM_WORKERS; w++) {
            workerPromises.push(workerLoop(w));
        }
        await Promise.all(workerPromises);

        await browser.close();

        db.updateUserFullScanTime(user.id);

        var fullResults = db.getFullResults(user.id);
        var totalInStock = fullResults.filter(function (r) { return r.stores.some(function (s) { return s.inStock; }); }).length;

        sendEvent('done', {
            message: 'Scan complete!',
            total: allDbItems.length,
            inStock: totalInStock,
            username: username,
            checked: itemsToCheck.length,
            cached: cachedCount
        });

    } catch (e) {
        sendEvent('error', { message: e.message });
    } finally {
        activeScan = null;
    }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// Force-reset scan lock
app.get('/api/reset', function (req, res) {
    activeScan = null;
    res.json({ ok: true });
});

// Diagnostic: test a single store with a known query
app.get('/api/test-stores', async function (req, res) {
    var testItem = { artist: 'Aphex Twin', title: 'Selected Ambient Works 85-92', searchQuery: 'Aphex Twin Selected Ambient Works' };
    try {
        var browser = await puppeteer.launch({
            headless: 'new',
            protocolTimeout: 30000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        var results = {};

        // Test Deejay.de
        var p1 = await browser.newPage();
        await p1.setRequestInterception(true);
        p1.on('request', function (r) { var t = r.resourceType(); (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') ? r.abort() : r.continue(); });
        var d = await checkDeejay(p1, testItem);
        results.deejay = { products: d.matches.length, inStock: d.inStock, error: d.error || null };
        await p1.close();

        // Test HHV
        var p2 = await browser.newPage();
        await p2.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        await p2.setRequestInterception(true);
        p2.on('request', function (r) { var t = r.resourceType(); (t === 'image' || t === 'media' || t === 'font') ? r.abort() : r.continue(); });
        var h = await checkHHV(p2, testItem);
        results.hhv = { products: h.matches.length, inStock: h.inStock, error: h.error || null };
        await p2.close();

        // Test Juno
        var p3 = await browser.newPage();
        await p3.setRequestInterception(true);
        p3.on('request', function (r) { var t = r.resourceType(); (t === 'image' || t === 'media' || t === 'font') ? r.abort() : r.continue(); });
        var j = await checkJuno(p3, testItem);
        results.juno = { products: j.matches.length, inStock: j.inStock, error: j.error || null };
        await p3.close();

        await browser.close();
        res.json({ testQuery: testItem.searchQuery, results: results });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// SSE endpoint for real-time scan progress
app.get('/api/scan/:username', function (req, res) {
    var username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: 'Username required' });

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    function sendEvent(type, data) {
        res.write('event: ' + type + '\n');
        res.write('data: ' + JSON.stringify(data) + '\n\n');
    }

    // Keep connection alive
    var keepAlive = setInterval(function () {
        res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', function () {
        clearInterval(keepAlive);
    });

    // Start the scan
    runScan(username, sendEvent).then(function () {
        clearInterval(keepAlive);
        res.end();
    });
});

// Get cached results from DB (instant)
app.get('/api/results/:username', function (req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username.trim());
        var results = db.getFullResults(user.id);
        res.json({
            username: req.params.username,
            total: results.length,
            inStock: results.filter(function (r) { return r.stores.some(function (s) { return s.inStock; }); }).length,
            lastScan: user.last_full_scan,
            results: results
        });
    } catch (e) {
        res.json({ username: req.params.username, total: 0, inStock: 0, results: [] });
    }
});

// Check scan status
app.get('/api/status', function (req, res) {
    res.json({ scanning: !!activeScan, username: activeScan });
});

// Serve the app
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Graceful shutdown
process.on('SIGINT', function () { db.close(); process.exit(0); });
process.on('SIGTERM', function () { db.close(); process.exit(0); });

// ═══════════════════════════════════════════════════════════════
// BACKGROUND SYNC — checks for new wantlist items periodically
// ═══════════════════════════════════════════════════════════════

var SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL) || (60 * 60 * 1000); // default 1 hour
var NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || '';
var NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || ''; // Discord/Slack webhook

async function backgroundSync() {
    var d = db.getDb();
    var users = d.prepare('SELECT * FROM users WHERE last_full_scan IS NOT NULL').all();
    if (users.length === 0) return;

    for (var i = 0; i < users.length; i++) {
        var user = users[i];
        if (activeScan) { console.log('[sync] Scan in progress, skipping ' + user.username); continue; }

        console.log('[sync] Syncing wantlist for ' + user.username + '...');
        try {
            var wantlist = await fetchWantlist(user.username);
            var syncResult = db.syncWantlistItems(user.id, wantlist);

            if (syncResult.newItems.length === 0) {
                console.log('[sync] ' + user.username + ': no new items');
                continue;
            }

            console.log('[sync] ' + user.username + ': ' + syncResult.newItems.length + ' new items, checking stores...');

            // Check new items
            activeScan = user.username + '-bg';
            var browser = await puppeteer.launch({
                headless: 'new',
                protocolTimeout: 60000,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });
            var workers = await createWorkerPages(browser);

            var newDbItems = db.getActiveWantlist(user.id).filter(function (w) {
                return syncResult.newItems.some(function (n) { return n.id === w.discogs_id; });
            });

            var notifications = [];
            var itemIdx = 0;

            async function bgWorker(workerIdx) {
                var pages = workers[workerIdx];
                while (true) {
                    var myIdx = itemIdx++;
                    if (myIdx >= newDbItems.length) break;
                    var w = newDbItems[myIdx];
                    var item = {
                        id: w.discogs_id, artist: w.artist, title: w.title,
                        year: w.year, label: w.label, catno: w.catno,
                        thumb: w.thumb, searchQuery: w.search_query
                    };
                    try {
                        var results = await checkItem(pages, item);
                        db.saveStoreResults(w.id, results);

                        if (w.discogs_id) {
                            try {
                                var priceData = await fetchMarketplaceStats(w.discogs_id);
                                db.saveDiscogsPrice(w.id, priceData);
                            } catch (e) {}
                        }

                        var inStockStores = results.filter(function (r) { return r.inStock && !r.linkOnly; });
                        if (inStockStores.length > 0) {
                            var dp = db.getDiscogsPrice(w.id);
                            notifications.push({
                                artist: w.artist, title: w.title,
                                stores: inStockStores.map(function (s) {
                                    var cheapest = s.matches && s.matches[0] ? s.matches[0].price : '';
                                    return { name: s.store, price: cheapest, url: s.searchUrl };
                                }),
                                discogsPrice: dp ? '$' + (dp.lowest_price || '?') : null
                            });
                        }
                    } catch (e) { console.log('[sync] Error checking ' + w.artist + ': ' + e.message); }
                }
            }

            var bgPromises = [];
            for (var w = 0; w < NUM_WORKERS; w++) bgPromises.push(bgWorker(w));
            await Promise.all(bgPromises);
            await browser.close();
            activeScan = null;

            // Send notifications if any items found in stock
            if (notifications.length > 0) {
                await sendNotifications(user.username, notifications);
            }

            console.log('[sync] ' + user.username + ': done, ' + notifications.length + ' new items in stock');
        } catch (e) {
            console.log('[sync] Error syncing ' + user.username + ': ' + e.message);
            activeScan = null;
        }
    }
}

async function sendNotifications(username, items) {
    var lines = items.map(function (item) {
        var storeList = item.stores.map(function (s) {
            return s.name + ' ' + s.price + ' ' + s.url;
        }).join('\n  ');
        var discogs = item.discogsPrice ? ' (Discogs: ' + item.discogsPrice + ')' : '';
        return item.artist + ' - ' + item.title + discogs + '\n  ' + storeList;
    });

    var message = 'Vinyl Checker: ' + items.length + ' new item(s) in stock for ' + username + '!\n\n' + lines.join('\n\n');
    console.log('[notify]\n' + message);

    // Discord/Slack webhook
    if (NOTIFICATION_WEBHOOK) {
        try {
            var url = new URL(NOTIFICATION_WEBHOOK);
            var payload = JSON.stringify({ content: message });
            var options = {
                hostname: url.hostname, path: url.pathname, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            };
            await new Promise(function (resolve) {
                var req = (url.protocol === 'https:' ? https : require('http')).request(options, resolve);
                req.write(payload);
                req.end();
            });
            console.log('[notify] Webhook sent');
        } catch (e) { console.log('[notify] Webhook error: ' + e.message); }
    }
}

app.listen(PORT, function () {
    console.log('\n\u2728 Vinyl Checker running at http://localhost:' + PORT + '\n');

    // Background sync
    console.log('[sync] Background sync every ' + (SYNC_INTERVAL / 60000).toFixed(0) + ' minutes');
    if (NOTIFICATION_WEBHOOK) console.log('[sync] Notifications enabled (webhook)');
    setInterval(function () {
        backgroundSync().catch(function (e) { console.error('[sync] Fatal:', e.message); activeScan = null; });
    }, SYNC_INTERVAL);
});
