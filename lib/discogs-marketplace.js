'use strict';

/**
 * Discogs Marketplace fetcher.
 *
 * Calls the Discogs API (OAuth-signed) to get individual seller listings
 * for each wantlist release. Results are stored in the discogs_listings table
 * and fed into the cart optimizer alongside retail stores.
 */

const https = require('https');

// Country name → ISO-2 mapping for ships_from values Discogs returns
const COUNTRY_MAP = {
    'United States': 'US', 'Germany': 'DE', 'United Kingdom': 'GB',
    'France': 'FR', 'Japan': 'JP', 'Netherlands': 'NL', 'Australia': 'AU',
    'Canada': 'CA', 'Italy': 'IT', 'Spain': 'ES', 'Sweden': 'SE',
    'Belgium': 'BE', 'Austria': 'AT', 'Switzerland': 'CH', 'Poland': 'PL',
    'Turkey': 'TR', 'Brazil': 'BR', 'Mexico': 'MX', 'Argentina': 'AR',
    'Portugal': 'PT', 'Czech Republic': 'CZ', 'Denmark': 'DK',
    'Finland': 'FI', 'Greece': 'GR', 'Hungary': 'HU', 'Norway': 'NO',
    'Romania': 'RO', 'Slovakia': 'SK', 'South Korea': 'KR',
    'New Zealand': 'NZ', 'South Africa': 'ZA', 'Israel': 'IL',
    'Russia': 'RU', 'Ukraine': 'UA', 'India': 'IN', 'Hong Kong': 'HK',
    'Singapore': 'SG', 'Taiwan': 'TW', 'Thailand': 'TH', 'Colombia': 'CO',
    'Chile': 'CL', 'Ireland': 'IE', 'Malaysia': 'MY', 'Indonesia': 'ID'
};

const TO_USD = { USD: 1.0, EUR: 1.09, GBP: 1.27, JPY: 0.0067 };

function countryToISO(name) {
    return COUNTRY_MAP[name] || 'XX';
}

function toUSD(amount, currency) {
    return Math.round(amount * (TO_USD[currency] || 1.0) * 100) / 100;
}

/**
 * Fetch marketplace listings for one release from the Discogs API.
 *
 * @param {number} releaseId
 * @param {function} authHeaderFn  (method, url) => Authorization header string
 * @returns {Promise<object[]>}
 */
function fetchListingsForRelease(releaseId, authHeaderFn) {
    return new Promise(function (resolve, reject) {
        var path = '/marketplace/search?release_id=' + releaseId +
                   '&type=listing&per_page=100&sort=price&sort_order=asc';
        var url = 'https://api.discogs.com' + path;
        var authHeader = authHeaderFn('GET', url);

        https.get({
            hostname: 'api.discogs.com',
            path: path,
            headers: {
                'Authorization': authHeader,
                'User-Agent': 'GoldDigger/1.0',
                'Accept': 'application/json'
            }
        }, function (res) {
            var body = '';
            res.on('data', function (c) { body += c; });
            res.on('end', function () {
                if (res.statusCode === 429) return reject(new Error('RATE_LIMITED'));
                if (res.statusCode !== 200) return resolve([]);
                try {
                    var data = JSON.parse(body);
                    var listings = (data.results || []).map(function (r) {
                        var currency = (r.price && r.price.currency) || 'USD';
                        var price    = (r.price && r.price.value)    || 0;
                        return {
                            listingId:        r.id,
                            sellerUsername:   r.seller && r.seller.username,
                            sellerRating:     r.seller && r.seller.stats && parseFloat(r.seller.stats.rating),
                            sellerNumRatings: r.seller && r.seller.stats && r.seller.stats.total,
                            priceOriginal:    price,
                            currency:         currency,
                            priceUsd:         toUSD(price, currency),
                            condition:        r.condition || '',
                            shipsFrom:        countryToISO(r.ships_from || ''),
                            listingUrl:       r.uri || ('https://www.discogs.com/sell/item/' + r.id)
                        };
                    });
                    resolve(listings);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

/**
 * Run a full marketplace sync for a user.
 * Fetches listings for every wantlist item that has a discogs_id.
 *
 * @param {object[]} wantlistItems  from db.getActiveWantlist(userId)
 * @param {function} authHeaderFn
 * @param {object}   db
 * @param {function} [onProgress]  (done, total, item) callback
 */
async function syncMarketplace(wantlistItems, authHeaderFn, db, onProgress) {
    var items = wantlistItems.filter(function (w) { return w.discogs_id; });
    var total = items.length;
    var done  = 0;
    var errors = 0;

    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        try {
            var listings = await fetchListingsForRelease(item.discogs_id, authHeaderFn);
            db.saveDiscogsListings(item.id, listings);
        } catch (e) {
            if (e.message === 'RATE_LIMITED') {
                // Back off 1 minute and retry once
                await sleep(60000);
                try {
                    var listings2 = await fetchListingsForRelease(item.discogs_id, authHeaderFn);
                    db.saveDiscogsListings(item.id, listings2);
                } catch (e2) { errors++; }
            } else {
                errors++;
            }
        }
        done++;
        if (onProgress) onProgress(done, total, item);
        // Respect Discogs rate limit: 60 req/min = 1 req/sec
        await sleep(1100);
    }
    return { done, total, errors };
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

module.exports = { fetchListingsForRelease, syncMarketplace, countryToISO, toUSD };
