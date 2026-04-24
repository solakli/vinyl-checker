/**
 * Mix Resolver — tracklist waterfall
 *
 * For a given SoundCloud / YouTube / Mixcloud URL, attempts to find the
 * tracklist using each source in order, stopping as soon as one succeeds:
 *
 *   1. Mixcloud native tracklist API      (when URL is Mixcloud)
 *   2. Description parsing                (existing logic)
 *   3. Comments                           (SC comments API / YT Data API)
 *   4. ACRCloud audio fingerprinting      (if ACRCLOUD keys are configured)
 *
 * Each step records itself in result.steps[] so the UI can show progress.
 */

const { parseTracklistFromDescription } = require('./soundcloud');

// ─── Platform detection ───────────────────────────────────────────────────────

function detectPlatform(url) {
    if (/soundcloud\.com/i.test(url))    return 'soundcloud';
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/mixcloud\.com/i.test(url))      return 'mixcloud';
    return null;
}

function extractYoutubeId(url) {
    let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function extractMixcloudSlug(url) {
    // https://www.mixcloud.com/{user}/{slug}/  → /{user}/{slug}/
    const m = url.match(/mixcloud\.com(\/[^/?#]+\/[^/?#]+)/);
    return m ? m[1].replace(/\/$/, '') : null;
}

// ─── Step helpers ─────────────────────────────────────────────────────────────

function makeStep(name, status, detail) {
    return { name, status, detail: detail || null };
}

// ─── 1. Mixcloud native tracklist ────────────────────────────────────────────

/**
 * Fetch Mixcloud metadata + native tracklist in one pass.
 * Returns: { artists[], rawTracks[], meta, step }
 */
async function fetchMixcloudTracklist(url) {
    const slug = extractMixcloudSlug(url);
    if (!slug) return { artists: [], meta: null, step: makeStep('Mixcloud tracklist', 'skip', 'Could not parse URL') };

    let meta = null;
    try {
        // Fetch metadata and tracks in parallel
        const [metaRes, tracksRes] = await Promise.all([
            fetch('https://api.mixcloud.com' + slug + '/'),
            fetch('https://api.mixcloud.com' + slug + '/tracks/?limit=100')
        ]);

        if (metaRes.ok) {
            const md = await metaRes.json();
            meta = {
                title:       md.name         || null,
                artist:      md.user && md.user.name || null,
                description: md.description  || '',
                artworkUrl:  md.pictures && md.pictures.large || null
            };
        }

        if (!tracksRes.ok) {
            return { artists: [], meta, step: makeStep('Mixcloud tracklist', tracksRes.status === 404 ? 'none' : 'fail', 'No tracklist on this cloudcast') };
        }

        const data   = await tracksRes.json();
        const tracks = data.data || [];

        if (tracks.length === 0) {
            return { artists: [], meta, step: makeStep('Mixcloud tracklist', 'none', 'No tracklist on this cloudcast') };
        }

        const seen    = new Set();
        const artists = [];
        tracks.forEach(function(t) {
            const name = t.artist && t.artist.name;
            if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                artists.push(name);
            }
        });

        return {
            artists,
            rawTracks: tracks.map(function(t) {
                return {
                    artist:    t.artist && t.artist.name || null,
                    title:     t.track  && t.track.name  || null,
                    startTime: t.start_time || null
                };
            }),
            meta,
            step: makeStep('Mixcloud tracklist', 'ok', artists.length + ' artists from official tracklist')
        };
    } catch (e) {
        return { artists: [], meta, step: makeStep('Mixcloud tracklist', 'fail', e.message) };
    }
}

// ─── 2. Description ───────────────────────────────────────────────────────────

function checkDescription(description) {
    if (!description) return { artists: [], step: makeStep('Description', 'none', 'No description') };
    const artists = parseTracklistFromDescription(description);
    if (artists.length === 0) return { artists: [], step: makeStep('Description', 'none', 'No tracklist in description') };
    return { artists, step: makeStep('Description', 'ok', artists.length + ' artists found in description') };
}

// ─── 3a. SoundCloud comments ─────────────────────────────────────────────────

async function fetchSoundCloudComments(trackId, accessToken) {
    if (!accessToken) {
        return { artists: [], step: makeStep('SoundCloud comments', 'skip', 'Not connected to SoundCloud') };
    }
    try {
        const res  = await fetch('https://api.soundcloud.com/tracks/' + trackId + '/comments?limit=200', {
            headers: { 'Authorization': 'OAuth ' + accessToken }
        });
        if (!res.ok) {
            return { artists: [], step: makeStep('SoundCloud comments', 'fail', 'HTTP ' + res.status) };
        }
        const data     = await res.json();
        const comments = Array.isArray(data) ? data : (data.collection || []);
        return parseCommentsForTracklist(comments.map(function(c) { return c.body || ''; }), 'SoundCloud comments');
    } catch (e) {
        return { artists: [], step: makeStep('SoundCloud comments', 'fail', e.message) };
    }
}

// ─── 3b. YouTube comments ─────────────────────────────────────────────────────

async function fetchYouTubeComments(videoId, accessToken) {
    // Prefer API key (no user re-auth needed) → fall back to OAuth token
    const ytApiKey = process.env.YOUTUBE_API_KEY;

    let url = 'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=' + videoId + '&order=relevance&maxResults=100&textFormat=plainText';
    const headers = {};

    if (ytApiKey) {
        url += '&key=' + ytApiKey;
    } else if (accessToken) {
        headers['Authorization'] = 'Bearer ' + accessToken;
    } else {
        return { artists: [], step: makeStep('YouTube comments', 'skip', 'No YOUTUBE_API_KEY or Google token') };
    }

    try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
            const body = await res.text();
            let hint = 'HTTP ' + res.status;
            try {
                const err = JSON.parse(body);
                hint = err.error && err.error.message || hint;
            } catch(_) {}
            return { artists: [], step: makeStep('YouTube comments', 'fail', hint) };
        }
        const data     = await res.json();
        const comments = (data.items || []).map(function(item) {
            return item.snippet.topLevelComment.snippet.textOriginal || '';
        });
        return parseCommentsForTracklist(comments, 'YouTube comments');
    } catch (e) {
        return { artists: [], step: makeStep('YouTube comments', 'fail', e.message) };
    }
}

/**
 * Given an array of comment strings, find the best tracklist comment
 * and extract artists from it.
 */
function parseCommentsForTracklist(commentTexts, sourceName) {
    if (!commentTexts || commentTexts.length === 0) {
        return { artists: [], step: makeStep(sourceName, 'none', 'No comments') };
    }

    // Score each comment for tracklist likelihood
    function scoreComment(text) {
        const lines     = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
        const hasTs     = lines.filter(function(l) { return /^\d{1,2}:\d{2}/.test(l); }).length;
        const hasNum    = lines.filter(function(l) { return /^\d{1,3}[\.\)]\s+\S/.test(l); }).length;
        const hasDash   = lines.filter(function(l) { return /\s[-–]\s/.test(l); }).length;
        return hasTs * 3 + hasNum * 3 + hasDash + (lines.length > 10 ? 5 : 0);
    }

    const scored = commentTexts
        .map(function(text) { return { text, score: scoreComment(text) }; })
        .filter(function(c) { return c.score >= 5; })
        .sort(function(a, b) { return b.score - a.score; });

    if (scored.length === 0) {
        return { artists: [], step: makeStep(sourceName, 'none', 'No tracklist found in comments') };
    }

    // Try the top-scoring comment
    const best    = scored[0].text;
    const artists = parseTracklistFromDescription(best);

    if (artists.length === 0) {
        return { artists: [], step: makeStep(sourceName, 'none', 'Comments found but could not extract artists') };
    }

    return {
        artists,
        step: makeStep(sourceName, 'ok', artists.length + ' artists from ' + sourceName.toLowerCase())
    };
}

// ─── 4. Audio fingerprinting — Shazam (RapidAPI) primary, ACRCloud fallback ──

/**
 * Sample a mix URL at 5 offsets, identify each segment via Shazam (RapidAPI)
 * with ACRCloud as fallback. Matches the Ronaut Radio track_identifier pattern.
 *
 * Requires in .env:
 *   RAPIDAPI_KEY           — Shazam via RapidAPI (primary)
 *   ACRCLOUD_ACCESS_KEY + ACRCLOUD_ACCESS_SECRET + ACRCLOUD_HOST (fallback)
 *
 * Also requires: yt-dlp + ffmpeg on PATH.
 */
async function acrcloudFingerprint(url, platform, tokens) {
    const rapidApiKey  = process.env.RAPIDAPI_KEY;
    const acrKey       = process.env.ACRCLOUD_ACCESS_KEY;
    const acrSecret    = process.env.ACRCLOUD_ACCESS_SECRET;
    const acrHost      = process.env.ACRCLOUD_HOST || 'identify-eu-west-1.acrcloud.com';

    const hasShazam  = !!rapidApiKey;
    const hasAcr     = !!(acrKey && acrSecret);

    if (!hasShazam && !hasAcr) {
        return {
            artists: [],
            step: makeStep('Audio fingerprinting', 'skip',
                'Add RAPIDAPI_KEY (Shazam) or ACRCLOUD_* keys to .env to enable')
        };
    }

    const { execSync, execFileSync } = require('child_process');
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');
    const https = require('https');

    // ── locate yt-dlp ─────────────────────────────────────────────────────────
    let ytdlpPath = null;
    for (const c of ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp']) {
        try { execSync(c + ' --version', { stdio: 'ignore' }); ytdlpPath = c; break; } catch(_) {}
    }
    if (!ytdlpPath) {
        return { artists: [], step: makeStep('Audio fingerprinting', 'skip', 'yt-dlp not found — run: pip3 install yt-dlp') };
    }

    // ── locate ffmpeg ─────────────────────────────────────────────────────────
    let ffmpegPath = null;
    for (const c of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
        try { execSync(c + ' -version', { stdio: 'ignore' }); ffmpegPath = c; break; } catch(_) {}
    }
    if (!ffmpegPath) {
        return { artists: [], step: makeStep('Audio fingerprinting', 'skip', 'ffmpeg not found') };
    }

    // ── Shazam identify via RapidAPI (raw PCM, same format as Ronaut Radio) ──
    function shazamIdentify(rawPcmPath) {
        return new Promise(function(resolve) {
            try {
                var audioData = fs.readFileSync(rawPcmPath);
                var audiob64  = audioData.toString('base64');
                var opts = {
                    hostname: 'shazam.p.rapidapi.com',
                    path:     '/songs/v3/detect',
                    method:   'POST',
                    headers:  {
                        'Content-Type':  'text/plain',
                        'x-rapidapi-host': 'shazam.p.rapidapi.com',
                        'x-rapidapi-key':  rapidApiKey,
                    }
                };
                var req = https.request(opts, function(res) {
                    var data = '';
                    res.on('data', function(c) { data += c; });
                    res.on('end', function() {
                        try {
                            var json = JSON.parse(data);
                            var matches = (json.results || {}).matches || [];
                            if (!matches.length) return resolve(null);
                            var resources = json.resources || {};
                            var albums = resources.albums || {};
                            var artists = resources.artists || {};
                            var albumInfo = {};
                            for (var k in albums) { albumInfo = albums[k].attributes || {}; break; }
                            var artistName = '';
                            for (var k in artists) { artistName = (artists[k].attributes || {}).name || ''; break; }
                            var fullArtist = albumInfo.artistName || artistName;
                            var title = (albumInfo.name || '').replace(' - Single', '');
                            if (!fullArtist) return resolve(null);
                            resolve({ artist: fullArtist, title: title, source: 'shazam' });
                        } catch(e) { resolve(null); }
                    });
                });
                req.on('error', function() { resolve(null); });
                req.write(audiob64);
                req.end();
            } catch(e) { resolve(null); }
        });
    }

    // ── ACRCloud identify (fallback) ──────────────────────────────────────────
    async function acrIdentify(mp3Path) {
        if (!hasAcr) return null;
        try {
            const ACRCloud = require('acrcloud');
            const acr = new ACRCloud({ host: acrHost, access_key: acrKey, access_secret: acrSecret });
            const audioData = fs.readFileSync(mp3Path);
            const result    = await acr.identify(audioData);
            const music = result && result.metadata && result.metadata.music && result.metadata.music[0];
            if (!music) return null;
            const artistName = music.artists && music.artists[0] && music.artists[0].name;
            if (!artistName) return null;
            return { artist: artistName, title: music.title || null, source: 'acrcloud' };
        } catch(e) { return null; }
    }

    // ── sample the mix at 5 offsets ───────────────────────────────────────────
    const OFFSETS  = [120, 600, 1200, 2100, 3000]; // seconds into the mix
    const DURATION = hasShazam ? 5 : 12;           // Shazam needs only 5s; ACR needs 12s
    const tmpDir   = os.tmpdir();
    const identified = [];
    const seen       = new Set();

    for (const offset of OFFSETS) {
        const end       = offset + DURATION;
        const rawFile   = path.join(tmpDir, 'gd_shazam_' + offset + '_' + Date.now() + '.raw');
        const mp3File   = path.join(tmpDir, 'gd_acr_'    + offset + '_' + Date.now() + '.mp3');
        try {
            // Download just this segment via yt-dlp
            execSync(
                `"${ytdlpPath}" -x --audio-format mp3 --audio-quality 5 ` +
                `--download-sections "*${offset}-${end}" ` +
                `--ffmpeg-location "${ffmpegPath}" ` +
                `-o "${mp3File}" "${url}" --quiet --no-warnings`,
                { timeout: 60000, stdio: 'ignore' }
            );
            if (!fs.existsSync(mp3File)) continue;

            var track = null;

            if (hasShazam) {
                // Convert mp3 → raw PCM for Shazam (44100Hz mono 16-bit)
                execSync(
                    `"${ffmpegPath}" -y -i "${mp3File}" -f s16le -ar 44100 -ac 1 "${rawFile}" -loglevel quiet`,
                    { timeout: 15000, stdio: 'ignore' }
                );
                if (fs.existsSync(rawFile)) {
                    track = await shazamIdentify(rawFile);
                    try { fs.unlinkSync(rawFile); } catch(_) {}
                }
            }

            // ACRCloud fallback
            if (!track && hasAcr) {
                track = await acrIdentify(mp3File);
            }

            try { fs.unlinkSync(mp3File); } catch(_) {}

            if (track && track.artist && !seen.has(track.artist.toLowerCase())) {
                seen.add(track.artist.toLowerCase());
                identified.push({ artist: track.artist, title: track.title, offsetSec: offset, source: track.source });
            }
        } catch(e) {
            try { fs.unlinkSync(rawFile); } catch(_) {}
            try { fs.unlinkSync(mp3File); } catch(_) {}
        }
        // Small delay between API calls
        await new Promise(function(r) { setTimeout(r, 500); });
    }

    if (identified.length === 0) {
        return { artists: [], step: makeStep('Audio fingerprinting', 'none', 'No tracks identified') };
    }

    var apiUsed = [...new Set(identified.map(function(t) { return t.source; }))].join('+');
    return {
        artists:   identified.map(function(t) { return t.artist; }),
        rawTracks: identified,
        step: makeStep('Audio fingerprinting', 'ok',
            identified.length + ' tracks identified via ' + apiUsed)
    };
}

// ─── SoundCloud + YouTube metadata resolvers ──────────────────────────────────

async function resolveSoundCloud(url, accessToken) {
    if (!accessToken) return { error: 'Connect SoundCloud first', meta: null };
    try {
        const res = await fetch('https://api.soundcloud.com/resolve?url=' + encodeURIComponent(url), {
            headers: { 'Authorization': 'OAuth ' + accessToken, 'Accept': 'application/json' }
        });
        if (!res.ok) return { error: 'SoundCloud resolve failed (HTTP ' + res.status + ')', meta: null };
        const data = await res.json();
        return {
            meta: {
                id:          data.id,
                title:       data.title || null,
                artist:      data.user && data.user.username || null,
                description: data.description || '',
                artworkUrl:  data.artwork_url || null
            }
        };
    } catch (e) { return { error: e.message, meta: null }; }
}

async function resolveYoutube(url, accessToken) {
    const videoId = extractYoutubeId(url);
    if (!videoId) return { error: 'Could not extract YouTube video ID', meta: null };

    const ytApiKey = process.env.YOUTUBE_API_KEY;
    let apiUrl = 'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + videoId;
    const headers = {};

    if (ytApiKey)      apiUrl += '&key=' + ytApiKey;
    else if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
    else return { error: 'No YouTube API key or Google token', meta: null };

    try {
        const res = await fetch(apiUrl, { headers });
        if (!res.ok) return { error: 'YouTube API HTTP ' + res.status, meta: null };
        const data = await res.json();
        const item = data.items && data.items[0];
        if (!item) return { error: 'Video not found', meta: null };
        const s = item.snippet || {};
        return {
            meta: {
                id:          videoId,
                title:       s.title || null,
                artist:      s.channelTitle || null,
                description: s.description || '',
                artworkUrl:  s.thumbnails && (s.thumbnails.maxres || s.thumbnails.high) && (s.thumbnails.maxres || s.thumbnails.high).url || null
            }
        };
    } catch (e) { return { error: e.message, meta: null }; }
}

// ─── Main waterfall ───────────────────────────────────────────────────────────

/**
 * Resolve a mix URL using the full tracklist waterfall.
 *
 * Returns:
 * {
 *   platform, title, artist, artworkUrl,
 *   tracklist: string[],          // final artist list
 *   tracklistSource: string,      // which step found it
 *   hasTracklist: boolean,
 *   steps: [{ name, status, detail }]  // waterfall log for UI
 * }
 */
async function resolveMixUrl(url, tokens) {
    tokens = tokens || {};
    const platform = detectPlatform(url.trim());
    const steps    = [];

    if (!platform) {
        return {
            error:   'Unsupported platform. Paste a SoundCloud, YouTube, or Mixcloud URL.',
            tracklist: [],
            steps:   []
        };
    }

    // ── MIXCLOUD: native tracklist → description → ACRCloud ──────────────
    if (platform === 'mixcloud') {
        const { artists, rawTracks, meta: mcMeta, step } = await fetchMixcloudTracklist(url);
        steps.push(step);

        if (artists.length > 0) {
            return buildResult(platform, mcMeta || {}, artists, 'Mixcloud tracklist', steps, rawTracks || null);
        }

        // Description (from cloudcast metadata)
        const descResult = checkDescription(mcMeta && mcMeta.description || '');
        steps.push(descResult.step);
        if (descResult.artists.length > 0) {
            return buildResult(platform, mcMeta || {}, descResult.artists, 'Description', steps);
        }

        steps.push(makeStep('SoundCloud comments', 'skip', 'Not a SoundCloud URL'));
        steps.push(makeStep('YouTube comments',    'skip', 'Not a YouTube URL'));

        const acr = await acrcloudFingerprint(url, platform, tokens);
        steps.push(acr.step);
        return {
            platform,
            tracklist:  acr.artists,
            title:      mcMeta && mcMeta.title     || null,
            artist:     mcMeta && mcMeta.artist    || null,
            artworkUrl: mcMeta && mcMeta.artworkUrl || null,
            hasTracklist: acr.artists.length > 0,
            tracklistSource: 'Audio fingerprinting',
            steps
        };
    }

    // ── SOUNDCLOUD / YOUTUBE: metadata + description + comments ───────────
    let meta = null;

    if (platform === 'soundcloud') {
        const resolved = await resolveSoundCloud(url, tokens.soundcloudToken);
        if (resolved.error) {
            return { platform, error: resolved.error, tracklist: [], steps };
        }
        meta = resolved.meta;
    } else {
        const resolved = await resolveYoutube(url, tokens.googleToken);
        if (resolved.error) {
            return { platform, error: resolved.error, tracklist: [], steps };
        }
        meta = resolved.meta;
    }

    // Step 1: description
    const descResult = checkDescription(meta.description);
    steps.push(descResult.step);
    if (descResult.artists.length > 0) {
        return buildResult(platform, meta, descResult.artists, 'Description', steps);
    }

    // Step 2: comments
    let commentsResult;
    if (platform === 'soundcloud') {
        steps.push(makeStep('YouTube comments', 'skip', 'Not a YouTube URL'));
        commentsResult = await fetchSoundCloudComments(meta.id, tokens.soundcloudToken);
        steps.push(commentsResult.step);
    } else {
        steps.push(makeStep('SoundCloud comments', 'skip', 'Not a SoundCloud URL'));
        commentsResult = await fetchYouTubeComments(meta.id, tokens.googleToken);
        steps.push(commentsResult.step);
    }

    if (commentsResult.artists.length > 0) {
        return buildResult(platform, meta, commentsResult.artists, commentsResult.step.name, steps);
    }

    // Step 3: audio fingerprinting
    const acr = await acrcloudFingerprint(url, platform, tokens);
    steps.push(acr.step);
    if (acr.artists.length > 0) {
        return buildResult(platform, meta, acr.artists, 'Audio fingerprinting', steps, acr.rawTracks || null);
    }

    // Nothing found
    return {
        platform,
        title:      meta.title,
        artist:     meta.artist,
        artworkUrl: meta.artworkUrl,
        tracklist:  [],
        hasTracklist: false,
        tracklistSource: null,
        steps
    };
}

function buildResult(platform, meta, artists, source, steps, rawTracks) {
    return {
        platform,
        title:      meta.title,
        artist:     meta.artist,
        artworkUrl: meta.artworkUrl,
        tracklist:  artists,
        rawTracks:  rawTracks || null,
        hasTracklist: artists.length > 0,
        tracklistSource: source,
        steps
    };
}

// ─── Inventory search (unchanged) ────────────────────────────────────────────

function norm(s) {
    if (!s) return '';
    return s.toLowerCase()
        .replace(/\s*\(\d+\)\s*/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function searchInventoryForTracklist(tracklistArtists, db) {
    if (!tracklistArtists || tracklistArtists.length === 0) return [];

    const rows = db.prepare(
        'SELECT store, artist, title, label, catno, price_usd, url, image_url, product_type FROM store_inventory WHERE available = 1 AND artist IS NOT NULL'
    ).all();

    const targets = tracklistArtists.map(function(a) {
        return { original: a, normalised: norm(a) };
    }).filter(function(t) { return t.normalised.length >= 2; });

    const resultMap  = new Map();
    const recordsMap = new Map();
    targets.forEach(function(t) {
        resultMap.set(t.original, new Set());
        recordsMap.set(t.original, []);
    });

    rows.forEach(function(row) {
        const invArtists = row.artist.split(',').map(function(a) { return a.trim(); });
        for (const invArtist of invArtists) {
            const invNorm = norm(invArtist);
            if (!invNorm) continue;
            for (const target of targets) {
                const matches =
                    invNorm === target.normalised ||
                    invNorm.includes(target.normalised) ||
                    target.normalised.includes(invNorm);
                if (matches) {
                    const key = row.store + '||' + norm(row.artist) + '||' + norm(row.title);
                    if (!resultMap.get(target.original).has(key)) {
                        resultMap.get(target.original).add(key);
                        recordsMap.get(target.original).push({
                            store: row.store, artist: row.artist, title: row.title,
                            label: row.label || null, catno: row.catno || null,
                            priceUsd: row.price_usd, url: row.url,
                            imageUrl: row.image_url || null, productType: row.product_type || null
                        });
                    }
                    break;
                }
            }
        }
    });

    return targets
        .map(function(t) {
            return {
                tracklistArtist: t.original,
                records: recordsMap.get(t.original).sort(function(a, b) { return (a.priceUsd || 999) - (b.priceUsd || 999); })
            };
        })
        .filter(function(r) { return r.records.length > 0; });
}

module.exports = {
    resolveMixUrl,
    searchInventoryForTracklist,
    detectPlatform,
    parseTracklistFromDescription
};
