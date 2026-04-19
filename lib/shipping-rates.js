/**
 * Shipping cost estimates between country pairs.
 *
 * These are approximate per-order costs based on real 2025/2026 postal rates
 * for a single standard LP (180g vinyl in a cardboard mailer, ~500g total).
 * Sellers on Discogs typically charge flat rates per order (not per record),
 * so buying 5 records from one seller costs the same shipping as buying 1.
 *
 * Rates here are "typical" for indie/private sellers, not large commercial
 * retailers. They're used ONLY for optimizer ranking — the final price the
 * user sees when they click through to the actual Discogs listing may differ.
 *
 * Postcode → country resolution uses the prefix patterns that uniquely
 * identify a country's postal system. For the optimizer UI we just need
 * a country code, but we accept postcodes to be user-friendly.
 */

// Shipping cost in USD from [origin country] to [destination country].
// Format: RATES[origin][destination] = USD
// 'XX' = rest of world fallback
const RATES = {
    'US': { 'US': 5.00, 'GB': 18.00, 'DE': 18.00, 'FR': 18.00, 'NL': 18.00,
             'BE': 18.00, 'AT': 18.00, 'IT': 18.00, 'ES': 18.00, 'SE': 18.00,
             'DK': 18.00, 'NO': 18.00, 'FI': 18.00, 'CH': 18.00, 'PL': 18.00,
             'CZ': 18.00, 'HU': 18.00, 'PT': 18.00, 'GR': 18.00,
             'JP': 22.00, 'AU': 22.00, 'CA': 12.00, 'MX': 14.00, 'NZ': 22.00,
             'BR': 22.00, 'ZA': 22.00, 'XX': 22.00 },
    'GB': { 'GB': 4.00, 'US': 14.00, 'DE': 10.00, 'FR': 10.00, 'NL': 10.00,
             'BE': 10.00, 'AT': 10.00, 'IT': 10.00, 'ES': 10.00, 'SE': 10.00,
             'DK': 10.00, 'NO': 12.00, 'FI': 12.00, 'CH': 11.00, 'PL': 11.00,
             'JP': 16.00, 'AU': 16.00, 'CA': 14.00, 'XX': 16.00 },
    'DE': { 'DE': 4.00, 'US': 14.00, 'GB': 10.00, 'FR': 8.00, 'NL': 7.00,
             'BE': 7.00, 'AT': 7.00, 'IT': 9.00, 'ES': 9.00, 'SE': 9.00,
             'DK': 8.00, 'NO': 10.00, 'FI': 10.00, 'CH': 8.00, 'PL': 8.00,
             'CZ': 8.00, 'PT': 10.00, 'JP': 16.00, 'AU': 16.00, 'CA': 14.00,
             'XX': 16.00 },
    'FR': { 'FR': 5.00, 'US': 14.00, 'GB': 10.00, 'DE': 8.00, 'NL': 8.00,
             'BE': 7.00, 'AT': 9.00, 'IT': 9.00, 'ES': 9.00, 'SE': 10.00,
             'CH': 9.00, 'JP': 16.00, 'AU': 16.00, 'CA': 14.00, 'XX': 16.00 },
    'NL': { 'NL': 4.00, 'US': 14.00, 'GB': 10.00, 'DE': 7.00, 'FR': 8.00,
             'BE': 6.00, 'AT': 8.00, 'IT': 9.00, 'ES': 9.00, 'SE': 9.00,
             'CH': 9.00, 'XX': 15.00 },
    'JP': { 'JP': 5.00, 'US': 18.00, 'GB': 18.00, 'DE': 18.00, 'FR': 18.00,
             'NL': 18.00, 'AU': 14.00, 'CA': 18.00, 'XX': 20.00 },
    'AU': { 'AU': 6.00, 'US': 18.00, 'GB': 18.00, 'DE': 18.00, 'NZ': 10.00,
             'XX': 20.00 },
    'CA': { 'CA': 6.00, 'US': 10.00, 'GB': 14.00, 'DE': 14.00, 'XX': 16.00 },
    'IT': { 'IT': 5.00, 'US': 14.00, 'GB': 10.00, 'DE': 8.00, 'FR': 8.00, 'XX': 15.00 },
    'ES': { 'ES': 5.00, 'US': 14.00, 'GB': 11.00, 'DE': 9.00, 'FR': 8.00, 'XX': 15.00 },
    'SE': { 'SE': 4.00, 'US': 14.00, 'GB': 10.00, 'DE': 9.00, 'NO': 8.00, 'DK': 7.00, 'XX': 15.00 },
    'BE': { 'BE': 4.00, 'US': 14.00, 'GB': 10.00, 'DE': 7.00, 'NL': 6.00, 'FR': 7.00, 'XX': 15.00 },
    'AT': { 'AT': 4.00, 'US': 14.00, 'GB': 10.00, 'DE': 7.00, 'XX': 14.00 },
    'CH': { 'CH': 5.00, 'US': 15.00, 'GB': 11.00, 'DE': 8.00, 'XX': 15.00 },
    'PL': { 'PL': 3.00, 'US': 14.00, 'GB': 10.00, 'DE': 8.00, 'XX': 14.00 }
};

// Discogs uses full country names in `ships_from`. Map to ISO-2 codes.
const COUNTRY_NAME_TO_CODE = {
    'United States': 'US', 'USA': 'US', 'U.S.A.': 'US',
    'United Kingdom': 'GB', 'UK': 'GB', 'England': 'GB', 'Scotland': 'GB', 'Wales': 'GB',
    'Germany': 'DE', 'Deutschland': 'DE',
    'France': 'FR',
    'Netherlands': 'NL', 'The Netherlands': 'NL', 'Holland': 'NL',
    'Japan': 'JP',
    'Australia': 'AU',
    'Canada': 'CA',
    'Italy': 'IT',
    'Spain': 'ES',
    'Sweden': 'SE',
    'Belgium': 'BE',
    'Austria': 'AT',
    'Switzerland': 'CH',
    'Poland': 'PL',
    'Denmark': 'DK',
    'Norway': 'NO',
    'Finland': 'FI',
    'Portugal': 'PT',
    'Greece': 'GR',
    'Czech Republic': 'CZ', 'Czechia': 'CZ',
    'Hungary': 'HU',
    'New Zealand': 'NZ',
    'Brazil': 'BR',
    'Mexico': 'MX',
    'South Africa': 'ZA'
};

/**
 * Get estimated shipping cost in USD from origin to destination.
 *
 * @param {string} originCountry  - ISO-2 code OR Discogs country name string
 * @param {string} destCountry    - ISO-2 code
 * @returns {number} estimated USD shipping cost
 */
function estimateShipping(originCountry, destCountry) {
    var origin = normalizeCountry(originCountry);
    var dest = normalizeCountry(destCountry) || 'US';

    var originRates = RATES[origin];
    if (!originRates) {
        // Unknown origin — use a conservative flat rate
        return dest === origin ? 5.00 : 16.00;
    }

    return originRates[dest] || originRates['XX'] || 18.00;
}

function normalizeCountry(input) {
    if (!input) return null;
    var s = String(input).trim();
    // Already a 2-letter code
    if (/^[A-Z]{2}$/.test(s)) return s;
    if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
    // Full name lookup
    return COUNTRY_NAME_TO_CODE[s] || null;
}

/**
 * Resolve a postcode to a country code.
 * Supports US ZIP codes, UK postcodes, and a small set of other formats.
 * Falls back gracefully for formats we don't recognise.
 *
 * @param {string} postcode
 * @returns {{ countryCode: string, confidence: 'high'|'low' }}
 */
function postcodeToCountry(postcode) {
    if (!postcode) return { countryCode: 'US', confidence: 'low' };
    var p = String(postcode).trim().toUpperCase().replace(/\s+/g, '');

    // US ZIP: 5 digits or 5+4
    if (/^\d{5}(-\d{4})?$/.test(p)) return { countryCode: 'US', confidence: 'high' };

    // UK: letter(s) + digit(s) + space + digit + 2 letters (AN NAA, ANN NAA, AAN NAA, AANN NAA)
    if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(p)) return { countryCode: 'GB', confidence: 'high' };

    // Canadian: A1A1A1
    if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(p)) return { countryCode: 'CA', confidence: 'high' };

    // Australian: 4 digits starting with 2-9
    if (/^[2-9]\d{3}$/.test(p)) return { countryCode: 'AU', confidence: 'high' };

    // German: 5 digits starting with 0-9
    if (/^\d{5}$/.test(p)) return { countryCode: 'DE', confidence: 'low' }; // could also be FR/ES/IT

    // Netherlands: 4 digits + 2 letters
    if (/^\d{4}[A-Z]{2}$/.test(p)) return { countryCode: 'NL', confidence: 'high' };

    // Swedish: 5 digits
    if (/^\d{5}$/.test(p)) return { countryCode: 'SE', confidence: 'low' };

    // Japanese: 7 digits (NNN-NNNN)
    if (/^\d{3}-?\d{4}$/.test(p)) return { countryCode: 'JP', confidence: 'high' };

    return { countryCode: 'US', confidence: 'low' };
}

/**
 * Given a Discogs `ships_from` country name, return the ISO-2 code.
 */
function shipsFromToCode(shipsFrom) {
    return normalizeCountry(shipsFrom) || 'XX';
}

/**
 * Return a human-readable shipping estimate string.
 * e.g. "~$12" or "~$5 (domestic)"
 */
function shippingLabel(originCountry, destCountry) {
    var origin = normalizeCountry(originCountry) || 'XX';
    var dest = normalizeCountry(destCountry) || 'US';
    var cost = estimateShipping(origin, dest);
    var domestic = origin === dest;
    return '~$' + cost.toFixed(2) + (domestic ? ' (domestic)' : '');
}

module.exports = {
    estimateShipping: estimateShipping,
    postcodeToCountry: postcodeToCountry,
    normalizeCountry: normalizeCountry,
    shipsFromToCode: shipsFromToCode,
    shippingLabel: shippingLabel,
    RATES: RATES,
    COUNTRY_NAME_TO_CODE: COUNTRY_NAME_TO_CODE
};
