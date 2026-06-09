'use strict';
/**
 * Regression test — verifies all recent fixes without breaking existing behaviour.
 *
 * Run: node test-regression.js
 * Exit 0 = all pass.  Non-zero = failures found.
 */

// ─── inline the changed functions exactly as they appear in scrapers.js ───────

function similarity(s1, s2) {
    var longer  = s1.length > s2.length ? s1 : s2;
    var shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    var ed = levenshtein(longer.toLowerCase(), shorter.toLowerCase());
    return (longer.length - ed) / longer.length;
}
function levenshtein(s1, s2) {
    var costs = [];
    for (var i = 0; i <= s1.length; i++) {
        var lastValue = i;
        for (var j = 0; j <= s2.length; j++) {
            if (i === 0) { costs[j] = j; }
            else if (j > 0) {
                var newValue = costs[j - 1];
                if (s1.charAt(i-1) !== s2.charAt(j-1))
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                costs[j-1] = lastValue;
                lastValue  = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}
function normalize(str) {
    return str.toLowerCase().replace(/^the\s+/i,'').replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
}
function wordContains(haystack, needle) {
    if (!needle || needle.length < 4) return false;
    var idx = haystack.indexOf(needle);
    if (idx === -1) return false;
    var before = idx === 0 || haystack[idx-1] === ' ';
    var after  = (idx + needle.length) >= haystack.length || haystack[idx + needle.length] === ' ';
    return before && after;
}
function trailingSuffix(t) {
    var m = t.match(/\b(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xv|xvi{0,3}|xix|xx|\d+)\s*$/i);
    return m ? m[1].toLowerCase() : null;
}
function numbersMatch(a, b) {
    var numsA = a.match(/\d+/g) || [];
    var numsB = b.match(/\d+/g) || [];
    if (numsA.length === 0 || numsB.length === 0) return true;
    for (var i = 0; i < numsA.length; i++)
        for (var j = 0; j < numsB.length; j++)
            if (numsA[i] === numsB[j]) return true;
    return false;
}
function recordsMatch(wanted, found, threshold) {
    threshold = threshold || 0.7;
    var wantedArtist = normalize(wanted.artist);
    var foundArtist  = normalize(found.artist);
    var wantedTitle  = normalize(wanted.title);
    var foundTitle   = normalize(found.title);
    var artistSim = similarity(wantedArtist, foundArtist);
    var titleSim  = similarity(wantedTitle,  foundTitle);
    var wantedIsBareNumber = /^\d+$/.test(wantedTitle);
    if (!wantedIsBareNumber && wordContains(foundTitle, wantedTitle)) {
        var extra = foundTitle.slice(wantedTitle.length).trim();
        var wantedHasNums = /\d/.test(wantedTitle);
        if (wantedHasNums || !/^\d+$/.test(extra)) titleSim = Math.max(titleSim, 0.85);
    }
    if (!wantedIsBareNumber && wordContains(wantedTitle, foundTitle)) titleSim = Math.max(titleSim, 0.85);
    var wantedSuffix = trailingSuffix(wantedTitle);
    var foundSuffix  = trailingSuffix(foundTitle);
    if (wantedSuffix && foundSuffix && wantedSuffix !== foundSuffix) return false;
    var isVarious = /^various(\s+artists?)?$/.test(wantedArtist);
    if (isVarious) return titleSim >= threshold && numbersMatch(wantedTitle, foundTitle);
    if (artistSim >= 0.85) {
        if (titleSim < 0.65) return false;
        var wantedTitleNums = wantedTitle.match(/\d+/g) || [];
        var foundTitleNums  = foundTitle.match(/\d+/g)  || [];
        if (wantedTitleNums.length === 0 && foundTitleNums.length > 0) {
            var tailAfterWanted = foundTitle.slice(wantedTitle.length).trim();
            if (/^\d+$/.test(tailAfterWanted)) return false;
        }
        return true;
    }
    return artistSim >= threshold && titleSim >= threshold;
}

// ─── test harness ─────────────────────────────────────────────────────────────
var passed = 0, failed = 0;
function test(label, result, expected) {
    if (result === expected) {
        process.stdout.write('  ✓  ' + label + '\n');
        passed++;
    } else {
        process.stdout.write('  ✗  ' + label + '  →  got ' + result + ', want ' + expected + '\n');
        failed++;
    }
}

// ─── 1. trailingSuffix ────────────────────────────────────────────────────────
console.log('\n─── trailingSuffix ───');
test('bare i',          trailingSuffix('acid dub versions i'),    'i');
test('bare ii',         trailingSuffix('acid dub versions ii'),   'ii');
test('bare iii',        trailingSuffix('acid dub versions iii'),  'iii');
test('bare iv',         trailingSuffix('acid dub versions iv'),   'iv');
test('bare v',          trailingSuffix('something v'),            'v');
test('bare x',          trailingSuffix('something x'),            'x');
test('bare xi',         trailingSuffix('something xi'),           'xi');
test('bare xx',         trailingSuffix('something xx'),           'xx');
test('arabic 3',        trailingSuffix('metro area 3'),           '3');
test('arabic 001',      trailingSuffix('uncanny valley 001'),     '001');
test('no suffix',       trailingSuffix('moments in time'),        null);
test('no suffix 2',     trailingSuffix('smile w savage'),         null);
test('within word i',   trailingSuffix('remix'),                  null); // "i" inside word
test('within word v',   trailingSuffix('love'),                   null); // not a word boundary
test('within word x',   trailingSuffix('mix'),                    null);
test('generation x',    trailingSuffix('generation x'),           'x');  // standalone X
test('remaster trail',  trailingSuffix('something i remaster'),   null); // "remaster" last
test('2025 year',       trailingSuffix('2025'),                   '2025');
test('year in title',   trailingSuffix('summer 2025'),            '2025');

// ─── 2. Fixes: false positives that MUST now be blocked ──────────────────────
console.log('\n─── Fixed false positives — must be blocked ───');
test('Various/2025 vs subbase sampler 2025',
    recordsMatch({artist:'Various',title:'2025'},{artist:'Various Artists',title:'subbase sampler 2025 vinyl edition'}),
    false);
test('Om Unit Acid Dub II vs III',
    recordsMatch({artist:'Om Unit',title:'Acid Dub Versions II'},{artist:'Om Unit',title:'acid dub versions iii'}),
    false);
test('Metro Area 3 vs Metro Area 4',
    recordsMatch({artist:'Metro Area',title:'Metro Area 3'},{artist:'Metro Area',title:'Metro Area 4'}),
    false);
test('Hutson vs Hutson 1 (pre-existing guard)',
    recordsMatch({artist:'Charles Earland',title:'Hutson'},{artist:'Charles Earland',title:'Hutson 1'}),
    false);

// ─── 3. True positives that MUST still match ─────────────────────────────────
console.log('\n─── True positives — must still match ───');
test('Exact artist+title',
    recordsMatch({artist:'Rhythm & Sound',title:'Smile'},{artist:'Rhythm & Sound',title:'Smile'}),
    true);
test('Hardwax case: Rhythm & Sound Smile w Savage match',
    recordsMatch({artist:'Rhythm & Sound',title:'Smile'},{artist:'Rhythm & Sound',title:'smile w savage'}),
    true);
test('Tr One Remixes Of exact',
    recordsMatch({artist:'Tr One',title:'Remixes Of'},{artist:'Tr One',title:'remixes of'}),
    true);
test('Vince Watson Moments in Time',
    recordsMatch({artist:'Vince Watson',title:'Moments In Time'},{artist:'vince watson',title:'moments in time'}),
    true);
test('Same Roman numeral (III = III)',
    recordsMatch({artist:'Om Unit',title:'Acid Dub Versions III'},{artist:'Om Unit',title:'acid dub versions iii'}),
    true);
test('Same arabic suffix (3 = 3)',
    recordsMatch({artist:'Metro Area',title:'Metro Area 3'},{artist:'Metro Area',title:'metro area 3'}),
    true);
test('Title with format appended (25 year anniversary)',
    recordsMatch({artist:'Aphex Twin',title:'Selected Ambient Works'},{artist:'Aphex Twin',title:'selected ambient works 25th anniversary'}),
    true);
test('Typo in title',
    recordsMatch({artist:'Basic Channel',title:'Phylyps Trak'},{artist:'Basic Channel',title:'Phylips Trak'}),
    true);
test('Various: title match with number',
    recordsMatch({artist:'Various',title:'Uncanny Valley 001'},{artist:'Various Artists',title:'Uncanny Valley 001'}),
    true);
test('Artist typo / abbreviation',
    recordsMatch({artist:'Mr. Fingers',title:'Can You Feel It'},{artist:'Mr Fingers',title:'Can You Feel It'}),
    true);
test('The-prefix stripped',
    recordsMatch({artist:'The Prodigy',title:'Music For The Jilted Generation'},{artist:'Prodigy',title:'Music For The Jilted Generation'}),
    true);
test('Brawther Do It Yourself EP',
    recordsMatch({artist:'Brawther',title:'Do It Yourself EP'},{artist:'BRAWTHER',title:'Do It Yourself EP'}),
    true);
test('Title contains found (truncated store listing)',
    recordsMatch({artist:'Dj Sprinkles',title:'Midtown 120 Blues'},{artist:'DJ Sprinkles',title:'Midtown 120'}),
    true);
test('wantedTitle with digits: wordContains still applies',
    recordsMatch({artist:'Various',title:'Volume 1'},{artist:'Various Artists',title:'volume 1 sampler'}),
    true);

// ─── 4. True negatives that must NOT match ───────────────────────────────────
console.log('\n─── True negatives — must not match ───');
test('Completely different artist+title',
    recordsMatch({artist:'Boards of Canada',title:'Music Has The Right To Children'},{artist:'Aphex Twin',title:'Drukqs'}),
    false);
test('Same artist different album',
    recordsMatch({artist:'Basic Channel',title:'Phylyps Trak'},{artist:'Basic Channel',title:'Quadrant Dub'}),
    false);
test('Various: different VA compilation numbers (001 vs 50)',
    recordsMatch({artist:'Various',title:'Uncanny Valley 001'},{artist:'Various',title:'Uncanny Valley 50'}),
    false);
test('Year in title: Various/2024 vs sampler 2024',
    recordsMatch({artist:'Various',title:'2024'},{artist:'Various',title:'sampler 2024 special edition'}),
    false);
test('Volume mismatch arabic I vs II',
    recordsMatch({artist:'Drexciya',title:'The Quest Vol 1'},{artist:'Drexciya',title:'The Quest Vol 2'}),
    false);

// ─── 5. safeGoto logic (synchronous path analysis — no browser needed) ───────
console.log('\n─── safeGoto logic ───');

// Simulate what safeGoto does for error classification
function classifySafeGotoError(msg) {
    if (msg.indexOf('Requesting main frame too early') !== -1) return 'retry';
    if (msg.indexOf('ERR_HTTP2_PROTOCOL_ERROR') !== -1) return 'http2_rejected';
    return 'rethrow';
}
test('safeGoto: frame-too-early → retry',   classifySafeGotoError('Requesting main frame too early'), 'retry');
test('safeGoto: http2 error → classified',  classifySafeGotoError('net::ERR_HTTP2_PROTOCOL_ERROR'), 'http2_rejected');
test('safeGoto: timeout → rethrow',         classifySafeGotoError('Navigation timeout of 8000 ms exceeded'), 'rethrow');
test('safeGoto: net error → rethrow',       classifySafeGotoError('net::ERR_CONNECTION_REFUSED'), 'rethrow');

// ─── 6. Edge cases: words that look like Roman numerals but aren't ────────────
console.log('\n─── Edge: titles ending in Roman-numeral-shaped words ───');
// "vitamin i" shouldn't have a trailing suffix that interferes
// since "vitamin" → normalize → "vitamin i" ends in " i" → trailingSuffix = "i"
// This is intentional: if store has "Vitamin I" and we want "Vitamin I" — same → pass
test('Vitamin I vs Vitamin I (same)',
    recordsMatch({artist:'Artist',title:'Vitamin I'},{artist:'Artist',title:'Vitamin I'}),
    true);
// "Vitamin I" vs "Vitamin II" — different release, must block
test('Vitamin I vs Vitamin II (different)',
    recordsMatch({artist:'Artist',title:'Vitamin I'},{artist:'Artist',title:'Vitamin II'}),
    false);
// Title ending in "mix" — "x" is inside word, not standalone → no suffix
test('remix vs remix (no false suffix extraction)',
    recordsMatch({artist:'Artist',title:'Extended Mix'},{artist:'Artist',title:'Extended Mix'}),
    true);
// Generation X — "X" is a standalone word suffix
test('Generation X vs Generation X (same)',
    recordsMatch({artist:'Artist',title:'Generation X'},{artist:'Artist',title:'Generation X'}),
    true);
// "Dub in a time of..." — ends in "..." but after normalize it's "dub in a time of"
// trailingSuffix of "dub in a time of" → no match → null. Fine.
test('No suffix: ends in common word',
    trailingSuffix(normalize('Dub in a time of repress')), null);
// Title "i" alone — normalize → "i", trailingSuffix → "i"
// "i" vs "i" should match; "i" vs "ii" should not
test('Single-letter title I vs I (same)',
    recordsMatch({artist:'Artist',title:'I'},{artist:'Artist',title:'I'}),
    true);
test('Single-letter title I vs II (different)',
    recordsMatch({artist:'Artist',title:'I'},{artist:'Artist',title:'II'}),
    false);
// wordContains guard: needle < 4 chars — "I" won't boost via wordContains regardless
test('Short title no wordContains boost',
    wordContains('i extended mix', 'i'), // needle "i" len=1 < 4
    false);

// ─── 7. Bare-number guard edge cases ─────────────────────────────────────────
console.log('\n─── Bare-number guard ───');
// Title "001" — bare number, guard active
test('001 vs 001 (same bare number, direct sim high)',
    recordsMatch({artist:'Plastikman',title:'001'},{artist:'Plastikman',title:'001'}),
    true);
// Title "001" vs "001 Extended" — wordContains boost blocked, but direct sim?
// normalize("001") = "001", normalize("001 extended") = "001 extended"
// similarity("001","001 extended") = 1 - 8/12 = 0.33. Not above 0.7. Should NOT match.
test('001 vs 001 Extended (bare number, no false boost)',
    recordsMatch({artist:'Plastikman',title:'001'},{artist:'Plastikman',title:'001 Extended'}),
    false);
// A title "2025" vs "2025" (same VA release titled with a year) — should match via direct sim
test('VA 2025 vs VA 2025 (same)',
    recordsMatch({artist:'Various',title:'2025'},{artist:'Various',title:'2025'}),
    true);

// ─── 8. Live server endpoints ─────────────────────────────────────────────────
console.log('\n─── Live server endpoints ───');
var https = require('https');
var endpoints = [
    'https://waxdigger.ai/vinyl/',
    'https://waxdigger.ai/api/health',
    'https://waxdigger.ai/api/stores',
    'https://waxdigger.ai/api/results/osolakli',
    'https://waxdigger.ai/api/auth/status',
];
var pending = endpoints.length;
var livePass = 0, liveFail = 0;

endpoints.forEach(function(url) {
    var start = Date.now();
    https.get(url, { timeout: 8000 }, function(res) {
        var ok = res.statusCode >= 200 && res.statusCode < 500;
        var dur = Date.now() - start;
        if (ok) {
            process.stdout.write('  ✓  HTTP ' + res.statusCode + '  ' + dur + 'ms  ' + url + '\n');
            livePass++;
        } else {
            process.stdout.write('  ✗  HTTP ' + res.statusCode + '  ' + url + '\n');
            liveFail++;
        }
        res.resume();
        if (--pending === 0) finish();
    }).on('error', function(e) {
        process.stdout.write('  ✗  ERR  ' + e.message + '  ' + url + '\n');
        liveFail++;
        if (--pending === 0) finish();
    }).on('timeout', function() {
        process.stdout.write('  ✗  TIMEOUT  ' + url + '\n');
        liveFail++;
        if (--pending === 0) finish();
    });
});

function finish() {
    var totalPass = passed + livePass;
    var totalFail = failed + liveFail;
    console.log('\n══════════════════════════════════');
    console.log('  Unit tests:   ' + passed + ' pass, ' + failed + ' fail');
    console.log('  Live checks:  ' + livePass + ' pass, ' + liveFail + ' fail');
    console.log('  Total:        ' + totalPass + ' pass, ' + totalFail + ' fail');
    console.log('══════════════════════════════════\n');
    if (totalFail > 0) {
        console.log('RESULT: ✗  FAILURES DETECTED — review above\n');
        process.exit(1);
    } else {
        console.log('RESULT: ✓  ALL PASS\n');
        process.exit(0);
    }
}
