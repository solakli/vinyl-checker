# Vinyl Checker

Find your Discogs wantlist in stock across 12 vinyl stores worldwide. Runs as a hosted web app on a VPS with daily automated syncing, background validation, and a real-time SSE scan stream.

---

## Stores

### EU — per-item browser scrape
| Store | City |
|---|---|
| HHV | Berlin |
| Deejay.de | Berlin |
| Hardwax | Berlin |
| Juno | London |
| Phonica | London |
| Decks.de | Germany |
| Yoyaku | Paris |

### US — per-item browser scrape
| Store | City |
|---|---|
| Turntable Lab | NYC |
| Underground Vinyl Source | LA |

### US — catalog mirror (Shopify / WooCommerce)
Full catalogs synced daily into SQLite. Per-scan matching is pure in-process — no HTTP, no browser.

| Store | City | Platform | Catalog |
|---|---|---|---|
| Gramaphone Records | Chicago | Shopify | ~6k |
| Further Records | Seattle | Shopify | ~25k (hits Shopify 25k cap) |
| Octopus Records NYC | Brooklyn | WooCommerce | ~6k |

---

## Architecture

```
Discogs OAuth
      │
      ▼
  wantlist table (SQLite)
      │
      ├──▶  Per-item scan (Puppeteer × 9 stores, parallel batches)
      │
      ├──▶  Catalog-mirror stores (checkGramaphone / checkFurther / checkOctopus)
      │     └── matchInventoryRow() — catno-first, then artist+title fuzzy
      │
      └──▶  store_results table
                  │
                  └──▶  Background validator (Puppeteer re-checks in/out of stock,
                         excludes catalog-mirror stores — they self-validate via daily sync)
```

### Catalog-mirror sync pipeline
```
Shopify /products.json   ──┐
WooCommerce /wc/store/v1 ──┤  once per day (sequential, 5s gap between stores)
                            ▼
                    store_inventory (SQLite)
                            │
                    matchInventoryRow() — called per-scan for each wantlist item
```

Sync triggers:
- **Auto** — piggybacks on the 15-min daily-rescan scheduler tick; re-syncs each store if last sync was 20+ hours ago
- **CLI** — `node sync-store.js <gramaphone|further|octopus|uvs>`
- **HTTP** — `POST /api/admin/sync-store?secret=CRON_SECRET&store=<name>`

### Matching — catno-first

`matchInventoryRow(wanted, row)` in `lib/scrapers.js`, shared by all catalog-mirror stores:

1. **Catno match** — strip both to `[a-z0-9]+`, compare. If both ≥3 chars and equal → definitive hit.
2. **Artist + title fuzzy** — bigram similarity ≥ 0.75 (structured rows with both fields)
3. **Combined-title fallback** — for stores like Octopus that don't expose artist (title-only rows)

### Rate-limit handling (Shopify)

`shopify.fetchAllProducts()` retries on 429 and 503 up to 3 times, honouring `Retry-After`. Per-page delay: 500ms (Gramaphone/UVS) to 750ms (Further). Stores sync sequentially (not in parallel) to avoid shared-IP rate limiting at Shopify's CDN edge.

---

## Key Files

```
server.js                   Express app, API endpoints, background schedulers
db.js                       SQLite schema + all DB helpers (better-sqlite3)
lib/
  scrapers.js               Per-item scan orchestration, shared matchers
  scanner.js                Background jobs: daily rescan, Puppeteer validator
  stores/
    shopify.js              Generic Shopify paginator + product parser
    woocommerce.js          Generic WooCommerce paginator + product parser
    gramaphone.js           Gramaphone Records (Chicago, Shopify)
    further.js              Further Records (Seattle, Shopify)
    octopus.js              Octopus Records NYC (WooCommerce)
    uvs.js                  Underground Vinyl Source (LA, Shopify)
sync-store.js               CLI tool: node sync-store.js <store>
public/
  index.html                Frontend SPA
  js/app.js                 UI logic (SSE stream, store filters, modals)
  css/style.css             Dark/light theme, per-store color vars
test/
  gramaphone.test.js        Parser + matcher tests
  further.test.js           Further dual-mode parser tests (30 cases)
  octopus.test.js           WooCommerce parser tests (42 cases)
  matcher.test.js           matchInventoryRow() shared matcher tests (19 cases)
```

---

## Adding Another Store

### Shopify store
1. Verify public catalog: `curl -s https://STORE.com/products.json?limit=1`
2. Inspect `body_html` on a few products — find label/catno convention
3. Create `lib/stores/<store>.js` — copy `gramaphone.js` or `further.js` as template
4. Register in `server.js` `STORE_SYNCERS`, `lib/scrapers.js` `checkItem()`, `sync-store.js`
5. Add to `CATALOG_STORES` exclusion list in `lib/scanner.js` (validator)
6. Add logo to `public/img/`, update `storeLogoMap` / `storeClassMap` / `storeDisplayName` in `app.js`, add badge to `index.html`

### WooCommerce store
Same pattern but use `lib/stores/woocommerce.js` as the pagination layer. WooCommerce typically doesn't expose artist as a structured field — catno-first matching covers most cases.

---

## Deployment

VPS: Contabo Ubuntu 22.04, behind nginx at `stream.ronautradio.la/vinyl/`

```bash
# First deploy
git clone https://github.com/solakli/vinyl-checker
cd vinyl-checker && npm install
cp ecosystem.config.js.example ecosystem.config.js   # fill in secrets
pm2 start ecosystem.config.js
pm2 save

# Updates (also triggered automatically via GitHub webhook → /api/deploy)
git pull && npm install && pm2 reload vinyl-checker
```

Environment variables (set in `ecosystem.config.js` env block):
```
PORT=5052
DISCOGS_CONSUMER_KEY
DISCOGS_CONSUMER_SECRET
SESSION_SECRET
CRON_SECRET
GITHUB_WEBHOOK_SECRET
```

---

## Running Tests

```bash
npm test
```

Runs all four test suites (gramaphone, further, octopus, matcher) with Node — no Jest required.

---

## Roadmap

### Phase I — Multi-store wantlist checker (complete)
- 12 stores across EU + US
- Discogs OAuth — works with private wantlists
- Catalog-mirror architecture for US Shopify/WooCommerce stores (fast, no-scrape matching)
- Catno-first shared matcher (`matchInventoryRow`)
- Daily automated wantlist sync + background store resync
- Puppeteer validator (detects stale in-stock / false negatives)
- VPS deployment: PM2 + nginx reverse proxy + GitHub webhook auto-deploy
- Dark/light theme, per-store filter, style tags, shareable wantlist links

### Phase II — Smart Cart Builder (in progress, PR #4)
Given your wantlist, find the optimal combination of Discogs sellers + catalog-mirror stores that covers the most records at the lowest total cost — counting shipping once per seller, not per record.

**How it works:**
1. For each wantlist item, scrape the Discogs marketplace for available listings (seller, condition, price, ships-from)
2. Run a greedy set-cover optimizer — picks the seller with the lowest marginal cost per uncovered item, iterates until all items are covered or no sellers remain
3. Returns ranked cart suggestions: "Buy 7 records from seller A ($84 + $8 shipping) and 3 from seller B ($41 + $5 shipping)"

**Architecture note:** The Discogs marketplace page is behind Cloudflare bot protection — scraping requires a residential IP. The cart builder therefore runs on a local machine (Mac mini / laptop) rather than on the VPS. The rest of the stack (store sync, wantlist management, UI) stays on the VPS as normal.

**Stack:** `lib/discogs-market.js` (Playwright + stealth), `lib/optimizer.js` (greedy facility-location), `lib/optimizer-worker.js` (job queue), `lib/shipping-rates.js` (flat-rate estimates by country)

**What's left:**
- Remote worker mode — Mac mini polls VPS for pending optimizer jobs, runs scrape locally, POSTs results back (so hosted UI can show cart results without needing to run locally)
- Add Puppeteer-scraped stores (HHV, Deejay.de, Hardwax, Juno, Phonica) to the source pool via `store_results`
- Expose `forceRefresh` in the UI to bypass the 6-hour listing cache
- Stuck-job recovery (timeout jobs stuck in `processing` after a server crash)

### Phase III — Ideas
- **Price alerts** — notify when a wantlist item drops below a target price on Discogs
- **New arrivals feed** — "these 3 labels you buy from restocked at Gramaphone this week"
- **More stores** — any Shopify or WooCommerce store with a public catalog endpoint can be added in ~2 hours (see Adding Another Store above)
- **Mobile PWA** — installable web app with push notifications for in-stock alerts

---

## License

MIT
