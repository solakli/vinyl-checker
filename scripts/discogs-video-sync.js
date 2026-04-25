#!/usr/bin/env node
/**
 * discogs-video-sync.js
 *
 * For every release in wantlist/collection that has NO youtube_video_id,
 * fetch the Discogs release details and extract the video ID from the
 * videos[] array that Discogs editors maintain.
 *
 * This is FREE — no YouTube API quota used. Discogs editors add correct
 * YouTube links, so no mismatch validation needed.
 *
 * Rate: 2.5s gap → 24 req/min (under 25/min unauthenticated limit).
 * With DISCOGS_TOKEN: same rate, but authenticated = more reliable.
 *
 * Run: node scripts/discogs-video-sync.js
 */
'use strict';

const path = require('path');

// Load .env
try {
    require('fs').readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n').forEach(function(line) {
        line = line.trim();
        if (line && !line.startsWith('#')) {
            var eq = line.indexOf('=');
            if (eq > 0) {
                var k = line.substring(0, eq).trim();
                var v = line.substring(eq + 1).trim();
                if (!process.env[k]) process.env[k] = v;
            }
        }
    });
} catch(e) {}

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../vinyl-checker.db');
var db      = require('../db');
var d       = db.getDb();
var discogs = require('../lib/discogs');
var ytEnrich = require('../lib/youtube-enrichment');

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
    // All unique discogs_ids across all users that have no youtube_video_id.
    // Use NOT IN to avoid correlated-subquery column-resolution issues in SQLite.
    var rows = d.prepare(`
        SELECT DISTINCT discogs_id, artist, title FROM (
            SELECT w.discogs_id, w.artist, w.title
            FROM wantlist w
            WHERE w.active = 1 AND w.discogs_id IS NOT NULL
            UNION
            SELECT c.discogs_id, c.artist, c.title
            FROM collection c
            WHERE c.discogs_id IS NOT NULL
        ) items
        WHERE items.discogs_id NOT IN (
            SELECT sm.discogs_id FROM streaming_metadata sm
            WHERE sm.youtube_video_id IS NOT NULL
        )
        ORDER BY discogs_id
    `).all();

    console.log('Fetching Discogs videos for', rows.length, 'releases without video IDs...\n');
    console.log('Using DISCOGS_TOKEN:', !!process.env.DISCOGS_TOKEN, '\n');

    var found = 0, none = 0, errors = 0;

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        try {
            var det = await discogs.fetchReleaseDetails(row.discogs_id);
            var videos = det.videos || [];
            var videoId = ytEnrich.extractVideoIdFromDiscogs(videos);

            if (videoId) {
                db.saveStreamingMetadata(row.discogs_id, { youtubeVideoId: videoId });
                found++;
                console.log('[FOUND]', row.artist, '-', row.title, '→', videoId,
                    '(' + videos.length + ' videos on Discogs)');
            } else {
                none++;
                if (none <= 20 || none % 50 === 0) {
                    console.log('[NONE]', row.artist, '-', row.title,
                        '(Discogs has ' + videos.length + ' videos, none are YouTube)');
                }
            }
        } catch(e) {
            errors++;
            console.warn('[ERR]', row.discogs_id, row.artist, '-', row.title, ':', e.message);
        }

        if (i < rows.length - 1) {
            await sleep(2500); // 24 req/min — just under 25/min unauthenticated limit
        }

        // Progress every 50 items
        if ((i + 1) % 50 === 0) {
            console.log('\n--- Progress:', i + 1, '/', rows.length,
                '| Found:', found, '| None:', none, '| Errors:', errors, '---\n');
        }
    }

    console.log('\n=== DONE ===');
    console.log('Total checked: ', rows.length);
    console.log('Video IDs found from Discogs:', found);
    console.log('No YouTube video on Discogs: ', none, '(YouTube search will handle these)');
    console.log('Errors (rate-limited/404):   ', errors);
}

main().catch(function(e) { console.error('Fatal:', e); process.exit(1); });
