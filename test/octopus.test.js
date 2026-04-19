/**
 * Tests for the Octopus Records (WooCommerce) parser layer + the generic
 * WooCommerce helpers it sits on top of. Pure-function tests — no DB, no
 * network. Run with `node test/octopus.test.js`.
 *
 * Exits with non-zero status if any assertion fails.
 */

const assert = require('assert');
const wc = require('../lib/stores/woocommerce');
const octopus = require('../lib/stores/octopus');

var failures = 0;
var passed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓ ' + name);
    } catch (e) {
        failures++;
        console.log('  ✗ ' + name);
        console.log('    ' + (e.message || e));
        if (e.stack) console.log(e.stack.split('\n').slice(1, 4).map(function (l) { return '    ' + l; }).join('\n'));
    }
}

function suite(name, fn) {
    console.log('\n' + name);
    fn();
}

// ─── woocommerce.decodeEntities ──────────────────────────────────────────────
suite('woocommerce.decodeEntities', function () {
    test('decodes named entities', function () {
        assert.strictEqual(wc.decodeEntities('Funk &amp; Soul'), 'Funk & Soul');
        assert.strictEqual(wc.decodeEntities('R&amp;B'), 'R&B');
        assert.strictEqual(wc.decodeEntities('&quot;hello&quot;'), '"hello"');
    });

    test('decodes numeric decimal entities (× and ″)', function () {
        assert.strictEqual(wc.decodeEntities('2&#215;12&#8243;'), '2×12″');
    });

    test('decodes numeric hex entities', function () {
        // &#x2014; is em-dash (—)
        assert.strictEqual(wc.decodeEntities('a&#x2014;b'), 'a—b');
    });

    test('preserves text without entities', function () {
        assert.strictEqual(wc.decodeEntities('Plain text'), 'Plain text');
    });

    test('handles empty / null / undefined input', function () {
        assert.strictEqual(wc.decodeEntities(''), '');
        assert.strictEqual(wc.decodeEntities(null), '');
        assert.strictEqual(wc.decodeEntities(undefined), '');
    });

    test('decodes apostrophe (smart quote) used in WordPress', function () {
        // &#8217; is right-single-quote (')
        assert.strictEqual(wc.decodeEntities('Eamon Harkin&#8217;s'), 'Eamon Harkin\u2019s');
    });
});

// ─── woocommerce.firstParagraphText ──────────────────────────────────────────
suite('woocommerce.firstParagraphText', function () {
    test('extracts the first <p> when multiple paragraphs exist', function () {
        var html = '<p>2026, 2&#215;12&#8243; LP, Mister Saturday Night Records.</p>\n<p>Rest of prose here.</p>';
        assert.strictEqual(
            wc.firstParagraphText(html),
            '2026, 2×12″ LP, Mister Saturday Night Records.'
        );
    });

    test('handles a single-paragraph description', function () {
        var html = '<p>2025, 12&#8243; EP, Phantasy Sound</p>';
        assert.strictEqual(wc.firstParagraphText(html), '2025, 12″ EP, Phantasy Sound');
    });

    test('falls back to full stripped text when no <p> exists', function () {
        assert.strictEqual(wc.firstParagraphText('Just plain text'), 'Just plain text');
    });

    test('returns empty string for empty input', function () {
        assert.strictEqual(wc.firstParagraphText(''), '');
        assert.strictEqual(wc.firstParagraphText(null), '');
    });
});

// ─── woocommerce.parsePrice ──────────────────────────────────────────────────
suite('woocommerce.parsePrice', function () {
    test('converts minor-unit cents to dollars', function () {
        assert.strictEqual(
            wc.parsePrice({ prices: { price: '1850', currency_minor_unit: 2 } }),
            18.50
        );
    });

    test('handles 3-decimal currencies (e.g. JOD/KWD)', function () {
        assert.strictEqual(
            wc.parsePrice({ prices: { price: '12345', currency_minor_unit: 3 } }),
            12.345
        );
    });

    test('returns null when price is missing or zero', function () {
        assert.strictEqual(wc.parsePrice({ prices: {} }), null);
        assert.strictEqual(wc.parsePrice({ prices: { price: '0' } }), null);
        assert.strictEqual(wc.parsePrice({}), null);
    });

    test('defaults to 2 minor units when currency_minor_unit is absent', function () {
        assert.strictEqual(
            wc.parsePrice({ prices: { price: '999' } }),
            9.99
        );
    });
});

// ─── octopus.parseLabel (description-prose label extraction) ─────────────────
suite('octopus.parseLabel', function () {
    test('parses standard "YEAR, FORMAT, LABEL." pattern', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2026, 2×12″ LP, Mister Saturday Night Records.'
        });
        assert.strictEqual(result.label, 'Mister Saturday Night Records');
        assert.strictEqual(result.catno, null);
    });

    test('parses "YEAR reissue, FORMAT, LABEL." pattern', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2026 reissue, 2×12″ LP, Nonesuch.'
        });
        assert.strictEqual(result.label, 'Nonesuch');
    });

    test('parses unpunctuated trailing label (no terminal period)', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2025, 12″ EP, Phantasy Sound'
        });
        assert.strictEqual(result.label, 'Phantasy Sound');
    });

    test('stops at period when extra prose follows the label', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2025, 12″ compilation EP, Brooklyn Sway. NYC house/techno label.'
        });
        assert.strictEqual(result.label, 'Brooklyn Sway');
    });

    test('preserves slash-separated multi-label catalogs', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2020 reissue, 12″ LP, Mutant/Masterworks/Proximity Media.'
        });
        assert.strictEqual(result.label, 'Mutant/Masterworks/Proximity Media');
    });

    test('handles "12″ compilation EP" as the format chunk', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2026, 12″ compilation EP, Sole Aspect.'
        });
        assert.strictEqual(result.label, 'Sole Aspect');
    });

    test('returns null label when the text does not match the pattern', function () {
        var result = octopus.parseLabel({
            firstParagraphText: 'Some unrelated description without the standard format.'
        });
        assert.strictEqual(result.label, null);
        assert.strictEqual(result.catno, null);
    });

    test('returns null when first paragraph is empty', function () {
        var result = octopus.parseLabel({ firstParagraphText: '' });
        assert.strictEqual(result.label, null);
    });

    test('always returns null for catno (parseWcProduct uses sku as fallback)', function () {
        var result = octopus.parseLabel({
            firstParagraphText: '2026, 12″ LP, Some Label.'
        });
        // We deliberately don't try to parse a catno from prose — sku is more reliable.
        assert.strictEqual(result.catno, null);
    });
});

// ─── octopus.parseYear ───────────────────────────────────────────────────────
suite('octopus.parseYear', function () {
    test('extracts the leading year', function () {
        assert.strictEqual(octopus.parseYear('2026, 12″ LP, Some Label.'), 2026);
    });

    test('extracts the year before "reissue"', function () {
        assert.strictEqual(octopus.parseYear('2020 reissue, 12″ LP, Nettwerk.'), 2020);
    });

    test('returns null for years outside the plausible range', function () {
        assert.strictEqual(octopus.parseYear('1800, 12″ LP, X.'), null);
        assert.strictEqual(octopus.parseYear('3500, 12″ LP, X.'), null);
    });

    test('returns null when no leading year exists', function () {
        assert.strictEqual(octopus.parseYear('No year here'), null);
        assert.strictEqual(octopus.parseYear(''), null);
    });
});

// ─── octopus.shouldInclude (filter) ──────────────────────────────────────────
suite('octopus.shouldInclude', function () {
    test('includes a normal simple-type vinyl product', function () {
        var p = { type: 'simple', sku: 'ABC123', categories: [{ name: 'Electronic' }] };
        assert.strictEqual(octopus.shouldInclude(p), true);
    });

    test('excludes products in the CD/8-track catch-all category', function () {
        var p = {
            type: 'simple',
            sku: 'XYZ',
            categories: [{ name: 'Other Media / CD / 8 Track' }]
        };
        assert.strictEqual(octopus.shouldInclude(p), false);
    });

    test('excludes products without a SKU', function () {
        var p = { type: 'simple', sku: '', categories: [] };
        assert.strictEqual(octopus.shouldInclude(p), false);
    });

    test('excludes non-simple product types defensively', function () {
        var p = { type: 'variable', sku: 'XYZ', categories: [] };
        assert.strictEqual(octopus.shouldInclude(p), false);
    });

    test('handles missing categories array', function () {
        var p = { type: 'simple', sku: 'OK1', categories: undefined };
        assert.strictEqual(octopus.shouldInclude(p), true);
    });
});

// ─── End-to-end: parseWcProduct with octopus context ─────────────────────────
suite('woocommerce.parseWcProduct (Octopus context)', function () {
    var realProduct = {
        id: 54954,
        name: 'The Place Where We Live',
        sku: 'MSNLP005',
        type: 'simple',
        is_in_stock: true,
        is_purchasable: true,
        permalink: 'https://www.octopusrecords.nyc/product/the-place-where-we-live/',
        slug: 'the-place-where-we-live',
        description: '<p>2026, 2&#215;12&#8243; LP, Mister Saturday Night Records.</p>\n<p>Mister Saturday Night co-founder Eamon Harkin&#8217;s debut album.</p>',
        prices: { price: '3500', currency_minor_unit: 2, currency_code: 'USD' },
        categories: [
            { name: 'Electronic' },
            { name: 'House/Techno/Electro' }
        ],
        images: [{ src: 'https://example.com/cover.jpg' }]
    };

    test('extracts the title verbatim from product.name (no artist split)', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.title, 'The Place Where We Live');
        assert.strictEqual(row.artist, '');
    });

    test('uses sku as catno', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.catno, 'MSNLP005');
    });

    test('extracts label from description first paragraph', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.label, 'Mister Saturday Night Records');
    });

    test('converts minor-unit price into a USD float', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.priceUsd, 35.00);
        assert.strictEqual(row.currency, 'USD');
    });

    test('marks available based on is_in_stock', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.available, true);

        var oos = Object.assign({}, realProduct, { is_in_stock: false });
        var oosRow = wc.parseWcProduct(oos, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(oosRow.available, false);
    });

    test('decodes HTML entities in product name', function () {
        var p = Object.assign({}, realProduct, {
            name: 'William Shakespeare&#8217;s Romeo + Juliet',
            sku: 'B0022529-01'
        });
        var row = wc.parseWcProduct(p, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.title, 'William Shakespeare\u2019s Romeo + Juliet');
    });

    test('uses permalink directly when provided', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.url, 'https://www.octopusrecords.nyc/product/the-place-where-we-live/');
    });

    test('falls back to constructed permalink when missing', function () {
        var p = Object.assign({}, realProduct);
        delete p.permalink;
        var row = wc.parseWcProduct(p, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.url, 'https://www.octopusrecords.nyc/product/the-place-where-we-live');
    });

    test('storeKey + productId round-trip cleanly', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: octopus.parseLabel
        });
        assert.strictEqual(row.store, 'octopus');
        assert.strictEqual(row.productId, '54954');
    });

    test('survives a parseLabel that throws', function () {
        var row = wc.parseWcProduct(realProduct, {
            storeKey: 'octopus',
            baseUrl: 'https://www.octopusrecords.nyc',
            parseLabel: function () { throw new Error('boom'); }
        });
        assert.strictEqual(row.label, null);
        // sku still flows through as catno fallback
        assert.strictEqual(row.catno, 'MSNLP005');
    });
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + (passed + failures) + ' tests, ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);
