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

Some US stores (starting with **Gramaphone Records** in Chicago) ship their full
catalog through a public Shopify `/products.json` endpoint. For these we mirror
the catalog into a local SQLite table once a day and match wantlist items
against it in-process. Benefits:

- **Fast** — checking 200 wantlist items against Gramaphone's ~6,000 records
  takes well under a second (no per-item HTTP, no Puppeteer page).
- **Reliable** — no flaky DOM scraping, no Cloudflare/Sucuri challenges.
- **Discovery-ready** — the synced `store_inventory` table is the foundation
  for "what new records did Gramaphone add this week from labels I love?".

### Architecture

```
┌─────────────────────┐    once per day    ┌──────────────────────┐
│  Shopify storefront │ ─────────────────▶ │  store_inventory     │
│  /products.json     │   (paginated)      │  (SQLite, ~6k rows)  │
└─────────────────────┘                    └──────────┬───────────┘
                                                      │ per scan
                                                      ▼
                                           ┌──────────────────────┐
                                           │  checkGramaphone()   │
                                           │  (fuzzy match local) │
                                           └──────────────────────┘
```

### Sync triggers

| Trigger             | When                                                          |
|---------------------|---------------------------------------------------------------|
| Auto (server)       | Piggybacks on the 15-min daily-rescan loop. Re-syncs if last sync was 20+ hours ago. |
| Cron / one-off CLI  | `node sync-store.js gramaphone`                               |
| Admin HTTP endpoint | `POST /api/admin/sync-store?secret=$CRON_SECRET&store=gramaphone` |

### Adding another US Shopify store

1. Verify the store exposes `/products.json` (most do — try
   `curl -s https://STORE.com/products.json?limit=1`).
2. Add a thin module under `lib/stores/<store>.js` that exports
   `sync<Store>()` and `check<Store>()`. Use `lib/stores/shopify.js` for the
   pagination + parsing primitives. Provide a store-specific `parseLabel`
   function that knows the conventions in that store's `body_html`.
3. Register the sync in `server.js` `STORE_SYNCERS` and the check in
   `lib/scrapers.js` `checkItem()`.
4. Add the CLI entry in `sync-store.js`.

That pattern will cover **Underground Vinyl Source**, **Further Records**,
**Octopus Records**, and most other US independent stores on Shopify.

## 📄 License

MIT - Use however you want!
