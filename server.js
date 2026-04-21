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

// Load .env if present (local dev)
try { require('dotenv').config(); } catch(e) {}

const express = require('express');
const db = require('./db');
const discogs = require('./lib/discogs');
const scanner = require('./lib/scanner');
const oauth = require('./lib/oauth');

// Catalog-sync stores: registry of stores whose full inventory we mirror locally
// (rather than scraping per-item). Add a new store by adding its module here.
const STORE_SYNCERS = {
    gramaphone: function () {
        var m = require('./lib/stores/gramaphone');
        return { name: m.STORE_NAME, sync: m.syncGramaphone };
    },
    uvs: function () {
        var m = require('./lib/stores/uvs');
        return { name: m.STORE_NAME, sync: m.syncUVS };
    },
    further: function () {
        var m = require('./lib/stores/further');
        return { name: m.STORE_NAME, sync: m.syncFurther };
    },
    octopus: function () {
        var m = require('./lib/stores/octopus');
        return { name: m.STORE_NAME, sync: m.syncOctopus };
    },
    hardwax: function () {
        var m = require('./lib/stores/hardwax');
        return { name: m.STORE_NAME, sync: m.syncHardwax };
    },
};
const SYNC_STALE_AFTER_MS = 20 * 60 * 60 * 1000; // re-sync if last run was 20+ hours ago

// Prevent unhandled errors from crashing the server.
// EXCEPTION: EADDRINUSE means the port is already taken — exit so PM2 can restart us
// rather than letting the process run silently without serving any HTTP traffic.
process.on('uncaughtException', function (e) {
    if (e.code === 'EADDRINUSE') {
        console.error('[FATAL] Port already in use — exiting so PM2 can retry:', e.message);
        process.exit(1);
    }
    console.error('Uncaught:', e.message);
});
process.on('unhandledRejection', function (e) { console.error('Unhandled:', e && e.message); });

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));
// Parse JSON bodies, capturing raw body for GitHub webhook HMAC verification
app.use(express.json({
    limit: '20mb',
    verify: function (req, res, buf) { req.rawBody = buf.toString(); }
}));

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

// ─── Collection sync + retrieval ─────────────────────────────────────────────
app.get('/api/collection/:username', async function (req, res) {
    var username = (req.params.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required' });

    var user = db.getOrCreateUser(username);
    var forceRefresh = req.query.refresh === '1';

    // Return cached collection unless force-refresh requested
    if (!forceRefresh) {
        var cached = db.getCollection(user.id);
        if (cached && cached.length > 0) {
            var stats = db.getCollectionStats(user.id);
            return res.json({ source: 'cache', total: cached.length, stats: stats, items: cached });
        }
    }

    // Fetch fresh from Discogs
    try {
        var oauthToken = db.getOAuthToken(user.id, 'discogs');
        var headersFn  = null;
        if (oauthToken && oauthToken.access_token && oauthToken.access_secret) {
            var oauthLib = require('./lib/oauth');
            headersFn = function (method, path) {
                var url = 'https://api.discogs.com' + path;
                return {
                    'User-Agent': 'VinylWantlistChecker/1.0',
                    'Authorization': oauthLib.discogsAuthHeader(method, url, oauthToken.access_token, oauthToken.access_secret)
                };
            };
        }
        var items = await discogs.fetchCollection(username, headersFn);
        db.syncCollectionItems(user.id, items);
        var stats2 = db.getCollectionStats(user.id);
        res.json({ source: 'fresh', total: items.length, stats: stats2, items: db.getCollection(user.id) });
    } catch (e) {
        console.error('[collection] Error for', username, ':', e.message);
        // Fall back to cache even if stale
        var stale = db.getCollection(user.id);
        if (stale && stale.length > 0) {
            return res.json({ source: 'stale', total: stale.length, items: stale, error: e.message });
        }
        res.status(500).json({ error: e.message });
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

// Full history for a release (store stock + Discogs price)
app.get('/api/history/:discogs_id', function (req, res) {
    var discogsId = parseInt(req.params.discogs_id, 10);
    if (!discogsId || isNaN(discogsId)) return res.status(400).json({ error: 'Invalid discogs_id' });

    var d = db.getDb();
    var w = d.prepare('SELECT id FROM wantlist WHERE discogs_id = ? LIMIT 1').get(discogsId);
    if (!w) return res.json({ stores: [], discogs: [] });

    var days = parseInt(req.query.days, 10) || 90;
    var history = db.getItemHistory(w.id, days);
    res.json(history);
});

// ═══════════════════════════════════════════════════════════
// OPTIMIZER API
// ═══════════════════════════════════════════════════════════

// GET /api/preferences/:username — fetch saved preferences
app.get('/api/preferences/:username', function (req, res) {
    var user = db.getOrCreateUser(req.params.username);
    var prefs = db.getUserPreferences(user.id);
    res.json(prefs || {});
});

// POST /api/preferences/:username — save preferences
app.post('/api/preferences/:username', function (req, res) {
    var user = db.getOrCreateUser(req.params.username);
    var saved = db.saveUserPreferences(user.id, {
        countryCode: req.body.countryCode,
        postcode: req.body.postcode,
        minCondition: req.body.minCondition || 'VG+',
        minSellerRating: req.body.minSellerRating != null ? parseFloat(req.body.minSellerRating) : 98.0,
        maxPriceUsd: req.body.maxPriceUsd ? parseFloat(req.body.maxPriceUsd) : null,
        currency: req.body.currency || 'USD'
    });
    res.json(saved);
});

// ─── Cart Optimizer — queue-based ────────────────────────────────────────────
// POST /api/optimize/:username  — submit a job (or return existing pending job)
// GET  /api/optimize/job/:jobId — poll status, progress, result
//
// The worker (lib/optimizer-worker.js) processes jobs sequentially in the
// background.  Clients poll every 2–3 s and receive real-time progress updates
// written to the DB by the worker.

app.post('/api/optimize/:username', function (req, res) {
    var username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: 'Username required' });

    var user = db.getOrCreateUser(username);
    var savedPrefs = db.getUserPreferences(user.id) || {};
    var body = req.body || {};

    var params = {
        postcode:        body.postcode        || savedPrefs.postcode        || '',
        countryCode:     body.countryCode     || savedPrefs.country_code    || '',
        minCondition:    body.minCondition    || savedPrefs.min_condition   || 'VG',
        minSellerRating: body.minSellerRating != null ? body.minSellerRating : (savedPrefs.min_seller_rating || 98),
        maxPriceUsd:     body.maxPriceUsd     != null ? body.maxPriceUsd    : (savedPrefs.max_price_usd     || null),
        forceRefresh:    body.forceRefresh    === true
    };

    var r = db.createOptimizerJob(username, user.id, params);
    res.json({
        jobId:         r.job.id,
        status:        r.job.status,
        queuePosition: r.queuePosition,
        reused:        r.reused
    });
});

app.get('/api/optimize/job/:jobId', function (req, res) {
    var jobId = parseInt(req.params.jobId, 10);
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: 'Invalid jobId' });

    var job = db.getOptimizerJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    var response = {
        jobId:    job.id,
        username: job.username,
        status:   job.status,  // pending | processing | done | failed
        createdAt:   job.created_at,
        startedAt:   job.started_at,
        completedAt: job.completed_at
    };

    if (job.status === 'pending') {
        response.queuePosition = db.getQueuePosition(job.id);
    }

    if (job.status === 'processing' && job.progress) {
        try { response.progress = JSON.parse(job.progress); } catch(e) {}
    }

    if (job.status === 'done' && job.result) {
        try { response.result = JSON.parse(job.result); } catch(e) {
            response.status = 'failed';
            response.error  = 'Result parse error';
        }
    }

    if (job.status === 'failed') {
        response.error = job.error;
    }

    res.json(response);
});

// GET /api/optimize/latest/:username — return last completed result (within 24h)
// Used by the client to restore results without re-running.
app.get('/api/optimize/latest/:username', function (req, res) {
    var username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: 'Username required' });
    var job = db.getLatestCompletedOptimization(username, 24);
    if (!job || !job.result) return res.json({ found: false });
    try {
        var result = JSON.parse(job.result);
        res.json({ found: true, jobId: job.id, completedAt: job.completed_at, result: result });
    } catch (e) {
        res.json({ found: false });
    }
});

// ─── Taste-based recommendations ─────────────────────────────────────────────
app.get('/api/recommend/:username', function (req, res) {
    var username = (req.params.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required' });
    try {
        var rec = require('./lib/recommendations');
        var limit = Math.min(parseInt(req.query.limit) || 30, 60);
        var result = rec.getRecommendations(username, limit);
        res.json(result);
    } catch (e) {
        console.error('[recommend] Error for', username, ':', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// Verify a single store result (user-triggered validation)
app.post('/api/verify', async function (req, res) {
    var store = req.body.store;
    var searchUrl = req.body.searchUrl;
    var artist = req.body.artist;
    var title = req.body.title;
    var discogsId = req.body.discogsId;
    if (!store || !searchUrl || !artist) return res.status(400).json({ error: 'Missing params' });

    try {
        var item = { artist: artist, title: title, searchQuery: (artist + ' ' + title).trim() };
        var result = await scanner.verifySingleStore(store, searchUrl, item);
        // If the verify shows it's NOT in stock, update DB
        if (discogsId && !result.verdict) {
            var d = db.getDb();
            var w = d.prepare('SELECT id FROM wantlist WHERE discogs_id = ? LIMIT 1').get(parseInt(discogsId, 10));
            if (w) {
                d.prepare('UPDATE store_results SET in_stock = 0, matches = ?, checked_at = ? WHERE wantlist_id = ? AND store = ?')
                    .run('[]', new Date().toISOString(), w.id, store);
            }
        }
        res.json(result);
    } catch (e) {
        res.json({ error: e.message, verdict: null, steps: {} });
    }
});

// Check scan status
app.get('/api/status', function (req, res) {
    res.json({ scanning: Object.keys(scanner.activeScans).length > 0, users: Object.keys(scanner.activeScans) });
});

// Job health — shows last run times and counts for daily/validate/sync jobs
app.get('/api/job-health', function (req, res) {
    var health = scanner.getJobHealth ? scanner.getJobHealth() : {};
    var d = db.getDb();
    var users = d.prepare('SELECT username, last_full_scan, last_daily_rescan FROM users WHERE username != ?').all('testuser');
    res.json({ jobs: health, users: users, serverUptime: process.uptime(), now: new Date().toISOString() });
});

// Cron trigger — allows a system cron job to kick off daily rescan + validation
// Protected by a simple secret token so it's not publicly abusable
app.post('/api/trigger', function (req, res) {
    var secret = process.env.CRON_SECRET || '';
    var token = req.headers['x-cron-secret'] || req.query.secret || '';
    if (!secret || token !== secret) return res.status(401).json({ error: 'unauthorized' });

    var job = req.query.job || 'daily';
    if (job === 'daily') {
        scanner.dailyFullRescan()
            .then(function () { scanner.trackJobRun('daily', true); })
            .catch(function (e) { scanner.trackJobRun('daily', false, e.message); });
        res.json({ triggered: 'daily', at: new Date().toISOString() });
    } else if (job === 'validate') {
        scanner.validateInStockResults()
            .then(function () { scanner.trackJobRun('validate', true); })
            .catch(function (e) { scanner.trackJobRun('validate', false, e.message); });
        res.json({ triggered: 'validate', at: new Date().toISOString() });
    } else if (job === 'all') {
        scanner.dailyFullRescan()
            .then(function () { scanner.trackJobRun('daily', true); })
            .catch(function (e) { scanner.trackJobRun('daily', false, e.message); });
        setTimeout(function () {
            scanner.validateInStockResults()
                .then(function () { scanner.trackJobRun('validate', true); })
                .catch(function (e) { scanner.trackJobRun('validate', false, e.message); });
        }, 5 * 60 * 1000); // validate 5 min after daily starts
        res.json({ triggered: 'daily+validate', at: new Date().toISOString() });
    } else {
        res.status(400).json({ error: 'unknown job, use: daily, validate, all' });
    }
});

// Trigger a one-off catalog sync for a single store. Same auth as /api/trigger.
//   POST /api/admin/sync-store?secret=...&store=gramaphone
//   POST /api/admin/sync-store?secret=...&store=further
//   POST /api/admin/sync-store?secret=...&store=octopus
app.post('/api/admin/sync-store', function (req, res) {
    var secret = process.env.CRON_SECRET || '';
    var token = req.headers['x-cron-secret'] || req.query.secret || '';
    if (!secret || token !== secret) return res.status(401).json({ error: 'unauthorized' });

    var storeKey = (req.query.store || (req.body && req.body.store) || '').toLowerCase();
    var loader = STORE_SYNCERS[storeKey];
    if (!loader) {
        return res.status(400).json({
            error: 'unknown store',
            available: Object.keys(STORE_SYNCERS)
        });
    }

    var store = loader();
    res.json({ triggered: 'sync-store', store: storeKey, at: new Date().toISOString() });

    store.sync({
        onProgress: function (p) {
            if (p.phase === 'fetch') console.log('[sync-store:' + storeKey + '] page ' + p.page + ' (+' + p.count + ', ' + p.total + ' total)');
            else if (p.phase === 'done') console.log('[sync-store:' + storeKey + '] done', p.stats);
        }
    })
    .then(function () { scanner.trackJobRun && scanner.trackJobRun('sync-store-' + storeKey, true); })
    .catch(function (e) {
        console.error('[sync-store:' + storeKey + '] failed:', e.message);
        scanner.trackJobRun && scanner.trackJobRun('sync-store-' + storeKey, false, e.message);
    });
});

// Run any catalog syncs that are stale. Called from the daily-rescan interval.
// Runs catalog store syncs one at a time (sequential, not parallel) to avoid
// triggering Shopify's IP-level rate limiter when multiple stores are fetched
// simultaneously. A 5-second gap between stores gives the CDN time to breathe.
async function syncStaleStores() {
    var keys = Object.keys(STORE_SYNCERS);
    var syncedAny = false;
    for (var i = 0; i < keys.length; i++) {
        var storeKey = keys[i];
        var last = db.getLastStoreSync(storeKey);
        var stale = !last || !last.finished_at ||
            (Date.now() - new Date(last.finished_at).getTime()) > SYNC_STALE_AFTER_MS;
        if (!stale) continue;

        // Gap between stores so we don't hammer Shopify's CDN back-to-back.
        if (syncedAny) await new Promise(function (r) { setTimeout(r, 5000); });
        syncedAny = true;

        var loader = STORE_SYNCERS[storeKey];
        var store = loader();
        console.log('[sync-store:' + storeKey + '] auto-sync starting (last=' + (last ? last.finished_at : 'never') + ')');
        try {
            await store.sync({
                onProgress: function (p) {
                    if (p.phase === 'done') console.log('[sync-store:' + storeKey + '] auto-sync done', p.stats);
                }
            });
            scanner.trackJobRun && scanner.trackJobRun('sync-store-' + storeKey, true);
        } catch (e) {
            console.error('[sync-store:' + storeKey + '] auto-sync failed:', e.message);
            scanner.trackJobRun && scanner.trackJobRun('sync-store-' + storeKey, false, e.message);
        }
    }
}

// GitHub webhook — auto-deploy on push to master
// Set GITHUB_WEBHOOK_SECRET in ecosystem.config.js env, then add webhook in GitHub repo settings
// Payload URL: https://stream.ronautradio.la/vinyl/api/deploy
// Content type: application/json, Secret: same as GITHUB_WEBHOOK_SECRET
app.post('/api/deploy', function (req, res) {
    var crypto = require('crypto');
    var { execSync } = require('child_process');
    var secret = process.env.GITHUB_WEBHOOK_SECRET || '';

    // Verify GitHub HMAC signature
    if (secret) {
        var sig = req.headers['x-hub-signature-256'] || '';
        var expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
        if (sig !== expected) {
            console.log('[deploy] Webhook signature mismatch — rejected');
            return res.status(401).json({ error: 'invalid signature' });
        }
    }

    var payload = req.body || {};
    var branch = (payload.ref || '').replace('refs/heads/', '');
    if (branch && branch !== 'master') {
        console.log('[deploy] Push to branch "' + branch + '" — skipping (only deploy master)');
        return res.json({ skipped: true, reason: 'not master branch' });
    }

    var pusher = payload.pusher ? payload.pusher.name : 'unknown';
    var commits = payload.commits ? payload.commits.length : 0;
    console.log('[deploy] GitHub push from ' + pusher + ' (' + commits + ' commit(s)) — pulling...');

    res.json({ ok: true, deploying: true, pusher: pusher, commits: commits });

    // Run git pull + pm2 reload in background (after response sent)
    setTimeout(function () {
        try {
            var appDir = __dirname;
            var pullOut = execSync('cd ' + appDir + ' && git pull origin master 2>&1').toString().trim();
            console.log('[deploy] git pull: ' + pullOut);
            if (pullOut.indexOf('Already up to date') !== -1) {
                console.log('[deploy] Nothing new to deploy');
                return;
            }
            // Reinstall deps if package.json changed
            if (pullOut.indexOf('package.json') !== -1) {
                console.log('[deploy] package.json changed — running npm install');
                execSync('cd ' + appDir + ' && npm install --production 2>&1');
            }
            // Reload PM2 via a detached child process — calling pm2 reload from within
            // the process being reloaded causes SIGTERM mid-execSync. Detached spawn
            // lets the child outlive the current process cleanly.
            console.log('[deploy] Reloading via PM2...');
            var child = require('child_process').spawn('pm2', ['reload', 'vinyl-checker', '--update-env'], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
        } catch (e) {
            console.error('[deploy] ERROR: ' + e.message);
        }
    }, 100);
});

// Scan status for a specific user (used by resume UI)
app.get('/api/scan-status/:username', function (req, res) {
    var username = req.params.username.trim();
    res.json(scanner.getScanStatus(username));
});

// Serve the app
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Shareable wantlist page — redirect to ?share= so relative paths work
app.get('/u/:username', function (req, res) {
    res.redirect('/?share=' + encodeURIComponent(req.params.username));
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

// ─── Discogs Listings count (for optimizer panel status) ─────────────────────
app.get('/api/discogs-listings-count/:username', function (req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username);
        if (!user) return res.json({ count: 0 });
        var listings = db.getDiscogsListings(user.id);
        res.json({ count: listings.length });
    } catch (e) {
        res.json({ count: 0 });
    }
});

// ─── Discogs Listings (from Chrome extension) ────────────────────────────────
app.post('/api/discogs-listings/:username', function (req, res) {
    try {
        var username = req.params.username;
        var user = db.getOrCreateUser(username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        var listings = req.body.listings || [];
        if (!listings.length) return res.status(400).json({ error: 'No listings provided' });

        // Group by wantlistId and save
        var byWantlist = {};
        listings.forEach(function (l) {
            if (!l.wantlistId) return;
            if (!byWantlist[l.wantlistId]) byWantlist[l.wantlistId] = [];
            byWantlist[l.wantlistId].push(l);
        });

        var saved = 0;
        var marketplace = require('./lib/discogs-marketplace');
        Object.keys(byWantlist).forEach(function (wid) {
            var rows = byWantlist[wid].map(function (l) {
                return {
                    listingId:        l.listingId || null,
                    sellerUsername:   l.sellerUsername || '',
                    sellerRating:     l.sellerRating || null,
                    sellerNumRatings: l.sellerNumRatings || null,
                    priceOriginal:    l.priceOriginal || null,
                    currency:         l.currency || 'USD',
                    priceUsd:         marketplace.toUSD(l.priceOriginal || 0, l.currency || 'USD'),
                    condition:        l.condition || '',
                    shipsFrom:        marketplace.countryToISO(l.shipsFrom || ''),
                    listingUrl:       l.listingUrl || ''
                };
            });
            db.saveDiscogsListings(parseInt(wid), rows);
            saved += rows.length;
        });

        res.json({ saved: saved, wantlistItems: Object.keys(byWantlist).length });
    } catch (e) {
        console.error('[discogs-listings] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Discogs Marketplace Sync ─────────────────────────────────────────────────

// In-memory sync state per username
var marketplaceSyncState = {};

app.post('/api/marketplace-sync/:username', async function (req, res) {
    var username = req.params.username;
    var user = db.getOrCreateUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Already running?
    if (marketplaceSyncState[username] && marketplaceSyncState[username].running) {
        return res.json({ started: false, message: 'Sync already in progress' });
    }

    // Get OAuth token
    var oauthToken = db.getOAuthToken(user.id, 'discogs');
    if (!oauthToken || !oauthToken.access_token) {
        return res.status(403).json({ error: 'No Discogs OAuth token — please reconnect Discogs' });
    }

    var wantlistItems = db.getActiveWantlist(user.id);
    var total = wantlistItems.filter(function (w) { return w.discogs_id; }).length;

    marketplaceSyncState[username] = { running: true, done: 0, total: total, errors: 0, startedAt: Date.now() };
    res.json({ started: true, total: total });

    // Run sync in background
    var discogsMarketplace = require('./lib/discogs-marketplace');
    var oauthLib = require('./lib/oauth');
    var authHeaderFn = function (method, url) {
        return oauthLib.discogsAuthHeader(method, url, oauthToken.access_token, oauthToken.access_secret);
    };

    try {
        await discogsMarketplace.syncMarketplace(wantlistItems, authHeaderFn, db, function (done, total, item) {
            marketplaceSyncState[username].done = done;
            marketplaceSyncState[username].total = total;
        });
        marketplaceSyncState[username].running = false;
        marketplaceSyncState[username].completedAt = Date.now();
    } catch (e) {
        console.error('[marketplace-sync] error for', username, ':', e.message);
        marketplaceSyncState[username].running = false;
        marketplaceSyncState[username].error = e.message;
    }
});

app.get('/api/marketplace-sync/:username/status', function (req, res) {
    var username = req.params.username;
    var state = marketplaceSyncState[username];
    if (!state) return res.json({ running: false, done: 0, total: 0 });
    res.json(state);
});

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
        var validationData = scanner.getValidationStats ? scanner.getValidationStats() : {};

        // ── Observability (persisted) ──────────────────────────────
        // Recent scan runs (all users, last 10)
        var recentScanRuns = [];
        try {
            recentScanRuns = d.prepare(
                'SELECT sr.*, u.username FROM scan_runs sr JOIN users u ON u.id = sr.user_id ORDER BY sr.started_at DESC LIMIT 10'
            ).all();
        } catch(e) {}

        // Error rate per store (last 7 days)
        var scraperErrorStats = db.getScraperErrorStats(7);

        // Cumulative accuracy per store
        var storeAccuracy = db.getStoreAccuracy();

        // Last 5 validator runs
        var validatorHistory = db.getValidatorRunHistory(5);

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
            validation: validationData,
            // Persisted observability
            recentScanRuns: recentScanRuns,
            scraperErrorStats: scraperErrorStats,
            storeAccuracy: storeAccuracy,
            validatorHistory: validatorHistory,
            workers: scanner.NUM_WORKERS || 5
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
var DAILY_CHECK_INTERVAL = 60 * 60 * 1000; // Check every 1 hour if any user needs daily rescan
var NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || '';

app.listen(PORT, function () {
    console.log('\n\u2728 Vinyl Checker running at http://localhost:' + PORT + '\n');

    // Cart optimizer job queue worker
    var optimizerWorker = require('./lib/optimizer-worker');
    optimizerWorker.start();

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
        // Piggyback on the same cadence to refresh any stale catalog mirrors.
        syncStaleStores();
    }, DAILY_CHECK_INTERVAL);

    // Also run daily check once on startup (after 2 min delay to let things settle)
    setTimeout(function () {
        scanner.dailyFullRescan()
            .then(function() { scanner.trackJobRun('daily', true); })
            .catch(function (e) { console.error('[daily] Startup check fatal:', e.message); scanner.trackJobRun('daily', false, e.message); });
        syncStaleStores();
    }, 120000);

    // Stock validation — re-checks "in stock" items to catch false positives
    var VALIDATE_INTERVAL = parseInt(process.env.VALIDATE_INTERVAL) || 4 * 60 * 60 * 1000; // 4 hours
    console.log('[validate] Stock validation every ' + (VALIDATE_INTERVAL / 3600000).toFixed(1) + ' hours');
    setInterval(function () {
        scanner.validateInStockResults()
            .then(function() { scanner.trackJobRun('validate', true); })
            .catch(function (e) { console.error('[validate] Fatal:', e.message); scanner.trackJobRun('validate', false, e.message); });
    }, VALIDATE_INTERVAL);

    // Run first validation 5 min after startup
    setTimeout(function () {
        scanner.validateInStockResults()
            .then(function() { scanner.trackJobRun('validate', true); })
            .catch(function (e) { console.error('[validate] Startup validation fatal:', e.message); scanner.trackJobRun('validate', false, e.message); });
    }, 300000);
});
