'use strict';

/**
 * Gem Score — taste intelligence layer
 *
 * Scores each release in a user's wantlist/collection using:
 *   1. YouTube obscurity   — low views = underground (inverse log scale)
 *   2. YouTube engagement  — likes/views ratio (passionate niche community)
 *   3. DJ validation       — DJ names mentioned in comments (club weapon signal)
 *   4. Discogs rarity      — want/have ratio (sought-after but scarce)
 *   5. Genre depth         — comment genre richness (culturally resonant)
 *
 * Output per release:
 *   gemScore    0–100 composite
 *   tier        "hidden_gem" | "club_weapon" | "deep_cut" | "known_quantity" | "unscored"
 *   signals     breakdown of each dimension
 *   label       human-readable single line
 */

// ─── Scoring weights ──────────────────────────────────────────────────────────
const W = {
    obscurity:  0.35,   // most important — underground = interesting
    engagement: 0.25,   // high likes/views ratio = passionate crowd
    djSignal:   0.20,   // DJ mentions = club validation
    rarity:     0.15,   // Discogs want/have
    genreDepth: 0.05,   // genre richness in comments
};

// ─── Individual scorers (each returns 0–100) ─────────────────────────────────

/**
 * Obscurity: inverse log scale on view count.
 * < 1k views   → ~95   (totally underground)
 * ~10k views   → ~75   (niche)
 * ~100k views  → ~50   (known in the scene)
 * ~1M views    → ~25   (popular)
 * > 10M views  → ~5    (mainstream)
 */
function obscurityScore(viewCount) {
    if (viewCount == null) return 50; // no data = neutral
    if (viewCount <= 0)   return 100;
    // log10 scale: 0=100, 3=75, 5=50, 6=25, 7+=5
    var log = Math.log10(viewCount);
    var score = Math.max(0, Math.min(100, 100 - (log * 14)));
    return Math.round(score);
}

/**
 * Engagement: comment rate + like rate, calibrated for underground vinyl.
 *
 * YouTube hid public like counts (Nov 2021) — likes often show 0 even on
 * loved records. Comments are higher-intent: someone who comments on a
 * 1k-view vinyl video is a superfan.
 *
 * Comment rate thresholds (vinyl-calibrated):
 *   1k views, 10 comments = 1%  → extraordinary (cult)
 *   1k views, 3 comments  = 0.3% → very passionate
 *   1k views, 1 comment   = 0.1% → engaged
 *   10k views, 10 comments = 0.1% → decent
 *   100k views, 50 comments = 0.05% → average
 */
function engagementScore(viewCount, likeCount, commentCount) {
    if (!viewCount || viewCount <= 0) return 50; // no data — neutral

    var commentRate = (commentCount || 0) / viewCount;
    var likeRate    = (likeCount    || 0) / viewCount;

    // Comment rate score (primary — high-intent engagement)
    var commentScore = 0;
    if (commentRate >= 0.01)        commentScore = 100;  // 1%+   e.g. 10 comments on 1k views
    else if (commentRate >= 0.003)  commentScore = 85;   // 0.3%  e.g. 3 comments on 1k views
    else if (commentRate >= 0.001)  commentScore = 65;   // 0.1%  e.g. 1 comment on 1k views
    else if (commentRate >= 0.0003) commentScore = 40;   // 0.03% some engagement
    else if (commentRate > 0)       commentScore = 20;

    // Like rate score (secondary — less reliable post-2021 but still a signal)
    var likeScore = 0;
    if (likeRate >= 0.05)       likeScore = 100;
    else if (likeRate >= 0.02)  likeScore = 75;
    else if (likeRate >= 0.01)  likeScore = 50;
    else if (likeRate >= 0.005) likeScore = 35;
    else if (likeRate > 0)      likeScore = 20;

    // Blend: comments weighted higher (60/40). Use whichever we have.
    var hasComments = (commentCount || 0) > 0;
    var hasLikes    = (likeCount    || 0) > 0;
    if (hasComments && hasLikes) return Math.round(commentScore * 0.6 + likeScore * 0.4);
    if (hasComments) return commentScore;
    if (hasLikes)    return likeScore;
    return 50; // no engagement data
}

/**
 * DJ validation: number of unique DJ mentions in comments.
 * 3+  → 100
 * 2   → 70
 * 1   → 40
 * 0   → 0
 */
function djScore(djs) {
    if (!djs || !djs.length) return 0;
    if (djs.length >= 3) return 100;
    if (djs.length === 2) return 70;
    return 40;
}

/**
 * Rarity: Discogs want/have ratio.
 * > 3x  → 100  (everyone wants it, few have it)
 * 2–3x  → 75
 * 1–2x  → 50
 * < 1x  → 25
 * No data → 50
 */
function rarityScore(have, want) {
    if (!have || !want) return 50;
    var ratio = want / have;
    if (ratio >= 3)   return 100;
    if (ratio >= 2)   return 75;
    if (ratio >= 1)   return 50;
    return 25;
}

/**
 * Genre depth: number of genres identified in comments (cultural richness).
 * 5+  → 100
 * 3–4 → 65
 * 1–2 → 35
 * 0   → 0
 */
function genreDepthScore(genres) {
    if (!genres || !genres.length) return 0;
    if (genres.length >= 5) return 100;
    if (genres.length >= 3) return 65;
    return 35;
}

// ─── Tier classification ──────────────────────────────────────────────────────

function classifyTier(score, signals, enriched) {
    // Not enriched — only Discogs rarity available
    if (!enriched) {
        if (score >= 50) return 'deep_cut';   // rarity-driven only
        return 'unscored';
    }

    // Club weapon: DJ-validated at any tier — DJs are playing it
    if (signals.djSignal >= 40) return 'club_weapon';

    // Hidden gem: obscurity ≥ 70 (~< 2k views) + decent overall score
    // These are records almost nobody has found — not even DJs claiming them
    if (signals.obscurity >= 70 && score >= 52) return 'hidden_gem';

    // Deep cut: underground-ish, decent signals
    if (score >= 48) return 'deep_cut';

    // Known quantity: enriched but mainstream signals dominate
    return 'known_quantity';
}

const TIER_LABELS = {
    hidden_gem:     '💎 Hidden Gem',
    club_weapon:    '🔥 Club Weapon',
    deep_cut:       '🎯 Deep Cut',
    known_quantity: '📣 Known Quantity',
    unscored:       '⬜ Unscored',
};

// ─── Score one release ────────────────────────────────────────────────────────

function scoreRelease(meta, rm) {
    var commentData = {};
    try { commentData = JSON.parse(meta.youtube_comment_data || '{}'); } catch(e) {}

    var signals = {
        obscurity:  obscurityScore(meta.youtube_view_count),
        engagement: engagementScore(meta.youtube_view_count, meta.youtube_like_count, meta.youtube_comment_count),
        djSignal:   djScore(commentData.djs),
        rarity:     rarityScore(rm && rm.community_have, rm && rm.community_want),
        genreDepth: genreDepthScore(commentData.genres),
    };

    var gemScore = Math.round(
        signals.obscurity  * W.obscurity  +
        signals.engagement * W.engagement +
        signals.djSignal   * W.djSignal   +
        signals.rarity     * W.rarity     +
        signals.genreDepth * W.genreDepth
    );

    var enriched = !!meta.youtube_enriched_at;
    var tier = classifyTier(gemScore, signals, enriched);

    return {
        gemScore,
        tier,
        label: TIER_LABELS[tier],
        signals,
        // context data for UI
        viewCount:    meta.youtube_view_count    || null,
        likeCount:    meta.youtube_like_count    || null,
        commentCount: meta.youtube_comment_count || null,
        genres:       commentData.genres         || [],
        djs:          commentData.djs            || [],
        era:          commentData.era            || [],
        soundsLike:   commentData.soundsLike     || [],
        rawTop:       commentData.rawTop         || [],
        videoId:      meta.youtube_video_id      || null,
        enriched:     !!meta.youtube_enriched_at,
    };
}

// ─── Score a user's full wantlist + collection ─────────────────────────────────

function scoreUserCollection(userId, db) {
    var d = typeof db.getDb === 'function' ? db.getDb() : db;

    // Get all unique discogs_ids for this user (wantlist + collection, deduped)
    // SQLite has no FULL OUTER JOIN — use UNION of two LEFT JOINs
    var rows = d.prepare(`
        SELECT discogs_id, artist, title, year, 1 AS in_wantlist,
               CASE WHEN EXISTS(SELECT 1 FROM collection c WHERE c.user_id=? AND c.discogs_id=w.discogs_id) THEN 1 ELSE 0 END AS in_collection
        FROM wantlist w
        WHERE w.user_id=? AND w.active=1 AND w.discogs_id IS NOT NULL
        UNION
        SELECT discogs_id, artist, title, year, 0 AS in_wantlist, 1 AS in_collection
        FROM collection c
        WHERE c.user_id=? AND c.discogs_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM wantlist w WHERE w.user_id=? AND w.discogs_id=c.discogs_id AND w.active=1)
    `).all(userId, userId, userId, userId);

    if (!rows.length) return [];

    // Batch-fetch streaming_metadata + release_meta
    var ids = rows.map(function(r) { return r.discogs_id; });
    var placeholders = ids.map(function() { return '?'; }).join(',');

    var metaMap = {};
    d.prepare('SELECT * FROM streaming_metadata WHERE discogs_id IN (' + placeholders + ')').all(...ids)
        .forEach(function(r) { metaMap[r.discogs_id] = r; });

    var rmMap = {};
    d.prepare('SELECT * FROM release_meta WHERE discogs_id IN (' + placeholders + ')').all(...ids)
        .forEach(function(r) { rmMap[r.discogs_id] = r; });

    var scored = rows.map(function(row) {
        var meta = metaMap[row.discogs_id] || {};
        var rm   = rmMap[row.discogs_id]   || null;
        var s    = scoreRelease(meta, rm);
        return Object.assign({}, row, s);
    });

    // Sort: hidden gems + club weapons first, then by gemScore desc
    scored.sort(function(a, b) {
        var tierOrder = { hidden_gem: 0, club_weapon: 1, deep_cut: 2, known_quantity: 3, unscored: 4 };
        var at = tierOrder[a.tier] !== undefined ? tierOrder[a.tier] : 5;
        var bt = tierOrder[b.tier] !== undefined ? tierOrder[b.tier] : 5;
        if (at !== bt) return at - bt;
        return b.gemScore - a.gemScore;
    });

    return scored;
}

// ─── Taste summary across all scored releases ──────────────────────────────────

function tasteSummary(scoredReleases) {
    var total   = scoredReleases.length;
    var enriched = scoredReleases.filter(function(r) { return r.enriched; }).length;

    var tierCounts = { hidden_gem: 0, club_weapon: 0, deep_cut: 0, known_quantity: 0, unscored: 0 };
    var allGenres  = {};
    var allDjs     = {};
    var allEras    = {};
    var scores     = [];

    scoredReleases.forEach(function(r) {
        tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
        scores.push(r.gemScore);
        r.genres.forEach(function(g)    { allGenres[g] = (allGenres[g] || 0) + 1; });
        r.djs.forEach(function(d)       { allDjs[d]    = (allDjs[d]    || 0) + 1; });
        (r.era || []).forEach(function(e) { allEras[e]  = (allEras[e]   || 0) + 1; });
    });

    var avgScore = scores.length
        ? Math.round(scores.reduce(function(a, b) { return a + b; }, 0) / scores.length)
        : 0;

    // Underground index: % of releases scoring obscurity >= 65
    var undergroundPct = total > 0
        ? Math.round(scoredReleases.filter(function(r) { return r.signals.obscurity >= 65; }).length / total * 100)
        : 0;

    function topN(obj, n) {
        return Object.keys(obj).sort(function(a, b) { return obj[b] - obj[a]; }).slice(0, n);
    }

    return {
        total, enriched,
        enrichedPct: total > 0 ? Math.round(enriched / total * 100) : 0,
        avgGemScore: avgScore,
        undergroundPct,
        tierCounts,
        topGenres:  topN(allGenres, 8),
        topDjs:     topN(allDjs,    8),
        topEras:    topN(allEras,   5),
    };
}

module.exports = {
    scoreRelease,
    scoreUserCollection,
    tasteSummary,
    TIER_LABELS,
};
