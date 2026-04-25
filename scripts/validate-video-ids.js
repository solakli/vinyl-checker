#!/usr/bin/env node
/**
 * validate-video-ids.js
 *
 * For every stored youtube_video_id, fetches the video title from YouTube
 * and checks whether it matches the artist/title from wantlist/collection.
 * Clears video_id + enriched_at for mismatches so the search job re-finds
 * them with the new validation logic.
 *
 * Cost: 1 quota unit per video (videos?part=snippet)
 * With 856 videos and 7 keys (70k quota/day) this costs ~1.2% of daily quota.
 *
 * Run: node scripts/validate-video-ids.js
 */
'use strict';

const path  = require('path');
const https = require('https');

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
var db = require('../db');
var d  = db.getDb();

// Collect all API keys
var keys = [];
if (process.env.YOUTUBE_API_KEY) keys.push(process.env.YOUTUBE_API_KEY);
for (var i = 2; i <= 50; i++) {
    var k = process.env['YOUTUBE_API_KEY_' + i];
    if (!k) break;
    keys.push(k);
}
if (!keys.length) { console.error('No YOUTUBE_API_KEY set'); process.exit(1); }
console.log('Using', keys.length, 'API key(s)');

var IGNORE_WORDS = new Set(['various', 'artists', 'artist', 'feat', 'with', 'and', 'the', 'von', 'de', 'el', 'la']);

function artistWords(artist) {
    return (artist || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(function(w){ return w.length >= 3 && !IGNORE_WORDS.has(w); });
}
function titleWords(title) {
    return (title || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(function(w){ return w.length >= 4; });
}

function ytGet(path, apiKey) {
    return new Promise(function(resolve, reject) {
        var sep = path.includes('?') ? '&' : '?';
        https.get({
            hostname: 'www.googleapis.com',
            path: path + sep + 'key=' + encodeURIComponent(apiKey),
            headers: { 'User-Agent': 'VinylChecker/1.0' }
        }, function(res) {
            var data = '';
            res.on('data', function(c){ data += c; });
            res.on('end', function(){
                try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

async function main() {
    // Get all stored video IDs with their wantlist/collection metadata
    var rows = d.prepare(`
        SELECT sm.discogs_id, sm.youtube_video_id,
               COALESCE(w.artist, c.artist) as artist,
               COALESCE(w.title,  c.title)  as title
        FROM streaming_metadata sm
        LEFT JOIN wantlist    w ON w.discogs_id = sm.discogs_id AND w.active = 1
        LEFT JOIN collection  c ON c.discogs_id = sm.discogs_id
        WHERE sm.youtube_video_id IS NOT NULL
        GROUP BY sm.discogs_id
    `).all();

    console.log('Validating', rows.length, 'video IDs...\n');

    var cleared = 0, valid = 0, skipped = 0;
    var clearStmt = d.prepare(`
        UPDATE streaming_metadata
        SET youtube_video_id   = NULL,
            youtube_view_count = NULL,
            youtube_like_count = NULL,
            youtube_comment_count = NULL,
            youtube_comment_data  = NULL,
            youtube_enriched_at   = NULL
        WHERE discogs_id = ?
    `);

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row.artist && !row.title) { skipped++; continue; }

        var key = keys[i % keys.length];
        try {
            var res = await ytGet(
                '/youtube/v3/videos?part=snippet&id=' + encodeURIComponent(row.youtube_video_id),
                key
            );
            var item = res.items && res.items[0];
            if (!item) {
                // Video deleted — clear it
                clearStmt.run(row.discogs_id);
                cleared++;
                console.log('[DELETED]', row.artist, '-', row.title, '→', row.youtube_video_id);
                await sleep(500);
                continue;
            }

            var videoTitle   = (item.snippet.title        || '').toLowerCase();
            var channelTitle = (item.snippet.channelTitle || '').toLowerCase();
            var combined     = videoTitle + ' ' + channelTitle;

            var aWords = artistWords(row.artist);
            var tWords = titleWords(row.title);

            var artistMatch = aWords.length === 0 || aWords.some(function(w){ return combined.includes(w); });
            var titleMatch  = tWords.length  === 0 || tWords.some(function(w){ return combined.includes(w); });

            if (!artistMatch && !titleMatch) {
                clearStmt.run(row.discogs_id);
                cleared++;
                console.log('[MISMATCH] ' + row.artist + ' - ' + row.title);
                console.log('           Video: ' + item.snippet.title + ' / ' + item.snippet.channelTitle);
            } else {
                valid++;
                if (valid % 50 === 0) console.log('[OK]', valid, 'valid so far...');
            }
        } catch(e) {
            console.warn('[ERR]', row.youtube_video_id, e.message);
        }

        await sleep(500); // 2 req/s — well within rate limits
    }

    console.log('\n=== DONE ===');
    console.log('Valid:   ', valid);
    console.log('Cleared: ', cleared, '(will be re-found by search job with new validation)');
    console.log('Skipped: ', skipped, '(no artist/title metadata)');
}

main().catch(function(e){ console.error('Fatal:', e); process.exit(1); });
