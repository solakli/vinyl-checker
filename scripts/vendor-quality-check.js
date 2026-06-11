'use strict';
/**
 * Vendor scraping quality check — run ON THE VPS (IP matters: Juno 451s us).
 *
 *   node scripts/vendor-quality-check.js
 *
 * Browser stores get a known-stocked query and must parse >0 products and
 * find the expected match. Catalog stores are tested against a real row
 * pulled from their own store_inventory, so the whole matching path runs.
 */

var db = require('../db');
var scrapers = require('../lib/scrapers');

var pass = 0, fail = 0, warn = 0;
function report(store, ok, detail, soft) {
    var mark = ok ? '✓' : (soft ? '~' : '✗');
    if (ok) pass++; else if (soft) warn++; else fail++;
    console.log('  ' + mark + '  ' + store.padEnd(22) + detail);
}

(async function () {
    var puppeteer = require('puppeteer');
    var browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    var page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    console.log('\n─── Browser stores (live scrape from this IP) ───');

    // Deejay.de — search a perennial: catalogue staple with many pressings
    try {
        var r = await scrapers.checkDeejay(page, { artist: 'Mr. Fingers', title: 'Can You Feel It', searchQuery: 'Mr Fingers Can You Feel It' });
        report('Deejay.de', !r.error, r.error ? ('ERROR: ' + r.error) : ('parsed OK — inStock: ' + r.inStock + ', matches: ' + (r.matches || []).length));
    } catch (e) { report('Deejay.de', false, 'THREW: ' + e.message); }

    // Hardwax — Basic Channel is their house label, always stocked
    try {
        var r2 = await scrapers.checkHardwax(page, { artist: 'Basic Channel', title: 'BCD', searchQuery: 'Basic Channel' });
        report('Hardwax', !r2.error, r2.error ? ('ERROR: ' + r2.error) : ('parsed OK — inStock: ' + r2.inStock + ', matches: ' + (r2.matches || []).length));
    } catch (e) { report('Hardwax', false, 'THREW: ' + e.message); }

    // Yoyaku — fixed parser; ADSR "Incidents" verified stocked at time of writing
    try {
        var r3 = await scrapers.checkYoyaku(page, { artist: 'ADSR', title: 'Incidents', searchQuery: 'ADSR Incidents' });
        report('Yoyaku', !r3.error && r3.inStock === true, r3.error ? ('ERROR: ' + r3.error) : ('inStock: ' + r3.inStock + ' ' + JSON.stringify((r3.matches || [])[0] || {})));
    } catch (e) { report('Yoyaku', false, 'THREW: ' + e.message); }

    // Juno — must be link-only now
    try {
        var r4 = scrapers.getJunoLink({ searchQuery: 'test' });
        report('Juno (link-only)', r4.linkOnly === true && r4.searchUrl.indexOf('juno.co.uk') !== -1, 'linkOnly: ' + r4.linkOnly);
    } catch (e) { report('Juno (link-only)', false, 'THREW: ' + e.message); }

    await browser.close();

    console.log('\n─── Catalog-mirror stores (SQLite inventory) ───');
    // store_inventory uses lowercase slugs, not display names
    var catalogStores = [
        { name: 'Further Records',     slug: 'further',    fn: scrapers.checkFurther },
        { name: 'Gramaphone',          slug: 'gramaphone', fn: scrapers.checkGramaphone },
        { name: 'Octopus Records NYC', slug: 'octopus',    fn: scrapers.checkOctopus },
        { name: 'Underground Vinyl',   slug: 'uvs',        fn: scrapers.checkUVS },
    ];
    var d = db.getDb();
    for (var i = 0; i < catalogStores.length; i++) {
        var cs = catalogStores[i];
        try {
            // Pull a real in-stock inventory row and check the matcher finds it
            var row = d.prepare(
                "SELECT artist, title, title_raw FROM store_inventory WHERE store = ? AND available = 1 AND artist IS NOT NULL AND artist != '' AND title IS NOT NULL AND title != '' LIMIT 1"
            ).get(cs.slug);
            if (!row) {
                // WooCommerce stores (Octopus) parse no artist field — their rows
                // match via combined title_raw instead. Test that path.
                row = d.prepare(
                    "SELECT artist, title, title_raw FROM store_inventory WHERE store = ? AND available = 1 AND title_raw IS NOT NULL AND length(title_raw) > 8 LIMIT 1"
                ).get(cs.slug);
                if (row) { row.artist = ''; row.title = row.title_raw; }
            }
            if (!row) {
                report(cs.name, false, 'no in-stock inventory rows — sync may be stale', true);
                continue;
            }
            var res = await cs.fn(null, { artist: row.artist, title: row.title, searchQuery: (row.artist + ' ' + row.title).trim() });
            report(cs.name, res.inStock === true, res.inStock
                ? ('self-match OK: "' + (row.artist ? row.artist + ' — ' : '') + row.title + '"')
                : ('FAILED to match own inventory row: "' + (row.artist ? row.artist + ' — ' : '') + row.title + '"'));
        } catch (e) { report(cs.name, false, 'THREW: ' + e.message); }
    }

    console.log('\n─── Inventory freshness ───');
    try {
        var rows = d.prepare(
            "SELECT store, COUNT(*) as n, SUM(available) as in_stock, MAX(last_synced_at) as last_seen FROM store_inventory GROUP BY store"
        ).all();
        rows.forEach(function (r) {
            var ageH = r.last_seen ? Math.round((Date.now() - new Date(r.last_seen).getTime()) / 3600000) : null;
            var fresh = ageH !== null && ageH < 48;
            report(r.store, fresh, r.n + ' rows, ' + r.in_stock + ' in stock, synced ' + (ageH === null ? 'never' : ageH + 'h ago'), !fresh);
        });
    } catch (e) { console.log('  (store_inventory query failed: ' + e.message + ')'); }

    console.log('\n══════════════════════════');
    console.log('  ' + pass + ' pass, ' + warn + ' warnings, ' + fail + ' fail');
    console.log('══════════════════════════\n');
    process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) { console.error('FATAL:', e.message); process.exit(1); });
