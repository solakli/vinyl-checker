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

// Load .env if present (no dependency needed)
const fs = require('fs');
const path = require('path');
try {
    var envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                var eq = line.indexOf('=');
                if (eq > 0) {
                    var key = line.substring(0, eq).trim();
                    var val = line.substring(eq + 1).trim();
                    if (!process.env[key]) process.env[key] = val;
                }
            }
        });
    }
} catch(e) {}

const express = require('express');
const db = require('./db');
const discogs = require('./lib/discogs');
const scanner = require('./lib/scanner');
const oauth = require('./lib/oauth');

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', function (e) { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', function (e) { console.error('Unhandled:', e && e.message); });

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Cookie parsing middleware (simple, no dependency)
app.use(function (req, res, next) {
    req.cookies = {};
    var cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(function (cookie) {
            var parts = cookie.split('=');
            var key = parts[0].trim();
            var val = parts.slice(1).join('=').trim();
            req.cookies[key] = val;
        });
    }
    next();
});

// Session middleware -- identify user from cookie
app.use(function (req, res, next) {
    var token = req.cookies['vinyl_session'];
    if (token) {
        var sessionUser = db.getSessionUser(token);
        if (sessionUser) {
            req.sessionUser = sessionUser;
            db.updateSessionLastSeen(token);
        }
    }
    next();
});

// Base path for redirects (handles nginx subpath)
var APP_BASE = process.env.BASE_URL || '';

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

// Get auth status for current user
app.get('/api/auth/status', function (req, res) {
    var result = {
        discogs: { connected: false },
        youtube: { connected: false },
        discogsOAuthEnabled: oauth.discogsEnabled(),
        youtubeEnabled: oauth.googleEnabled()
    };
    if (req.sessionUser) {
        var discogsToken = db.getOAuthToken(req.sessionUser.id, 'discogs');
        var googleToken = db.getOAuthToken(req.sessionUser.id, 'google');
        if (discogsToken) result.discogs = { connected: true, username: discogsToken.provider_username };
        if (googleToken) result.youtube = { connected: true };
    }
    res.json(result);
});

// --- DISCOGS OAUTH ---

app.get('/api/auth/discogs', async function (req, res) {
    if (!oauth.discogsEnabled()) return res.status(503).json({ error: 'Discogs OAuth not configured' });
    try {
        var result = await oauth.discogsRequestToken();
        // Store which session initiated this so we can link on callback
        if (req.sessionUser) {
            // Store session token in a cookie so callback can find user
            res.cookie('vinyl_oauth_state', req.cookies['vinyl_session'], { httpOnly: true, maxAge: 600000, path: '/' });
        }
        res.redirect(result.authorizeUrl);
    } catch (e) {
        console.error('[auth] Discogs request token error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/auth/discogs/callback', async function (req, res) {
    var oauthToken = req.query.oauth_token;
    var oauthVerifier = req.query.oauth_verifier;

    if (!oauthToken || !oauthVerifier) {
        return res.redirect(APP_BASE + '/?auth_error=denied');
    }

    try {
        // Exchange for access token
        var tokens = await oauth.discogsAccessToken(oauthToken, oauthVerifier);

        // Get identity
        var identity = await oauth.discogsIdentity(tokens.accessToken, tokens.accessSecret);

        // Find or create user by Discogs username
        var user = db.getOrCreateUser(identity.username);

        // Save OAuth tokens
        db.saveOAuthToken(user.id, 'discogs', {
            accessToken: tokens.accessToken,
            accessSecret: tokens.accessSecret,
            providerUsername: identity.username,
            providerId: String(identity.id)
        });

        // Create a session for this user
        var sessionToken = db.createSession(user.id);
        res.cookie('vinyl_session', sessionToken, {
            httpOnly: true,
            maxAge: 365 * 24 * 60 * 60 * 1000,
            sameSite: 'lax',
            path: '/'
        });

        // Redirect back to app
        res.redirect(APP_BASE + '/?auth=discogs&username=' + encodeURIComponent(identity.username));
    } catch (e) {
        console.error('[auth] Discogs callback error:', e.message);
        res.redirect(APP_BASE + '/?auth_error=' + encodeURIComponent(e.message));
    }
});

app.post('/api/auth/discogs/disconnect', function (req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    db.deleteOAuthToken(req.sessionUser.id, 'discogs');
    res.json({ ok: true });
});

// --- GOOGLE/YOUTUBE OAUTH ---

app.get('/api/auth/google', function (req, res) {
    if (!oauth.googleEnabled()) return res.status(503).json({ error: 'YouTube OAuth not configured' });
    if (!req.sessionUser) return res.status(401).json({ error: 'Login first (enter Discogs username or connect Discogs)' });

    var state = req.cookies['vinyl_session'] || '';
    var authUrl = oauth.googleAuthorizeUrl(state);
    res.redirect(authUrl);
});

app.get('/api/auth/google/callback', async function (req, res) {
    var code = req.query.code;
    var error = req.query.error;

    if (error || !code) return res.redirect(APP_BASE + '/?auth_error=google_denied');

    try {
        var tokens = await oauth.googleExchangeCode(code);

        // Need to find the user from session
        if (!req.sessionUser) return res.redirect(APP_BASE + '/?auth_error=no_session');

        db.saveOAuthToken(req.sessionUser.id, 'google', {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: new Date(tokens.expiresAt).toISOString()
        });

        res.redirect(APP_BASE + '/?auth=youtube');
    } catch (e) {
        console.error('[auth] Google callback error:', e.message);
        res.redirect(APP_BASE + '/?auth_error=' + encodeURIComponent(e.message));
    }
});

app.post('/api/auth/google/disconnect', function (req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    db.deleteOAuthToken(req.sessionUser.id, 'google');
    res.json({ ok: true });
});

// --- YOUTUBE PLAYLIST CREATION ---

app.post('/api/youtube/create-playlist', async function (req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });

    var googleOAuth = db.getOAuthToken(req.sessionUser.id, 'google');
    if (!googleOAuth) return res.status(401).json({ error: 'Connect YouTube first' });

    try {
        // Refresh token if expired
        var accessToken = googleOAuth.access_token;
        if (googleOAuth.expires_at && new Date(googleOAuth.expires_at) < new Date()) {
            if (!googleOAuth.refresh_token) return res.status(401).json({ error: 'YouTube token expired, reconnect' });
            var refreshed = await oauth.googleRefreshToken(googleOAuth.refresh_token);
            db.saveOAuthToken(req.sessionUser.id, 'google', {
                accessToken: refreshed.accessToken,
                expiresAt: new Date(refreshed.expiresAt).toISOString()
            });
            accessToken = refreshed.accessToken;
        }

        var title = req.body.title || (req.sessionUser.username + "'s Vinyl Wantlist");
        var description = req.body.description || 'Created by Vinyl Checker from Discogs wantlist';
        var videoIds = req.body.videoIds || [];

        if (videoIds.length === 0) return res.status(400).json({ error: 'No videos to add' });

        // Create playlist
        var playlist = await oauth.createPlaylist(accessToken, title, description);
        var playlistId = playlist.id;
        var playlistUrl = 'https://www.youtube.com/playlist?list=' + playlistId;

        // Add videos (with delay to respect rate limits)
        var added = 0;
        var errors = [];
        for (var i = 0; i < videoIds.length; i++) {
            try {
                await oauth.addVideoToPlaylist(accessToken, playlistId, videoIds[i]);
                added++;
            } catch (e) {
                errors.push({ videoId: videoIds[i], error: e.message });
            }
            // Small delay between adds
            if (i < videoIds.length - 1) {
                await new Promise(function(r) { setTimeout(r, 200); });
            }
        }

        res.json({
            ok: true,
            playlistId: playlistId,
            playlistUrl: playlistUrl,
            added: added,
            total: videoIds.length,
            errors: errors
        });
    } catch (e) {
        console.error('[youtube] Playlist error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Force-reset scan lock
app.get('/api/reset', function (req, res) {
    scanner.activeScans = {};
    res.json({ ok: true });
});

// Get current session info
app.get('/api/session', function (req, res) {
    if (req.sessionUser) {
        var discogsOAuth = db.getOAuthToken(req.sessionUser.id, 'discogs');
        res.json({
            username: req.sessionUser.username,
            discogsConnected: !!discogsOAuth
        });
    } else {
        res.json({ username: null });
    }
});

// Create session for a username
app.post('/api/session', function (req, res) {
    var username = (req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required' });

    var user = db.getOrCreateUser(username);
    var token = db.createSession(user.id);

    res.cookie('vinyl_session', token, {
        httpOnly: true,
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        sameSite: 'lax',
        path: '/'
    });

    res.json({ username: username });
});

// Logout — clear session cookie
app.post('/api/logout', function (req, res) {
    res.clearCookie('vinyl_session', { path: '/' });
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// STORE VALIDATION / HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

var TEST_ITEMS = [
    { artist: 'Aphex Twin', title: 'Selected Ambient Works 85-92', searchQuery: 'Aphex Twin Selected Ambient Works' },
    { artist: 'Daft Punk', title: 'Discovery', searchQuery: 'Daft Punk Discovery' },
    { artist: 'Burial', title: 'Untrue', searchQuery: 'Burial Untrue' }
];

app.get('/api/test-stores', async function (req, res) {
    var puppeteerExtra = require('puppeteer-extra');
    var StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    var scrapers = require('./lib/scrapers');
    var testIdx = parseInt(req.query.test) || 0;
    var testItem = TEST_ITEMS[testIdx % TEST_ITEMS.length];
    var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

    try {
        var browser = await puppeteerExtra.launch({
            headless: 'new',
            protocolTimeout: 60000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        var results = {};

        // Test scraped stores — one page per store, no request interception (stealth needs clean state)
        var stores = [
            { name: 'Deejay.de', fn: scrapers.checkDeejay },
            { name: 'HHV', fn: scrapers.checkHHV, warmup: true },
            { name: 'Juno', fn: scrapers.checkJuno },
            { name: 'Hardwax', fn: scrapers.checkHardwax },
            { name: 'Turntable Lab', fn: scrapers.checkTurntableLab },
            { name: 'Underground Vinyl', fn: scrapers.checkUndergroundVinyl }
        ];

        for (var i = 0; i < stores.length; i++) {
            var store = stores[i];
            var startTime = Date.now();
            try {
                var page = await browser.newPage();
                page.setDefaultNavigationTimeout(15000);
                page.setDefaultTimeout(15000);
                await page.setUserAgent(UA);
                // HHV needs warmup visit to establish session
                if (store.warmup) {
                    await page.goto('https://www.hhv.de/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(function () {});
                    await new Promise(function (r) { setTimeout(r, 2000); });
                }
                var result = await store.fn(page, testItem);
                var elapsed = Date.now() - startTime;
                results[store.name] = {
                    status: result.inStock ? 'found' : (result.error ? 'error' : 'no_match'),
                    products: (result.matches || []).length,
                    inStock: result.inStock,
                    error: result.error || null,
                    responseTime: elapsed + 'ms',
                    searchUrl: result.searchUrl
                };
                await page.close();
            } catch (e) {
                results[store.name] = { status: 'crash', error: e.message, responseTime: (Date.now() - startTime) + 'ms' };
            }
        }

        // Link-only stores
        var linkStores = [
            { name: 'Decks.de', fn: scrapers.getDecksLink },
            { name: 'Phonica', fn: scrapers.getPhonicaLink },
            { name: 'Yoyaku', fn: scrapers.getYoyakuLink }
        ];
        linkStores.forEach(function (ls) {
            var link = ls.fn(testItem);
            results[ls.name] = { status: 'link_only', searchUrl: link.searchUrl, usShipping: link.usShipping };
        });

        await browser.close();

        var scraped = Object.keys(results).filter(function (k) { return results[k].status !== 'link_only'; });
        var healthy = scraped.filter(function (k) { return results[k].status === 'found' || results[k].status === 'no_match'; });
        var broken = scraped.filter(function (k) { return results[k].status === 'error' || results[k].status === 'crash'; });

        res.json({
            testQuery: testItem.searchQuery,
            testItem: testItem,
            timestamp: new Date().toISOString(),
            summary: {
                total: Object.keys(results).length,
                scraped: scraped.length,
                healthy: healthy.length,
                broken: broken.length,
                brokenStores: broken
            },
            results: results
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Full validation: test all 6 scraped stores with all test items
app.get('/api/validate', async function (req, res) {
    var puppeteerExtra = require('puppeteer-extra');
    var StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    var scrapers = require('./lib/scrapers');
    var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

    try {
        var browser = await puppeteerExtra.launch({
            headless: 'new',
            protocolTimeout: 60000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        var storeChecks = [
            { name: 'Deejay.de', fn: scrapers.checkDeejay },
            { name: 'HHV', fn: scrapers.checkHHV, warmup: true },
            { name: 'Juno', fn: scrapers.checkJuno },
            { name: 'Hardwax', fn: scrapers.checkHardwax },
            { name: 'Turntable Lab', fn: scrapers.checkTurntableLab },
            { name: 'Underground Vinyl', fn: scrapers.checkUndergroundVinyl }
        ];

        var report = {};
        for (var s = 0; s < storeChecks.length; s++) {
            var store = storeChecks[s];
            report[store.name] = { tests: [], healthy: true, avgResponseTime: 0 };
            var totalTime = 0;

            // Each store gets its own page (no interception conflicts)
            var page = await browser.newPage();
            await page.setUserAgent(UA);
            if (store.warmup) {
                await page.goto('https://www.hhv.de/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(function () {});
                await new Promise(function (r) { setTimeout(r, 2000); });
            }

            for (var t = 0; t < TEST_ITEMS.length; t++) {
                var item = TEST_ITEMS[t];
                var startTime = Date.now();
                try {
                    var result = await store.fn(page, item);
                    var elapsed = Date.now() - startTime;
                    totalTime += elapsed;
                    var testResult = {
                        query: item.searchQuery,
                        products: (result.matches || []).length,
                        inStock: result.inStock,
                        error: result.error || null,
                        responseTime: elapsed
                    };
                    if (result.error) report[store.name].healthy = false;
                    report[store.name].tests.push(testResult);
                } catch (e) {
                    report[store.name].tests.push({ query: item.searchQuery, error: e.message });
                    report[store.name].healthy = false;
                }
                await new Promise(function (r) { setTimeout(r, 1000); });
            }
            report[store.name].avgResponseTime = Math.round(totalTime / TEST_ITEMS.length) + 'ms';
            await page.close();
        }

        await browser.close();

        var storeNames = Object.keys(report);
        var healthyCount = storeNames.filter(function (n) { return report[n].healthy; }).length;

        res.json({
            timestamp: new Date().toISOString(),
            overallHealth: healthyCount + '/' + storeNames.length + ' stores healthy',
            testItems: TEST_ITEMS.map(function (i) { return i.searchQuery; }),
            stores: report
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// SSE endpoint for real-time scan progress
app.get('/api/scan/:username', function (req, res) {
    var username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: 'Username required' });
    var force = req.query.force === 'true';

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    var closed = false;
    function sendEvent(type, data) {
        if (closed) return;
        try {
            res.write('event: ' + type + '\n');
            res.write('data: ' + JSON.stringify(data) + '\n\n');
            // End response when scan is done or errors
            if (type === 'done' || type === 'error' || type === 'scan-error') {
                clearInterval(keepAlive);
                closed = true;
                res.end();
            }
        } catch (e) { closed = true; }
    }

    // Keep connection alive
    var keepAlive = setInterval(function () {
        if (closed) return clearInterval(keepAlive);
        try { res.write(': keepalive\n\n'); } catch (e) { closed = true; clearInterval(keepAlive); }
    }, 15000);

    req.on('close', function () {
        closed = true;
        clearInterval(keepAlive);
        // Remove this listener from scanProgress
        var sp = scanner.scanProgress;
        if (sp[username]) {
            sp[username].listeners = sp[username].listeners.filter(function (fn) { return fn !== sendEvent; });
        }
    });

    // Build per-user Discogs auth headers if they have OAuth connected
    var userDiscogsHeaders = null;
    if (req.sessionUser) {
        var discogsOAuth = db.getOAuthToken(req.sessionUser.id, 'discogs');
        console.log('[scan] Session user:', req.sessionUser.username, '| OAuth token:', discogsOAuth ? 'found' : 'not found');
        if (discogsOAuth && discogsOAuth.access_token && discogsOAuth.access_secret) {
            console.log('[scan] Using OAuth headers for', username);
            userDiscogsHeaders = function (method, path) {
                var url = 'https://api.discogs.com' + path;
                return {
                    'User-Agent': 'VinylWantlistChecker/1.0',
                    'Authorization': oauth.discogsAuthHeader(method, url, discogsOAuth.access_token, discogsOAuth.access_secret)
                };
            };
        }
    } else {
        console.log('[scan] No session user for scan of', username, '| Cookie:', req.cookies['vinyl_session'] ? 'present' : 'missing');
    }

    // Start or attach to existing scan
    scanner.runScan(username, sendEvent, force, userDiscogsHeaders);
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

// Release details endpoint
app.get('/api/release/:discogs_id', async function (req, res) {
    var discogsId = parseInt(req.params.discogs_id, 10);
    if (!discogsId || isNaN(discogsId)) return res.status(400).json({ error: 'Invalid discogs_id' });

    try {
        // Check cache first
        var cached = db.getReleaseDetails(discogsId);
        if (cached) {
            return res.json({ source: 'cache', data: cached });
        }

        // Fetch from Discogs API
        var details = await discogs.fetchReleaseDetails(discogsId);

        // Match tracks to videos
        var artistName = (details.artists && details.artists[0]) ? details.artists[0].name : '';
        details.tracklistWithVideos = discogs.matchTracksToVideos(
            details.tracklist, artistName, details.videos
        );

        // Cache it
        db.saveReleaseDetails(discogsId, details);

        res.json({ source: 'api', data: details });
    } catch (e) {
        console.error('[release] Error fetching ' + discogsId + ': ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

// Price history for a release
app.get('/api/price-history/:discogs_id', function (req, res) {
    var discogsId = parseInt(req.params.discogs_id, 10);
    if (!discogsId || isNaN(discogsId)) return res.status(400).json({ error: 'Invalid discogs_id' });

    var history = db.getPriceHistoryByDiscogsId(discogsId, 90);
    var current = null;

    // Also get current price
    var d = db.getDb();
    var row = d.prepare(`
        SELECT dp.* FROM discogs_prices dp
        JOIN wantlist w ON w.id = dp.wantlist_id
        WHERE w.discogs_id = ?
    `).get(discogsId);

    if (row) {
        current = {
            lowestPrice: row.lowest_price,
            numForSale: row.num_for_sale,
            currency: row.currency,
            checkedAt: row.checked_at
        };
    }

    // Calculate stats
    var stats = null;
    if (history.length > 0) {
        var prices = history.map(function(h) { return h.lowest_price; });
        var minPrice = Math.min.apply(null, prices);
        var maxPrice = Math.max.apply(null, prices);
        var avgPrice = prices.reduce(function(a, b) { return a + b; }, 0) / prices.length;
        var trend = prices.length >= 2 ? (prices[prices.length - 1] - prices[0]) : 0;

        stats = {
            min: minPrice,
            max: maxPrice,
            avg: Math.round(avgPrice * 100) / 100,
            trend: trend > 0 ? 'up' : trend < 0 ? 'down' : 'stable',
            trendAmount: Math.round(Math.abs(trend) * 100) / 100,
            dataPoints: history.length
        };
    }

    res.json({ discogsId: discogsId, current: current, history: history, stats: stats });
});

// Check scan status
app.get('/api/status', function (req, res) {
    res.json({ scanning: Object.keys(scanner.activeScans).length > 0, users: Object.keys(scanner.activeScans) });
});

// Serve the app
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
process.on('SIGINT', function () { db.close(); process.exit(0); });
process.on('SIGTERM', function () { db.close(); process.exit(0); });

// ═══════════════════════════════════════════════════════════════
// CHANGES API (new since last visit)
// ═══════════════════════════════════════════════════════════════

// Get undismissed changes for a user
app.get('/api/changes/:username', function (req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username.trim());
        // Optionally filter by "since" timestamp
        var since = req.query.since || null;
        var changes = db.getUndismissedChanges(user.id, since);
        res.json({ username: req.params.username, changes: changes });
    } catch (e) {
        res.json({ username: req.params.username, changes: [] });
    }
});

// Dismiss changes
app.post('/api/changes/dismiss', function (req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    try {
        var ids = req.body.ids || null; // null = dismiss all
        db.dismissChanges(req.sessionUser.id, ids);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH & ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Health check — background job monitoring + rich analytics
app.get('/api/health', function (req, res) {
    try {
        var d = db.getDb();

        // Users summary
        var users = d.prepare('SELECT id, username, last_full_scan, last_daily_rescan FROM users').all();
        var userSummary = users.map(function (u) {
            var wantlistCount = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id = ? AND active = 1').get(u.id).c;
            var resultCount = d.prepare('SELECT COUNT(DISTINCT wantlist_id) as c FROM store_results WHERE wantlist_id IN (SELECT id FROM wantlist WHERE user_id = ?)').get(u.id).c;
            var inStockCount = d.prepare('SELECT COUNT(*) as c FROM store_results WHERE in_stock = 1 AND wantlist_id IN (SELECT id FROM wantlist WHERE user_id = ? AND active = 1)').get(u.id).c;
            var changeCount = d.prepare('SELECT COUNT(*) as c FROM scan_changes WHERE user_id = ?').get(u.id).c;
            var undismissedChanges = d.prepare('SELECT COUNT(*) as c FROM scan_changes WHERE user_id = ? AND dismissed = 0').get(u.id).c;
            return {
                id: u.id, username: u.username,
                wantlistItems: wantlistCount, checkedItems: resultCount,
                inStockResults: inStockCount, totalChanges: changeCount,
                undismissedChanges: undismissedChanges,
                lastFullScan: u.last_full_scan || null,
                lastDailyRescan: u.last_daily_rescan || null,
                scanAge: u.last_full_scan ? Math.round((Date.now() - new Date(u.last_full_scan).getTime()) / 3600000) + 'h ago' : 'never'
            };
        });

        // Store results breakdown
        var storeStats = d.prepare("SELECT store, COUNT(*) as total, SUM(CASE WHEN in_stock=1 THEN 1 ELSE 0 END) as in_stock, SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) as errors FROM store_results GROUP BY store").all();

        // Most sought tracks (in stock at most stores)
        var mostSought = d.prepare("SELECT w.artist, w.title, w.year, COUNT(DISTINCT sr.store) as store_count FROM store_results sr JOIN wantlist w ON w.id = sr.wantlist_id WHERE sr.in_stock = 1 GROUP BY sr.wantlist_id ORDER BY store_count DESC LIMIT 15").all();

        // Most expensive items (by Discogs price)
        var mostExpensive = d.prepare("SELECT w.artist, w.title, w.year, dp.lowest_price, dp.currency, dp.num_for_sale FROM discogs_prices dp JOIN wantlist w ON w.id = dp.wantlist_id WHERE dp.lowest_price IS NOT NULL ORDER BY dp.lowest_price DESC LIMIT 15").all();

        // Cheapest finds (lowest store price across all matches)
        var cheapestFinds = d.prepare("SELECT w.artist, w.title, sr.store, sr.matches FROM store_results sr JOIN wantlist w ON w.id = sr.wantlist_id WHERE sr.in_stock = 1 AND sr.matches IS NOT NULL ORDER BY sr.wantlist_id LIMIT 500").all();
        var cheapest = [];
        cheapestFinds.forEach(function(r) {
            try {
                var matches = JSON.parse(r.matches || '[]');
                matches.forEach(function(m) {
                    var priceNum = parseFloat((m.price || '').replace(/[^0-9.]/g, ''));
                    if (priceNum && priceNum > 0) {
                        cheapest.push({ artist: r.artist, title: r.title, store: r.store, price: m.price, priceNum: priceNum });
                    }
                });
            } catch(e) {}
        });
        cheapest.sort(function(a, b) { return a.priceNum - b.priceNum; });
        var cheapestItems = cheapest.slice(0, 15);

        // Genre counts
        var allGenres = {};
        var allStyles = {};
        var yearCounts = {};
        var allWantlist = d.prepare("SELECT genres, styles, year FROM wantlist WHERE active = 1").all();
        allWantlist.forEach(function(w) {
            if (w.genres) w.genres.split(', ').forEach(function(g) { if (g) allGenres[g] = (allGenres[g] || 0) + 1; });
            if (w.styles) w.styles.split(', ').forEach(function(s) { if (s) allStyles[s] = (allStyles[s] || 0) + 1; });
            if (w.year) yearCounts[w.year] = (yearCounts[w.year] || 0) + 1;
        });

        // Sort and limit
        var genreList = Object.keys(allGenres).map(function(g) { return { name: g, count: allGenres[g] }; }).sort(function(a,b) { return b.count - a.count; });
        var styleList = Object.keys(allStyles).map(function(s) { return { name: s, count: allStyles[s] }; }).sort(function(a,b) { return b.count - a.count; }).slice(0, 25);
        var yearList = Object.keys(yearCounts).map(function(y) { return { year: parseInt(y), count: yearCounts[y] }; }).filter(function(y) { return y.year > 1900; }).sort(function(a,b) { return a.year - b.year; });

        // Average Discogs price
        var avgPrice = d.prepare("SELECT AVG(lowest_price) as avg, MIN(lowest_price) as min, MAX(lowest_price) as max, COUNT(*) as cnt FROM discogs_prices WHERE lowest_price IS NOT NULL AND lowest_price > 0").get();

        // Active scans & job health
        var activeScanInfo = scanner.getActiveScans ? scanner.getActiveScans() : {};
        var jobHealthData = scanner.getJobHealth ? scanner.getJobHealth() : {};

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.round(process.uptime()) + 's',
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            users: userSummary,
            storeStats: storeStats,
            mostSought: mostSought,
            mostExpensive: mostExpensive,
            cheapestFinds: cheapestItems,
            genres: genreList,
            styles: styleList,
            years: yearList,
            priceStats: avgPrice,
            activeScans: activeScanInfo,
            jobHealth: jobHealthData,
            workers: 3
        });
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// Admin dashboard — HTML page
app.get('/admin', function (req, res) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Clean up dead/empty user accounts
app.post('/api/admin/cleanup', function (req, res) {
    try {
        var d = db.getDb();
        // Find users with no scan history
        var deadUsers = d.prepare('SELECT id, username FROM users WHERE last_full_scan IS NULL').all();
        var removed = [];
        deadUsers.forEach(function (u) {
            var wantlistCount = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id = ?').get(u.id).c;
            if (wantlistCount === 0) {
                // Clean up any related records first
                d.prepare('DELETE FROM discogs_prices WHERE wantlist_id IN (SELECT id FROM wantlist WHERE user_id = ?)').run(u.id);
                d.prepare('DELETE FROM store_results WHERE wantlist_id IN (SELECT id FROM wantlist WHERE user_id = ?)').run(u.id);
                d.prepare('DELETE FROM scan_changes WHERE user_id = ?').run(u.id);
                d.prepare('DELETE FROM wantlist WHERE user_id = ?').run(u.id);
                d.prepare('DELETE FROM users WHERE id = ?').run(u.id);
                removed.push(u.username);
            }
        });
        res.json({ ok: true, removed: removed, message: removed.length + ' dead accounts removed' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// BACKGROUND SYNC
// ═══════════════════════════════════════════════════════════════

var SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL) || (60 * 60 * 1000); // default 1 hour
var DAILY_CHECK_INTERVAL = 15 * 60 * 1000; // Check every 15 min if any user needs daily rescan
var NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || '';

app.listen(PORT, function () {
    console.log('\n\u2728 Vinyl Checker running at http://localhost:' + PORT + '\n');

    // Background sync (incremental — new items only)
    console.log('[sync] Background sync every ' + (SYNC_INTERVAL / 60000).toFixed(0) + ' minutes');
    if (NOTIFICATION_WEBHOOK) console.log('[sync] Notifications enabled (webhook)');
    setInterval(function () {
        scanner.backgroundSync()
            .then(function() { scanner.trackJobRun('sync', true); })
            .catch(function (e) { console.error('[sync] Fatal:', e.message); scanner.trackJobRun('sync', false, e.message); });
    }, SYNC_INTERVAL);

    // Daily full rescan scheduler — checks every 15 min if any user is due
    console.log('[daily] Daily rescan checker every 15 minutes');
    setInterval(function () {
        scanner.dailyFullRescan()
            .then(function() { scanner.trackJobRun('daily', true); })
            .catch(function (e) { console.error('[daily] Fatal:', e.message); scanner.trackJobRun('daily', false, e.message); });
    }, DAILY_CHECK_INTERVAL);

    // Also run daily check once on startup (after 2 min delay to let things settle)
    setTimeout(function () {
        scanner.dailyFullRescan()
            .then(function() { scanner.trackJobRun('daily', true); })
            .catch(function (e) { console.error('[daily] Startup check fatal:', e.message); scanner.trackJobRun('daily', false, e.message); });
    }, 120000);
});
