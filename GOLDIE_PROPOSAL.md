# GOLDIE — AI Vinyl Commerce Agent
## Product Proposal & Deployed Architecture
**April 2026 — Confidential**

---

## The One-Line Pitch

GOLDIE is an AI agent that knows everything about a vinyl digger's taste, watches their wantlist in real time, and can talk them into a ready-to-checkout cart — from any device, any interface, in under 60 seconds.

---

## The Problem

Buying records online is fragmented and manual:
- A collector's wantlist has 200–400 items spread across 15+ stores
- Stock changes daily — by the time you notice something is available, it's gone
- Building a cart that makes sense (right stores, right budget, right taste) takes 30+ minutes
- Every store has a different checkout flow

Collectors spend more time searching than buying.

---

## What GOLDIE Does Today (Live on VPS)

GOLDIE runs as a live service at `stream.ronautradio.la/vinyl/`. It has two interfaces:

### 1. Chat Panel (in the app)
The `✦ GOLDIE` button opens a slide-in chat panel. GOLDIE knows:
- The logged-in user's **full taste profile** (genres, styles, era, personality archetypes, rarity score) built from their Discogs wantlist + collection combined
- **What's in stock right now** across 15 scraped stores — updated every 24h, incrementally every 15 min
- **Community rarity data** (Discogs community_have/want) for every wantlist item
- **Every other digger** on the platform and their taste overlap with the current user
- **Cart state** — what's already in the cart, what's been dismissed

Example conversations:
> "What's in stock for me right now?" → lists items by store with prices and rarity scores
> "Suggest a cart for HHV under €80" → builds an optimized cart for that store
> "What are my rarest in-stock finds?" → surfaces ultra-rare items (<50 collectors worldwide)
> "What does Alex Emami have that I might like?" → cross-digger taste comparison

### 2. MCP Server (Claude Desktop / claude.ai)
GOLDIE also runs as an **MCP (Model Context Protocol) server** on stdio. Add it to Claude Desktop and you can ask questions about your vinyl collection from any Claude interface — no browser needed.

---

## Architecture (Deployed Today)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Contabo VPS (89.117.16.160)                   │
│                                                                   │
│  ┌──────────────────────────┐   ┌──────────────────────────┐    │
│  │   vinyl-checker          │   │   GOLDIE                  │    │
│  │   (PM2, port 5052)       │   │   (PM2, port 5053)        │    │
│  │                          │   │                           │    │
│  │  Express server          │   │  HTTP + SSE               │    │
│  │  15 store scrapers       │◄──┤  Claude claude-opus-4-5   │    │
│  │  SQLite DB               │   │  8 data tools             │    │
│  │  Discogs OAuth           │   │  Session history (SQLite) │    │
│  │  Background sync         │   │  MCP stdio server         │    │
│  └──────────┬───────────────┘   └──────────┬────────────────┘    │
│             │                              │                      │
│  ┌──────────▼──────────────────────────────▼────────────────┐    │
│  │              SQLite: vinyl-checker.db                     │    │
│  │  users / wantlist / collection / store_results            │    │
│  │  release_meta / goldie_sessions / scan_runs / cart        │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
│  nginx → /vinyl/  → 5052     Access: stream.ronautradio.la/vinyl/ │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

External:
  Discogs API  → wantlist + collection + community metadata
  Anthropic API → GOLDIE's Claude claude-opus-4-5 reasoning layer

Client interfaces:
  Browser  → vinyl-checker UI + GOLDIE chat panel
  Claude Desktop → MCP connection to GOLDIE stdio server
  claude.ai (future) → MCP HTTP transport
```

### GOLDIE's 8 Live Data Tools

| Tool | What it does |
|------|-------------|
| `get_user_profile` | Full taste profile: archetypes, genres, styles, era, rarity stats, in-stock % |
| `get_in_stock` | Items in stock now, filterable by store, rarity, sort order |
| `suggest_cart` | Builds per-store carts optimized for taste / rarity / value / budget |
| `get_rare_finds` | Rarest in-stock items (by Discogs community_have count) |
| `search_wantlist` | Search wantlist by artist, title, label, genre, style |
| `get_store_breakdown` | Deep breakdown of one store: inventory, genres, prices |
| `get_diggers` | All platform users with taste match % vs current user |
| `compare_diggers` | Head-to-head taste overlap between two users |

### Taste Profile Data Sources (combined)
- Wantlist (items wanted but not owned) — proves desire
- Collection (items already owned) — proves taste
- Release metadata (Discogs community have/want/rating) — proves rarity and cultural weight
- Scan history — shows buying patterns and urgency
- Personality archetypes (rule-based, 21 rules) — produces readable labels like "DnB / Jungle Junkie", "Rominimal Head", "Jazz Archaeologist"

---

## Roadmap

### Phase 2 — Cart Actions (Next 4 weeks)

**GOLDIE adds items to cart directly.**

> "Add all 3 HHV items to my cart" → GOLDIE calls `add_to_cart(username, items[])` and the cart badge updates

> "Remove the €45 item, keep the others" → GOLDIE adjusts cart in the same conversation

New tool: `manage_cart(username, action, items)` — add, remove, clear by store

**GOLDIE generates store-specific checkout links.**

Each store has a different cart URL structure. GOLDIE generates pre-filled URLs:
- HHV: `hhv.de/cart?add=SKU1,SKU2`
- Juno: `juno.co.uk/checkout?basket=...`
- etc.

One-click opens the store with items already in cart.

### Phase 3 — One-Click Checkout (6–8 weeks)

**Chrome extension integration.**

The Gold Digger Chrome extension (already exists for Discogs sync) gets a new capability: GOLDIE passes a checkout instruction to the extension, which opens a store tab and automates the checkout flow.

Flow:
1. User: "Check out my HHV cart"
2. GOLDIE: "Your HHV cart is €67.50 (3 items). Confirm?"
3. User: "Yes"
4. GOLDIE → extension: `checkout({ store: 'HHV', items: [...], total: 67.50 })`
5. Extension opens HHV, adds items, navigates to checkout
6. User enters payment (GOLDIE never handles payment data)

**Scope boundary:** GOLDIE orchestrates up to the payment screen. Payment is always completed by the human. This is non-negotiable for security.

### Phase 4 — Full Dashboard Intelligence (8–12 weeks)

GOLDIE gets read access to all platform dashboards:

| Dashboard | What GOLDIE can surface |
|-----------|------------------------|
| Scan history | "Your last scan found 3 new items. Want to see them?" |
| Price trends | "This pressing dropped 20% on Discogs this month" |
| Digger community | "Alex and you both want this — first to buy wins" |
| Store performance | "Juno has had 8 of your wants in the last 30 days, HHV only 2" |
| Rarity alerts | "This item has 31 collectors. It rarely appears in stock." |

### Phase 5 — Website Interaction via GOLDIE (3–6 months)

**The end goal: GOLDIE IS the interface.**

GOLDIE controls the vinyl-checker UI via tool calls. The browser becomes just a renderer. A user can:

- Open the GOLDIE chat panel
- Navigate the entire platform through conversation
- Have GOLDIE filter, sort, search, open modals, build carts
- Never touch a filter or dropdown again

Technical approach:
- GOLDIE tool: `navigate_ui(view, filters)` → posts a `goldieCommand` event to the page
- App.js listens for `goldieCommand` events and applies them
- GOLDIE can ask the page for its current state via a `get_ui_state` tool

This turns GOLDIE from a chat panel into a **conversational operating system** for the app.

### Phase 6 — LLM-Generated Personality Profiles (2–4 months)

Currently personality tags (e.g. "Rominimal Head") are rule-based. In Phase 6:

GOLDIE generates a **taste profile paragraph** per user:

> "You gravitate toward obscure Eastern European techno from the late 90s and early 00s. Your wantlist skews heavily toward original pressings over reissues, and you pay a premium for rarity — 68% of your wantlist has fewer than 200 collectors worldwide. Your collection is anchored in Hardwax-era minimal techno and Berlin club culture, with a secondary lane in deep ambient and drone. You're not a mainstream Juno shopper — you're a Hardwax, Decks.de, Yoyaku digger."

Cached monthly, updated when wantlist or collection changes significantly.

### Phase 7 — Streaming + Social Integrations (4–6 months)

- **Spotify**: "Build a playlist from everything in my HHV cart" → auto-creates Spotify playlist from wantlist items
- **YouTube**: "Show me YouTube videos for these 3 records" → surfaces Discogs video links
- **SoundCloud**: Artist/label lookup for wantlist items
- All behind per-user feature flags (opt-in, toggleable in profile settings)

---

## Competitive Context

| Platform | Intelligence | Commerce | Taste Profiling |
|----------|-------------|---------|-----------------|
| Discogs | None | Marketplace only | None |
| Bandcamp | None | Direct purchase | None |
| Juno / HHV | None | Store checkout | None |
| **GOLDIE** | **Claude claude-opus-4-5 LLM** | **Multi-store carts** | **Genre + rarity + era + collection** |

No other platform has an AI agent that understands cross-store vinyl availability + personal taste + community rarity data simultaneously.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent reasoning | Anthropic Claude claude-opus-4-5 (streaming, tool use) |
| Agent server | Node.js, custom HTTP/SSE, goldie.js |
| MCP protocol | @modelcontextprotocol/sdk (stdio) |
| Data layer | SQLite via better-sqlite3 |
| Store scrapers | Puppeteer + stealth plugin |
| Background sync | Node.js setInterval + job queue |
| Auth | Discogs OAuth 1.0a, session cookies |
| Hosting | Contabo VPS, Ubuntu 22.04, PM2, nginx |
| Domain | stream.ronautradio.la/vinyl/ |

---

## Cost Model (per user per month)

GOLDIE uses Claude claude-opus-4-5. Approximate token costs:

| Usage pattern | Tokens/month | Est. cost |
|---------------|-------------|-----------|
| Light (5 chats/month) | ~50K | ~$0.38 |
| Medium (20 chats/month) | ~200K | ~$1.50 |
| Heavy (daily use) | ~600K | ~$4.50 |

At scale: shared system prompt cached via Anthropic prompt caching (5-min TTL) reduces input token cost by ~90% for repeated queries. At 100 users medium usage: ~$150/month in API costs.

---

## What Dan Needs to Know

1. **It's live.** GOLDIE is deployed, responding, and has database access to all user profiles.
2. **The data moat.** Taste profile + real-time multi-store inventory + community rarity data in one place is not replicable from any single public source.
3. **The interface is the product.** Phase 5 (GOLDIE as UI) makes the website itself obsolete as a navigation tool. The conversation IS the product.
4. **One dependency.** GOLDIE needs an Anthropic API key (`console.anthropic.com`). Everything else is self-hosted.
5. **The checkout loop is 4 weeks away.** Cart management + one-click store links are the next sprint. Full automated checkout via Chrome extension is 6–8 weeks.

---

## Access

| Resource | URL |
|---------|-----|
| App | https://stream.ronautradio.la/vinyl/ |
| GOLDIE health | http://89.117.16.160:5053/health |
| GitHub | https://github.com/solakli/vinyl-checker |
| Anthropic Console | https://console.anthropic.com |

---

*Built by Omer Solakli — April 2026*
*GOLDIE proposal v1.0 — Share with: Dan*
