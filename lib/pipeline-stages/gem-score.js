'use strict';

/**
 * Stage 5: Gem Score Recompute (terminal stage)
 * Re-scores the user's wantlist + collection with the current gem-score formula.
 * Results written to a gem_score_cache table so /api/gem-score doesn't recompute
 * on every read. Also invalidates the digger_recommendations cache so "Recommend"
 * suggestions reflect the latest scores.
 */

const db = require('../../db');

module.exports = async function gemScore(userId, username) {
    var gemScoreLib = require('../gem-score');
    var d = db.getDb();

    var scored = gemScoreLib.scoreUserCollection(userId, d);
    var summary = gemScoreLib.tasteSummary(scored);

    // Invalidate stale digger recommendations so next fetch recomputes
    d.prepare('DELETE FROM digger_recommendations WHERE user_id=?').run(userId);

    console.log('[stage:gem_score]', username, '—', scored.length, 'records scored, undergroundPct:', summary.undergroundPct);
    return { itemsProcessed: scored.length };
};
