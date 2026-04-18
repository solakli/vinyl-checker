#!/usr/bin/env node
/**
 * CLI: sync a store's full catalog into the local store_inventory table.
 *
 * Usage:
 *     node sync-store.js gramaphone
 *     node sync-store.js further
 *
 * Designed to be safe to run from cron / pm2 / systemd:
 *   - Exits 0 on success, 1 on failure
 *   - Writes a row to store_sync_log on every run (success or failure)
 *   - Marks unseen items as unavailable so out-of-stock detection still works
 */

const STORES = {
    gramaphone: function () { return require('./lib/stores/gramaphone'); },
    further: function () { return require('./lib/stores/further'); }
};

async function main() {
    var storeKey = process.argv[2];
    if (!storeKey) {
        console.error('Usage: node sync-store.js <store>');
        console.error('Available stores: ' + Object.keys(STORES).join(', '));
        process.exit(2);
    }

    var loader = STORES[storeKey];
    if (!loader) {
        console.error('Unknown store: ' + storeKey);
        console.error('Available stores: ' + Object.keys(STORES).join(', '));
        process.exit(2);
    }

    var store = loader();
    var syncFn = store['sync' + storeKey.charAt(0).toUpperCase() + storeKey.slice(1)];
    if (typeof syncFn !== 'function') {
        console.error('Store module ' + storeKey + ' does not export a sync function');
        process.exit(2);
    }

    console.log('[sync-store] Starting ' + storeKey + ' sync at ' + new Date().toISOString());
    var startedAt = Date.now();

    try {
        var stats = await syncFn({
            onProgress: function (p) {
                if (p.phase === 'fetch') {
                    if (p.offsetCap) {
                        console.log('[sync-store]   ⚠ Shopify 25,000-product offset cap reached — stopping cleanly');
                    } else {
                        console.log('[sync-store]   fetched page ' + p.page + ' (' + p.count + ' products, ' + p.total + ' total)');
                    }
                } else if (p.phase === 'upsert') {
                    console.log('[sync-store]   upserting ' + p.count + ' rows...');
                }
            }
        });
        console.log('[sync-store] ✓ ' + storeKey + ' sync complete in ' + Math.round((Date.now() - startedAt) / 1000) + 's');
        console.log('[sync-store]   seen=' + stats.seen + ', added=' + stats.added + ', updated=' + stats.updated + ', markedUnavailable=' + stats.markedUnavailable);
        process.exit(0);
    } catch (e) {
        console.error('[sync-store] ✗ ' + storeKey + ' sync failed: ' + e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
}

main();
