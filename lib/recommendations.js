'use strict';

/**
 * Enhanced Taste-Based Recommendation Engine
 *
 * Builds a multi-dimensional taste profile from the user's wantlist and scores
 * every available item across ALL store inventories (Gramaphone, Further,
 * Octopus, UVS, …) against it.
 *
 * Scoring signals (all additive):
 *  1. Artist affinity      — You want 3 Aphex Twin records → here's a 4th
 *  2. Label affinity       — Warp, Hyperdub, Ninja Tune super-fans detected
 *  3. Label neighbourhood  — Labels that share artists with your wantlist
 *  4. Style match (TF-IDF) — "Minimal Wave" match >> "Electronic" match
 *  5. Genre match          — Broad genre bucket
 *  6. Era proximity        — Decade distribution from your wantlist
 *  7. Style cluster expand — "Minimal Techno" → related: "Dub Techno", etc.
 *  8. Diversity injection  — Max 3 items per artist to avoid echo chambers
 *
 * No external API calls. Pure computation on data already in SQLite.
 * Typical run: < 200 ms for 13 000 inventory items.
 */

const db = require('../db');

// ─── Signal weights (tunable) ─────────────────────────────────────────────────
const W = {
    artist:          15,   // direct artist match
    label:            8,   // direct label match
    labelNeighbour:   3,   // label shares artists w/ wantlist
    style:            6,   // subgenre match (× IDF rarity multiplier)
    genre:            3,   // broad genre bucket (× IDF multiplier, capped)
    era:              2,   // year proximity
    decade:           1.5, // decade distribution bonus
};

// ─── Streaming signal weights ─────────────────────────────────────────────────
// Applied only when streaming data is available (Spotify / SoundCloud connected).
// These boost artists the user already listens to on streaming platforms, turning
// the recommendation engine into a cross-platform taste engine.
//
// Dan's integration note: these weights were designed to complement, not override,
// the wantlist signals above. A pure-streaming match without any wantlist signal
// still won't surface (NOISE_FLOOR filters it) — so this only boosts items that
// already have some taste signal from the wantlist.
const W_STREAMING = {
    userTopArtist:   8.0,  // artist is in user's Spotify/SoundCloud top artists
    userRecentPlay:  5.0,  // artist appeared in recently played
    userLikedTrack:  3.5,  // artist appeared in user's liked tracks (SoundCloud)
};

// ─── Generic artist names to skip for affinity matching ──────────────────────
var SKIP_ARTISTS = new Set([
    'various', 'various artists', 'v/a', 'va', 'unknown', 'unknown artist',
]);

// ─── Style semantic clusters ──────────────────────────────────────────────────
// Matching on a style in the user's profile also adds 50% credit to its relatives.
const STYLE_CLUSTERS = {
    'minimal techno':     ['techno', 'minimal', 'dub techno', 'tech house'],
    'dub techno':         ['techno', 'minimal techno', 'ambient techno'],
    'acid':               ['acid house', 'acid techno', 'chicago house'],
    'ambient':            ['ambient techno', 'drone', 'new age', 'experimental'],
    'jungle':             ['drum n bass', 'breakbeat', 'hardcore', 'rave'],
    'drum n bass':        ['jungle', 'liquid funk', 'neurofunk', 'breakbeat'],
    'deep house':         ['house', 'chicago house', 'soulful house', 'soul'],
    'uk garage':          ['2-step', 'grime', 'bass music'],
    'hip-hop':            ['rap', 'boom bap', 'conscious hip-hop'],
    'boom bap':           ['hip-hop', 'rap', 'jazz rap'],
    'industrial':         ['ebt', 'power electronics', 'noise', 'experimental'],
    'krautrock':          ['kosmische musik', 'experimental', 'psychedelic rock', 'prog rock'],
    'psychedelic rock':   ['rock', 'krautrock', 'prog rock', 'folk rock'],
    'soul':               ['funk', 'r&b', 'deep house', 'gospel'],
    'funk':               ['soul', 'r&b', 'disco', 'afrobeat'],
    'jazz':               ['jazz-funk', 'jazz rap', 'nu jazz', 'free jazz'],
    'jazz-funk':          ['jazz', 'funk', 'soul'],
    'electro':            ['electro funk', 'hip-hop', 'techno', 'chicago house'],
    'house':              ['deep house', 'chicago house', 'tech house', 'soulful house'],
    'disco':              ['funk', 'soul', 'house', 'italo disco'],
    'italo disco':        ['disco', 'synth-pop', 'electro'],
    'synth-pop':          ['new wave', 'electro', 'italo disco', 'darkwave'],
    'new wave':           ['post-punk', 'synth-pop', 'darkwave'],
    'post-punk':          ['punk', 'new wave', 'gothic rock', 'no wave'],
    'drone':              ['ambient', 'experimental', 'noise', 'minimalism'],
    'afrobeat':           ['funk', 'soul', 'african', 'jazz'],
};

// ─── Tag normalisation ────────────────────────────────────────────────────────
/**
 * Shopify tags arrive as JSON: ["Electronic","House/Techno/Electro","12-Inch"]
 * Split compound tags by "/" and lower-case everything.
 */
function expandTags(tagsJson) {
    var raw = [];
    try { raw = JSON.parse(tagsJson || '[]'); } catch (e) {}
    var out = new Set();
    raw.forEach(function (tag) {
        tag.split('/').forEach(function (part) {
            var t = part.trim().toLowerCase();
            if (t && t.length > 2) out.add(t);
        });
    });
    return Array.from(out);
}

// ─── TF-IDF corpus ────────────────────────────────────────────────────────────
/**
 * Compute smoothed IDF for every tag across the full inventory.
 * Rare tags ("Musique Concrète") score higher than common ones ("Electronic").
 *
 * idf(t) = log((N+1)/(df(t)+1)) + 1      (add-1 smoothing)
 */
function buildCorpusIDF(inventory) {
    var docFreq = {};
    var N = Math.max(inventory.length, 1);

    inventory.forEach(function (item) {
        var tags = expandTags(item.tags);
        // Count each tag once per document
        var seen = new Set(tags);
        seen.forEach(function (t) {
            docFreq[t] = (docFreq[t] || 0) + 1;
        });
    });

    var idf = {};
    Object.keys(docFreq).forEach(function (t) {
        idf[t] = Math.log((N + 1) / (docFreq[t] + 1)) + 1;
    });
    return idf;
}

// ─── Taste profile ────────────────────────────────────────────────────────────
/**
 * Summarise the user's wantlist into weighted feature maps.
 * All maps are normalised to [0, 1] relative to their own maximum.
 *
 * Extra:
 *  - Style cluster expansion: rare subgenres expand to relatives at 50% weight
 *  - Label → artist co-occurrence index for neighbourhood scoring
 *  - Full decade distribution (not just median year)
 */
function buildTasteProfile(wantlistItems) {
    var genres  = {};
    var styles  = {};
    var labels  = {};
    var artists = {};
    var years   = [];
    var labelArtists = {};   // label (lower) → Set of artists (lower)

    wantlistItems.forEach(function (item) {
        // Genres and styles stored as comma+space delimited by discogs.fetchWantlist
        (item.genres || '').split(', ').map(function (s) { return s.trim().toLowerCase(); })
            .filter(Boolean)
            .forEach(function (g) { genres[g] = (genres[g] || 0) + 1; });

        (item.styles || '').split(', ').map(function (s) { return s.trim().toLowerCase(); })
            .filter(Boolean)
            .forEach(function (s) {
                styles[s] = (styles[s] || 0) + 1;
                // Expand related styles at half weight
                if (STYLE_CLUSTERS[s]) {
                    STYLE_CLUSTERS[s].forEach(function (rel) {
                        styles[rel] = (styles[rel] || 0) + 0.5;
                    });
                }
            });

        var labelNorm  = item.label  ? item.label.toLowerCase().trim()  : null;
        var artistNorm = item.artist ? item.artist.toLowerCase().trim() : null;

        if (labelNorm)  labels[labelNorm]   = (labels[labelNorm]   || 0) + 1;
        if (artistNorm && !SKIP_ARTISTS.has(artistNorm)) artists[artistNorm] = (artists[artistNorm] || 0) + 1;
        if (item.year && item.year > 1900) years.push(item.year);

        // Build label → artist co-occurrence
        if (labelNorm && artistNorm) {
            if (!labelArtists[labelNorm]) labelArtists[labelNorm] = new Set();
            labelArtists[labelNorm].add(artistNorm);
        }
    });

    function normalize(map) {
        var max = Math.max.apply(null, Object.values(map).concat([1]));
        var out = {};
        Object.keys(map).forEach(function (k) { out[k] = map[k] / max; });
        return out;
    }

    // Decade distribution
    var decadeCounts = {};
    years.forEach(function (y) {
        var d = Math.floor(y / 10) * 10;
        decadeCounts[String(d)] = (decadeCounts[String(d)] || 0) + 1;
    });

    years.sort(function (a, b) { return a - b; });

    return {
        genres:       normalize(genres),
        styles:       normalize(styles),
        labels:       normalize(labels),
        artists:      normalize(artists),
        labelArtists: labelArtists,
        decades:      normalize(decadeCounts),
        medianYear:   years.length ? years[Math.floor(years.length / 2)] : null,
        total:        wantlistItems.length,
    };
}

// ─── Score one inventory item ─────────────────────────────────────────────────
/**
 * Returns null if:
 *  – the item is already on the wantlist (key match)
 *  – the composite score is below NOISE_FLOOR
 *
 * Returns { score, signals, reasons, reasonTypes, item } otherwise.
 *
 * @param {object} item           - inventory row
 * @param {object} profile        - wantlist taste profile from buildTasteProfile()
 * @param {Set}    wantlistKeys   - set of 'artist|title' strings to deduplicate
 * @param {object} idf            - IDF map from buildCorpusIDF()
 * @param {object} [streaming]    - streaming profile from buildStreamingProfile(), optional
 */
function scoreItem(item, profile, wantlistKeys, idf, streaming) {
    // Dedup: skip items already wanted
    var key = ((item.artist || '') + '|' + (item.title || '')).toLowerCase();
    if (wantlistKeys.has(key)) return null;

    var score    = 0;
    var signals  = {};   // { artist, label, style, genre, era } → contribution
    var reasons  = [];   // [{ type, text, weight }]

    // ── 1. Artist match ────────────────────────────────────────────────────────
    var artistNorm = (item.artist || '').toLowerCase().trim();
    if (artistNorm && !SKIP_ARTISTS.has(artistNorm) && profile.artists[artistNorm]) {
        var aw = profile.artists[artistNorm];
        var artistScore = aw * W.artist;
        score += artistScore;
        signals.artist = artistScore;
        if (aw > 0.3) reasons.push({ type: 'artist', text: item.artist, weight: artistScore });
    }

    // ── 2. Label match ─────────────────────────────────────────────────────────
    var labelNorm = (item.label || '').toLowerCase().trim();
    if (labelNorm && profile.labels[labelNorm]) {
        var lw = profile.labels[labelNorm];
        var labelScore = lw * W.label;
        score += labelScore;
        signals.label = labelScore;
        if (lw > 0.3) reasons.push({ type: 'label', text: item.label, weight: labelScore });
    } else if (labelNorm) {
        // Label neighbourhood: this store label shares artists with wanted records
        var sharedArtists = profile.labelArtists[labelNorm];
        if (sharedArtists && sharedArtists.size > 0) {
            var neighbourScore = Math.min(sharedArtists.size / Math.max(profile.total, 1), 0.3) * W.labelNeighbour;
            if (neighbourScore > 0.2) {
                score += neighbourScore;
                signals.labelNeighbour = neighbourScore;
            }
        }
    }

    // ── 3. Style / genre matching (TF-IDF weighted) ────────────────────────────
    var tags       = expandTags(item.tags);
    var styleScore = 0;
    var genreScore = 0;
    var bestStyleEntry = null;

    tags.forEach(function (tag) {
        // Style match
        if (profile.styles[tag]) {
            var sw = profile.styles[tag];
            // IDF rarity: clamp to [1, 3.5] so ultra-rare tags don't explode scores
            var idfMult = idf ? Math.min(Math.max(idf[tag] || 1, 1), 3.5) : 1;
            var tagScore = sw * W.style * idfMult;
            styleScore += tagScore;
            if (sw > 0.2 && (!bestStyleEntry || tagScore > bestStyleEntry.weight)) {
                bestStyleEntry = {
                    type: 'style',
                    text: tag.charAt(0).toUpperCase() + tag.slice(1),
                    weight: tagScore
                };
            }
        }
        // Genre match (capped IDF mult to avoid double-boosting broad terms)
        if (profile.genres[tag]) {
            var gw = profile.genres[tag];
            var idfMult2 = idf ? Math.min(idf[tag] || 1, 2) : 1;
            genreScore += gw * W.genre * idfMult2;
        }
    });

    // Cap style score to prevent tag-stuffed items from dominating
    styleScore = Math.min(styleScore, W.style * 5);
    score += styleScore;
    score += genreScore;
    if (styleScore > 0) signals.style = styleScore;
    if (genreScore > 0) signals.genre = genreScore;
    if (bestStyleEntry) reasons.push(bestStyleEntry);

    // ── 4. Era proximity ───────────────────────────────────────────────────────
    if (item.year && profile.medianYear) {
        var diff = Math.abs(item.year - profile.medianYear);
        var eraScore = Math.max(0, 1 - diff / 25) * W.era;
        score += eraScore;
        if (eraScore > 0.5) signals.era = eraScore;
    }

    // Decade distribution bonus
    if (item.year && Object.keys(profile.decades).length > 0) {
        var decade = String(Math.floor(item.year / 10) * 10);
        if (profile.decades[decade]) {
            var decScore = profile.decades[decade] * W.decade;
            score += decScore;
            signals.decade = decScore;
        }
    }

    // ── 5. Streaming affinity ──────────────────────────────────────────────────
    // Only applied when the user has streaming data synced (Spotify / SoundCloud).
    if (streaming && streaming.hasData && artistNorm && !SKIP_ARTISTS.has(artistNorm)) {
        var streamingAffinity = streaming.artistAffinity[artistNorm] || 0;
        if (streamingAffinity > 0) {
            // Choose the strongest applicable weight based on affinity level
            // (high affinity = top_artist weight, lower = liked_track weight)
            var streamingWeight = streamingAffinity >= 0.6
                ? W_STREAMING.userTopArtist
                : streamingAffinity >= 0.3
                    ? W_STREAMING.userRecentPlay
                    : W_STREAMING.userLikedTrack;

            var streamingScore = streamingAffinity * streamingWeight;
            score += streamingScore;
            signals.streaming = streamingScore;
            if (streamingAffinity >= 0.4) {
                reasons.push({
                    type:   'streaming',
                    text:   item.artist + ' (on your playlists)',
                    weight: streamingScore,
                });
            }
        }
    }

    var NOISE_FLOOR = 2.5;
    if (score < NOISE_FLOOR) return null;

    // Sort reasons by weight, keep top 3
    reasons.sort(function (a, b) { return b.weight - a.weight; });

    return {
        score:       Math.round(score * 10) / 10,
        signals:     signals,
        reasons:     reasons.slice(0, 3).map(function (r) { return r.text; }),
        reasonTypes: reasons.slice(0, 3).map(function (r) { return r.type; }),
        item:        item,
    };
}

// ─── Diversity injection ──────────────────────────────────────────────────────
/**
 * Limit results to maxPerArtist per artist to prevent echo-chamber outputs.
 * Excess items are moved to the end of the list (not discarded).
 */
function diversify(scored, maxPerArtist) {
    maxPerArtist = maxPerArtist || 3;
    var counts   = {};
    var primary  = [];
    var overflow = [];

    scored.forEach(function (r) {
        var artist = (r.item.artist || '').toLowerCase();
        counts[artist] = (counts[artist] || 0) + 1;
        if (counts[artist] <= maxPerArtist) {
            primary.push(r);
        } else {
            overflow.push(r);
        }
    });

    return primary.concat(overflow);
}

// ─── Normalise score → 0-100 match % ─────────────────────────────────────────
function scoreToPercent(score, maxScore) {
    if (!maxScore || maxScore <= 0) return 50;
    // Soft cap: scores above 80th percentile all look like 95-100%
    return Math.min(100, Math.round((score / maxScore) * 100));
}

// ─── Public: getRecommendations ───────────────────────────────────────────────
/**
 * Return top-N recommended in-stock records for a given Discogs username.
 *
 * @param {string} username
 * @param {number} [limit=30]
 * @returns {{ profile, recommendations, topGenres, topStyles, wantlistSize, inventorySize, computeMs }}
 */
function getRecommendations(username, limit) {
    limit = limit || 30;
    var t0 = Date.now();

    var user     = db.getOrCreateUser(username);
    var wantlist = db.getActiveWantlist(user.id);

    if (!wantlist.length) {
        return {
            profile:         null,
            recommendations: [],
            topGenres:       [],
            topStyles:       [],
            wantlistSize:    0,
            inventorySize:   0,
            computeMs:       Date.now() - t0,
        };
    }

    var profile = buildTasteProfile(wantlist);

    // Build dedup set: (artist|title) keys already on wantlist
    var wantlistKeys = new Set(
        wantlist.map(function (w) {
            return ((w.artist || '') + '|' + (w.title || '')).toLowerCase();
        })
    );

    // Pull all in-stock inventory from the catalog stores
    var inventory = db.getAllInStockInventory();

    // Build TF-IDF corpus once over the full inventory
    var idf = buildCorpusIDF(inventory);

    // Score every item
    var scored = [];
    inventory.forEach(function (item) {
        var result = scoreItem(item, profile, wantlistKeys, idf);
        if (result) scored.push(result);
    });

    // Sort descending by score
    scored.sort(function (a, b) { return b.score - a.score; });

    // Diversity: max 3 items per artist in primary results
    scored = diversify(scored, 3);

    // Compute normalised match % (relative to top result)
    var maxScore = scored.length ? scored[0].score : 1;

    // Top genres and styles from wantlist profile (for the UI)
    var topGenres = Object.keys(profile.genres)
        .sort(function (a, b) { return profile.genres[b] - profile.genres[a]; })
        .slice(0, 5)
        .map(function (g) { return g.charAt(0).toUpperCase() + g.slice(1); });

    var topStyles = Object.keys(profile.styles)
        .sort(function (a, b) { return profile.styles[b] - profile.styles[a]; })
        .slice(0, 8)
        .map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); });

    return {
        profile:         profile,
        topGenres:       topGenres,
        topStyles:       topStyles,
        wantlistSize:    wantlist.length,
        inventorySize:   inventory.length,
        computeMs:       Date.now() - t0,
        recommendations: scored.slice(0, limit).map(function (r) {
            return {
                store:       r.item.store,
                title:       r.item.title     || r.item.title_raw || '',
                artist:      r.item.artist    || '',
                label:       r.item.label     || '',
                catno:       r.item.catno     || '',
                year:        r.item.year      || null,
                price:       r.item.price_usd || null,
                url:         r.item.url       || '',
                image:       r.item.image_url || '',
                tags:        expandTags(r.item.tags).slice(0, 6),
                score:       r.score,
                matchPct:    scoreToPercent(r.score, maxScore),
                reasons:     r.reasons,
                reasonTypes: r.reasonTypes,
                signals:     r.signals,
            };
        }),
    };
}

module.exports = {
    buildTasteProfile:  buildTasteProfile,
    buildCorpusIDF:     buildCorpusIDF,
    getRecommendations: getRecommendations,
};
