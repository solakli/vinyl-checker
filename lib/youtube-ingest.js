/**
 * YouTube taste ingestion
 *
 * Pulls two signals via the YouTube Data API v3:
 *   1. Liked videos  — titles parsed for artist names
 *   2. Subscriptions — channel names (artists/labels you follow)
 *
 * Artist extraction from video titles uses common music video patterns:
 *   "Artist - Title", "Artist | Title", "Artist: Title"
 *   "Artist ft. X - Title", "Artist @ Venue", "Artist live at ..."
 *   Boiler Room / RA / fabric style: "Artist Name Boiler Room ..."
 */

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// ── Pagination helper ──────────────────────────────────────────

async function fetchAllPages(path, accessToken, maxItems) {
    maxItems = maxItems || 500;
    const items = [];
    let pageToken = null;

    do {
        const url = YT_BASE + path +
            (path.includes('?') ? '&' : '?') +
            'maxResults=50' +
            (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');

        const res = await fetch(url, {
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'Accept': 'application/json'
            }
        });

        if (!res.ok) {
            const body = await res.text();
            console.warn('[youtube-ingest] HTTP', res.status, url, body.slice(0, 120));
            break;
        }

        const data = await res.json();
        if (data.error) {
            console.warn('[youtube-ingest] API error:', data.error.message);
            break;
        }

        items.push(...(data.items || []));
        pageToken = data.nextPageToken || null;
    } while (pageToken && items.length < maxItems);

    return items;
}

// ── Artist name extraction ─────────────────────────────────────

// Noise words that appear after an artist name in typical YT music titles
const NOISE_SUFFIXES = [
    /\s+(boiler\s+room|fabric|resident\s+advisor|ra\s+|dekmantel|live\s+at|live\s+@|at\s+|@\s+|-\s+live|-\s+set|full\s+set|dj\s+set|recorded\s+live|official\s+video|official\s+audio|music\s+video|\(official|\[official|feat\.|ft\.|vs\.?)/i
];

const SPLIT_PATTERNS = [
    / [-–—] /,   // "Artist - Title"
    / [|｜] /,  // "Artist | Title"
    /: /,        // "Artist: Title"
];

function extractArtistFromTitle(title) {
    if (!title) return null;

    // Try split patterns first — most reliable
    for (const pat of SPLIT_PATTERNS) {
        const parts = title.split(pat);
        if (parts.length >= 2) {
            let candidate = parts[0].trim();
            // Clean noise from the candidate (e.g. "Kerri Chandler Boiler Room" → "Kerri Chandler")
            for (const noise of NOISE_SUFFIXES) {
                candidate = candidate.replace(noise, '').trim();
            }
            // Reject if too long (likely a full sentence, not an artist name)
            if (candidate.length > 0 && candidate.length < 60) {
                return candidate;
            }
        }
    }

    // Fallback: strip noise from the whole title
    let cleaned = title;
    for (const noise of NOISE_SUFFIXES) {
        const match = cleaned.search(noise);
        if (match > 2) {
            cleaned = cleaned.slice(0, match).trim();
            break;
        }
    }

    if (cleaned.length > 0 && cleaned.length < 60 && cleaned !== title) {
        return cleaned;
    }

    return null;
}

// ── Main ingestion functions ───────────────────────────────────

/**
 * Fetch liked videos and extract artist names from titles.
 * Returns array of { artist, title, videoId }
 */
async function getLikedVideos(accessToken, maxItems) {
    maxItems = maxItems || 500;
    const items = await fetchAllPages(
        '/videos?part=snippet&myRating=liked',
        accessToken,
        maxItems
    );

    return items.map(function(item) {
        const snippet = item.snippet || {};
        const title = snippet.title || '';
        const channelTitle = snippet.videoOwnerChannelTitle || snippet.channelTitle || '';

        // Try title parsing first, fall back to channel name
        const artist = extractArtistFromTitle(title) || cleanChannelName(channelTitle);

        return {
            artist: artist,
            title: title,
            videoId: item.id,
            channelTitle: channelTitle
        };
    }).filter(function(v) { return v.artist && v.artist.length > 1; });
}

/**
 * Fetch subscribed channels — direct artist/label signals.
 * Returns array of channel names.
 */
async function getSubscriptions(accessToken, maxItems) {
    maxItems = maxItems || 300;
    const items = await fetchAllPages(
        '/subscriptions?part=snippet&mine=true&order=relevance',
        accessToken,
        maxItems
    );

    return items.map(function(item) {
        const title = (item.snippet && item.snippet.title) || '';
        return cleanChannelName(title);
    }).filter(Boolean);
}

/**
 * Strip common YouTube channel suffix noise:
 * "Boiler Room", "Official", "VEVO", "Music", "Records", "TV" etc.
 */
function cleanChannelName(name) {
    if (!name) return null;
    return name
        .replace(/\s*[-–|]\s*(?:official|vevo|music|records|tv|channel|videos?|boiler\s*room|topic)\s*$/i, '')
        .replace(/\s*(?:vevo|official|topic)$/i, '')
        .replace(/\s*-\s*topic$/i, '')  // YouTube auto-generated "Artist - Topic" channels
        .trim();
}

/**
 * Full ingest: liked videos + subscriptions.
 * Returns { likedArtists, subscriptions, allArtists, counts }
 */
async function ingestAll(accessToken) {
    const [liked, subs] = await Promise.all([
        getLikedVideos(accessToken, 500),
        getSubscriptions(accessToken, 300)
    ]);

    // Deduplicate into a unified artist list
    const seen = new Set();
    const allArtists = [];

    liked.forEach(function(v) {
        const norm = v.artist.toLowerCase();
        if (!seen.has(norm)) { seen.add(norm); allArtists.push(v.artist); }
    });

    subs.forEach(function(name) {
        const norm = name.toLowerCase();
        if (!seen.has(norm)) { seen.add(norm); allArtists.push(name); }
    });

    return {
        likedArtists: liked,
        subscriptions: subs,
        allArtists: allArtists,
        counts: {
            liked: liked.length,
            subscriptions: subs.length
        }
    };
}

module.exports = { ingestAll, getLikedVideos, getSubscriptions, extractArtistFromTitle };
