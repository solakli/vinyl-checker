'use strict';

/**
 * Discogs Wantlist / Collection Mutations
 *
 * Uses the existing oauth.js discogsAuthHeader() for signing — no new npm deps.
 * All functions return Promises; the server endpoints await them.
 */

const https  = require('https');
const oauth  = require('./oauth');

const USER_AGENT = 'VinylWantlistChecker/1.0 +https://github.com/solakli/vinyl-checker';

/**
 * Signed HTTPS request to api.discogs.com
 * @param {string} method  GET / PUT / POST / DELETE
 * @param {string} path    e.g. '/users/osolakli/wants/12345'
 * @param {string} accessToken
 * @param {string} accessSecret
 * @returns {Promise<object>} parsed JSON body (or {} on 204 / empty responses)
 */
function discogsRequest(method, path, accessToken, accessSecret) {
    return new Promise(function(resolve, reject) {
        var url = 'https://api.discogs.com' + path;
        var authHeader = oauth.discogsAuthHeader(method, url, accessToken, accessSecret);

        var options = {
            hostname: 'api.discogs.com',
            path:     path,
            method:   method,
            headers: {
                'Authorization':  authHeader,
                'User-Agent':     USER_AGENT,
                'Content-Type':   'application/json',
                'Content-Length': 0,
            }
        };

        var req = https.request(options, function(res) {
            var raw = '';
            res.on('data', function(c) { raw += c; });
            res.on('end', function() {
                if (res.statusCode === 204 || res.statusCode === 201 || res.statusCode === 200) {
                    try { resolve(raw ? JSON.parse(raw) : {}); } catch(e) { resolve({}); }
                } else {
                    reject(new Error('Discogs ' + method + ' ' + path + ' → ' +
                        res.statusCode + ': ' + raw.slice(0, 300)));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Add a release to the authenticated user's Discogs wantlist.
 * PUT /users/{username}/wants/{release_id}
 * Idempotent on Discogs's side (re-adding returns 200).
 */
function addToWantlist(discogsUsername, releaseId, accessToken, accessSecret) {
    return discogsRequest(
        'PUT',
        '/users/' + encodeURIComponent(discogsUsername) + '/wants/' + releaseId,
        accessToken, accessSecret
    );
}

/**
 * Remove a release from the authenticated user's Discogs wantlist.
 * DELETE /users/{username}/wants/{release_id}
 */
function removeFromWantlist(discogsUsername, releaseId, accessToken, accessSecret) {
    return discogsRequest(
        'DELETE',
        '/users/' + encodeURIComponent(discogsUsername) + '/wants/' + releaseId,
        accessToken, accessSecret
    );
}

/**
 * Add a release to the user's collection (folder 1 = Uncategorized).
 * POST /users/{username}/collection/folders/1/releases/{release_id}
 * Returns { instance_id } — store this to later remove the specific copy.
 */
function addToCollection(discogsUsername, releaseId, accessToken, accessSecret) {
    return discogsRequest(
        'POST',
        '/users/' + encodeURIComponent(discogsUsername) + '/collection/folders/1/releases/' + releaseId,
        accessToken, accessSecret
    );
}

module.exports = { addToWantlist, removeFromWantlist, addToCollection };
