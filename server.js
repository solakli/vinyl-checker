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
const shippingLib = require('./lib/shipping-rates');

// Shipping origin country per store (for discover cost estimates)
var STORE_COUNTRIES = {
    'HHV': 'DE', 'Deejay.de': 'DE', 'Hardwax': 'DE', 'Decks.de': 'DE',
    'Juno': 'GB', 'Phonica': 'GB',
    'Yoyaku': 'JP',
    'Turntable Lab': 'US', 'Underground Vinyl': 'US',
    'Gramaphone': 'US', 'Further Records': 'US', 'Octopus Records NYC': 'US',
};

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

        // Redirect back to app immediately — don't wait for collection sync
        res.redirect(APP_BASE + '/?auth=discogs&username=' + encodeURIComponent(identity.username));

        // Auto-fetch collection in background now that we have a valid OAuth token
        var _authHeaderFn = function(method, url) {
            return {
                'Authorization': require('./lib/oauth').discogsAuthHeader(method, url, tokens.accessToken, tokens.accessSecret)
            };
        };
        discogs.fetchCollection(identity.username, _authHeaderFn).then(function(items) {
            db.syncCollectionItems(user.id, items);
            console.log('[oauth] Auto-synced collection for', identity.username, '—', items.length, 'items');
        }).catch(function(e) {
            console.warn('[oauth] Collection auto-sync failed for', identity.username, ':', e.message);
        });
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

        // Background: ingest YouTube liked videos + subscriptions for recommender seeds
        var ytIngest = require('./lib/youtube-ingest');
        var _ytUserId   = req.sessionUser.id;
        var _ytUsername = req.sessionUser.username;
        ytIngest.ingestAll(tokens.accessToken).then(function(result) {
            db.saveOAuthToken(_ytUserId, 'google', {
                accessToken:      tokens.accessToken,
                refreshToken:     tokens.refreshToken,
                expiresAt:        new Date(tokens.expiresAt).toISOString(),
                providerUsername: JSON.stringify({ counts: result.counts, artists: (result.allArtists || []).slice(0, 300) })
            });
            console.log('[youtube-ingest] Ingested', result.counts, 'for', _ytUsername);
        }).catch(function(e) { console.warn('[youtube-ingest] Error:', e.message); });
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

// ─── SOUNDCLOUD OAUTH ──────────────────────────────────────────────────────

app.get('/api/auth/soundcloud', function(req, res) {
    if (!oauth.soundcloudEnabled()) return res.status(503).json({ error: 'SoundCloud OAuth not configured — add SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET to .env' });
    if (!req.sessionUser) return res.status(401).json({ error: 'Login first' });
    var state = (req.cookies['vinyl_session'] || '') + '|' + req.sessionUser.username;
    res.redirect(oauth.soundcloudAuthorizeUrl(state));
});

app.get('/api/auth/soundcloud/callback', async function(req, res) {
    var code  = req.query.code;
    var state = req.query.state || '';
    var error = req.query.error;
    if (error || !code) return res.redirect(APP_BASE + '/?auth_error=soundcloud_denied');
    try {
        var tokens = await oauth.soundcloudExchangeCode(code, state);

        var user = req.sessionUser;
        if (!user) {
            var stateParts   = state.split('|');
            var stateUsername = stateParts[1] || '';
            if (stateUsername) {
                user = db.getOrCreateUser(stateUsername);
                var newTok = db.createSession(user.id);
                res.cookie('vinyl_session', newTok, { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
            }
        }
        if (!user) return res.redirect(APP_BASE + '/?auth_error=no_session');

        db.saveOAuthToken(user.id, 'soundcloud', {
            accessToken:  tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            expiresAt:    tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null
        });

        res.redirect(APP_BASE + '/?auth=soundcloud');

        // Background ingest: liked tracks, following, tracklist artists → recommender seeds
        var soundcloud  = require('./lib/soundcloud');
        var _scUserId   = user.id;
        var _scUsername = user.username;
        soundcloud.ingestAll(tokens.accessToken).then(function(result) {
            db.saveOAuthToken(_scUserId, 'soundcloud', {
                accessToken:      tokens.accessToken,
                refreshToken:     tokens.refreshToken || null,
                expiresAt:        tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
                providerUsername: JSON.stringify({ counts: result.counts, weightedArtists: result.weightedArtists || [] })
            });
            console.log('[soundcloud] Ingested', result.counts, 'for', _scUsername);
        }).catch(function(e) { console.warn('[soundcloud] Ingest error:', e.message); });
    } catch(e) {
        console.error('[auth] SoundCloud callback error:', e.message);
        res.redirect(APP_BASE + '/?auth_error=' + encodeURIComponent(e.message));
    }
});

app.post('/api/auth/soundcloud/disconnect', function(req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    db.deleteOAuthToken(req.sessionUser.id, 'soundcloud');
    res.json({ ok: true });
});

// Manual re-ingest
app.post('/api/soundcloud/ingest', async function(req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    var scToken = db.getOAuthToken(req.sessionUser.id, 'soundcloud');
    if (!scToken) return res.status(400).json({ error: 'SoundCloud not connected' });
    try {
        var soundcloud = require('./lib/soundcloud');
        var result = await soundcloud.ingestAll(scToken.access_token);
        db.saveOAuthToken(req.sessionUser.id, 'soundcloud', {
            accessToken:      scToken.access_token,
            refreshToken:     scToken.refresh_token || null,
            expiresAt:        scToken.expires_at || null,
            providerUsername: JSON.stringify({ counts: result.counts, weightedArtists: result.weightedArtists || [] })
        });
        res.json({ ok: true, counts: result.counts });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/soundcloud/status', function(req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    var scToken = db.getOAuthToken(req.sessionUser.id, 'soundcloud');
    if (!scToken) return res.json({ connected: false });
    try {
        var data = JSON.parse(scToken.provider_username || '{}');
        res.json({ connected: true, counts: data.counts || null, artistCount: (data.weightedArtists || []).length });
    } catch(e) { res.json({ connected: true }); }
});

// ─── YOUTUBE PERSONAL INGEST (liked videos + subscriptions) ──────────────

app.post('/api/youtube/ingest', async function(req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    var gToken = db.getOAuthToken(req.sessionUser.id, 'google');
    if (!gToken) return res.status(400).json({ error: 'YouTube not connected' });
    try {
        var accessToken = gToken.access_token;
        if (gToken.expires_at && new Date(gToken.expires_at) < new Date()) {
            if (!gToken.refresh_token) return res.status(401).json({ error: 'Token expired — reconnect YouTube' });
            var refreshed = await oauth.googleRefreshToken(gToken.refresh_token);
            db.saveOAuthToken(req.sessionUser.id, 'google', { accessToken: refreshed.accessToken, expiresAt: new Date(refreshed.expiresAt).toISOString() });
            accessToken = refreshed.accessToken;
        }
        var ytIngest = require('./lib/youtube-ingest');
        var result = await ytIngest.ingestAll(accessToken);
        db.saveOAuthToken(req.sessionUser.id, 'google', {
            accessToken:      accessToken,
            providerUsername: JSON.stringify({ counts: result.counts, artists: (result.allArtists || []).slice(0, 300) })
        });
        res.json({ ok: true, counts: result.counts });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/status', async function(req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    var gToken = db.getOAuthToken(req.sessionUser.id, 'google');
    if (!gToken) return res.json({ connected: false });
    try {
        var data = JSON.parse(gToken.provider_username || '{}');
        res.json({ connected: true, counts: data.counts || null, artistCount: (data.artists || []).length });
    } catch(e) { res.json({ connected: true }); }
});

// ─── DISCOVERY — Last.fm-powered recommendations from wantlist + streaming seeds ──

app.get('/api/discovery/:username', async function(req, res) {
    try {
        var username = req.params.username.trim();
        var d = db.getDb();
        var recommender = require('./lib/recommender');
        var result = await recommender.recommend(username, d, {
            seedLimit:      parseInt(req.query.seeds)   || 30,
            similarPerSeed: parseInt(req.query.similar) || 8,
            resultLimit:    parseInt(req.query.limit)   || 40
        });
        res.json(result);
    } catch(e) {
        console.error('[discovery]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── MIX TO CART ──────────────────────────────────────────────────────────────

// Resolve a SoundCloud / YouTube / Mixcloud URL → tracklist waterfall
app.post('/api/mix-to-cart/resolve', async function(req, res) {
    if (!req.sessionUser) return res.status(401).json({ error: 'Not logged in' });
    var url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
        var scToken = db.getOAuthToken(req.sessionUser.id, 'soundcloud');
        var gToken  = db.getOAuthToken(req.sessionUser.id, 'google');
        var tokens  = {
            soundcloud: scToken ? scToken.access_token : null,
            youtube:    gToken  ? gToken.access_token  : null,
            youtubeApiKey: process.env.YOUTUBE_API_KEY || null,
        };
        var mixResolver = require('./lib/mix-resolver');
        var result = await mixResolver.resolveMixUrl(url, tokens);
        res.json(result);
    } catch(e) {
        console.error('[mix-to-cart] resolve error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Cross-reference parsed artists against store inventory
app.post('/api/mix-to-cart/search', function(req, res) {
    var artists = req.body.artists || [];
    if (!artists.length) return res.status(400).json({ error: 'artists array required' });
    try {
        var mixResolver = require('./lib/mix-resolver');
        var rawDb = db.getDb();
        var results = mixResolver.searchInventoryForTracklist(artists, rawDb);
        res.json({ results: results });
    } catch(e) {
        console.error('[mix-to-cart] search error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Parse a pasted tracklist description (no URL needed)
app.post('/api/mix-to-cart/parse-text', function(req, res) {
    var text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    try {
        var { parseTracklistFromDescription } = require('./lib/mix-resolver');
        var artists = parseTracklistFromDescription(text);
        res.json({ artists: artists });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
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

    var browser = null;
    try {
        browser = await puppeteerExtra.launch({
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
            var page = null;
            try {
                page = await browser.newPage();
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
            } catch (e) {
                results[store.name] = { status: 'crash', error: e.message, responseTime: (Date.now() - startTime) + 'ms' };
            } finally {
                try { if (page) await page.close(); } catch(e) {}
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
    } finally {
        var _bpTest = browser ? browser.process() : null;
        try { if (browser) await browser.close(); } catch(e) {}
        if (_bpTest && _bpTest.pid) { try { process.kill(_bpTest.pid, 'SIGKILL'); } catch(e) {} }
    }
});

// Full validation: test all 6 scraped stores with all test items
app.get('/api/validate', async function (req, res) {
    var puppeteerExtra = require('puppeteer-extra');
    var StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    var scrapers = require('./lib/scrapers');
    var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

    var browser = null;
    try {
        browser = await puppeteerExtra.launch({
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
            try { await page.close(); } catch(e) {}
        }

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
    } finally {
        var _bpValidate = browser ? browser.process() : null;
        try { if (browser) await browser.close(); } catch(e) {}
        if (_bpValidate && _bpValidate.pid) { try { process.kill(_bpValidate.pid, 'SIGKILL'); } catch(e) {} }
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
                // ── Post-scan background jobs (fire & forget) ──
                if (type === 'done') {
                    var d = db.getDb();
                    var u = d.prepare('SELECT id FROM users WHERE username=?').get(username);
                    if (u) {
                        // 1. Auto-start release-meta sync if not yet fully synced
                        var metaSynced = d.prepare('SELECT COUNT(*) as c FROM wantlist w JOIN release_meta rm ON rm.discogs_id=w.discogs_id WHERE w.user_id=? AND w.active=1').get(u.id).c;
                        var metaTotal  = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1 AND discogs_id IS NOT NULL').get(u.id).c;
                        if (metaSynced < metaTotal && !_metaSyncActive[username]) {
                            console.log('[post-scan] Auto-starting meta sync for', username, '(' + metaSynced + '/' + metaTotal + ' synced)');
                            setTimeout(function() { runMetaSync(u.id, username); }, 3000);
                        }
                        // 2. If user has OAuth, refresh collection if stale or empty
                        var collCount = d.prepare('SELECT COUNT(*) as c FROM collection WHERE user_id=?').get(u.id).c;
                        var oauthTok  = db.getOAuthToken(u.id, 'discogs');
                        if (oauthTok && oauthTok.access_token && collCount === 0) {
                            console.log('[post-scan] Auto-fetching collection for new OAuth user', username);
                            var _hFn = function(method, url) {
                                return { 'User-Agent': 'VinylWantlistChecker/1.0', 'Authorization': require('./lib/oauth').discogsAuthHeader(method, url, oauthTok.access_token, oauthTok.access_secret) };
                            };
                            discogs.fetchCollection(username, _hFn).then(function(items) {
                                if (items.length > 0) db.syncCollectionItems(u.id, items);
                                console.log('[post-scan] Collection synced for', username, '—', items.length, 'items');
                            }).catch(function(e) { console.warn('[post-scan] Collection sync failed:', e.message); });
                        }
                    }
                }
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
        var tokenValid = false;
        if (oauthToken && oauthToken.access_token && oauthToken.access_secret) {
            var oauthLib = require('./lib/oauth');
            // Quick token validation — hit identity endpoint before wasting a full sync
            try {
                var identityUrl = 'https://api.discogs.com/oauth/identity';
                var identityHeader = oauthLib.discogsAuthHeader('GET', identityUrl, oauthToken.access_token, oauthToken.access_secret);
                var identityResp = await new Promise(function(resolve) {
                    require('https').get({ hostname: 'api.discogs.com', path: '/oauth/identity', headers: { 'User-Agent': 'VinylWantlistChecker/1.0', 'Authorization': identityHeader } }, function(r) {
                        var d = ''; r.on('data', function(c){ d+=c; }); r.on('end', function(){ try{ resolve(JSON.parse(d)); }catch(e){ resolve({}); } });
                    }).on('error', function(){ resolve({}); });
                });
                tokenValid = !!(identityResp && identityResp.username);
            } catch(e) { tokenValid = false; }

            if (tokenValid) {
                headersFn = function (method, path) {
                    var url = 'https://api.discogs.com' + path;
                    return {
                        'User-Agent': 'VinylWantlistChecker/1.0',
                        'Authorization': oauthLib.discogsAuthHeader(method, url, oauthToken.access_token, oauthToken.access_secret)
                    };
                };
            } else {
                console.warn('[collection] OAuth token invalid for', username, '— falling back to public API');
            }
        }
        var items = await discogs.fetchCollection(username, headersFn);
        // Only write to DB if we actually got items back — don't wipe existing data on auth failure
        if (items.length > 0) {
            db.syncCollectionItems(user.id, items);
        }
        var cached3 = db.getCollection(user.id);
        var stats2 = db.getCollectionStats(user.id);
        res.json({
            source: items.length > 0 ? 'fresh' : 'cache',
            total: cached3.length,
            stats: stats2,
            items: cached3,
            token_valid: tokenValid,
            needs_reauth: !tokenValid && !!oauthToken,
            warning: (!tokenValid && oauthToken) ? 'Discogs OAuth token expired — reconnect to see full private collection' : undefined
        });
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

// ─── Taste-match helper ────────────────────────────────────────────────────
function computeTasteMatch(items1, items2) {
    // Build genre + style Sets for each user
    var g1 = new Set(), s1 = new Set(), a1 = new Set();
    var g2 = new Set(), s2 = new Set(), a2 = new Set();
    items1.forEach(function(w) {
        (w.genres||'').split('|').forEach(function(x){ x=x.trim(); if(x) g1.add(x); });
        (w.styles||'').split('|').forEach(function(x){ x=x.trim(); if(x) s1.add(x); });
        var a = (w.artist||'').trim();
        if (a && a !== 'Various' && a !== 'Various Artists') a1.add(a);
    });
    items2.forEach(function(w) {
        (w.genres||'').split('|').forEach(function(x){ x=x.trim(); if(x) g2.add(x); });
        (w.styles||'').split('|').forEach(function(x){ x=x.trim(); if(x) s2.add(x); });
        var a = (w.artist||'').trim();
        if (a && a !== 'Various' && a !== 'Various Artists') a2.add(a);
    });
    function jaccard(A, B) {
        if (A.size === 0 && B.size === 0) return 0;
        var inter = 0;
        A.forEach(function(x) { if (B.has(x)) inter++; });
        var union = A.size + B.size - inter;
        return union === 0 ? 0 : inter / union;
    }
    // Weighted: genres 40%, styles 45%, artists 15%
    var score = jaccard(g1, g2) * 0.40 + jaccard(s1, s2) * 0.45 + jaccard(a1, a2) * 0.15;
    return Math.round(score * 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSONALITY TAGS — Rule-based from mined metadata
// Phase 3 slot: replace/supplement with LLM call using same structured input
// ═══════════════════════════════════════════════════════════════════════════

var ARCHETYPE_RULES = [
    // label,                       icon, color,    style array,                                                    genre array, min%
    { label:'UK Garage Head',       icon:'🏴',  color:'teal',   styles:['UK Garage','Speed Garage','2-Step'],                 genres:[],              min:5  },
    { label:'DnB / Jungle Junkie',  icon:'🥁',  color:'purple', styles:['Drum n Bass','Jungle','Darkstep','Neurofunk'],       genres:[],              min:7  },
    { label:'Rominimal Head',       icon:'〰️', color:'blue',   styles:['Minimal','Minimal Techno','Microhouse'],             genres:[],              min:7  },
    { label:'Detroit Purist',       icon:'🏭', color:'smoke',  styles:['Detroit Techno','Deep Techno'],                      genres:[],              min:5  },
    { label:'Acid Freak',           icon:'🧪', color:'green',  styles:['Acid','Acid House','Acid Jazz','Acid Techno'],       genres:[],              min:5  },
    { label:'Italo-Cosmic Head',    icon:'🪐', color:'pink',   styles:['Cosmic','Italo-Disco','Space'],                      genres:[],              min:5  },
    { label:'House Music Lifer',    icon:'🏠', color:'orange', styles:['Chicago House','Deep House','Soulful House','House'],genres:[],              min:9  },
    { label:'Breaks Fiend',         icon:'💥', color:'red',    styles:['Breakbeat','Breaks','Nu-Skool Breaks','Big Beat'],   genres:[],              min:5  },
    { label:'Dub Archaeologist',    icon:'🌿', color:'green',  styles:['Dub','Roots Reggae','Dub Techno','Lovers Rock'],     genres:['Reggae'],      min:7  },
    { label:'Global Grooves Hunter',icon:'🌍', color:'gold',   styles:['Afrobeat','Highlife','Afro-Cuban','Cumbia','Baile Funk'], genres:[],         min:4  },
    { label:'Ambient Explorer',     icon:'🌌', color:'blue',   styles:['Ambient','Drone','New Age','Dark Ambient'],          genres:[],              min:7  },
    { label:'Industrial Head',      icon:'⚙️', color:'smoke',  styles:['EBM','Industrial','Dark Electro','Power Electronics'],genres:[],             min:5  },
    { label:'80s Synth Devotee',    icon:'🎛', color:'pink',   styles:['Synth-pop','New Wave','Post-Punk','Darkwave'],       genres:[],              min:7  },
    { label:'Jazz Archaeologist',   icon:'🎷', color:'gold',   styles:['Bop','Post Bop','Hard Bop','Cool Jazz','Free Jazz'], genres:['Jazz'],        min:8  },
    { label:'Soul & Funk Hunter',   icon:'✊', color:'orange', styles:['Soul','Funk','Northern Soul','Neo Soul'],             genres:['Soul'],        min:10 },
    { label:'Hip Hop Head',         icon:'🎤', color:'red',    styles:[],                                                    genres:['Hip Hop'],     min:12 },
    { label:'Latin Grooves Collector',icon:'💃',color:'teal',  styles:['Cumbia','Salsa','Latin Jazz','Bossa Nova'],          genres:['Latin'],       min:5  },
    { label:'Balearic Head',        icon:'🏝', color:'teal',   styles:['Balearic','Chill Out','Downtempo'],                  genres:[],              min:5  },
    { label:'Trance Pilgrim',       icon:'🕊', color:'purple', styles:['Trance','Progressive Trance','Psy-Trance'],          genres:[],              min:7  },
    { label:'Noise & Experimental', icon:'📡', color:'smoke',  styles:['Noise','Avant-garde','Free Improvisation'],          genres:['Non-Music'],   min:5  },
    { label:'Classical Digger',     icon:'🎼', color:'gold',   styles:[],                                                    genres:['Classical'],   min:10 },
];

function computePersonalityTags(genreCounts, styleCounts, totalItems, avgHave, topDecade) {
    var scored = ARCHETYPE_RULES.map(function(rule) {
        var sum = 0;
        rule.styles.forEach(function(s) { sum += (styleCounts[s] || 0); });
        rule.genres.forEach(function(g) { sum += (genreCounts[g] || 0); });
        var pct = totalItems > 0 ? (sum / totalItems) * 100 : 0;
        return { label: rule.label, icon: rule.icon, color: rule.color, pct: pct, min: rule.min };
    });

    // Sort by pct descending, pick rules that clear their threshold
    scored.sort(function(a, b) { return b.pct - a.pct; });
    var tags = scored.filter(function(r) { return r.pct >= r.min; }).slice(0, 3);

    // Rarity tag — only if room and we have community data
    if (tags.length < 3 && typeof avgHave === 'number' && avgHave > 0) {
        if      (avgHave < 50)  tags.push({ label:'Ultra Rare Digger',       icon:'💎', color:'gold' });
        else if (avgHave < 150) tags.push({ label:'Underground Gem Hunter',  icon:'🔍', color:'gold' });
        else if (avgHave < 400) tags.push({ label:'Deep Digger',             icon:'⛏', color:'smoke' });
    }

    // Era fallback — if nothing else fired
    if (tags.length === 0 && topDecade) {
        var eraMap = {
            '60s':{ label:"60s Collector",      icon:'🎸', color:'orange' },
            '70s':{ label:'Vintage Digger',      icon:'🕰', color:'gold'   },
            '80s':{ label:"'80s Archaeologist",  icon:'📼', color:'purple' },
            '90s':{ label:"'90s Head",           icon:'💿', color:'blue'   },
            '00s':{ label:'Y2K Era Explorer',    icon:'💾', color:'teal'   },
            '10s':{ label:'2010s Digger',        icon:'📱', color:'smoke'  },
        };
        if (eraMap[topDecade]) tags.push(eraMap[topDecade]);
    }

    return tags.slice(0, 3);
}

// ─── Background Discogs release-meta crawler ──────────────────────────────
// Fetches community.have/want/rating for each wantlist item at ~24 req/min.
// Purely background — never blocks a scan or request.
var _metaSyncActive = {};

async function runMetaSync(userId, username) {
    if (_metaSyncActive[username]) return;
    _metaSyncActive[username] = true;
    console.log('[meta-sync] Starting for', username);
    try {
        var d = db.getDb();
        var cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T',' ');
        // Cover both wantlist AND collection — UNION dedupes shared releases
        var items = d.prepare(`
            SELECT discogs_id FROM (
                SELECT w.discogs_id, rm.fetched_at FROM wantlist w
                LEFT JOIN release_meta rm ON rm.discogs_id = w.discogs_id
                WHERE w.user_id = ? AND w.active = 1 AND w.discogs_id IS NOT NULL
                  AND (rm.discogs_id IS NULL OR replace(rm.fetched_at,'T',' ') < ?)
                UNION
                SELECT c.discogs_id, rm.fetched_at FROM collection c
                LEFT JOIN release_meta rm ON rm.discogs_id = c.discogs_id
                WHERE c.user_id = ? AND c.discogs_id IS NOT NULL
                  AND (rm.discogs_id IS NULL OR replace(rm.fetched_at,'T',' ') < ?)
            ) ORDER BY fetched_at ASC NULLS FIRST
            LIMIT 300
        `).all(userId, cutoff, userId, cutoff);

        var upsert = d.prepare(`
            INSERT OR REPLACE INTO release_meta
                (discogs_id, community_have, community_want, avg_rating, ratings_count, country, year, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);

        var ytEnrich = require('./lib/youtube-enrichment');
        console.log('[meta-sync]', username, '—', items.length, 'items to enrich');
        for (var i = 0; i < items.length; i++) {
            var id = items[i].discogs_id;
            try {
                var det = await discogs.fetchReleaseDetails(id);
                var comm = det.community || {};
                upsert.run(
                    id,
                    comm.have || null,
                    comm.want || null,
                    comm.rating ? comm.rating.average : null,
                    comm.rating ? comm.rating.count   : null,
                    det.country || null,
                    det.released ? parseInt(det.released, 10) || null : null
                );
                // FREE: Discogs already returns a videos[] array — extract YouTube ID at no extra quota cost
                var videoId = ytEnrich.extractVideoIdFromDiscogs(det.videos || []);
                if (videoId) {
                    db.saveStreamingMetadata(id, { youtubeVideoId: videoId });
                }
            } catch(e) { /* 404 or rate-limit — skip, will retry next sync */ }
            // 2.5s gap → 24 req/min (safely under 25/min unauthenticated limit)
            await new Promise(function(r) { setTimeout(r, 2500); });
        }
        console.log('[meta-sync]', username, 'done');
    } catch(e) {
        console.error('[meta-sync] Error:', e.message);
    } finally {
        _metaSyncActive[username] = false;
    }
}

// ─── Meta-sync status + trigger endpoint ─────────────────────────────────
app.get('/api/meta-sync/:username', function(req, res) {
    try {
        var username = req.params.username.trim();
        var d = db.getDb();
        var user = d.prepare('SELECT id FROM users WHERE username=?').get(username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        var total  = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1 AND discogs_id IS NOT NULL').get(user.id).c;
        var synced = d.prepare('SELECT COUNT(*) as c FROM wantlist w JOIN release_meta rm ON rm.discogs_id=w.discogs_id WHERE w.user_id=? AND w.active=1').get(user.id).c;
        var running = !!_metaSyncActive[username];
        var pct = total > 0 ? Math.round((synced / total) * 100) : 0;

        if (req.query.trigger === '1' && !running && synced < total) {
            runMetaSync(user.id, username); // fire and forget
        }

        res.json({ total: total, synced: synced, pct: pct, running: running });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── YouTube enrichment status + manual trigger ───────────────────────────
app.get('/api/youtube-enrichment/status', function(req, res) {
    try {
        var ytEnrich = require('./lib/youtube-enrichment');
        var status = ytEnrich.getEnrichmentStatus();
        if (req.query.trigger === '1' && !status.running) {
            var YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
            if (YOUTUBE_API_KEY) {
                ytEnrich.runYouTubeEnrichment(YOUTUBE_API_KEY).catch(function(e) {
                    console.error('[yt-enrich] Triggered run fatal:', e.message);
                });
                status.triggered = true;
            } else {
                status.triggered = false;
                status.error = 'YOUTUBE_API_KEY not set';
            }
        }
        res.json(status);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Community / all diggers ───────────────────────────────────────────────
app.get('/api/diggers', function (req, res) {
    try {
        var d = db.getDb();
        var forUser = (req.query.forUser || '').trim();
        // Pre-load forUser's items for taste-match (if requested)
        var forUserItems = null;
        if (forUser) {
            var fu = d.prepare('SELECT id FROM users WHERE username=?').get(forUser);
            if (fu) {
                // Combine wantlist + collection for taste match
                var fuWant = d.prepare('SELECT genres, styles, artist FROM wantlist WHERE user_id=? AND active=1').all(fu.id);
                var fuColl = d.prepare('SELECT genres, styles, artist FROM collection WHERE user_id=?').all(fu.id);
                forUserItems = fuWant.concat(fuColl);
            }
        }
        var users = d.prepare('SELECT id, username, last_full_scan FROM users ORDER BY username').all();
        var result = users.map(function(u) {
            var wantlist  = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1').get(u.id).c;
            var inStock   = d.prepare('SELECT COUNT(DISTINCT w.id) as c FROM wantlist w JOIN store_results sr ON sr.wantlist_id=w.id WHERE w.user_id=? AND w.active=1 AND sr.in_stock=1').get(u.id).c;
            var scanCount = d.prepare('SELECT COUNT(*) as c FROM scan_runs WHERE user_id=? AND finished_at IS NOT NULL AND error IS NULL').get(u.id).c;
            // Combine wantlist + collection for taste signal
            var wantItems = d.prepare('SELECT genres, styles, artist FROM wantlist WHERE user_id=? AND active=1').all(u.id);
            var collItems = d.prepare('SELECT genres, styles, artist FROM collection WHERE user_id=?').all(u.id);
            var items = wantItems.concat(collItems);
            var genres = {};
            items.forEach(function(w) {
                (w.genres||'').split('|').forEach(function(g){ g=g.trim(); if(g) genres[g]=(genres[g]||0)+1; });
            });
            var topGenres = Object.keys(genres).sort(function(a,b){return genres[b]-genres[a];}).slice(0,3);
            var row = {
                username:  u.username,
                wantlist:  wantlist,
                inStock:   inStock,
                inStockPct: wantlist > 0 ? Math.round((inStock/wantlist)*10)/10 : 0,
                scanCount: scanCount,
                lastScan:  u.last_full_scan,
                topGenres: topGenres
            };
            // Taste match vs forUser
            if (forUserItems && u.username !== forUser) {
                row.tasteMatch = computeTasteMatch(forUserItems, items);
            }
            return row;
        });
        res.json(result);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── User Profile ─────────────────────────────────────────────────────────────
app.get('/api/profile/:username', function (req, res) {
    try {
        var username = req.params.username.trim();
        var d = db.getDb();
        var user = d.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // ── Wantlist stats ──
        var wantlistSize = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id = ? AND active = 1').get(user.id).c;
        var inStockCount = d.prepare(
            'SELECT COUNT(DISTINCT w.id) as c FROM wantlist w JOIN store_results sr ON sr.wantlist_id = w.id WHERE w.user_id = ? AND w.active = 1 AND sr.in_stock = 1'
        ).get(user.id).c;

        // ── Taste profile (genres/styles from wantlist + collection combined) ──
        var wantlistItems    = d.prepare('SELECT genres, styles, artist FROM wantlist WHERE user_id = ? AND active = 1').all(user.id);
        var collectionItems  = d.prepare('SELECT genres, styles, artist, date_added FROM collection WHERE user_id = ?').all(user.id);
        var collectionSize   = collectionItems.length;
        var genreCounts = {}, styleCounts = {}, artistCounts = {};
        // ── Hunting: wantlist-only taste ──
        var huntingGenre = {}, huntingStyle = {};
        wantlistItems.forEach(function(w) {
            (w.genres || '').split('|').forEach(function(g) { g = g.trim(); if (g) { genreCounts[g] = (genreCounts[g]||0)+1; huntingGenre[g] = (huntingGenre[g]||0)+1; } });
            (w.styles || '').split('|').forEach(function(s) { s = s.trim(); if (s) { styleCounts[s] = (styleCounts[s]||0)+1; huntingStyle[s] = (huntingStyle[s]||0)+1; } });
            var a = (w.artist || '').trim();
            if (a && a !== 'Various' && a !== 'Various Artists') artistCounts[a] = (artistCounts[a] || 0) + 1;
        });
        var wantN = wantlistItems.length || 1;
        var huntingTopGenres = Object.keys(huntingGenre).sort(function(a,b){return huntingGenre[b]-huntingGenre[a];}).slice(0,6)
            .map(function(g){ return { name:g, count:huntingGenre[g], pct:Math.round(huntingGenre[g]/wantN*100) }; });
        var huntingTopStyles = Object.keys(huntingStyle).sort(function(a,b){return huntingStyle[b]-huntingStyle[a];}).slice(0,10)
            .map(function(s){ return { name:s, count:huntingStyle[s], pct:Math.round(huntingStyle[s]/wantN*100) }; });

        // ── Keeping: collection-only taste ──
        var keepingGenre = {}, keepingStyle = {};
        collectionItems.forEach(function(w) {
            (w.genres || '').split('|').forEach(function(g) { g = g.trim(); if (g) { genreCounts[g] = (genreCounts[g]||0)+1; keepingGenre[g] = (keepingGenre[g]||0)+1; } });
            (w.styles || '').split('|').forEach(function(s) { s = s.trim(); if (s) { styleCounts[s] = (styleCounts[s]||0)+1; keepingStyle[s] = (keepingStyle[s]||0)+1; } });
            var a = (w.artist || '').trim();
            if (a && a !== 'Various' && a !== 'Various Artists') artistCounts[a] = (artistCounts[a] || 0) + 1;
        });
        var collN = collectionSize || 1;
        var keepingTopGenres = Object.keys(keepingGenre).sort(function(a,b){return keepingGenre[b]-keepingGenre[a];}).slice(0,6)
            .map(function(g){ return { name:g, count:keepingGenre[g], pct:Math.round(keepingGenre[g]/collN*100) }; });
        var keepingTopStyles = Object.keys(keepingStyle).sort(function(a,b){return keepingStyle[b]-keepingStyle[a];}).slice(0,10)
            .map(function(s){ return { name:s, count:keepingStyle[s], pct:Math.round(keepingStyle[s]/collN*100) }; });

        // ── Leaning lately: recent collection additions (60 days) ──
        var sixtyDaysAgo = new Date(Date.now() - 60*24*60*60*1000).toISOString().slice(0,10);
        var recentCollItems = collectionItems.filter(function(w) {
            return w.date_added && w.date_added.slice(0,10) >= sixtyDaysAgo;
        });
        var leaningGenre = {}, leaningStyle = {};
        recentCollItems.forEach(function(w) {
            (w.genres||'').split('|').forEach(function(g){ g=g.trim(); if(g) leaningGenre[g]=(leaningGenre[g]||0)+1; });
            (w.styles||'').split('|').forEach(function(s){ s=s.trim(); if(s) leaningStyle[s]=(leaningStyle[s]||0)+1; });
        });
        var recentN = recentCollItems.length || 1;
        var leaningTrend = Object.keys(leaningStyle).sort(function(a,b){return leaningStyle[b]-leaningStyle[a];}).slice(0,8)
            .map(function(s) {
                var leanPct  = Math.round(leaningStyle[s] / recentN * 100);
                var keepPct  = Math.round((keepingStyle[s]||0) / collN * 100);
                return { name:s, count:leaningStyle[s], leanPct:leanPct, keepPct:keepPct, drift:leanPct-keepPct };
            }).sort(function(a,b){ return b.drift - a.drift; });
        var leaningGenreTrend = Object.keys(leaningGenre).sort(function(a,b){return leaningGenre[b]-leaningGenre[a];}).slice(0,4)
            .map(function(g) {
                var leanPct = Math.round(leaningGenre[g] / recentN * 100);
                var keepPct = Math.round((keepingGenre[g]||0) / collN * 100);
                return { name:g, count:leaningGenre[g], leanPct:leanPct, keepPct:keepPct, drift:leanPct-keepPct };
            }).sort(function(a,b){ return b.drift - a.drift; });

        // ── Store match: catalog alignment with user's taste ──
        var storeItemRows = d.prepare(
            'SELECT sr.store, w.genres, w.styles FROM store_results sr JOIN wantlist w ON w.id = sr.wantlist_id WHERE w.user_id = ? AND sr.in_stock = 1'
        ).all(user.id);
        var storeStyleMap = {};
        storeItemRows.forEach(function(r) {
            if (!storeStyleMap[r.store]) storeStyleMap[r.store] = {};
            (r.styles||'').split('|').forEach(function(s){ s=s.trim(); if(s) storeStyleMap[r.store][s]=(storeStyleMap[r.store][s]||0)+1; });
            (r.genres||'').split('|').forEach(function(g){ g=g.trim(); if(g) storeStyleMap[r.store][g]=(storeStyleMap[r.store][g]||0)+1; });
        });
        var userSignal = new Set(
            Object.keys(huntingStyle).sort(function(a,b){return huntingStyle[b]-huntingStyle[a];}).slice(0,20)
            .concat(Object.keys(huntingGenre).sort(function(a,b){return huntingGenre[b]-huntingGenre[a];}).slice(0,8))
        );
        var storeMatch = Object.keys(storeStyleMap).map(function(store) {
            var storeSet = new Set(Object.keys(storeStyleMap[store]));
            var hits = 0; userSignal.forEach(function(s){ if(storeSet.has(s)) hits++; });
            var matchPct = userSignal.size > 0 ? Math.round(hits/userSignal.size*100) : 0;
            var topStylesAtStore = Object.keys(storeStyleMap[store]).sort(function(a,b){return storeStyleMap[store][b]-storeStyleMap[store][a];}).slice(0,3);
            return { store:store, matchPct:matchPct, topStyles:topStylesAtStore };
        }).sort(function(a,b){ return b.matchPct-a.matchPct; });
        var totalTasteItems = wantlistItems.length + collectionItems.length;
        var topGenres = Object.keys(genreCounts).sort(function(a,b){ return genreCounts[b]-genreCounts[a]; }).slice(0,8)
            .map(function(g){ return { name: g, count: genreCounts[g] }; });
        var topStyles = Object.keys(styleCounts).sort(function(a,b){ return styleCounts[b]-styleCounts[a]; }).slice(0,12)
            .map(function(s){ return { name: s, count: styleCounts[s] }; });
        var topArtists = Object.keys(artistCounts).sort(function(a,b){ return artistCounts[b]-artistCounts[a]; }).slice(0,8)
            .map(function(a){ return { name: a, count: artistCounts[a] }; });

        // ── Store breakdown ──
        var storeRows = d.prepare(
            'SELECT sr.store, COUNT(DISTINCT w.id) as cnt FROM store_results sr JOIN wantlist w ON w.id = sr.wantlist_id WHERE w.user_id = ? AND sr.in_stock = 1 GROUP BY sr.store ORDER BY cnt DESC'
        ).all(user.id);
        var storeBreakdown = storeRows.map(function(r) {
            return { store: r.store, count: r.cnt, pct: wantlistSize > 0 ? Math.round((r.cnt / wantlistSize) * 100) : 0 };
        });

        // ── Scan history (last 15 completed runs) ──
        var recentScans = d.prepare(
            "SELECT run_type, started_at, finished_at, items_checked, items_in_stock, items_error, duration_ms, workers_used, error FROM scan_runs WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 15"
        ).all(user.id);

        // ── Member since (earliest scan or created) ──
        var firstScan = d.prepare('SELECT started_at FROM scan_runs WHERE user_id = ? ORDER BY started_at ASC LIMIT 1').get(user.id);
        var memberSince = firstScan ? firstScan.started_at : user.last_full_scan;

        // ── Recent finds (scan_changes: now_in_stock in last 30 days) ──
        var recentFinds = d.prepare(
            "SELECT sc.detected_at, sc.store, sc.new_value, w.artist, w.title, w.thumb FROM scan_changes sc JOIN wantlist w ON w.id = sc.wantlist_id WHERE sc.user_id = ? AND sc.change_type = 'now_in_stock' AND sc.detected_at > datetime('now','-30 days') ORDER BY sc.detected_at DESC LIMIT 12"
        ).all(user.id).map(function(r) {
            var val = {};
            try { val = JSON.parse(r.new_value || '{}'); } catch(e) {}
            return { artist: r.artist, title: r.title, thumb: r.thumb, store: r.store, price: val.price || null, url: val.url || null, foundAt: r.detected_at };
        });

        // ── Total scan stats ──
        var scanStats = d.prepare(
            "SELECT COUNT(*) as total, AVG(duration_ms) as avgMs, AVG(items_error*1.0/NULLIF(items_checked,0))*100 as avgErrPct FROM scan_runs WHERE user_id = ? AND finished_at IS NOT NULL AND error IS NULL"
        ).get(user.id);

        // ── Items never found in any store ──
        var neverFound = d.prepare(
            'SELECT COUNT(*) as c FROM wantlist w WHERE w.user_id = ? AND w.active = 1 AND NOT EXISTS (SELECT 1 FROM store_results sr WHERE sr.wantlist_id = w.id AND sr.in_stock = 1)'
        ).get(user.id).c;

        // ── Discogs listings count ──
        var discogsCount = d.prepare(
            'SELECT COUNT(DISTINCT dl.wantlist_id) as c FROM discogs_listings dl JOIN wantlist w ON w.id = dl.wantlist_id WHERE w.user_id = ? AND w.active = 1'
        ).get(user.id).c;

        // ── Release metadata (community have/want/rating) ──
        var metaStats = d.prepare(`
            SELECT
                COUNT(rm.discogs_id)           as synced,
                AVG(rm.community_have)         as avgHave,
                AVG(rm.community_want)         as avgWant,
                AVG(rm.avg_rating)             as avgRating,
                MIN(rm.community_have)         as minHave,
                MAX(rm.community_have)         as maxHave
            FROM wantlist w
            JOIN release_meta rm ON rm.discogs_id = w.discogs_id
            WHERE w.user_id = ? AND w.active = 1
        `).get(user.id);

        // ── Era / decade distribution from release_meta + wantlist.year ──
        var yearRows = d.prepare(`
            SELECT COALESCE(rm.year, w.year) as yr, COUNT(*) as cnt
            FROM wantlist w
            LEFT JOIN release_meta rm ON rm.discogs_id = w.discogs_id
            WHERE w.user_id = ? AND w.active = 1
              AND COALESCE(rm.year, w.year) IS NOT NULL
              AND COALESCE(rm.year, w.year) > 1950
            GROUP BY yr
        `).all(user.id);

        var decadeCounts = {};
        yearRows.forEach(function(r) {
            var decade = Math.floor(r.yr / 10) * 10;
            var key = (decade % 100) + 's';  // '90s', '80s' etc.
            decadeCounts[key] = (decadeCounts[key] || 0) + r.cnt;
        });
        var topDecade = Object.keys(decadeCounts).sort(function(a,b){ return decadeCounts[b]-decadeCounts[a]; })[0] || null;

        // ── Personality tags (rule-based; LLM slot ready) ──
        var avgHave = metaStats && metaStats.synced > 0 ? metaStats.avgHave : null;
        var personalityTags = computePersonalityTags(genreCounts, styleCounts, totalTasteItems, avgHave, topDecade);

        // ── Rarity score: proportion of items with community_have < 200 ──
        var rarityRow = d.prepare(`
            SELECT COUNT(*) as cnt
            FROM wantlist w JOIN release_meta rm ON rm.discogs_id = w.discogs_id
            WHERE w.user_id = ? AND w.active = 1 AND rm.community_have < 200
        `).get(user.id);
        var rarePct = metaStats && metaStats.synced > 0
            ? Math.round((rarityRow.cnt / metaStats.synced) * 100) : null;

        // ── Meta-sync status ──
        var totalDiscogs = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1 AND discogs_id IS NOT NULL').get(user.id).c;

        res.json({
            username:        user.username,
            collectionSize:  collectionSize,
            memberSince:     memberSince,
            lastScan:        user.last_full_scan,
            lastSync:        user.last_sync,
            wantlistSize:    wantlistSize,
            inStockCount:    inStockCount,
            inStockPct:      wantlistSize > 0 ? Math.round((inStockCount / wantlistSize) * 1000) / 10 : 0,
            neverFound:      neverFound,
            discogsCount:    discogsCount,
            totalScans:      scanStats ? scanStats.total : 0,
            avgScanMinutes:  scanStats && scanStats.avgMs ? Math.round(scanStats.avgMs / 60000 * 10) / 10 : null,
            avgErrorPct:     scanStats && scanStats.avgErrPct ? Math.round(scanStats.avgErrPct) : 0,
            topGenres:       topGenres,
            topStyles:       topStyles,
            topArtists:      topArtists,
            storeBreakdown:  storeBreakdown,
            recentScans:     recentScans,
            recentFinds:     recentFinds,
            // ── enriched ──
            personalityTags: personalityTags,
            decadeCounts:    decadeCounts,
            topDecade:       topDecade,
            metaSynced:      metaStats ? (metaStats.synced || 0) : 0,
            metaTotal:       totalDiscogs,
            avgHave:         avgHave ? Math.round(avgHave) : null,
            avgWant:         metaStats && metaStats.avgWant ? Math.round(metaStats.avgWant) : null,
            avgRating:       metaStats && metaStats.avgRating ? Math.round(metaStats.avgRating * 10) / 10 : null,
            rarePct:         rarePct,
            // ── Taste intelligence ──
            hunting: { topGenres: huntingTopGenres, topStyles: huntingTopStyles, total: wantlistItems.length },
            keeping: { topGenres: keepingTopGenres, topStyles: keepingTopStyles, total: collectionSize },
            leaning: { trend: leaningTrend, genreTrend: leaningGenreTrend, recentCount: recentCollItems.length },
            storeMatch: storeMatch
        });
    } catch(e) {
        console.error('[profile] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── GOLDIE proxy — forward to goldie.js process on port 5053 ────────────
var GOLDIE_URL = 'http://127.0.0.1:' + (process.env.GOLDIE_PORT || '5053');
var https_mod  = require('https');
var http_mod   = require('http');

function proxyToGoldie(req, res, extraPath) {
    var targetUrl = GOLDIE_URL + (extraPath || req.path.replace(/^\/api\/goldie/, ''));
    var parsed    = require('url').parse(targetUrl);
    var options   = {
        hostname: parsed.hostname, port: parsed.port, path: parsed.path,
        method: req.method,
        headers: Object.assign({}, req.headers, { host: parsed.host })
    };
    var proxyReq = http_mod.request(options, function(proxyRes) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', function() { res.status(502).json({ error: 'GOLDIE offline' }); });
    if (req.body && typeof req.body === 'object') {
        var bodyStr = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyStr));
        proxyReq.write(bodyStr);
    } else if (req.rawBody) {
        proxyReq.write(req.rawBody);
    }
    proxyReq.end();
}

app.use('/api/goldie', function(req, res) { proxyToGoldie(req, res); });

// Serve the app
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Shareable wantlist page — redirect to ?share= so relative paths work
app.get('/u/:username', function (req, res) {
    res.redirect('/?share=' + encodeURIComponent(req.params.username));
});

// Graceful shutdown
process.on('SIGINT', function () { db.close(); reapChrome(); process.exit(0); });
process.on('SIGTERM', function () { db.close(); reapChrome(); process.exit(0); });

// Kill any zombie Chrome/Chromium processes left over from a previous crash.
// Called on startup and on shutdown. Safe to call repeatedly — only kills processes
// that are children of THIS Node pid (Puppeteer always spawns as children), so we
// won't accidentally kill system Chrome instances. Falls back to pkill on failure.
function reapChrome() {
    try {
        var { execSync } = require('child_process');
        // Kill zombie Chrome child-processes
        var myPid = process.pid;
        try {
            var out = execSync('pgrep -P ' + myPid + ' -f "chrom" 2>/dev/null || true').toString().trim();
            if (out) {
                var pids = out.split('\n').filter(Boolean);
                pids.forEach(function(pid) {
                    try { process.kill(parseInt(pid), 'SIGKILL'); } catch(e) {}
                });
                if (pids.length > 0) console.log('[reaper] Killed ' + pids.length + ' zombie Chrome process(es)');
            }
        } catch(e) {}
        // Clean up orphaned Puppeteer tmp profile dirs older than 10 min
        try { scanner.reapOrphanedProfiles(); } catch(e) {}
    } catch(e) {}
}

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

// ─── GOLDIE internal sync trigger ─────────────────────────────────────────────
// Simple non-SSE endpoint GOLDIE can call to kick off a wantlist + collection sync
app.post('/api/sync-now/:username', async function (req, res) {
    var username = req.params.username;
    var user = db.getOrCreateUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Kick off background wantlist refresh (same as the 15-min cron) without SSE
    setImmediate(async function() {
        try {
            var oauthToken = db.getOAuthToken(user.id, 'discogs');
            var headersFn = null;
            if (oauthToken && oauthToken.access_token) {
                var oauthLib = require('./lib/oauth');
                headersFn = function(method, url) {
                    return { 'Authorization': oauthLib.discogsAuthHeader(method, url, oauthToken.access_token, oauthToken.access_secret) };
                };
            }
            var discogsLib = require('./lib/discogs');
            var wantlist = await discogsLib.fetchWantlist(username, headersFn ? function(method, url) { return headersFn(method, url)['Authorization']; } : null);
            if (wantlist && wantlist.length > 0) {
                db.syncWantlist(user.id, wantlist);
                console.log('[sync-now] Synced', wantlist.length, 'wantlist items for', username);
            }
        } catch(e) {
            console.error('[sync-now] error for', username, ':', e.message);
        }
    });

    res.json({ started: true, username: username, message: 'Wantlist sync started in background' });
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
        // Recent scan runs (all users, last 15) with username join
        var recentScanRuns = [];
        try {
            recentScanRuns = d.prepare(
                'SELECT sr.*, u.username FROM scan_runs sr JOIN users u ON u.id = sr.user_id ORDER BY sr.started_at DESC LIMIT 15'
            ).all();
        } catch(e) {}

        // Per-run-type aggregate stats (last 30 days)
        var scanRunStats = [];
        try { scanRunStats = db.getScanRunStats(); } catch(e) {}

        // Error rate per store (last 7 days)
        var scraperErrorStats = db.getScraperErrorStats(7);

        // Cumulative accuracy per store
        var storeAccuracy = db.getStoreAccuracy();

        // Last 5 validator runs
        var validatorHistory = db.getValidatorRunHistory(5);

        // Recent stock availability changes (for timeline dashboard)
        var recentStockChanges = [];
        try { recentStockChanges = db.getRecentStockChanges(25); } catch(e) {}

        // Chrome lock & RAM health
        var mem = process.memoryUsage();
        var lockContention = {
            waitCount:    jobHealthData.lockWaitCount    || 0,
            skipCount:    jobHealthData.lockSkipCount    || 0,
            totalWaitMs:  jobHealthData.totalLockWaitMs  || 0,
            avgWaitMs:    jobHealthData.lockWaitCount > 0
                              ? Math.round((jobHealthData.totalLockWaitMs || 0) / jobHealthData.lockWaitCount)
                              : 0,
            lastWait:     jobHealthData.lastLockWait  || null,
            lastSkip:     jobHealthData.lastLockSkip  || null
        };

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.round(process.uptime()) + 's',
            memory: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
            memoryDetail: {
                heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
                heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                rssMB:       Math.round(mem.rss       / 1024 / 1024),
                externalMB:  Math.round(mem.external  / 1024 / 1024)
            },
            chromeLock: scanner.chromeLock || false,
            lockContention: lockContention,
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
            scanRunStats: scanRunStats,
            scraperErrorStats: scraperErrorStats,
            storeAccuracy: storeAccuracy,
            validatorHistory: validatorHistory,
            recentStockChanges: recentStockChanges,
            workers: scanner.NUM_WORKERS || 3,
            workersConfig: {
                manual: scanner.NUM_WORKERS || 3,
                daily:  scanner.DAILY_WORKERS || 2,
                bg:     scanner.BG_WORKERS || 1,
            }
        });
    } catch (e) {
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// ─── Discover API ─────────────────────────────────────────────────────────────

app.get('/api/discover/:username', function(req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username);
        var rows = db.getDiscoverData(user.id);
        var cartItems = db.getCartItems(user.id);
        var cartSet = {};
        cartItems.forEach(function(c) { cartSet[String(c.wantlist_id) + ':' + c.store] = true; });

        // Aggregate by store
        var storeMap = {};
        rows.forEach(function(row) {
            if (!storeMap[row.store]) {
                storeMap[row.store] = {
                    store: row.store,
                    country: STORE_COUNTRIES[row.store] || 'XX',
                    items: [],
                    genreCounts: {},
                    styleCounts: {},
                    totalRecordUsd: 0,
                    itemsWithPrice: 0,
                };
            }
            var s = storeMap[row.store];

            var matches = [];
            try { matches = JSON.parse(row.matches || '[]'); } catch(e) {}

            // Parse store price from first match
            var priceStr  = '';
            var priceUsd  = null;
            if (matches.length > 0 && matches[0].price) {
                priceStr = matches[0].price;
                var rawNum = parseFloat(priceStr.replace(/[^0-9.,]/g, '').replace(',', '.'));
                if (!isNaN(rawNum) && rawNum > 0) {
                    priceUsd = (priceStr.indexOf('\u20ac') !== -1 || priceStr.indexOf('EUR') !== -1)
                        ? Math.round(rawNum * 1.09 * 100) / 100
                        : Math.round(rawNum * 100) / 100;
                    s.totalRecordUsd += priceUsd;
                    s.itemsWithPrice++;
                }
            }

            // Genre / style tag tallies
            (row.genres || '').split('|').forEach(function(g) {
                g = g.trim();
                if (g) s.genreCounts[g] = (s.genreCounts[g] || 0) + 1;
            });
            (row.styles || '').split('|').forEach(function(st) {
                st = st.trim();
                if (st) s.styleCounts[st] = (s.styleCounts[st] || 0) + 1;
            });

            var itemUrl = (matches.length > 0 && matches[0].url) ? matches[0].url : (row.search_url || '');
            s.items.push({
                wantlistId:    row.wantlist_id,
                discogsId:     row.discogs_id || null,
                artist:        row.artist  || '',
                title:         row.title   || '',
                year:          row.year    || null,
                label:         row.label   || '',
                catno:         row.catno   || '',
                thumb:         row.thumb   || '',
                genres:        row.genres  || '',
                styles:        row.styles  || '',
                priceStr:      priceStr,
                priceUsd:      priceUsd,
                discogsLowest: row.discogs_lowest  || null,
                numForSale:    row.num_for_sale    || 0,
                url:           itemUrl,
                inCart:        !!cartSet[String(row.wantlist_id) + ':' + row.store],
            });
        });

        // Convert to sorted array + compute shipping
        var stores = Object.keys(storeMap).map(function(storeName) {
            var s = storeMap[storeName];
            var shippingUsd = shippingLib.estimateShipping(s.country, 'US');
            var totalWithShipping = s.itemsWithPrice > 0
                ? Math.round((s.totalRecordUsd + shippingUsd) * 100) / 100
                : null;

            // Top genres / styles (sorted by frequency)
            var topGenres = Object.keys(s.genreCounts).sort(function(a,b){ return s.genreCounts[b]-s.genreCounts[a]; }).slice(0,5);
            var topStyles = Object.keys(s.styleCounts).sort(function(a,b){ return s.styleCounts[b]-s.styleCounts[a]; }).slice(0,8);

            return {
                store:             s.store,
                country:           s.country,
                itemCount:         s.items.length,
                items:             s.items,
                totalRecordUsd:    Math.round(s.totalRecordUsd * 100) / 100,
                itemsWithPrice:    s.itemsWithPrice,
                shippingUsd:       shippingUsd,
                totalWithShipping: totalWithShipping,
                topGenres:         topGenres,
                topStyles:         topStyles,
            };
        }).sort(function(a,b) { return b.itemCount - a.itemCount; });

        // ── "For You" feed ─────────────────────────────────────────────────────
        // 1. Wantlist in-stock items → 100% match (user already wants them)
        var forYouItems = [];
        rows.forEach(function(row) {
            var matches = [];
            try { matches = JSON.parse(row.matches || '[]'); } catch(e) {}
            var priceStr = matches.length > 0 ? (matches[0].price || '') : '';
            var itemUrl  = matches.length > 0 && matches[0].url ? matches[0].url : (row.search_url || '');
            forYouItems.push({
                wantlistId:    row.wantlist_id,
                discogsId:     row.discogs_id || null,
                artist:        row.artist  || '',
                title:         row.title   || '',
                year:          row.year    || null,
                label:         row.label   || '',
                catno:         row.catno   || '',
                store:         row.store,
                thumb:         row.thumb   || '',
                image:         row.thumb   || '',
                genres:        row.genres  || '',
                styles:        row.styles  || '',
                priceStr:      priceStr,
                priceUsd:      null,
                discogsLowest: row.discogs_lowest  || null,
                numForSale:    row.num_for_sale    || 0,
                url:           itemUrl,
                matchPct:      100,
                source:        'wantlist',
                inCart:        !!cartSet[String(row.wantlist_id) + ':' + row.store],
            });
        });

        // 2. Taste-based recs from catalog inventory (algo-scored)
        var tasteProfile = { topGenres: [], topStyles: [], wantlistSize: 0, inventorySize: 0, computeMs: 0 };
        try {
            var rec = require('./lib/recommendations');
            var recResult = rec.getRecommendations(req.params.username, 60);
            tasteProfile = {
                topGenres:     recResult.topGenres    || [],
                topStyles:     recResult.topStyles    || [],
                wantlistSize:  recResult.wantlistSize || 0,
                inventorySize: recResult.inventorySize || 0,
                computeMs:     recResult.computeMs   || 0,
            };
            // Dedup: skip if same artist+title already in wantlist in-stock
            var wantlistKeys = new Set(forYouItems.map(function(i) {
                return (i.artist + '|' + i.title).toLowerCase();
            }));
            (recResult.recommendations || []).forEach(function(r) {
                var key = (r.artist + '|' + r.title).toLowerCase();
                if (wantlistKeys.has(key)) return; // already shown at 100%
                var tags = Array.isArray(r.tags) ? r.tags : [];
                forYouItems.push({
                    wantlistId:    null,
                    discogsId:     null,
                    artist:        r.artist || '',
                    title:         r.title  || '',
                    year:          r.year   || null,
                    label:         r.label  || '',
                    catno:         r.catno  || '',
                    store:         r.store  || '',
                    thumb:         r.image  || '',
                    image:         r.image  || '',
                    genres:        tags.filter(function(t){ return t.length < 20; }).slice(0,2).join('|'),
                    styles:        tags.slice(0,4).join('|'),
                    priceStr:      r.price  ? '$' + r.price.toFixed(2) : '',
                    priceUsd:      r.price  || null,
                    discogsLowest: null,
                    numForSale:    0,
                    url:           r.url    || '',
                    matchPct:      r.matchPct || 0,
                    reasons:       r.reasonTypes || [],
                    source:        'catalog',
                    inCart:        false,
                });
                wantlistKeys.add(key);
            });
        } catch(recErr) {
            console.error('[discover] rec error:', recErr.message);
        }

        // Sort: wantlist (100%) first, then by matchPct desc
        forYouItems.sort(function(a, b) {
            if (a.source === 'wantlist' && b.source !== 'wantlist') return -1;
            if (b.source === 'wantlist' && a.source !== 'wantlist') return  1;
            return b.matchPct - a.matchPct;
        });

        // ── Discogs marketplace listings (from Chrome extension sync) ──────────
        var rawDiscogs = db.getDiscogsListings(user.id);
        var discogsMap = {};
        rawDiscogs.forEach(function(l) {
            var wid = l.wantlist_id;
            if (!discogsMap[wid]) {
                discogsMap[wid] = {
                    wantlistId: wid,
                    artist:  l.artist  || '',
                    title:   l.title   || '',
                    catno:   l.catno   || '',
                    discogsId: l.discogs_id || null,
                    thumb:   l.thumb   || '',
                    genres:  l.genres  || '',
                    styles:  l.styles  || '',
                    numListings: 0,
                    cheapest: null,
                    cheapestUsd: null,
                };
            }
            var item = discogsMap[wid];
            item.numListings++;
            if (!item.cheapest || (l.price_usd > 0 && (!item.cheapestUsd || l.price_usd < item.cheapestUsd))) {
                item.cheapest = l;
                item.cheapestUsd = l.price_usd;
            }
        });
        var discogsItems = Object.keys(discogsMap).map(function(wid) {
            var d = discogsMap[wid];
            var c = d.cheapest;
            var cheapestStr = '';
            if (c && c.price_original) {
                cheapestStr = c.currency === 'USD' ? '$' + parseFloat(c.price_original).toFixed(2)
                    : parseFloat(c.price_original).toFixed(2) + ' ' + c.currency;
            }
            return {
                wantlistId:   d.wantlistId,
                artist:       d.artist,
                title:        d.title,
                catno:        d.catno,
                discogsId:    d.discogsId,
                thumb:        d.thumb,
                genres:       d.genres,
                styles:       d.styles,
                numListings:  d.numListings,
                cheapestUsd:  d.cheapestUsd,
                cheapestStr:  cheapestStr,
                seller:       c ? c.seller_username : null,
                sellerRating: c ? c.seller_rating : null,
                condition:    c ? c.condition : null,
                shipsFrom:    c ? c.ships_from : null,
                listingUrl:   c ? c.listing_url : null,
            };
        }).sort(function(a, b) { return (a.cheapestUsd || 9999) - (b.cheapestUsd || 9999); });

        res.json({
            username:     req.params.username,
            stores:       stores,
            forYou:       forYouItems,
            tasteProfile: tasteProfile,
            cart:         cartItems,
            cartSet:      cartSet,
            totalInStock: rows.length,
            discogsListings:    discogsItems,
            discogsListingCount: rawDiscogs.length,
        });
    } catch(e) {
        console.error('[discover]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Cart API ─────────────────────────────────────────────────────────────────

app.get('/api/cart/:username', function(req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username);
        res.json({ cart: db.getCartItems(user.id), count: db.getCartCount(user.id) });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cart/:username', function(req, res) {
    try {
        var user  = db.getOrCreateUser(req.params.username);
        var wid   = req.body.wantlistId;
        var store = req.body.store;
        if (!wid || !store) return res.status(400).json({ error: 'wantlistId and store required' });
        db.addToCart(user.id, wid, store, req.body.price, req.body.priceUsd);
        res.json({ ok: true, count: db.getCartCount(user.id) });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cart/:username/:wantlistId/:store', function(req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username);
        db.removeFromCart(user.id, req.params.wantlistId, decodeURIComponent(req.params.store));
        res.json({ ok: true, count: db.getCartCount(user.id) });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cart/:username', function(req, res) {
    try {
        var user = db.getOrCreateUser(req.params.username);
        db.clearCart(user.id);
        res.json({ ok: true, count: 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
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

var SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL) || (4 * 60 * 60 * 1000); // default 4 hours — incremental new-items only
var DAILY_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // daily check fires once/day; users qualify after 23 h since last scan
var NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || '';

app.listen(PORT, function () {
    console.log('\n\u2728 Vinyl Checker running at http://localhost:' + PORT + '\n');

    // ── Startup cleanup ───────────────────────────────────────────────────────
    // Mark any unfinished scan_runs as errored. These are left over from a crash
    // or OOM kill — they show as "⏳ ..." in the admin dashboard forever otherwise.
    try {
        var stuckRows = db.getDb().prepare(
            "SELECT id FROM scan_runs WHERE finished_at IS NULL AND replace(started_at,'T',' ') < datetime('now', '-10 minutes')"
        ).all();
        if (stuckRows.length > 0) {
            var cleanStmt = db.getDb().prepare(
                "UPDATE scan_runs SET finished_at = datetime('now'), error = 'Process crashed or restarted before scan completed' WHERE id = ?"
            );
            stuckRows.forEach(function(r) { cleanStmt.run(r.id); });
            console.log('[startup] Cleaned up ' + stuckRows.length + ' stuck scan_run(s) from previous crash');
        }
    } catch(e) { console.error('[startup] scan_run cleanup error:', e.message); }

    // Kill any zombie Chrome processes left from a previous crash
    reapChrome();

    // Sweep orphaned Puppeteer /tmp/puppeteer_dev_profile-* dirs every 10 min.
    // Each orphaned dir is 250-420 MB — 2000+ of them ate 17 GB on the VPS.
    // scanner.js now cleans up after each browser.close(), but this interval
    // catches anything that slips through (OOM kills, external process deaths).
    setInterval(function () { reapChrome(); }, 10 * 60 * 1000);

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

    // Daily full rescan scheduler — fires once per day for users not scanned in 23+ hours
    console.log('[daily] Daily rescan fires once/day per user (23h threshold). ' + (scanner.DAILY_WORKERS || 2) + ' workers × 7 stores');
    setInterval(function () {
        scanner.dailyFullRescan()
            .then(function() { scanner.trackJobRun('daily', true); })
            .catch(function (e) { console.error('[daily] Fatal:', e.message); scanner.trackJobRun('daily', false, e.message); });
        // Piggyback on the same cadence to refresh any stale catalog mirrors.
        syncStaleStores();
    }, DAILY_CHECK_INTERVAL);

    // Also run daily check once on startup (after 5 min delay — gives manual scans priority window)
    setTimeout(function () {
        scanner.dailyFullRescan()
            .then(function() { scanner.trackJobRun('daily', true); })
            .catch(function (e) { console.error('[daily] Startup check fatal:', e.message); scanner.trackJobRun('daily', false, e.message); });
        syncStaleStores();
    }, 300000);

    // YouTube enrichment — fetch view/like counts + comment genre signals for all items with a video ID.
    // Each item costs 2 quota units (stats + comments); 10,000 units/day free → 5,000 items/day.
    // Video IDs are populated for FREE during meta-sync from Discogs release details.
    var YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
    if (YOUTUBE_API_KEY) {
        var ytEnrich = require('./lib/youtube-enrichment');
        console.log('[yt-enrich] YouTube enrichment enabled — runs every 6 hours');
        // First run: 15 min after startup so meta-sync can populate video IDs first
        setTimeout(function() {
            ytEnrich.runYouTubeEnrichment(YOUTUBE_API_KEY).catch(function(e) {
                console.error('[yt-enrich] Startup run fatal:', e.message);
            });
        }, 15 * 60 * 1000);
        setInterval(function() {
            ytEnrich.runYouTubeEnrichment(YOUTUBE_API_KEY).catch(function(e) {
                console.error('[yt-enrich] Fatal:', e.message);
            });
        }, 6 * 60 * 60 * 1000);
    } else {
        console.log('[yt-enrich] YOUTUBE_API_KEY not set — YouTube enrichment disabled');
    }

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
