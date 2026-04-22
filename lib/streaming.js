'use strict';

/**
 * Streaming Data Integration
 *
 * Fetches and caches user listening activity from Spotify and SoundCloud
 * (YouTube activity is handled via the existing Google OAuth flow in oauth.js).
 *
 * Architecture:
 *  - Sync functions write to:
 *      user_streaming_activity  — per-user listening history / top artists
 *      streaming_metadata       — per-release popularity signals
 *  - buildStreamingProfile() reads from those tables (zero live API calls)
 *  - getRecommendations() in recommendations.js calls buildStreamingProfile()
 *    and injects streaming signals into scoreItem() via the profile object
 *
 * Dan's integration points:
 *   POST /api/streaming/sync/:username  → calls syncAll()
 *   GET  /api/streaming/:username       → calls buildStreamingProfile()
 *   The recommendation engine picks up streaming signals automatically once
 *   the tables are populated.
 *
 * Adding a new provider (e.g. Last.fm):
 *   1. Add OAuth flow to lib/oauth.js
 *   2. Add a sync function here (syncLastFmActivity)
 *   3. Call it from syncAll()
 *   4. The existing buildStreamingProfile() will pick up any artist_name rows
 *      stored in user_streaming_activity regardless of provider.
 */

const db    = require('../db');
const oauth = require('./oauth');

// ─── Token helpers ────────────────────────────────────────────────────────────

/**
 * Return a valid Spotify access token for a user, auto-refreshing if expired.
 * Returns null if no token is stored or refresh fails.
 */
async function getValidSpotifyToken(userId) {
    var token = db.getOAuthToken(userId, 'spotify');
    if (!token || !token.access_token) return null;

    // Refresh if expires within 5 minutes
    var expiryMs = token.expires_at ? new Date(token.expires_at).getTime() : 0;
    if (expiryMs && expiryMs < Date.now() + 5 * 60 * 1000) {
        if (!token.refresh_token) {
            console.warn('[streaming] Spotify token expired and no refresh_token for user', userId);
            return null;
        }
        try {
            var refreshed = await oauth.spotifyRefreshToken(token.refresh_token);
            db.saveOAuthToken(userId, 'spotify', {
                accessToken:  refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt:    new Date(refreshed.expiresAt).toISOString(),
            });
            return refreshed.accessToken;
        } catch (e) {
            console.error('[streaming] Spotify token refresh failed for user', userId, ':', e.message);
            return null;
        }
    }

    return token.access_token;
}

/**
 * Return a valid SoundCloud access token for a user, auto-refreshing if expired.
 * SoundCloud tokens with scope 'non-expiring' never expire, so refresh is rarely needed.
 */
async function getValidSoundCloudToken(userId) {
    var token = db.getOAuthToken(userId, 'soundcloud');
    if (!token || !token.access_token) return null;

    var expiryMs = token.expires_at ? new Date(token.expires_at).getTime() : 0;
    if (expiryMs && expiryMs < Date.now() + 5 * 60 * 1000) {
        if (!token.refresh_token) {
            console.warn('[streaming] SoundCloud token expired and no refresh_token for user', userId);
            return null;
        }
        try {
            var refreshed = await oauth.soundcloudRefreshToken(token.refresh_token);
            db.saveOAuthToken(userId, 'soundcloud', {
                accessToken:  refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt:    refreshed.expiresAt ? new Date(refreshed.expiresAt).toISOString() : null,
            });
            return refreshed.accessToken;
        } catch (e) {
            console.error('[streaming] SoundCloud token refresh failed for user', userId, ':', e.message);
            return null;
        }
    }

    return token.access_token;
}

// ─── Spotify sync ─────────────────────────────────────────────────────────────

/**
 * Fetch user's top artists (3 time ranges) and recently played tracks.
 * Stores results in user_streaming_activity.
 *
 * @param {number} userId
 * @param {string} accessToken  - valid Spotify access token
 * @returns {{ provider: 'spotify', saved: number, errors: string[] }}
 */
async function syncSpotifyActivity(userId, accessToken) {
    var saved  = 0;
    var errors = [];

    // ── Top artists — all 3 time windows for a richer taste profile ───────────
    var ranges = ['short_term', 'medium_term', 'long_term'];
    for (var ri = 0; ri < ranges.length; ri++) {
        var range = ranges[ri];
        try {
            var resp = await oauth.spotifyRequest(
                'GET',
                '/v1/me/top/artists?limit=50&time_range=' + range,
                accessToken
            );
            var artists = resp.items || [];
            var rows = artists.map(function (artist, idx) {
                return {
                    userId:      userId,
                    provider:    'spotify',
                    activityType: 'top_artist',
                    artistName:  artist.name,
                    trackName:   null,
                    albumName:   null,
                    providerUri: artist.uri,
                    playCount:   null,
                    // Affinity: #1 = 1.0, #50 ≈ 0.02 (linear decay, min 0.02)
                    userAffinity: Math.max(0.02, 1.0 - (idx / Math.max(artists.length, 1)) * 0.98),
                    recordedAt:  new Date().toISOString(),
                };
            });
            db.saveStreamingActivity(userId, 'spotify', 'top_artist_' + range, rows);
            saved += rows.length;
        } catch (e) {
            errors.push('top_artists_' + range + ': ' + e.message);
            console.error('[streaming] Spotify top artists (' + range + '):', e.message);
        }
    }

    // ── Recently played tracks ────────────────────────────────────────────────
    try {
        var recentResp = await oauth.spotifyRequest(
            'GET',
            '/v1/me/player/recently-played?limit=50',
            accessToken
        );
        var recent = recentResp.items || [];
        var recentRows = recent.map(function (play, idx) {
            var track   = play.track || {};
            var artists = (track.artists || []).map(function (a) { return a.name; }).join(', ');
            return {
                userId:       userId,
                provider:     'spotify',
                activityType: 'recent_play',
                artistName:   artists,
                trackName:    track.name  || null,
                albumName:    track.album ? track.album.name : null,
                providerUri:  track.uri   || null,
                playCount:    null,
                userAffinity: Math.max(0.1, 1.0 - (idx / Math.max(recent.length, 1)) * 0.9),
                recordedAt:   play.played_at || new Date().toISOString(),
            };
        });
        db.saveStreamingActivity(userId, 'spotify', 'recent_play', recentRows);
        saved += recentRows.length;
    } catch (e) {
        errors.push('recently_played: ' + e.message);
        console.error('[streaming] Spotify recently played:', e.message);
    }

    return { provider: 'spotify', saved: saved, errors: errors };
}

/**
 * Search Spotify for a wantlist release and return popularity signals.
 * Suitable for enriching streaming_metadata for individual releases.
 *
 * @param {string} accessToken
 * @param {string} artist
 * @param {string} title
 * @returns {object|null}
 */
async function searchSpotifyAlbum(accessToken, artist, title) {
    try {
        var q    = encodeURIComponent('artist:' + artist + ' album:' + title);
        var resp = await oauth.spotifyRequest(
            'GET',
            '/v1/search?q=' + q + '&type=album&limit=3',
            accessToken
        );
        var albums = resp.albums && resp.albums.items;
        if (!albums || albums.length === 0) return null;

        var album = albums[0];
        var artistId = album.artists && album.artists[0] && album.artists[0].id;
        var artistFollowers = null;

        if (artistId) {
            try {
                var artistResp = await oauth.spotifyRequest('GET', '/v1/artists/' + artistId, accessToken);
                artistFollowers = artistResp.followers ? artistResp.followers.total : null;
            } catch (_) {}
        }

        return {
            spotifyAlbumUri:        album.uri  || null,
            spotifyArtistUri:       album.artists && album.artists[0] && album.artists[0].uri || null,
            spotifyPopularity:      album.popularity != null ? album.popularity : null,
            spotifyArtistFollowers: artistFollowers,
        };
    } catch (e) {
        console.error('[streaming] searchSpotifyAlbum error:', e.message);
        return null;
    }
}

// ─── SoundCloud sync ──────────────────────────────────────────────────────────

/**
 * Fetch user's liked tracks from SoundCloud.
 * Stores results in user_streaming_activity.
 *
 * @param {number} userId
 * @param {string} accessToken
 * @returns {{ provider: 'soundcloud', saved: number, errors: string[] }}
 */
async function syncSoundCloudActivity(userId, accessToken) {
    var saved  = 0;
    var errors = [];

    try {
        // SoundCloud API v2: /me/likes returns tracks and playlists in 'collection'
        var resp  = await oauth.soundcloudRequest('GET', '/me/likes?limit=200', accessToken);
        var items = Array.isArray(resp) ? resp : (resp.collection || []);

        var rows = [];
        items.forEach(function (item, idx) {
            // collection entries have a 'track' or 'playlist' key
            var track = item.track || item;
            if (!track || !track.id) return; // skip playlists / malformed

            var artistName = (track.user && track.user.username) ? track.user.username : '';
            rows.push({
                userId:       userId,
                provider:     'soundcloud',
                activityType: 'liked_track',
                artistName:   artistName,
                trackName:    track.title || null,
                albumName:    null,
                providerUri:  String(track.id),
                playCount:    track.playback_count || null,
                userAffinity: Math.max(0.05, 1.0 - (idx / Math.max(items.length, 1)) * 0.9),
                recordedAt:   new Date().toISOString(),
            });
        });

        db.saveStreamingActivity(userId, 'soundcloud', 'liked_track', rows);
        saved += rows.length;
    } catch (e) {
        errors.push('liked_tracks: ' + e.message);
        console.error('[streaming] SoundCloud likes:', e.message);
    }

    return { provider: 'soundcloud', saved: saved, errors: errors };
}

// ─── Full sync ────────────────────────────────────────────────────────────────

/**
 * Sync all connected streaming providers for a user.
 * Called by POST /api/streaming/sync/:username
 *
 * @param {number} userId
 * @returns {object}  results per provider
 */
async function syncAll(userId) {
    var results = {};

    // Spotify
    var spotifyToken = await getValidSpotifyToken(userId);
    if (spotifyToken) {
        results.spotify = await syncSpotifyActivity(userId, spotifyToken);
    } else {
        results.spotify = { provider: 'spotify', skipped: true, reason: 'not connected' };
    }

    // SoundCloud
    var scToken = await getValidSoundCloudToken(userId);
    if (scToken) {
        results.soundcloud = await syncSoundCloudActivity(userId, scToken);
    } else {
        results.soundcloud = { provider: 'soundcloud', skipped: true, reason: 'not connected' };
    }

    // YouTube activity sync is handled separately via the existing Google OAuth
    // (we use their Liked Videos / watch history, which requires extra scopes).
    // Dan's team: add syncYouTubeActivity() here once Google scopes are updated.

    return results;
}

// ─── Profile builder ──────────────────────────────────────────────────────────

/**
 * Build a streaming taste profile for a user from stored activity.
 * Returns artist affinity scores that the recommendation engine can use.
 *
 * Output shape matches what scoreItem() expects:
 *   {
 *     artistAffinity: { 'aphex twin': 0.93, 'burial': 0.75, ... },
 *     totalActivities: 147,
 *     hasData: true,
 *     providers: { spotify: { rows: 120, lastSynced: '...' }, soundcloud: { ... } }
 *   }
 */
function buildStreamingProfile(userId) {
    try {
        var activities = db.getStreamingActivity(userId);
        var syncStatus = db.getStreamingSyncStatus(userId);

        if (!activities || activities.length === 0) {
            return { artistAffinity: {}, hasData: false, providers: syncStatus };
        }

        var artistAffinity = {};

        activities.forEach(function (row) {
            if (!row.artist_name) return;

            // Multi-artist tracks are stored as "Artist A, Artist B" — split them
            var artists = row.artist_name.split(/,\s*/);
            artists.forEach(function (rawArtist) {
                var norm = rawArtist.trim().toLowerCase();
                if (!norm || norm.length < 2) return;
                // Skip generic names
                if (norm === 'various' || norm === 'v/a' || norm === 'va' || norm === 'unknown') return;

                // Weight multiplier by activity type
                var typeMultiplier = 1.0;
                if (row.activity_type === 'top_artist')   typeMultiplier = 1.6;
                else if (row.activity_type === 'recent_play') typeMultiplier = 1.2;
                else if (row.activity_type === 'liked_track') typeMultiplier = 1.0;

                var weighted = Math.min(1.0, (row.user_affinity || 0.5) * typeMultiplier);
                artistAffinity[norm] = Math.max(artistAffinity[norm] || 0, weighted);
            });
        });

        // Normalize to [0, 1]
        var vals    = Object.values(artistAffinity);
        var maxVal  = vals.length ? Math.max.apply(null, vals) : 1;
        if (maxVal > 0) {
            Object.keys(artistAffinity).forEach(function (k) {
                artistAffinity[k] = artistAffinity[k] / maxVal;
            });
        }

        return {
            artistAffinity:  artistAffinity,
            totalActivities: activities.length,
            hasData:         Object.keys(artistAffinity).length > 0,
            providers:       syncStatus,
        };
    } catch (e) {
        console.error('[streaming] buildStreamingProfile error:', e.message);
        return { artistAffinity: {}, hasData: false };
    }
}

module.exports = {
    // Token helpers
    getValidSpotifyToken:    getValidSpotifyToken,
    getValidSoundCloudToken: getValidSoundCloudToken,
    // Sync functions
    syncSpotifyActivity:     syncSpotifyActivity,
    syncSoundCloudActivity:  syncSoundCloudActivity,
    searchSpotifyAlbum:      searchSpotifyAlbum,
    syncAll:                 syncAll,
    // Profile
    buildStreamingProfile:   buildStreamingProfile,
};
