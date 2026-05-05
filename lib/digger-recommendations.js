'use strict';

/**
 * Cross-Digger Recommendation Engine
 *
 * Algorithm (data scientist view):
 *
 * 1. Build the requesting user's wantlist as a Set<discogs_id> (the exclusion mask).
 * 2. Union all OTHER users' wantlist items → candidate pool, deduplicated on discogs_id.
 *    For each candidate, track which diggers want it (for social proof display).
 * 3. Score each candidate:
 *    - tasteScore  = cosine similarity between user's style/genre vector and the
 *      candidate release's style/genre tags (same vector space as the taste match engine)
 *    - gemScore    = normalised gem score (0–100) from streaming_metadata join;
 *      null if no enrichment yet (treated as 50 = neutral in final score)
 *    - combinedScore = tasteScore * (1 + gemScore / 100)
 *      → gem score amplifies taste match but never dominates; a perfect gem with 0
 *        taste match still scores 0.
 * 4. Deduplicate on discogs_id, keep highest combinedScore per release.
 * 5. Sort descending by combinedScore, return top N.
 *
 * computeTasteScoreForRelease() reuses the same frequency-vector cosine similarity
 * used in /api/diggers — if a style appears 20× in user's wantlist and the release
 * has that style, it scores highly. Single-style releases still score something.
 *
 * Output per recommendation:
 * { discogsId, artist, title, year, label, catno, thumb, genres, styles,
 *   tasteScore, gemScore, combinedScore, diggersWanting: ['alice', 'bob'] }
 */

const db = require('../db');

/**
 * Compute recommendations for userId/username.
 * @param {number} userId
 * @param {string} username
 * @param {object} d  — better-sqlite3 db handle (passed in to avoid re-opening)
 * @returns {Array} sorted recommendation objects
 */
function compute(userId, username, d) {
    if (!d) d = db.getDb();

    // ── 1. User's existing wantlist (exclusion mask) ──────────────────────────
    var myIds = new Set(
        d.prepare('SELECT discogs_id FROM wantlist WHERE user_id=? AND active=1 AND discogs_id IS NOT NULL')
         .all(userId)
         .map(function(r) { return r.discogs_id; })
    );

    // Also exclude items the user already owns in their collection
    d.prepare('SELECT discogs_id FROM collection WHERE user_id=? AND discogs_id IS NOT NULL')
     .all(userId)
     .forEach(function(r) { myIds.add(r.discogs_id); });

    // ── 2. User's taste profile vector (styles + genres frequency map) ────────
    var myProfile = buildTasteVector(userId, d);

    // ── 3. Candidate pool: other diggers' wantlists + collections ───────────────
    // Collections carry a 'owned' source tag — these are records someone actually
    // bought, so they're a stronger signal than wantlist items (still wanting).
    // We UNION both and deduplicate on discogs_id per user in step 5.
    var otherRows = d.prepare(`
        SELECT w.discogs_id, w.artist, w.title, w.year, w.label, w.catno, w.thumb,
               w.genres, w.styles, u.username AS wanter, 'want' AS source
        FROM wantlist w
        JOIN users u ON u.id = w.user_id
        WHERE w.user_id != ? AND w.active = 1 AND w.discogs_id IS NOT NULL
        UNION ALL
        SELECT c.discogs_id, c.artist, c.title, c.year, c.label, c.catno, c.thumb,
               c.genres, c.styles, u.username AS wanter, 'owned' AS source
        FROM collection c
        JOIN users u ON u.id = c.user_id
        WHERE c.user_id != ? AND c.discogs_id IS NOT NULL
    `).all(userId, userId);

    // ── 4. Gem scores from streaming_metadata ─────────────────────────────────
    var gemRows = d.prepare(`
        SELECT sm.discogs_id,
               sm.youtube_view_count,
               sm.youtube_like_count,
               sm.youtube_comment_count,
               rm.community_have,
               rm.community_want
        FROM streaming_metadata sm
        LEFT JOIN release_meta rm ON rm.discogs_id = sm.discogs_id
    `).all();
    var gemMap = {};
    gemRows.forEach(function(r) { gemMap[r.discogs_id] = r; });

    // ── 5. Build candidate map: discogs_id → best record + diggers ───────────
    // diggersOwned: diggers who own it (stronger signal)
    // diggersWanting: diggers who want it
    var candidates = {};

    otherRows.forEach(function(row) {
        if (myIds.has(row.discogs_id)) return;  // skip already-owned/wanted by me
        if (!candidates[row.discogs_id]) {
            candidates[row.discogs_id] = {
                discogsId:      row.discogs_id,
                artist:         row.artist || '',
                title:          row.title  || '',
                year:           row.year   || null,
                label:          row.label  || '',
                catno:          row.catno  || '',
                thumb:          row.thumb  || '',
                genres:         row.genres || '',
                styles:         row.styles || '',
                diggersOwning:  new Set(),  // bought it
                diggersWanting: new Set(),  // want it
            };
        }
        if (row.source === 'owned') {
            candidates[row.discogs_id].diggersOwning.add(row.wanter);
        } else {
            candidates[row.discogs_id].diggersWanting.add(row.wanter);
        }
    });

    // ── 6. Score each candidate ───────────────────────────────────────────────
    // combinedScore = tasteScore × (1 + gemScore/100) × ownershipBoost
    // ownershipBoost: records someone already owns get a 30% lift — they've been
    // validated by an actual purchase, not just a wishlist click.
    var results = Object.values(candidates).map(function(c) {
        var tasteScore      = computeTasteScoreForRelease(myProfile, c.styles, c.genres);
        var rawGemScore     = computeGemScore(gemMap[c.discogsId]);
        var gemScore        = rawGemScore !== null ? rawGemScore : 50;
        var ownersCount     = c.diggersOwning.size;
        var ownershipBoost  = ownersCount > 0 ? 1.3 : 1.0;  // +30% if any digger owns it
        var combinedScore   = tasteScore * (1 + gemScore / 100) * ownershipBoost;

        // Merge owners + wanters for display, owners first
        var diggersOwning  = Array.from(c.diggersOwning);
        var diggersWanting = Array.from(c.diggersWanting).filter(function(u) {
            return !c.diggersOwning.has(u); // don't double-list
        });

        return {
            discogsId:      c.discogsId,
            artist:         c.artist,
            title:          c.title,
            year:           c.year,
            label:          c.label,
            catno:          c.catno,
            thumb:          c.thumb,
            genres:         c.genres,
            styles:         c.styles,
            tasteScore:     Math.round(tasteScore * 100),    // 0–100
            gemScore:       rawGemScore,                      // 0–100 or null
            combinedScore:  Math.round(combinedScore * 100), // ranking int
            diggersOwning:  diggersOwning,   // bought it — strongest social proof
            diggersWanting: diggersWanting,  // want it
        };
    });

    // ── 7. Sort by combinedScore desc ─────────────────────────────────────────
    results.sort(function(a, b) { return b.combinedScore - a.combinedScore; });
    return results;
}

// ─── Taste profile ────────────────────────────────────────────────────────────

function buildTasteVector(userId, d) {
    // Both wantlist AND collection — owned records are confirmed taste signals
    var rows = d.prepare(`
        SELECT styles, genres FROM wantlist WHERE user_id=? AND active=1
        UNION ALL
        SELECT styles, genres FROM collection WHERE user_id=?
    `).all(userId, userId);
    var vec = {};
    rows.forEach(function(r) {
        split(r.styles).forEach(function(s) { vec[s] = (vec[s] || 0) + 1; });
        split(r.genres).forEach(function(g) { vec[g] = (vec[g] || 0) + 1; });
    });
    return vec;
}

function computeTasteScoreForRelease(userVec, stylesStr, genresStr) {
    // Build a unit release vector from the release's styles + genres (each tag = weight 1)
    var relVec = {};
    split(stylesStr).forEach(function(s) { relVec[s] = (relVec[s] || 0) + 1; });
    split(genresStr).forEach(function(g) { relVec[g] = (relVec[g] || 0) + 1; });

    // Cosine similarity: dot(user, release) / (|user| * |release|)
    var dot = 0, magU = 0, magR = 0;
    var keys = new Set(Object.keys(userVec).concat(Object.keys(relVec)));
    keys.forEach(function(k) {
        var u = userVec[k] || 0, r = relVec[k] || 0;
        dot  += u * r;
        magU += u * u;
        magR += r * r;
    });
    if (!magU || !magR) return 0;
    return dot / (Math.sqrt(magU) * Math.sqrt(magR));
}

// ─── Gem score from streaming_metadata row ────────────────────────────────────
// Simplified version of lib/gem-score.js obscurityScore — avoids circular dep.
// Returns 0–100 or null if no enrichment data.
function computeGemScore(row) {
    if (!row || row.youtube_view_count == null) return null;

    var views    = row.youtube_view_count || 0;
    var likes    = row.youtube_like_count || 0;
    var comments = row.youtube_comment_count || 0;
    var have     = row.community_have || 0;
    var want     = row.community_want || 0;

    // Obscurity: inverse log scale, capped at 100
    var obscurity = views < 1 ? 100 :
        Math.max(0, Math.min(100, 100 - (Math.log10(views + 1) / Math.log10(1000000)) * 100));

    // Engagement: comment rate (primary) + like rate (secondary)
    var commentRate = views > 0 ? (comments / views) * 1000 : 0;  // per 1000 views
    var likeRate    = views > 0 ? (likes    / views) * 100  : 0;  // %
    var engagement  = Math.min(100, commentRate * 40 + likeRate * 0.6);

    // Rarity: want/have ratio
    var rarity = have > 0 ? Math.min(100, (want / have) * 50) : 50;

    return Math.round(obscurity * 0.5 + engagement * 0.3 + rarity * 0.2);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function split(str) {
    if (!str) return [];
    return str.split(/,\s*/).map(function(s) { return s.trim(); }).filter(Boolean);
}

module.exports = { compute };
