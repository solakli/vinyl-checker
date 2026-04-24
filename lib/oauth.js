/**
 * OAuth handlers for Discogs (OAuth 1.0a) and YouTube/Google (OAuth 2.0)
 *
 * Environment variables needed:
 *   DISCOGS_CONSUMER_KEY, DISCOGS_CONSUMER_SECRET
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   BASE_URL (e.g. https://stream.ronautradio.la/vinyl)
 */

const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DISCOGS_KEY = process.env.DISCOGS_CONSUMER_KEY || '';
const DISCOGS_SECRET = process.env.DISCOGS_CONSUMER_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SC_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID || '';
const SC_CLIENT_SECRET = process.env.SOUNDCLOUD_CLIENT_SECRET || '';

// Temporary storage for OAuth 1.0a request tokens (in-memory, short-lived)
var pendingTokens = {};

// ═══════════════════════════════════════════════════════════════
// DISCOGS OAUTH 1.0a
// ═══════════════════════════════════════════════════════════════

function discogsEnabled() { return !!(DISCOGS_KEY && DISCOGS_SECRET); }

function oauthNonce() { return crypto.randomBytes(16).toString('hex'); }
function oauthTimestamp() { return Math.floor(Date.now() / 1000).toString(); }

function percentEncode(str) {
    return encodeURIComponent(str)
        .replace(/!/g, '%21').replace(/\*/g, '%2A')
        .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function oauthSignature(method, url, params, consumerSecret, tokenSecret) {
    var sortedKeys = Object.keys(params).sort();
    var paramStr = sortedKeys.map(function(k) {
        return percentEncode(k) + '=' + percentEncode(params[k]);
    }).join('&');

    var baseString = method.toUpperCase() + '&' + percentEncode(url) + '&' + percentEncode(paramStr);
    var signingKey = percentEncode(consumerSecret) + '&' + percentEncode(tokenSecret || '');

    return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function oauthHeader(params) {
    var parts = Object.keys(params).sort().map(function(k) {
        return percentEncode(k) + '="' + percentEncode(params[k]) + '"';
    });
    return 'OAuth ' + parts.join(', ');
}

/**
 * Step 1: Get request token from Discogs, return authorize URL
 */
function discogsRequestToken() {
    return new Promise(function(resolve, reject) {
        var callbackUrl = BASE_URL + '/api/auth/discogs/callback';
        var url = 'https://api.discogs.com/oauth/request_token';
        var nonce = oauthNonce();
        var timestamp = oauthTimestamp();

        var oauthParams = {
            oauth_consumer_key: DISCOGS_KEY,
            oauth_nonce: nonce,
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: timestamp,
            oauth_callback: callbackUrl,
            oauth_version: '1.0'
        };

        var sig = oauthSignature('POST', url, oauthParams, DISCOGS_SECRET, '');
        oauthParams.oauth_signature = sig;

        var postData = '';
        var options = {
            hostname: 'api.discogs.com',
            path: '/oauth/request_token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': oauthHeader(oauthParams),
                'User-Agent': 'VinylWantlistChecker/1.0'
            }
        };

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                if (res.statusCode !== 200) {
                    return reject(new Error('Discogs request token failed: ' + res.statusCode + ' ' + data));
                }
                var parsed = querystring.parse(data);
                if (!parsed.oauth_token) return reject(new Error('No oauth_token in response'));

                // Store the secret temporarily
                pendingTokens[parsed.oauth_token] = {
                    secret: parsed.oauth_token_secret,
                    created: Date.now()
                };

                // Clean old pending tokens (>10 min)
                Object.keys(pendingTokens).forEach(function(k) {
                    if (Date.now() - pendingTokens[k].created > 600000) delete pendingTokens[k];
                });

                resolve({
                    token: parsed.oauth_token,
                    authorizeUrl: 'https://discogs.com/oauth/authorize?oauth_token=' + parsed.oauth_token
                });
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Step 2: Exchange verifier for access token
 */
function discogsAccessToken(oauthToken, oauthVerifier) {
    return new Promise(function(resolve, reject) {
        var pending = pendingTokens[oauthToken];
        if (!pending) return reject(new Error('Unknown or expired OAuth token'));

        var tokenSecret = pending.secret;
        delete pendingTokens[oauthToken];

        var url = 'https://api.discogs.com/oauth/access_token';
        var nonce = oauthNonce();
        var timestamp = oauthTimestamp();

        var oauthParams = {
            oauth_consumer_key: DISCOGS_KEY,
            oauth_nonce: nonce,
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: timestamp,
            oauth_token: oauthToken,
            oauth_verifier: oauthVerifier,
            oauth_version: '1.0'
        };

        var sig = oauthSignature('POST', url, oauthParams, DISCOGS_SECRET, tokenSecret);
        oauthParams.oauth_signature = sig;

        var options = {
            hostname: 'api.discogs.com',
            path: '/oauth/access_token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': oauthHeader(oauthParams),
                'User-Agent': 'VinylWantlistChecker/1.0'
            }
        };

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                if (res.statusCode !== 200) {
                    return reject(new Error('Discogs access token failed: ' + res.statusCode + ' ' + data));
                }
                var parsed = querystring.parse(data);
                resolve({
                    accessToken: parsed.oauth_token,
                    accessSecret: parsed.oauth_token_secret
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Get Discogs identity (username) using OAuth credentials
 */
function discogsIdentity(accessToken, accessSecret) {
    return new Promise(function(resolve, reject) {
        var url = 'https://api.discogs.com/oauth/identity';
        var nonce = oauthNonce();
        var timestamp = oauthTimestamp();

        var oauthParams = {
            oauth_consumer_key: DISCOGS_KEY,
            oauth_nonce: nonce,
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: timestamp,
            oauth_token: accessToken,
            oauth_version: '1.0'
        };

        var sig = oauthSignature('GET', url, oauthParams, DISCOGS_SECRET, accessSecret);
        oauthParams.oauth_signature = sig;

        https.get({
            hostname: 'api.discogs.com',
            path: '/oauth/identity',
            headers: {
                'Authorization': oauthHeader(oauthParams),
                'User-Agent': 'VinylWantlistChecker/1.0'
            }
        }, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                if (res.statusCode !== 200) return reject(new Error('Identity check failed'));
                try {
                    var json = JSON.parse(data);
                    resolve({ id: json.id, username: json.username });
                } catch(e) { reject(new Error('Parse error')); }
            });
        }).on('error', reject);
    });
}

/**
 * Build OAuth 1.0a Authorization header for authenticated API requests
 */
function discogsAuthHeader(method, url, accessToken, accessSecret) {
    var nonce = oauthNonce();
    var timestamp = oauthTimestamp();

    // OAuth 1.0a: base URL must not contain query params — they go into the signing params
    var urlParts = url.split('?');
    var baseUrl = urlParts[0];
    var queryParams = {};
    if (urlParts[1]) {
        urlParts[1].split('&').forEach(function(pair) {
            var kv = pair.split('=');
            queryParams[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
        });
    }

    var oauthParams = {
        oauth_consumer_key: DISCOGS_KEY,
        oauth_nonce: nonce,
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: timestamp,
        oauth_token: accessToken,
        oauth_version: '1.0'
    };

    // Merge query params into signing params (OAuth 1.0a spec requires this)
    var signingParams = {};
    Object.keys(oauthParams).forEach(function(k) { signingParams[k] = oauthParams[k]; });
    Object.keys(queryParams).forEach(function(k) { signingParams[k] = queryParams[k]; });

    var sig = oauthSignature(method, baseUrl, signingParams, DISCOGS_SECRET, accessSecret);
    oauthParams.oauth_signature = sig;

    return oauthHeader(oauthParams);
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE/YOUTUBE OAUTH 2.0
// ═══════════════════════════════════════════════════════════════

function googleEnabled() { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }

// youtube.force-ssl is required for reading comments
var YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl';

function googleAuthorizeUrl(state) {
    var callbackUrl = BASE_URL + '/api/auth/google/callback';
    var params = {
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: YOUTUBE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state: state || ''
    };
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + querystring.stringify(params);
}

function googleExchangeCode(code) {
    return new Promise(function(resolve, reject) {
        var callbackUrl = BASE_URL + '/api/auth/google/callback';
        var postData = querystring.stringify({
            code: code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: callbackUrl,
            grant_type: 'authorization_code'
        });

        var options = {
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var json = JSON.parse(data);
                    if (json.error) return reject(new Error(json.error_description || json.error));
                    resolve({
                        accessToken: json.access_token,
                        refreshToken: json.refresh_token,
                        expiresIn: json.expires_in,
                        expiresAt: Date.now() + (json.expires_in * 1000)
                    });
                } catch(e) { reject(new Error('Parse error')); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function googleRefreshToken(refreshToken) {
    return new Promise(function(resolve, reject) {
        var postData = querystring.stringify({
            refresh_token: refreshToken,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token'
        });

        var options = {
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var json = JSON.parse(data);
                    if (json.error) return reject(new Error(json.error_description || json.error));
                    resolve({
                        accessToken: json.access_token,
                        expiresIn: json.expires_in,
                        expiresAt: Date.now() + (json.expires_in * 1000)
                    });
                } catch(e) { reject(new Error('Parse error')); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════════
// YOUTUBE API OPERATIONS
// ═══════════════════════════════════════════════════════════════

function youtubeRequest(method, path, accessToken, body) {
    return new Promise(function(resolve, reject) {
        var postData = body ? JSON.stringify(body) : '';
        var options = {
            hostname: 'www.googleapis.com',
            path: path,
            method: method,
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };
        if (body) options.headers['Content-Length'] = Buffer.byteLength(postData);

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        var errMsg = (json.error && json.error.message) || 'YouTube API error ' + res.statusCode;
                        return reject(new Error(errMsg));
                    }
                    resolve(json);
                } catch(e) { reject(new Error('Parse error')); }
            });
        });
        req.on('error', reject);
        if (body) req.write(postData);
        req.end();
    });
}

function createPlaylist(accessToken, title, description) {
    return youtubeRequest('POST', '/youtube/v3/playlists?part=snippet,status', accessToken, {
        snippet: { title: title, description: description || '' },
        status: { privacyStatus: 'private' }
    });
}

function addVideoToPlaylist(accessToken, playlistId, videoId) {
    return youtubeRequest('POST', '/youtube/v3/playlistItems?part=snippet', accessToken, {
        snippet: {
            playlistId: playlistId,
            resourceId: { kind: 'youtube#video', videoId: videoId }
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// SOUNDCLOUD OAUTH 2.1  (PKCE required)
// ═══════════════════════════════════════════════════════════════

// In-memory store for PKCE verifiers keyed by state param
var _scPkceStore = {};

function soundcloudEnabled() { return !!(SC_CLIENT_ID && SC_CLIENT_SECRET); }

/**
 * Generate a PKCE code_verifier and its SHA-256 base64url code_challenge.
 */
function _generatePkce() {
    var verifier = crypto.randomBytes(48).toString('base64url');
    var challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier: verifier, challenge: challenge };
}

/**
 * Build the SoundCloud authorize URL and stash the PKCE verifier.
 * @param {string} state  - opaque value to round-trip (e.g. username or session token)
 */
function soundcloudAuthorizeUrl(state) {
    var callbackUrl = BASE_URL + '/api/auth/soundcloud/callback';
    var pkce = _generatePkce();

    // Store verifier keyed by state so callback can retrieve it
    _scPkceStore[state] = { verifier: pkce.verifier, created: Date.now() };

    // Clean up stale entries (> 10 min)
    Object.keys(_scPkceStore).forEach(function(k) {
        if (Date.now() - _scPkceStore[k].created > 600000) delete _scPkceStore[k];
    });

    var params = new URLSearchParams({
        client_id: SC_CLIENT_ID,
        redirect_uri: callbackUrl,
        response_type: 'code',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state: state || ''
    });
    return 'https://secure.soundcloud.com/authorize?' + params.toString();
}

/**
 * Exchange authorization code for tokens (PKCE flow).
 * @param {string} code   - authorization code from callback
 * @param {string} state  - must match what was used in authorizeUrl to retrieve verifier
 */
function soundcloudExchangeCode(code, state) {
    return new Promise(function(resolve, reject) {
        var callbackUrl = BASE_URL + '/api/auth/soundcloud/callback';

        // Retrieve and consume the PKCE verifier
        var pkceEntry = state ? _scPkceStore[state] : null;
        var codeVerifier = pkceEntry ? pkceEntry.verifier : '';
        if (pkceEntry) delete _scPkceStore[state];

        var postData = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: SC_CLIENT_ID,
            client_secret: SC_CLIENT_SECRET,
            redirect_uri: callbackUrl,
            code_verifier: codeVerifier,
            code: code
        }).toString();

        var options = {
            hostname: 'secure.soundcloud.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var json = JSON.parse(data);
                    if (json.error) return reject(new Error((json.error_description || json.error) + ' (status ' + res.statusCode + ')'));
                    resolve({
                        accessToken: json.access_token,
                        refreshToken: json.refresh_token || null,
                        expiresIn: json.expires_in || null,
                        expiresAt: json.expires_in ? Date.now() + (json.expires_in * 1000) : null,
                        scope: json.scope || null
                    });
                } catch(e) { reject(new Error('SoundCloud token parse error: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function soundcloudRefreshToken(refreshToken) {
    return new Promise(function(resolve, reject) {
        var postData = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: SC_CLIENT_ID,
            client_secret: SC_CLIENT_SECRET,
            refresh_token: refreshToken
        }).toString();

        var options = {
            hostname: 'secure.soundcloud.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var json = JSON.parse(data);
                    if (json.error) return reject(new Error(json.error_description || json.error));
                    resolve({
                        accessToken: json.access_token,
                        refreshToken: json.refresh_token || refreshToken,
                        expiresIn: json.expires_in || null,
                        expiresAt: json.expires_in ? Date.now() + (json.expires_in * 1000) : null
                    });
                } catch(e) { reject(new Error('SoundCloud refresh parse error')); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

module.exports = {
    // Discogs OAuth
    discogsEnabled: discogsEnabled,
    discogsRequestToken: discogsRequestToken,
    discogsAccessToken: discogsAccessToken,
    discogsIdentity: discogsIdentity,
    discogsAuthHeader: discogsAuthHeader,
    // Google/YouTube OAuth
    googleEnabled: googleEnabled,
    googleAuthorizeUrl: googleAuthorizeUrl,
    googleExchangeCode: googleExchangeCode,
    googleRefreshToken: googleRefreshToken,
    // YouTube API
    createPlaylist: createPlaylist,
    addVideoToPlaylist: addVideoToPlaylist,
    youtubeRequest: youtubeRequest,
    // SoundCloud OAuth
    soundcloudEnabled: soundcloudEnabled,
    soundcloudAuthorizeUrl: soundcloudAuthorizeUrl,
    soundcloudExchangeCode: soundcloudExchangeCode,
    soundcloudRefreshToken: soundcloudRefreshToken
};
