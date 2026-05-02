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

// ─── DJ name extraction ───────────────────────────────────────────────────────
// Strategy (highest precision first):
//   1. Explicit "DJ Xyz" prefix  — near-zero false positives
//   2. "played by Xyz" / "Xyz played this" — filtered aggressively
//   3. "heard this in Xyz's set" pattern
//
// Anything that passes a regex MUST also pass isLikelyDjName() to cut noise.

// Words that reliably indicate a false-positive DJ match
const DJ_REJECT_FIRST = new Set([
    'my','his','her','their','our','your','its','the','a','an',
    'this','that','when','where','who','what','how','why','if',
    'just','soon','recently','always','never','once','every','some',
    'any','no','not','i','we','they','he','she','it','you',
    'god','lord','jesus','mr','mrs','ms','dr','sir',
]);
const DJ_REJECT_CONTAINS = new Set([
    'husband','wife','father','mother','brother','sister','friend',
    'boyfriend','girlfriend','partner','son','daughter','uncle','aunt',
    'cousin','grandma','grandpa','grandfather','grandmother',
    'baby','man','woman','guy','girl','people','person','family',
    'someone','everyone','anyone','nobody','somebody',
    'late','dead','passed','memory','memories','remember',
    'school','college','church','club','party','wedding','funeral',
]);

function isLikelyDjName(name) {
    if (!name || name.length < 3 || name.length > 40) return false;
    var words = name.trim().split(/\s+/);
    // Max 4 words — real DJ names are short
    if (words.length > 4) return false;
    var first = words[0].toLowerCase();
    // Reject if first word is a pronoun/article/preposition
    if (DJ_REJECT_FIRST.has(first)) return false;
    // Reject if any word is a relationship or sentiment word
    var lowerWords = words.map(function(w){ return w.toLowerCase(); });
    if (lowerWords.some(function(w){ return DJ_REJECT_CONTAINS.has(w); })) return false;
    // Must start with a capital letter (proper noun)
    if (!/^[A-Z]/.test(name.trim())) return false;
    // Reject pure filler: ends with prepositions/conjunctions/articles
    var last = words[words.length - 1].toLowerCase();
    if (['and','or','but','in','at','by','of','the','a','an','also','too','had','has'].includes(last)) return false;
    return true;
}

function cleanDjName(name) {
    // Strip honorific prefixes
    return name.replace(/^(?:Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+|Dr\.?\s+)/i, '').trim();
}

// Explicit "DJ Xyz" pattern — highest precision
// Each word in the name MUST start with a capital letter (stops at lowercase words like "mix", "played")
const DJ_PREFIX_RE = /\bDJ\s+([A-Z][a-zA-Z&'-]{1,20}(?:\s+[A-Z][a-zA-Z&'-]{1,15}){0,2})/g;
// "played by Xyz" / "in Xyz's set" — medium precision, needs name filter
const PLAYED_BY_RE = /(?:played\s+by\s+|in\s+(?:a\s+)?(?:[A-Z]\w+\s+)?set\s+by\s+|heard\s+(?:this|it)\s+(?:in|from|at)\s+(?:a\s+)?)([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){0,2})/g;
// "Xyz played/dropped this" — lower precision, strict name filter
const DJ_PLAYED_RE = /([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){0,2})\s+(?:played|dropped|featured|spun)\s+(?:this|it)\b/g;

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
                try {
                    var parsed = JSON.parse(data);
                    // Surface API errors as thrown exceptions so callers can rotate keys
                    if (parsed.error) {
                        var err = new Error(parsed.error.message || 'YouTube API error');
                        err.ytCode = parsed.error.code || 0;
                        // quotaExceeded / dailyLimitExceeded → caller should try next key
                        err.quotaExceeded = !!(parsed.error.errors || []).some(function(e) {
                            return e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded';
                        }) || parsed.error.code === 403;
                        return reject(err);
                    }
                    resolve(parsed);
                } catch(e) { reject(new Error('Parse error: ' + e.message)); }
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

    // DJ mentions — three patterns, each filtered through isLikelyDjName()
    var djs = [];
    // 1. Highest precision: explicit "DJ Xyz" prefix
    DJ_PREFIX_RE.lastIndex = 0;
    while ((m = DJ_PREFIX_RE.exec(allText)) !== null) {
        var djp = ('DJ ' + m[1]).trim().replace(/\.$/, '');
        if (isLikelyDjName(m[1].trim())) djs.push(djp);
    }
    // 2. "played by Xyz" patterns
    PLAYED_BY_RE.lastIndex = 0;
    while ((m = PLAYED_BY_RE.exec(allText)) !== null) {
        var dj = cleanDjName(m[1].trim().replace(/\.$/, ''));
        if (isLikelyDjName(dj)) djs.push(dj);
    }
    // 3. "Xyz played/dropped this"
    DJ_PLAYED_RE.lastIndex = 0;
    while ((m = DJ_PLAYED_RE.exec(allText)) !== null) {
        var dj2 = cleanDjName(m[1].trim().replace(/\.$/, ''));
        if (isLikelyDjName(dj2)) djs.push(dj2);
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

// ─── Batch stats fetch (up to 50 IDs per call = 1 quota unit) ────────────────
// Much more efficient than one-at-a-time: 50 videos cost 1 unit vs 50 units.
// Returns a map of { videoId → { viewCount, likeCount, commentCount, descGenres } }

async function batchFetchStats(videoIds, apiKey) {
    if (!videoIds || !videoIds.length) return {};
    // API accepts comma-separated IDs, max 50
    var idsParam = videoIds.slice(0, 50).map(encodeURIComponent).join(',');
    var res = await ytGet(
        '/youtube/v3/videos?part=snippet,statistics&id=' + idsParam,
        apiKey
    );
    var statsMap = {};
    (res.items || []).forEach(function(item) {
        var stats   = item.statistics || {};
        var snippet = item.snippet    || {};
        var descText = (snippet.description || '') + ' ' + (snippet.tags || []).join(' ');
        var descLower = descText.toLowerCase();
        var descGenres = GENRE_KEYWORDS.filter(function(g) { return descLower.includes(g); }).slice(0, 5);
        statsMap[item.id] = {
            viewCount:    stats.viewCount    ? parseInt(stats.viewCount,    10) : null,
            likeCount:    stats.likeCount    ? parseInt(stats.likeCount,    10) : null,
            commentCount: stats.commentCount ? parseInt(stats.commentCount, 10) : null,
            descGenres:   descGenres,
        };
    });
    return statsMap;
}

// ─── Fetch comments for one video ID (1 quota unit) ───────────────────────────

async function fetchComments(videoId, apiKey) {
    var res = await ytGet(
        '/youtube/v3/commentThreads?part=snippet&videoId=' + encodeURIComponent(videoId) +
        '&maxResults=50&order=relevance&textFormat=plainText',
        apiKey
    );
    return (res.items && res.items.length) ? res.items : null;
}

// ─── Fetch video stats + comments for one video ID ───────────────────────────
// Legacy single-video path — still used by validate script.

async function enrichOneVideo(videoId, apiKey) {
    var statsMap = await batchFetchStats([videoId], apiKey);
    var s = statsMap[videoId];
    if (!s) return null;

    var descGenres = s.descGenres || [];
    var commentData = { genres: descGenres, era: [], djs: [], soundsLike: [], rawTop: [] };
    try {
        var items = await fetchComments(videoId, apiKey);
        if (items) {
            var parsed = parseComments(items);
            parsed.genres = [...new Set([...descGenres, ...parsed.genres])].slice(0, 10);
            commentData = parsed;
        }
    } catch(e) {
        // Comments disabled — still use stats
    }

    return { viewCount: s.viewCount, likeCount: s.likeCount, commentCount: s.commentCount, commentData };
}

// ─── Key pool helper ──────────────────────────────────────────────────────────
// Accepts a single key string OR an array. Returns a non-empty array of strings.

function resolveKeys(apiKeys) {
    if (!apiKeys) return [];
    if (typeof apiKeys === 'string') return apiKeys ? [apiKeys] : [];
    return apiKeys.filter(Boolean);
}

// ─── Main enrichment job ──────────────────────────────────────────────────────

var _enrichActive = false;

async function runYouTubeEnrichment(apiKeys, opts) {
    var keys = resolveKeys(apiKeys);
    if (!keys.length) { console.log('[yt-enrich] No API keys — skipping'); return; }
    if (_enrichActive) { console.log('[yt-enrich] Already running'); return; }
    _enrichActive = true;

    opts = opts || {};
    // Scale batch with number of keys: 80 items × keys (each key has 10k quota)
    var batchSize = opts.batchSize || (80 * keys.length);
    var delayMs   = opts.delayMs   || 3000; // 3s gap = 20/min per key, polite

    console.log('[yt-enrich] Using', keys.length, 'API key(s) — batch size', batchSize);

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
                youtube_comment_count = ?,
                youtube_comment_data  = ?,
                youtube_enriched_at   = datetime('now')
            WHERE discogs_id = ?
        `);

        // ── Phase 1: Batch-fetch stats (50 videos per API call = 1 unit per 50) ──
        // Key rotation: on quota error, mark the key exhausted and try the next one.
        // If all keys are exhausted, log and stop — will retry next enrichment cycle.
        var statsCache = {};
        var STATS_BATCH = 50;
        var keyIdx = 0;
        var exhaustedKeys = new Set(); // keys known to be quota-exhausted this run

        for (var b = 0; b < items.length; b += STATS_BATCH) {
            var batch = items.slice(b, b + STATS_BATCH);
            var batchIds = batch.map(function(it) { return it.youtube_video_id; });
            var batchNum = Math.floor(b / STATS_BATCH) + 1;

            // Try each available key until one works
            var fetched = false;
            for (var attempt = 0; attempt < keys.length; attempt++) {
                var batchKey = keys[keyIdx % keys.length];
                keyIdx++;
                if (exhaustedKeys.has(batchKey)) continue;

                try {
                    var batchStats = await batchFetchStats(batchIds, batchKey);
                    Object.assign(statsCache, batchStats);
                    console.log('[yt-enrich] Stats batch', batchNum,
                        '— fetched', Object.keys(batchStats).length, 'of', batch.length,
                        '| key #' + ((keyIdx - 1) % keys.length + 1));
                    fetched = true;
                    break;
                } catch(e) {
                    if (e.quotaExceeded) {
                        console.warn('[yt-enrich] Key #' + ((keyIdx - 1) % keys.length + 1) + ' quota exceeded — rotating to next key');
                        exhaustedKeys.add(batchKey);
                    } else {
                        console.warn('[yt-enrich] Stats batch', batchNum, 'failed:', e.message);
                        break; // Non-quota error — don't rotate, just skip this batch
                    }
                }
            }

            if (!fetched && exhaustedKeys.size >= keys.length) {
                console.warn('[yt-enrich] All', keys.length, 'API keys quota-exhausted — stopping enrichment for today');
                break;
            }

            if (b + STATS_BATCH < items.length) {
                await new Promise(function(r) { setTimeout(r, 1000); }); // 1s between stat batches
            }
        }

        // ── Phase 2: Fetch comments individually (1 unit per video, can't batch) ──
        // Reuses exhaustedKeys set from Phase 1 — skips keys already burned out.
        var done = 0;
        var commentKeyIdx = 0;
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var s    = statsCache[item.youtube_video_id];
            if (!s) {
                // Stats missing — video deleted, invalid ID, or all keys exhausted in Phase 1
                continue;
            }

            // Pick a non-exhausted key for comments
            var key = null;
            for (var ka = 0; ka < keys.length; ka++) {
                var candidate = keys[commentKeyIdx % keys.length];
                commentKeyIdx++;
                if (!exhaustedKeys.has(candidate)) { key = candidate; break; }
            }
            if (!key) {
                console.warn('[yt-enrich] No keys left for comments — saving stats only');
                upsert.run(s.viewCount, s.likeCount, s.commentCount, JSON.stringify({ genres: s.descGenres || [], era: [], djs: [], soundsLike: [], rawTop: [] }), item.discogs_id);
                done++;
                continue;
            }

            var descGenres  = s.descGenres || [];
            var commentData = { genres: descGenres, era: [], djs: [], soundsLike: [], rawTop: [] };
            try {
                var commentItems = await fetchComments(item.youtube_video_id, key);
                if (commentItems) {
                    var parsed = parseComments(commentItems);
                    parsed.genres = [...new Set([...descGenres, ...parsed.genres])].slice(0, 10);
                    commentData = parsed;
                }
            } catch(e) {
                if (e.quotaExceeded) {
                    console.warn('[yt-enrich] Comment key quota exceeded — rotating');
                    exhaustedKeys.add(key);
                }
                // else: comments disabled or network error — still save stats
            }

            upsert.run(s.viewCount, s.likeCount, s.commentCount, JSON.stringify(commentData), item.discogs_id);
            done++;

            if (i % 10 === 0) {
                console.log('[yt-enrich]', i + 1, '/', items.length,
                    '| views:', s.viewCount,
                    '| likes:', s.likeCount,
                    '| comments:', s.commentCount,
                    '| genres:', (commentData.genres || []).slice(0, 3).join(', '));
            }

            if (i < items.length - 1) {
                await new Promise(function(r) { setTimeout(r, delayMs); });
            }
        }
        console.log('[yt-enrich] Done —', done, '/', items.length, 'items enriched',
            exhaustedKeys.size > 0 ? '(' + exhaustedKeys.size + ' key(s) quota-exhausted)' : '');
    } catch(e) {
        console.error('[yt-enrich] Fatal:', e.message);
    } finally {
        _enrichActive = false;
    }
}

// ─── YouTube search: find video ID by artist + title ─────────────────────────
// Costs 100 quota units per search — use sparingly.
// Called for releases that have no Discogs-linked video.

/**
 * Search YouTube for a release video ID.
 * Primary: Discogs `videos[]` data is already extracted for free during meta-sync.
 * This is the fallback for releases Discogs editors didn't link to YouTube.
 *
 * Query strategy (best → worst precision):
 *   1. artist + title + label   (most specific — label narrows to the right pressing)
 *   2. artist + title           (fallback if label yields nothing)
 *
 * Each call = 100 quota units. 10k/day free → max 100 searches/day.
 * We run 90/day leaving headroom for enrichment (~200-300 units/day).
 */
async function searchVideoId(artist, title, apiKey, opts) {
    opts = opts || {};
    var label = opts.label || '';

    // Build the most specific query first (include label if we have it)
    var baseQuery = (artist + ' ' + title).replace(/\s+/g, ' ').trim();
    var fullQuery = label ? (baseQuery + ' ' + label).slice(0, 120) : baseQuery.slice(0, 100);

    // Words to ignore when checking artist name match (too generic to be useful)
    var IGNORE_ARTIST_WORDS = new Set(['various', 'artists', 'artist', 'feat', 'with', 'and', 'the', 'von', 'de', 'el', 'la']);

    // Extract meaningful words from artist name for validation
    var artistWords = artist.toLowerCase()
        .replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(function(w){ return w.length >= 3 && !IGNORE_ARTIST_WORDS.has(w); });

    // Extract meaningful words from title
    var titleWords = title.toLowerCase()
        .replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(function(w){ return w.length >= 4; });

    function isVideoRelevant(item) {
        if (!item || !item.snippet) return false;
        var videoTitle   = (item.snippet.title        || '').toLowerCase();
        var channelName  = (item.snippet.channelTitle || '').toLowerCase();
        var combined = videoTitle + ' ' + channelName;

        // At least one artist word must appear in title or channel name
        var artistMatch = artistWords.length === 0 ||
            artistWords.some(function(w){ return combined.includes(w); });

        // At least one title word must appear (prevents total mismatches)
        var titleMatch = titleWords.length === 0 ||
            titleWords.some(function(w){ return combined.includes(w); });

        // Accept if EITHER matches — both failing means wrong video
        if (!artistMatch && !titleMatch) {
            console.log('[yt-search] Rejected (mismatch):', item.snippet.title, '| channel:', item.snippet.channelTitle);
            return false;
        }
        return true;
    }

    async function doSearch(q) {
        var res = await ytGet(
            '/youtube/v3/search?part=snippet&type=video&maxResults=1&q=' + encodeURIComponent(q),
            apiKey
        );
        var item = res.items && res.items[0];
        if (!item || !item.id || !item.id.videoId) return null;
        // Validate: reject if the video title/channel don't mention the artist or track
        if (!isVideoRelevant(item)) return null;
        return item.id.videoId;
    }

    // Try with label first; fall back to bare artist+title if nothing found
    var videoId = await doSearch(fullQuery);
    if (!videoId && label) {
        videoId = await doSearch(baseQuery.slice(0, 100));
    }
    return videoId || null;
}

// ─── Background job: populate missing video IDs via YouTube search ────────────
// Fallback for releases where Discogs editors didn't link YouTube.
// Primary path (free, no quota): extractVideoIdFromDiscogs() in meta-sync.
// Quota: 100 units/search × 90/day = 9,000 units. Enrichment uses ~300/day.
// Total ≈ 9,300/day — safely within 10,000/day free tier.

var _searchActive = false;

async function runVideoIdSearch(apiKeys, opts) {
    var keys = resolveKeys(apiKeys);
    if (!keys.length) return;
    if (_searchActive) return;
    _searchActive = true;

    opts = opts || {};
    // Scale batch with key count: 90 searches × keys (100 units each = 9k per key)
    var batchSize = opts.batchSize || (90 * keys.length);
    var delayMs   = opts.delayMs   || 3000; // 3s between searches

    console.log('[yt-search] Using', keys.length, 'API key(s) — batch size', batchSize);

    try {
        var db = require('../db');
        var d  = db.getDb();

        // Find wantlist + collection releases with NO video ID yet.
        // UNION ensures collection-only releases are included (LEFT JOIN missed them).
        // Once found, ID is stored per discogs_id → benefits all users instantly.
        var items = d.prepare(`
            SELECT discogs_id, artist, title, label FROM (
                SELECT w.discogs_id, w.artist, w.title, w.label
                FROM wantlist w
                WHERE w.active = 1 AND w.discogs_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM streaming_metadata sm
                    WHERE sm.discogs_id = w.discogs_id AND sm.youtube_video_id IS NOT NULL
                  )
                UNION
                SELECT c.discogs_id, c.artist, c.title, c.label
                FROM collection c
                WHERE c.discogs_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM streaming_metadata sm
                    WHERE sm.discogs_id = c.discogs_id AND sm.youtube_video_id IS NOT NULL
                  )
            )
            GROUP BY discogs_id
            LIMIT ?
        `).all(batchSize);

        if (!items.length) { console.log('[yt-search] All releases have video IDs'); _searchActive = false; return; }
        console.log('[yt-search] Searching YouTube for', items.length, 'releases without video IDs');

        var found = 0;
        var searchKeyIdx = 0;
        var searchExhausted = new Set();

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item.artist || !item.title) continue;

            // Pick a non-exhausted key (round-robin, skip burned-out keys)
            var key = null;
            for (var ka = 0; ka < keys.length; ka++) {
                var candidate = keys[searchKeyIdx % keys.length];
                searchKeyIdx++;
                if (!searchExhausted.has(candidate)) { key = candidate; break; }
            }
            if (!key) {
                console.warn('[yt-search] All keys quota-exhausted — stopping search');
                break;
            }

            try {
                var videoId = await searchVideoId(item.artist, item.title, key, { label: item.label });
                if (videoId) {
                    db.saveStreamingMetadata(item.discogs_id, { youtubeVideoId: videoId });
                    found++;
                    if (found % 10 === 0) {
                        console.log('[yt-search]', found, 'found |', item.artist, '-', item.title, '→', videoId);
                    }
                }
            } catch(e) {
                if (e.quotaExceeded) {
                    console.warn('[yt-search] Key quota exceeded — rotating');
                    searchExhausted.add(key);
                    i--; // retry this item with next key
                    continue;
                }
                console.warn('[yt-search] Failed for', item.artist, '-', item.title, ':', e.message);
            }
            if (i < items.length - 1) {
                await new Promise(function(r) { setTimeout(r, delayMs); });
            }
        }
        console.log('[yt-search] Done —', found, 'video IDs found out of', items.length, 'searched',
            searchExhausted.size > 0 ? '(' + searchExhausted.size + ' key(s) exhausted)' : '');
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
