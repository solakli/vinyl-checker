/**
 * Tests for the Gramaphone (Shopify) parser layer.
 * Pure-function tests — no DB, no network. Run with `node test/gramaphone.test.js`.
 *
 * Exits with non-zero status if any assertion fails.
 */

const assert = require('assert');
const shopify = require('../lib/stores/shopify');
const gramaphone = require('../lib/stores/gramaphone');

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

// ─── splitArtistTitle ─────────────────────────────────────────────────────────
suite('shopify.splitArtistTitle', function () {
    test('splits a normal "Artist - Title"', function () {
        var r = shopify.splitArtistTitle('Boo Williams - The Recovery');
        assert.strictEqual(r.artist, 'Boo Williams');
        assert.strictEqual(r.title, 'The Recovery');
    });

    test('splits on the FIRST " - " when title contains another " - "', function () {
        // Real Gramaphone case: ex_libris label, third release in series
        var r = shopify.splitArtistTitle('ex_libris - ex_libris - 003');
        assert.strictEqual(r.artist, 'ex_libris');
        assert.strictEqual(r.title, 'ex_libris - 003');
    });

    test('returns empty artist when no " - " is present (e.g. merch)', function () {
        var r = shopify.splitArtistTitle('Slipmat Pack');
        assert.strictEqual(r.artist, '');
        assert.strictEqual(r.title, 'Slipmat Pack');
    });

    test('does NOT split on hyphen without spaces', function () {
        // "X-Press 2" should be treated as one artist token, not split
        var r = shopify.splitArtistTitle('X-Press 2 - Muzikizum');
        assert.strictEqual(r.artist, 'X-Press 2');
        assert.strictEqual(r.title, 'Muzikizum');
    });

    test('handles empty / null input safely', function () {
        assert.deepStrictEqual(shopify.splitArtistTitle(''), { artist: '', title: '' });
        assert.deepStrictEqual(shopify.splitArtistTitle(null), { artist: '', title: '' });
        assert.deepStrictEqual(shopify.splitArtistTitle(undefined), { artist: '', title: '' });
    });

    test('trims surrounding whitespace', function () {
        var r = shopify.splitArtistTitle('  Theo Parrish  -  Sound Sculptures Vol. 1  ');
        assert.strictEqual(r.artist, 'Theo Parrish');
        assert.strictEqual(r.title, 'Sound Sculptures Vol. 1');
    });
});

// ─── stripHtml ────────────────────────────────────────────────────────────────
suite('shopify.stripHtml', function () {
    test('strips common HTML tags and entities', function () {
        var html = '<p>Label: Rush Hour &ndash; RHM051.</p><iframe src="x"></iframe>';
        var text = shopify.stripHtml(html);
        assert.ok(text.indexOf('<') === -1, 'no remaining tags');
        assert.ok(text.indexOf('Label: Rush Hour') !== -1, 'preserves text content');
    });

    test('removes script/style blocks entirely', function () {
        var html = '<p>Keep</p><script>var x = 1;</script><style>.a{}</style>';
        var text = shopify.stripHtml(html);
        assert.ok(text.indexOf('var x') === -1);
        assert.ok(text.indexOf('.a{}') === -1);
        assert.ok(text.indexOf('Keep') !== -1);
    });

    test('handles null/empty', function () {
        assert.strictEqual(shopify.stripHtml(null), '');
        assert.strictEqual(shopify.stripHtml(''), '');
    });
});

// ─── Gramaphone label parser ─────────────────────────────────────────────────
suite('gramaphone.parseLabel', function () {
    test('extracts label + catno separated by em-dash', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Label: Rush Hour – RHM051. A1: Track One' });
        assert.strictEqual(r.label, 'Rush Hour');
        assert.strictEqual(r.catno, 'RHM051');
    });

    test('extracts label + catno separated by hyphen', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Label: Concealed Sounds - CONC009. Tracklist:' });
        assert.strictEqual(r.label, 'Concealed Sounds');
        assert.strictEqual(r.catno, 'CONC009');
    });

    test('extracts catno with embedded space', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Label: Tasteful Nudes – TNUDE 17. Side A.' });
        assert.strictEqual(r.label, 'Tasteful Nudes');
        assert.strictEqual(r.catno, 'TNUDE 17');
    });

    test('returns label only when no catno present', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Label: Sound Signature. Some other text.' });
        assert.strictEqual(r.label, 'Sound Signature');
        assert.strictEqual(r.catno, null);
    });

    test('returns nulls when no Label: prefix', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Released by Concealed Sounds, CONC-009' });
        assert.strictEqual(r.label, null);
        assert.strictEqual(r.catno, null);
    });

    test('handles empty / missing bodyText', function () {
        assert.deepStrictEqual(gramaphone.parseLabel({ bodyText: '' }), { label: null, catno: null });
        assert.deepStrictEqual(gramaphone.parseLabel({}), { label: null, catno: null });
    });

    test('strips trailing punctuation from label', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Label: Perlon, Various' });
        // Label ends at first newline or "." — comma is allowed in label name itself
        assert.ok(r.label !== null);
        assert.ok(!/[\s.,;:]$/.test(r.label), 'no trailing punctuation: ' + JSON.stringify(r.label));
    });

    // Real Gramaphone body_html — multi-field structured format that <br> collapses to spaces
    test('extracts label/catno from full multi-field description', function () {
        var bodyHtml = '<p>Tracklisting: A1 Animal A2 Out</p><p>Label: Rush Hour Store Jams \u2013 RH-StoreJams031<br>Format: Vinyl, 12"<br>Released: Mar 12, 2026<br>Style: House</p>';
        var r = gramaphone.parseLabel({ bodyText: shopify.stripHtml(bodyHtml) });
        assert.strictEqual(r.label, 'Rush Hour Store Jams');
        assert.strictEqual(r.catno, 'RH-StoreJams031');
    });

    test('does not leak "Format" / "Released" into catno', function () {
        var bodyText = 'Label: Heist \u2013 HEIST090 Format: 12" Released: 2024';
        var r = gramaphone.parseLabel({ bodyText: bodyText });
        assert.strictEqual(r.label, 'Heist');
        assert.strictEqual(r.catno, 'HEIST090');
    });

    test('does not leak "Genre" into label when no catno present', function () {
        var bodyText = 'Label: Bastard Jazz Recordings Genre: Balearic, Disco, House';
        var r = gramaphone.parseLabel({ bodyText: bodyText });
        assert.strictEqual(r.label, 'Bastard Jazz Recordings');
        assert.strictEqual(r.catno, null);
    });

    test('handles em-dash with no surrounding spaces', function () {
        // Real Gramaphone case: "Label: Pronto– PRONTO021"
        var r = gramaphone.parseLabel({ bodyText: 'Label: Pronto\u2013 PRONTO021 Format: 12"' });
        assert.strictEqual(r.label, 'Pronto');
        assert.strictEqual(r.catno, 'PRONTO021');
    });

    test('does NOT split label name "X-Press 2" on internal hyphen', function () {
        var r = gramaphone.parseLabel({ bodyText: 'Label: X-Press 2 - XPR123 Format: 12"' });
        assert.strictEqual(r.label, 'X-Press 2');
        assert.strictEqual(r.catno, 'XPR123');
    });
});

// ─── Gramaphone product filter ───────────────────────────────────────────────
suite('gramaphone.shouldInclude', function () {
    test('includes "Records & LPs"', function () {
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'Records & LPs' }), true);
    });

    test('includes empty product_type (treated as record)', function () {
        assert.strictEqual(gramaphone.shouldInclude({ product_type: '' }), true);
        assert.strictEqual(gramaphone.shouldInclude({}), true);
    });

    test('includes label-named buckets like "Sushitech Records"', function () {
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'Sushitech Records' }), true);
    });

    test('excludes T-Shirts, Slipmats, Books, etc.', function () {
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'T-Shirt' }), false);
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'Slipmat' }), false);
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'Books' }), false);
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'Vinyl Care + Cleaning' }), false);
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'Gift Card' }), false);
        assert.strictEqual(gramaphone.shouldInclude({ product_type: 'CD' }), false);
    });
});

// ─── Full-product end-to-end parsing ─────────────────────────────────────────
suite('shopify.parseShopifyProduct (Gramaphone)', function () {
    var sampleProduct = {
        id: 1234567890,
        title: 'Theo Parrish - Sound Sculptures Vol. 1',
        handle: 'theo-parrish-sound-sculptures-vol-1',
        body_html: '<p>Label: Sound Signature – SS052. A1: Track One</p>',
        vendor: 'Sound Signature',
        product_type: 'Records & LPs',
        tags: 'Detroit, Deep House, 12"',
        updated_at: '2026-04-01T12:00:00Z',
        variants: [{ price: '24.99', available: true }],
        images: [{ src: 'https://cdn.shopify.com/img.jpg' }]
    };

    test('produces a fully normalized inventory row', function () {
        var row = shopify.parseShopifyProduct(sampleProduct, {
            storeKey: 'gramaphone',
            baseUrl: 'https://gramaphonerecords.com',
            parseLabel: gramaphone.parseLabel
        });
        assert.strictEqual(row.store, 'gramaphone');
        assert.strictEqual(row.productId, '1234567890');
        assert.strictEqual(row.artist, 'Theo Parrish');
        assert.strictEqual(row.title, 'Sound Sculptures Vol. 1');
        assert.strictEqual(row.label, 'Sound Signature');
        assert.strictEqual(row.catno, 'SS052');
        assert.strictEqual(row.priceUsd, 24.99);
        assert.strictEqual(row.available, true);
        assert.strictEqual(row.url, 'https://gramaphonerecords.com/products/theo-parrish-sound-sculptures-vol-1');
        assert.strictEqual(row.imageUrl, 'https://cdn.shopify.com/img.jpg');
        assert.deepStrictEqual(row.tags, ['Detroit', 'Deep House', '12"']);
    });

    test('marks sold-out variants as unavailable', function () {
        var soldOut = Object.assign({}, sampleProduct, { variants: [{ price: '24.99', available: false }] });
        var row = shopify.parseShopifyProduct(soldOut, {
            storeKey: 'gramaphone',
            baseUrl: 'https://gramaphonerecords.com',
            parseLabel: gramaphone.parseLabel
        });
        assert.strictEqual(row.available, false);
    });

    test('handles missing label info gracefully', function () {
        var noLabel = Object.assign({}, sampleProduct, { body_html: '<p>Just a description, no label info.</p>' });
        var row = shopify.parseShopifyProduct(noLabel, {
            storeKey: 'gramaphone',
            baseUrl: 'https://gramaphonerecords.com',
            parseLabel: gramaphone.parseLabel
        });
        assert.strictEqual(row.label, null);
        assert.strictEqual(row.catno, null);
        // Still produces a valid row
        assert.strictEqual(row.artist, 'Theo Parrish');
    });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0 ? '✓' : '✗') + ' ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);
