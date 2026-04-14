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
const path = require('path');
const db = require('./db');
const discogs = require('./lib/discogs');
const scanner = require('./lib/scanner');

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

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// Force-reset scan lock
app.get('/api/reset', function (req, res) {
    scanner.activeScans = {};
    res.json({ ok: true });
});

// Get current session info
app.get('/api/session', function (req, res) {
    if (req.sessionUser) {
        res.json({ username: req.sessionUser.username });
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

// Diagnostic: test a single store with a known query
app.get('/api/test-stores', async function (req, res) {
    const puppeteer = require('puppeteer');
    const scrapers = require('./lib/scrapers');
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
        var d = await scrapers.checkDeejay(p1, testItem);
        results.deejay = { products: d.matches.length, inStock: d.inStock, error: d.error || null };
        await p1.close();

        // Test HHV
        var p2 = await browser.newPage();
        await p2.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        await p2.setRequestInterception(true);
        p2.on('request', function (r) { var t = r.resourceType(); (t === 'image' || t === 'media' || t === 'font') ? r.abort() : r.continue(); });
        var h = await scrapers.checkHHV(p2, testItem);
        results.hhv = { products: h.matches.length, inStock: h.inStock, error: h.error || null };
        await p2.close();

        // Test Juno
        var p3 = await browser.newPage();
        await p3.setRequestInterception(true);
        p3.on('request', function (r) { var t = r.resourceType(); (t === 'image' || t === 'media' || t === 'font') ? r.abort() : r.continue(); });
        var j = await scrapers.checkJuno(p3, testItem);
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
            if (type === 'done' || type === 'error') {
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

    // Start or attach to existing scan
    scanner.runScan(username, sendEvent, force);
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
// BACKGROUND SYNC
// ═══════════════════════════════════════════════════════════════

var SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL) || (60 * 60 * 1000); // default 1 hour
var NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || '';

app.listen(PORT, function () {
    console.log('\n\u2728 Vinyl Checker running at http://localhost:' + PORT + '\n');

    // Background sync
    console.log('[sync] Background sync every ' + (SYNC_INTERVAL / 60000).toFixed(0) + ' minutes');
    if (NOTIFICATION_WEBHOOK) console.log('[sync] Notifications enabled (webhook)');
    setInterval(function () {
        scanner.backgroundSync().catch(function (e) { console.error('[sync] Fatal:', e.message); });
    }, SYNC_INTERVAL);
});
