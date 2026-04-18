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

Several US stores ship their full catalog through a public Shopify
`/products.json` endpoint. For these we mirror the catalog into a local SQLite
table once a day and match wantlist items against it in-process. Currently:

- **Gramaphone Records** (Chicago) — ~6,000 products
- **Further Records** (Seattle) — ~25,000 products (Shopify hard-caps the
  unauthenticated offset at 25,000)

Benefits over per-item Puppeteer scraping:

- **Fast** — checking 200 wantlist items against the 25k+30k local rows takes
  well under a second (no per-item HTTP, no browser page).
- **Reliable** — no flaky DOM scraping, no Cloudflare/Sucuri challenges.
- **Discovery-ready** — the synced `store_inventory` table is the foundation
  for "what new records did these stores add this week from labels I love?".

### Architecture

```
┌─────────────────────┐    once per day    ┌──────────────────────┐
│  Shopify storefront │ ─────────────────▶ │  store_inventory     │
│  /products.json     │   (paginated)      │  (SQLite, ~30k rows) │
└─────────────────────┘                    └──────────┬───────────┘
                                                      │ per scan
                                                      ▼
                                           ┌──────────────────────┐
                                           │  checkGramaphone()   │
                                           │  checkFurther()      │
                                           │  (fuzzy match local) │
                                           └──────────────────────┘
```

### Sync triggers

| Trigger             | When                                                              |
|---------------------|-------------------------------------------------------------------|
| Auto (server)       | Piggybacks on the 15-min daily-rescan loop. Re-syncs each store if its last sync was 20+ hours ago. |
| Cron / one-off CLI  | `node sync-store.js gramaphone` &nbsp;·&nbsp; `node sync-store.js further` |
| Admin HTTP endpoint | `POST /api/admin/sync-store?secret=$CRON_SECRET&store=<name>`     |

### Per-store body_html parsing

Each Shopify store formats its product description differently, so each
`lib/stores/<store>.js` provides its own `parseLabel` (and optionally
`parseArtistTitle`) callback that the generic `lib/stores/shopify.js`
`parseShopifyProduct` calls.

- **Gramaphone** uses prose like `Label: Rush Hour – RH-StoreJams031 Format: ...`
  and has its parser anchor on the next field keyword (Format, Released, etc.)
  to bound the catno cleanly.
- **Further** mostly uses structured `Field: value` pairs (`Artist:`, `Title:`,
  `Label:`, `Catalog:`, `Format:`) — handled with the generic
  `shopify.parseStructuredFields(text, fieldNames)` helper. About 30% of the
  catalog (the curated picks) instead use a free-form layout
  `<title> (<format>) <Label> - <CATNO> <YEAR> <genres> <tracklist>`; both
  shapes are parsed.

### Adding another US Shopify store

1. Verify the store exposes `/products.json` (most do — try
   `curl -s https://STORE.com/products.json?limit=1`).
2. Inspect a few `body_html` samples to learn the label/catno convention.
   If they use `Field: value` lines, you can reuse
   `shopify.parseStructuredFields`. Otherwise write a regex anchored on a
   stable terminator (e.g. a 4-digit year, or the next known field keyword).
3. Add a thin module under `lib/stores/<store>.js` that exports
   `sync<Store>()` and `check<Store>()`. Use `lib/stores/shopify.js` for
   pagination + parsing primitives.
4. Register the sync in `server.js` `STORE_SYNCERS`, the check in
   `lib/scrapers.js` `checkItem()`, and the CLI in `sync-store.js`.
5. Add a parser test under `test/<store>.test.js` and wire it into the
   `npm test` script in `package.json`.

That pattern covers **Underground Vinyl Source** and most other US
independent stores on Shopify. Stores on custom CMSes (e.g. **Octopus Records
NYC** runs on Wix, not Shopify) need the per-item Puppeteer pattern instead.

## 📄 License

MIT - Use however you want!
