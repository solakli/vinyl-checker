/**
 * Last.fm API wrapper
 *
 * Requires LASTFM_API_KEY in environment.
 * Uses an in-memory LRU-style cache so we don't hammer the API
 * for the same artist repeatedly within a session.
 */

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const _cache = new Map(); // artist (lowercase) -> { artists, expiresAt }

/**
 * Normalise an artist name for cache keying / comparison.
 * Strips trailing " (2)", " (3)" Discogs disambiguation suffixes.
 */
function normalise(name) {
    if (!name) return '';
    return name
        .replace(/\s*\(\d+\)$/, '')
        .trim()
        .toLowerCase();
}

/**
 * Fetch similar artists from Last.fm for a given seed artist.
 * Returns an array of { name, match } sorted by match score desc.
 * Returns [] on any error (missing key, artist not found, network issue).
 *
 * @param {string} artist - seed artist name
 * @param {number} limit  - max similar artists to return (default 8)
 */
async function getSimilarArtists(artist, limit = 8) {
    const key = normalise(artist);
    if (!key || key === 'various') return [];

    const apiKey = process.env.LASTFM_API_KEY;
    if (!apiKey) {
        console.warn('[last-fm] LASTFM_API_KEY not set — skipping similarity lookup');
        return [];
    }

    // Cache hit
    const cached = _cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.artists;
    }

    const url =
        BASE_URL +
        '?method=artist.getSimilar' +
        '&artist=' + encodeURIComponent(artist.replace(/\s*\(\d+\)$/, '').trim()) +
        '&api_key=' + apiKey +
        '&format=json' +
        '&limit=' + limit;

    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn('[last-fm] HTTP', res.status, 'for', artist);
            return [];
        }
        const data = await res.json();

        if (data.error) {
            // e.g. error 6 = artist not found — not a crash, just no results
            return [];
        }

        const similar = (data.similarartists?.artist || []).map(function (a) {
            return { name: a.name, match: parseFloat(a.match) || 0 };
        });

        _cache.set(key, { artists: similar, expiresAt: Date.now() + CACHE_TTL_MS });
        return similar;
    } catch (err) {
        console.warn('[last-fm] fetch error for', artist, err.message);
        return [];
    }
}

/**
 * Bulk: fetch similar artists for multiple seeds concurrently.
 *
 * Accepts either:
 *   - string[]                         (legacy, all weight 1)
 *   - Array<{ name, weight }>          (weighted seeds)
 *
 * Score accumulation: rec.match * seedWeight — so setlist seeds (weight 4)
 * produce 4× stronger recommendations than wantlist seeds (weight 2).
 *
 * @param {string[]|{name,weight}[]} seeds
 * @param {number} similarPerSeed
 */
async function expandSeeds(seeds, similarPerSeed = 8) {
    // Normalise input to { name, weight } objects
    const seedObjects = seeds.map(function(s) {
        return typeof s === 'string' ? { name: s, weight: 1 } : s;
    });

    const seedSet = new Set(seedObjects.map(function(s) { return normalise(s.name); }));

    const CONCURRENCY = 5;
    const scoreMap = new Map();

    for (let i = 0; i < seedObjects.length; i += CONCURRENCY) {
        const batch = seedObjects.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(function(s) {
            // Higher-weight seeds get more similar artists to expand into
            const limit = Math.min(20, similarPerSeed + Math.floor(s.weight * 2));
            return getSimilarArtists(s.name, limit);
        }));

        results.forEach(function(similar, batchIdx) {
            const seed = batch[batchIdx];
            similar.forEach(function(rec) {
                const normName = normalise(rec.name);
                if (seedSet.has(normName)) return;

                const weightedScore = rec.match * seed.weight;
                const existing = scoreMap.get(normName);
                if (existing) {
                    existing.score     += weightedScore;
                    existing.seedCount += 1;
                    existing.seeds.push(seed.name);
                } else {
                    scoreMap.set(normName, {
                        displayName: rec.name,
                        score: weightedScore,
                        seedCount: 1,
                        seeds: [seed.name]
                    });
                }
            });
        });
    }

    return scoreMap;
}

module.exports = { getSimilarArtists, expandSeeds, normalise };
