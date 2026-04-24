/**
 * YouTube Enrichment — background job
 *
 * Pipeline (all lightweight, no browser):
 *
 *   1. During meta sync: Discogs release details already return a `videos[]`
 *      array with YouTube URLs — extract video ID for FREE (no API quota used)
 *
 *   2. Background enrichment job: for items that have a youtube_video_id but
 *      haven't been enriched yet, fetch:
 *        a. Video stats  — 1 quota unit  (view_count, like_count, tags, description)
 *        b. Top comments — 1 quota unit  (50 comments ordered by relevance)
 *      Parse comments for: genre tags, era, DJ name mentions, "sounds like" refs
 *
 * Quota: ~2 units per item. 574 items = ~1,150 units vs 10,000/day free limit.
 * Rate: 1 item per 3 seconds → 20/min → a full collection in ~30 min.
 */

'use strict';

const https = require('https');

// ─── Genre keyword list ───────────────────────────────────────────────────────

const GENRE_KEYWORDS = [
  'house', 'deep house', 'tech house', 'minimal', 'techno', 'acid', 'ambient',
  'drum and bass', 'dnb', 'd&b', 'jungle', 'breakbeat', 'breaks', 'garage',
  'uk garage', 'disco', 'funk', 'soul', 'jazz', 'hip hop', 'hip-hop', 'rap',
  'r&b', 'rnb', 'electro', 'electronic', 'experimental', 'noise', 'industrial',
  'dub', 'reggae', 'afro', 'afrobeat', 'latin', 'cumbia', 'salsa', 'bossa nova',
  'classical', 'folk', 'country', 'blues', 'rock', 'punk', 'post-punk',
  'new wave', 'synth', 'synthwave', 'wave', 'coldwave', 'darkwave', 'italo',
  'italo disco', 'cosmic', 'balearic', 'progressive', 'prog', 'trance',
  'psytrance', 'hardstyle', 'hardcore', 'rave', 'club', 'dance', 'edm',
  'footwork', 'juke', 'grime', 'dubstep', 'bass', 'halftime', 'deconstructed',
  'club', 'world', 'global', 'tropical', 'exotica', 'library', 'film score',
  'soundtrack', 'spoken word', 'spiritual jazz', 'free jazz', 'modal jazz',
  'nu jazz', 'future jazz', 'broken beat', 'neo soul', 'afro house',
  'melodic techno', 'melodic house', 'organic house', 'lo-fi', 'lofi',
  'chillout', 'downtempo', 'trip hop', 'abstract'
];

// Decade/era patterns
const ERA_RE = /\b(19[5-9]\d|20[0-2]\d)s?\b|\b(fifties|sixties|seventies|eighties|nineties)\b/gi;
const ERA_DECADE_RE = /\b([5-9]0s|[0-2]0s)\b/gi;  // "90s", "00s" etc.

// "Sounds like / reminds me of" patterns
const SOUNDS_LIKE_RE = /(?:sounds?\s+like|reminds?\s+me\s+of|similar\s+to|(?:this|that)\s+is\s+so)\s+([A-Z][a-zA-Z\s&'-]{2,30})/g;

// "X played this" / "heard this in X's set" patterns
const PLAYED_BY_RE = /(?:heard\s+(?:this|it)\s+(?:in|from|at)\s+(?:a\s+)?|played\s+by\s+|in\s+(?:a\s+)?(?:[A-Z]\w+\s+)?set\s+by\s+)([A-Z][a-zA-Z\s&'-]{2,30})/g;
const DJ_PLAYED_RE = /([A-Z][a-zA-Z\s&'-]{2,25})\s+(?:played|dropped|featured|uses?d?)\s+(?:this|it)/g;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function ytGet(path, apiKey) {
    return new Promise(function(resolve, reject) {
        var sep = path.includes('?') ? '&' : '?';
        var fullPath = path + sep + 'key=' + encodeURIComponent(apiKey);
        https.get({
            hostname: 'www.googleapis.com',
            path: fullPath,
            headers: { 'User-Agent': 'VinylWantlistChecker/1.0' }
        }, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('Parse error: ' + e.message)); }
            });
        }).on('error', reject);
    });
}

// ─── Extract YouTube video ID from Discogs videos array ──────────────────────
// Called during meta sync — zero extra API quota used.

function extractVideoIdFromDiscogs(videos) {
    if (!videos || !videos.length) return null;
    var { extractYoutubeId } = require('./discogs');
    // Prefer videos with "official" or "original" in title
    var sorted = videos.slice().sort(function(a, b) {
        var aScore = /official|original|full/i.test(a.title || '') ? 1 : 0;
        var bScore = /official|original|full/i.test(b.title || '') ? 1 : 0;
        return bScore - aScore;
    });
    for (var i = 0; i < sorted.length; i++) {
        var id = extractYoutubeId(sorted[i].url || '');
        if (id) return id;
    }
    return null;
}

// ─── Comment parser ───────────────────────────────────────────────────────────

function parseComments(comments) {
    var allText = comments.map(function(c) {
        return (c.snippet && c.snippet.topLevelComment &&
                c.snippet.topLevelComment.snippet &&
                c.snippet.topLevelComment.snippet.textDisplay) || '';
    }).join('\n');

    var textLower = allText.toLowerCase();

    // Genres
    var genres = [];
    GENRE_KEYWORDS.forEach(function(g) {
        if (textLower.includes(g)) genres.push(g);
    });
    genres = [...new Set(genres)].slice(0, 8);

    // Era/years
    var years = [];
    var m;
    ERA_RE.lastIndex = 0;
    while ((m = ERA_RE.exec(allText)) !== null) {
        var yr = parseInt(m[1] || m[0], 10);
        if (yr >= 1950 && yr <= 2030) years.push(yr);
    }
    ERA_DECADE_RE.lastIndex = 0;
    while ((m = ERA_DECADE_RE.exec(allText)) !== null) years.push(m[0]);
    var era = years.length
        ? [...new Set(years)].sort().slice(0, 5)
        : [];

    // "Sounds like" references
    var soundsLike = [];
    SOUNDS_LIKE_RE.lastIndex = 0;
    while ((m = SOUNDS_LIKE_RE.exec(allText)) !== null) {
        var name = m[1].trim().replace(/\.$/, '');
        if (name.length > 2 && name.length < 35) soundsLike.push(name);
    }
    soundsLike = [...new Set(soundsLike)].slice(0, 8);

    // DJ mentions
    var djs = [];
    PLAYED_BY_RE.lastIndex = 0;
    while ((m = PLAYED_BY_RE.exec(allText)) !== null) {
        var dj = m[1].trim().replace(/\.$/, '');
        if (dj.length > 2 && dj.length < 35) djs.push(dj);
    }
    DJ_PLAYED_RE.lastIndex = 0;
    while ((m = DJ_PLAYED_RE.exec(allText)) !== null) {
        var dj2 = m[1].trim().replace(/\.$/, '');
        if (dj2.length > 2 && dj2.length < 35) djs.push(dj2);
    }
    djs = [...new Set(djs)].slice(0, 10);

    // Top raw comments (first 5, stripped of HTML)
    var rawTop = comments.slice(0, 5).map(function(c) {
        var text = (c.snippet && c.snippet.topLevelComment &&
                    c.snippet.topLevelComment.snippet &&
                    c.snippet.topLevelComment.snippet.textDisplay) || '';
        return text.replace(/<[^>]+>/g, '').slice(0, 300);
    }).filter(Boolean);

    return { genres, era, djs, soundsLike, rawTop };
}

// ─── Fetch video stats + comments for one video ID ───────────────────────────

async function enrichOneVideo(videoId, apiKey) {
    // 1 quota unit: video snippet + statistics
    var statsRes = await ytGet(
        '/youtube/v3/videos?part=snippet,statistics&id=' + encodeURIComponent(videoId),
        apiKey
    );
    var item = statsRes.items && statsRes.items[0];
    if (!item) return null;

    var stats   = item.statistics || {};
    var snippet = item.snippet    || {};
    var viewCount = stats.viewCount ? parseInt(stats.viewCount, 10) : null;
    var likeCount = stats.likeCount ? parseInt(stats.likeCount, 10) : null;

    // Pull description genre hints too
    var descText = (snippet.description || '') + ' ' + (snippet.tags || []).join(' ');
    var descLower = descText.toLowerCase();
    var descGenres = GENRE_KEYWORDS.filter(function(g) { return descLower.includes(g); }).slice(0, 5);

    // 1 quota unit: top 50 comments by relevance
    var commentData = { genres: descGenres, era: [], djs: [], soundsLike: [], rawTop: [] };
    try {
        var commRes = await ytGet(
            '/youtube/v3/commentThreads?part=snippet&videoId=' + encodeURIComponent(videoId) +
            '&maxResults=50&order=relevance&textFormat=plainText',
            apiKey
        );
        if (commRes.items && commRes.items.length) {
            var parsed = parseComments(commRes.items);
            // Merge description genres with comment genres
            parsed.genres = [...new Set([...descGenres, ...parsed.genres])].slice(0, 10);
            commentData = parsed;
        }
    } catch(e) {
        // Comments disabled on video — still save stats
    }

    return { viewCount, likeCount, commentData };
}

// ─── Main enrichment job ──────────────────────────────────────────────────────

var _enrichActive = false;

async function runYouTubeEnrichment(apiKey, opts) {
    if (!apiKey) { console.log('[yt-enrich] No YOUTUBE_API_KEY — skipping'); return; }
    if (_enrichActive) { console.log('[yt-enrich] Already running'); return; }
    _enrichActive = true;

    opts = opts || {};
    var batchSize = opts.batchSize || 80; // stay well under 10k/day quota
    var delayMs   = opts.delayMs   || 3000; // 3s gap = 20/min, polite

    try {
        var db = require('../db');
        var d  = db.getDb();

        // Find items with a video ID but not yet enriched (or enriched >30 days ago)
        var cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ');
        var items = d.prepare(`
            SELECT sm.discogs_id, sm.youtube_video_id
            FROM streaming_metadata sm
            WHERE sm.youtube_video_id IS NOT NULL
              AND (sm.youtube_enriched_at IS NULL OR replace(sm.youtube_enriched_at,'T',' ') < ?)
            ORDER BY sm.youtube_enriched_at ASC NULLS FIRST
            LIMIT ?
        `).all(cutoff, batchSize);

        console.log('[yt-enrich] Enriching', items.length, 'items');

        var upsert = d.prepare(`
            UPDATE streaming_metadata
            SET youtube_view_count    = ?,
                youtube_like_count    = ?,
                youtube_comment_data  = ?,
                youtube_enriched_at   = datetime('now')
            WHERE discogs_id = ?
        `);

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            try {
                var result = await enrichOneVideo(item.youtube_video_id, apiKey);
                if (result) {
                    upsert.run(
                        result.viewCount,
                        result.likeCount,
                        JSON.stringify(result.commentData),
                        item.discogs_id
                    );
                    if (i % 10 === 0) {
                        console.log('[yt-enrich]', i + 1, '/', items.length,
                            '| views:', result.viewCount,
                            '| genres:', (result.commentData.genres || []).slice(0, 3).join(', '));
                    }
                }
            } catch(e) {
                console.warn('[yt-enrich] Failed for', item.youtube_video_id, ':', e.message);
            }
            if (i < items.length - 1) {
                await new Promise(function(r) { setTimeout(r, delayMs); });
            }
        }
        console.log('[yt-enrich] Done —', items.length, 'items processed');
    } catch(e) {
        console.error('[yt-enrich] Fatal:', e.message);
    } finally {
        _enrichActive = false;
    }
}

// ─── YouTube search: find video ID by artist + title ─────────────────────────
// Costs 100 quota units per search — use sparingly.
// Called for releases that have no Discogs-linked video.

async function searchVideoId(artist, title, apiKey) {
    var query = encodeURIComponent((artist + ' ' + title).slice(0, 100));
    var res = await ytGet(
        '/youtube/v3/search?part=snippet&type=video&maxResults=1&q=' + query,
        apiKey
    );
    var item = res.items && res.items[0];
    if (!item) return null;
    var id = item.id && item.id.videoId;
    return id || null;
}

// ─── Background job: populate missing video IDs via YouTube search ────────────
// Runs separately from enrichment — 50 searches/day max (~5k quota units)

var _searchActive = false;

async function runVideoIdSearch(apiKey, opts) {
    if (!apiKey) return;
    if (_searchActive) return;
    _searchActive = true;

    opts = opts || {};
    var batchSize = opts.batchSize || 50;   // 50 searches = 5k quota
    var delayMs   = opts.delayMs   || 3000; // 3s between searches

    try {
        var db = require('../db');
        var d  = db.getDb();

        // Find wantlist/collection releases that have NO video ID yet
        // Join across all users — once found, the ID benefits everyone
        var items = d.prepare(`
            SELECT DISTINCT
                COALESCE(w.discogs_id, c.discogs_id) AS discogs_id,
                COALESCE(w.artist,     c.artist)     AS artist,
                COALESCE(w.title,      c.title)      AS title
            FROM wantlist w
            LEFT JOIN collection c ON c.discogs_id = w.discogs_id
            WHERE COALESCE(w.discogs_id, c.discogs_id) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM streaming_metadata sm
                WHERE sm.discogs_id = COALESCE(w.discogs_id, c.discogs_id)
                  AND sm.youtube_video_id IS NOT NULL
              )
              AND (w.active = 1 OR w.id IS NULL)
            LIMIT ?
        `).all(batchSize);

        if (!items.length) { console.log('[yt-search] All releases have video IDs'); return; }
        console.log('[yt-search] Searching YouTube for', items.length, 'releases without video IDs');

        var found = 0;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item.artist || !item.title) continue;
            try {
                var videoId = await searchVideoId(item.artist, item.title, apiKey);
                if (videoId) {
                    db.saveStreamingMetadata(item.discogs_id, { youtubeVideoId: videoId });
                    found++;
                    if (found % 10 === 0) {
                        console.log('[yt-search]', found, 'found so far |', item.artist, '-', item.title, '→', videoId);
                    }
                }
            } catch(e) {
                console.warn('[yt-search] Failed for', item.artist, '-', item.title, ':', e.message);
            }
            if (i < items.length - 1) {
                await new Promise(function(r) { setTimeout(r, delayMs); });
            }
        }
        console.log('[yt-search] Done —', found, 'video IDs found out of', items.length, 'searched');
    } catch(e) {
        console.error('[yt-search] Fatal:', e.message);
    } finally {
        _searchActive = false;
    }
}

// ─── Status ───────────────────────────────────────────────────────────────────

function getEnrichmentStatus() {
    var db = require('../db');
    var d  = db.getDb();
    var total    = d.prepare('SELECT COUNT(*) as c FROM streaming_metadata WHERE youtube_video_id IS NOT NULL').get().c;
    var enriched = d.prepare('SELECT COUNT(*) as c FROM streaming_metadata WHERE youtube_enriched_at IS NOT NULL').get().c;
    return { total, enriched, running: _enrichActive, pct: total > 0 ? Math.round(enriched/total*100) : 0 };
}

module.exports = {
    extractVideoIdFromDiscogs,
    searchVideoId,
    runYouTubeEnrichment,
    runVideoIdSearch,
    getEnrichmentStatus,
    parseComments,   // exported for testing
};
