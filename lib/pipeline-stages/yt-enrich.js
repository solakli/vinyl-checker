'use strict';

/**
 * Stage 4: YouTube Stats + Comment Enrichment
 * Batch-fetches view/like/comment counts (1 unit per 50 videos) and fetches
 * comment threads per video (1 unit per video) to extract genres/DJs/era signals.
 * Quota-limited: runs until keys are exhausted, then stops gracefully.
 */

const db = require('../../db');

module.exports = async function ytEnrich(userId, username) {
    var ytEnrichLib = require('../youtube-enrichment');

    var ytKeys = loadYtKeys();
    if (!ytKeys.length) {
        console.log('[stage:yt_enrich]', username, '— no YouTube API keys, skipping');
        return { itemsProcessed: 0 };
    }

    var before = countEnriched();
    await ytEnrichLib.runYouTubeEnrichment(ytKeys);
    var after  = countEnriched();
    var enriched = Math.max(0, after - before);

    console.log('[stage:yt_enrich]', username, '—', enriched, 'newly enriched');
    return { itemsProcessed: enriched };
};

function loadYtKeys() {
    var keys = [];
    if (process.env.YOUTUBE_API_KEY) keys.push(process.env.YOUTUBE_API_KEY);
    for (var i = 2; i <= 50; i++) {
        var k = process.env['YOUTUBE_API_KEY_' + i];
        if (!k) break;
        keys.push(k);
    }
    return keys;
}

function countEnriched() {
    return db.getDb().prepare(
        "SELECT COUNT(*) as c FROM streaming_metadata WHERE youtube_enriched_at IS NOT NULL"
    ).get().c;
}
