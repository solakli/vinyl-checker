'use strict';

/**
 * Stage 1: Wantlist + Collection Sync
 * Delegates to the Discogs library — same logic as the existing backgroundSync.
 * Returns { itemsProcessed } for the pipeline worker to record.
 */

const db = require('../../db');

module.exports = async function wantlistSync(userId, username) {
    var d = db.getDb();
    var discogs = require('../discogs');

    // Build OAuth header function if the user has connected their Discogs account.
    // fetchWantlist/fetchCollection expect a headersFn(method, path) → headers object,
    // NOT a plain { accessToken, accessSecret } object (that form doesn't get signed).
    var token = db.getOAuthToken ? db.getOAuthToken(userId, 'discogs') : null;
    var headersFn = null;
    if (token && token.access_token && token.access_secret) {
        var oauthLib = require('../oauth');
        headersFn = function(method, path) {
            var fullUrl = 'https://api.discogs.com' + path;
            return {
                'User-Agent': 'VinylWantlistChecker/1.0',
                'Authorization': oauthLib.discogsAuthHeader(method, fullUrl, token.access_token, token.access_secret)
            };
        };
    }

    var processed = 0;

    // ── Wantlist ──────────────────────────────────────────────────────────────
    try {
        var wantlist = await discogs.fetchWantlist(username, headersFn);
        if (wantlist && wantlist.length) {
            db.syncWantlist(userId, wantlist);
            processed += wantlist.length;
            console.log('[stage:wantlist_sync]', username, '— wantlist:', wantlist.length);
        }
    } catch (e) {
        console.error('[stage:wantlist_sync] wantlist error for', username + ':', e.message);
    }

    // ── Collection ────────────────────────────────────────────────────────────
    try {
        var items = await discogs.fetchCollection(username, headersFn);
        if (items && items.length) {
            db.syncCollectionItems(userId, items);
            processed += items.length;
            console.log('[stage:wantlist_sync]', username, '— collection:', items.length);
        }
    } catch (e) {
        console.error('[stage:wantlist_sync] collection error for', username + ':', e.message);
    }

    // Update last_sync timestamp
    d.prepare("UPDATE users SET last_sync=datetime('now') WHERE id=?").run(userId);

    return { itemsProcessed: processed };
};
