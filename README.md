# 🎵 Discogs Vinyl Wantlist Checker

Automatically check if your Discogs wantlist items are in stock at:

**EU stores (per-item scrape):**
- **Phonica Records** (London) — HTTP API
- **Deejay.de** (Berlin)
- **HHV** (Berlin)
- **Hardwax** (Berlin)
- **Juno** (London)
- **Decks.de** (Germany)
- **Yoyaku** (Paris)

**US stores (per-item scrape):**
- **Turntable Lab** (NYC)
- **Underground Vinyl Source** (LA)

**US stores (catalog mirror — fast local match):**
- **Gramaphone Records** (Chicago) — full ~6k catalog synced daily, matched in-process
- **Further Records** (Seattle) — ~25k catalog (caps at Shopify's 25k offset limit) synced daily, matched in-process
- **Octopus Records NYC** (Brooklyn) — full ~6k catalog synced daily via WooCommerce API, matched in-process

## ✨ Features

- ✅ Fetches your entire Discogs wantlist (all pages)
- ✅ Smart fuzzy matching (handles represses, artist name variations)
- ✅ Ignores year differences (catches represses/reissues)
- ✅ Real browser automation for accurate results
- ✅ Saves results to JSON file
- ✅ Run on-demand whenever you want

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

This will install Puppeteer (headless Chrome browser).

### 2. Run the Checker

```bash
node vinyl-checker-puppeteer.js osolakli
```

Replace `osolakli` with your Discogs username.

### 3. View Results

The script will:
- Show progress in the terminal
- Print in-stock items at the end
- Save full results to `results.json`

## 📋 Example Output

```
🎵 Fetching wantlist for osolakli...
✓ Loaded 274 items

🔍 Checking stores...

Checking 274/274: Artist Name - Track Title

================================================================================

🎉 Found 12 items in stock!

📀 Floating Points - Crush (2019)
   Ninja Tune ZEN12345
   ✓ Phonica: 1 matches found
     - Crush €24.99
     https://www.phonicarecords.com/search?q=Floating+Points+Crush
   ✓ HHV: 1 matches found
     - Crush (2023 Repress) €22.50
     https://www.hhv.de/shop/en/search?query=Floating+Points+Crush

================================================================================
```

## 🎯 Smart Matching

The checker uses fuzzy matching to handle:

### Artist Name Variations
- "The Beatles" matches "Beatles"
- "Boards Of Canada" matches "Boards of Canada"

### Title Variations
- Minor spelling differences
- Extra words in reissues

### Year Differences (IGNORED)
- Original: 2019
- Repress: 2023
- ✅ Will still match!

## ⚙️ Configuration

Edit the matching threshold in `vinyl-checker-puppeteer.js`:

```javascript
function recordsMatch(wanted, found, threshold = 0.7) {
  // Lower = more lenient (more matches)
  // Higher = more strict (fewer matches)
}
```

## 📊 Results File

`results.json` contains:
```json
[
  {
    "item": {
      "artist": "Artist Name",
      "title": "Track Title",
      "year": 2019,
      "label": "Label Name",
      "catno": "CAT123"
    },
    "stores": [
      {
        "store": "Phonica",
        "inStock": true,
        "matches": [
          {
            "artist": "Artist Name",
            "title": "Track Title",
            "price": "€24.99"
          }
        ],
        "searchUrl": "https://..."
      }
    ]
  }
]
```

## 🔄 Running Regularly

### Option 1: Manual (Recommended)
Just run when you want to check:
```bash
npm run check
```

### Option 2: Cron Job (Daily)
Add to your crontab:
```bash
0 9 * * * cd /path/to/vinyl-checker && node vinyl-checker-puppeteer.js osolakli
```

### Option 3: Email Notifications
Modify the script to send an email when items are found (requires nodemailer).

## 🐛 Troubleshooting

### "Puppeteer failed to launch"
Install Chrome dependencies:
```bash
# Ubuntu/Debian
sudo apt-get install -y chromium-browser

# macOS
brew install chromium
```

### Too slow?
The script waits 2 seconds between each item to avoid rate limiting. You can reduce this in the code:
```javascript
await new Promise(resolve => setTimeout(resolve, 2000)); // Change to 1000
```

### No matches found
- Try lowering the matching threshold
- Check if your wantlist is public on Discogs
- Verify store websites are accessible

## 📝 Notes

- **Rate Limiting**: The script includes delays to be respectful to the stores
- **Accuracy**: Store HTML structures may change - update selectors if needed
- **Privacy**: Your Discogs wantlist must be public
- **Legal**: This is for personal use only

## 🛠️ Advanced: Updating Store Selectors

If a store changes their website structure, update the selectors in the check functions:

```javascript
async function checkPhonica(page, item) {
  const products = await page.evaluate(() => {
    document.querySelectorAll('.product-item') // <- Update this
  });
}
```

## 🇺🇸 Catalog-Mirror Stores (Sync + Local Match)

Several US stores expose their full catalog through a public API. We mirror
the catalog into a local SQLite table once a day and match wantlist items
against it in-process. Currently:

| Store | Platform | Catalog size | Notes |
|---|---|---|---|
| **Gramaphone Records** (Chicago) | Shopify | ~6k | `/products.json` |
| **Further Records** (Seattle) | Shopify | ~25k | Hits Shopify's 25k offset cap |
| **Octopus Records NYC** (Brooklyn) | WooCommerce | ~6k | `/wp-json/wc/store/v1/products` |

Benefits over per-item Puppeteer scraping:

- **Fast** — checking 200 wantlist items against 35k+ local rows takes
  well under a second (no per-item HTTP, no browser page).
- **Reliable** — no flaky DOM scraping, no Cloudflare/Sucuri challenges.
- **Discovery-ready** — the synced `store_inventory` table is the foundation
  for "what new records did these stores add this week from labels I love?".

### Catno-first matching

Catalog numbers are globally unique identifiers printed on every release
sleeve. They're by far the strongest matching signal — stronger than fuzzy
artist+title similarity (which can fail on punctuation variants, "and" vs
"&", missing EP suffixes, etc).

`lib/scrapers.js` now ships a shared `matchInventoryRow(wanted, row)` helper
used by all three catalog-mirror stores:

1. **Catno match** — normalise both sides to `[a-z0-9]+` and compare. If
   both sides have ≥3 chars and they match, accept immediately.
2. **Artist+title fuzzy** — existing bigram similarity for rows with both
   fields structured.
3. **Combined-title fallback** — for rows where artist isn't available
   (Octopus shape).

This means matching a wantlist entry with catno `MSNLP005` against
Octopus's row for "The Place Where We Live" (sku `MSNLP005`) is a
definitive hit even though Octopus doesn't store the artist name.

### Architecture

```
┌──────────────────────┐    once per day    ┌──────────────────────┐
│  Shopify storefront  │ ─────────────────▶ │  store_inventory     │
│  /products.json      │   (paginated)      │  (SQLite, ~35k rows) │
└──────────────────────┘                    └──────────┬───────────┘
                                                       │
┌──────────────────────┐    once per day               │
│  WooCommerce Store   │ ─────────────────▶            │
│  /wc/store/v1/prods  │   (paginated)                 │
└──────────────────────┘                               │ per scan
                                                       ▼
                                           ┌──────────────────────┐
                                           │  checkGramaphone()   │
                                           │  checkFurther()      │
                                           │  checkOctopus()      │
                                           │  matchInventoryRow() │
                                           └──────────────────────┘
```

### Sync triggers

| Trigger             | When                                                              |
|---------------------|-------------------------------------------------------------------|
| Auto (server)       | Piggybacks on the 15-min daily-rescan loop. Re-syncs each store if its last sync was 20+ hours ago. |
| Cron / one-off CLI  | `node sync-store.js gramaphone` · `node sync-store.js further` · `node sync-store.js octopus` |
| Admin HTTP endpoint | `POST /api/admin/sync-store?secret=$CRON_SECRET&store=<name>`     |

### Per-store description parsing

Each store formats its product description differently:

- **Gramaphone** — prose like `Label: Rush Hour – RH-StoreJams031 Format: ...`
  Regex anchored on the next field keyword.
- **Further** — mostly structured `Field: value` pairs (`Artist:`, `Title:`,
  `Label:`, `Catalog:`), handled via `shopify.parseStructuredFields()`. ~30%
  of the catalog uses a free-form layout; both shapes are parsed.
- **Octopus** — WooCommerce. No artist field (title only). First `<p>` of
  every description is `"YEAR[qualifier], FORMAT, LABEL."` — label extracted
  by regex. Artist matching relies entirely on catno-first logic.

### Adding another US Shopify store

1. Verify `/products.json` is public (`curl -s https://STORE.com/products.json?limit=1`).
2. Inspect a few `body_html` samples to learn the label/catno convention.
   Reuse `shopify.parseStructuredFields()` for `Field: value` layouts;
   otherwise write a regex anchored on a stable terminator (year, next field).
3. Add `lib/stores/<store>.js` exporting `sync<Store>()` and `check<Store>()`.
4. Register in `server.js` `STORE_SYNCERS`, `lib/scrapers.js` `checkItem()`,
   and `sync-store.js`.
5. Add parser tests under `test/<store>.test.js` and wire into `npm test`.

### Adding another US WooCommerce store

Same pattern as Octopus, but use `lib/stores/woocommerce.js` instead of
`lib/stores/shopify.js` for pagination and `parseWcProduct()`. WooCommerce
stores typically don't expose artist as a structured field — lean on
catno-first matching and title-only fuzzy for the remainder.

## 📄 License

MIT - Use however you want!
