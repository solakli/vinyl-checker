'use strict';

/**
 * Stage 3: YouTube Video ID Resolution
 * Resolves YouTube IDs for wantlist/collection releases that don't have one yet.
 * Uses YouTube Search API (100 quota units/search) — expensive, so runs
 * only for releases where Discogs videos[] came back empty (Stage 2 free path failed).
 * Returns { itemsProcessed } — actual search calls made.
 */

const db  = require('../../db');

module.exports = async function ytIdSearch(userId, username) {
    var ytEnrich = require('../youtube-enrichment');

    var ytKeys = loadYtKeys();
    if (!ytKeys.length) {
        console.log('[stage:yt_id_search]', username, '— no YouTube API keys, skipping');
        return { itemsProcessed: 0 };
    }

    // Run the search pass (searches only releases missing a video ID)
    var before = countMissingIds();
    await ytEnrich.runVideoIdSearch(ytKeys);
    var after  = countMissingIds();
    var found  = Math.max(0, before - after);

    console.log('[stage:yt_id_search]', username, '— resolved', found, 'new video IDs');
    return { itemsProcessed: found };
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

function countMissingIds() {
    return db.getDb().prepare(
        "SELECT COUNT(*) as c FROM streaming_metadata WHERE youtube_video_id IS NULL"
    ).get().c;
}
