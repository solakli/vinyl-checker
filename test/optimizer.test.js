/**
 * Tests for the cart optimizer and shipping engine.
 * Pure-function tests — no DB, no network. Run with `node test/optimizer.test.js`.
 */

const assert = require('assert');
const shipping = require('../lib/shipping-rates');
const { buildSourcePool, optimizeCart, runOptimizer } = require('../lib/optimizer');

var failures = 0;
var passed = 0;

function test(name, fn) {
    try { fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) {
        failures++;
        console.log('  ✗ ' + name);
        console.log('    ' + (e.message || e));
    }
}
function suite(name, fn) { console.log('\n' + name); fn(); }

// ─── shipping-rates ──────────────────────────────────────────────────────────
suite('shipping-rates.postcodeToCountry', function () {
    test('US ZIP code (5-digit)', function () {
        assert.strictEqual(shipping.postcodeToCountry('10001').countryCode, 'US');
        assert.strictEqual(shipping.postcodeToCountry('90210').countryCode, 'US');
        assert.strictEqual(shipping.postcodeToCountry('60601').countryCode, 'US');
    });

    test('US ZIP+4', function () {
        assert.strictEqual(shipping.postcodeToCountry('10001-1234').countryCode, 'US');
    });

    test('UK postcode', function () {
        assert.strictEqual(shipping.postcodeToCountry('SW1A 1AA').countryCode, 'GB');
        assert.strictEqual(shipping.postcodeToCountry('E1W3SS').countryCode, 'GB');
        assert.strictEqual(shipping.postcodeToCountry('M11AE').countryCode, 'GB');
    });

    test('Canadian postcode (A1A1A1)', function () {
        assert.strictEqual(shipping.postcodeToCountry('M5V3L9').countryCode, 'CA');
        assert.strictEqual(shipping.postcodeToCountry('K1A0A9').countryCode, 'CA');
    });

    test('Dutch postcode (1234AB)', function () {
        assert.strictEqual(shipping.postcodeToCountry('1017AB').countryCode, 'NL');
    });

    test('Japanese postcode (123-4567)', function () {
        assert.strictEqual(shipping.postcodeToCountry('150-0001').countryCode, 'JP');
    });

    test('empty input defaults to US with low confidence', function () {
        var r = shipping.postcodeToCountry('');
        assert.strictEqual(r.countryCode, 'US');
        assert.strictEqual(r.confidence, 'low');
    });
});

suite('shipping-rates.estimateShipping', function () {
    test('US to US is cheap domestic', function () {
        var cost = shipping.estimateShipping('US', 'US');
        assert.ok(cost < 8, 'US domestic should be under $8, got ' + cost);
    });

    test('Germany to US is more expensive than domestic', function () {
        var de_us = shipping.estimateShipping('DE', 'US');
        var de_de = shipping.estimateShipping('DE', 'DE');
        assert.ok(de_us > de_de, 'DE→US should cost more than DE→DE');
    });

    test('accepts full Discogs country name strings', function () {
        var cost = shipping.estimateShipping('United States', 'US');
        assert.strictEqual(cost, shipping.estimateShipping('US', 'US'));
    });

    test('accepts lowercase ISO-2 codes', function () {
        assert.strictEqual(
            shipping.estimateShipping('de', 'us'),
            shipping.estimateShipping('DE', 'US')
        );
    });

    test('unknown origin falls back gracefully (non-zero)', function () {
        var cost = shipping.estimateShipping('ZZ', 'US');
        assert.ok(cost > 0, 'Unknown origin should still return a positive shipping cost');
    });

    test('Japan to UK costs more than UK to UK', function () {
        assert.ok(
            shipping.estimateShipping('JP', 'GB') > shipping.estimateShipping('GB', 'GB')
        );
    });
});

suite('shipping-rates.normalizeCountry', function () {
    test('passes through valid ISO-2', function () {
        assert.strictEqual(shipping.normalizeCountry('US'), 'US');
        assert.strictEqual(shipping.normalizeCountry('GB'), 'GB');
    });

    test('maps full country names', function () {
        assert.strictEqual(shipping.normalizeCountry('United States'), 'US');
        assert.strictEqual(shipping.normalizeCountry('Germany'), 'DE');
        assert.strictEqual(shipping.normalizeCountry('Netherlands'), 'NL');
        assert.strictEqual(shipping.normalizeCountry('Japan'), 'JP');
    });

    test('returns null for unknown inputs', function () {
        assert.strictEqual(shipping.normalizeCountry('Wakanda'), null);
        assert.strictEqual(shipping.normalizeCountry(''), null);
    });
});

// ─── optimizer.optimizeCart ──────────────────────────────────────────────────
suite('optimizer.optimizeCart — basic correctness', function () {
    function makeItem(id, artist, title, catno) {
        return { id: id, artist: artist, title: title, catno: catno || '' };
    }
    function makeSource(id, name, country, shippingCost, itemListings) {
        return {
            sourceId: id, sourceName: name, sourceType: 'discogs',
            country: country, shippingCostUsd: shippingCost,
            sellerRating: 99, sellerNumRatings: 500,
            listings: itemListings
        };
    }

    test('picks the seller that covers the most items cheapest', function () {
        var items = [makeItem(1), makeItem(2), makeItem(3)];
        var sources = [
            makeSource('s1', 'Seller A', 'US', 5, [
                { itemId: 1, priceUsd: 20, condition: 'VG+', url: '#' },
                { itemId: 2, priceUsd: 18, condition: 'VG+', url: '#' },
                { itemId: 3, priceUsd: 22, condition: 'VG+', url: '#' }
            ]),
            makeSource('s2', 'Seller B', 'DE', 14, [
                { itemId: 1, priceUsd: 19, condition: 'VG+', url: '#' }
            ])
        ];
        var result = optimizeCart(sources, items);
        // Seller A covers all 3 for $60 + $5 = $65
        // Seller B only covers item 1 for $19 + $14 = $33, then Seller A needs $40 + $5 = $45 more = $78
        // So Seller A alone is cheapest
        assert.strictEqual(result.covered, 3);
        assert.strictEqual(result.cart.length, 1);
        assert.strictEqual(result.cart[0].source.sourceId, 's1');
    });

    test('uses two sellers when combined is cheaper than one', function () {
        var items = [makeItem(1), makeItem(2), makeItem(3), makeItem(4)];
        // Seller A has items 1+2 cheaply (US, cheap shipping)
        // Seller B has items 3+4 cheaply (US, cheap shipping)
        // Seller C has all 4 but expensive
        var sources = [
            makeSource('sA', 'Seller A', 'US', 5, [
                { itemId: 1, priceUsd: 15, condition: 'VG+', url: '#' },
                { itemId: 2, priceUsd: 15, condition: 'VG+', url: '#' },
                { itemId: 3, priceUsd: 40, condition: 'VG+', url: '#' },
                { itemId: 4, priceUsd: 40, condition: 'VG+', url: '#' }
            ]),
            makeSource('sB', 'Seller B', 'US', 5, [
                { itemId: 1, priceUsd: 40, condition: 'VG+', url: '#' },
                { itemId: 2, priceUsd: 40, condition: 'VG+', url: '#' },
                { itemId: 3, priceUsd: 15, condition: 'VG+', url: '#' },
                { itemId: 4, priceUsd: 15, condition: 'VG+', url: '#' }
            ])
        ];
        var result = optimizeCart(sources, items);
        assert.strictEqual(result.covered, 4);
        // Both sellers should be used (each covers 2 records cheaply)
        assert.strictEqual(result.cart.length, 2);
        assert.ok(result.grandTotalUsd < 100, 'Should be under $100, got ' + result.grandTotalUsd);
    });

    test('leaves items uncovered when no source has them', function () {
        var items = [makeItem(1), makeItem(2), makeItem(3)];
        var sources = [
            makeSource('s1', 'Seller', 'US', 5, [
                { itemId: 1, priceUsd: 20, condition: 'VG+', url: '#' }
            ])
        ];
        var result = optimizeCart(sources, items);
        assert.strictEqual(result.covered, 1);
        assert.strictEqual(result.uncoveredItems.length, 2);
    });

    test('empty wantlist returns empty cart', function () {
        var result = optimizeCart([], []);
        assert.strictEqual(result.covered, 0);
        assert.strictEqual(result.cart.length, 0);
        assert.strictEqual(result.grandTotalUsd, 0);
    });

    test('grand total = records + shipping', function () {
        var items = [makeItem(1)];
        var sources = [
            makeSource('s1', 'Seller', 'DE', 12, [
                { itemId: 1, priceUsd: 25, condition: 'VG+', url: '#' }
            ])
        ];
        var result = optimizeCart(sources, items);
        assert.strictEqual(result.grandTotalUsd, 37); // 25 + 12
        assert.strictEqual(result.grandShippingUsd, 12);
        assert.strictEqual(result.grandRecordsUsd, 25);
    });

    test('free shipping store is preferred when prices are equal', function () {
        var items = [makeItem(1), makeItem(2)];
        var sources = [
            makeSource('store', 'Store (free ship)', 'US', 0, [
                { itemId: 1, priceUsd: 22, condition: 'NM', url: '#' },
                { itemId: 2, priceUsd: 22, condition: 'NM', url: '#' }
            ]),
            makeSource('seller', 'Discogs Seller', 'US', 10, [
                { itemId: 1, priceUsd: 22, condition: 'VG+', url: '#' },
                { itemId: 2, priceUsd: 22, condition: 'VG+', url: '#' }
            ])
        ];
        var result = optimizeCart(sources, items);
        assert.strictEqual(result.cart[0].source.sourceId, 'store');
    });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + (passed + failures) + ' tests, ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);
