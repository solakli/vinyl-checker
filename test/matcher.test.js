/**
 * Tests for lib/scrapers.js matching primitives — specifically the catno-first
 * matchInventoryRow() helper used by all catalog-mirror stores (Gramaphone,
 * Further, Octopus). Pure-function tests — no DB, no network.
 *
 * Run with `node test/matcher.test.js`.
 * Exits with non-zero status if any assertion fails.
 */

const assert = require('assert');
const scrapers = require('../lib/scrapers');

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

// ─── normalizeCatno ──────────────────────────────────────────────────────────
suite('scrapers.normalizeCatno', function () {
    test('lowercases and strips non-alphanumerics', function () {
        assert.strictEqual(scrapers.normalizeCatno('MSN-LP-005'), 'msnlp005');
        assert.strictEqual(scrapers.normalizeCatno('MSN LP 005'), 'msnlp005');
        assert.strictEqual(scrapers.normalizeCatno('MSNLP005'), 'msnlp005');
        assert.strictEqual(scrapers.normalizeCatno('msn.lp.005'), 'msnlp005');
    });

    test('handles real-world catno formatting variants', function () {
        // Tresor uses dot separator; Discogs sometimes drops it
        assert.strictEqual(
            scrapers.normalizeCatno('TRESOR.130'),
            scrapers.normalizeCatno('TRESOR 130')
        );
        // SLP 1202 vs SLP1202
        assert.strictEqual(
            scrapers.normalizeCatno('SLP 1202'),
            scrapers.normalizeCatno('SLP1202')
        );
        // Ostgut uses no separator at all
        assert.strictEqual(scrapers.normalizeCatno('OSTGUTLP38'), 'ostgutlp38');
    });

    test('returns empty string for null / undefined / empty', function () {
        assert.strictEqual(scrapers.normalizeCatno(null), '');
        assert.strictEqual(scrapers.normalizeCatno(undefined), '');
        assert.strictEqual(scrapers.normalizeCatno(''), '');
    });

    test('coerces non-string inputs', function () {
        assert.strictEqual(scrapers.normalizeCatno(12345), '12345');
    });
});

// ─── catnosMatch ─────────────────────────────────────────────────────────────
suite('scrapers.catnosMatch', function () {
    test('matches identical catnos exactly', function () {
        assert.strictEqual(scrapers.catnosMatch('MSNLP005', 'MSNLP005'), true);
    });

    test('matches the same catno across formatting variants', function () {
        assert.strictEqual(scrapers.catnosMatch('MSN-LP-005', 'msnlp005'), true);
        assert.strictEqual(scrapers.catnosMatch('TRESOR.130', 'TRESOR 130'), true);
        assert.strictEqual(scrapers.catnosMatch('SLP 1202', 'SLP1202'), true);
        assert.strictEqual(scrapers.catnosMatch('Stroom-007', 'STROOM 007'), true);
    });

    test('does NOT match different catnos on the same label', function () {
        assert.strictEqual(scrapers.catnosMatch('MSNLP005', 'MSNLP006'), false);
        assert.strictEqual(scrapers.catnosMatch('IT075', 'IT076'), false);
        assert.strictEqual(scrapers.catnosMatch('RHR008', 'RHR080'), false);
    });

    test('does NOT match if either side is empty/null', function () {
        assert.strictEqual(scrapers.catnosMatch('MSNLP005', ''), false);
        assert.strictEqual(scrapers.catnosMatch('', 'MSNLP005'), false);
        assert.strictEqual(scrapers.catnosMatch(null, 'MSNLP005'), false);
        assert.strictEqual(scrapers.catnosMatch('MSNLP005', undefined), false);
    });

    test('rejects sub-3-character catnos as too generic', function () {
        // "EP", "LP", "1" — meaningless on their own and would collide across labels
        assert.strictEqual(scrapers.catnosMatch('EP', 'EP'), false);
        assert.strictEqual(scrapers.catnosMatch('LP', 'LP'), false);
        assert.strictEqual(scrapers.catnosMatch('1', '1'), false);
        assert.strictEqual(scrapers.catnosMatch('A1', 'A1'), false);
    });

    test('accepts 3-character catnos (the minimum valid length)', function () {
        assert.strictEqual(scrapers.catnosMatch('LP1', 'LP1'), true);
        assert.strictEqual(scrapers.catnosMatch('SS1', 'SS1'), true);
    });
});

// ─── matchInventoryRow ───────────────────────────────────────────────────────
suite('scrapers.matchInventoryRow (catno-first matcher)', function () {
    test('catno match alone is sufficient even when artist/title differ', function () {
        // The Discogs-canonical artist string and the store-stored artist
        // can disagree on punctuation, ampersands, "and" vs "&", trailing
        // "EP", etc. Catno is the tie-breaker.
        var wanted = {
            artist: 'Theo Parrish & Marcellus Pittman',
            title: 'Sound Sculptures Vol 1 EP',
            catno: 'SS052'
        };
        var row = {
            artist: 'Theo Parrish and M. Pittman',
            title: 'Sound Sculptures',
            title_raw: 'Theo Parrish and M. Pittman - Sound Sculptures',
            catno: 'SS-052'
        };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), true);
    });

    test('catno match works when row has no artist (Octopus shape)', function () {
        var wanted = { artist: 'Eamon Harkin', title: 'The Place Where We Live', catno: 'MSNLP005' };
        var row = { artist: '', title: 'The Place Where We Live', catno: 'MSNLP005' };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), true);
    });

    test('falls back to artist+title fuzzy when catno is missing on either side', function () {
        var wanted = { artist: 'Traumer', title: 'Nectar', catno: '' };
        var row = {
            artist: 'Traumer',
            title: 'Nectar',
            title_raw: 'Traumer - Nectar',
            catno: 'GETTRAUMER001'
        };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), true);
    });

    test('falls back to combined-title match when row has no structured artist', function () {
        // Octopus shape: artist='', title=just the release name
        // Catno is missing on the wanted side, so we fall through to combined match
        var wanted = { artist: 'Phantasy Sound', title: 'Wrekons', catno: '' };
        var row = {
            artist: '',
            title: 'Wrekons Phantasy Sound',
            title_raw: 'Wrekons Phantasy Sound',
            catno: 'PH148'
        };
        // Combined matching is permissive enough to find this
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), true);
    });

    test('does not match unrelated records that happen to share a generic title', function () {
        var wanted = { artist: 'Anonymous Artist', title: 'EP', catno: 'XX001' };
        var row = {
            artist: 'Different Artist',
            title: 'EP',
            title_raw: 'Different Artist - EP',
            catno: 'YY002'
        };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), false);
    });

    test('does not catno-match on truthy-but-different catnos', function () {
        var wanted = { artist: 'Foo', title: 'Bar', catno: 'IT075' };
        var row = {
            artist: 'Different',
            title: 'Different',
            title_raw: 'Different - Different',
            catno: 'IT076'
        };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), false);
    });

    test('handles missing/null catno on either side without throwing', function () {
        var wanted = { artist: 'Foo', title: 'Bar' };
        var row = { artist: 'Foo', title: 'Bar', title_raw: 'Foo - Bar' };
        // No catno anywhere — should still match via fuzzy artist+title
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), true);
    });

    test('catno of 1 char is rejected (too generic, treated as no catno)', function () {
        // Pick artist/title pairs that share NO substrings so the fuzzy
        // fallback can't accidentally rescue them — the only way these would
        // match is if catno=='1' were accepted as a positive signal.
        var wanted = { artist: 'Aphex Twin', title: 'Selected Ambient Works', catno: '1' };
        var row = {
            artist: 'Burial',
            title: 'Untrue',
            title_raw: 'Burial - Untrue',
            catno: '1'
        };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), false);
    });

    test('regression: artist+title-only match still works for Gramaphone/Further pre-catno-rollout rows', function () {
        // Inventory rows that pre-date this change might have catno=null but
        // a clean artist+title pair. Those should still match via the
        // existing recordsMatch() path.
        var wanted = { artist: 'Huerta', title: 'Junipero', catno: 'KSO11' };
        var row = {
            artist: 'Huerta',
            title: 'Junipero',
            title_raw: 'Huerta - Junipero',
            catno: null
        };
        assert.strictEqual(scrapers.matchInventoryRow(wanted, row), true);
    });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + (passed + failures) + ' tests, ' + passed + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);
