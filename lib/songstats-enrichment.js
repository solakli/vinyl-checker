'use strict';

/**
 * songstats-enrichment.js
 *
 * Two-step Songstats enrichment for vinyl releases:
 *   Step 1 — /tracks/search?q=artist+title → songstats_track_id
 *   Step 2 — /tracks/stats?songstats_track_id=ID&source=all → multi-platform stats
 *
 * Signals extracted (all stored in streaming_metadata):
 *   songstats_shazams          — Shazam identification count (obscurity signal)
 *   songstats_sc_streams       — SoundCloud play count (second obscurity signal)
 *   songstats_spotify_streams  — Spotify streams (mainstream scale signal)
 *   songstats_beatport_charts  — Beatport DJ chart appearances (DJ validation)
 *   songstats_traxsource_charts— Traxsource DJ chart appearances (DJ validation)
 *   songstats_tracklist_support— 1001tracklists DJ set appearances (club weapon signal)
 *   songstats_tracklist_unique — Unique DJs who played this track
 *
 * Rate note: Free tier ~100 req/month, Basic ~500.
 * Each track = 2 calls. Batch small (default 30 tracks/run).
 * TTL: 90 days (Songstats data is cumulative, updates slowly).
 */

const https = require('https');

const SONGSTATS_HOST   = 'songstats.p.rapidapi.com';
const SONGSTATS_TTL_DAYS = 90;
const BATCH_DELAY_MS  = 2000;   // 2s between tracks (conservative)

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function apiGet(path, apiKey) {
    return new Promise(function(resolve, reject) {
        var options = {
            hostname: SONGSTATS_HOST,
            path: path,
            method: 'GET',
            headers: {
                'X-RapidAPI-Key':  apiKey,
                'X-RapidAPI-Host': SONGSTATS_HOST,
                'Accept-Encoding': 'gzip, deflate',
            },
        };
        var req = https.request(options, function(res) {
            var chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() {
                var body = Buffer.concat(chunks);
                if (res.statusCode === 204 || !body.length) { resolve(null); return; }
                // Handle gzip
                var str;
                var enc = (res.headers['content-encoding'] || '').toLowerCase();
                if (enc === 'gzip' || enc === 'br') {
                    try {
                        var zlib = require('zlib');
                        var decompress = enc === 'br' ? zlib.brotliDecompressSync : zlib.gunzipSync;
                        str = decompress(body).toString();
                    } catch(e) { str = body.toString(); }
                } else {
                    str = body.toString();
                }
                try { resolve(JSON.parse(str)); }
                catch(e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.setTimeout(12000, function() { req.destroy(new Error('timeout')); });
        req.end();
    });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ─── Step 1: search for Songstats track ID ────────────────────────────────────

/**
 * Search Songstats for a track. Returns songstats_track_id string or null.
 * Validates that the result roughly matches artist+title.
 */
async function searchSongstatsTrackId(artist, title, apiKey) {
    var q   = encodeURIComponent((artist + ' ' + title).trim());
    var path = '/tracks/search?q=' + q + '&limit=3';

    var data = await apiGet(path, apiKey);
    if (!data || !data.results || !data.results.length) return null;

    var artistLow = artist.toLowerCase();
    var titleLow  = title.toLowerCase();

    // Try to find a result where artist or title matches
    for (var i = 0; i < data.results.length; i++) {
        var r = data.results[i];
        var rTitle   = (r.title || '').toLowerCase();
        var rArtists = (r.artists || []).map(function(a) { return (a.name || '').toLowerCase(); }).join(' ');

        var titleMatch  = rTitle.includes(titleLow)  || titleLow.includes(rTitle);
        var artistMatch = rArtists.includes(artistLow) || artistLow.split(' ').some(function(w) { return w.length > 3 && rArtists.includes(w); });

        if ((titleMatch && artistMatch) || (titleMatch && i === 0)) {
            return r.songstats_track_id;
        }
    }

    // Fallback: first result
    return data.results[0].songstats_track_id || null;
}

// ─── Step 2: fetch full stats ─────────────────────────────────────────────────

/**
 * Fetch all platform stats for a songstats_track_id.
 * Returns a normalized object with only the signals we care about.
 */
async function fetchSongstatsStats(trackId, apiKey) {
    var path = '/tracks/stats?songstats_track_id=' + encodeURIComponent(trackId) + '&source=all';
    var data = await apiGet(path, apiKey);
    if (!data || !data.stats) return null;

    var result = {};

    data.stats.forEach(function(s) {
        var d = s.data || {};
        switch (s.source) {
            case 'shazam':
                if (d.shazams_total != null) result.shazams = d.shazams_total;
                break;
            case 'soundcloud':
                if (d.streams_total != null)   result.scStreams = d.streams_total;
                break;
            case 'spotify':
                if (d.streams_total != null) result.spotifyStreams = d.streams_total;
                break;
            case 'beatport':
                if (d.dj_charts_total != null) result.beatportCharts = d.dj_charts_total;
                break;
            case 'traxsource':
                if (d.dj_charts_total != null) result.traxsourceCharts = d.dj_charts_total;
                break;
            case 'tracklist':  // 1001tracklists
                if (d.total_support  != null) result.tracklistSupport = d.total_support;
                if (d.unique_support != null) result.tracklistUnique  = d.unique_support;
                break;
        }
    });

    return Object.keys(result).length > 0 ? result : null;
}

// ─── Main enrichment runner ───────────────────────────────────────────────────

/**
 * Enrich up to `limit` releases with Songstats data.
 * Prioritises records with no songstats data, then oldest enrichment.
 *
 * @param {object} db     - vinyl-checker db module
 * @param {string} apiKey - RapidAPI key
 * @param {number} limit  - max tracks to enrich this run (default 30)
 */
async function runSongstatsEnrichment(db, apiKey, limit) {
    limit = limit || 30;
    var d = db.getDb();

    var cutoff = new Date(Date.now() - SONGSTATS_TTL_DAYS * 86400 * 1000).toISOString();

    var rows = d.prepare(`
        SELECT DISTINCT
            COALESCE(w.discogs_id, c.discogs_id) AS discogs_id,
            COALESCE(w.artist,     c.artist)     AS artist,
            COALESCE(w.title,      c.title)      AS title,
            sm.songstats_enriched_at
        FROM (
            SELECT discogs_id, artist, title FROM wantlist  WHERE active=1 AND discogs_id IS NOT NULL
            UNION
            SELECT discogs_id, artist, title FROM collection WHERE discogs_id IS NOT NULL
        ) AS releases
        LEFT JOIN wantlist   w  ON w.discogs_id  = releases.discogs_id AND w.active=1
        LEFT JOIN collection c  ON c.discogs_id  = releases.discogs_id
        LEFT JOIN streaming_metadata sm ON sm.discogs_id = releases.discogs_id
        WHERE sm.songstats_enriched_at IS NULL OR sm.songstats_enriched_at < ?
        ORDER BY sm.songstats_enriched_at ASC NULLS FIRST
        LIMIT ?
    `).all(cutoff, limit);

    if (!rows.length) {
        console.log('[Songstats] All releases up to date.');
        return { enriched: 0, failed: 0, noResult: 0 };
    }

    console.log('[Songstats] Enriching', rows.length, 'releases...');
    var enriched = 0, failed = 0, noResult = 0;

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var nowIso = new Date().toISOString();

        try {
            // Step 1: find track ID
            var trackId = await searchSongstatsTrackId(row.artist, row.title, apiKey);

            if (!trackId) {
                noResult++;
                // Mark enriched so we don't retry every run (null track = not on platform)
                d.prepare(`INSERT INTO streaming_metadata (discogs_id, fetched_at, songstats_enriched_at) VALUES (?,?,?)
                    ON CONFLICT(discogs_id) DO UPDATE SET songstats_enriched_at=excluded.songstats_enriched_at`
                ).run(row.discogs_id, nowIso, nowIso);
                console.log('[Songstats] [NO RESULT]', row.artist, '-', row.title);
                await sleep(BATCH_DELAY_MS);
                continue;
            }

            await sleep(600); // brief pause between the two calls

            // Step 2: get stats
            var stats = await fetchSongstatsStats(trackId, apiKey);

            // Save
            db.saveStreamingMetadata(row.discogs_id, {
                songstatsTrackId:          trackId,
                songstatsShazams:          stats ? stats.shazams          : null,
                songstatsScStreams:         stats ? stats.scStreams         : null,
                songstatsSpotifyStreams:    stats ? stats.spotifyStreams    : null,
                songstatsBeatportCharts:   stats ? stats.beatportCharts   : null,
                songstatsTraxsourceCharts: stats ? stats.traxsourceCharts : null,
                songstatsTracklistSupport: stats ? stats.tracklistSupport : null,
                songstatsTracklistUnique:  stats ? stats.tracklistUnique  : null,
            });

            enriched++;
            var sig = stats ? [
                stats.shazams        != null ? 'shazam:'   + stats.shazams.toLocaleString()       : null,
                stats.scStreams       != null ? 'sc:'       + stats.scStreams.toLocaleString()      : null,
                stats.beatportCharts != null ? 'bp:'       + stats.beatportCharts                  : null,
                stats.tracklistSupport != null ? '1001tl:' + stats.tracklistSupport               : null,
            ].filter(Boolean).join(' | ') : 'no stats';

            console.log('[Songstats] [OK]', row.artist, '-', row.title, '→', sig);

        } catch(e) {
            failed++;
            console.warn('[Songstats] [ERR]', row.discogs_id, row.artist, '-', row.title, ':', e.message);
        }

        if (i < rows.length - 1) await sleep(BATCH_DELAY_MS);

        if ((i + 1) % 10 === 0) {
            console.log('[Songstats] Progress:', i + 1, '/', rows.length,
                '| enriched:', enriched, '| no result:', noResult, '| errors:', failed);
        }
    }

    console.log('[Songstats] Done. enriched:', enriched, '| no result:', noResult, '| errors:', failed);
    return { enriched, failed, noResult };
}

// ─── Score helpers (for gem-score.js) ────────────────────────────────────────

/** DJ validation score from Beatport + Traxsource charts + 1001tracklists appearances */
function songstatsDjScore(beatportCharts, traxsourceCharts, tracklistSupport, tracklistUnique) {
    var total = (beatportCharts || 0) + (traxsourceCharts || 0);
    var tl    = tracklistUnique || tracklistSupport || 0;

    // 1001tracklists unique DJs is the strongest signal
    if (tl >= 20)  return 100;
    if (tl >= 10)  return 85;
    if (tl >= 5)   return 70;
    if (tl >= 2)   return 50;

    // Beatport + Traxsource charts fallback
    if (total >= 50) return 90;
    if (total >= 20) return 75;
    if (total >= 5)  return 55;
    if (total >= 1)  return 35;

    return 0;
}

/** Obscurity score from Shazam count (inverse log scale) */
function songstatsShazamScore(shazams) {
    if (shazams == null) return 50;
    if (shazams <= 0)    return 100;
    var log   = Math.log10(shazams);
    var score = Math.max(0, Math.min(100, 100 - (log * 14)));
    return Math.round(score);
}

/** Obscurity score from SoundCloud streams (inverse log scale) */
function songstatsSoundcloudScore(scStreams) {
    if (scStreams == null) return 50;
    if (scStreams <= 0)    return 100;
    var log   = Math.log10(scStreams);
    var score = Math.max(0, Math.min(100, 100 - (log * 12)));
    return Math.round(score);
}

module.exports = {
    searchSongstatsTrackId,
    fetchSongstatsStats,
    runSongstatsEnrichment,
    songstatsDjScore,
    songstatsShazamScore,
    songstatsSoundcloudScore,
    SONGSTATS_TTL_DAYS,
};
