# Vinyl Checker

A self-hosted web app that checks your Discogs wantlist across 12 vinyl stores worldwide and finds the cheapest combination of sellers to buy everything — shipping included.

---

## What it does

1. **Wantlist scanning** — connect your Discogs account (OAuth) and it checks all your wantlist items against every supported store automatically.

2. **Cart Optimizer** — hit "HIT ME WITH THE BEST CART GOLDY" and it fetches live Discogs marketplace listings for every item on your wantlist, then calculates the cheapest combination of sellers (including shipping to your location) to cover as much of your wantlist as possible.

3. **Daily rescans** — runs in the background and alerts you when something new comes into stock.

---

## Stores

### EU — live scraped per item
| Store | Location |
|---|---|
| Phonica Records | London |
| HHV | Berlin |
| Hardwax | Berlin |
| Deejay.de | Berlin |
| Decks.de | Germany |
| Juno | London |
| Yoyaku | Paris |

### US — catalog mirrored locally (fast, no scraping)
| Store | Platform | Catalog size |
|---|---|---|
| Gramaphone Records (Chicago) | Shopify | ~6k |
| Further Records (Seattle) | Shopify | ~25k |
| Octopus Records NYC (Brooklyn) | WooCommerce | ~6k |
| Turntable Lab (NYC) | Scraped | — |
| Underground Vinyl Source (LA) | Scraped | — |

---

## Tech stack

- **Node.js + Express** — web server and API
- **SQLite (better-sqlite3)** — all data: wantlist, store inventory, Discogs listings cache, job queue
- **Playwright + Chromium** — used only for the cart optimizer's Discogs marketplace scraping (see below)
- **Vanilla JS frontend** — no framework, served as static files

---

## Setup

### 1. Prerequisites

- Node.js 18+
- Playwright's Chromium installed: `npx playwright install chromium`

### 2. Install dependencies

```bash
npm install
```

### 3. Create a `.env` file

```
# Required — your Discogs Personal Access Token
# Get one at: https://www.discogs.com/settings/developers
DISCOGS_TOKEN=your_token_here
DISCOGS_PERSONAL_TOKEN=your_token_here   # same token, both names used internally

PORT=3000
```

To get a Discogs Personal Access Token:
1. Go to [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
2. Click **Generate new token**
3. Paste it into `.env`

### 4. Start the server

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000).

For production (auto-restart on crash/reboot):
```bash
npm install -g pm2
pm2 start server.js --name vinyl-checker
pm2 startup   # follow the printed instructions to enable on reboot
```

---

## Usage

### Scanning your wantlist

The app is OAuth-only. On first load, click **Connect Your Discogs** — you'll be redirected to Discogs to authorize, then redirected back. Your wantlist starts scanning immediately.

Manual entry (without OAuth): add `?share=USERNAME` to the URL to view any public wantlist in read-only mode.

### Cart Optimizer

1. Click **HIT ME WITH THE BEST CART GOLDY**
2. Enter your postcode/ZIP (for shipping cost estimates)
3. Set minimum record condition, minimum seller rating, and optionally a max price per record
4. Click **Optimize**

The optimizer runs as a background job — you'll see a progress bar updating as it fetches Discogs marketplace listings. Since listing data is cached for 6 hours in SQLite, repeat runs for the same wantlist are near-instant.

When complete, results show a ranked list of sellers/stores with the items to buy from each, shipping costs, and direct links to each Discogs listing.

If you navigate away while it's running, you'll get a browser notification when it's ready.

---

## Architecture

### Matching

US catalog-mirror stores use **catno-first matching**:

1. Normalize both sides to `[a-z0-9]+` and compare catalog numbers. If both have ≥3 chars and match → definitive hit.
2. Fall back to fuzzy artist + title similarity (Levenshtein bigrams).
3. Fall back to combined-title match for stores without a discrete artist field (Octopus).

Catalog numbers are globally unique (e.g. `MSNLP005`), so a catno match is always trusted over any title/artist fuzzy logic.

### Discogs marketplace data

The official Discogs API removed the endpoint for fetching all listings by release ID. The app works around this using `discogs-marketplace-api-nodejs`, which calls Discogs' internal JSON API via a headless Chromium browser. The browser bypasses Cloudflare bot-protection that blocks plain HTTP requests.

**This only works from a residential IP.** Cloud server IPs are blocked by Cloudflare. The app is designed to run on a home server (Mac Mini etc.) for exactly this reason.

Listings are cached in SQLite for 6 hours so the browser only needs to run when the cache is cold.

### Cart optimizer job queue

The optimizer is computationally heavy (20 Chromium sessions per run for a 300-item wantlist). To prevent multiple simultaneous runs from exhausting RAM, all optimizer requests go through a queue:

```
User submits → optimizer_jobs table (status: pending)
                        ↓
         worker polls every 3 seconds
                        ↓
         claims next pending job (status: processing)
                        ↓
         writes progress to DB every few seconds
                        ↓
         client polls /api/optimize/job/:id every 2.5s
                        ↓
         writes result to DB (status: done)
                        ↓
         client renders results + fires browser notification
```

One job at a time. Users submitting while another is running see their queue position. Completed jobs are cleaned up after 24 hours.

### Background jobs

The server runs three background loops on startup:

| Loop | Interval | What it does |
|---|---|---|
| Background sync | 60 min | Incremental wantlist re-check for new store stock |
| Daily rescan | 15 min check | Full wantlist rescan for users due (every 24h) |
| Stock validation | 4 hours | Re-validates in-stock items to catch items that sold |
| Optimizer worker | 3 sec | Picks up pending optimizer jobs from the queue |

Catalog mirrors (Gramaphone, Further, Octopus) are re-synced every 20+ hours, piggybacking on the daily rescan loop.

---

## CLI tools

Manually trigger a store catalog sync:

```bash
node sync-store.js gramaphone
node sync-store.js further
node sync-store.js octopus
```

---

## Tests

```bash
npm test
```

141 tests covering:
- Shopify product parsing (Gramaphone, Further)
- WooCommerce product parsing (Octopus)
- Catno-first matching logic
- Shipping rate estimation + postcode-to-country resolution
- Cart optimization algorithm

---

## Deployment (recommended: Mac Mini at home)

The Discogs marketplace scraping requires a **residential IP** to pass Cloudflare checks. A Mac Mini on home broadband is the right host for this.

### Making it publicly accessible without port forwarding

Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (free):

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Authenticate (one-time, opens browser)
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create vinyl-checker

# Route your domain
cloudflared tunnel route dns vinyl-checker yourdomain.com

# Run (or add to pm2)
cloudflared tunnel run vinyl-checker
```

This gives you a stable public URL with automatic HTTPS, even as your home IP changes. No router config needed.

### Recommended hardware

| Component | Spec | Why |
|---|---|---|
| Mac Mini M2 | 16GB RAM | 8GB handles ~2 concurrent optimizer runs; 16GB is comfortable |
| UPS | Any 300VA+ | Keeps it running through short power outages |
| Home broadband | 50+ Mbps up | Fine for hundreds of concurrent users on the web UI |

---

## Adding a new store

### Shopify store

1. Verify `/products.json` is public: `curl -s https://STORE.com/products.json?limit=1`
2. Inspect a few `body_html` samples to understand how label/catno are formatted
3. Add `lib/stores/<store>.js` — export `sync<Store>(opts)` and `check<Store>(page, item)`
4. Register in `server.js` (`STORE_SYNCERS`), `lib/scrapers.js` (`checkItem`), and `sync-store.js`
5. Add parser tests in `test/<store>.test.js`

### WooCommerce store

Same as above but use `lib/stores/woocommerce.js` helpers (`fetchAllProducts`, `parseWcProduct`). WooCommerce stores typically don't expose a separate artist field — lean on catno-first matching.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCOGS_TOKEN` | Yes | Discogs Personal Access Token |
| `DISCOGS_PERSONAL_TOKEN` | Yes | Same token (both names referenced internally) |
| `PORT` | No | HTTP port (default: 3000) |
| `DISCOGS_CONSUMER_KEY` | No | For OAuth app flow (not needed for PAT auth) |
| `DISCOGS_CONSUMER_SECRET` | No | For OAuth app flow |
| `CRON_SECRET` | No | Secret for the admin store-sync HTTP endpoint |
| `NOTIFICATION_WEBHOOK` | No | Webhook URL for new-stock Slack/Discord alerts |

---

## License

MIT
