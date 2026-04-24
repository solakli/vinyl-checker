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

        CREATE TABLE IF NOT EXISTS discogs_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wantlist_id INTEGER NOT NULL,
            listing_id INTEGER,
            seller_username TEXT NOT NULL,
            seller_rating REAL,
            seller_num_ratings INTEGER,
            price_usd REAL,
            price_original REAL,
            currency TEXT DEFAULT 'USD',
            condition TEXT,
            ships_from TEXT,
            listing_url TEXT,
            fetched_at TEXT,
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

        -- Cached Discogs marketplace listings per release.
        -- Expires after TTL so we don't hammer the API on every optimize run.
        CREATE TABLE IF NOT EXISTS market_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discogs_release_id INTEGER NOT NULL,
            listing_id INTEGER NOT NULL,
            seller_username TEXT NOT NULL,
            seller_country TEXT,
            seller_rating REAL,
            seller_num_ratings INTEGER DEFAULT 0,
            price REAL NOT NULL,
            currency TEXT DEFAULT 'USD',
            price_usd REAL,
            condition TEXT,
            sleeve_condition TEXT,
            comments TEXT,
            listing_url TEXT,
            fetched_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            UNIQUE(listing_id)
        );

        CREATE INDEX IF NOT EXISTS idx_market_listings_release ON market_listings(discogs_release_id, expires_at);
        CREATE INDEX IF NOT EXISTS idx_market_listings_seller ON market_listings(seller_username);

        -- User preferences for the optimizer (per Discogs user).
        CREATE TABLE IF NOT EXISTS user_preferences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            country_code TEXT,
            postcode TEXT,
            min_condition TEXT DEFAULT 'VG+',
            min_seller_rating REAL DEFAULT 98.0,
            max_price_usd REAL,
            currency TEXT DEFAULT 'USD',
            updated_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Optimizer job queue. One row per submitted optimization request.
        CREATE TABLE IF NOT EXISTS optimizer_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            user_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            params TEXT,
            progress TEXT,
            result TEXT,
            error TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            started_at TEXT,
            completed_at TEXT
        );

        -- ── OBSERVABILITY ─────────────────────────────────────────────

        -- One row per scan job (full, force, background, daily).
        -- Gives timing, throughput, and error counts per run.
        CREATE TABLE IF NOT EXISTS scan_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            run_type TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            items_checked INTEGER DEFAULT 0,
            items_in_stock INTEGER DEFAULT 0,
            items_cached INTEGER DEFAULT 0,
            items_error INTEGER DEFAULT 0,
            changes_detected INTEGER DEFAULT 0,
            duration_ms INTEGER,
            error TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_scan_runs_user ON scan_runs(user_id, started_at);

        -- Per-store scraper error log (one row per error per item).
        -- Populated by scanner whenever a store check returns .error.
        CREATE TABLE IF NOT EXISTS scraper_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id INTEGER,
            user_id INTEGER,
            store TEXT NOT NULL,
            artist TEXT,
            title TEXT,
            error_msg TEXT,
            error_type TEXT,
            occurred_at TEXT NOT NULL,
            FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id)
        );

        CREATE INDEX IF NOT EXISTS idx_scraper_errors_store ON scraper_errors(store, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_scraper_errors_run ON scraper_errors(scan_run_id);

        -- One row per validator job run (TP/FP/FN/TN aggregate).
        CREATE TABLE IF NOT EXISTS validator_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            items_checked INTEGER DEFAULT 0,
            tp INTEGER DEFAULT 0,
            fp INTEGER DEFAULT 0,
            fn INTEGER DEFAULT 0,
            tn INTEGER DEFAULT 0,
            errors INTEGER DEFAULT 0,
            duration_ms INTEGER
        );

        -- Cumulative confusion matrix per store, updated after each validator run.
        -- precision_pct = tp/(tp+fp)*100,  recall_pct = tp/(tp+fn)*100
        CREATE TABLE IF NOT EXISTS store_accuracy (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store TEXT UNIQUE NOT NULL,
            tp INTEGER DEFAULT 0,
            fp INTEGER DEFAULT 0,
            fn INTEGER DEFAULT 0,
            tn INTEGER DEFAULT 0,
            errors INTEGER DEFAULT 0,
            checked INTEGER DEFAULT 0,
            precision_pct REAL,
            recall_pct REAL,
            last_updated TEXT
        );
    `);

    // Indexes
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_optimizer_jobs_username ON optimizer_jobs(username)'); } catch(e) {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_optimizer_jobs_status ON optimizer_jobs(status, created_at)'); } catch(e) {}

    // Migrations — add columns if missing
    try { db.exec('ALTER TABLE users ADD COLUMN last_daily_rescan TEXT'); } catch(e) {}
    try { db.exec('ALTER TABLE market_listings ADD COLUMN price_usd REAL'); } catch(e) {}
    // workers_used: how many parallel Chrome workers were used for this scan run (1 or 2)
    try { db.exec('ALTER TABLE scan_runs ADD COLUMN workers_used INTEGER'); } catch(e) {}

    // Collection table — mirrors user's Discogs collection (records they own)
    db.exec(`
        CREATE TABLE IF NOT EXISTS collection (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            discogs_id  INTEGER,
            instance_id INTEGER,
            artist      TEXT,
            title       TEXT,
            year        INTEGER,
            label       TEXT,
            catno       TEXT,
            thumb       TEXT,
            genres      TEXT DEFAULT '',
            styles      TEXT DEFAULT '',
            formats     TEXT DEFAULT '',
            date_added  TEXT,
            rating      INTEGER DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, instance_id)
        );
        CREATE INDEX IF NOT EXISTS idx_collection_user ON collection(user_id);
    `);

    // ── Streaming integration ────────────────────────────────────────────────────

    // Popularity/metadata per release fetched from streaming APIs.
    // Keyed by discogs_id so we can join with wantlist.
    db.exec(`
        CREATE TABLE IF NOT EXISTS streaming_metadata (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            discogs_id               INTEGER NOT NULL,
            spotify_album_uri        TEXT,
            spotify_artist_uri       TEXT,
            spotify_popularity       INTEGER,
            spotify_artist_followers INTEGER,
            youtube_video_id         TEXT,
            youtube_view_count       INTEGER,
            youtube_like_count       INTEGER,
            youtube_comment_data     TEXT,   -- JSON: { genres, era, djs, sounds_like, raw_top[] }
            youtube_enriched_at      TEXT,   -- when comments/stats were last fetched
            soundcloud_track_id      INTEGER,
            soundcloud_playback_count INTEGER,
            soundcloud_reposts       INTEGER,
            soundcloud_likes         INTEGER,
            fetched_at               TEXT NOT NULL,
            UNIQUE(discogs_id)
        );
        CREATE INDEX IF NOT EXISTS idx_streaming_meta_discogs ON streaming_metadata(discogs_id);
    `);

    // User listening activity synced from Spotify / SoundCloud / YouTube.
    // One row per track/artist event (top_artist, recent_play, liked_track, etc.)
    // user_affinity is a pre-computed 0-1 score used by the recommendation engine.
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_streaming_activity (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL,
            provider      TEXT NOT NULL,
            activity_type TEXT NOT NULL,
            artist_name   TEXT,
            track_name    TEXT,
            album_name    TEXT,
            provider_uri  TEXT,
            play_count    INTEGER,
            user_affinity REAL,
            recorded_at   TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_streaming_activity_user
            ON user_streaming_activity(user_id, provider, activity_type);
    `);

    // ── Discover cart — user's per-store shopping cart ───────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS cart (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            wantlist_id INTEGER NOT NULL,
            store       TEXT    NOT NULL,
            price       TEXT,
            price_usd   REAL,
            added_at    TEXT    NOT NULL,
            FOREIGN KEY (user_id)     REFERENCES users(id),
            FOREIGN KEY (wantlist_id) REFERENCES wantlist(id),
            UNIQUE(user_id, wantlist_id, store)
        );
        CREATE INDEX IF NOT EXISTS idx_cart_user ON cart(user_id);
    `);

    // ── Discogs release community metadata ──────────────────────────────────
    // Fetched from api.discogs.com/releases/{id} in the background.
    // community_have/want + avg_rating give us rarity signal for taste profiling.
    db.exec(`
        CREATE TABLE IF NOT EXISTS release_meta (
            discogs_id      INTEGER PRIMARY KEY,
            community_have  INTEGER,
            community_want  INTEGER,
            avg_rating      REAL,
            ratings_count   INTEGER,
            country         TEXT,
            year            INTEGER,
            fetched_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_release_meta_fetched ON release_meta(fetched_at);
    `);

    // ── AI-generated taste profile cache ─────────────────────────────────────
    try { db.exec(`ALTER TABLE users ADD COLUMN taste_tags TEXT`); } catch(e) {}
    try { db.exec(`ALTER TABLE users ADD COLUMN taste_summary TEXT`); } catch(e) {}
    try { db.exec(`ALTER TABLE users ADD COLUMN taste_computed_at TEXT`); } catch(e) {}
    // YouTube enrichment columns
    try { db.exec(`ALTER TABLE streaming_metadata ADD COLUMN youtube_comment_data TEXT`); } catch(e) {}
    try { db.exec(`ALTER TABLE streaming_metadata ADD COLUMN youtube_enriched_at TEXT`); } catch(e) {}

    // ── GOLDIE chat sessions ──────────────────────────────────────────────────
    db.exec(`
        CREATE TABLE IF NOT EXISTS goldie_sessions (
            id          TEXT PRIMARY KEY,
            username    TEXT,
            title       TEXT,
            messages    TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            last_active TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_goldie_sessions_user ON goldie_sessions(username, last_active);
    `);
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

// ═══════════════════════════════════════════════════════════
// DISCOGS LISTINGS (individual seller listings for optimizer)
// ═══════════════════════════════════════════════════════════

function saveDiscogsListings(wantlistId, listings) {
    var d = getDb();
    var now = new Date().toISOString();
    // Clear old listings for this item first
    d.prepare('DELETE FROM discogs_listings WHERE wantlist_id = ?').run(wantlistId);
    var insert = d.prepare(`
        INSERT INTO discogs_listings
            (wantlist_id, listing_id, seller_username, seller_rating, seller_num_ratings,
             price_usd, price_original, currency, condition, ships_from, listing_url, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    var insertMany = d.transaction(function (rows) {
        rows.forEach(function (l) {
            insert.run(
                wantlistId, l.listingId || null, l.sellerUsername || '',
                l.sellerRating || null, l.sellerNumRatings || null,
                l.priceUsd || null, l.priceOriginal || null, l.currency || 'USD',
                l.condition || '', l.shipsFrom || '', l.listingUrl || '', now
            );
        });
    });
    insertMany(listings);
}

function getDiscogsListings(userId) {
    return getDb().prepare(`
        SELECT dl.*, w.artist, w.title, w.catno, w.discogs_id, w.thumb, w.genres, w.styles
        FROM discogs_listings dl
        JOIN wantlist w ON w.id = dl.wantlist_id
        WHERE w.user_id = ? AND w.active = 1
        ORDER BY dl.wantlist_id, dl.price_usd ASC
    `).all(userId);
}

function getMarketplaceSyncStatus(userId) {
    var row = getDb().prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN fetched_at IS NOT NULL THEN 1 ELSE 0 END) as synced,
               MAX(fetched_at) as last_synced
        FROM discogs_listings dl
        JOIN wantlist w ON w.id = dl.wantlist_id
        WHERE w.user_id = ? AND w.active = 1
    `).get(userId);
    return row;
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

    // Build per-item Discogs listings summary in ONE query (not N queries)
    var listingsSummary = {};
    if (items.length > 0) {
        var ids = items.map(function (w) { return w.id; });
        var placeholders = ids.map(function () { return '?'; }).join(',');
        try {
            var stmt = d.prepare(
                'SELECT wantlist_id,' +
                '  COUNT(*) as num_listings,' +
                '  MIN(price_usd) as cheapest_usd,' +
                '  MIN(CASE WHEN ships_from IN (\'US\',\'United States\') THEN price_usd END) as cheapest_us_usd,' +
                '  SUM(CASE WHEN ships_from IN (\'US\',\'United States\') THEN 1 ELSE 0 END) as us_count,' +
                '  MIN(CASE WHEN ships_from IN (\'US\',\'United States\') THEN condition END) as cheapest_us_cond' +
                ' FROM discogs_listings' +
                ' WHERE wantlist_id IN (' + placeholders + ')' +
                ' GROUP BY wantlist_id'
            );
            var rows = stmt.all(ids);   // better-sqlite3 accepts array as single arg
            rows.forEach(function (r) { listingsSummary[r.wantlist_id] = r; });
        } catch (e) {
            // discogs_listings table may be empty — not fatal
        }
    }

    // Build per-item summary from market_listings (populated by the cart optimizer).
    // Keyed by discogs_id since market_listings doesn't know wantlist_ids.
    var marketListingsSummary = {};
    if (items.length > 0) {
        var discogIds = items.map(function (w) { return w.discogs_id; }).filter(Boolean);
        if (discogIds.length > 0) {
            var ph2 = discogIds.map(function () { return '?'; }).join(',');
            try {
                var mlRows = d.prepare(
                    'SELECT discogs_release_id,' +
                    '  COUNT(*) as num_listings,' +
                    '  MIN(price_usd) as cheapest_usd,' +
                    '  MIN(CASE WHEN seller_country IN (\'US\',\'United States\') THEN price_usd END) as cheapest_us_usd,' +
                    '  SUM(CASE WHEN seller_country IN (\'US\',\'United States\') THEN 1 ELSE 0 END) as us_count' +
                    ' FROM market_listings' +
                    ' WHERE discogs_release_id IN (' + ph2 + ') AND expires_at > ?' +
                    ' GROUP BY discogs_release_id'
                ).all([...discogIds, new Date().toISOString()]);
                var mlByRelease = {};
                mlRows.forEach(function (r) { mlByRelease[r.discogs_release_id] = r; });
                items.forEach(function (w) {
                    if (w.discogs_id && mlByRelease[w.discogs_id]) {
                        marketListingsSummary[w.id] = mlByRelease[w.discogs_id];
                    }
                });
            } catch (e) { /* market_listings may be empty — not fatal */ }
        }
    }

    return items.map(function (w) {
        var stores = getStoreResults(w.id);
        var price = getDiscogsPrice(w.id);
        var ls = listingsSummary[w.id] || null;
        var mls = marketListingsSummary[w.id] || null;

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
            // Summary of individually-synced Discogs listings (from Chrome extension)
            discogsListings: ls ? {
                numListings: ls.num_listings || 0,
                cheapestUsd: ls.cheapest_usd || null,
                cheapestUsUsd: ls.cheapest_us_usd || null,
                usCount: ls.us_count || 0,
                cheapestUsCond: ls.cheapest_us_cond || null
            } : null,
            // Summary from market_listings (populated when cart optimizer is run)
            marketListings: mls ? {
                numListings: mls.num_listings || 0,
                cheapestUsd: mls.cheapest_usd || null,
                cheapestUsUsd: mls.cheapest_us_usd || null,
                usCount: mls.us_count || 0
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
    var d = getDb();
    var now = new Date().toISOString();
    // Deduplicate: if an undismissed change of the same type already exists for this
    // item+store, update its timestamp and new_value instead of inserting a duplicate.
    // This prevents the banner showing the same record twice when the validator briefly
    // flips it to 0 and the next daily re-detects it as now_in_stock.
    var existing = d.prepare(
        'SELECT id FROM scan_changes WHERE user_id=? AND wantlist_id=? AND change_type=? AND store=? AND dismissed=0'
    ).get(userId, wantlistId, changeType, store);
    if (existing) {
        d.prepare('UPDATE scan_changes SET new_value=?, detected_at=? WHERE id=?')
            .run(JSON.stringify(newVal), now, existing.id);
    } else {
        d.prepare(`
            INSERT INTO scan_changes (user_id, wantlist_id, change_type, store, old_value, new_value, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, wantlistId, changeType, store, JSON.stringify(oldVal), JSON.stringify(newVal), now);
    }
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
    // Users who have any wantlist items AND haven't had a daily rescan in 23+ hours.
    // Also skips users who already have an unfinished scan_run (started_at exists,
    // finished_at NULL) that began within the last 3 hours — guards against cascades
    // where Chrome OOM-crashed before last_daily_rescan could be stamped.
    return getDb().prepare(`
        SELECT u.* FROM users u
        WHERE EXISTS (SELECT 1 FROM wantlist w WHERE w.user_id = u.id AND w.active = 1)
          AND (u.last_daily_rescan IS NULL OR u.last_daily_rescan < datetime('now', '-23 hours'))
          AND NOT EXISTS (
              SELECT 1 FROM scan_runs sr
              WHERE sr.user_id = u.id
                AND sr.finished_at IS NULL
                AND sr.started_at > datetime('now', '-3 hours')
          )
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

/** All in-stock inventory across every synced store — for recommendations. */
function getAllInStockInventory() {
    return getDb().prepare(
        'SELECT * FROM store_inventory WHERE available = 1 ORDER BY last_synced_at DESC'
    ).all();
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

// ═══════════════════════════════════════════════════════════
// MARKET LISTINGS (Discogs marketplace cache)
// ═══════════════════════════════════════════════════════════

function upsertMarketListings(listings) {
    var d = getDb();
    var stmt = d.prepare(`
        INSERT INTO market_listings
            (discogs_release_id, listing_id, seller_username, seller_country,
             seller_rating, seller_num_ratings, price, currency, price_usd,
             condition, sleeve_condition, comments, listing_url, fetched_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(listing_id) DO UPDATE SET
            seller_rating = excluded.seller_rating,
            price = excluded.price, price_usd = excluded.price_usd,
            condition = excluded.condition,
            fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    `);
    var run = d.transaction(function (rows) {
        rows.forEach(function (l) {
            stmt.run(
                l.releaseId, l.listingId, l.sellerUsername, l.sellerCountry || null,
                l.sellerRating || null, l.sellerNumRatings || 0,
                l.price, l.currency || 'USD', l.priceUsd || null,
                l.condition || null, l.sleeveCondition || null,
                l.comments || null, l.listingUrl || null,
                l.fetchedAt, l.expiresAt
            );
        });
    });
    run(listings);
}

function getMarketListings(releaseId) {
    var now = new Date().toISOString();
    return getDb().prepare(
        'SELECT * FROM market_listings WHERE discogs_release_id = ? AND expires_at > ? ORDER BY price_usd ASC'
    ).all(releaseId, now);
}

function clearExpiredListings() {
    var now = new Date().toISOString();
    var info = getDb().prepare('DELETE FROM market_listings WHERE expires_at <= ?').run(now);
    return info.changes;
}

function getListingCacheAge(releaseId) {
    var row = getDb().prepare(
        'SELECT fetched_at, expires_at FROM market_listings WHERE discogs_release_id = ? ORDER BY fetched_at DESC LIMIT 1'
    ).get(releaseId);
    return row || null;
}

// ═══════════════════════════════════════════════════════════
// USER PREFERENCES
// ═══════════════════════════════════════════════════════════

function getUserPreferences(userId) {
    return getDb().prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) || null;
}

function saveUserPreferences(userId, prefs) {
    var d = getDb();
    var now = new Date().toISOString();
    d.prepare(`
        INSERT INTO user_preferences
            (user_id, country_code, postcode, min_condition, min_seller_rating, max_price_usd, currency, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
            country_code = excluded.country_code,
            postcode = excluded.postcode,
            min_condition = excluded.min_condition,
            min_seller_rating = excluded.min_seller_rating,
            max_price_usd = excluded.max_price_usd,
            currency = excluded.currency,
            updated_at = excluded.updated_at
    `).run(
        userId,
        prefs.countryCode || null,
        prefs.postcode || null,
        prefs.minCondition || 'VG+',
        prefs.minSellerRating != null ? prefs.minSellerRating : 98.0,
        prefs.maxPriceUsd || null,
        prefs.currency || 'USD',
        now
    );
    return getUserPreferences(userId);
}

// ═══════════════════════════════════════════════════════════
// OPTIMIZER JOB QUEUE
// ═══════════════════════════════════════════════════════════

function createOptimizerJob(username, userId, params) {
    var d = getDb();
    // If there's already a pending or processing job for this user, return it
    var existing = d.prepare(
        "SELECT * FROM optimizer_jobs WHERE username = ? AND status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1"
    ).get(username);
    if (existing) {
        var pos = getQueuePosition(existing.id);
        return { job: existing, queuePosition: pos, reused: true };
    }
    var info = d.prepare(
        'INSERT INTO optimizer_jobs (username, user_id, params, status) VALUES (?, ?, ?, ?)'
    ).run(username, userId || null, JSON.stringify(params || {}), 'pending');
    var job = d.prepare('SELECT * FROM optimizer_jobs WHERE id = ?').get(info.lastInsertRowid);
    var pos = getQueuePosition(job.id);
    return { job: job, queuePosition: pos, reused: false };
}

function getOptimizerJob(jobId) {
    return getDb().prepare('SELECT * FROM optimizer_jobs WHERE id = ?').get(jobId) || null;
}

/**
 * Return the most recent completed optimizer job for a user,
 * if it was completed within maxAgeHours (default 24).
 */
function getLatestCompletedOptimization(username, maxAgeHours) {
    maxAgeHours = maxAgeHours || 24;
    var cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    return getDb().prepare(
        "SELECT id, username, completed_at, result FROM optimizer_jobs " +
        "WHERE username = ? AND status = 'done' AND completed_at > ? " +
        "ORDER BY completed_at DESC LIMIT 1"
    ).get(username, cutoff) || null;
}

function getActiveJobForUser(username) {
    return getDb().prepare(
        "SELECT * FROM optimizer_jobs WHERE username = ? AND status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1"
    ).get(username) || null;
}

function getQueuePosition(jobId) {
    // How many pending jobs were created before this one?
    var row = getDb().prepare(
        "SELECT COUNT(*) as cnt FROM optimizer_jobs WHERE status = 'pending' AND id < ?"
    ).get(jobId);
    return row ? row.cnt : 0;
}

// Atomically claim the next pending job — sets status to 'processing'.
// Returns the claimed job or null if queue is empty.
function claimNextJob() {
    var d = getDb();
    var job = d.prepare(
        "SELECT * FROM optimizer_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    ).get();
    if (!job) return null;
    var now = new Date().toISOString();
    d.prepare(
        "UPDATE optimizer_jobs SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'"
    ).run(now, job.id);
    // Re-fetch to confirm we got it (in case of concurrent workers)
    var claimed = d.prepare("SELECT * FROM optimizer_jobs WHERE id = ? AND status = 'processing'").get(job.id);
    return claimed || null;
}

function updateJobProgress(jobId, progress) {
    getDb().prepare(
        'UPDATE optimizer_jobs SET progress = ? WHERE id = ?'
    ).run(JSON.stringify(progress), jobId);
}

function completeOptimizerJob(jobId, result) {
    var now = new Date().toISOString();
    getDb().prepare(
        "UPDATE optimizer_jobs SET status = 'done', result = ?, completed_at = ?, progress = NULL WHERE id = ?"
    ).run(JSON.stringify(result), now, jobId);
}

function failOptimizerJob(jobId, errorMsg) {
    var now = new Date().toISOString();
    getDb().prepare(
        "UPDATE optimizer_jobs SET status = 'failed', error = ?, completed_at = ?, progress = NULL WHERE id = ?"
    ).run(errorMsg, now, jobId);
}

// Clean up completed/failed jobs older than 24 hours
function cleanupOldOptimizerJobs() {
    var cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    var info = getDb().prepare(
        "DELETE FROM optimizer_jobs WHERE status IN ('done','failed') AND completed_at < ?"
    ).run(cutoff);
    return info.changes;
}

// ═══════════════════════════════════════════════════════════
// OBSERVABILITY — scan run logging
// ═══════════════════════════════════════════════════════════

function startScanRun(userId, runType) {
    var info = getDb().prepare(
        'INSERT INTO scan_runs (user_id, run_type, started_at) VALUES (?, ?, ?)'
    ).run(userId, runType, new Date().toISOString());
    return info.lastInsertRowid;
}

function finishScanRun(runId, stats) {
    stats = stats || {};
    var now = new Date().toISOString();
    var row = getDb().prepare('SELECT started_at FROM scan_runs WHERE id = ?').get(runId);
    var durationMs = row ? (Date.now() - new Date(row.started_at).getTime()) : null;
    getDb().prepare(`
        UPDATE scan_runs SET
            finished_at = ?, items_checked = ?, items_in_stock = ?,
            items_cached = ?, items_error = ?, changes_detected = ?,
            duration_ms = ?, error = ?, workers_used = ?
        WHERE id = ?
    `).run(
        now,
        stats.itemsChecked || 0, stats.itemsInStock || 0,
        stats.itemsCached || 0, stats.itemsError || 0,
        stats.changesDetected || 0, durationMs, stats.error || null,
        stats.workersUsed || null,
        runId
    );
}

// Per-run-type aggregate stats (last 30 days) — used by admin KPI dashboard
function getScanRunStats() {
    return getDb().prepare(`
        SELECT
            run_type,
            COUNT(*)                                                    AS run_count,
            ROUND(AVG(duration_ms))                                     AS avg_duration_ms,
            MIN(duration_ms)                                            AS min_duration_ms,
            MAX(duration_ms)                                            AS max_duration_ms,
            ROUND(AVG(items_checked))                                   AS avg_items_checked,
            ROUND(AVG(items_error))                                     AS avg_errors,
            SUM(CASE WHEN workers_used = 1 THEN 1 ELSE 0 END)          AS single_worker_runs,
            SUM(CASE WHEN workers_used >= 2 THEN 1 ELSE 0 END)         AS dual_worker_runs,
            SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)         AS failed_runs
        FROM scan_runs
        WHERE started_at >= datetime('now', '-30 days')
        GROUP BY run_type
        ORDER BY run_count DESC
    `).all();
}

// Last N stock-availability changes across all users (for dashboard timeline)
function getRecentStockChanges(limit) {
    return getDb().prepare(`
        SELECT sc.change_type, sc.store, sc.detected_at,
               sc.new_value, w.artist, w.title, u.username
        FROM scan_changes sc
        JOIN wantlist w ON w.id = sc.wantlist_id
        JOIN users u    ON u.id = sc.user_id
        ORDER BY sc.detected_at DESC
        LIMIT ?
    `).all(limit || 20);
}

// Log a single scraper error (store check returned .error field).
// error_type: one of 'err_timeout', 'err_nav', 'err_protocol', 'err_selector', 'err_other'
function logScraperError(scanRunId, userId, store, artist, title, errorMsg, errorType) {
    getDb().prepare(`
        INSERT INTO scraper_errors
            (scan_run_id, user_id, store, artist, title, error_msg, error_type, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        scanRunId || null, userId || null, store,
        artist || null, title || null,
        errorMsg || null, errorType || null,
        new Date().toISOString()
    );
}

function getRecentScanRuns(userId, limit) {
    return getDb().prepare(
        'SELECT * FROM scan_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(userId, limit || 20);
}

// Aggregate error counts per store over the last N days
function getScraperErrorStats(days) {
    days = days || 7;
    var since = new Date(Date.now() - days * 86400000).toISOString();
    return getDb().prepare(`
        SELECT store,
               COUNT(*) AS total_errors,
               SUM(CASE WHEN error_type = 'err_timeout'  THEN 1 ELSE 0 END) AS timeouts,
               SUM(CASE WHEN error_type = 'err_nav'      THEN 1 ELSE 0 END) AS nav_errors,
               SUM(CASE WHEN error_type = 'err_protocol' THEN 1 ELSE 0 END) AS protocol_errors,
               SUM(CASE WHEN error_type = 'err_selector' THEN 1 ELSE 0 END) AS selector_errors,
               MAX(occurred_at) AS last_error_at
        FROM scraper_errors
        WHERE occurred_at >= ?
        GROUP BY store
        ORDER BY total_errors DESC
    `).all(since);
}

// ═══════════════════════════════════════════════════════════
// OBSERVABILITY — validator tracking
// ═══════════════════════════════════════════════════════════

function startValidatorRun() {
    var info = getDb().prepare(
        'INSERT INTO validator_runs (started_at) VALUES (?)'
    ).run(new Date().toISOString());
    return info.lastInsertRowid;
}

function finishValidatorRun(runId, stats) {
    stats = stats || {};
    var now = new Date().toISOString();
    var row = getDb().prepare('SELECT started_at FROM validator_runs WHERE id = ?').get(runId);
    var durationMs = row ? (Date.now() - new Date(row.started_at).getTime()) : null;
    var total = (stats.tp || 0) + (stats.fp || 0) + (stats.fn || 0) + (stats.tn || 0) + (stats.errors || 0);
    getDb().prepare(`
        UPDATE validator_runs SET
            finished_at = ?, items_checked = ?,
            tp = ?, fp = ?, fn = ?, tn = ?, errors = ?, duration_ms = ?
        WHERE id = ?
    `).run(
        now, total,
        stats.tp || 0, stats.fp || 0, stats.fn || 0, stats.tn || 0, stats.errors || 0,
        durationMs, runId
    );
}

// Accumulate delta into per-store cumulative confusion matrix.
// delta: { tp, fp, fn, tn, errors, checked }
function updateStoreAccuracy(store, delta) {
    var d = getDb();
    var now = new Date().toISOString();
    var existing = d.prepare('SELECT * FROM store_accuracy WHERE store = ?').get(store);
    if (existing) {
        var tp = (existing.tp || 0) + (delta.tp || 0);
        var fp = (existing.fp || 0) + (delta.fp || 0);
        var fn = (existing.fn || 0) + (delta.fn || 0);
        var tn = (existing.tn || 0) + (delta.tn || 0);
        var errs = (existing.errors || 0) + (delta.errors || 0);
        var checked = (existing.checked || 0) + (delta.checked || 0);
        var precision = (tp + fp) > 0 ? Math.round(tp / (tp + fp) * 1000) / 10 : null;
        var recall    = (tp + fn) > 0 ? Math.round(tp / (tp + fn) * 1000) / 10 : null;
        d.prepare(`
            UPDATE store_accuracy
            SET tp=?, fp=?, fn=?, tn=?, errors=?, checked=?,
                precision_pct=?, recall_pct=?, last_updated=?
            WHERE store=?
        `).run(tp, fp, fn, tn, errs, checked, precision, recall, now, store);
    } else {
        var tp2 = delta.tp || 0, fp2 = delta.fp || 0, fn2 = delta.fn || 0;
        var precision2 = (tp2 + fp2) > 0 ? Math.round(tp2 / (tp2 + fp2) * 1000) / 10 : null;
        var recall2    = (tp2 + fn2) > 0 ? Math.round(tp2 / (tp2 + fn2) * 1000) / 10 : null;
        d.prepare(`
            INSERT INTO store_accuracy
                (store, tp, fp, fn, tn, errors, checked, precision_pct, recall_pct, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(store, tp2, fp2, fn2, delta.tn || 0, delta.errors || 0, delta.checked || 0,
               precision2, recall2, now);
    }
}

function getStoreAccuracy() {
    return getDb().prepare('SELECT * FROM store_accuracy ORDER BY store').all();
}

function getValidatorRunHistory(limit) {
    return getDb().prepare(
        'SELECT * FROM validator_runs ORDER BY started_at DESC LIMIT ?'
    ).all(limit || 20);
}

// ═══════════════════════════════════════════════════════════
// COLLECTION OPERATIONS
// ═══════════════════════════════════════════════════════════

function syncCollectionItems(userId, items) {
    var d = getDb();
    var stmt = d.prepare(`
        INSERT INTO collection
            (user_id, discogs_id, instance_id, artist, title, year, label, catno,
             thumb, genres, styles, formats, date_added, rating)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, instance_id) DO UPDATE SET
            artist=excluded.artist, title=excluded.title, year=excluded.year,
            label=excluded.label, catno=excluded.catno, thumb=excluded.thumb,
            genres=excluded.genres, styles=excluded.styles, formats=excluded.formats,
            date_added=excluded.date_added, rating=excluded.rating
    `);
    var run = d.transaction(function(rows) {
        rows.forEach(function(item) {
            stmt.run(
                userId, item.discogs_id || null, item.instance_id || null,
                item.artist || '', item.title || '',
                item.year || null, item.label || '', item.catno || '',
                item.thumb || '', item.genres || '', item.styles || '',
                item.formats || '', item.date_added || null, item.rating || 0
            );
        });
    });
    run(items);

    // Mark items that disappeared from Discogs as removed (soft delete via negative instance_id)
    // For now, just add — we don't prune (user might have removed from Discogs but we keep history)
    return items.length;
}

function getCollection(userId) {
    return getDb().prepare(
        'SELECT * FROM collection WHERE user_id = ? ORDER BY date_added DESC'
    ).all(userId);
}

function getCollectionStats(userId) {
    return getDb().prepare(`
        SELECT
            COUNT(*) AS total,
            COUNT(DISTINCT label) AS unique_labels,
            COUNT(DISTINCT artist) AS unique_artists,
            MIN(year) AS earliest_year,
            MAX(year) AS latest_year
        FROM collection WHERE user_id = ?
    `).get(userId);
}

// ═══════════════════════════════════════════════════════════
// STREAMING ACTIVITY OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Upsert a batch of streaming activity rows for a user.
 * activityTag is used to clear old rows of the same type before inserting
 * fresh data (e.g. 'top_artist_short_term', 'recent_play').
 *
 * @param {number} userId
 * @param {string} provider  - 'spotify' | 'soundcloud' | 'youtube'
 * @param {string} activityTag  - used to scope the clear (e.g. 'top_artist_short_term')
 * @param {Array}  rows
 */
function saveStreamingActivity(userId, provider, activityTag, rows) {
    if (!rows || rows.length === 0) return 0;
    var d = getDb();

    // Derive the activity_type from the tag (strip the _short/medium/long suffix for top_artist)
    var activityType = activityTag.replace(/_short_term|_medium_term|_long_term$/, '');

    // Clear stale rows for this provider+activityType combo
    d.prepare(
        'DELETE FROM user_streaming_activity WHERE user_id = ? AND provider = ? AND activity_type = ?'
    ).run(userId, provider, activityType);

    var insert = d.prepare(`
        INSERT INTO user_streaming_activity
            (user_id, provider, activity_type, artist_name, track_name, album_name,
             provider_uri, play_count, user_affinity, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    var insertMany = d.transaction(function (rowList) {
        rowList.forEach(function (row) {
            insert.run(
                row.userId || userId,
                row.provider || provider,
                row.activityType || activityType,
                row.artistName || null,
                row.trackName  || null,
                row.albumName  || null,
                row.providerUri || null,
                row.playCount != null ? row.playCount : null,
                row.userAffinity != null ? row.userAffinity : null,
                row.recordedAt || new Date().toISOString()
            );
        });
    });

    insertMany(rows);
    return rows.length;
}

/**
 * Get all streaming activity rows for a user (all providers).
 */
function getStreamingActivity(userId) {
    return getDb().prepare(
        'SELECT * FROM user_streaming_activity WHERE user_id = ? ORDER BY user_affinity DESC, recorded_at DESC'
    ).all(userId);
}

/**
 * Remove all streaming activity for a user (or optionally a single provider).
 */
function clearStreamingActivity(userId, provider) {
    if (provider) {
        getDb().prepare(
            'DELETE FROM user_streaming_activity WHERE user_id = ? AND provider = ?'
        ).run(userId, provider);
    } else {
        getDb().prepare(
            'DELETE FROM user_streaming_activity WHERE user_id = ?'
        ).run(userId);
    }
}

/**
 * Upsert streaming metadata for a Discogs release.
 */
function saveStreamingMetadata(discogsId, meta) {
    var d = getDb();
    d.prepare(`
        INSERT INTO streaming_metadata
            (discogs_id, spotify_album_uri, spotify_artist_uri, spotify_popularity,
             spotify_artist_followers, youtube_video_id, youtube_view_count, youtube_like_count,
             soundcloud_track_id, soundcloud_playback_count, soundcloud_reposts,
             soundcloud_likes, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(discogs_id) DO UPDATE SET
            spotify_album_uri        = COALESCE(excluded.spotify_album_uri,        spotify_album_uri),
            spotify_artist_uri       = COALESCE(excluded.spotify_artist_uri,       spotify_artist_uri),
            spotify_popularity       = COALESCE(excluded.spotify_popularity,       spotify_popularity),
            spotify_artist_followers = COALESCE(excluded.spotify_artist_followers, spotify_artist_followers),
            youtube_video_id         = COALESCE(excluded.youtube_video_id,         youtube_video_id),
            youtube_view_count       = COALESCE(excluded.youtube_view_count,       youtube_view_count),
            youtube_like_count       = COALESCE(excluded.youtube_like_count,       youtube_like_count),
            soundcloud_track_id      = COALESCE(excluded.soundcloud_track_id,      soundcloud_track_id),
            soundcloud_playback_count= COALESCE(excluded.soundcloud_playback_count,soundcloud_playback_count),
            soundcloud_reposts       = COALESCE(excluded.soundcloud_reposts,       soundcloud_reposts),
            soundcloud_likes         = COALESCE(excluded.soundcloud_likes,         soundcloud_likes),
            fetched_at               = excluded.fetched_at
    `).run(
        discogsId,
        meta.spotifyAlbumUri        || null,
        meta.spotifyArtistUri       || null,
        meta.spotifyPopularity      != null ? meta.spotifyPopularity      : null,
        meta.spotifyArtistFollowers != null ? meta.spotifyArtistFollowers : null,
        meta.youtubeVideoId         || null,
        meta.youtubeViewCount       != null ? meta.youtubeViewCount       : null,
        meta.youtubeLikeCount       != null ? meta.youtubeLikeCount       : null,
        meta.soundcloudTrackId      != null ? meta.soundcloudTrackId      : null,
        meta.soundcloudPlaybackCount!= null ? meta.soundcloudPlaybackCount: null,
        meta.soundcloudReposts      != null ? meta.soundcloudReposts      : null,
        meta.soundcloudLikes        != null ? meta.soundcloudLikes        : null,
        new Date().toISOString()
    );
}

/**
 * Get streaming metadata for a Discogs release.
 */
function getStreamingMetadata(discogsId) {
    return getDb().prepare(
        'SELECT * FROM streaming_metadata WHERE discogs_id = ?'
    ).get(discogsId) || null;
}

/**
 * Return a summary of streaming sync status for a user.
 */
function getStreamingSyncStatus(userId) {
    var d = getDb();
    var providers = ['spotify', 'soundcloud', 'youtube'];
    var result = {};
    providers.forEach(function (p) {
        var row = d.prepare(
            'SELECT COUNT(*) as cnt, MAX(recorded_at) as last_synced FROM user_streaming_activity WHERE user_id = ? AND provider = ?'
        ).get(userId, p);
        result[p] = { activityRows: row ? row.cnt : 0, lastSynced: row ? row.last_synced : null };
    });
    return result;
}

// ═══════════════════════════════════════════════════════════
// DISCOVER + CART
// ═══════════════════════════════════════════════════════════

/**
 * All in-stock, non-link-only items for a user, joined with Discogs price data.
 * Used by the Discover tab to build per-store cards.
 */
function getDiscoverData(userId) {
    return getDb().prepare(`
        SELECT
            sr.store,
            sr.matches,
            sr.search_url,
            w.id             AS wantlist_id,
            w.artist,
            w.title,
            w.year,
            w.label,
            w.catno,
            w.thumb,
            w.genres,
            w.styles,
            w.discogs_id,
            dp.lowest_price  AS discogs_lowest,
            dp.num_for_sale
        FROM store_results sr
        JOIN  wantlist       w  ON  w.id = sr.wantlist_id
        LEFT JOIN discogs_prices dp ON dp.wantlist_id = w.id
        WHERE w.user_id    = ?
          AND w.active     = 1
          AND sr.in_stock  = 1
          AND sr.link_only = 0
        ORDER BY sr.store, w.artist
    `).all(userId);
}

function getCartItems(userId) {
    return getDb().prepare(`
        SELECT c.id, c.wantlist_id, c.store, c.price, c.price_usd, c.added_at,
               w.artist, w.title, w.year, w.thumb, w.discogs_id
        FROM cart c
        JOIN wantlist w ON w.id = c.wantlist_id
        WHERE c.user_id = ?
        ORDER BY c.added_at DESC
    `).all(userId);
}

function addToCart(userId, wantlistId, store, price, priceUsd) {
    try {
        return getDb().prepare(`
            INSERT OR REPLACE INTO cart (user_id, wantlist_id, store, price, price_usd, added_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(userId, wantlistId, store, price || null, priceUsd || null);
    } catch(e) { return null; }
}

function removeFromCart(userId, wantlistId, store) {
    return getDb().prepare(
        'DELETE FROM cart WHERE user_id = ? AND wantlist_id = ? AND store = ?'
    ).run(userId, wantlistId, store);
}

function clearCart(userId) {
    return getDb().prepare('DELETE FROM cart WHERE user_id = ?').run(userId);
}

function getCartCount(userId) {
    return (getDb().prepare('SELECT COUNT(*) AS c FROM cart WHERE user_id = ?').get(userId) || { c: 0 }).c;
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
    getAllInStockInventory: getAllInStockInventory,
    getInventoryStats: getInventoryStats,
    upsertMarketListings: upsertMarketListings,
    getMarketListings: getMarketListings,
    clearExpiredListings: clearExpiredListings,
    getListingCacheAge: getListingCacheAge,
    getUserPreferences: getUserPreferences,
    saveUserPreferences: saveUserPreferences,
    createOptimizerJob: createOptimizerJob,
    getOptimizerJob: getOptimizerJob,
    getLatestCompletedOptimization: getLatestCompletedOptimization,
    getActiveJobForUser: getActiveJobForUser,
    getQueuePosition: getQueuePosition,
    claimNextJob: claimNextJob,
    updateJobProgress: updateJobProgress,
    completeOptimizerJob: completeOptimizerJob,
    failOptimizerJob: failOptimizerJob,
    cleanupOldOptimizerJobs: cleanupOldOptimizerJobs,
    saveDiscogsListings: saveDiscogsListings,
    getDiscogsListings: getDiscogsListings,
    getMarketplaceSyncStatus: getMarketplaceSyncStatus,
    // Observability
    startScanRun: startScanRun,
    finishScanRun: finishScanRun,
    logScraperError: logScraperError,
    getRecentScanRuns: getRecentScanRuns,
    getScanRunStats: getScanRunStats,
    getRecentStockChanges: getRecentStockChanges,
    getScraperErrorStats: getScraperErrorStats,
    startValidatorRun: startValidatorRun,
    finishValidatorRun: finishValidatorRun,
    updateStoreAccuracy: updateStoreAccuracy,
    getStoreAccuracy: getStoreAccuracy,
    getValidatorRunHistory: getValidatorRunHistory,
    close: close,
    syncCollectionItems: syncCollectionItems,
    getCollection: getCollection,
    getCollectionStats: getCollectionStats,
    // Streaming integration
    saveStreamingActivity: saveStreamingActivity,
    getStreamingActivity: getStreamingActivity,
    clearStreamingActivity: clearStreamingActivity,
    saveStreamingMetadata: saveStreamingMetadata,
    getStreamingMetadata: getStreamingMetadata,
    getStreamingSyncStatus: getStreamingSyncStatus,
    // Discover + Cart
    getDiscoverData: getDiscoverData,
    getCartItems: getCartItems,
    addToCart: addToCart,
    removeFromCart: removeFromCart,
    clearCart: clearCart,
    getCartCount: getCartCount,
};
