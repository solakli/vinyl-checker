/**
 * SoundCloud data ingestion
 *
 * Signal hierarchy (highest → lowest):
 *   1. Setlist artists  — artists extracted from tracklists in mix descriptions (weight 4)
 *   2. Liked track artist — performer parsed from mix title (weight 2)
 *   3. Following artist   — accounts the user follows (weight 1)
 *
 * All sources feed into Last.fm expansion in recommender.js.
 */

const SC_API = 'https://api.soundcloud.com';
const PAGE_LIMIT = 200;

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchAllPages(path, accessToken, maxItems) {
    maxItems = maxItems || 500;
    const items = [];
    let offset = 0;

    while (items.length < maxItems) {
        const sep = path.includes('?') ? '&' : '?';
        const url = SC_API + path + sep + 'limit=' + PAGE_LIMIT + '&offset=' + offset + '&linked_partitioning=1';

        const res = await fetch(url, {
            headers: {
                'Authorization': 'OAuth ' + accessToken,
                'Accept': 'application/json; charset=utf-8'
            }
        });

        if (!res.ok) {
            const body = await res.text();
            console.warn('[soundcloud] HTTP', res.status, 'for', url, '-', body.slice(0, 120));
            break;
        }

        const data = await res.json();
        const page = Array.isArray(data) ? data : (data.collection || []);
        if (page.length === 0) break;
        items.push(...page);
        if (page.length < PAGE_LIMIT) break;
        offset += page.length;
    }

    return items;
}

// ─── Title → performer name ───────────────────────────────────────────────────

const LOCATION_PREFIX   = /^(?:recorded|live|broadcast|streaming|performed)\s+(?:at|from|@)\s+/i;
const ARTIST_SUFFIX_NOISE = /\s+(?:mix|edit|remix|set|dj\s+set|vinyl\s+set|live\s+set)$/i;
const SKIP_SOLO_WORDS   = /^(?:recorded|live|broadcast|streaming|set|mix|music|various)$/i;
const DATE_LIKE         = /^\d|(?:january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)/i;

function artistFromTitle(title) {
    if (!title) return null;
    const t = title.trim();

    if (LOCATION_PREFIX.test(t)) {
        const m = t.match(/[-–]\s*(.{3,60})$/);
        return m ? cleanStr(m[1]) : null;
    }

    let m;

    m = t.match(/^(.+?)\s*[-–]\s*(?:live\s+at|recorded\s+at|live\s+@|live\s+from)\b/i);
    if (m) return cleanStr(m[1]);

    m = t.match(/^(.+?)\s+\((?:vinyl|live|recorded|dj)\b/i);
    if (m) return cleanStr(m[1]);

    m = t.match(/^(.{3,50}?)\s*\|\s*/);
    if (m) return cleanStr(m[1]);

    m = t.match(/^(.+?)\s+[Bb]2[Bb]\s+/);
    if (m) return cleanStr(m[1]);

    m = t.match(/^(.+?)\s+@\s+\S/);
    if (m) return cleanStr(m[1]);

    m = t.match(/^(.+?)\s+at\s+[A-Z]/);
    if (m) {
        const c = cleanStr(m[1]);
        if (c && !SKIP_SOLO_WORDS.test(c)) return c;
    }

    if (t.includes(' / ')) {
        const parts = t.split(' / ');
        const first = parts[0].trim();
        const second = parts[1] && parts[1].trim();
        if (/\d+$/.test(first) && second && second.length >= 3 && second.length <= 50) return cleanStr(second);
        if (first.length >= 3 && first.length <= 50 && !/^\d/.test(first)) return cleanStr(first);
    }

    m = t.match(/^.{3,40}?\s+\d{1,4}\s*:\s*(.{3,60})$/);
    if (m) return cleanStr(m[1]);

    m = t.match(/^[A-Z0-9][A-Z0-9\s\.\-]{3,30}\s+\d{1,4}\s*[-–]\s*(.{3,60})$/);
    if (m) return cleanStr(m[1]);

    m = t.match(/^[A-Za-z0-9\s]{3,30}[\.\s]\d{2,4}\s*[-–]\s*(.{3,60})$/);
    if (m) return cleanStr(m[1]);

    m = t.match(/[-–]\s*[Mm]ixed\s+[Bb]y\s+(.{3,50})$/);
    if (m) return cleanStr(m[1]);

    m = t.match(/^(?:[A-Za-z0-9\s\.]{5,35})\s*[-–]\s*([A-Z][A-Za-z0-9\s\&\.\-\']{2,50})$/);
    if (m) {
        const c = cleanStr(m[1]);
        if (c && !DATE_LIKE.test(c)) return c;
    }

    return null;
}

function cleanStr(str) {
    if (!str) return null;
    const s = str.trim()
        .replace(/\s*[\(\[].*/, '')
        .replace(/\s*[-–]?\s*$/, '')
        .replace(ARTIST_SUFFIX_NOISE, '')
        .trim();
    return (s.length >= 2 && s.length <= 60) ? s : null;
}

// ─── Setlist / tracklist extraction ──────────────────────────────────────────

/**
 * Parse a mix description to extract performing artists from the tracklist.
 *
 * Supported formats:
 *   Timestamp:  "00:01 Artist - Track Name"   → artist is LEFT
 *               "1:02:00 Artist - Track Name"
 *   Numbered:   "1. Track Name - Artist"       → artist detection by heuristic
 *               "1.  Artist - Track Name"
 *
 * Returns array of artist name strings (deduplicated).
 */
function parseTracklistFromDescription(description) {
    if (!description || description.length < 30) return [];

    const lines = description.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);

    // Collect candidate lines that look like tracklist entries
    const tsLines   = [];  // timestamp format
    const numLines  = [];  // numbered format
    const plainLines = []; // plain "Artist - Track" lines

    const TS_PAT  = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+?)\s*[–-]\s*(.+)$/;
    const NUM_PAT = /^\d{1,3}[\.\)]\s{1,5}(.+?)\s*[–-]\s*(.+)$/;
    const PLAIN_PAT = /^([A-Z][^\n]{3,40}?)\s*[–-]\s*([A-Z][^\n]{3,50})$/;

    for (const line of lines) {
        // Skip URLs, @handles, very short lines
        if (/^https?:\/\/|^@|^\s*$/.test(line) || line.length < 8) continue;

        let m = line.match(TS_PAT);
        if (m) { tsLines.push({ left: m[2].trim(), right: m[3].trim() }); continue; }

        m = line.match(NUM_PAT);
        if (m) { numLines.push({ left: m[1].trim(), right: m[2].trim() }); continue; }

        m = line.match(PLAIN_PAT);
        if (m) { plainLines.push({ left: m[1].trim(), right: m[2].trim() }); }
    }

    const artistNames = [];

    // Timestamp format: artist is on the LEFT of the dash
    for (const entry of tsLines) {
        const candidates = extractArtistsFromSide(entry.left, entry.right, 'left');
        artistNames.push(...candidates);
    }

    // Numbered format: detect which side is the artist
    if (numLines.length > 0) {
        const side = detectArtistSide(numLines);
        for (const entry of numLines) {
            const candidates = extractArtistsFromSide(entry.left, entry.right, side);
            artistNames.push(...candidates);
        }
    }

    // Plain "Artist - Track" lines (less common, treat left as artist)
    if (tsLines.length === 0 && numLines.length === 0) {
        for (const entry of plainLines) {
            const candidates = extractArtistsFromSide(entry.left, entry.right, 'left');
            artistNames.push(...candidates);
        }
    }

    const REJECT_SETLIST = /^\d|^(?:the\s+)?(?:tracklist|playlist|set\s+list)|(?:summer|winter|spring|autumn|fall)\s+\d{2}/i;

    // Normalise whitespace and deduplicate case-insensitively
    const seen = new Set();
    return artistNames
        .map(function(a) { return a.replace(/\s{2,}/g, ' ').trim(); }) // collapse multi-spaces
        .filter(function(a) { return a && a.length >= 2 && a.length <= 60 && !REJECT_SETLIST.test(a); })
        .filter(function(a) {
            const k = a.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
}

/**
 * Determine whether the artist name is on the 'left' or 'right' side of the dash
 * for a set of numbered tracklist entries.
 *
 * Heuristic: the side that more often contains remix/mix/edit qualifiers is the
 * TRACK side — so the OTHER side is the artist.
 */
function detectArtistSide(entries) {
    const MIX_QUAL = /\b(?:mix|remix|edit|dub|rework|version|bootleg|vocal|instrumental|reprise)\b/i;
    let leftMix = 0, rightMix = 0;

    for (const e of entries) {
        if (MIX_QUAL.test(e.left))  leftMix++;
        if (MIX_QUAL.test(e.right)) rightMix++;
    }

    // If left side has more mix qualifiers → left is track → artist is RIGHT
    if (leftMix > rightMix) return 'right';
    // If right side has more mix qualifiers → right is track → artist is LEFT
    if (rightMix > leftMix) return 'left';

    // Tie-break: artist names tend to be shorter
    const avgLeft  = entries.reduce(function(s, e) { return s + e.left.length; }, 0) / entries.length;
    const avgRight = entries.reduce(function(s, e) { return s + e.right.length; }, 0) / entries.length;
    return avgLeft <= avgRight ? 'left' : 'right';
}

/**
 * Extract artist name(s) from one side of a tracklist entry.
 *
 * For timestamp format (side='left') with multi-dash titles like:
 *   "Anti - Gravity (Kenlou Dubb) - Krust"
 * we re-check if the left looks like a track title and use the last dash segment.
 */
function extractArtistsFromSide(left, right, side) {
    let raw = (side === 'left' ? left : right) || '';
    if (!raw) return [];

    // For 'right' side: if it still contains a dash it may be "Track (Mix) - Artist"
    // Use word-boundary-free match so "Dubb", "Kenlou Dub", etc. are caught
    if (side === 'right' && raw.includes(' - ')) {
        const lastDash = raw.lastIndexOf(' - ');
        const afterLast = raw.slice(lastDash + 3).trim();
        const leftPart  = raw.slice(0, lastDash).trim();
        const hasMixLeft = /(?:mix|remix|edit|dub|version|rework|bootleg)/i.test(leftPart);
        if (hasMixLeft && afterLast.length >= 2 && afterLast.length <= 60) {
            raw = afterLast;
        }
    }

    // Strip feat/ft suffixes
    let s = raw.replace(/\s*(?:feat\.?|ft\.?|featuring|vs\.?)\s+.+$/i, '').trim();
    // Strip remix/mix qualifiers in parentheses
    s = s.replace(/\s*\([^)]*(?:mix|remix|edit|dub|version|rework|bootleg|live)[^)]*\)/gi, '').trim();
    // Strip trailing punctuation / year
    s = s.replace(/[,;]\s*$/, '').replace(/\s*\(?20\d\d\)?$/, '').trim();

    if (!s || s.length < 2) return [];

    // Split comma-separated collaborators: "Earth Trax, Newborn Jr., Annjet"
    const commaParts = s.split(/\s*,\s*/);
    if (commaParts.length > 1 && commaParts.every(function(p) { return p.trim().length >= 2; })) {
        return commaParts.map(function(p) { return p.trim(); }).filter(function(p) { return p.length >= 2 && p.length <= 60; });
    }

    // Split on " / " for slash-separated artists (keep "&" duos together)
    const parts = s.split(/\s*\/\s*/);
    return parts
        .map(function(p) { return p.trim(); })
        .filter(function(p) { return p.length >= 2 && p.length <= 60; });
}

function extractArtist(track) {
    if (!track) return null;
    if (track.publisher_metadata && track.publisher_metadata.artist) {
        return track.publisher_metadata.artist.trim();
    }
    if (track.title) {
        const fromTitle = artistFromTitle(track.title);
        if (fromTitle) return fromTitle;
    }
    if (track.user && track.user.username) {
        return track.user.username.trim();
    }
    return null;
}

// ─── API fetchers ─────────────────────────────────────────────────────────────

async function getPlayHistory(accessToken, maxItems) {
    return []; // not available in v1 official API
}

/**
 * Fetch liked tracks including descriptions.
 * Returns array of { artist, title, setlistArtists[] }
 */
async function getLikedTracks(accessToken, maxItems) {
    maxItems = maxItems || 500;
    const items = await fetchAllPages('/me/favorites', accessToken, maxItems);

    return items.map(function(track) {
        const setlistArtists = parseTracklistFromDescription(track.description || '');
        return {
            artist: extractArtist(track),
            title: track.title || null,
            description: track.description || null,
            setlistArtists: setlistArtists
        };
    }).filter(function(t) { return t.artist || t.setlistArtists.length > 0; });
}

const PERSONAL_ACCOUNT_PATTERNS = [
    /\d{2,}/,
    /^(mr|mrs|ms|dr)[\s\.]/i,
];
const NOISE_KEYWORDS = new Set([
    'festival', 'records', 'radio', 'fm', 'station', 'podcast', 'sessions',
    'nightclub', 'club', 'bar', 'lounge', 'music group', 'collective',
    'management', 'agency', 'booking', 'promo', 'promotion', 'promotions',
    'selects', 'shows', 'show', 'official',
]);

function looksLikeArtist(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    for (const kw of NOISE_KEYWORDS) {
        if (lower.includes(kw)) return false;
    }
    for (const pat of PERSONAL_ACCOUNT_PATTERNS) {
        if (pat.test(name)) return false;
    }
    return true;
}

async function getFollowings(accessToken, maxItems) {
    maxItems = maxItems || 300;
    const items = await fetchAllPages('/me/followings', accessToken, maxItems);
    return items
        .map(function(user) { return user.full_name || user.username || null; })
        .filter(Boolean)
        .filter(looksLikeArtist);
}

// ─── Full ingest with weighted signals ───────────────────────────────────────

/**
 * Full ingest: combine all sources into a weighted artist list.
 *
 * Returns:
 *   weightedArtists: Array of { name, weight } sorted by weight desc
 *   allArtists: flat unique list (for backward compat, ordered by weight)
 *   counts: { history, likes, followings, setlistTracks, setlistArtists }
 */
async function ingestAll(accessToken) {
    const [history, likes, followings] = await Promise.all([
        getPlayHistory(accessToken, 500),
        getLikedTracks(accessToken, 500),
        getFollowings(accessToken, 300)
    ]);

    // Weight map: name.toLowerCase() → { name, weight }
    const weightMap = new Map();

    function addArtist(name, weight) {
        if (!name || name.length < 2) return;
        const key = name.toLowerCase();
        const existing = weightMap.get(key);
        if (existing) {
            existing.weight = Math.max(existing.weight, weight);
        } else {
            weightMap.set(key, { name: name, weight: weight });
        }
    }

    // Setlist artists — highest signal (weight 4)
    // These are artists the user heard inside mixes they loved enough to like
    let setlistArtistCount = 0;
    let setlistTrackCount = 0;
    likes.forEach(function(track) {
        if (track.setlistArtists && track.setlistArtists.length > 0) {
            setlistTrackCount++;
            track.setlistArtists.forEach(function(a) {
                addArtist(a, 4);
                setlistArtistCount++;
            });
        }
    });

    // Liked track performer (from title) — weight 2
    likes.forEach(function(track) {
        if (track.artist) addArtist(track.artist, 2);
    });

    // Following artists — weight 1
    followings.forEach(function(name) {
        addArtist(name, 1);
    });

    // History (empty for now, placeholder for when we get it) — weight 3
    history.forEach(function(t) {
        if (t.artist) addArtist(t.artist, 3);
    });

    // Sort by weight desc, then name
    const weightedArtists = Array.from(weightMap.values()).sort(function(a, b) {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return a.name.localeCompare(b.name);
    });

    return {
        history: history,
        likes: likes,
        followings: followings,
        weightedArtists: weightedArtists,
        allArtists: weightedArtists.map(function(a) { return a.name; }),
        counts: {
            history: history.length,
            likes: likes.length,
            followings: followings.length,
            setlistTracks: setlistTrackCount,
            setlistArtists: setlistArtistCount
        }
    };
}

module.exports = { ingestAll, getPlayHistory, getLikedTracks, getFollowings, parseTracklistFromDescription };
