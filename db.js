/**
 * SQLite database layer for Vinyl Checker
 * Caches wantlist items, store results, and Discogs marketplace prices
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'vinyl-checker.db');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initTables();
    }
    return db;
}

function initTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            last_full_scan TEXT,
            last_sync TEXT
        );

        CREATE TABLE IF NOT EXISTS wantlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            discogs_id INTEGER,
            artist TEXT,
            title TEXT,
            year INTEGER,
            label TEXT,
            catno TEXT,
            thumb TEXT,
            genres TEXT DEFAULT '',
            styles TEXT DEFAULT '',
            search_query TEXT,
            date_added TEXT,
            active INTEGER DEFAULT 1,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, discogs_id)
        );

        CREATE TABLE IF NOT EXISTS store_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wantlist_id INTEGER NOT NULL,
            store TEXT NOT NULL,
            in_stock INTEGER DEFAULT 0,
            matches TEXT DEFAULT '[]',
            search_url TEXT,
            link_only INTEGER DEFAULT 0,
            us_shipping TEXT,
            error TEXT,
            checked_at TEXT,
            FOREIGN KEY (wantlist_id) REFERENCES wantlist(id),
            UNIQUE(wantlist_id, store)
        );

        CREATE TABLE IF NOT EXISTS discogs_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wantlist_id INTEGER NOT NULL,
            lowest_price REAL,
            currency TEXT DEFAULT 'USD',
            num_for_sale INTEGER DEFAULT 0,
            shipping TEXT,
            marketplace_url TEXT,
            checked_at TEXT,
            FOREIGN KEY (wantlist_id) REFERENCES wantlist(id),
            UNIQUE(wantlist_id)
        );

        CREATE INDEX IF NOT EXISTS idx_wantlist_user ON wantlist(user_id);
        CREATE INDEX IF NOT EXISTS idx_wantlist_active ON wantlist(user_id, active);
        CREATE INDEX IF NOT EXISTS idx_store_results_wantlist ON store_results(wantlist_id);
        CREATE INDEX IF NOT EXISTS idx_discogs_prices_wantlist ON discogs_prices(wantlist_id);
    `);
}

// ═══════════════════════════════════════════════════════════
// USER OPERATIONS
// ═══════════════════════════════════════════════════════════

function getOrCreateUser(username) {
    var d = getDb();
    var user = d.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        var info = d.prepare('INSERT INTO users (username) VALUES (?)').run(username);
        user = { id: info.lastInsertRowid, username: username };
    }
    return user;
}

function updateUserSyncTime(userId) {
    getDb().prepare('UPDATE users SET last_sync = ? WHERE id = ?').run(new Date().toISOString(), userId);
}

function updateUserFullScanTime(userId) {
    getDb().prepare('UPDATE users SET last_full_scan = ? WHERE id = ?').run(new Date().toISOString(), userId);
}

// ═══════════════════════════════════════════════════════════
// WANTLIST OPERATIONS
// ═══════════════════════════════════════════════════════════

function syncWantlistItems(userId, items) {
    var d = getDb();
    var existing = d.prepare('SELECT discogs_id FROM wantlist WHERE user_id = ? AND active = 1').all(userId);
    var existingIds = new Set(existing.map(function (e) { return e.discogs_id; }));
    var incomingIds = new Set(items.map(function (i) { return i.id; }));

    var newItems = [];
    var removedIds = [];

    // Find new items
    items.forEach(function (item) {
        if (!existingIds.has(item.id)) {
            newItems.push(item);
        }
    });

    // Find removed items
    existingIds.forEach(function (id) {
        if (!incomingIds.has(id)) {
            removedIds.push(id);
        }
    });

    // Upsert all items
    var upsert = d.prepare(`
        INSERT INTO wantlist (user_id, discogs_id, artist, title, year, label, catno, thumb, genres, styles, search_query, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(user_id, discogs_id) DO UPDATE SET
            artist = excluded.artist, title = excluded.title, year = excluded.year,
            label = excluded.label, catno = excluded.catno, thumb = excluded.thumb,
            genres = excluded.genres, styles = excluded.styles,
            search_query = excluded.search_query, active = 1
    `);

    var upsertMany = d.transaction(function (items) {
        items.forEach(function (item) {
            upsert.run(userId, item.id, item.artist, item.title, item.year, item.label, item.catno, item.thumb, item.genres || '', item.styles || '', item.searchQuery);
        });
    });
    upsertMany(items);

    // Deactivate removed items
    if (removedIds.length > 0) {
        var placeholders = removedIds.map(function () { return '?'; }).join(',');
        d.prepare('UPDATE wantlist SET active = 0 WHERE user_id = ? AND discogs_id IN (' + placeholders + ')')
            .run(userId, ...removedIds);
    }

    updateUserSyncTime(userId);

    return { newItems: newItems, removedCount: removedIds.length, totalActive: items.length };
}

function getActiveWantlist(userId) {
    return getDb().prepare('SELECT * FROM wantlist WHERE user_id = ? AND active = 1 ORDER BY id').all(userId);
}

function getWantlistItem(wantlistId) {
    return getDb().prepare('SELECT * FROM wantlist WHERE id = ?').get(wantlistId);
}

// ═══════════════════════════════════════════════════════════
// STORE RESULTS OPERATIONS
// ═══════════════════════════════════════════════════════════

function saveStoreResult(wantlistId, result) {
    var d = getDb();
    d.prepare(`
        INSERT INTO store_results (wantlist_id, store, in_stock, matches, search_url, link_only, us_shipping, error, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wantlist_id, store) DO UPDATE SET
            in_stock = excluded.in_stock, matches = excluded.matches,
            search_url = excluded.search_url, link_only = excluded.link_only,
            us_shipping = excluded.us_shipping,
            error = excluded.error, checked_at = excluded.checked_at
    `).run(
        wantlistId,
        result.store,
        result.inStock ? 1 : 0,
        JSON.stringify(result.matches || []),
        result.searchUrl || '',
        result.linkOnly ? 1 : 0,
        result.usShipping || null,
        result.error || null,
        new Date().toISOString()
    );
}

function saveStoreResults(wantlistId, results) {
    var d = getDb();
    var save = d.transaction(function (results) {
        results.forEach(function (r) { saveStoreResult(wantlistId, r); });
    });
    save(results);
}

function getStoreResults(wantlistId) {
    var rows = getDb().prepare('SELECT * FROM store_results WHERE wantlist_id = ?').all(wantlistId);
    return rows.map(function (r) {
        return {
            store: r.store,
            inStock: !!r.in_stock,
            matches: JSON.parse(r.matches || '[]'),
            searchUrl: r.search_url,
            linkOnly: !!r.link_only,
            usShipping: r.us_shipping || null,
            error: r.error,
            checkedAt: r.checked_at
        };
    });
}

function getItemsNeedingCheck(userId) {
    var d = getDb();

    // Only items that have NEVER been checked (no store_results at all)
    var items = d.prepare(`
        SELECT w.* FROM wantlist w
        WHERE w.user_id = ? AND w.active = 1
        AND NOT EXISTS (SELECT 1 FROM store_results sr WHERE sr.wantlist_id = w.id AND sr.link_only = 0)
        ORDER BY w.id
    `).all(userId);

    return items;
}

// ═══════════════════════════════════════════════════════════
// DISCOGS PRICES OPERATIONS
// ═══════════════════════════════════════════════════════════

function saveDiscogsPrice(wantlistId, priceData) {
    getDb().prepare(`
        INSERT INTO discogs_prices (wantlist_id, lowest_price, currency, num_for_sale, shipping, marketplace_url, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wantlist_id) DO UPDATE SET
            lowest_price = excluded.lowest_price, currency = excluded.currency,
            num_for_sale = excluded.num_for_sale, shipping = excluded.shipping,
            marketplace_url = excluded.marketplace_url,
            checked_at = excluded.checked_at
    `).run(
        wantlistId,
        priceData.lowestPrice || null,
        priceData.currency || 'USD',
        priceData.numForSale || 0,
        priceData.shipping || null,
        priceData.marketplaceUrl || '',
        new Date().toISOString()
    );
}

function getDiscogsPrice(wantlistId) {
    return getDb().prepare('SELECT * FROM discogs_prices WHERE wantlist_id = ?').get(wantlistId);
}

function getPricesNeedingCheck(userId) {
    return getDb().prepare(`
        SELECT w.* FROM wantlist w
        WHERE w.user_id = ? AND w.active = 1
        AND NOT EXISTS (SELECT 1 FROM discogs_prices dp WHERE dp.wantlist_id = w.id)
        ORDER BY w.id
    `).all(userId);
}

// ═══════════════════════════════════════════════════════════
// FULL RESULTS (for API response)
// ═══════════════════════════════════════════════════════════

function getFullResults(userId) {
    var d = getDb();
    var items = getActiveWantlist(userId);

    return items.map(function (w) {
        var stores = getStoreResults(w.id);
        var price = getDiscogsPrice(w.id);

        return {
            item: {
                id: w.discogs_id,
                artist: w.artist,
                title: w.title,
                year: w.year,
                label: w.label,
                catno: w.catno,
                thumb: w.thumb,
                genres: w.genres || '',
                styles: w.styles || '',
                searchQuery: w.search_query
            },
            stores: stores,
            discogsPrice: price ? {
                lowestPrice: price.lowest_price,
                currency: price.currency,
                numForSale: price.num_for_sale,
                marketplaceUrl: price.marketplace_url,
                checkedAt: price.checked_at
            } : null,
            wantlistId: w.id
        };
    });
}

function close() {
    if (db) { db.close(); db = null; }
}

module.exports = {
    getDb: getDb,
    getOrCreateUser: getOrCreateUser,
    updateUserSyncTime: updateUserSyncTime,
    updateUserFullScanTime: updateUserFullScanTime,
    syncWantlistItems: syncWantlistItems,
    getActiveWantlist: getActiveWantlist,
    getWantlistItem: getWantlistItem,
    saveStoreResult: saveStoreResult,
    saveStoreResults: saveStoreResults,
    getStoreResults: getStoreResults,
    getItemsNeedingCheck: getItemsNeedingCheck,
    saveDiscogsPrice: saveDiscogsPrice,
    getDiscogsPrice: getDiscogsPrice,
    getPricesNeedingCheck: getPricesNeedingCheck,
    getFullResults: getFullResults,
    close: close
};
