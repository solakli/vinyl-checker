'use strict';

/**
 * Stage 2: Discogs Release Meta Sync
 * Fetches community have/want/rating + country/year for wantlist + collection releases.
 * Also extracts YouTube video IDs from Discogs videos[] array at zero quota cost.
 * Rate: 2.5s per release → ~24 req/min (under 25/min unauthenticated limit).
 * Covers up to 300 stale releases per run (30-day TTL).
 */

'use strict';

const db = require('../../db');
const discogs = require('../discogs');

module.exports = async function metaSync(userId, username) {
    var d = db.getDb();
    var ytEnrich = require('../youtube-enrichment');

    var cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ');

    var items = d.prepare(`
        SELECT discogs_id FROM (
            SELECT w.discogs_id, rm.fetched_at FROM wantlist w
            LEFT JOIN release_meta rm ON rm.discogs_id = w.discogs_id
            WHERE w.user_id = ? AND w.active = 1 AND w.discogs_id IS NOT NULL
              AND (rm.discogs_id IS NULL OR replace(rm.fetched_at,'T',' ') < ?)
            UNION
            SELECT c.discogs_id, rm.fetched_at FROM collection c
            LEFT JOIN release_meta rm ON rm.discogs_id = c.discogs_id
            WHERE c.user_id = ? AND c.discogs_id IS NOT NULL
              AND (rm.discogs_id IS NULL OR replace(rm.fetched_at,'T',' ') < ?)
        ) ORDER BY fetched_at ASC NULLS FIRST
        LIMIT 300
    `).all(userId, cutoff, userId, cutoff);

    console.log('[stage:meta_sync]', username, '—', items.length, 'items to enrich');
    if (items.length === 0) return { itemsProcessed: 0 };

    var upsert = d.prepare(`
        INSERT OR REPLACE INTO release_meta
            (discogs_id, community_have, community_want, avg_rating, ratings_count, country, year, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    var processed = 0;
    for (var i = 0; i < items.length; i++) {
        var id = items[i].discogs_id;
        try {
            var det = await discogs.fetchReleaseDetails(id);
            var comm = det.community || {};
            upsert.run(
                id,
                comm.have   || null,
                comm.want   || null,
                comm.rating ? comm.rating.average : null,
                comm.rating ? comm.rating.count   : null,
                det.country  || null,
                det.released ? parseInt(det.released, 10) || null : null
            );
            // Free: Discogs already returns videos[] — extract YouTube ID at zero quota cost
            var videoId = ytEnrich.extractVideoIdFromDiscogs(det.videos || []);
            if (videoId) db.saveStreamingMetadata(id, { youtubeVideoId: videoId });
            processed++;
        } catch(e) { /* 404 or rate-limit — skip silently, will retry next run */ }
        // 2.5s gap → 24 req/min safely under unauthenticated limit
        await new Promise(function(r) { setTimeout(r, 2500); });
    }

    console.log('[stage:meta_sync]', username, 'done —', processed, 'enriched');
    return { itemsProcessed: processed };
};
