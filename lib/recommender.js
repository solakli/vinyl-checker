/**
 * Discovery Recommender
 *
 * Pipeline:
 *   1. Extract seed artists from user's wantlist (DB)
 *   2. Expand via Last.fm artist.getSimilar
 *   3. Score expanded artists (sum of similarity scores from all seeds)
 *   4. Cross-reference against store_inventory to find in-stock records
 *   5. Filter out records already in the user's wantlist
 *   6. Return ranked results with "why" context
 */

const lastFm = require('./last-fm');

/**
 * Run the full discovery pipeline for a user.
 *
 * @param {string} username - Discogs username
 * @param {object} db - raw better-sqlite3 db instance (from db.getDb())
 * @param {object} opts
 * @param {number} opts.seedLimit     - max wantlist seeds to use (default 30)
 * @param {number} opts.similarPerSeed - Last.fm similar artists per seed (default 8)
 * @param {number} opts.resultLimit   - max recommendations to return (default 40)
 * @returns {Promise<object>} { seeds, recommendations, cached }
 */
async function recommend(username, db, opts) {
    opts = opts || {};
    const seedLimit = opts.seedLimit || 30;
    const similarPerSeed = opts.similarPerSeed || 8;
    const resultLimit = opts.resultLimit || 40;

    // --- Step 1: Seed artists from wantlist ---
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!user) return { seeds: [], recommendations: [], error: 'User not found' };

    const wantlistRows = db
        .prepare(
            'SELECT DISTINCT artist FROM wantlist WHERE user_id = ? AND active = 1 AND artist IS NOT NULL ORDER BY RANDOM() LIMIT ?'
        )
        .all(user.id, seedLimit);

    // Filter out "Various" and empty artists
    let seedArtists = wantlistRows
        .map(function (r) { return r.artist; })
        .filter(function (a) {
            const n = lastFm.normalise(a);
            return n && n !== 'various' && n.length > 1;
        });

    // Build a weight map for all seeds (wantlist = weight 2 as baseline)
    const seedWeightMap = new Map(); // normalised → { name, weight }
    function addSeed(name, weight) {
        const n = lastFm.normalise(name);
        if (!n || n === 'various' || n.length < 2) return;
        const existing = seedWeightMap.get(n);
        if (!existing || existing.weight < weight) {
            seedWeightMap.set(n, { name, weight });
        }
    }
    seedArtists.forEach(function(a) { addSeed(a, 2); });

    // Merge SoundCloud artists with their weights (setlist=4, liked=2, following=1)
    try {
        const scToken = db.prepare('SELECT provider_username FROM oauth_tokens WHERE user_id = ? AND provider = ?').get(user.id, 'soundcloud');
        if (scToken && scToken.provider_username) {
            const scData = JSON.parse(scToken.provider_username);
            // New format: weightedArtists array
            const weighted = scData.weightedArtists || scData.artists && scData.artists.map(function(a) { return { name: a, weight: 2 }; }) || [];
            let added = 0;
            weighted.forEach(function(entry) {
                addSeed(entry.name, entry.weight);
                added++;
            });
            console.log('[recommender] Merged', added, 'SoundCloud weighted seeds');
        }
    } catch(e) {
        console.warn('[recommender] SoundCloud seed merge error:', e.message);
    }

    // Merge YouTube artists (liked videos + subscriptions)
    try {
        const ytToken = db.prepare('SELECT provider_username FROM oauth_tokens WHERE user_id = ? AND provider = ?').get(user.id, 'google');
        if (ytToken && ytToken.provider_username) {
            const ytData = JSON.parse(ytToken.provider_username);
            const ytArtists = (ytData.artists || []);
            let added = 0;
            ytArtists.forEach(function(a) {
                addSeed(a, 2);
                added++;
            });
            console.log('[recommender] Merged', added, 'YouTube seeds');
        }
    } catch(e) {
        console.warn('[recommender] YouTube seed merge error:', e.message);
    }

    // Convert weight map to sorted weighted seed objects for Last.fm expansion
    const weightedSeeds = Array.from(seedWeightMap.values())
        .sort(function(a, b) { return b.weight - a.weight; });

    seedArtists = weightedSeeds.map(function(e) { return e.name; });

    if (seedArtists.length === 0) {
        return { seeds: [], recommendations: [], error: 'No valid wantlist artists found' };
    }

    // Also keep a set of wantlist artist names (normalised) so we can exclude them from results
    const allWantlistRows = db
        .prepare('SELECT DISTINCT artist FROM wantlist WHERE user_id = ? AND active = 1')
        .all(user.id);
    const wantlistArtistSet = new Set(
        allWantlistRows.map(function (r) { return lastFm.normalise(r.artist); })
    );

    // Collect wantlist release IDs to exclude exact duplicates
    const wantlistReleaseIds = new Set(
        db.prepare('SELECT discogs_id FROM wantlist WHERE user_id = ? AND active = 1 AND discogs_id IS NOT NULL')
            .all(user.id)
            .map(function (r) { return r.discogs_id; })
    );

    // --- Step 2: Last.fm expansion (with seed weights) ---
    const scoreMap = await lastFm.expandSeeds(weightedSeeds, similarPerSeed);

    if (scoreMap.size === 0) {
        return {
            seeds: seedArtists,
            recommendations: [],
            error: 'Last.fm returned no similar artists — check LASTFM_API_KEY'
        };
    }

    // --- Step 3: Build a sorted candidate list ---
    const candidates = Array.from(scoreMap.values()).sort(function (a, b) {
        // Primary: seedCount (recommended by more seeds = stronger signal)
        // Secondary: Last.fm match score
        if (b.seedCount !== a.seedCount) return b.seedCount - a.seedCount;
        return b.score - a.score;
    });

    // --- Step 4: Cross-reference store inventory ---
    // Pull all inventory records for matching artists in one go
    // We match on normalised artist name using a LIKE query per candidate
    // For efficiency we batch-query and filter in JS

    // Get the top N candidate names to query (avoid querying thousands)
    const topCandidates = candidates.slice(0, 80);
    const candidateMap = new Map(); // normalised name -> score info
    topCandidates.forEach(function (c) {
        candidateMap.set(lastFm.normalise(c.displayName), c);
    });

    // Fetch all inventory items whose artist matches any candidate
    // We do this by pulling all inventory and filtering in JS — acceptable at 41k rows
    const inventoryRows = db
        .prepare(
            'SELECT store, artist, title, label, catno, price_usd, url, image_url, product_type, tags FROM store_inventory WHERE available = 1 AND artist IS NOT NULL'
        )
        .all();

    const recommendations = [];
    const seenKeys = new Set(); // deduplicate artist+title

    inventoryRows.forEach(function (row) {
        if (!row.artist) return;

        // An inventory record can have multiple artists (comma-separated)
        const invArtists = row.artist.split(',').map(function (a) { return a.trim(); });
        let bestMatch = null;
        let bestScore = 0;

        invArtists.forEach(function (a) {
            const norm = lastFm.normalise(a);
            const info = candidateMap.get(norm);
            if (info && info.score > bestScore) {
                bestMatch = info;
                bestScore = info.score;
            }
        });

        if (!bestMatch) return;

        // Skip if this artist is already in the user's wantlist (they know about them)
        const isWantlistArtist = invArtists.some(function (a) {
            return wantlistArtistSet.has(lastFm.normalise(a));
        });
        if (isWantlistArtist) return;

        const dedupeKey = lastFm.normalise(row.artist) + '||' + lastFm.normalise(row.title);
        if (seenKeys.has(dedupeKey)) return;
        seenKeys.add(dedupeKey);

        recommendations.push({
            store: row.store,
            artist: row.artist,
            title: row.title,
            label: row.label || null,
            catno: row.catno || null,
            priceUsd: row.price_usd,
            url: row.url,
            imageUrl: row.image_url || null,
            productType: row.product_type || null,
            // Why this was recommended
            because: bestMatch.seeds.slice(0, 3), // up to 3 seed artists that led here
            similarityScore: bestMatch.score,
            seedCount: bestMatch.seedCount,
            recommendedArtist: bestMatch.displayName
        });
    });

    // Sort by similarity signal strength
    recommendations.sort(function (a, b) {
        if (b.seedCount !== a.seedCount) return b.seedCount - a.seedCount;
        return b.similarityScore - a.similarityScore;
    });

    return {
        seeds: seedArtists,
        recommendations: recommendations.slice(0, resultLimit),
        totalMatches: recommendations.length
    };
}

module.exports = { recommend };
