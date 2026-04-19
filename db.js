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

        CREATE TABLE IF NOT EXISTS release_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discogs_id INTEGER UNIQUE NOT NULL,
            data TEXT,
            fetched_at TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TEXT,
            last_seen TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS oauth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            access_token TEXT,
            access_secret TEXT,
            refresh_token TEXT,
            expires_at TEXT,
            provider_username TEXT,
            provider_id TEXT,
            created_at TEXT,
            updated_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, provider)
        );

        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wantlist_id INTEGER NOT NULL,
            lowest_price REAL,
            num_for_sale INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'USD',
            recorded_at TEXT,
            FOREIGN KEY (wantlist_id) REFERENCES wantlist(id)
        );

        CREATE TABLE IF NOT EXISTS store_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wantlist_id INTEGER NOT NULL,
            store TEXT NOT NULL,
            in_stock INTEGER DEFAULT 0,
            price REAL,
            currency TEXT,
            recorded_at TEXT,
            FOREIGN KEY (wantlist_id) REFERENCES wantlist(id)
        );

        CREATE INDEX IF NOT EXISTS idx_wantlist_user ON wantlist(user_id);
        CREATE INDEX IF NOT EXISTS idx_wantlist_active ON wantlist(user_id, active);
        CREATE INDEX IF NOT EXISTS idx_store_results_wantlist ON store_results(wantlist_id);
        CREATE INDEX IF NOT EXISTS idx_discogs_prices_wantlist ON discogs_prices(wantlist_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
        CREATE INDEX IF NOT EXISTS idx_price_history_wantlist ON price_history(wantlist_id);
        CREATE INDEX IF NOT EXISTS idx_store_history_wantlist ON store_history(wantlist_id);
        CREATE INDEX IF NOT EXISTS idx_store_history_lookup ON store_history(wantlist_id, store, recorded_at);

        CREATE TABLE IF NOT EXISTS scan_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            wantlist_id INTEGER NOT NULL,
            change_type TEXT NOT NULL,
            store TEXT,
            old_value TEXT,
            new_value TEXT,
            detected_at TEXT NOT NULL,
            dismissed INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (wantlist_id) REFERENCES wantlist(id)
        );

        CREATE INDEX IF NOT EXISTS idx_scan_changes_user ON scan_changes(user_id, dismissed);

        -- Cached inventory pulled from store catalogs (e.g. Shopify /products.json).
        -- Lets us match wantlist items locally instead of hitting each store per scan.
        CREATE TABLE IF NOT EXISTS store_inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store TEXT NOT NULL,
            product_id TEXT NOT NULL,
            title_raw TEXT,
            artist TEXT,
            title TEXT,
            label TEXT,
            catno TEXT,
            vendor TEXT,
            product_type TEXT,
            tags TEXT DEFAULT '[]',
            price_usd REAL,
            currency TEXT DEFAULT 'USD',
            available INTEGER DEFAULT 0,
            url TEXT,
            image_url TEXT,
            store_updated_at TEXT,
            last_synced_at TEXT,
            UNIQUE(store, product_id)
        );

        CREATE INDEX IF NOT EXISTS idx_store_inv_store_avail ON store_inventory(store, available);
        CREATE INDEX IF NOT EXISTS idx_store_inv_artist ON store_inventory(artist);
        CREATE INDEX IF NOT EXISTS idx_store_inv_label ON store_inventory(label);

        -- Audit trail of catalog sync runs per store
        CREATE TABLE IF NOT EXISTS store_sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            products_seen INTEGER DEFAULT 0,
            products_added INTEGER DEFAULT 0,
            products_updated INTEGER DEFAULT 0,
            products_marked_unavailable INTEGER DEFAULT 0,
            error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_store_sync_log_store ON store_sync_log(store, started_at);
    `);

    // Migrations — add columns if missing
    try { db.exec('ALTER TABLE users ADD COLUMN last_daily_rescan TEXT'); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════
// USER OPERATIONS
// ═══════════════════════════════════════════════════════════

function getOrCreateUser(username) {
    var d = getDb();
    // Case-insensitive lookup to prevent duplicate users (e.g. "OsolAkli" vs "osolakli")
    var user = d.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
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
        INSERT INTO wantlist (user_id, discogs_id, artist, title, year, label, catno, thumb, genres, styles, search_query, date_added, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(user_id, discogs_id) DO UPDATE SET
            artist = excluded.artist, title = excluded.title, year = excluded.year,
            label = excluded.label, catno = excluded.catno, thumb = excluded.thumb,
            genres = excluded.genres, styles = excluded.styles,
            search_query = excluded.search_query, date_added = COALESCE(excluded.date_added, wantlist.date_added), active = 1
    `);

    var upsertMany = d.transaction(function (items) {
        items.forEach(function (item) {
            upsert.run(userId, item.id, item.artist, item.title, item.year, item.label, item.catno, item.thumb, item.genres || '', item.styles || '', item.searchQuery, item.dateAdded || null);
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
    var now = new Date().toISOString();
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
        now
    );

    // Save daily store history snapshot (one per store per item per day)
    if (!result.linkOnly && !result.error) {
        var today = now.slice(0, 10);
        var price = null;
        if (result.matches && result.matches.length > 0 && result.matches[0].price) {
            var p = String(result.matches[0].price).replace(/[^0-9.,]/g, '').replace(',', '.');
            price = parseFloat(p) || null;
        }
        var existing = d.prepare('SELECT id FROM store_history WHERE wantlist_id = ? AND store = ? AND recorded_at = ?').get(wantlistId, result.store, today);
        if (existing) {
            d.prepare('UPDATE store_history SET in_stock = ?, price = ? WHERE id = ?').run(result.inStock ? 1 : 0, price, existing.id);
        } else {
            d.prepare('INSERT INTO store_history (wantlist_id, store, in_stock, price, recorded_at) VALUES (?, ?, ?, ?, ?)').run(wantlistId, result.store, result.inStock ? 1 : 0, price, today);
        }
    }
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

/**
 * Returns the most recent in-stock store_results row for each
 * (wantlist_id, store) pair for a user. Used by the cart optimizer.
 */
function getLatestInStockResults(userId) {
    return getDb().prepare(`
        SELECT sr.wantlist_id, sr.store, sr.matches, sr.search_url, sr.checked_at
        FROM store_results sr
        INNER JOIN wantlist w ON w.id = sr.wantlist_id
        WHERE w.user_id = ? AND w.active = 1 AND sr.in_stock = 1
        GROUP BY sr.wantlist_id, sr.store
        HAVING sr.checked_at = MAX(sr.checked_at)
    `).all(userId);
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
    var d = getDb();
    var now = new Date().toISOString();
    d.prepare(`
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
        now
    );

    // Append to price history (only if we have a price)
    if (priceData.lowestPrice) {
        // Don't duplicate if already recorded today
        var today = now.substring(0, 10);
        var existing = d.prepare(
            "SELECT id FROM price_history WHERE wantlist_id = ? AND recorded_at LIKE ? || '%'"
        ).get(wantlistId, today);

        if (!existing) {
            d.prepare(`
                INSERT INTO price_history (wantlist_id, lowest_price, num_for_sale, currency, recorded_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(wantlistId, priceData.lowestPrice, priceData.numForSale || 0, priceData.currency || 'USD', now);
        } else {
            // Update today's entry with latest price
            d.prepare('UPDATE price_history SET lowest_price = ?, num_for_sale = ? WHERE id = ?')
                .run(priceData.lowestPrice, priceData.numForSale || 0, existing.id);
        }
    }
}

function getDiscogsPrice(wantlistId) {
    return getDb().prepare('SELECT * FROM discogs_prices WHERE wantlist_id = ?').get(wantlistId);
}

function getPriceHistory(wantlistId, limit) {
    return getDb().prepare(
        'SELECT lowest_price, num_for_sale, currency, recorded_at FROM price_history WHERE wantlist_id = ? ORDER BY recorded_at ASC LIMIT ?'
    ).all(wantlistId, limit || 90);
}

function getPriceHistoryByDiscogsId(discogsId, limit) {
    return getDb().prepare(
        'SELECT ph.lowest_price, ph.num_for_sale, ph.currency, ph.recorded_at FROM price_history ph JOIN wantlist w ON w.id = ph.wantlist_id WHERE w.discogs_id = ? ORDER BY ph.recorded_at ASC LIMIT ?'
    ).all(discogsId, limit || 90);
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
                searchQuery: w.search_query,
                dateAdded: w.date_added || null
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

// ═══════════════════════════════════════════════════════════
// RELEASE DETAILS OPERATIONS
// ═══════════════════════════════════════════════════════════

const RELEASE_DETAILS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function saveReleaseDetails(discogsId, data) {
    getDb().prepare(`
        INSERT INTO release_details (discogs_id, data, fetched_at)
        VALUES (?, ?, ?)
        ON CONFLICT(discogs_id) DO UPDATE SET
            data = excluded.data, fetched_at = excluded.fetched_at
    `).run(discogsId, JSON.stringify(data), new Date().toISOString());
}

function getReleaseDetails(discogsId) {
    var row = getDb().prepare('SELECT * FROM release_details WHERE discogs_id = ?').get(discogsId);
    if (!row) return null;

    // Check TTL
    var fetchedAt = new Date(row.fetched_at).getTime();
    if (Date.now() - fetchedAt > RELEASE_DETAILS_TTL) {
        return null; // expired
    }

    try {
        return JSON.parse(row.data);
    } catch (e) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════
// SESSION OPERATIONS
// ═══════════════════════════════════════════════════════════

function createSession(userId) {
    var crypto = require('crypto');
    var token = crypto.randomBytes(32).toString('hex');
    var now = new Date().toISOString();
    getDb().prepare('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)')
        .run(token, userId, now, now);
    return token;
}

function getSessionUser(token) {
    if (!token) return null;
    var row = getDb().prepare(`
        SELECT s.*, u.username FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
    `).get(token);
    if (!row) return null;
    return { id: row.user_id, username: row.username, token: row.token };
}

function updateSessionLastSeen(token) {
    if (!token) return;
    getDb().prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
        .run(new Date().toISOString(), token);
}

// ═══════════════════════════════════════════════════════════
// OAUTH TOKEN OPERATIONS
// ═══════════════════════════════════════════════════════════

function saveOAuthToken(userId, provider, tokenData) {
    var now = new Date().toISOString();
    getDb().prepare(`
        INSERT INTO oauth_tokens (user_id, provider, access_token, access_secret, refresh_token, expires_at, provider_username, provider_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, provider) DO UPDATE SET
            access_token = excluded.access_token, access_secret = excluded.access_secret,
            refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
            expires_at = excluded.expires_at,
            provider_username = COALESCE(excluded.provider_username, oauth_tokens.provider_username),
            provider_id = COALESCE(excluded.provider_id, oauth_tokens.provider_id),
            updated_at = excluded.updated_at
    `).run(
        userId, provider,
        tokenData.accessToken || null,
        tokenData.accessSecret || null,
        tokenData.refreshToken || null,
        tokenData.expiresAt || null,
        tokenData.providerUsername || null,
        tokenData.providerId || null,
        now, now
    );
}

function getOAuthToken(userId, provider) {
    return getDb().prepare('SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?').get(userId, provider);
}

function deleteOAuthToken(userId, provider) {
    getDb().prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?').run(userId, provider);
}

// ═══════════════════════════════════════════════════════════
// SCAN CHANGES (new since last visit)
// ═══════════════════════════════════════════════════════════

function snapshotStoreResults(userId) {
    // Get current in_stock status + best price per wantlist item per store
    return getDb().prepare(`
        SELECT sr.wantlist_id, sr.store, sr.in_stock, sr.matches
        FROM store_results sr
        JOIN wantlist w ON w.id = sr.wantlist_id
        WHERE w.user_id = ? AND w.active = 1
    `).all(userId);
}

function insertScanChange(userId, wantlistId, changeType, store, oldVal, newVal) {
    getDb().prepare(`
        INSERT INTO scan_changes (user_id, wantlist_id, change_type, store, old_value, new_value, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, wantlistId, changeType, store, JSON.stringify(oldVal), JSON.stringify(newVal), new Date().toISOString());
}

function getUndismissedChanges(userId, since) {
    var query = `
        SELECT sc.*, w.artist, w.title, w.thumb, w.discogs_id
        FROM scan_changes sc
        JOIN wantlist w ON w.id = sc.wantlist_id
        WHERE sc.user_id = ? AND sc.dismissed = 0
    `;
    var params = [userId];
    if (since) {
        query += ' AND sc.detected_at > ?';
        params.push(since);
    }
    query += ' ORDER BY sc.detected_at DESC LIMIT 100';
    return getDb().prepare(query).all(params);
}

function dismissChanges(userId, ids) {
    if (!ids || ids.length === 0) {
        getDb().prepare('UPDATE scan_changes SET dismissed = 1 WHERE user_id = ? AND dismissed = 0').run(userId);
    } else {
        var placeholders = ids.map(function() { return '?'; }).join(',');
        getDb().prepare('UPDATE scan_changes SET dismissed = 1 WHERE user_id = ? AND id IN (' + placeholders + ')').run(userId, ...ids);
    }
}

function getUsersDueForRescan() {
    // Users who have any wantlist items AND haven't had a daily rescan in 20+ hours
    // Picks up users with partial scans too (last_full_scan can be NULL)
    return getDb().prepare(`
        SELECT u.* FROM users u
        WHERE EXISTS (SELECT 1 FROM wantlist w WHERE w.user_id = u.id AND w.active = 1)
        AND (u.last_daily_rescan IS NULL OR u.last_daily_rescan < datetime('now', '-20 hours'))
    `).all();
}

function updateUserDailyRescan(userId) {
    getDb().prepare('UPDATE users SET last_daily_rescan = ? WHERE id = ?').run(new Date().toISOString(), userId);
}

function getSessionLastSeen(token) {
    if (!token) return null;
    var row = getDb().prepare('SELECT last_seen FROM sessions WHERE token = ?').get(token);
    return row ? row.last_seen : null;
}

// ═══════════════════════════════════════════════════════════
// HISTORY OPERATIONS
// ═══════════════════════════════════════════════════════════

function getStoreHistory(wantlistId, days) {
    days = days || 90;
    var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return getDb().prepare(
        'SELECT store, in_stock, price, recorded_at FROM store_history WHERE wantlist_id = ? AND recorded_at >= ? ORDER BY recorded_at'
    ).all(wantlistId, since);
}

function getItemHistory(wantlistId, days) {
    days = days || 90;
    var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    var storeHist = getDb().prepare(
        'SELECT store, in_stock, price, recorded_at FROM store_history WHERE wantlist_id = ? AND recorded_at >= ? ORDER BY recorded_at'
    ).all(wantlistId, since);
    var priceHist = getDb().prepare(
        'SELECT lowest_price, num_for_sale, currency, recorded_at FROM price_history WHERE wantlist_id = ? AND recorded_at >= ? ORDER BY recorded_at'
    ).all(wantlistId, since);
    return { stores: storeHist, discogs: priceHist };
}

// ═══════════════════════════════════════════════════════════
// STORE INVENTORY OPERATIONS
// ═══════════════════════════════════════════════════════════

function startStoreSync(store) {
    var info = getDb().prepare(
        'INSERT INTO store_sync_log (store, started_at) VALUES (?, ?)'
    ).run(store, new Date().toISOString());
    return info.lastInsertRowid;
}

function finishStoreSync(syncId, stats) {
    stats = stats || {};
    getDb().prepare(`
        UPDATE store_sync_log
        SET finished_at = ?, products_seen = ?, products_added = ?,
            products_updated = ?, products_marked_unavailable = ?, error = ?
        WHERE id = ?
    `).run(
        new Date().toISOString(),
        stats.seen || 0,
        stats.added || 0,
        stats.updated || 0,
        stats.markedUnavailable || 0,
        stats.error || null,
        syncId
    );
}

function getLastStoreSync(store) {
    return getDb().prepare(
        'SELECT * FROM store_sync_log WHERE store = ? ORDER BY started_at DESC LIMIT 1'
    ).get(store);
}

// Upsert one inventory row. Returns 'added' | 'updated' so the caller can tally stats.
function upsertInventoryItem(item) {
    var d = getDb();
    var now = new Date().toISOString();
    var existing = d.prepare(
        'SELECT id, available FROM store_inventory WHERE store = ? AND product_id = ?'
    ).get(item.store, item.productId);

    if (existing) {
        d.prepare(`
            UPDATE store_inventory SET
                title_raw = ?, artist = ?, title = ?, label = ?, catno = ?,
                vendor = ?, product_type = ?, tags = ?, price_usd = ?, currency = ?,
                available = ?, url = ?, image_url = ?, store_updated_at = ?, last_synced_at = ?
            WHERE id = ?
        `).run(
            item.titleRaw || null,
            item.artist || null,
            item.title || null,
            item.label || null,
            item.catno || null,
            item.vendor || null,
            item.productType || null,
            JSON.stringify(item.tags || []),
            item.priceUsd != null ? item.priceUsd : null,
            item.currency || 'USD',
            item.available ? 1 : 0,
            item.url || null,
            item.imageUrl || null,
            item.storeUpdatedAt || null,
            now,
            existing.id
        );
        return 'updated';
    } else {
        d.prepare(`
            INSERT INTO store_inventory (
                store, product_id, title_raw, artist, title, label, catno,
                vendor, product_type, tags, price_usd, currency, available,
                url, image_url, store_updated_at, last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            item.store,
            item.productId,
            item.titleRaw || null,
            item.artist || null,
            item.title || null,
            item.label || null,
            item.catno || null,
            item.vendor || null,
            item.productType || null,
            JSON.stringify(item.tags || []),
            item.priceUsd != null ? item.priceUsd : null,
            item.currency || 'USD',
            item.available ? 1 : 0,
            item.url || null,
            item.imageUrl || null,
            item.storeUpdatedAt || null,
            now
        );
        return 'added';
    }
}

function upsertInventoryBatch(items) {
    var d = getDb();
    var stats = { added: 0, updated: 0, seen: items.length };
    var run = d.transaction(function (rows) {
        rows.forEach(function (row) {
            var result = upsertInventoryItem(row);
            stats[result]++;
        });
    });
    run(items);
    return stats;
}

// After a sync completes, mark items not seen during this sync as unavailable.
// We treat items not present in the latest /products.json as sold out / delisted
// rather than deleting them, so historical references and `scan_changes` still resolve.
function markStaleInventoryUnavailable(store, syncedSince) {
    var info = getDb().prepare(`
        UPDATE store_inventory
        SET available = 0
        WHERE store = ? AND available = 1 AND (last_synced_at IS NULL OR last_synced_at < ?)
    `).run(store, syncedSince);
    return info.changes;
}

function getInStockInventory(store) {
    return getDb().prepare(
        'SELECT * FROM store_inventory WHERE store = ? AND available = 1'
    ).all(store);
}

function getInventoryStats(store) {
    return getDb().prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(available) AS in_stock,
            COUNT(DISTINCT label) AS unique_labels
        FROM store_inventory WHERE store = ?
    `).get(store);
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
    getLatestInStockResults: getLatestInStockResults,
    getItemsNeedingCheck: getItemsNeedingCheck,
    saveDiscogsPrice: saveDiscogsPrice,
    getDiscogsPrice: getDiscogsPrice,
    getPriceHistory: getPriceHistory,
    getPriceHistoryByDiscogsId: getPriceHistoryByDiscogsId,
    getPricesNeedingCheck: getPricesNeedingCheck,
    getFullResults: getFullResults,
    saveReleaseDetails: saveReleaseDetails,
    getReleaseDetails: getReleaseDetails,
    createSession: createSession,
    getSessionUser: getSessionUser,
    updateSessionLastSeen: updateSessionLastSeen,
    saveOAuthToken: saveOAuthToken,
    getOAuthToken: getOAuthToken,
    deleteOAuthToken: deleteOAuthToken,
    snapshotStoreResults: snapshotStoreResults,
    insertScanChange: insertScanChange,
    getUndismissedChanges: getUndismissedChanges,
    dismissChanges: dismissChanges,
    getUsersDueForRescan: getUsersDueForRescan,
    updateUserDailyRescan: updateUserDailyRescan,
    getSessionLastSeen: getSessionLastSeen,
    getStoreHistory: getStoreHistory,
    getItemHistory: getItemHistory,
    startStoreSync: startStoreSync,
    finishStoreSync: finishStoreSync,
    getLastStoreSync: getLastStoreSync,
    upsertInventoryItem: upsertInventoryItem,
    upsertInventoryBatch: upsertInventoryBatch,
    markStaleInventoryUnavailable: markStaleInventoryUnavailable,
    getInStockInventory: getInStockInventory,
    getInventoryStats: getInventoryStats,
    close: close
};
