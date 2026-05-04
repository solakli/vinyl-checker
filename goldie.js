#!/usr/bin/env node
/**
 * WAXY — Vinyl Intelligence Agent
 *
 * Runs as two things simultaneously:
 *   1. HTTP agent server  — POST /chat  (streaming Claude responses + tool calls)
 *                           GET  /sessions/:username
 *                           GET  /context/:username
 *   2. MCP server         — stdio transport (connect from Claude Desktop / claude.ai)
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required
 *   GOLDIE_PORT         default 5053
 *   GOLDIE_SECRET       optional Bearer token for HTTP auth
 *   DB_PATH             defaults to ./vinyl-checker.db
 *
 * Run:  node goldie.js
 * MCP:  node goldie.js --mcp   (stdio mode for Claude Desktop)
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const http    = require('http');

// Load .env before anything else
try {
    var envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                var eq = line.indexOf('=');
                if (eq > 0) {
                    var k = line.substring(0, eq).trim();
                    var v = line.substring(eq + 1).trim();
                    if (!process.env[k]) process.env[k] = v;
                }
            }
        });
    }
} catch(e) {}

const Anthropic = require('@anthropic-ai/sdk');

// ── DB ──────────────────────────────────────────────────────────────────────
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, 'vinyl-checker.db');
const db = require('./db');

// ── Claude client ───────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-opus-4-5';

// ═══════════════════════════════════════════════════════════════════════════
// PERSONALITY ARCHETYPES (mirrored from server.js — no circular require)
// ═══════════════════════════════════════════════════════════════════════════

var ARCHETYPE_RULES = [
    { label:'UK Garage Head',        icon:'🏴',  color:'teal',   styles:['UK Garage','Speed Garage','2-Step'],                    genres:[],            min:5  },
    { label:'DnB / Jungle Junkie',   icon:'🥁',  color:'purple', styles:['Drum n Bass','Jungle','Darkstep','Neurofunk'],          genres:[],            min:7  },
    { label:'Rominimal Head',        icon:'〰️', color:'blue',   styles:['Minimal','Minimal Techno','Microhouse'],                genres:[],            min:7  },
    { label:'Detroit Purist',        icon:'🏭', color:'smoke',  styles:['Detroit Techno','Deep Techno'],                         genres:[],            min:5  },
    { label:'Acid Freak',            icon:'🧪', color:'green',  styles:['Acid','Acid House','Acid Jazz','Acid Techno'],          genres:[],            min:5  },
    { label:'Italo-Cosmic Head',     icon:'🪐', color:'pink',   styles:['Cosmic','Italo-Disco','Space'],                         genres:[],            min:5  },
    { label:'House Music Lifer',     icon:'🏠', color:'orange', styles:['Chicago House','Deep House','Soulful House','House'],   genres:[],            min:9  },
    { label:'Breaks Fiend',          icon:'💥', color:'red',    styles:['Breakbeat','Breaks','Nu-Skool Breaks','Big Beat'],      genres:[],            min:5  },
    { label:'Dub Archaeologist',     icon:'🌿', color:'green',  styles:['Dub','Roots Reggae','Dub Techno','Lovers Rock'],        genres:['Reggae'],    min:7  },
    { label:'Global Grooves Hunter', icon:'🌍', color:'gold',   styles:['Afrobeat','Highlife','Afro-Cuban','Cumbia','Baile Funk'],genres:[],            min:4  },
    { label:'Ambient Explorer',      icon:'🌌', color:'blue',   styles:['Ambient','Drone','New Age','Dark Ambient'],             genres:[],            min:7  },
    { label:'Industrial Head',       icon:'⚙️', color:'smoke',  styles:['EBM','Industrial','Dark Electro','Power Electronics'],  genres:[],            min:5  },
    { label:'80s Synth Devotee',     icon:'🎛', color:'pink',   styles:['Synth-pop','New Wave','Post-Punk','Darkwave'],          genres:[],            min:7  },
    { label:'Jazz Archaeologist',    icon:'🎷', color:'gold',   styles:['Bop','Post Bop','Hard Bop','Cool Jazz','Free Jazz'],    genres:['Jazz'],      min:8  },
    { label:'Soul & Funk Hunter',    icon:'✊', color:'orange', styles:['Soul','Funk','Northern Soul','Neo Soul'],                genres:['Soul'],      min:10 },
    { label:'Hip Hop Head',          icon:'🎤', color:'red',    styles:[],                                                       genres:['Hip Hop'],   min:12 },
    { label:'Latin Grooves Collector',icon:'💃',color:'teal',   styles:['Cumbia','Salsa','Latin Jazz','Bossa Nova'],             genres:['Latin'],     min:5  },
    { label:'Balearic Head',         icon:'🏝', color:'teal',   styles:['Balearic','Chill Out','Downtempo'],                     genres:[],            min:5  },
    { label:'Trance Pilgrim',        icon:'🕊', color:'purple', styles:['Trance','Progressive Trance','Psy-Trance'],             genres:[],            min:7  },
    { label:'Noise & Experimental',  icon:'📡', color:'smoke',  styles:['Noise','Avant-garde','Free Improvisation'],             genres:['Non-Music'], min:5  },
    { label:'Classical Digger',      icon:'🎼', color:'gold',   styles:[],                                                       genres:['Classical'], min:10 },
];

function computePersonalityTags(genreCounts, styleCounts, totalItems, avgHave, topDecade) {
    var scored = ARCHETYPE_RULES.map(function(rule) {
        var sum = 0;
        rule.styles.forEach(function(s){ sum += (styleCounts[s] || 0); });
        rule.genres.forEach(function(g){ sum += (genreCounts[g] || 0); });
        var pct = totalItems > 0 ? (sum / totalItems) * 100 : 0;
        return { label: rule.label, icon: rule.icon, color: rule.color, pct: Math.round(pct*10)/10, min: rule.min };
    });
    scored.sort(function(a, b){ return b.pct - a.pct; });
    var tags = scored.filter(function(r){ return r.pct >= r.min; }).slice(0, 3);

    if (tags.length < 3 && typeof avgHave === 'number' && avgHave > 0) {
        if      (avgHave < 50)  tags.push({ label:'Ultra Rare Digger',      icon:'💎', color:'gold' });
        else if (avgHave < 150) tags.push({ label:'Underground Gem Hunter', icon:'🔍', color:'gold' });
        else if (avgHave < 400) tags.push({ label:'Deep Digger',            icon:'⛏', color:'smoke' });
    }
    if (tags.length === 0 && topDecade) {
        var eraMap = {
            '60s':{ label:'60s Collector',     icon:'🎸', color:'orange' },
            '70s':{ label:'Vintage Digger',     icon:'🕰', color:'gold'   },
            '80s':{ label:"'80s Archaeologist", icon:'📼', color:'purple' },
            '90s':{ label:"'90s Head",          icon:'💿', color:'blue'   },
            '00s':{ label:'Y2K Era Explorer',   icon:'💾', color:'teal'   },
            '10s':{ label:'2010s Digger',       icon:'📱', color:'smoke'  },
        };
        if (eraMap[topDecade]) tags.push(eraMap[topDecade]);
    }
    return tags.slice(0, 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE — GOLDIE's system prompt
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are WAXY, an expert vinyl record intelligence agent embedded in the Wax Digger platform. You help diggers (vinyl collectors) discover, track and buy records.

You have access to a set of tools that query the platform's live database. Always use tools to get fresh data before making recommendations — never guess at prices, stock levels or user taste.

## Platform overview
- Users sync their Discogs wantlist and collection. The platform scrapes ~15 independent stores and shows which wanted items are in stock.
- Stores scraped: HHV (Berlin), Deejay.de (Berlin), Hardwax (Berlin), Decks.de (Germany), Juno (London), Phonica (London), Yoyaku (Tokyo), Turntable Lab (NYC), Gramaphone (Chicago), Further Records (US), Underground Vinyl (US), Octopus Records (NYC).
- Each user has a taste profile built from wantlist + collection: top genres, styles, artists, era, personality archetypes, rarity score.
- The optimizer is the real cart-building engine: it covers the full wantlist using BOTH scraped stores AND individual Discogs marketplace sellers. It calculates real shipping per seller, picks the cheapest combination, and stores results in optimizer_jobs. Always use get_optimizer_result when the user mentions "optimize", "cart", or "checkout". If no result exists, use run_optimizer to trigger one.
- suggest_cart is a lightweight fallback that only sees scraped in-stock items — not Discogs sellers and not real shipping costs.

## Chrome Extension & Discogs Marketplace Sync
The platform has a Chrome extension called **Wax Digger** that syncs real Discogs marketplace data:
- **Marketplace sync**: scrapes individual seller listings for every wantlist item from Discogs.com, capturing seller username, seller rating, condition (VG+/NM/etc.), price, and ships-from country.
- **Wantlist sync**: keeps the local DB in sync with the user's Discogs wantlist in real time.
- This data lets you compare store prices vs Discogs marketplace prices, find the best-rated seller, or filter by condition and shipping origin.
- Use 'get_discogs_marketplace' to query this data. If no listings found, tell the user to run a marketplace sync from the app or Chrome extension.
- Use 'get_sync_status' whenever the user asks "is it done?", "what's the progress?", "did it work?", or similar. Also call it automatically after trigger_sync to confirm the sync actually started. NEVER say you can't check progress — you have get_sync_status for exactly that.

## Your capabilities
- Show a user what's in stock for them right now (scraped stores)
- Look up Discogs marketplace listings for wantlist items: price, seller, condition, ships-from
- Compare store prices vs Discogs marketplace prices — surface where a record is cheapest
- Suggest carts per store based on their taste profile and budget, add/remove items via manage_cart
- Read current cart state and generate checkout links per store via get_cart
- Browse a user's owned collection via get_collection (separate from wantlist)
- Rank in-stock items by rarity, price value vs Discogs market, or taste alignment
- Compare taste between diggers and find shared interests
- Explain a user's taste profile in plain language
- Highlight hidden gems (low community_have = hard to find elsewhere)
- Provide store recommendations (which stores are best for their taste)
- Show GEM INTELLIGENCE: underground index, hidden gem tier, YouTube view data, DJ validation, YouTube-comment genre tags — use get_gem_intelligence for any question about "hidden gems", "underground records", "my underground index", "DJ validation", or "YouTube data on my records"
- Find underground/gem records that are currently in stock: use get_gem_store_hits — THE best "buy now" signal, combines gem score + live availability
- Discover records NOT on the wantlist from catalog stores (Further, Gramaphone, Octopus, UVS) that match taste: use get_catalog_discoveries
- Get AI-powered artist + record recommendations via Last.fm similarity, cross-referenced with live catalog: use get_taste_recommendations

## Discovery + Catalog Tools
- **get_gem_store_hits**: Wantlist items that are BOTH gem-scored (hidden_gem / club_weapon) AND in stock right now. Use for "what underground records can I buy today", "which gems are available", "best records to buy now". Ranks by gem score.
- **get_catalog_discoveries**: Browse 40k+ catalog records (Further, Gramaphone, Octopus, UVS) for items NOT on the wantlist that match the user's taste profile. Use for "what should I discover", "what's at Further that fits my taste", "show me new records". Scores by genre/style overlap with wantlist.
- **get_taste_recommendations**: Full Last.fm similarity engine — expands from wantlist seed artists, finds similar artists, returns their in-catalog records available to buy. Use for "recommend me music", "what artists would I like", "what should I dig for". Includes blended score + "because you want X" reasons.

## GEM INTELLIGENCE
The platform enriches every wantlist + collection item with YouTube data (view count, DJ mentions in comments, genre tags). From this it computes a Gem Score (0-100) and assigns each release a tier:
- **hidden_gem**: very low YouTube views (<10k), obscure on Discogs — truly underground
- **club_weapon**: DJs shout it out in comments — underground but validated
- **deep_cut**: niche but with some following
- **known_quantity**: well-known, widely discussed
- **unscored**: not yet enriched (background job runs 90/day)
Use get_gem_intelligence to answer questions about underground percentage, top hidden gems, which DJs are in the comments, YouTube-based genre tags. The underground index and tier counts improve daily as the enrichment job runs.

## Cart workflow
When a user says "add to cart", "build my cart", or "what should I buy":
1. Call get_optimizer_result first — it covers both stores + Discogs sellers with real shipping
2. Suggest specific items: list them grouped by store/seller with prices
3. Offer to add them to the in-app cart via manage_cart
4. Use get_cart to show current cart state and checkout URLs per store
- Store checkout URLs: HHV → hhv.de/cart, Juno → juno.co.uk/basket/, Deejay.de → deejay.de/warenkorb/
- For Discogs sellers: https://www.discogs.com/seller/SELLER_NAME/profile

## Collection vs Wantlist
- Wantlist = records the user WANTS to buy (search_wantlist, get_in_stock)
- Collection = records the user OWNS (get_collection)
- Both are used for taste profiling. Use get_collection when a user asks "what do I own", "show my collection", or when comparing with another user's collection.

## Personality
You are WAXY — sharp, opinionated, deeply embedded in vinyl culture. You speak like a seasoned crate digger who also happens to understand data. Short sentences. No filler. Surface the insight immediately ("only 47 collectors own this worldwide", "98% seller rating ships from Germany — solid buy", "3 DJs mentioned this in comments — it's a weapon").

Make opinionated calls when asked. Don't just list options — tell the user what to do and why. Back everything with data but don't bury the recommendation in caveats.

Keep responses scannable: bullet lists for multiple items, bold for key figures, one-line reasons per record.

When suggesting carts, group by store and include: item name, price, rarity (community_have), and a one-line reason.
When surfacing Discogs marketplace listings, always show: seller, condition, price, ships-from, and seller rating.
When showing hidden gems, lead with the gem tier and view count — that's the signal.

Today's date: ${new Date().toISOString().slice(0,10)}`;

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

const TOOLS = [
    {
        name: 'get_user_profile',
        description: 'Get a user\'s full taste profile: personality archetypes, top genres/styles/artists, era breakdown, wantlist stats, collection size, rarity score, in-stock count. Use this to understand a user before making recommendations.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_in_stock',
        description: 'Get items currently in stock for a user\'s wantlist. Can filter by store or minimum rarity. Returns artist, title, store, price, community_have (rarity), Discogs URL.',
        input_schema: {
            type: 'object',
            properties: {
                username:      { type: 'string', description: 'Discogs username' },
                store:         { type: 'string', description: 'Filter by store name (optional)' },
                max_have:      { type: 'number', description: 'Only return items with community_have below this (rarity filter, optional)' },
                sort:          { type: 'string', enum: ['rarity','price_asc','price_desc','artist'], description: 'Sort order (default: rarity)' },
                limit:         { type: 'number', description: 'Max items to return (default 30)' }
            },
            required: ['username']
        }
    },
    {
        name: 'suggest_cart',
        description: 'FALLBACK ONLY — simple store-only cart suggestion when no optimizer result exists. Prefer get_optimizer_result for any "cart" or "optimize" request. This tool only sees scraped store inventory (not Discogs marketplace sellers) and does not calculate real shipping. Use it when the user wants a quick in-stock store recommendation without running the full optimizer.',
        input_schema: {
            type: 'object',
            properties: {
                username:   { type: 'string', description: 'Discogs username' },
                max_budget: { type: 'number', description: 'Total budget in USD (optional)' },
                stores:     { type: 'array', items: { type: 'string' }, description: 'Limit to these stores (optional)' },
                min_items_per_store: { type: 'number', description: 'Min items per store cart (default 2, to justify shipping)' },
                prioritize: { type: 'string', enum: ['rarity','value','taste'], description: 'What to optimize for (default: taste)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_diggers',
        description: 'List all diggers on the platform with stats and multi-dimensional taste match vs a target user. Match score blends: style cosine similarity (30%), era overlap (20%), artist overlap (15%), rarity alignment (15%), label overlap (10%), underground alignment (10%). Use when user asks "who has similar taste to me" or "who should I dig with".',
        input_schema: {
            type: 'object',
            properties: {
                for_user: { type: 'string', description: 'Compute taste match % for this username (optional)' }
            }
        }
    },
    {
        name: 'search_wantlist',
        description: 'Search a user\'s wantlist by artist, title, label, or genre. Returns matching items with in-stock status.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                query:    { type: 'string', description: 'Search term (artist, title, label)' },
                genre:    { type: 'string', description: 'Filter by genre (optional)' },
                style:    { type: 'string', description: 'Filter by style (optional)' },
                in_stock_only: { type: 'boolean', description: 'Only return in-stock items' }
            },
            required: ['username', 'query']
        }
    },
    {
        name: 'get_store_breakdown',
        description: 'Get detailed breakdown of a specific store: how many items from wantlist are in stock, average prices, top genres available.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                store:    { type: 'string', description: 'Store name (e.g. HHV, Juno, Deejay.de)' }
            },
            required: ['username', 'store']
        }
    },
    {
        name: 'get_rare_finds',
        description: 'Find the rarest in-stock items for a user (lowest community_have count = hardest to find elsewhere). Great for "buy now" urgency.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                limit:    { type: 'number', description: 'Max items (default 10)' }
            },
            required: ['username']
        }
    },
    {
        name: 'compare_diggers',
        description: 'Deep comparison of two diggers with full taste match breakdown: overall %, style similarity (30%), era overlap (20%), artist overlap (15%), rarity alignment (15%), label overlap (10%), underground alignment (10%). Also shows shared wantlist items, shared artists, shared styles, shared labels, era distribution, and what makes each digger unique. Use for "compare me with X", "how similar am I to X", "do me and X have the same taste".',
        input_schema: {
            type: 'object',
            properties: {
                username1: { type: 'string' },
                username2: { type: 'string' }
            },
            required: ['username1', 'username2']
        }
    },
    {
        name: 'get_discogs_marketplace',
        description: 'Query real Discogs marketplace seller listings for a user\'s wantlist items — synced by the Wax Digger Chrome extension. Returns individual seller listings with condition, price, seller rating, and ships-from country. Use this to find the best deal on a specific record, compare Discogs prices vs store prices, or filter by condition/origin. Also returns Discogs summary stats (lowest price, num copies for sale) where available.',
        input_schema: {
            type: 'object',
            properties: {
                username:          { type: 'string',  description: 'Discogs username' },
                query:             { type: 'string',  description: 'Search by artist or title (optional — omit to see all synced listings)' },
                min_condition:     { type: 'string',  description: 'Minimum condition: M, NM, VG+, VG, G+ (optional)' },
                ships_from:        { type: 'string',  description: 'Filter by ships-from country code or name, e.g. DE, US, UK, JP (optional)' },
                max_price_usd:     { type: 'number',  description: 'Maximum price in USD (optional)' },
                min_seller_rating: { type: 'number',  description: 'Minimum seller rating 0-100 (optional, 97+ recommended)' },
                sort:              { type: 'string',  enum: ['price_asc','price_desc','condition','seller_rating'], description: 'Sort order (default: price_asc)' },
                limit:             { type: 'number',  description: 'Max listings to return (default 20)' }
            },
            required: ['username']
        }
    },
    {
        name: 'trigger_sync',
        description: 'Trigger a Discogs data sync for a user. Can sync the wantlist (pulls latest wantlist from Discogs API) and/or the marketplace (scrapes current seller listings for all wantlist items). Use this when the user asks to sync, refresh, or update their Discogs data. Returns sync status.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                type:     { type: 'string', enum: ['wantlist', 'marketplace', 'both'], description: 'What to sync: wantlist (pull from Discogs API), marketplace (scrape seller listings), or both (default: both)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_sync_status',
        description: 'Check the live progress of an ongoing Discogs marketplace sync. Use this whenever the user asks "is it done?", "what\'s the progress?", "how far along is the sync?", or any time you want to report sync progress after triggering one. Returns running state, items done vs total, elapsed time, and how many listings are in the DB so far.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_optimizer_result',
        description: 'Get the latest cart optimization result for a user. The optimizer is the real cart-building engine — it covers the full wantlist using both scraped stores AND individual Discogs marketplace sellers, calculates real shipping costs per source, and picks the cheapest combination. ALWAYS use this instead of suggest_cart when the user asks to "optimize", "build a cart", or "check the optimizer". Returns store carts and top Discogs sellers with items, prices, shipping, and conditions.',
        input_schema: {
            type: 'object',
            properties: {
                username:             { type: 'string',  description: 'Discogs username' },
                max_age_hours:        { type: 'number',  description: 'How old the cached result can be in hours (default 24)' },
                show_discogs_sellers: { type: 'boolean', description: 'Include top Discogs seller detail (default true)' },
                limit_sellers:        { type: 'number',  description: 'How many top Discogs sellers to show (default 5)' }
            },
            required: ['username']
        }
    },
    {
        name: 'run_optimizer',
        description: 'Trigger a new cart optimization job for a user. The optimizer scans ALL wantlist items across scraped stores and Discogs marketplace sellers to build the cheapest cart. Takes 1-2 minutes. After calling this, use get_optimizer_result to fetch the result. Use this when the user asks to re-optimize, or when get_optimizer_result returns no cached result.',
        input_schema: {
            type: 'object',
            properties: {
                username:          { type: 'string',  description: 'Discogs username' },
                min_condition:     { type: 'string',  description: 'Minimum record condition: M, NM, VG+, VG, G+ (default: VG)' },
                min_seller_rating: { type: 'number',  description: 'Minimum Discogs seller rating 0-100 (default: 98)' },
                max_price_usd:     { type: 'number',  description: 'Max price per record in USD (optional)' },
                force_refresh:     { type: 'boolean', description: 'Force a new run even if a fresh cached result exists (default false)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_cart',
        description: 'Get the current in-app cart for a user — items queued for purchase, grouped by store with totals and checkout URLs. Use this when the user asks "what\'s in my cart", "show my cart", or after adding items via manage_cart.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' }
            },
            required: ['username']
        }
    },
    {
        name: 'manage_cart',
        description: 'Add or remove items from the user\'s in-app cart. Use this to actually queue items for purchase after suggesting them. Items are matched by title+store. Returns updated cart summary with checkout URLs. Action: "add" (queue items), "remove" (dequeue), "clear" (empty cart).',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                action:   { type: 'string', enum: ['add', 'remove', 'clear'], description: 'add items, remove specific items, or clear entire cart' },
                items: {
                    type: 'array',
                    description: 'Items to add or remove (not needed for clear action)',
                    items: {
                        type: 'object',
                        properties: {
                            artist:    { type: 'string', description: 'Artist name' },
                            title:     { type: 'string', description: 'Record title' },
                            store:     { type: 'string', description: 'Store name, e.g. HHV, Juno, Deejay.de' },
                            price_usd: { type: 'number', description: 'Price in USD (optional for add)' }
                        },
                        required: ['artist', 'title', 'store']
                    }
                }
            },
            required: ['username', 'action']
        }
    },
    {
        name: 'get_collection',
        description: 'Get records a user OWNS (their collection, not wantlist). Can search by artist, title, genre, or style. Use this when the user asks "what do I own", "show my collection", or when you need to compare two users\' owned records.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                query:    { type: 'string', description: 'Search by artist or title (optional)' },
                genre:    { type: 'string', description: 'Filter by genre (optional)' },
                style:    { type: 'string', description: 'Filter by style (optional)' },
                sort:     { type: 'string', enum: ['date_added', 'artist', 'year'], description: 'Sort order (default: date_added desc)' },
                limit:    { type: 'number', description: 'Max items to return (default 30, max 100)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_gem_intelligence',
        description: 'Get a user\'s GEM INTELLIGENCE profile: underground index (% of releases with <10k YouTube views), gem tier breakdown (hidden_gem/club_weapon/deep_cut/known_quantity/unscored), top hidden gems, most underground records by view count, YouTube-comment genre tags, and DJs who have mentioned their records. Use this for any question about "hidden gems", "underground index", "which records are most underground", "what DJs are in my records", "YouTube data on my collection", or taste profile deep-dives based on streaming data.',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                limit:    { type: 'number', description: 'Max top gems to return (default 20, max 50)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_gem_store_hits',
        description: 'Find hidden gems and club weapons on the wantlist that are currently IN STOCK at any store. The ultimate "buy now" list — records that are underground (low YouTube views), DJ-validated (mentioned in comments), or deep cuts, that happen to be available right now. Use this when the user asks "what underground records can I buy today", "which of my gems are in stock", or "best records to buy now". Returns gem score, tier, view count, DJs mentioned, and which store has it.',
        input_schema: {
            type: 'object',
            properties: {
                username:  { type: 'string', description: 'Discogs username' },
                tiers:     { type: 'array', items: { type: 'string' }, description: 'Gem tiers to include: hidden_gem, club_weapon, deep_cut (default: hidden_gem and club_weapon)' },
                min_score: { type: 'number', description: 'Minimum gem score 0–100 (default 35)' },
                limit:     { type: 'number', description: 'Max results (default 15)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_catalog_discoveries',
        description: 'Browse the full catalog inventory of Further Records, Gramaphone, Octopus Records NYC, Underground Vinyl, and Hardwax for records NOT on the user\'s wantlist that match their taste. Uses Engine 1: TF-IDF style scoring, artist/label affinity, style cluster expansion, diversity cap. Each result includes a matchPct and reasons (e.g. "because you want Burial" or "Minimal Techno"). Great for "what should I discover today", "what\'s in stock at Further that fits my taste", "show me deep house at Gramaphone". Note: Octopus has no artist data (style/label only); UVS has no label data (artist/style only).',
        input_schema: {
            type: 'object',
            properties: {
                username:  { type: 'string', description: 'Discogs username' },
                store:     { type: 'string', description: 'Limit to one store (optional — all if omitted): "Further Records", "Gramaphone", "Octopus Records NYC", "Underground Vinyl", "Hardwax"' },
                genre:     { type: 'string', description: 'Filter by genre/style keyword (optional, e.g. "Techno", "House", "Ambient")' },
                max_price: { type: 'number', description: 'Max price in USD (optional)' },
                limit:     { type: 'number', description: 'Max results (default 20, max 50)' }
            },
            required: ['username']
        }
    },
    {
        name: 'get_taste_recommendations',
        description: 'Get AI-powered record recommendations based on the user\'s taste profile — uses Last.fm similarity to expand from wantlist seed artists, cross-referenced against catalog store inventory for records available RIGHT NOW. Far richer than suggest_cart: discovers artists outside the user\'s wantlist that they would likely love, scored by Last.fm similarity × taste tag overlap. Use for "what should I dig for", "recommend me records", "what artists are similar to my taste", or "discover new music". Each recommendation says WHY it was suggested (because you want X).',
        input_schema: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Discogs username' },
                limit:    { type: 'number', description: 'Max recommendations (default 20, max 40)' }
            },
            required: ['username']
        }
    }
];

// ═══════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function toolGetUserProfile({ username }) {
    var d = db.getDb();
    var user = d.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };

    var wantlistSize   = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1').get(user.id).c;
    var inStockCount   = d.prepare('SELECT COUNT(DISTINCT w.id) as c FROM wantlist w JOIN store_results sr ON sr.wantlist_id=w.id WHERE w.user_id=? AND w.active=1 AND sr.in_stock=1').get(user.id).c;
    var collectionSize = d.prepare('SELECT COUNT(*) as c FROM collection WHERE user_id=?').get(user.id).c;
    var neverFound     = d.prepare('SELECT COUNT(*) as c FROM wantlist w WHERE w.user_id=? AND w.active=1 AND NOT EXISTS (SELECT 1 FROM store_results sr WHERE sr.wantlist_id=w.id AND sr.in_stock=1)').get(user.id).c;

    // Genres + styles from wantlist + collection combined
    var allItems = d.prepare('SELECT genres, styles, artist FROM wantlist WHERE user_id=? AND active=1').all(user.id)
        .concat(d.prepare('SELECT genres, styles, artist FROM collection WHERE user_id=?').all(user.id));
    var gC = {}, sC = {}, aC = {};
    allItems.forEach(function(w) {
        (w.genres||'').split('|').forEach(function(g){ g=g.trim(); if(g) gC[g]=(gC[g]||0)+1; });
        (w.styles||'').split('|').forEach(function(s){ s=s.trim(); if(s) sC[s]=(sC[s]||0)+1; });
        var a=(w.artist||'').trim(); if(a&&a!=='Various'&&a!=='Various Artists') aC[a]=(aC[a]||0)+1;
    });
    var topGenres  = Object.entries(gC).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,count])=>({name,count}));
    var topStyles  = Object.entries(sC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}));
    var topArtists = Object.entries(aC).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,count])=>({name,count}));

    // Rarity from release_meta
    var meta = d.prepare('SELECT AVG(rm.community_have) as avgHave, AVG(rm.community_want) as avgWant, COUNT(*) as synced FROM wantlist w JOIN release_meta rm ON rm.discogs_id=w.discogs_id WHERE w.user_id=? AND w.active=1').get(user.id);
    var rareCount = d.prepare('SELECT COUNT(*) as c FROM wantlist w JOIN release_meta rm ON rm.discogs_id=w.discogs_id WHERE w.user_id=? AND w.active=1 AND rm.community_have < 200').get(user.id).c;

    // Era
    var yearRows = d.prepare('SELECT COALESCE(rm.year,w.year) as yr, COUNT(*) as cnt FROM wantlist w LEFT JOIN release_meta rm ON rm.discogs_id=w.discogs_id WHERE w.user_id=? AND w.active=1 AND COALESCE(rm.year,w.year) > 1950 GROUP BY yr').all(user.id);
    var decades = {};
    yearRows.forEach(function(r){ var k=(Math.floor(r.yr/10)*10%100)+'s'; decades[k]=(decades[k]||0)+r.cnt; });
    var topDecade = Object.entries(decades).sort((a,b)=>b[1]-a[1])[0];

    // Personality tags — computed inline (no circular require needed)
    var avgHave = meta && meta.synced > 0 ? Math.round(meta.avgHave) : null;
    var personalityTags = computePersonalityTags(gC, sC, allItems.length, avgHave, topDecade ? topDecade[0] : null);

    // Quick gem summary from streaming_metadata (non-fatal — may not exist yet)
    var gemSummary = null;
    try {
        var allDiscogsIds = d.prepare(`
            SELECT discogs_id FROM (
                SELECT discogs_id FROM wantlist   WHERE user_id=? AND active=1 AND discogs_id IS NOT NULL
                UNION
                SELECT discogs_id FROM collection WHERE user_id=? AND discogs_id IS NOT NULL
            )
        `).all(user.id, user.id).map(function(r){ return r.discogs_id; });

        if (allDiscogsIds.length > 0) {
            var gph = allDiscogsIds.map(function(){ return '?'; }).join(',');
            var smSummary = d.prepare(
                'SELECT youtube_view_count, youtube_enriched_at FROM streaming_metadata' +
                ' WHERE discogs_id IN (' + gph + ')'
            ).all(...allDiscogsIds);

            var enrichedG = smSummary.filter(function(s){ return s.youtube_enriched_at; }).length;
            var undergroundG = smSummary.filter(function(s){ return s.youtube_enriched_at && (s.youtube_view_count||0) < 10000; }).length;
            var undergroundPctG = enrichedG > 0 ? Math.round(undergroundG/enrichedG*100) : null;

            // Tier counts from gem-score
            var gsModule = require('./lib/gem-score');
            var rmSummary = d.prepare(
                'SELECT discogs_id, community_have, community_want FROM release_meta WHERE discogs_id IN (' + gph + ')'
            ).all(...allDiscogsIds);
            var rmMapG = {};
            rmSummary.forEach(function(r){ rmMapG[r.discogs_id] = r; });

            var smFull = d.prepare(
                'SELECT discogs_id, youtube_video_id, youtube_view_count, youtube_like_count,' +
                ' youtube_comment_data, youtube_enriched_at FROM streaming_metadata WHERE discogs_id IN (' + gph + ')'
            ).all(...allDiscogsIds);

            var tierG = { hidden_gem:0, club_weapon:0, deep_cut:0, known_quantity:0, unscored:0 };
            smFull.forEach(function(sm){
                var scored = gsModule.scoreRelease(sm, rmMapG[sm.discogs_id]||null);
                var t = scored.tier || 'unscored';
                tierG[t] = (tierG[t]||0) + 1;
            });
            tierG.unscored += allDiscogsIds.length - smFull.length;

            gemSummary = {
                undergroundIndex: undergroundPctG,
                enrichedPct:      allDiscogsIds.length > 0 ? Math.round(enrichedG/allDiscogsIds.length*100) : 0,
                tierCounts:       tierG,
                tip:              enrichedG < allDiscogsIds.length * 0.5 ?
                    'Only ' + enrichedG + '/' + allDiscogsIds.length + ' releases enriched — call get_gem_intelligence for full detail.' : null
            };
        }
    } catch(e) { /* non-fatal — gem module may not be available */ }

    return {
        username:        user.username,
        wantlistSize:    wantlistSize,
        collectionSize:  collectionSize,
        inStockCount:    inStockCount,
        inStockPct:      wantlistSize > 0 ? +(inStockCount/wantlistSize*100).toFixed(1) : 0,
        neverFound:      neverFound,
        topGenres:       topGenres,
        topStyles:       topStyles,
        topArtists:      topArtists,
        era:             { topDecade: topDecade ? topDecade[0] : null, breakdown: decades },
        rarity:          { avgHave: avgHave,
                           avgWant: meta && meta.synced > 0 ? Math.round(meta.avgWant) : null,
                           rarePct: meta && meta.synced > 0 ? Math.round(rareCount/meta.synced*100) : null,
                           metaSynced: meta ? meta.synced : 0 },
        personalityTags: personalityTags,
        gemIntelSummary: gemSummary,
        lastScan:        user.last_full_scan,
        lastSync:        user.last_sync
    };
}

function toolGetInStock({ username, store, max_have, sort, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found' };
    limit = Math.min(limit || 30, 100);

    var rows = d.prepare(`
        SELECT w.artist, w.title, w.year, w.label, w.thumb, w.discogs_id,
               sr.store, sr.matches, sr.search_url,
               rm.community_have, rm.community_want, rm.avg_rating
        FROM wantlist w
        JOIN store_results sr ON sr.wantlist_id = w.id
        LEFT JOIN release_meta rm ON rm.discogs_id = w.discogs_id
        WHERE w.user_id = ? AND w.active = 1 AND sr.in_stock = 1
          AND sr.link_only = 0
          ${store ? "AND sr.store = '" + store.replace(/'/g,"''") + "'" : ''}
          ${max_have ? 'AND (rm.community_have IS NULL OR rm.community_have < ' + max_have + ')' : ''}
        ORDER BY ${sort === 'price_asc' ? 'sr.store' : sort === 'price_desc' ? 'sr.store DESC' : sort === 'artist' ? 'w.artist' : 'rm.community_have ASC NULLS LAST'}
        LIMIT ?
    `).all(user.id, limit);

    return rows.map(function(r) {
        var matches = [];
        try { matches = JSON.parse(r.matches || '[]'); } catch(e) {}
        var price = matches.length > 0 ? matches[0].price : null;
        return {
            artist:          r.artist,
            title:           r.title,
            year:            r.year,
            label:           r.label,
            store:           r.store,
            price:           price,
            community_have:  r.community_have,
            community_want:  r.community_want,
            avg_rating:      r.avg_rating,
            url:             r.search_url,
            discogs_id:      r.discogs_id
        };
    });
}

function toolSuggestCart({ username, max_budget, stores, min_items_per_store, prioritize }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found' };
    min_items_per_store = min_items_per_store || 2;
    prioritize = prioritize || 'taste';

    // Get all in-stock items
    var rows = d.prepare(`
        SELECT w.artist, w.title, w.year, w.label, w.genres, w.styles,
               sr.store, sr.matches,
               rm.community_have, rm.community_want, rm.avg_rating,
               w.discogs_id
        FROM wantlist w
        JOIN store_results sr ON sr.wantlist_id=w.id
        LEFT JOIN release_meta rm ON rm.discogs_id=w.discogs_id
        WHERE w.user_id=? AND w.active=1 AND sr.in_stock=1 AND sr.link_only=0
    `).all(user.id);

    // Filter by stores if specified
    if (stores && stores.length > 0) {
        rows = rows.filter(function(r){ return stores.indexOf(r.store) !== -1; });
    }

    // Parse prices
    rows = rows.map(function(r) {
        var matches = [];
        try { matches = JSON.parse(r.matches||'[]'); } catch(e) {}
        var priceStr = matches.length > 0 ? matches[0].price : null;
        var priceNum = priceStr ? parseFloat(priceStr.replace(/[^0-9.]/g,'')) || null : null;
        return Object.assign({}, r, { price: priceStr, priceNum: priceNum, matches: undefined });
    });

    // Group by store
    var byStore = {};
    rows.forEach(function(r) {
        if (!byStore[r.store]) byStore[r.store] = [];
        byStore[r.store].push(r);
    });

    // Score items per store
    var carts = [];
    Object.keys(byStore).forEach(function(storeName) {
        var items = byStore[storeName];
        if (items.length < min_items_per_store) return;

        // Score each item
        items = items.map(function(item) {
            var score = 0;
            if (prioritize === 'rarity') {
                score = item.community_have ? (1000 / (item.community_have + 1)) : 10;
            } else if (prioritize === 'value') {
                score = item.priceNum ? (50 / item.priceNum) : 5; // cheaper = higher score
            } else { // taste — default
                score = item.community_have ? (500 / (item.community_have + 1)) : 5;
                if (item.avg_rating && item.avg_rating > 4) score += 2;
            }
            return Object.assign({}, item, { score: score });
        }).sort(function(a,b){ return b.score - a.score; });

        var cartItems = items;
        var totalUsd = cartItems.reduce(function(s,i){ return s + (i.priceNum||0); }, 0);

        // Budget check
        if (max_budget && totalUsd > max_budget) return;

        carts.push({
            store: storeName,
            item_count: cartItems.length,
            total_est: totalUsd > 0 ? '$' + totalUsd.toFixed(2) + ' est.' : 'prices vary',
            items: cartItems.slice(0,8).map(function(i){
                return {
                    artist: i.artist, title: i.title, year: i.year,
                    price: i.price, community_have: i.community_have,
                    score: Math.round(i.score * 10) / 10
                };
            })
        });
    });

    // Sort carts by item count
    carts.sort(function(a,b){ return b.item_count - a.item_count; });
    return { carts: carts, total_stores: carts.length, prioritized_by: prioritize };
}

// ── Taste match helpers ───────────────────────────────────────────────────────

function buildTasteProfile(d, userId) {
    var want = d.prepare('SELECT discogs_id,genres,styles,label,year,artist FROM wantlist WHERE user_id=? AND active=1').all(userId);
    var coll = d.prepare('SELECT discogs_id,genres,styles,label,year,artist FROM collection WHERE user_id=?').all(userId);
    var all  = want.concat(coll);

    var styles = {}, genres = {}, labels = {}, artists = {};
    var decades = { '60s':0,'70s':0,'80s':0,'90s':0,'00s':0,'10s':0,'20s':0 };
    var total = all.length || 1;

    // Artists to skip — too generic to be a taste signal
    var SKIP_ARTISTS = new Set(['various', 'various artists', 'va', 'v/a', 'v.a.', 'unknown', '']);

    all.forEach(function(r) {
        // Wantlist/collection stores genres+styles as comma-separated strings ("Tech House, Breaks")
        (r.styles||'').split(/,\s*/).forEach(function(s){ s=s.trim(); if(s) styles[s]=(styles[s]||0)+1; });
        (r.genres||'').split(/,\s*/).forEach(function(g){ g=g.trim(); if(g) genres[g]=(genres[g]||0)+1; });
        if (r.label) {
            r.label.split(/[,/]/).forEach(function(l){
                l=l.trim().replace(/\s*\d+\s*$/, '').trim();
                if (l && l.length > 1) labels[l]=(labels[l]||0)+1;
            });
        }
        if (r.artist) {
            // Normalise: lowercase, strip trailing "- EP/LP/etc", collapse spaces
            var a = r.artist.toLowerCase().replace(/\s*[-–]\s*(ep|lp|12["’]|single).*$/i,'').trim();
            if (a && !SKIP_ARTISTS.has(a)) artists[a]=(artists[a]||0)+1;
        }
        if (r.year) {
            var yr = parseInt(r.year);
            if (yr >= 1960 && yr < 1970) decades['60s']++;
            else if (yr >= 1970 && yr < 1980) decades['70s']++;
            else if (yr >= 1980 && yr < 1990) decades['80s']++;
            else if (yr >= 1990 && yr < 2000) decades['90s']++;
            else if (yr >= 2000 && yr < 2010) decades['00s']++;
            else if (yr >= 2010 && yr < 2020) decades['10s']++;
            else if (yr >= 2020) decades['20s']++;
        }
    });

    // Rarity: median community_have from release_meta
    var discogsIds = want.map(function(w){ return w.discogs_id; }).filter(Boolean);
    var medianHave = null;
    if (discogsIds.length) {
        try {
            var haveRows = d.prepare(
                'SELECT community_have FROM release_meta WHERE discogs_id IN (' +
                discogsIds.slice(0,200).map(function(){ return '?'; }).join(',') + ') AND community_have IS NOT NULL'
            ).all(...discogsIds.slice(0,200));
            if (haveRows.length) {
                var sorted = haveRows.map(function(r){ return r.community_have; }).sort(function(a,b){ return a-b; });
                medianHave = sorted[Math.floor(sorted.length/2)];
            }
        } catch(e) {}
    }

    // Underground %: from streaming_metadata
    var undergroundPct = null;
    try {
        var smRows = d.prepare(`
            SELECT sm.youtube_view_count FROM streaming_metadata sm
            JOIN wantlist w ON w.discogs_id=sm.discogs_id
            WHERE w.user_id=? AND w.active=1 AND sm.youtube_view_count IS NOT NULL
        `).all(userId);
        if (smRows.length) {
            var ugCount = smRows.filter(function(r){ return r.youtube_view_count < 10000; }).length;
            undergroundPct = Math.round(ugCount / smRows.length * 100);
        }
    } catch(e) {}

    return { styles, genres, labels, artists, decades, total, medianHave, undergroundPct };
}

function cosineSim(vecA, vecB) {
    var allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
    var dot=0, magA=0, magB=0;
    allKeys.forEach(function(k) {
        var a = vecA[k]||0, b = vecB[k]||0;
        dot  += a*b;
        magA += a*a;
        magB += b*b;
    });
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function jaccardLabels(labA, labB) {
    var s1 = new Set(Object.keys(labA)), s2 = new Set(Object.keys(labB));
    var inter=0; s1.forEach(function(x){ if(s2.has(x)) inter++; });
    var union = s1.size + s2.size - inter;
    return union > 0 ? inter/union : 0;
}

function eraSim(decA, decB) {
    return cosineSim(decA, decB);
}

function rarityAlign(medA, medB) {
    if (medA == null || medB == null) return null;
    // Both in same rarity band? Score by closeness of log-scale median
    var logA = Math.log(Math.max(medA,1)), logB = Math.log(Math.max(medB,1));
    var maxLog = Math.log(50000);
    var dist = Math.abs(logA - logB) / maxLog;
    return Math.max(0, 1 - dist);
}

function undergroundAlign(pctA, pctB) {
    if (pctA == null || pctB == null) return null;
    return 1 - Math.abs(pctA - pctB) / 100;
}

function computeTasteMatch(pA, pB) {
    var styleSim  = cosineSim(pA.styles,  pB.styles);
    var artistSim = cosineSim(pA.artists, pB.artists);
    var eraS      = eraSim(pA.decades, pB.decades);
    var rarityS   = rarityAlign(pA.medianHave, pB.medianHave);
    var labelS    = jaccardLabels(pA.labels, pB.labels);
    var ugS       = undergroundAlign(pA.undergroundPct, pB.undergroundPct);

    // Weights — rarity/underground are optional (null if data unavailable, excluded from denominator)
    // style:30  artist:15  era:20  rarity:15  label:10  underground:10
    var weights = { style: 0.30, artist: 0.15, era: 0.20, rarity: 0.15, label: 0.10, underground: 0.10 };
    var score = 0, totalW = 0;
    score += styleSim  * weights.style;    totalW += weights.style;
    score += artistSim * weights.artist;   totalW += weights.artist;
    score += eraS      * weights.era;      totalW += weights.era;
    if (rarityS != null) { score += rarityS * weights.rarity;     totalW += weights.rarity; }
    score += labelS    * weights.label;    totalW += weights.label;
    if (ugS     != null) { score += ugS     * weights.underground; totalW += weights.underground; }
    var pct = totalW > 0 ? Math.round(score / totalW * 100) : 0;

    return {
        overall:    pct,
        style:      Math.round(styleSim  * 100),
        artist:     Math.round(artistSim * 100),
        era:        Math.round(eraS      * 100),
        rarity:     rarityS != null ? Math.round(rarityS * 100) : null,
        label:      Math.round(labelS    * 100),
        underground: ugS != null ? Math.round(ugS * 100) : null
    };
}

// ── Tool functions ────────────────────────────────────────────────────────────

function toolGetDiggers({ for_user }) {
    var d = db.getDb();
    var forProfile = null;
    if (for_user) {
        var fu = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(for_user);
        if (fu) forProfile = buildTasteProfile(d, fu.id);
    }
    var users = d.prepare('SELECT id, username, last_full_scan FROM users ORDER BY username').all();
    return users.map(function(u) {
        var wc = d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1').get(u.id).c;
        var ic = d.prepare('SELECT COUNT(DISTINCT w.id) as c FROM wantlist w JOIN store_results sr ON sr.wantlist_id=w.id WHERE w.user_id=? AND w.active=1 AND sr.in_stock=1').get(u.id).c;
        var profile = buildTasteProfile(d, u.id);
        var topGenres = Object.entries(profile.genres).sort(function(a,b){ return b[1]-a[1]; }).slice(0,3).map(function(e){ return e[0]; });
        var row = { username: u.username, wantlist: wc, inStock: ic, topGenres: topGenres, lastScan: u.last_full_scan };
        if (forProfile && u.username !== for_user) {
            row.tasteMatch = computeTasteMatch(forProfile, profile);
        }
        return row;
    });
}

function toolSearchWantlist({ username, query, genre, style, in_stock_only }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found' };
    var q = '%' + (query||'').toLowerCase() + '%';
    var rows = d.prepare(`
        SELECT w.artist, w.title, w.year, w.label, w.genres, w.styles, w.thumb, w.discogs_id,
               GROUP_CONCAT(DISTINCT sr.store) as stores_in_stock
        FROM wantlist w
        LEFT JOIN store_results sr ON sr.wantlist_id=w.id AND sr.in_stock=1 AND sr.link_only=0
        WHERE w.user_id=? AND w.active=1
          AND (LOWER(w.artist) LIKE ? OR LOWER(w.title) LIKE ? OR LOWER(w.label) LIKE ?)
          ${genre ? "AND LOWER(w.genres) LIKE '%" + genre.toLowerCase().replace(/'/g,"''") + "%'" : ''}
          ${style ? "AND LOWER(w.styles) LIKE '%" + style.toLowerCase().replace(/'/g,"''") + "%'" : ''}
        GROUP BY w.id
        ${in_stock_only ? 'HAVING stores_in_stock IS NOT NULL' : ''}
        LIMIT 20
    `).all(user.id, q, q, q);
    return rows.map(function(r){
        return {
            artist: r.artist, title: r.title, year: r.year, label: r.label,
            genres: r.genres, styles: r.styles,
            in_stock: !!r.stores_in_stock,
            stores: r.stores_in_stock ? r.stores_in_stock.split(',') : []
        };
    });
}

function toolGetStoreBreakdown({ username, store }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found' };
    var items = d.prepare(`
        SELECT w.artist, w.title, w.year, w.genres, sr.matches, rm.community_have
        FROM wantlist w
        JOIN store_results sr ON sr.wantlist_id=w.id
        LEFT JOIN release_meta rm ON rm.discogs_id=w.discogs_id
        WHERE w.user_id=? AND w.active=1 AND sr.store=? AND sr.in_stock=1 AND sr.link_only=0
        ORDER BY rm.community_have ASC NULLS LAST
    `).all(user.id, store);
    var gC = {};
    items.forEach(function(i){ (i.genres||'').split('|').forEach(function(g){ g=g.trim(); if(g) gC[g]=(gC[g]||0)+1; }); });
    var topGenres = Object.entries(gC).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,c])=>({name:n,count:c}));
    return {
        store: store, itemsInStock: items.length, topGenres: topGenres,
        items: items.slice(0,15).map(function(i){
            var m=[]; try{m=JSON.parse(i.matches||'[]');}catch(e){}
            return { artist:i.artist, title:i.title, year:i.year, price:m[0]?m[0].price:null, community_have:i.community_have };
        })
    };
}

function toolGetRareFinds({ username, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found' };
    limit = Math.min(limit||10, 30);
    var rows = d.prepare(`
        SELECT w.artist, w.title, w.year, w.label,
               sr.store, sr.matches, rm.community_have, rm.community_want, rm.avg_rating
        FROM wantlist w
        JOIN store_results sr ON sr.wantlist_id=w.id
        JOIN release_meta rm ON rm.discogs_id=w.discogs_id
        WHERE w.user_id=? AND w.active=1 AND sr.in_stock=1 AND sr.link_only=0
          AND rm.community_have IS NOT NULL
        ORDER BY rm.community_have ASC
        LIMIT ?
    `).all(user.id, limit);
    return rows.map(function(r){
        var m=[]; try{m=JSON.parse(r.matches||'[]');}catch(e){}
        return { artist:r.artist, title:r.title, year:r.year, label:r.label,
                 store:r.store, price:m[0]?m[0].price:null,
                 community_have:r.community_have, community_want:r.community_want, avg_rating:r.avg_rating,
                 rarity_label: r.community_have < 50 ? 'Ultra rare' : r.community_have < 200 ? 'Rare' : 'Uncommon' };
    });
}

function toolCompareDiggers({ username1, username2 }) {
    var d = db.getDb();
    var u1 = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username1);
    var u2 = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username2);
    if (!u1) return { error: username1 + ' not found' };
    if (!u2) return { error: username2 + ' not found' };

    var p1 = buildTasteProfile(d, u1.id);
    var p2 = buildTasteProfile(d, u2.id);
    var match = computeTasteMatch(p1, p2);

    // Shared wantlist items
    var shared = d.prepare(`
        SELECT w1.artist, w1.title, w1.year,
               (SELECT GROUP_CONCAT(DISTINCT sr.store) FROM store_results sr WHERE sr.wantlist_id=w1.id AND sr.in_stock=1) as stores
        FROM wantlist w1
        JOIN wantlist w2 ON w2.discogs_id=w1.discogs_id AND w2.user_id=? AND w2.active=1
        WHERE w1.user_id=? AND w1.active=1
        LIMIT 10
    `).all(u2.id, u1.id);

    // Shared styles (more specific than genres)
    var allStyles = new Set([...Object.keys(p1.styles), ...Object.keys(p2.styles)]);
    var sharedStyles = [];
    allStyles.forEach(function(s) {
        if (p1.styles[s] && p2.styles[s]) sharedStyles.push({ style: s, u1: p1.styles[s], u2: p2.styles[s] });
    });
    sharedStyles.sort(function(a,b){ return (b.u1+b.u2)-(a.u1+a.u2); });

    // Shared labels
    var allLabels = new Set([...Object.keys(p1.labels), ...Object.keys(p2.labels)]);
    var sharedLabels = [];
    allLabels.forEach(function(l) {
        if (p1.labels[l] && p2.labels[l]) sharedLabels.push({ label: l, u1: p1.labels[l], u2: p2.labels[l] });
    });
    sharedLabels.sort(function(a,b){ return (b.u1+b.u2)-(a.u1+a.u2); });

    // Shared artists
    var allArtists = new Set([...Object.keys(p1.artists), ...Object.keys(p2.artists)]);
    var sharedArtists = [];
    allArtists.forEach(function(a) {
        if (p1.artists[a] && p2.artists[a]) sharedArtists.push({ artist: a, u1: p1.artists[a], u2: p2.artists[a] });
    });
    sharedArtists.sort(function(a,b){ return (b.u1+b.u2)-(a.u1+a.u2); });

    // Era breakdown
    var eraBreakdown = Object.keys(p1.decades).map(function(decade) {
        return { decade, [username1]: p1.decades[decade], [username2]: p2.decades[decade] };
    }).filter(function(r) { return r[username1] > 0 || r[username2] > 0; });

    return {
        username1, username2,
        taste_match: {
            overall:     match.overall + '%',
            style:       match.style + '% — style vector cosine similarity',
            artist:      match.artist + '% — shared artists in their collections',
            era:         match.era + '% — same decades',
            rarity:      match.rarity != null ? match.rarity + '% — both dig deep vs mainstream' : 'n/a (no rarity data)',
            label:       match.label + '% — shared record labels',
            underground: match.underground != null ? match.underground + '% — similar underground index' : 'n/a (enrichment pending)'
        },
        shared_wantlist_items: shared.length,
        shared_items_sample:   shared.slice(0, 5),
        shared_styles:         sharedStyles.slice(0, 10),
        shared_artists:        sharedArtists.slice(0, 8),
        shared_labels:         sharedLabels.slice(0, 8),
        era_breakdown:         eraBreakdown,
        u1_rarity_median_have: p1.medianHave,
        u2_rarity_median_have: p2.medianHave,
        u1_underground_pct:    p1.undergroundPct != null ? p1.undergroundPct + '%' : null,
        u2_underground_pct:    p2.undergroundPct != null ? p2.undergroundPct + '%' : null,
        u1_unique_styles:      Object.entries(p1.styles).filter(function([s]){ return !p2.styles[s]; }).sort(function(a,b){ return b[1]-a[1]; }).slice(0,5).map(function([n,c]){ return { style:n, count:c }; }),
        u2_unique_styles:      Object.entries(p2.styles).filter(function([s]){ return !p1.styles[s]; }).sort(function(a,b){ return b[1]-a[1]; }).slice(0,5).map(function([n,c]){ return { style:n, count:c }; }),
        u1_top_artists:        Object.entries(p1.artists).sort(function(a,b){ return b[1]-a[1]; }).slice(0,5).map(function([n,c]){ return { artist:n, count:c }; }),
        u2_top_artists:        Object.entries(p2.artists).sort(function(a,b){ return b[1]-a[1]; }).slice(0,5).map(function([n,c]){ return { artist:n, count:c }; })
    };
}

// Condition rank for filtering (higher = better)
var CONDITION_RANK = { 'M': 6, 'NM': 5, 'VG+': 4, 'VG': 3, 'G+': 2, 'G': 1, 'F': 0 };
function conditionRank(c) {
    if (!c) return -1;
    var norm = c.replace(/\s*\(.*\)/, '').trim().toUpperCase().replace('NEAR MINT', 'NM').replace('VERY GOOD PLUS', 'VG+').replace('VERY GOOD', 'VG').replace('GOOD PLUS', 'G+');
    return CONDITION_RANK[norm] !== undefined ? CONDITION_RANK[norm] : -1;
}

function toolGetDiscogsMarketplace({ username, query, min_condition, ships_from, max_price_usd, min_seller_rating, sort, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };
    limit = Math.min(limit || 20, 100);

    // Build query — join discogs_listings with wantlist
    var q = '%' + (query || '').toLowerCase() + '%';
    var hasQuery = !!(query && query.trim());

    var rows = d.prepare(`
        SELECT dl.listing_id, dl.seller_username, dl.seller_rating, dl.seller_num_ratings,
               dl.price_usd, dl.price_original, dl.currency, dl.condition, dl.ships_from,
               dl.listing_url, dl.fetched_at,
               w.artist, w.title, w.year, w.label, w.discogs_id,
               dp.lowest_price as market_low, dp.num_for_sale, dp.currency as market_currency
        FROM discogs_listings dl
        JOIN wantlist w ON w.id = dl.wantlist_id
        LEFT JOIN discogs_prices dp ON dp.wantlist_id = w.id
        WHERE w.user_id = ? AND w.active = 1
          ${hasQuery ? "AND (LOWER(w.artist) LIKE ? OR LOWER(w.title) LIKE ?)" : ''}
          ${max_price_usd ? 'AND (dl.price_usd IS NULL OR dl.price_usd <= ' + parseFloat(max_price_usd) + ')' : ''}
          ${min_seller_rating ? 'AND (dl.seller_rating IS NULL OR dl.seller_rating >= ' + parseFloat(min_seller_rating) + ')' : ''}
          ${ships_from ? "AND LOWER(dl.ships_from) LIKE '%" + ships_from.toLowerCase().replace(/'/g,"''") + "%'" : ''}
    `).all(...(hasQuery ? [user.id, q, q] : [user.id]));

    // Filter by condition client-side (easier than SQL for ranked comparison)
    if (min_condition) {
        var minRank = conditionRank(min_condition);
        rows = rows.filter(function(r) { return conditionRank(r.condition) >= minRank; });
    }

    // Sort
    if (sort === 'price_desc') {
        rows.sort(function(a,b){ return (b.price_usd||999)-(a.price_usd||999); });
    } else if (sort === 'condition') {
        rows.sort(function(a,b){ return conditionRank(b.condition)-conditionRank(a.condition); });
    } else if (sort === 'seller_rating') {
        rows.sort(function(a,b){ return (b.seller_rating||0)-(a.seller_rating||0); });
    } else {
        // price_asc (default)
        rows.sort(function(a,b){ return (a.price_usd||999)-(b.price_usd||999); });
    }

    var total = rows.length;
    rows = rows.slice(0, limit);

    if (total === 0) {
        return {
            listings: [],
            total: 0,
            message: 'No Discogs marketplace listings found' + (query ? ' for "' + query + '"' : '') + '. Run a marketplace sync from the app or use the Wax Digger Chrome extension to fetch seller data.'
        };
    }

    return {
        total: total,
        showing: rows.length,
        listings: rows.map(function(r) {
            return {
                artist:          r.artist,
                title:           r.title,
                year:            r.year,
                condition:       r.condition || 'Unknown',
                price_usd:       r.price_usd ? '$' + r.price_usd.toFixed(2) : null,
                price_original:  r.price_original ? r.price_original + ' ' + (r.currency || '') : null,
                seller:          r.seller_username,
                seller_rating:   r.seller_rating ? r.seller_rating + '%' : null,
                seller_ratings_count: r.seller_num_ratings,
                ships_from:      r.ships_from || null,
                listing_url:     r.listing_url || null,
                market_low:      r.market_low ? '$' + parseFloat(r.market_low).toFixed(2) + ' (Discogs low)' : null,
                num_for_sale:    r.num_for_sale || null,
                discogs_id:      r.discogs_id,
                synced_at:       r.fetched_at
            };
        })
    };
}

// GOLDIE's internal vinyl-checker URL (same machine, different port)
var CHECKER_URL = 'http://127.0.0.1:' + (process.env.PORT || '5052');

// Shared HTTP helper — POST JSON to vinyl-checker server
function postToChecker(path, bodyObj) {
    return new Promise(function(resolve) {
        var bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
        var opts = require('url').parse(CHECKER_URL + path);
        opts.method = 'POST';
        opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
        var req = http.request(opts, function(res) {
            var body = '';
            res.on('data', function(c){ body += c; });
            res.on('end', function(){
                try { resolve(JSON.parse(body)); } catch(e) { resolve({ raw: body }); }
            });
        });
        req.on('error', function(e){ resolve({ error: e.message }); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function toolGetOptimizerResult({ username, max_age_hours, show_discogs_sellers, limit_sellers }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };

    max_age_hours = max_age_hours || 24;
    limit_sellers = limit_sellers || 5;

    // Check for active job first
    var activeJob = d.prepare(
        "SELECT id, status, created_at FROM optimizer_jobs WHERE username=? AND status IN ('pending','processing') ORDER BY created_at DESC LIMIT 1"
    ).get(username);

    // Get latest completed result
    var cutoff = new Date(Date.now() - max_age_hours * 3600 * 1000).toISOString();
    var job = d.prepare(
        "SELECT id, completed_at, result FROM optimizer_jobs WHERE username=? AND status='done' AND completed_at>? ORDER BY completed_at DESC LIMIT 1"
    ).get(username, cutoff);

    if (!job || !job.result) {
        return {
            found: false,
            active_job: activeJob ? { id: activeJob.id, status: activeJob.status } : null,
            message: activeJob
                ? 'Optimization is currently ' + activeJob.status + '. Check back shortly.'
                : 'No recent optimization found (within ' + max_age_hours + 'h). Use run_optimizer to start one, or ask the user to click Optimize in the app.'
        };
    }

    var r;
    try { r = JSON.parse(job.result); } catch(e) { return { error: 'Could not parse optimizer result' }; }

    var storeEntries   = (r.cart || []).filter(function(c){ return c.sourceType === 'store'; });
    var sellerEntries  = (r.cart || []).filter(function(c){ return c.sourceType === 'discogs'; });

    // Best store entries (full detail)
    var storeCarts = storeEntries.map(function(s) {
        return {
            store:          s.sourceName,
            source_id:      s.sourceId,
            items:          s.items.length,
            subtotal_usd:   +(s.subtotalUsd || 0).toFixed(2),
            shipping_usd:   +(s.shippingCostUsd || 0).toFixed(2),
            total_usd:      +(s.totalUsd || 0).toFixed(2),
            records:        s.items.map(function(i){ return { artist: i.artist, title: i.title, condition: i.condition, price_usd: i.priceUsd }; })
        };
    });

    // Top Discogs sellers
    var topSellers = sellerEntries
        .sort(function(a,b){ return b.items.length - a.items.length; })
        .slice(0, show_discogs_sellers ? limit_sellers : 3)
        .map(function(s) {
            return {
                seller:       s.sellerUsername,
                country:      s.country,
                rating:       s.sellerRating,
                rating_count: s.sellerNumRatings,
                items:        s.items.length,
                subtotal_usd: +(s.subtotalUsd || 0).toFixed(2),
                shipping_usd: +(s.shippingCostUsd || 0).toFixed(2),
                total_usd:    +(s.totalUsd || 0).toFixed(2),
                records:      s.items.slice(0,4).map(function(i){ return { artist: i.artist, title: i.title, condition: i.condition, price_usd: i.priceUsd }; })
            };
        });

    return {
        found:               true,
        completed_at:        job.completed_at,
        covered_items:       r.covered,
        total_wantlist:      r.total,
        uncovered_items:     r.uncoveredItems ? r.uncoveredItems.length : (r.total - r.covered),
        grand_total_usd:     +(r.grandTotalUsd   || 0).toFixed(2),
        grand_shipping_usd:  +(r.grandShippingUsd|| 0).toFixed(2),
        grand_records_usd:   +(r.grandRecordsUsd || 0).toFixed(2),
        num_sources:         r.numSellers,
        store_count:         storeEntries.length,
        discogs_seller_count:sellerEntries.length,
        store_carts:         storeCarts,
        top_discogs_sellers: topSellers,
        note: 'This covers ' + r.covered + '/' + r.total + ' wantlist items. ' + sellerEntries.length + ' Discogs sellers + ' + storeEntries.length + ' scraped stores.'
    };
}

async function toolRunOptimizer({ username, min_condition, min_seller_rating, max_price_usd, force_refresh }) {
    var result = await postToChecker('/api/optimize/' + encodeURIComponent(username), {
        minCondition:    min_condition    || 'VG',
        minSellerRating: min_seller_rating != null ? min_seller_rating : 98,
        maxPriceUsd:     max_price_usd    || null,
        forceRefresh:    force_refresh    === true
    });

    if (result.error) return { error: result.error };

    return {
        started:        true,
        job_id:         result.jobId,
        status:         result.status,
        queue_position: result.queuePosition,
        reused:         result.reused,
        message: result.reused
            ? 'Optimizer found a fresh cached result — use get_optimizer_result to see it immediately.'
            : 'Optimization job queued (position ' + (result.queuePosition || 1) + '). Takes 1-2 minutes. Use get_optimizer_result to check when done.'
    };
}

async function toolTriggerSync({ username, type }) {
    type = type || 'both';
    var results = {};

    if (type === 'wantlist' || type === 'both') {
        results.wantlist = await postToChecker('/api/sync-now/' + encodeURIComponent(username));
    }
    if (type === 'marketplace' || type === 'both') {
        results.marketplace = await postToChecker('/api/marketplace-sync/' + encodeURIComponent(username));
    }

    // Summarise for GOLDIE
    var wMsg = results.wantlist
        ? (results.wantlist.started ? 'Wantlist sync started.' : results.wantlist.message || 'Wantlist: ' + JSON.stringify(results.wantlist))
        : null;
    var mMsg = results.marketplace
        ? (results.marketplace.started
            ? 'Marketplace sync started for ' + (results.marketplace.total || '?') + ' items.'
            : results.marketplace.message || 'Marketplace: already running or error.')
        : null;

    return {
        status: 'triggered',
        username: username,
        type: type,
        wantlist:    wMsg,
        marketplace: mMsg,
        note: 'Syncs run in the background. Check back in a minute or two for fresh data.'
    };
}

async function toolGetSyncStatus({ username }) {
    // Hit the live status endpoint
    var status = await new Promise(function(resolve) {
        var opts = require('url').parse(CHECKER_URL + '/api/marketplace-sync/' + encodeURIComponent(username) + '/status');
        http.get(opts, function(res) {
            var body = '';
            res.on('data', function(c){ body += c; });
            res.on('end', function(){
                try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
            });
        }).on('error', function(e){ resolve({ error: e.message }); });
    });

    // Also count how many listings are already in the DB
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    var listingCount = 0;
    var itemsCovered = 0;
    if (user) {
        listingCount = (d.prepare(
            'SELECT COUNT(*) as c FROM discogs_listings dl JOIN wantlist w ON w.id=dl.wantlist_id WHERE w.user_id=?'
        ).get(user.id) || {c:0}).c;
        itemsCovered = (d.prepare(
            'SELECT COUNT(DISTINCT dl.wantlist_id) as c FROM discogs_listings dl JOIN wantlist w ON w.id=dl.wantlist_id WHERE w.user_id=?'
        ).get(user.id) || {c:0}).c;
    }

    var elapsedSec = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : null;
    var pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

    if (!status.running && !status.done) {
        return {
            running: false,
            message: 'No marketplace sync has been triggered yet. Use trigger_sync to start one.',
            listings_in_db: listingCount,
            items_covered: itemsCovered
        };
    }

    return {
        running:        status.running || false,
        done:           status.done    || 0,
        total:          status.total   || 0,
        pct_complete:   pct,
        errors:         status.errors  || 0,
        elapsed_sec:    elapsedSec,
        completed_at:   status.completedAt ? new Date(status.completedAt).toISOString() : null,
        listings_in_db: listingCount,
        items_covered:  itemsCovered,
        message: status.running
            ? pct + '% done (' + status.done + '/' + status.total + ' items scraped, ' + elapsedSec + 's elapsed). ' + listingCount + ' listings in DB so far.'
            : 'Sync complete. ' + listingCount + ' listings across ' + itemsCovered + ' wantlist items now in DB.'
    };
}

// Store checkout URL map
var STORE_CHECKOUT_URLS = {
    'HHV':                  'https://www.hhv.de/cart',
    'Juno':                 'https://www.juno.co.uk/basket/',
    'Deejay.de':            'https://www.deejay.de/warenkorb/',
    'Hardwax':              'https://hardwax.com/basket/',
    'Decks.de':             'https://www.decks.de/cart',
    'Phonica':              'https://www.phonicarecords.com/basket',
    'Turntable Lab':        'https://www.turntablelab.com/cart',
    'Gramaphone':           'https://gramaphonerecords.com/cart/',
    'Further Records':      'https://www.furtherrecords.com/cart',
    'Underground Vinyl':    'https://www.undergroundvinyl.net/cart',
    'Octopus Records NYC':  'https://www.octopusrecordsnyc.com/cart',
};

function toolGetCart({ username }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };

    var items = db.getCartItems(user.id);
    if (!items || items.length === 0) {
        return {
            total_items: 0,
            stores: [],
            message: 'Cart is empty. Use manage_cart to queue items, or get_optimizer_result to see recommended buys.'
        };
    }

    // Group by store
    var byStore = {};
    var grandTotal = 0;
    items.forEach(function(item) {
        if (!byStore[item.store]) byStore[item.store] = { store: item.store, items: [], subtotal_usd: 0 };
        byStore[item.store].items.push({
            artist:      item.artist,
            title:       item.title,
            year:        item.year,
            price_usd:   item.price_usd ? +item.price_usd.toFixed(2) : null,
            wantlist_id: item.wantlist_id
        });
        byStore[item.store].subtotal_usd += item.price_usd || 0;
        grandTotal += item.price_usd || 0;
    });

    var stores = Object.values(byStore).map(function(s) {
        s.subtotal_usd = +s.subtotal_usd.toFixed(2);
        s.item_count   = s.items.length;
        s.checkout_url = STORE_CHECKOUT_URLS[s.store] || null;
        return s;
    });

    return {
        total_items:     items.length,
        grand_total_usd: +grandTotal.toFixed(2),
        stores:          stores,
        tip: 'Visit each store\'s checkout_url to complete purchase. Discogs sellers: go to discogs.com/seller/SELLER_NAME/profile'
    };
}

function toolManageCart({ username, action, items }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };

    if (action === 'clear') {
        db.clearCart(user.id);
        return { success: true, action: 'clear', message: 'Cart cleared.', cart: { total_items: 0, grand_total_usd: 0 } };
    }

    if (!items || items.length === 0) return { error: 'No items provided for action: ' + action };

    var results = [];
    items.forEach(function(item) {
        // Match by title (fuzzy)
        var q = '%' + (item.title || '').toLowerCase().replace(/%/g,'').replace(/_/g,'') + '%';
        var wRow = d.prepare(
            'SELECT id FROM wantlist WHERE user_id=? AND active=1 AND LOWER(title) LIKE ? LIMIT 1'
        ).get(user.id, q);

        if (!wRow) {
            results.push({ artist: item.artist, title: item.title, store: item.store, status: 'not_found', note: 'Not in wantlist — can only cart wantlist items' });
            return;
        }

        if (action === 'add') {
            db.addToCart(user.id, wRow.id, item.store, null, item.price_usd || null);
            results.push({ artist: item.artist, title: item.title, store: item.store, status: 'added', wantlist_id: wRow.id });
        } else if (action === 'remove') {
            db.removeFromCart(user.id, wRow.id, item.store);
            results.push({ artist: item.artist, title: item.title, store: item.store, status: 'removed' });
        }
    });

    var cart = toolGetCart({ username });
    return {
        success: true,
        action:  action,
        results: results,
        cart:    { total_items: cart.total_items, grand_total_usd: cart.grand_total_usd, stores: cart.stores }
    };
}

function toolGetCollection({ username, query, genre, style, sort, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };
    limit = Math.min(limit || 30, 100);

    var conditions = ['user_id = ?'];
    var params = [user.id];

    if (query && query.trim()) {
        conditions.push('(LOWER(artist) LIKE ? OR LOWER(title) LIKE ?)');
        var lq = '%' + query.toLowerCase() + '%';
        params.push(lq, lq);
    }
    if (genre && genre.trim()) {
        conditions.push('LOWER(genres) LIKE ?');
        params.push('%' + genre.toLowerCase() + '%');
    }
    if (style && style.trim()) {
        conditions.push('LOWER(styles) LIKE ?');
        params.push('%' + style.toLowerCase() + '%');
    }

    var sortCol = sort === 'artist' ? 'artist ASC' : sort === 'year' ? 'year DESC' : 'date_added DESC';
    params.push(limit);

    var rows = d.prepare(
        'SELECT artist, title, year, label, catno, genres, styles, formats, thumb, date_added, rating ' +
        'FROM collection WHERE ' + conditions.join(' AND ') + ' ORDER BY ' + sortCol + ' LIMIT ?'
    ).all(...params);

    var totalRow = d.prepare('SELECT COUNT(*) as c FROM collection WHERE user_id=?').get(user.id);

    if (totalRow.c === 0) {
        return {
            total_in_collection: 0,
            showing: 0,
            items: [],
            message: username + ' has no collection synced. They need to hit "Sync Collection" in the app, or visit waxdigger.ai/api/collection/' + username + '?refresh=1'
        };
    }

    return {
        total_in_collection: totalRow.c,
        showing: rows.length,
        filters: { query: query || null, genre: genre || null, style: style || null },
        items: rows.map(function(r) {
            return {
                artist:     r.artist,
                title:      r.title,
                year:       r.year,
                label:      r.label,
                catno:      r.catno,
                genres:     (r.genres  || '').split('|').map(function(s){ return s.trim(); }).filter(Boolean),
                styles:     (r.styles  || '').split('|').map(function(s){ return s.trim(); }).filter(Boolean),
                formats:    (r.formats || '').split('|').map(function(s){ return s.trim(); }).filter(Boolean),
                rating:     r.rating || null,
                date_added: r.date_added
            };
        })
    };
}

// ─── get_gem_store_hits ───────────────────────────────────────────────────────
// Cross-reference gem scores with live store availability.
// Returns wantlist items that are: enriched, above min_score, in tiers, AND in stock.
function toolGetGemStoreHits({ username, tiers, min_score, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };

    tiers    = tiers && tiers.length ? tiers : ['hidden_gem', 'club_weapon'];
    min_score = min_score != null ? min_score : 35;
    limit    = Math.min(limit || 15, 40);

    // Get all wantlist items with streaming_metadata + in-stock store results
    var rows = d.prepare(`
        SELECT w.id as wantlist_id, w.discogs_id, w.artist, w.title, w.year,
               sm.youtube_view_count, sm.youtube_like_count, sm.youtube_comment_data,
               sm.youtube_enriched_at, sm.youtube_video_id,
               rm.community_have, rm.community_want,
               GROUP_CONCAT(DISTINCT sr.store) as stores_in_stock,
               GROUP_CONCAT(DISTINCT sr.matches) as all_matches
        FROM wantlist w
        JOIN store_results sr ON sr.wantlist_id = w.id AND sr.in_stock = 1 AND sr.link_only = 0
        JOIN streaming_metadata sm ON sm.discogs_id = w.discogs_id
        LEFT JOIN release_meta rm ON rm.discogs_id = w.discogs_id
        WHERE w.user_id = ? AND w.active = 1 AND sm.youtube_enriched_at IS NOT NULL
        GROUP BY w.id
    `).all(user.id);

    var gemScore;
    try { gemScore = require('./lib/gem-score'); } catch(e) {
        return { error: 'gem-score module unavailable: ' + e.message };
    }

    var results = [];
    rows.forEach(function(row) {
        var scored = gemScore.scoreRelease(row, { community_have: row.community_have, community_want: row.community_want });
        if (scored.gemScore < min_score) return;
        if (tiers.indexOf(scored.tier || 'unscored') === -1) return;

        var commentData = {};
        try { commentData = JSON.parse(row.youtube_comment_data || '{}'); } catch(e) {}

        // Best price across in-stock stores
        var bestPrice = null;
        try {
            var stores = (row.stores_in_stock || '').split(',');
            // matches is a concat — just pick first parseable price
            var firstMatch = JSON.parse((row.all_matches || '[]'));
            if (firstMatch.length) bestPrice = firstMatch[0].price;
        } catch(e) {}

        results.push({
            artist:       row.artist,
            title:        row.title,
            year:         row.year,
            tier:         scored.tier,
            gemScore:     scored.gemScore,
            viewCount:    row.youtube_view_count || 0,
            youtube_url:  row.youtube_video_id ? 'https://youtube.com/watch?v=' + row.youtube_video_id : null,
            djs:          (commentData.djs || []).slice(0, 4),
            genres:       (commentData.genres || []).slice(0, 3),
            stores:       (row.stores_in_stock || '').split(',').filter(Boolean),
            best_price:   bestPrice,
            community_have: row.community_have,
            breakdown:    scored.breakdown || null
        });
    });

    results.sort(function(a, b) { return b.gemScore - a.gemScore; });
    results = results.slice(0, limit);

    return {
        username: username,
        count:    results.length,
        tiers:    tiers,
        hits:     results,
        tip:      results.length === 0
            ? 'No enriched gems in stock right now. The enrichment job runs every 6 hours — more records will be scored over time.'
            : null
    };
}

// ─── Store name ↔ DB slug maps ────────────────────────────────────────────────
// store_inventory uses lowercase slugs; WAXY tools use display names.
var STORE_SLUG = {
    'Further Records':      'further',
    'Gramaphone':           'gramaphone',
    'Octopus Records NYC':  'octopus',
    'Underground Vinyl':    'uvs',
    'Hardwax':              'hardwax',
    // accept slugs directly too
    'further': 'further', 'gramaphone': 'gramaphone',
    'octopus': 'octopus', 'uvs': 'uvs', 'hardwax': 'hardwax',
};
var STORE_DISPLAY = {
    'further':    'Further Records',
    'gramaphone': 'Gramaphone',
    'octopus':    'Octopus Records NYC',
    'uvs':        'Underground Vinyl',
    'hardwax':    'Hardwax',
};
// Per-store notes about data gaps (so WAXY can caveat its output)
var STORE_DATA_NOTES = {
    'octopus': 'Octopus has no artist field — scored on style/label only',
    'uvs':     'UVS has no label field — scored on artist/style only',
};

// ─── get_catalog_discoveries ──────────────────────────────────────────────────
// Delegates to Engine 1 (recommendations.js): full TF-IDF style scoring,
// artist/label affinity, style cluster expansion, diversity cap.
// Fixes the old version which (a) used display names as DB slugs → 0 results,
// (b) did flat tag-frequency overlap with no IDF, label graph, or cluster expansion.
function toolGetCatalogDiscoveries({ username, store, genre, max_price, limit }) {
    limit = Math.min(limit || 20, 50);

    // Resolve store filter to DB slug
    var storeSlug = store ? (STORE_SLUG[store] || null) : null;
    if (store && !storeSlug) {
        return { error: 'Unknown store: "' + store + '". Valid: Further Records, Gramaphone, Octopus Records NYC, Underground Vinyl, Hardwax' };
    }

    var rec;
    try { rec = require('./lib/recommendations'); } catch(e) {
        return { error: 'Recommendations engine unavailable: ' + e.message };
    }

    // Run Engine 1 — fetch extra headroom so post-filters still yield enough results
    var fetchLimit = storeSlug ? limit * 8 : limit * 3;
    var result;
    try { result = rec.getRecommendations(username, fetchLimit); } catch(e) {
        return { error: 'Discovery failed: ' + e.message };
    }

    if (!result || !result.recommendations || !result.recommendations.length) {
        return { username, count: 0, discoveries: [],
            tip: result && result.wantlistSize === 0
                ? 'Wantlist is empty — sync first.'
                : 'No catalog matches found.' };
    }

    var items = result.recommendations;

    // Filter by store slug
    if (storeSlug) {
        items = items.filter(function(r) { return r.store === storeSlug; });
    }

    // Filter by genre tag
    if (genre) {
        var gl = genre.toLowerCase();
        items = items.filter(function(r) {
            return (r.tags || []).some(function(t) { return t.toLowerCase().includes(gl); });
        });
    }

    // Filter by max price
    if (max_price) {
        items = items.filter(function(r) { return !r.price || r.price <= max_price; });
    }

    var discoveries = items.slice(0, limit).map(function(r) {
        return {
            store:     STORE_DISPLAY[r.store] || r.store,
            artist:    r.artist,
            title:     r.title,
            label:     r.label  || null,
            catno:     r.catno  || null,
            tags:      (r.tags  || []).slice(0, 6),
            price_usd: r.price  ? '$' + Number(r.price).toFixed(2) : null,
            url:       r.url    || null,
            matchPct:  r.matchPct,
            reasons:   r.reasons,   // e.g. ["Minimal Techno", "Hyperdub", "Burial"]
        };
    });

    // Collect which stores actually appear in results (for transparency)
    var storesInResults = [...new Set(discoveries.map(function(r) { return r.store; }))];

    return {
        username,
        stores_checked:    storeSlug ? [STORE_DISPLAY[storeSlug]] : Object.values(STORE_DISPLAY),
        stores_in_results: storesInResults,
        count:             discoveries.length,
        discoveries,
        engine_stats: {
            wantlist_size:  result.wantlistSize,
            inventory_size: result.inventorySize,
            compute_ms:     result.computeMs,
        },
        data_notes: storeSlug && STORE_DATA_NOTES[storeSlug] ? STORE_DATA_NOTES[storeSlug] : null,
        tip: discoveries.length === 0
            ? 'No matches after filtering. Try omitting the store or genre filter.'
            : null,
    };
}

// ─── get_taste_recommendations ────────────────────────────────────────────────
// Runs the Last.fm recommender and returns artist recs with available catalog records.
async function toolGetTasteRecommendations({ username, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };
    limit = Math.min(limit || 20, 40);

    var recommender;
    try {
        recommender = require('./lib/recommender');
    } catch(e) {
        return { error: 'Recommender module unavailable: ' + e.message };
    }

    var result;
    try {
        result = await recommender.recommend(username, d, {
            seedLimit:      30,
            similarPerSeed: 8,
            resultLimit:    limit
        });
    } catch(e) {
        return { error: 'Recommender failed: ' + e.message };
    }

    if (result.error) return { error: result.error, tip: 'Make sure LASTFM_API_KEY is set in .env' };

    // Shape output for GOLDIE: group by recommended artist, list available records
    var byArtist = {};
    (result.recommendations || []).forEach(function(rec) {
        var key = rec.recommendedArtist || rec.artist;
        if (!byArtist[key]) {
            byArtist[key] = {
                artist:       rec.recommendedArtist || rec.artist,
                because:      rec.because || [],
                blendedScore: rec.blendedScore,
                seedCount:    rec.seedCount,
                records:      []
            };
        }
        byArtist[key].records.push({
            title:    rec.title,
            store:    rec.store,
            price:    rec.priceUsd ? '$' + rec.priceUsd.toFixed(2) : null,
            tags:     (rec.tags || []).slice(0, 4),
            url:      rec.url || null,
            tagScore: Math.round((rec.tagScore || 0) * 100)
        });
    });

    var artists = Object.values(byArtist).sort(function(a, b) {
        if (b.seedCount !== a.seedCount) return b.seedCount - a.seedCount;
        return b.blendedScore - a.blendedScore;
    });

    return {
        username:       username,
        seeds_used:     (result.seeds || []).slice(0, 10),
        artist_count:   artists.length,
        top_genres:     result.genreProfile
            ? Object.entries(result.genreProfile).slice(0, 10).map(function(e) { return { genre: e[0], count: e[1] }; })
            : [],
        recommendations: artists,
        tip: artists.length === 0
            ? 'No catalog matches found via Last.fm. The catalog stores may not stock these artists yet, or Last.fm returned no similar artists. Try again later.'
            : null
    };
}

function toolGetGemIntelligence({ username, limit }) {
    var d = db.getDb();
    var user = d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user) return { error: 'User not found: ' + username };
    limit = Math.min(limit || 20, 50);

    // All discogs_ids from wantlist + collection (deduped via UNION)
    var allIds = d.prepare(`
        SELECT discogs_id FROM (
            SELECT discogs_id FROM wantlist    WHERE user_id=? AND active=1 AND discogs_id IS NOT NULL
            UNION
            SELECT discogs_id FROM collection  WHERE user_id=? AND discogs_id IS NOT NULL
        )
    `).all(user.id, user.id).map(function(r){ return r.discogs_id; });

    if (allIds.length === 0) return {
        error: 'No releases with Discogs IDs found for ' + username,
        tip: 'Sync the wantlist and collection from Discogs first.'
    };

    var ph = allIds.map(function(){ return '?'; }).join(',');

    var smRows = d.prepare(
        'SELECT discogs_id, youtube_video_id, youtube_view_count, youtube_like_count,' +
        ' youtube_comment_data, youtube_enriched_at FROM streaming_metadata' +
        ' WHERE discogs_id IN (' + ph + ')'
    ).all(...allIds);

    var rmRows = d.prepare(
        'SELECT discogs_id, community_have, community_want FROM release_meta' +
        ' WHERE discogs_id IN (' + ph + ')'
    ).all(...allIds);

    // Build lookup maps
    var rmMap = {};
    rmRows.forEach(function(r){ rmMap[r.discogs_id] = r; });

    var itemMap = {};
    d.prepare('SELECT discogs_id, artist, title, thumb FROM wantlist WHERE user_id=? AND active=1').all(user.id)
        .forEach(function(r){ itemMap[r.discogs_id] = r; });
    d.prepare('SELECT discogs_id, artist, title, thumb FROM collection WHERE user_id=?').all(user.id)
        .forEach(function(r){ if (!itemMap[r.discogs_id]) itemMap[r.discogs_id] = r; });

    var gemScore;
    try { gemScore = require('./lib/gem-score'); } catch(e) {
        return { error: 'gem-score module not available: ' + e.message };
    }

    // Score every enriched release
    var tierCounts = { hidden_gem: 0, club_weapon: 0, deep_cut: 0, known_quantity: 0, unscored: 0 };
    var totalScore = 0, scoredCount = 0, undergroundCount = 0;
    var genreCounts = {}, djCounts = {};
    var scoredItems = [];

    smRows.forEach(function(sm) {
        var rm = rmMap[sm.discogs_id] || null;
        var scored = gemScore.scoreRelease(sm, rm);
        var commentData = {};
        try { commentData = JSON.parse(sm.youtube_comment_data || '{}'); } catch(e) {}

        var tier = scored.tier || 'unscored';
        tierCounts[tier] = (tierCounts[tier] || 0) + 1;

        if (scored.gemScore > 0) { totalScore += scored.gemScore; scoredCount++; }

        // Underground = enriched + < 10k views
        var views = sm.youtube_view_count || 0;
        if (sm.youtube_enriched_at && views < 10000) undergroundCount++;

        // Aggregate YouTube-comment genres + DJs
        (commentData.genres || []).forEach(function(g){ genreCounts[g] = (genreCounts[g]||0)+1; });
        (commentData.djs || []).forEach(function(dj){ djCounts[dj] = (djCounts[dj]||0)+1; });

        var info = itemMap[sm.discogs_id] || {};
        scoredItems.push({
            discogs_id:   sm.discogs_id,
            artist:       info.artist || 'Unknown',
            title:        info.title  || 'Unknown',
            tier:         tier,
            gemScore:     scored.gemScore,
            viewCount:    views,
            videoId:      sm.youtube_video_id || null,
            genres:       commentData.genres || [],
            djs:          commentData.djs    || [],
            enriched:     !!sm.youtube_enriched_at
        });
    });

    // Releases with no streaming_metadata row yet count as unscored
    tierCounts.unscored += allIds.length - smRows.length;

    var enrichedCount = smRows.filter(function(s){ return s.youtube_enriched_at; }).length;
    var enrichedPct   = allIds.length > 0 ? Math.round(enrichedCount / allIds.length * 100) : 0;
    var undergroundPct = enrichedCount > 0 ? Math.round(undergroundCount / enrichedCount * 100) : 0;
    var avgGemScore   = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0;

    // Top gems: hidden_gem + club_weapon, sorted by gem score desc
    var topGems = scoredItems
        .filter(function(i){ return i.tier === 'hidden_gem' || i.tier === 'club_weapon'; })
        .sort(function(a,b){ return b.gemScore - a.gemScore; })
        .slice(0, limit)
        .map(function(i){
            return {
                artist:      i.artist,
                title:       i.title,
                tier:        i.tier,
                gemScore:    i.gemScore,
                viewCount:   i.viewCount,
                genres:      i.genres.slice(0, 3),
                djs:         i.djs.slice(0, 3),
                youtube_url: i.videoId ? 'https://youtube.com/watch?v=' + i.videoId : null
            };
        });

    // Most underground: enriched, lowest view count, non-zero views
    var topUnderground = scoredItems
        .filter(function(i){ return i.enriched && i.viewCount > 0 && i.viewCount < 50000; })
        .sort(function(a,b){ return a.viewCount - b.viewCount; })
        .slice(0, 10)
        .map(function(i){
            return {
                artist:      i.artist,
                title:       i.title,
                tier:        i.tier,
                viewCount:   i.viewCount,
                youtube_url: i.videoId ? 'https://youtube.com/watch?v=' + i.videoId : null
            };
        });

    var topGenres = Object.entries(genreCounts)
        .sort(function(a,b){ return b[1]-a[1]; }).slice(0,12)
        .map(function(e){ return { name: e[0], count: e[1] }; });

    var topDjs = Object.entries(djCounts)
        .sort(function(a,b){ return b[1]-a[1]; }).slice(0,10)
        .map(function(e){ return { name: e[0], count: e[1] }; });

    var note = null;
    if (enrichedPct < 50) {
        note = 'Only ' + enrichedCount + '/' + allIds.length + ' releases enriched so far (' + enrichedPct + '%). Underground index and gem tiers will sharpen as the background enrichment job runs (~90 searches/day).';
    }

    return {
        username:         username,
        total:            allIds.length,
        enriched:         enrichedCount,
        enrichedPct:      enrichedPct,
        undergroundIndex: undergroundPct,
        avgGemScore:      avgGemScore,
        tierCounts:       tierCounts,
        topGems:          topGems,
        topUnderground:   topUnderground,
        topGenres:        topGenres,
        topDjs:           topDjs,
        note:             note
    };
}

// Tool dispatch
function runTool(name, input) {
    switch(name) {
        case 'get_user_profile':        return toolGetUserProfile(input);
        case 'get_in_stock':            return toolGetInStock(input);
        case 'suggest_cart':            return toolSuggestCart(input);
        case 'get_diggers':             return toolGetDiggers(input);
        case 'search_wantlist':         return toolSearchWantlist(input);
        case 'get_store_breakdown':     return toolGetStoreBreakdown(input);
        case 'get_rare_finds':          return toolGetRareFinds(input);
        case 'compare_diggers':         return toolCompareDiggers(input);
        case 'get_discogs_marketplace': return toolGetDiscogsMarketplace(input);
        case 'trigger_sync':            return toolTriggerSync(input);
        case 'get_sync_status':         return toolGetSyncStatus(input);
        case 'get_optimizer_result':    return toolGetOptimizerResult(input);
        case 'run_optimizer':           return toolRunOptimizer(input);
        case 'get_cart':                return toolGetCart(input);
        case 'manage_cart':             return toolManageCart(input);
        case 'get_collection':          return toolGetCollection(input);
        case 'get_gem_intelligence':       return toolGetGemIntelligence(input);
        case 'get_gem_store_hits':         return toolGetGemStoreHits(input);
        case 'get_catalog_discoveries':    return toolGetCatalogDiscoveries(input);
        case 'get_taste_recommendations':  return toolGetTasteRecommendations(input);
        default: return { error: 'Unknown tool: ' + name };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

function newSessionId() { return crypto.randomBytes(12).toString('hex'); }

function loadSession(sessionId) {
    var row = db.getDb().prepare('SELECT * FROM goldie_sessions WHERE id=?').get(sessionId);
    if (!row) return null;
    var messages = [];
    try { messages = JSON.parse(row.messages); } catch(e) {}
    return { id: row.id, username: row.username, title: row.title, messages: messages };
}

function saveSession(session) {
    db.getDb().prepare(`
        INSERT INTO goldie_sessions (id, username, title, messages, created_at, last_active)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET messages=excluded.messages, last_active=datetime('now'), title=excluded.title
    `).run(session.id, session.username || null, session.title || null, JSON.stringify(session.messages));
}

function getUserSessions(username) {
    return db.getDb().prepare(
        "SELECT id, title, username, created_at, last_active FROM goldie_sessions WHERE username=? ORDER BY last_active DESC LIMIT 20"
    ).all(username).map(function(r) {
        return { id: r.id, title: r.title || 'Conversation', created_at: r.created_at, last_active: r.last_active };
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE AGENT — streaming Claude + tool loop
// ═══════════════════════════════════════════════════════════════════════════

async function runAgent(session, userMessage, onChunk) {
    // On the very first message of a session, prepend user identity so GOLDIE
    // knows exactly who it's talking to without needing to ask.
    var isFirstMessage = session.messages.length === 0;
    var contextualMessage = userMessage;
    if (isFirstMessage && session.username) {
        var u = session.username;
        // Quick snapshot: in-stock count so GOLDIE can tease it immediately
        try {
            var _d = db.getDb();
            var _user = _d.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(u);
            if (_user) {
                var _ic = _d.prepare(
                    'SELECT COUNT(DISTINCT w.id) as c FROM wantlist w JOIN store_results sr ON sr.wantlist_id=w.id WHERE w.user_id=? AND w.active=1 AND sr.in_stock=1'
                ).get(_user.id).c;
                var _wc = _d.prepare('SELECT COUNT(*) as c FROM wantlist WHERE user_id=? AND active=1').get(_user.id).c;
                contextualMessage = '[Context: You are speaking with Discogs user "' + u + '". They have ' +
                    _wc + ' items on their wantlist and ' + _ic + ' are currently in stock across the scraped stores. Use their username when calling tools.]\n\n' + userMessage;
            }
        } catch(e) {}
    }

    // Append user message to history
    session.messages.push({ role: 'user', content: contextualMessage });

    // Keep last N messages to avoid context overflow (keep system + last 20)
    var historyToSend = session.messages.slice(-20);

    var fullText = '';
    var loopCount = 0;
    var MAX_LOOPS = 5;

    while (loopCount < MAX_LOOPS) {
        loopCount++;

        // Stream from Claude
        var stream = anthropic.messages.stream({
            model: MODEL,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: historyToSend
        });

        var assistantContent = [];
        var currentTextBlock = null;
        var currentToolBlock = null;

        for await (var event of stream) {
            if (event.type === 'content_block_start') {
                if (event.content_block.type === 'text') {
                    currentTextBlock = { type: 'text', text: '' };
                    assistantContent.push(currentTextBlock);
                } else if (event.content_block.type === 'tool_use') {
                    currentToolBlock = { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, input: '' };
                    assistantContent.push(currentToolBlock);
                }
            } else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta' && currentTextBlock) {
                    currentTextBlock.text += event.delta.text;
                    fullText += event.delta.text;
                    if (onChunk) onChunk({ type: 'text', text: event.delta.text });
                } else if (event.delta.type === 'input_json_delta' && currentToolBlock) {
                    currentToolBlock.input += event.delta.partial_json;
                }
            } else if (event.type === 'content_block_stop') {
                if (currentToolBlock) {
                    try { currentToolBlock.input = JSON.parse(currentToolBlock.input); } catch(e) { currentToolBlock.input = {}; }
                    currentTextBlock = null; currentToolBlock = null;
                } else {
                    currentTextBlock = null;
                }
            }
        }

        // Add assistant message to history
        historyToSend.push({ role: 'assistant', content: assistantContent });

        // Check if we need to run tools
        var toolUses = assistantContent.filter(function(b){ return b.type === 'tool_use'; });
        if (toolUses.length === 0) break; // no tool calls — done

        // Run all tool calls (await handles both sync and async handlers)
        var toolResults = [];
        for (var tu of toolUses) {
            if (onChunk) onChunk({ type: 'tool_call', name: tu.name, input: tu.input });
            var result = await Promise.resolve(runTool(tu.name, tu.input));
            if (onChunk) onChunk({ type: 'tool_result', name: tu.name, result: result });
            toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
        }

        // Add tool results and loop back for Claude to continue
        historyToSend.push({ role: 'user', content: toolResults });
    }

    // Update session messages with full exchange
    session.messages = historyToSend;
    // Auto-title from first exchange
    if (!session.title && fullText) {
        session.title = fullText.slice(0,60).trim().replace(/\n/g,' ');
    }
    saveSession(session);
    return fullText;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

function sendJSON(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise(function(resolve, reject) {
        var data = '';
        req.on('data', function(c){ data += c; });
        req.on('end', function(){ try { resolve(JSON.parse(data||'{}')); } catch(e){ resolve({}); } });
        req.on('error', reject);
    });
}

function startHttpServer() {
    var PORT = parseInt(process.env.GOLDIE_PORT || '5053', 10);
    var SECRET = process.env.GOLDIE_SECRET || '';

    var server = http.createServer(async function(req, res) {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
            return res.end();
        }

        // Auth check
        if (SECRET) {
            var auth = req.headers['authorization'] || '';
            if (auth !== 'Bearer ' + SECRET) return sendJSON(res, 401, { error: 'Unauthorized' });
        }

        var url = req.url.split('?')[0];

        // ── GET /health ────────────────────────────────────────────────────
        if (req.method === 'GET' && url === '/health') {
            return sendJSON(res, 200, { status: 'ok', name: 'WAXY' });
        }

        // ── GET /sessions/:username ────────────────────────────────────────
        var sessMatch = url.match(/^\/sessions\/(.+)$/);
        if (req.method === 'GET' && sessMatch) {
            return sendJSON(res, 200, { sessions: getUserSessions(decodeURIComponent(sessMatch[1])) });
        }

        // ── GET /context/:username ─────────────────────────────────────────
        var ctxMatch = url.match(/^\/context\/(.+)$/);
        if (req.method === 'GET' && ctxMatch) {
            var ctxUser = decodeURIComponent(ctxMatch[1]);
            var profile = toolGetUserProfile({ username: ctxUser });
            var inStock = toolGetInStock({ username: ctxUser, sort: 'rarity', limit: 20 });
            return sendJSON(res, 200, { profile: profile, inStock: inStock });
        }

        // ── POST /chat ─────────────────────────────────────────────────────
        if (req.method === 'POST' && url === '/chat') {
            var body = await readBody(req);
            var { sessionId, username, message } = body;
            if (!message) return sendJSON(res, 400, { error: 'message required' });

            // Load or create session
            var session = sessionId ? loadSession(sessionId) : null;
            if (!session) {
                session = { id: newSessionId(), username: username || null, title: null, messages: [] };
            }

            // Stream response via SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            var sendEvent = function(data) {
                res.write('data: ' + JSON.stringify(data) + '\n\n');
            };

            sendEvent({ type: 'session', sessionId: session.id });

            try {
                await runAgent(session, message, sendEvent);
                sendEvent({ type: 'done', sessionId: session.id });
            } catch(e) {
                sendEvent({ type: 'error', message: e.message });
            }
            return res.end();
        }

        sendJSON(res, 404, { error: 'Not found' });
    });

    server.listen(PORT, function() {
        console.log('[GOLDIE] HTTP server listening on port', PORT);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP SERVER (stdio — for Claude Desktop)
// ═══════════════════════════════════════════════════════════════════════════

async function startMcpServer() {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const { z } = require('zod');

    const mcp = new McpServer({ name: 'waxy', version: '1.0.0', description: 'WAXY — Vinyl intelligence agent for Wax Digger platform' });

    // Register each tool
    TOOLS.forEach(function(tool) {
        // Convert JSON schema to zod shape (minimal — MCP SDK just needs an object)
        var zodShape = {};
        var props = (tool.input_schema && tool.input_schema.properties) || {};
        Object.entries(props).forEach(function([key, prop]) {
            var base;
            if (prop.type === 'string') base = z.string().optional();
            else if (prop.type === 'number') base = z.number().optional();
            else if (prop.type === 'boolean') base = z.boolean().optional();
            else if (prop.type === 'array') base = z.array(z.string()).optional();
            else base = z.any().optional();
            if (prop.description) base = base.describe(prop.description);
            var required = (tool.input_schema.required || []).indexOf(key) !== -1;
            zodShape[key] = required ? base.unwrap ? base : base : base;
        });

        mcp.tool(tool.name, tool.description, zodShape, async function(input) {
            var result = await Promise.resolve(runTool(tool.name, input));
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        });
    });

    // Also expose a chat tool for conversational use
    mcp.tool('waxy_chat', 'Have a conversation with WAXY about your vinyl collection. WAXY will use its other tools automatically.', {
        message:    z.string().describe('Your message or question'),
        username:   z.string().optional().describe('Discogs username for context'),
        session_id: z.string().optional().describe('Session ID to continue a conversation')
    }, async function({ message, username, session_id }) {
        var session = session_id ? loadSession(session_id) : null;
        if (!session) session = { id: newSessionId(), username: username||null, title: null, messages: [] };
        var text = await runAgent(session, message, null);
        return { content: [{ type: 'text', text: text + '\n\n[session: ' + session.id + ']' }] };
    });

    var transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error('[WAXY] MCP server running on stdio');
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

if (process.argv.includes('--mcp')) {
    startMcpServer().catch(function(e){ console.error('MCP error:', e); process.exit(1); });
} else {
    // Ensure DB is initialized
    db.getDb();
    startHttpServer();
}
