# Vinyl Checker — Pipeline Architecture

> **Node.js** · **SQLite (better-sqlite3)** · **Puppeteer** · **Last.fm API** · **YouTube Data API v3**
> **VPS:** 89.117.16.160 (Contabo, 12 GB RAM / 6 vCPU)
> App: PORT=5052, nginx proxy → `https://stream.ronautradio.la/vinyl/`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                       server.js                         │
│         (Express + setInterval job scheduler)           │
│                                                         │
│  Every 15 min  ──▶  Pipeline 1: Wantlist Sync           │
│  Every 3 h     ──▶  Pipeline 2: Rolling Puppeteer Scan  │
│  Every 24 h    ──▶  Pipeline 3: Catalog Sync + Match    │
│  Every 6 h     ──▶  Pipeline 4: YouTube Enrichment      │
│  Every 72 h    ──▶  Pipeline 5: Songstats Enrichment    │
│  Every 4 h     ──▶  Pipeline 6: Stock Validator         │
│  On-demand     ──▶  Pipeline 7: Discovery / Recommender │
└─────────────────────────────────────────────────────────┘
              │
              ▼
        vinyl-checker.db  (SQLite, WAL)
              │
              ▼
     public/js/app.js  (SPA, no framework)
```

---

## Pipeline 1 — Wantlist & Collection Sync

**Frequency:** Every 15 minutes per user (incremental diff)
**Source:** Discogs API · **Writes:** `wantlist`, `collection`, `users`

```mermaid
flowchart TD
    A([Timer: 15 min]) --> B[backgroundSync]
    B --> C{Users due\nfor sync?}
    C -- No --> Z([Done])
    C -- Yes --> D[GET /users/:u/wants\nDiscogs API paginated]
    D --> E[syncWantlistItems]
    E --> F{Diff incoming\nvs existing}
    F --> G[INSERT new items\nlast_puppeteer_check_at = NULL]
    F --> H[SET active=0\nfor removed items]
    F --> I[UPDATE existing\nartist/title/catno/thumb]
    G & H & I --> J[users.last_sync = now]
    J --> K[GET /users/:u/collection\nDiscogs API]
    K --> L[syncCollectionItems\nUPSERT collection]
    L --> M[Trigger meta-sync\nfor new discogs_ids]
    M --> Z
```

**Key behaviour:**
- New wantlist items get `last_puppeteer_check_at = NULL` → immediately queued for rolling scan
- Removed items are soft-deleted (`active = 0`), store_results retained for history
- Meta-sync runs inline: fetches `release_meta` (have/want/rating) + extracts Discogs video IDs

---

## Pipeline 2 — Rolling Puppeteer Scan

**Frequency:** Every 3 h (ROLLING_INTERVAL env var)
**Stores:** Deejay.de · Juno · Hardwax · Yoyaku (live Puppeteer scrapers)
**Writes:** `store_results`, `wantlist.last_puppeteer_check_at`, `scan_changes`

```mermaid
flowchart TD
    A([Timer: 3 h]) --> B{_chromeLock?}
    B -- Yes --> Z([Skip: Chrome busy])
    B -- No --> C[Set _chromeLock = true]
    C --> D[puppeteer.launch\n1–2 worker sets × 7 pages]

    D --> E[Phase A: URGENT]
    E --> F[getNewWantlistItems\nNULL last_puppeteer_check_at]
    F --> G{Any NULL items?}
    G -- No --> H[Phase B: ROUTINE]
    G -- Yes --> I[Check ALL NULL items\nacross all users\n— no cap —]
    I --> J[checkDeejay + checkJuno\n+ checkHardwax + checkYoyaku\nin parallel per item]
    J --> K[saveStoreResults\nstampPuppeteerCheck\ndetectChanges]
    K --> H

    H --> L[getOldestCheckedItems\nup to ROLLING_BATCH per user]
    L --> M[Check oldest-checked items\nDeejay + Juno + Hardwax + Yoyaku]
    M --> N[saveStoreResults\nstampPuppeteerCheck\ndetectChanges]
    N --> O[browser.close\nclean tmp dir]
    O --> P[_chromeLock = false]
    P --> Q[trackJobRun: 'rolling']
    Q --> Z2([Done])

    K --> |scan_changes| SC[(scan_changes)]
    N --> |scan_changes| SC
```

### FIFO Priority Queue

```mermaid
flowchart LR
    A[Discogs adds\nnew record] --> B[wantlist row\nlast_puppeteer_check_at = NULL]
    B --> C[Phase A: checked\nin next 3h run\n— unconditional —]

    D[Existing records\nlast checked 7d ago] --> E[Phase B: routine\noldest-first fill\nup to ROLLING_BATCH]

    F[Records checked\nyesterday] --> G[Phase B: queued but\nmay not fit this run\n— fine, checked recently]
```

**Resource usage at current settings (ROLLING_WORKERS=1):**
- 1 Chrome browser · 7 idle tabs · 4 active scrapers per item pair
- RAM: ~200–350 MB · CPU: burst on navigation, idle between items
- Available: 10+ GB free on VPS → bump ROLLING_WORKERS=2 for 2× throughput

---

## Pipeline 3 — Catalog Sync + Catalog Match

**Frequency:** Every 24 h (DAILY_CHECK_INTERVAL)
**Stores:** Further Records · Octopus Records NYC · Gramaphone · Underground Vinyl (Shopify)
**Writes:** `store_inventory`, `store_sync_log`, `store_results`, `users.last_catalog_match_at`

```mermaid
flowchart TD
    A([Timer: 24 h]) --> B[syncStaleStores]
    B --> C[For each catalog store\nwhere last_synced_at > 24h ago]
    C --> D[Fetch /products.json\npaginated Shopify API\nor store-specific API]
    D --> E[parseInventoryPage\nextract artist/title/label/catno/tags/price]
    E --> F[UPSERT store_inventory\nmark unavailable = 0 if gone]
    F --> G[INSERT store_sync_log]
    G --> H[runCatalogMatch]

    H --> I[getAllActiveUsers]
    I --> J[For each user: getActiveWantlist]
    J --> K[For each wantlist item:\ncheckFurther / checkGramaphone\n/ checkOctopus / checkUVS]
    K --> L{Match found\nin store_inventory?}
    L -- Yes --> M[saveStoreResult\nin_stock = 1]
    L -- No --> N[saveStoreResult\nin_stock = 0]
    M & N --> O[detectChanges\nnow_in_stock / out_of_stock]
    O --> P[stampCatalogMatch\nusers.last_catalog_match_at = now]
    P --> Z([Done])

    D --> |on error| E2[log error\nskip store]
    E2 --> Z
```

**Key difference from Puppeteer scan:** Zero Chrome — pure SQLite lookups. Runs 1,614 items × 4 stores in ~10 seconds.

---

## Pipeline 4 — YouTube Enrichment

**Frequency:** Every 6 h · **Quota:** 7 API keys, ~80 calls/key/day
**Writes:** `streaming_metadata` (video_id, view/like/comment counts, comment_data JSON)

```mermaid
flowchart TD
    A([Timer: 6 h]) --> B[Get wantlist items\nwhere youtube_enriched_at IS NULL\nor older than 30 days]

    B --> C[Source 1: Discogs video extraction\nFREE — zero quota]
    C --> D{discogs_id has\nvideos[] in release?}
    D -- Yes --> E[Extract YouTube ID\nfrom Discogs video URL]
    D -- No --> F[Source 2: YouTube Search API\n100 units/search · 90 calls/key/day]
    E --> G[Validate ID format]
    F --> G

    G --> H[Batch stats: videos.list\n50 IDs per call = 1 unit\nview_count, like_count, comment_count]
    H --> I[commentThreads API\n1 unit per video\nTop 20 comments]
    I --> J[parseComments\nextract genres / DJs / era / sounds_like]
    J --> K[UPDATE streaming_metadata\nyoutube_enriched_at = now]

    K --> L[gemScore.scoreRelease\ncomputed on read\nnot stored]

    style C fill:#d4edda
    style F fill:#fff3cd
```

### Gem Score Formula (on-read, not stored)

```mermaid
flowchart LR
    A[streaming_metadata\n+ release_meta] --> B[gemScore.scoreRelease]
    B --> C[obscurity 35%\ninverse log view_count]
    B --> D[engagement 25%\ncomment_rate × 60%\nlike_rate × 40%]
    B --> E[djSignal 20%\nunique DJ mentions\nin comments]
    B --> F[rarity 15%\nwant/have ratio\nDiscogs community]
    B --> G[genreDepth 5%\nrichness of\ncomment genres]
    C & D & E & F & G --> H[blended score 0–100]
    H --> I{Tier}
    I --> J[💎 hidden_gem\nobscurity≥70 + score≥52]
    I --> K[🔥 club_weapon\ndjSignal≥40]
    I --> L[🎯 deep_cut\nscore≥48]
    I --> M[known_quantity]
    I --> N[unscored]
```

---

## Pipeline 5 — Discovery / Recommender

**Trigger:** On-demand GET `/api/discovery/:username`
**Sources:** `wantlist` · `oauth_tokens` (SoundCloud, YouTube) · Last.fm API · `store_inventory`
**Returns:** Ranked recommendations with `because` (seed artists), `blendedScore`, `genreProfile`

```mermaid
flowchart TD
    A([GET /api/discovery/:username]) --> B[Load seed artists\nfrom wantlist\nDISTINCT artist, RANDOM, LIMIT 30]

    B --> C[Merge SoundCloud seeds\noauth_tokens.provider_username\nweightedArtists JSON\nsetlist=4, liked=2, following=1]
    C --> D[Merge YouTube seeds\nliked videos + subscriptions\nweight=2]
    D --> E[Sort by weight DESC\nfinal weighted seed list]

    E --> F[Build genre taste profile\nfrom wantlist genres + styles\nnormalised frequency map]

    E --> G[Last.fm expandSeeds\nartist.getSimilar per seed\n× similarPerSeed results]
    G --> H[Score map\nsum similarity × seed weight\nacross all seeds]

    F & H --> I[Top 80 candidate artists\nsorted by seedCount then score]

    I --> J[Cross-reference store_inventory\nartist match\navailable = 1]

    J --> K[For each inventory match:\ncompute tagScore\ntag overlap vs genreFreq map]

    K --> L[blendedScore\n60% Last.fm sim × seedCount\n+ 40% tagScore]

    L --> M[Sort: seedCount DESC\nthen blendedScore DESC]
    M --> N[Return top 40 recs\n+ seeds used\n+ genreProfile top 15]

    style G fill:#fff3cd
    style F fill:#d4edda
```

---

## Pipeline 6 — "What's New Since You Left"

**Trigger:** User opens the app (GET `/api/changes/:username`)
**Writes:** `users.last_seen_at`

```mermaid
sequenceDiagram
    participant Browser
    participant Server
    participant DB

    Note over Browser: User opens app
    Browser->>Server: GET /api/changes/:username
    Server->>DB: SELECT user.last_seen_at
    DB-->>Server: e.g. "2026-04-28T18:00:00Z"
    Server->>DB: SELECT scan_changes WHERE detected_at > last_seen_at AND dismissed=0
    DB-->>Server: [{ change_type, store, artist, title, old_value, new_value }]
    Server-->>Browser: { changes, since, lastSeenAt }

    alt changes.length > 0
        Browser->>Browser: showChangesBanner(changes)
    end

    Note over Browser: After fetching (always)
    Browser->>Server: POST /api/changes/seen { username }
    Server->>DB: UPDATE users SET last_seen_at = now()
    DB-->>Server: ok
    Server-->>Browser: { ok: true, lastSeenAt }

    Note over Browser: Next visit only shows\nchanges since THIS moment
```

**Change types detected by `detectChanges()` in scanner.js:**

| `change_type` | Trigger |
|---|---|
| `now_in_stock` | `in_stock` flipped 0 → 1 |
| `out_of_stock` | `in_stock` flipped 1 → 0 |
| `price_drop` | Price decreased ≥ 5% |
| `price_increase` | Price increased ≥ 5% |

---

## Pipeline 7 — Stock Validator

**Frequency:** Every 4 h · **Purpose:** Re-verify items currently marked `in_stock=1`

```mermaid
flowchart TD
    A([Timer: 4 h]) --> B{_chromeLock?}
    B -- Yes --> Z([Skip])
    B -- No --> C[Get all store_results\nwhere in_stock = 1]
    C --> D[Group by store]
    D --> E[For each store:\nre-run live scraper\nsame query as original scan]
    E --> F{Still in stock?}
    F -- Yes --> G[TP: correct positive\nupdate checked_at]
    F -- No --> H[FP: false positive\nset in_stock = 0\ndetectChanges out_of_stock]
    G & H --> I[UPDATE store_accuracy\ntp/fp/fn/tn/precision/recall]
    I --> J[INSERT validator_runs\nconfusion matrix aggregate]
    J --> Z2([Done])
```

---

## setInterval Schedule (server.js)

| Job | Interval | Env override | Notes |
|---|---|---|---|
| Wantlist sync | 15 min | `SYNC_INTERVAL` | Incremental diff |
| Rolling Puppeteer scan | 3 h | `ROLLING_INTERVAL` | Phase A (urgent) + Phase B (routine) |
| Catalog sync + match | 24 h | `DAILY_CHECK_INTERVAL` | No Chrome — pure SQLite |
| YouTube enrichment | 6 h | — | Quota-gated, 7 keys |
| Songstats enrichment | 72 h | — | 20 tracks/run |
| Stock validator | 4 h | — | Chrome, re-checks in_stock=1 |
| Meta-sync | inline | — | Piggybacks on wantlist sync |

**Startup sequence (after 5 min delay):**
1. Rolling Puppeteer scan (first batch)
2. Catalog sync → runCatalogMatch
3. YouTube enrichment pass

---

## Scaling Levers

| Lever | Current | Max (12 GB VPS) | How |
|---|---|---|---|
| ROLLING_WORKERS | 1 | 3 | `ROLLING_WORKERS=2` in env → 2 Chrome worker sets, check 2 items simultaneously |
| ROLLING_BATCH | 50/user/run | 150 | `ROLLING_BATCH=100` in env |
| ROLLING_INTERVAL | 3 h | 1 h | `ROLLING_INTERVAL=3600000` in env |
| Catalog stores | 4 | 4 | All Shopify-API stores already wired |
| Rolling scan stores | 4 | 6 | Add Decks.de (pages[5]) + Tracks & Layers (pages[4]) |
| seedLimit (discovery) | 30 seeds | 80 | `?seeds=60` query param |

**Effective cycle time** with ROLLING_WORKERS=2, ROLLING_BATCH=100, ROLLING_INTERVAL=3h:
- 6 users × 100 items × 3h = ~600 items/3h → full 1,614-item wantlist cycled every ~8 hours
