/**
 * Discogs API functions: wantlist, marketplace stats, release details
 */

const https = require('https');

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || '';

function discogsHeaders() {
    var headers = { 'User-Agent': 'VinylWantlistChecker/1.0' };
    if (DISCOGS_TOKEN) headers['Authorization'] = 'Discogs token=' + DISCOGS_TOKEN;
    return headers;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function getArtistName(w) {
    var artists = w.basic_information && w.basic_information.artists;
    return (artists && artists[0] && artists[0].name) || 'Unknown';
}

function getLabelName(w) {
    var labels = w.basic_information && w.basic_information.labels;
    return (labels && labels[0] && labels[0].name) || '';
}

function getCatno(w) {
    var labels = w.basic_information && w.basic_information.labels;
    return (labels && labels[0] && labels[0].catno) || '';
}

// ═══════════════════════════════════════════════════════════════
// FETCH WANTLIST
// ═══════════════════════════════════════════════════════════════

async function fetchWantlist(username, userHeadersFn) {
    return new Promise(function (resolve, reject) {
        var fetchPage = function (page, allWants) {
            allWants = allWants || [];
            var pagePath = '/users/' + username + '/wants?per_page=100&page=' + page;
            var headers = (typeof userHeadersFn === 'function')
                ? userHeadersFn('GET', pagePath)
                : (userHeadersFn || discogsHeaders());
            console.log('[discogs] Fetching wantlist page', page, '| headers type:', typeof userHeadersFn, '| has Authorization:', !!headers.Authorization);
            https.get({
                hostname: 'api.discogs.com',
                path: pagePath,
                headers: headers
            }, function (res) {
                if (res.statusCode === 404) return reject(new Error('Username not found on Discogs'));
                if (res.statusCode === 403) {
                    var errData = '';
                    res.on('data', function(c) { errData += c; });
                    res.on('end', function() {
                        console.log('[discogs] 403 response:', errData.substring(0, 200));
                        reject(new Error('Wantlist is private. Ask ' + username + ' to make their wantlist public on Discogs (Settings → Privacy → Wantlist → Public)'));
                    });
                    return;
                }
                if (res.statusCode === 429) return reject(new Error('Discogs rate limit reached, try again in a minute'));
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('Discogs API error: ' + res.statusCode));
                var data = '';
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    try { var json = JSON.parse(data); } catch (e) { return reject(new Error('Parse error')); }
                    if (!json.wants || json.wants.length === 0) return resolve(allWants);
                    var wants = json.wants.map(function (w) {
                        var artist = getArtistName(w);
                        var bi = w.basic_information;
                        return {
                            id: w.id, artist: artist, title: bi.title,
                            year: bi.year, label: getLabelName(w), catno: getCatno(w),
                            thumb: bi.thumb || '',
                            genres: (bi.genres || []).join(', '),
                            styles: (bi.styles || []).join(', '),
                            searchQuery: (artist + ' ' + bi.title).trim()
                        };
                    });
                    allWants = allWants.concat(wants);
                    if (page < json.pagination.pages) setTimeout(function () { fetchPage(page + 1, allWants); }, 500);
                    else resolve(allWants);
                });
            }).on('error', reject);
        };
        fetchPage(1);
    });
}

// ═══════════════════════════════════════════════════════════════
// FETCH MARKETPLACE STATS
// ═══════════════════════════════════════════════════════════════

function fetchMarketplaceStats(discogsId) {
    var marketplaceUrl = 'https://www.discogs.com/sell/release/' + discogsId + '?ev=rb&destination=United+States';
    return new Promise(function (resolve, reject) {
        https.get({
            hostname: 'api.discogs.com',
            path: '/marketplace/stats/' + discogsId,
            headers: discogsHeaders()
        }, function (res) {
            if (res.statusCode === 429) return reject(new Error('Rate limit'));
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                try {
                    var json = JSON.parse(data);
                    resolve({
                        lowestPrice: json.lowest_price ? json.lowest_price.value : null,
                        currency: json.lowest_price ? json.lowest_price.currency : 'USD',
                        numForSale: json.num_for_sale || 0,
                        shipping: null,
                        marketplaceUrl: marketplaceUrl
                    });
                } catch (e) { resolve({ lowestPrice: null, numForSale: 0, marketplaceUrl: marketplaceUrl }); }
            });
        }).on('error', function () { resolve({ lowestPrice: null, numForSale: 0, marketplaceUrl: marketplaceUrl }); });
    });
}

// ═══════════════════════════════════════════════════════════════
// FETCH RELEASE DETAILS (new for Phase 1)
// ═══════════════════════════════════════════════════════════════

function fetchReleaseDetails(discogsId) {
    return new Promise(function (resolve, reject) {
        https.get({
            hostname: 'api.discogs.com',
            path: '/releases/' + discogsId,
            headers: discogsHeaders()
        }, function (res) {
            if (res.statusCode === 429) return reject(new Error('Rate limit'));
            if (res.statusCode === 404) return reject(new Error('Release not found'));
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('API error: ' + res.statusCode));
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                try {
                    var json = JSON.parse(data);
                    resolve({
                        id: json.id,
                        title: json.title,
                        artists: (json.artists || []).map(function (a) { return { name: a.name, role: a.role }; }),
                        tracklist: (json.tracklist || []).map(function (t) {
                            return { position: t.position, title: t.title, duration: t.duration };
                        }),
                        images: (json.images || []).map(function (img) {
                            return { uri: img.uri, uri150: img.uri150, type: img.type };
                        }),
                        videos: (json.videos || []).map(function (v) {
                            return { url: v.uri, title: v.title, duration: v.duration };
                        }),
                        community: json.community ? {
                            rating: json.community.rating ? {
                                average: json.community.rating.average,
                                count: json.community.rating.count
                            } : null,
                            have: json.community.have,
                            want: json.community.want
                        } : null,
                        extraartists: (json.extraartists || []).map(function (a) {
                            return { name: a.name, role: a.role };
                        }),
                        notes: json.notes || '',
                        formats: (json.formats || []).map(function (f) {
                            return { name: f.name, qty: f.qty, descriptions: f.descriptions || [] };
                        }),
                        country: json.country || '',
                        released: json.released || '',
                        genres: json.genres || [],
                        styles: json.styles || [],
                        uri: json.uri || ''
                    });
                } catch (e) { reject(new Error('Parse error: ' + e.message)); }
            });
        }).on('error', reject);
    });
}

// ═══════════════════════════════════════════════════════════════
// YOUTUBE VIDEO MATCHING (ported from create-playlist Python)
// ═══════════════════════════════════════════════════════════════

const VARIOUS_ARTISTS = new Set(['various', 'various artists', 'v/a', 'va']);

function extractYoutubeId(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('youtube.com')) {
            return parsed.searchParams.get('v') || null;
        }
        if (parsed.hostname.includes('youtu.be')) {
            return parsed.pathname.replace(/^\//, '') || null;
        }
    } catch (e) {}
    return null;
}

function normalizeVideoTitle(text) {
    text = text.toLowerCase();
    text = text.replace(/\[.*?\]/g, '');
    text = text.replace(/\(.*?\)/g, '');
    return text.replace(/\s+/g, ' ').trim();
}

function matchTrackToDiscogsVideo(trackTitle, artist, videos) {
    if (!videos || videos.length === 0) return null;

    const trackL = normalizeVideoTitle(trackTitle);
    const artistL = normalizeVideoTitle(artist);

    let bestVideoId = null;
    let bestScore = 0;

    for (const video of videos) {
        const videoId = extractYoutubeId(video.url || '');
        if (!videoId) continue;

        const vtitle = normalizeVideoTitle(video.title || '');
        let score = 0;

        // Track title must appear in the video title
        if (vtitle.includes(trackL)) {
            score += 3;
        } else {
            continue; // No point scoring if track title doesn't match
        }

        if (artistL && !VARIOUS_ARTISTS.has(artistL) && vtitle.includes(artistL)) {
            score += 2;
        }

        if (score > bestScore) {
            bestScore = score;
            bestVideoId = videoId;
        }
    }

    return bestVideoId;
}

function matchTracksToVideos(tracklist, artist, videos) {
    if (!tracklist || !videos) return [];

    return tracklist.map(function (track) {
        const videoId = matchTrackToDiscogsVideo(track.title, artist, videos);
        return {
            position: track.position,
            title: track.title,
            duration: track.duration,
            videoId: videoId
        };
    });
}

module.exports = {
    fetchWantlist,
    fetchMarketplaceStats,
    fetchReleaseDetails,
    extractYoutubeId,
    matchTrackToDiscogsVideo,
    matchTracksToVideos
};
