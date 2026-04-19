/**
 * Tests for the Further Records (Shopify) parser layer.
 * Pure-function tests — no DB, no network. Run with `node test/further.test.js`.
 *
 * Exits with non-zero status if any assertion fails.
 */

const assert = require('assert');
const shopify = require('../lib/stores/shopify');
const further = require('../lib/stores/further');

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

// ─── parseStructuredFields helper ─────────────────────────────────────────────
suite('shopify.parseStructuredFields', function () {
    test('extracts a simple "Field: value" sequence', function () {
        var r = shopify.parseStructuredFields(
            'Artist: Foo Title: Bar Label: Baz Catalog: BAZ001 Format: 12"',
            ['Artist', 'Title', 'Label', 'Catalog', 'Format']
        );
        assert.strictEqual(r.Artist, 'Foo');
        assert.strictEqual(r.Title, 'Bar');
        assert.strictEqual(r.Label, 'Baz');
        assert.strictEqual(r.Catalog, 'BAZ001');
        assert.strictEqual(r.Format, '12"');
    });

    test('handles values containing spaces (multi-word labels)', function () {
        var r = shopify.parseStructuredFields(
            'Artist: Theo Parrish Title: Sound Sculptures Label: Sound Signature Catalog: SS052',
            ['Artist', 'Title', 'Label', 'Catalog']
        );
        assert.strictEqual(r.Artist, 'Theo Parrish');
        assert.strictEqual(r.Title, 'Sound Sculptures');
        assert.strictEqual(r.Label, 'Sound Signature');
        assert.strictEqual(r.Catalog, 'SS052');
    });

    test('omits fields that are not present in the text', function () {
        var r = shopify.parseStructuredFields(
            'Artist: Foo Title: Bar',
            ['Artist', 'Title', 'Label', 'Catalog']
        );
        assert.strictEqual(r.Artist, 'Foo');
        assert.strictEqual(r.Title, 'Bar');
        assert.ok(!('Label' in r), 'Label should be omitted');
        assert.ok(!('Catalog' in r), 'Catalog should be omitted');
    });

    test('handles values with commas (Styles: Disco, House)', function () {
        var r = shopify.parseStructuredFields(
            'Label: Foo Catalog: F001 Styles: Disco, House Tracklist: A1 thing',
            ['Label', 'Catalog', 'Styles', 'Tracklist']
        );
        assert.strictEqual(r.Styles, 'Disco, House');
    });

    test('strips trailing punctuation from values', function () {
        var r = shopify.parseStructuredFields(
            'Label: Sound Signature, Catalog: SS052',
            ['Label', 'Catalog']
        );
        // The trailing comma after "Sound Signature" should be stripped.
        assert.strictEqual(r.Label, 'Sound Signature');
        assert.strictEqual(r.Catalog, 'SS052');
    });

    test('handles empty / null input safely', function () {
        assert.deepStrictEqual(shopify.parseStructuredFields('', ['Label']), {});
        assert.deepStrictEqual(shopify.parseStructuredFields(null, ['Label']), {});
        assert.deepStrictEqual(shopify.parseStructuredFields('Label: X', []), {});
        assert.deepStrictEqual(shopify.parseStructuredFields('Label: X', null), {});
    });

    test('is case-insensitive when matching field names', function () {
        var r = shopify.parseStructuredFields(
            'label: Foo CATALOG: F001',
            ['Label', 'Catalog']
        );
        assert.strictEqual(r.Label, 'Foo');
        assert.strictEqual(r.Catalog, 'F001');
    });

    test('catalog values containing hyphens and spaces are preserved', function () {
        var r = shopify.parseStructuredFields(
            'Label: Heartbeat Records Catalog: C-HB-07 Format: Cassette',
            ['Label', 'Catalog', 'Format']
        );
        assert.strictEqual(r.Catalog, 'C-HB-07');
    });
});

// ─── Further label parser — structured mode ──────────────────────────────────
suite('further.parseLabel (structured body_html)', function () {
    // Real Further structured body (after stripHtml collapses <br> to spaces).
    var realBodyText =
        'Mc Fizzy/Killa P - We Deh (7") Artist: Mc Fizzy/Killa P Title: We Deh ' +
        'Label: Biasonic Catalog: BIASNC 001 Format: 7" Date: 2026 Styles: UK Garage ' +
        'Tracklist: A1 Get House B1 Man In Black (edit mix)';

    test('extracts Label and Catalog from structured body', function () {
        var r = further.parseLabel({ bodyText: realBodyText });
        assert.strictEqual(r.label, 'Biasonic');
        assert.strictEqual(r.catno, 'BIASNC 001');
    });

    test('handles labels equal to vendor (self-released artist on own label)', function () {
        var r = further.parseLabel({
            bodyText: 'Artist: Atjazz Title: Starbase 17 Label: Atjazz Catalog: ARC 1974V Format: LP'
        });
        assert.strictEqual(r.label, 'Atjazz');
        assert.strictEqual(r.catno, 'ARC 1974V');
    });

    test('handles labels with hyphens (multi-word with internal punctuation)', function () {
        var r = further.parseLabel({
            bodyText: 'Artist: X Title: Y Label: Sub-Sound Records Catalog: SUB-001 Format: 12"'
        });
        assert.strictEqual(r.label, 'Sub-Sound Records');
        assert.strictEqual(r.catno, 'SUB-001');
    });
});

// ─── Further label parser — free-form / curated mode ─────────────────────────
suite('further.parseLabel (free-form body_html)', function () {
    test('parses "Artist - Title (Format) Label - CATNO YEAR ..."', function () {
        // Real curated Further product
        var body = 'Hideo Shiraki - Plays Bossa Nova (LP) Jazz Room Records - JAZZR-025 2023 Jazz, Latin Bossa Nova A1 Tico Tico';
        var r = further.parseLabel({ bodyText: body });
        assert.strictEqual(r.label, 'Jazz Room Records');
        assert.strictEqual(r.catno, 'JAZZR-025');
    });

    test('handles cassette format', function () {
        var body = 'Various - Best Of Studio One (Cassette) Heartbeat Records - C-HB-07 1987 Reggae Roots Reggae A1 The Cables';
        var r = further.parseLabel({ bodyText: body });
        assert.strictEqual(r.label, 'Heartbeat Records');
        assert.strictEqual(r.catno, 'C-HB-07');
    });

    test('handles 2x12" format suffix', function () {
        var body = 'Forest Swords - Engravings (2x12") Tri Angle - TRIANGLE20 2016 Electronic, Rock Experimental';
        var r = further.parseLabel({ bodyText: body });
        assert.strictEqual(r.label, 'Tri Angle');
        assert.strictEqual(r.catno, 'TRIANGLE20');
    });

    test('handles catno with a space inside (JAZZR 026 not JAZZR-026)', function () {
        var body = 'Indigo Jam Unit - Colin Curtis Presents: indigo jam unit (12") Jazz Room Records - JAZZR 026 2023 Jazz, Latin';
        var r = further.parseLabel({ bodyText: body });
        assert.strictEqual(r.label, 'Jazz Room Records');
        assert.strictEqual(r.catno, 'JAZZR 026');
    });

    test('handles title containing a slash', function () {
        var body = 'Roy Ayers Ubiquity - Everybody Loves The Sunshine / Lonesome Cowboy (7") Dynamite Cuts - DYNAM7094 2021 Funk / Soul';
        var r = further.parseLabel({ bodyText: body });
        assert.strictEqual(r.label, 'Dynamite Cuts');
        assert.strictEqual(r.catno, 'DYNAM7094');
    });

    test('returns null label/catno when neither structured nor free-form pattern matches', function () {
        var r = further.parseLabel({ bodyText: 'Some random prose without structure or year.' });
        assert.strictEqual(r.label, null);
        assert.strictEqual(r.catno, null);
    });

    test('handles empty / missing bodyText safely', function () {
        assert.deepStrictEqual(further.parseLabel({ bodyText: '' }), { label: null, catno: null });
        assert.deepStrictEqual(further.parseLabel({}), { label: null, catno: null });
    });
});

// ─── Further parseArtistTitle override ───────────────────────────────────────
suite('further.parseArtistTitle', function () {
    test('returns structured Artist/Title when present', function () {
        var r = further.parseArtistTitle({
            bodyText: 'Artist: Mc Fizzy/Killa P Title: We Deh Label: Biasonic Catalog: BIASNC 001'
        });
        assert.strictEqual(r.artist, 'Mc Fizzy/Killa P');
        assert.strictEqual(r.title, 'We Deh');
    });

    test('returns null in free-form mode (caller falls back to splitArtistTitle)', function () {
        var r = further.parseArtistTitle({
            bodyText: 'Hideo Shiraki - Plays Bossa Nova (LP) Jazz Room Records - JAZZR-025 2023 Jazz'
        });
        assert.strictEqual(r, null);
    });

    test('returns null on empty input', function () {
        assert.strictEqual(further.parseArtistTitle({ bodyText: '' }), null);
        assert.strictEqual(further.parseArtistTitle({}), null);
    });
});

// ─── Further product filter ──────────────────────────────────────────────────
suite('further.shouldInclude', function () {
    test('includes vinyl format types', function () {
        ['12"', '7"', 'LP', '2xLP', '2x12"', '10"', 'Vinyl'].forEach(function (t) {
            assert.strictEqual(further.shouldInclude({ product_type: t }), true, t + ' should be included');
        });
    });

    test('includes cassette and CD (wantlist matching filters out wrong format)', function () {
        assert.strictEqual(further.shouldInclude({ product_type: 'Cassette' }), true);
        assert.strictEqual(further.shouldInclude({ product_type: 'CD' }), true);
    });

    test('includes box-set / multi-format combos', function () {
        assert.strictEqual(further.shouldInclude({ product_type: 'LP+CD+Box Set' }), true);
        assert.strictEqual(further.shouldInclude({ product_type: '8xLP' }), true);
    });

    test('excludes magazines', function () {
        assert.strictEqual(further.shouldInclude({ product_type: 'Magazine' }), false);
    });

    test('includes products with empty/missing product_type', function () {
        assert.strictEqual(further.shouldInclude({ product_type: '' }), true);
        assert.strictEqual(further.shouldInclude({}), true);
    });
});

// ─── Full-product end-to-end parsing ─────────────────────────────────────────
suite('shopify.parseShopifyProduct (Further)', function () {
    var structuredProduct = {
        id: 9876543210,
        title: 'Mc Fizzy/Killa P - We Deh (7")',
        handle: 'mc-fizzy-killa-p-we-deh',
        body_html:
            '<strong>Mc Fizzy/Killa P - We Deh (7")</strong><br><br>' +
            '<p>Artist: Mc Fizzy/Killa P<br>' +
            'Title: We Deh<br>' +
            'Label: Biasonic<br>' +
            'Catalog: BIASNC 001<br>' +
            'Format: 7"<br>' +
            'Date: 2026<br>' +
            'Styles: UK Garage</p>',
        vendor: 'Biasonic',
        product_type: '7"',
        tags: '7", Biasonic, Killa P, Mc Fizzy, pending_discogs_match',
        updated_at: '2026-04-01T12:00:00Z',
        variants: [{ price: '14.99', available: true }],
        images: [{ src: 'https://cdn.shopify.com/img.jpg' }]
    };

    test('produces a fully normalized inventory row from a structured product', function () {
        var row = shopify.parseShopifyProduct(structuredProduct, {
            storeKey: 'further',
            baseUrl: 'https://furtherrecords.com',
            parseLabel: further.parseLabel,
            parseArtistTitle: further.parseArtistTitle
        });
        assert.strictEqual(row.store, 'further');
        assert.strictEqual(row.productId, '9876543210');
        // parseArtistTitle should override with the structured Artist field.
        assert.strictEqual(row.artist, 'Mc Fizzy/Killa P');
        assert.strictEqual(row.title, 'We Deh');
        assert.strictEqual(row.label, 'Biasonic');
        assert.strictEqual(row.catno, 'BIASNC 001');
        assert.strictEqual(row.priceUsd, 14.99);
        assert.strictEqual(row.available, true);
        assert.strictEqual(row.url, 'https://furtherrecords.com/products/mc-fizzy-killa-p-we-deh');
        assert.strictEqual(row.imageUrl, 'https://cdn.shopify.com/img.jpg');
    });

    // Real Further free-form body_html shape (curated picks): <u>title</u> once,
    // then label/catno/year/genres on separate <br>-delimited lines, then tracklist.
    var freeFormProduct = {
        id: 1111111111,
        title: 'Hideo Shiraki - Plays Bossa Nova (LP)',
        handle: 'hideo-shiraki-plays-bossa-nova',
        body_html:
            '<u>Hideo Shiraki - Plays Bossa Nova (LP)</u><br><br>' +
            'Jazz Room Records - JAZZR-025<br><br>' +
            '2023<br><br>' +
            'Jazz, Latin<br>' +
            'Bossa Nova<br><br>' +
            'A1 Tico Tico (4:25)<br>A2 Besame Mucho (2:29)',
        vendor: 'Jazz Room Records',
        product_type: 'LP',
        tags: 'LP, Jazz, Latin',
        updated_at: '2026-04-01T12:00:00Z',
        variants: [{ price: '28.00', available: true }],
        images: [{ src: 'https://cdn.shopify.com/img2.jpg' }]
    };

    test('produces a normalized row from a free-form/curated product', function () {
        var row = shopify.parseShopifyProduct(freeFormProduct, {
            storeKey: 'further',
            baseUrl: 'https://furtherrecords.com',
            parseLabel: further.parseLabel,
            parseArtistTitle: further.parseArtistTitle
        });
        // No structured Artist/Title field, so default splitArtistTitle wins.
        assert.strictEqual(row.artist, 'Hideo Shiraki');
        assert.strictEqual(row.title, 'Plays Bossa Nova (LP)');
        assert.strictEqual(row.label, 'Jazz Room Records');
        assert.strictEqual(row.catno, 'JAZZR-025');
        assert.strictEqual(row.priceUsd, 28.00);
    });

    test('marks sold-out variants as unavailable', function () {
        var soldOut = Object.assign({}, structuredProduct, {
            variants: [{ price: '14.99', available: false }]
        });
        var row = shopify.parseShopifyProduct(soldOut, {
            storeKey: 'further',
            baseUrl: 'https://furtherrecords.com',
            parseLabel: further.parseLabel,
            parseArtistTitle: further.parseArtistTitle
        });
        assert.strictEqual(row.available, false);
    });

    test('handles missing label info gracefully', function () {
        var noLabel = Object.assign({}, structuredProduct, {
            body_html: '<p>Just a description, no label info.</p>'
        });
        var row = shopify.parseShopifyProduct(noLabel, {
            storeKey: 'further',
            baseUrl: 'https://furtherrecords.com',
            parseLabel: further.parseLabel,
            parseArtistTitle: further.parseArtistTitle
        });
        assert.strictEqual(row.label, null);
        assert.strictEqual(row.catno, null);
        // Falls back to splitting the combined Shopify title since no structured Artist.
        assert.strictEqual(row.artist, 'Mc Fizzy/Killa P');
        assert.strictEqual(row.title, 'We Deh (7")');
    });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0 ? '✓' : '✗') + ' ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);
