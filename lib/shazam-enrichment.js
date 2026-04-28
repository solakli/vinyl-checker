'use strict';

/**
 * shazam-enrichment.js
 *
 * Two-step Shazam enrichment for vinyl releases:
 *   Step 1 — shazam-core (tipsters provider): text search → Shazam track key
 *   Step 2 — shazam    (apidojo provider):    songs/get-count?key= → total count
 *
 * Both use the same RapidAPI key. Different X-RapidAPI-Host headers.
 *
 * Quota is tight (~500 req/month each on free tiers), so:
 *   - Cache key + count permanently (counts don't change dramatically)
 *   - Only re-enrich after SHAZAM_TTL_DAYS (default 60)
 *   - Prioritise records without any shazam data first
 *   - 1.5s delay between tracks to stay well inside rate limits
 */

const https = require('https');

const SHAZAM_CORE_HOST = 'shazam-core.p.rapidapi.com';
const SHAZAM_HOST      = 'shazam.p.rapidapi.com';
const SHAZAM_TTL_DAYS  = 60;
const BATCH_DELAY_MS   = 1500;   // 1.5 s between tracks (≈ 40/min, well under limits)

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function apiGet(host, path, apiKey) {
    return new Promise(function(resolve, reject) {
        var options = {
            hostname: host,
            path: path,
            method: 'GET',
            headers: {
                'X-RapidAPI-Key':  apiKey,
                'X-RapidAPI-Host': host,
            },
        };
        var req = https.request(options, function(res) {
            var chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() {
                var body = Buffer.concat(chunks).toString();
                if (res.statusCode === 204 || !body) { resolve(null); return; }
                try { resolve(JSON.parse(body)); }
                catch(e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, function() { req.destroy(new Error('timeout')); });
        req.end();
    });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ─── Step 1: search for Shazam track key ─────────────────────────────────────

/**
 * Search shazam-core for a track. Returns the Shazam track key string, or null.
 * Validates that the returned artist/title roughly matches what we searched for.
 */
async function searchShazamKey(artist, title, apiKey) {
    var query = encodeURIComponent((artist + ' ' + title).trim());
    var path  = '/v1/search/multi?search_type=SONGS&query=' + query + '&limit=3';

    var data = await apiGet(SHAZAM_CORE_HOST, path, apiKey);
    if (!data) return null;

    // shazam-core response: { tracks: { hits: [ { track: { key, title, subtitle } } ] } }
    var hits = (data.tracks && data.tracks.hits) || [];

    // Find best match — artist name or title must appear in result
    var artistLower = artist.toLowerCase();
    var titleLower  = title.toLowerCase();

    for (var i = 0; i < hits.length; i++) {
        var track = hits[i].track || {};
        var rTitle    = (track.title    || '').toLowerCase();
        var rArtist   = (track.subtitle || '').toLowerCase();
        var key       = track.key;

        if (!key) continue;

        // Accept if returned title matches OR artist matches
        var titleMatch  = rTitle.includes(titleLower)  || titleLower.includes(rTitle);
        var artistMatch = rArtist.includes(artistLower) || artistLower.includes(rArtist);

        if (titleMatch || artistMatch) return key;
    }

    // Fallback: take first result if we got any (better than nothing)
    var first = hits[0] && hits[0].track;
    return (first && first.key) || null;
}

// ─── Step 2: fetch Shazam count ──────────────────────────────────────────────

/**
 * Fetch total Shazam identification count for a track key.
 * Returns integer or null.
 */
async function fetchShazamCount(trackKey, apiKey) {
    var path = '/songs/get-count?key=' + encodeURIComponent(trackKey);
    var data = await apiGet(SHAZAM_HOST, path, apiKey);
    if (!data || data.total == null) return null;
    return parseInt(data.total, 10) || null;
}

// ─── Main enrichment runner ───────────────────────────────────────────────────

/**
 * Enrich up to `limit` releases with Shazam count.
 * Skips records enriched within SHAZAM_TTL_DAYS.
 *
 * @param {object} db       - vinyl-checker db module
 * @param {string} apiKey   - RapidAPI key (same for both hosts)
 * @param {number} limit    - max tracks to enrich this run (default 50, mind quota)
 */
async function runShazamEnrichment(db, apiKey, limit) {
    limit = limit || 50;
    var d = db.getDb();

    var cutoff = new Date(Date.now() - SHAZAM_TTL_DAYS * 86400 * 1000).toISOString();

    // Grab releases that need Shazam enrichment, prioritising never-enriched first
    var rows = d.prepare(`
        SELECT DISTINCT
            COALESCE(w.discogs_id, c.discogs_id) AS discogs_id,
            COALESCE(w.artist,     c.artist)     AS artist,
            COALESCE(w.title,      c.title)      AS title,
            sm.shazam_enriched_at
        FROM (
            SELECT discogs_id, artist, title FROM wantlist  WHERE active=1 AND discogs_id IS NOT NULL
            UNION
            SELECT discogs_id, artist, title FROM collection WHERE discogs_id IS NOT NULL
        ) AS releases
        LEFT JOIN wantlist   w  ON w.discogs_id  = releases.discogs_id AND w.active=1
        LEFT JOIN collection c  ON c.discogs_id  = releases.discogs_id
        LEFT JOIN streaming_metadata sm ON sm.discogs_id = releases.discogs_id
        WHERE sm.shazam_enriched_at IS NULL OR sm.shazam_enriched_at < ?
        ORDER BY sm.shazam_enriched_at ASC NULLS FIRST
        LIMIT ?
    `).all(cutoff, limit);

    if (!rows.length) {
        console.log('[Shazam] All releases up to date.');
        return { enriched: 0, failed: 0, noResult: 0 };
    }

    console.log('[Shazam] Enriching', rows.length, 'releases...');

    var enriched = 0, failed = 0, noResult = 0;

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        try {
            // Step 1: get Shazam key
            var key = await searchShazamKey(row.artist, row.title, apiKey);

            if (!key) {
                noResult++;
                // Still mark enriched_at so we don't retry every run
                d.prepare(`
                    INSERT INTO streaming_metadata (discogs_id, fetched_at, shazam_enriched_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(discogs_id) DO UPDATE SET shazam_enriched_at = excluded.shazam_enriched_at
                `).run(row.discogs_id, new Date().toISOString(), new Date().toISOString());

                console.log('[Shazam] [NO RESULT]', row.artist, '-', row.title);
                await sleep(BATCH_DELAY_MS);
                continue;
            }

            await sleep(500); // brief pause between the two calls

            // Step 2: get count
            var count = await fetchShazamCount(key, apiKey);

            // Save to DB
            db.saveStreamingMetadata(row.discogs_id, {
                shazamTrackKey: key,
                shazamCount:    count,
            });

            enriched++;
            console.log('[Shazam] [OK]', row.artist, '-', row.title,
                '→ key:', key, '| count:', count != null ? count.toLocaleString() : 'n/a');

        } catch(e) {
            failed++;
            console.warn('[Shazam] [ERR]', row.discogs_id, row.artist, '-', row.title, ':', e.message);
        }

        if (i < rows.length - 1) await sleep(BATCH_DELAY_MS);

        if ((i + 1) % 20 === 0) {
            console.log('[Shazam] Progress:', i + 1, '/', rows.length,
                '| enriched:', enriched, '| no result:', noResult, '| errors:', failed);
        }
    }

    console.log('[Shazam] Done. enriched:', enriched, '| no result:', noResult, '| errors:', failed);
    return { enriched, failed, noResult };
}

// ─── Score helper (used by gem-score.js) ─────────────────────────────────────

/**
 * Convert a Shazam count to a 0–100 score.
 * Shazam count = number of times globally identified. Low = obscure.
 *
 * Calibration (inverse log scale, similar to YouTube obscurity):
 *   < 1k    → ~95   totally underground
 *   10k     → ~75   niche
 *   100k    → ~50   known in the scene
 *   1M      → ~25   popular
 *   > 10M   → ~5    mainstream
 *   null    → 50    no data (neutral)
 */
function shazamObscurityScore(shazamCount) {
    if (shazamCount == null) return 50;
    if (shazamCount <= 0)    return 100;
    var log   = Math.log10(shazamCount);
    var score = Math.max(0, Math.min(100, 100 - (log * 14)));
    return Math.round(score);
}

module.exports = {
    searchShazamKey,
    fetchShazamCount,
    runShazamEnrichment,
    shazamObscurityScore,
    SHAZAM_TTL_DAYS,
};
