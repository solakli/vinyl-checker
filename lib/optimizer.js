/**
 * Cart optimizer — finds the cheapest combination of sellers/stores to buy
 * as many wantlist items as possible, accounting for per-seller shipping paid
 * once per order.
 *
 * ─── Problem statement ────────────────────────────────────────────────────────
 *
 * Given:
 *   - A set of wantlist items W = {w1, w2, ..., wn}
 *   - For each wi, a set of available listings from various sources (Discogs
 *     sellers + catalog-mirror stores)
 *   - A shipping cost per source (paid ONCE per source, regardless of how many
 *     items you buy from them)
 *
 * Find: a mapping of items → sources that minimises:
 *   total_cost = Σ(listing prices) + Σ(per-source shipping, counted once each)
 *
 * This is a variant of the weighted Uncapacitated Facility Location Problem,
 * which is NP-hard in general. For real wantlist sizes (50–500 items) and
 * realistic source counts, a greedy approximation with marginal-cost scoring
 * finds near-optimal solutions.
 *
 * ─── Algorithm ───────────────────────────────────────────────────────────────
 *
 * 1. Build a "source profile" for each seller/store:
 *    { sourceId, shippingCost, cheapestListingPerItem: Map<itemId → listing> }
 *
 * 2. Iterate until no uncovered items remain:
 *    a. For each source, compute marginalCost = (sum of their cheapest prices
 *       for uncovered items) + shippingCost
 *    b. Pick the source with the lowest marginalCost per item covered:
 *       score = marginalCost / items_covered
 *    c. Assign all uncovered items that source covers at their cheapest price,
 *       mark them covered, add the source to the cart
 *
 * 3. After the greedy pass, run a cleanup: for each item in the cart, check
 *    if it would be cheaper to buy it from a DIFFERENT source already in the
 *    cart (shipping already "paid"). If so, reassign it.
 *
 * ─── Source types ────────────────────────────────────────────────────────────
 *
 * The optimizer treats stores and Discogs sellers identically. Each source has:
 *   {
 *     sourceId: string,          // 'store:gramaphone' | 'discogs:vinyl_nerd_berlin'
 *     sourceName: string,        // human label
 *     sourceType: 'store'|'discogs',
 *     country: string,           // ISO-2 seller location
 *     shippingCostUsd: number,   // flat per-order shipping to the buyer
 *     sellerRating: number|null,
 *     listings: [{ itemId, priceUsd, condition, url, ... }]
 *   }
 */

const shipping = require('./shipping-rates');

/**
 * Build the full listing pool from all available sources for a user's wantlist.
 *
 * @param {object[]} wantlistItems   - from db.getActiveWantlist()
 * @param {object} storeInventory    - { gramaphone: row[], further: row[], octopus: row[], ... }
 * @param {object} marketListings    - { [discogsId]: listing[] } from discogs-market
 * @param {object} opts
 * @param {string} opts.buyerCountry - ISO-2 buyer location (e.g. 'US')
 * @param {string} [opts.minCondition='VG+']
 * @param {number} [opts.minSellerRating=98]
 * @param {number} [opts.maxPriceUsd]
 * @returns {object[]} array of source profiles
 */
function buildSourcePool(wantlistItems, storeInventory, marketListings, opts) {
    opts = opts || {};
    var buyerCountry = opts.buyerCountry || 'US';
    var minCondition = opts.minCondition || 'VG+';
    var minRating = opts.minSellerRating != null ? opts.minSellerRating : 98.0;
    var maxPrice = opts.maxPriceUsd || Infinity;

    var scrapers = require('./scrapers');

    // ── 1. Catalog-mirror stores ───────────────────────────────────────────
    var STORE_META = {
        gramaphone: { name: 'Gramaphone Records', country: 'US', shippingPolicy: function (rows) {
            // Free shipping over $50, else $5.99 flat
            var total = rows.reduce(function (s, r) { return s + (r.priceUsd || 0); }, 0);
            return total >= 50 ? 0 : 5.99;
        }},
        further: { name: 'Further Records', country: 'US', shippingPolicy: function (rows) {
            var total = rows.reduce(function (s, r) { return s + (r.priceUsd || 0); }, 0);
            return total >= 100 ? 0 : 7.99;
        }},
        octopus: { name: 'Octopus Records NYC', country: 'US', shippingPolicy: function () {
            return 6.00;
        }}
    };

    // Build item ID → wantlist item map (for catno matching)
    var itemMap = {};
    wantlistItems.forEach(function (item) { itemMap[item.id] = item; });

    // Build store source profiles
    var storeProfiles = {};
    Object.keys(storeInventory).forEach(function (storeKey) {
        var meta = STORE_META[storeKey];
        if (!meta) return;
        var rows = storeInventory[storeKey] || [];
        if (rows.length === 0) return;

        // Match each wantlist item against the store
        wantlistItems.forEach(function (wanted) {
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (!row.available) continue;
                if (!scrapers.matchInventoryRow(wanted, row)) continue;
                if (row.price_usd && row.price_usd > maxPrice) continue;

                var sourceId = 'store:' + storeKey;
                if (!storeProfiles[sourceId]) {
                    storeProfiles[sourceId] = {
                        sourceId: sourceId,
                        sourceName: meta.name,
                        sourceType: 'store',
                        country: meta.country,
                        sellerRating: null,
                        shippingPolicyFn: meta.shippingPolicy,
                        listings: []
                    };
                }

                storeProfiles[sourceId].listings.push({
                    itemId: wanted.id,
                    priceUsd: row.price_usd || 0,
                    condition: 'NM', // stores sell new records
                    url: row.url,
                    title: row.title_raw || row.title,
                    catno: row.catno
                });
                break; // take first match per item per store
            }
        });
    });

    // For store profiles, compute shipping after we know which items are included
    var storeSources = Object.values(storeProfiles).map(function (p) {
        return Object.assign({}, p, {
            shippingCostUsd: p.shippingPolicyFn(p.listings)
        });
    });

    // ── 2. Discogs marketplace sellers ────────────────────────────────────
    // Build seller → { itemId → cheapest listing } map
    var sellerMap = {};

    wantlistItems.forEach(function (wanted) {
        var releaseListings = marketListings[wanted.discogs_id] || [];
        releaseListings.forEach(function (l) {
            if (!l.sellerUsername) return;
            if (l.priceUsd == null) return;
            if (l.priceUsd > maxPrice) return;
            if (minRating && l.sellerRating && l.sellerRating < minRating) return;
            // condition filter already applied upstream, but double-check
            var condOk = shipping; // just a truthy reference; condition check is below
            var discogsMkt = require('./discogs-market');
            if (!discogsMkt.meetsMinCondition(l.condition, minCondition)) return;

            var seller = l.sellerUsername;
            if (!sellerMap[seller]) {
                sellerMap[seller] = {
                    sourceId: 'discogs:' + seller,
                    sourceName: seller + ' (Discogs)',
                    sellerUsername: seller,          // raw username for URL construction
                    sourceType: 'discogs',
                    country: shipping.shipsFromToCode(l.sellerCountry),
                    sellerRating: l.sellerRating,
                    sellerNumRatings: l.sellerNumRatings,
                    shippingCostUsd: shipping.estimateShipping(l.sellerCountry, buyerCountry),
                    listings: [],
                    _cheapestPerItem: {}
                };
            }

            var s = sellerMap[seller];
            var existing = s._cheapestPerItem[wanted.id];
            if (!existing || l.priceUsd < existing.priceUsd) {
                s._cheapestPerItem[wanted.id] = {
                    itemId: wanted.id,
                    priceUsd: l.priceUsd,
                    price: l.price,
                    currency: l.currency,
                    condition: l.condition,
                    sleeveCondition: l.sleeveCondition,
                    url: l.listingUrl,
                    title: wanted.title,
                    artist: wanted.artist,
                    catno: wanted.catno,
                    listingId: l.listingId
                };
            }
        });
    });

    // Flatten cheapestPerItem → listings array
    var discogsSources = Object.values(sellerMap).map(function (s) {
        s.listings = Object.values(s._cheapestPerItem);
        delete s._cheapestPerItem;
        return s;
    }).filter(function (s) { return s.listings.length > 0; });

    return storeSources.concat(discogsSources);
}

/**
 * Run the greedy cart optimizer.
 *
 * @param {object[]} sources  - from buildSourcePool()
 * @param {object[]} wantlistItems
 * @returns {object} cart result
 */
function optimizeCart(sources, wantlistItems) {
    var allItemIds = new Set(wantlistItems.map(function (w) { return w.id; }));
    var uncovered = new Set(allItemIds);
    var cart = []; // { source, assignedListings, shippingCostUsd, subtotalUsd, totalUsd }

    // Index: itemId → wantlist item
    var itemById = {};
    wantlistItems.forEach(function (w) { itemById[w.id] = w; });

    var iterations = 0;
    var maxIterations = sources.length + 10; // safety cap

    while (uncovered.size > 0 && iterations++ < maxIterations) {
        // Score each source by marginal cost per uncovered item
        var best = null;
        var bestScore = Infinity;

        sources.forEach(function (source) {
            // Items this source can cover that are still uncovered
            var coverable = source.listings.filter(function (l) {
                return uncovered.has(l.itemId);
            });
            if (coverable.length === 0) return;

            var itemsSubtotal = coverable.reduce(function (s, l) { return s + l.priceUsd; }, 0);

            // Shipping cost: if this source is already in the cart, shipping
            // is already paid — marginal shipping is 0.
            var alreadyInCart = cart.some(function (c) { return c.source.sourceId === source.sourceId; });
            var marginalShipping = alreadyInCart ? 0 : source.shippingCostUsd;

            var marginalCost = itemsSubtotal + marginalShipping;
            var score = marginalCost / coverable.length; // cost per item

            if (score < bestScore) {
                bestScore = score;
                best = { source: source, coverable: coverable, marginalShipping: marginalShipping };
            }
        });

        if (!best) break; // nothing left can cover any uncovered item

        // Assign this source's coverable items
        best.coverable.forEach(function (l) { uncovered.delete(l.itemId); });

        var subtotal = best.coverable.reduce(function (s, l) { return s + l.priceUsd; }, 0);
        var existing = cart.find(function (c) { return c.source.sourceId === best.source.sourceId; });

        if (existing) {
            // Source was already added in a prior iteration (shouldn't normally happen
            // given greedy, but handle gracefully)
            existing.assignedListings.push.apply(existing.assignedListings, best.coverable);
            existing.subtotalUsd = (existing.subtotalUsd || 0) + subtotal;
            existing.totalUsd = existing.subtotalUsd + existing.shippingCostUsd;
        } else {
            cart.push({
                source: best.source,
                assignedListings: best.coverable.slice(),
                shippingCostUsd: best.source.shippingCostUsd,
                subtotalUsd: subtotal,
                totalUsd: subtotal + best.source.shippingCostUsd
            });
        }
    }

    // ── Savings pass: check if adding a new source saves more than its shipping ──
    // The greedy may have assigned all items to one seller. If there's another
    // seller who has some of those same items cheaper, and the savings > their
    // shipping cost, it's worth splitting the order.
    var addedInSavingsPass = true;
    var maxSavingsPasses = 3;
    while (addedInSavingsPass && maxSavingsPasses-- > 0) {
        addedInSavingsPass = false;
        var cartSourceIdSet = new Set(cart.map(function (c) { return c.source.sourceId; }));

        // Build current price map: itemId → current assigned priceUsd
        var currentPriceMap = {};
        cart.forEach(function (c) {
            c.assignedListings.forEach(function (l) {
                currentPriceMap[l.itemId] = l.priceUsd;
            });
        });

        sources.forEach(function (source) {
            if (cartSourceIdSet.has(source.sourceId)) return; // already in cart
            // Find items we could save money on by using this source
            var saveable = source.listings.filter(function (l) {
                var currentPrice = currentPriceMap[l.itemId];
                return currentPrice != null && l.priceUsd < currentPrice;
            });
            if (saveable.length === 0) return;
            var savings = saveable.reduce(function (s, l) {
                return s + (currentPriceMap[l.itemId] - l.priceUsd);
            }, 0);
            // Only worth adding this source if the savings exceed its shipping cost
            if (savings <= source.shippingCostUsd) return;

            // Add this source to the cart with the items it saves on
            addedInSavingsPass = true;
            cartSourceIdSet.add(source.sourceId);

            // Remove those items from their current cart entries
            saveable.forEach(function (l) {
                cart.forEach(function (c) {
                    c.assignedListings = c.assignedListings.filter(function (al) {
                        return al.itemId !== l.itemId;
                    });
                });
                currentPriceMap[l.itemId] = l.priceUsd;
            });

            var subtotal = saveable.reduce(function (s, l) { return s + l.priceUsd; }, 0);
            cart.push({
                source: source,
                assignedListings: saveable.slice(),
                shippingCostUsd: source.shippingCostUsd,
                subtotalUsd: subtotal,
                totalUsd: subtotal + source.shippingCostUsd
            });
        });
    }

    // Remove entries emptied by the savings pass
    cart = cart.filter(function (c) { return c.assignedListings.length > 0; });

    cart.forEach(function (cartEntry) {
        cartEntry.assignedListings = cartEntry.assignedListings.map(function (listing) {
            // Check all other cart sources for a cheaper listing for this item
            var cheapest = listing;
            cart.forEach(function (other) {
                if (other.source.sourceId === cartEntry.source.sourceId) return;
                var alternative = other.source.listings.find(function (l) {
                    return l.itemId === listing.itemId && l.priceUsd < cheapest.priceUsd;
                });
                if (alternative) {
                    // Flag for reassignment
                    listing._reassignTo = other.source.sourceId;
                    cheapest = alternative;
                }
            });
            return listing;
        });
    });

    // Apply reassignments
    var reassignments = [];
    cart.forEach(function (cartEntry) {
        cartEntry.assignedListings = cartEntry.assignedListings.filter(function (l) {
            if (l._reassignTo) {
                reassignments.push({ listing: l, toSourceId: l._reassignTo });
                return false;
            }
            return true;
        });
    });
    reassignments.forEach(function (r) {
        var targetEntry = cart.find(function (c) { return c.source.sourceId === r.toSourceId; });
        if (targetEntry) {
            var betterListing = targetEntry.source.listings.find(function (l) {
                return l.itemId === r.listing.itemId;
            });
            if (betterListing) targetEntry.assignedListings.push(betterListing);
        }
    });

    // Remove empty entries (all listings reassigned away)
    cart = cart.filter(function (c) { return c.assignedListings.length > 0; });

    // Recompute totals after reassignment
    cart.forEach(function (c) {
        c.subtotalUsd = c.assignedListings.reduce(function (s, l) { return s + l.priceUsd; }, 0);
        // Recompute shipping for stores with order-total-based free shipping
        if (c.source.shippingPolicyFn) {
            c.shippingCostUsd = c.source.shippingPolicyFn(c.assignedListings);
        }
        c.totalUsd = c.subtotalUsd + c.shippingCostUsd;
    });

    // Sort cart by total cost descending (biggest order first for readability)
    cart.sort(function (a, b) { return b.subtotalUsd - a.subtotalUsd; });

    var coveredIds = new Set();
    cart.forEach(function (c) {
        c.assignedListings.forEach(function (l) { coveredIds.add(l.itemId); });
    });

    var grandTotal = cart.reduce(function (s, c) { return s + c.totalUsd; }, 0);
    var grandShipping = cart.reduce(function (s, c) { return s + c.shippingCostUsd; }, 0);
    var grandRecords = cart.reduce(function (s, c) { return s + c.assignedListings.length; }, 0);

    var uncoveredItems = wantlistItems.filter(function (w) { return !coveredIds.has(w.id); });

    return {
        cart: cart,
        covered: coveredIds.size,
        total: allItemIds.size,
        uncoveredItems: uncoveredItems,
        grandTotalUsd: grandTotal,
        grandShippingUsd: grandShipping,
        grandRecordsUsd: grandTotal - grandShipping,
        numSellers: cart.length
    };
}

/**
 * Top-level entry point: build the pool + run the optimizer.
 *
 * @param {object[]} wantlistItems
 * @param {object} storeInventory   - { storeKey: rows[] }
 * @param {object} marketListings   - { discogsId: listings[] }
 * @param {object} opts
 * @param {string} opts.buyerCountry
 * @param {string} [opts.minCondition='VG+']
 * @param {number} [opts.minSellerRating=98]
 * @param {number} [opts.maxPriceUsd]
 * @returns {object} optimizer result
 */
function runOptimizer(wantlistItems, storeInventory, marketListings, opts) {
    var sources = buildSourcePool(wantlistItems, storeInventory, marketListings, opts);
    return optimizeCart(sources, wantlistItems);
}

module.exports = {
    buildSourcePool: buildSourcePool,
    optimizeCart: optimizeCart,
    runOptimizer: runOptimizer
};
