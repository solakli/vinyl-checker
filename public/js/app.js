/* Vinyl Checker Frontend */

let resultsData = [];
let isScanning = false;
let activeGenres = new Set();
let activeStyles = new Set();
let currentFilteredIds = []; // Track filtered item IDs for modal navigation
let currentModalId = null; // Currently open modal item ID

// Store logo filenames
var storeLogoMap = {
  'HHV': 'hhv.png', 'Deejay.de': 'deejay.png', 'Hardwax': 'hardwax.png',
  'Juno': 'juno.png', 'Turntable Lab': 'ttlab.png', 'Underground Vinyl': 'uvs.png',
  'Decks.de': 'decks.png', 'Phonica': 'phonica.png', 'Yoyaku': 'yoyaku.png',
  'Discogs': 'discogs.png'
};

var MAX_STYLES = 20; // Show top N styles

// Fun loading messages — vinyl buyer / crate digger vibes
var loadingMessages = [
  'Digging through crates...',
  'Flipping through the bins...',
  'Checking the new arrivals wall...',
  'Dusting off some deep cuts...',
  'Asking the clerk about restocks...',
  'Inspecting the wax for scratches...',
  'Holding it up to the light...',
  'Reading the matrix runout...',
  'Checking the dead wax...',
  'Haggling over VG+ vs NM...',
  'Sniffing for that vintage vinyl smell...',
  'Elbowing past other diggers...',
  'Sliding through the jazz section...',
  'Found a first pressing? Wait, no...',
  'Squinting at catalog numbers...',
  'Dodging overpriced reissues...',
  'Nodding along to the in-store DJ...',
  'Flipping to the back of the rack...',
  'Checking if the sleeve matches the vinyl...',
  'Mentally calculating shipping costs...',
  'Adding to cart... removing... adding back...',
  'Wondering if this is the right pressing...',
  'Comparing prices across 9 stores...',
  'Eyeing someone else\'s finds...',
  'That "one more record" feeling...',
  'Pretending the budget still exists...',
  'Stacking up the wants pile...',
  'Testing the platter spin...',
  'Admiring gatefold artwork...',
  'Peeling back the shrink wrap corner...',
  'Checking Discogs median price...',
  'Calculating cost per minute of music...',
  'Reorganizing by BPM in my head...',
  'Whispering "just one more" to myself...',
  'Scanning the 12" singles section...',
  'Spotting a white label promo...',
  'Debating colored vinyl vs black...',
  'Measuring shelf space at home...',
  'Convincing myself this is an investment...',
];
var loadingMessageInterval = null;
var lastLoadingMsgIndex = -1;
var renderThrottleTimer = null;

// Store class map
const storeClassMap = {
  'HHV': 'hhv', 'Deejay.de': 'deejay', 'Hardwax': 'hardwax',
  'Juno': 'juno', 'Turntable Lab': 'ttlab', 'Underground Vinyl': 'uvs',
  'Decks.de': 'decks', 'Phonica': 'phonica', 'Yoyaku': 'yoyaku'
};

const storeDisplayName = {
  'HHV': 'HHV', 'Deejay.de': 'Deejay', 'Hardwax': 'Hardwax',
  'Juno': 'Juno', 'Turntable Lab': 'TT Lab', 'Underground Vinyl': 'UVS',
  'Decks.de': 'Decks', 'Phonica': 'Phonica', 'Yoyaku': 'Yoyaku'
};

// Theme toggle (persisted)
(function() {
  var saved = localStorage.getItem('vinyl-checker-theme');
  if (saved === 'dark') {
    document.body.classList.remove('light');
    document.getElementById('themeToggle').textContent = 'Light';
  } else if (saved === 'light') {
    document.body.classList.add('light');
    document.getElementById('themeToggle').textContent = 'Dark';
  }
})();
document.getElementById('themeToggle').addEventListener('click', function() {
  document.body.classList.toggle('light');
  var isLight = document.body.classList.contains('light');
  this.textContent = isLight ? 'Dark' : 'Light';
  localStorage.setItem('vinyl-checker-theme', isLight ? 'light' : 'dark');
});

// Scan button
document.getElementById('scanBtn').addEventListener('click', function() { startScan(false); });
document.getElementById('rescanBtn').addEventListener('click', function() { startScan(true); });
document.getElementById('usernameInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') startScan(false);
});

// Welcome page — OAuth only (manual username removed)

function startLoadingMessages() {
  var msgEl = document.getElementById('progressCurrent');
  // Show first message immediately
  lastLoadingMsgIndex = Math.floor(Math.random() * loadingMessages.length);
  msgEl.innerHTML = '<span class="loading-msg">' + loadingMessages[lastLoadingMsgIndex] + '</span>';
  // Rotate every 3 seconds
  loadingMessageInterval = setInterval(function() {
    var idx;
    do { idx = Math.floor(Math.random() * loadingMessages.length); } while (idx === lastLoadingMsgIndex);
    lastLoadingMsgIndex = idx;
    msgEl.classList.add('msg-fade');
    setTimeout(function() {
      msgEl.innerHTML = '<span class="loading-msg">' + loadingMessages[idx] + '</span>';
      msgEl.classList.remove('msg-fade');
    }, 200);
  }, 3000);
}

function stopLoadingMessages() {
  if (loadingMessageInterval) {
    clearInterval(loadingMessageInterval);
    loadingMessageInterval = null;
  }
}

function startScan(force) {
  var username = document.getElementById('usernameInput').value.trim();
  if (!username || isScanning) return;

  localStorage.setItem('vinyl-checker-username', username);

  // Create session cookie via API
  fetch('api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username })
  }).catch(function() {});

  isScanning = true;
  resultsData = [];
  activeGenres = new Set();
  activeStyles = new Set();

  // UI updates
  document.getElementById('scanBtn').disabled = true;
  document.getElementById('scanBtn').textContent = 'Scanning...';
  document.getElementById('rescanBtn').style.display = 'none';
  document.getElementById('liveBadge').style.display = 'inline-flex';
  document.getElementById('progressSection').classList.add('active');
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('scanSection').style.display = 'flex';
  document.getElementById('controls').style.display = 'flex';
  document.getElementById('grid').innerHTML = '';
  document.getElementById('noResults').style.display = 'none';

  // Start fun loading messages
  startLoadingMessages();

  // Connect to SSE
  var scanUrl = 'api/scan/' + encodeURIComponent(username) + (force ? '?force=true' : '');
  var evtSource = new EventSource(scanUrl);

  var thinkingDotsHtml = '<span class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';

  evtSource.addEventListener('status', function(e) {
    var data = JSON.parse(e.data);
    document.getElementById('progressText').innerHTML = escapeHtml(data.message) + thinkingDotsHtml;
  });

  evtSource.addEventListener('wantlist', function(e) {
    var data = JSON.parse(e.data);
    document.getElementById('progressCount').textContent = '0 / ' + data.total;
    updateStats();
  });

  evtSource.addEventListener('batch-start', function(e) {
    var data = JSON.parse(e.data);
    document.getElementById('progressText').innerHTML = 'Batch ' + data.batch + '/' + data.totalBatches + thinkingDotsHtml;
    document.getElementById('progressCurrent').textContent = data.items.join(' | ');
  });

  evtSource.addEventListener('item-done', function(e) {
    var data = JSON.parse(e.data);
    // Avoid duplicates from cache + live
    var exists = resultsData.some(function(r) { return r.item.id === data.item.id; });
    if (!exists) {
      resultsData.push({ item: data.item, stores: data.stores, discogsPrice: data.discogsPrice || null });
    }

    // Update progress
    var pct = ((data.index + 1) / data.total * 100).toFixed(1);
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressCount').textContent = (data.index + 1) + ' / ' + data.total;
    var suffix = data.fromCache ? ' (cached)' : (data.inStock ? ' ✓' : '');
    var itemText = data.item.artist + ' — ' + data.item.title + suffix;
    var currentMsg = lastLoadingMsgIndex >= 0 ? loadingMessages[lastLoadingMsgIndex] : '';
    document.getElementById('progressCurrent').innerHTML = '<span class="progress-item-name">' + itemText + '</span>' +
      (currentMsg ? '<span class="loading-msg">' + currentMsg + '</span>' : '');

    // Throttle renders during scan to avoid jank on large wantlists
    if (!renderThrottleTimer) {
      renderThrottleTimer = setTimeout(function() {
        renderThrottleTimer = null;
        updateStats();
        render();
      }, 300);
    }
  });

  evtSource.addEventListener('batch-done', function(e) {
    var data = JSON.parse(e.data);
    document.getElementById('progressText').innerHTML = 'Batch ' + data.batch + '/' + data.totalBatches + ' done' + thinkingDotsHtml;
  });

  evtSource.addEventListener('done', function(e) {
    var data = JSON.parse(e.data);
    evtSource.close();
    stopLoadingMessages();
    isScanning = false;
    document.getElementById('scanBtn').disabled = false;
    document.getElementById('scanBtn').textContent = 'Check Wantlist';
    document.getElementById('rescanBtn').style.display = 'inline-block';
    document.getElementById('liveBadge').style.display = 'none';
    document.getElementById('progressSection').classList.remove('active');
    var msg = data.checked > 0
      ? 'Scanned ' + data.checked + ' new items \u00b7 ' + (data.cached || 0) + ' from cache'
      : 'All results loaded from cache';
    document.getElementById('timestamp').textContent = msg + ' \u00b7 ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    updateStats();
    render();
    // Check for changes detected by background rescans
    fetchChanges(username);
  });

  evtSource.addEventListener('scan-error', function(e) {
    try {
      var data = JSON.parse(e.data);
      var msg = data.message || 'Unknown error';
      // If private wantlist, show connect button inline
      if (msg.toLowerCase().indexOf('private') !== -1) {
        document.getElementById('progressText').innerHTML =
          'This wantlist is private. ' +
          '<a href="api/auth/discogs" style="color:var(--gold);text-decoration:underline;cursor:pointer;font-weight:500">' +
          'Connect Discogs to access it</a>';
        document.getElementById('progressCurrent').innerHTML =
          '<span class="loading-msg">The owner needs to authorize via OAuth to scan a private wantlist</span>';
      } else {
        document.getElementById('progressText').textContent = 'Error: ' + msg;
      }
    } catch(err) {}
    evtSource.close();
    stopLoadingMessages();
    isScanning = false;
    document.getElementById('scanBtn').disabled = false;
    document.getElementById('scanBtn').textContent = 'Check Wantlist';
    document.getElementById('liveBadge').style.display = 'none';
    // Try to load cached results even on error (user may have previous scan data)
    if (resultsData.length === 0) {
      loadResultsForUser(username);
    }
  });

  // Handle native SSE connection errors (mobile Safari drops these)
  evtSource.onerror = function() {
    if (!isScanning) return;
    evtSource.close();
    stopLoadingMessages();
    isScanning = false;
    document.getElementById('scanBtn').disabled = false;
    document.getElementById('scanBtn').textContent = 'Check Wantlist';
    document.getElementById('liveBadge').style.display = 'none';
    document.getElementById('progressSection').classList.remove('active');
    // Load whatever results we have cached (SSE drop doesn't mean no data)
    if (resultsData.length === 0) {
      loadResultsForUser(username);
    }
  };
}

// Load cached results for a connected user
async function loadExisting(username) {
  if (!username) return;
  document.getElementById('usernameInput').value = username;
  await loadResultsForUser(username);
}

async function loadResultsForUser(username) {
  try {
    var res = await fetch('api/results/' + encodeURIComponent(username));
    if (res.ok) {
      var data = await res.json();
      if (data.results && data.results.length > 0) {
        resultsData = data.results;
        document.getElementById('welcome').style.display = 'none';
        document.getElementById('scanSection').style.display = 'flex';
        document.getElementById('controls').style.display = 'flex';
        document.getElementById('rescanBtn').style.display = 'inline-block';
        var lastScan = data.lastScan ? new Date(data.lastScan).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
        document.getElementById('timestamp').textContent = 'Cached \u00b7 Last full scan: ' + lastScan;
        updateStats();
        render();
        // Check for changes after loading results
        fetchChanges(username);
      }
    }
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// CHANGES NOTIFICATION (new since last visit)
// ═══════════════════════════════════════════════════════════════

async function fetchChanges(username) {
  try {
    var res = await fetch('api/changes/' + encodeURIComponent(username));
    if (!res.ok) return;
    var data = await res.json();
    if (data.changes && data.changes.length > 0) {
      showChangesBanner(data.changes);
    }
  } catch(e) {}
}

function showChangesBanner(changes) {
  // Remove existing banner if any
  var existing = document.getElementById('changesBanner');
  if (existing) existing.remove();

  // Group changes by type
  var newInStock = changes.filter(function(c) { return c.change_type === 'now_in_stock'; });
  var outOfStock = changes.filter(function(c) { return c.change_type === 'out_of_stock'; });
  var priceDrops = changes.filter(function(c) { return c.change_type === 'price_drop'; });
  var priceUps = changes.filter(function(c) { return c.change_type === 'price_increase'; });

  // Build summary line
  var parts = [];
  if (newInStock.length > 0) parts.push('<span class="changes-new">' + newInStock.length + ' newly in stock</span>');
  if (priceDrops.length > 0) parts.push('<span class="changes-drop">' + priceDrops.length + ' price drop' + (priceDrops.length > 1 ? 's' : '') + '</span>');
  if (outOfStock.length > 0) parts.push('<span class="changes-out">' + outOfStock.length + ' went out of stock</span>');
  if (priceUps.length > 0) parts.push('<span class="changes-up">' + priceUps.length + ' price increase' + (priceUps.length > 1 ? 's' : '') + '</span>');

  var summaryText = parts.join(' · ');

  // Build detail items (show first 5 most interesting changes)
  var topChanges = newInStock.concat(priceDrops).slice(0, 5);
  var detailHtml = '';
  if (topChanges.length > 0) {
    detailHtml = '<div class="changes-details">';
    topChanges.forEach(function(c) {
      var newVal = {};
      try { newVal = JSON.parse(c.new_value || '{}'); } catch(e) {}
      var icon = c.change_type === 'now_in_stock' ? '🟢' : '📉';
      var info = c.change_type === 'now_in_stock'
        ? (c.store + (newVal.price ? ' · ' + newVal.price : ''))
        : (c.store + ' · ' + (newVal.price || ''));
      detailHtml += '<div class="changes-item">' +
        '<span class="changes-icon">' + icon + '</span>' +
        '<span class="changes-item-text">' + escapeHtml(c.artist) + ' — ' + escapeHtml(c.title) + '</span>' +
        '<span class="changes-item-info">' + escapeHtml(info) + '</span>' +
      '</div>';
    });
    if (changes.length > 5) {
      detailHtml += '<div class="changes-more">+ ' + (changes.length - 5) + ' more changes</div>';
    }
    detailHtml += '</div>';
  }

  var banner = document.createElement('div');
  banner.id = 'changesBanner';
  banner.className = 'changes-banner';
  banner.innerHTML =
    '<div class="changes-header">' +
      '<div class="changes-summary">' +
        '<span class="changes-title">Changes since last visit</span>' +
        summaryText +
      '</div>' +
      '<button class="changes-dismiss" onclick="dismissChanges()">Dismiss</button>' +
    '</div>' +
    detailHtml;

  // Insert after header, before container
  var container = document.querySelector('.container');
  container.parentNode.insertBefore(banner, container);
}

async function dismissChanges() {
  var banner = document.getElementById('changesBanner');
  try {
    var res = await fetch('api/changes/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      // Session missing — create one from current username and retry
      var username = document.getElementById('usernameInput').value.trim();
      if (username) {
        await fetch('api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username })
        });
        await fetch('api/changes/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      }
    }
  } catch(e) {}
  if (banner) {
    banner.classList.add('changes-hiding');
    setTimeout(function() { banner.remove(); }, 300);
  }
}

function parsePrice(priceStr) {
  if (!priceStr) return Infinity;
  var match = priceStr.replace(',', '.').match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : Infinity;
}

function getLowestPrice(item) {
  var lowest = Infinity;
  item.stores.forEach(function(s) {
    if (s.matches) {
      s.matches.forEach(function(m) {
        var p = parsePrice(m.price);
        if (p < lowest) lowest = p;
      });
    }
  });
  return lowest;
}

function getStoreCount(item) {
  return item.stores.filter(function(s) { return s.inStock; }).length;
}

function updateStats() {
  var total = resultsData.length;
  var inStock = resultsData.filter(function(i) { return i.stores.some(function(s) { return s.inStock && !s.linkOnly; }); }).length;

  document.getElementById('stats').innerHTML =
    '<div><span class="stat-value">' + total + '</span> wantlist</div>' +
    '<div><span class="stat-value">' + inStock + '</span> in stock</div>';

  // Update store counts
  document.querySelectorAll('.store-badge').forEach(function(badge) {
    var store = badge.dataset.store;
    var count = resultsData.filter(function(i) {
      return i.stores.some(function(s) { return s.store === store && s.inStock && !s.linkOnly; });
    }).length;
    badge.querySelector('.count').textContent = '(' + count + ')';
  });

  // Populate genre/style tags with cross-filtering:
  // - When a genre is active, only count styles from items matching that genre
  // - When a style is active, only count genres from items matching that style
  var genreCounts = {};
  var genreInStock = {};
  var styleCounts = {};
  var styleInStock = {};

  // Items filtered by active styles (for genre counts)
  var itemsForGenres = resultsData;
  if (activeStyles.size > 0) {
    itemsForGenres = resultsData.filter(function(item) {
      var itemStyles = item.item.styles ? item.item.styles.split(', ') : [];
      return itemStyles.some(function(s) { return activeStyles.has(s); });
    });
  }

  // Items filtered by active genres (for style counts)
  var itemsForStyles = resultsData;
  if (activeGenres.size > 0) {
    itemsForStyles = resultsData.filter(function(item) {
      var itemGenres = item.item.genres ? item.item.genres.split(', ') : [];
      return itemGenres.some(function(g) { return activeGenres.has(g); });
    });
  }

  itemsForGenres.forEach(function(item) {
    var itemHasStock = item.stores && item.stores.some(function(s) { return s.inStock && !s.linkOnly; });
    if (item.item.genres) item.item.genres.split(', ').forEach(function(g) {
      if (g) {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
        if (itemHasStock) genreInStock[g] = (genreInStock[g] || 0) + 1;
      }
    });
  });

  itemsForStyles.forEach(function(item) {
    var itemHasStock = item.stores && item.stores.some(function(s) { return s.inStock && !s.linkOnly; });
    if (item.item.styles) item.item.styles.split(', ').forEach(function(s) {
      if (s) {
        styleCounts[s] = (styleCounts[s] || 0) + 1;
        if (itemHasStock) styleInStock[s] = (styleInStock[s] || 0) + 1;
      }
    });
  });

  var genreSection = document.getElementById('genreSection');
  var styleSection = document.getElementById('styleSection');
  var genreTagsEl = document.getElementById('genreTags');
  var styleTagsEl = document.getElementById('styleTags');

  // Sort genres by count descending
  var genreKeys = Object.keys(genreCounts).sort(function(a, b) { return genreCounts[b] - genreCounts[a]; });
  // Top styles by count, capped
  var styleKeys = Object.keys(styleCounts).sort(function(a, b) { return styleCounts[b] - styleCounts[a]; }).slice(0, MAX_STYLES);

  genreSection.style.display = genreKeys.length > 0 ? 'flex' : 'none';
  styleSection.style.display = styleKeys.length > 0 ? 'flex' : 'none';

  // Calculate max in-stock for intensity scaling
  var maxGenreStock = Math.max.apply(null, genreKeys.map(function(g) { return genreInStock[g] || 0; }).concat([1]));
  var maxStyleStock = Math.max.apply(null, styleKeys.map(function(s) { return styleInStock[s] || 0; }).concat([1]));

  genreTagsEl.innerHTML = genreKeys.map(function(g) {
    var active = activeGenres.has(g) ? ' active' : '';
    var stock = genreInStock[g] || 0;
    var intensity = Math.round((stock / maxGenreStock) * 100);
    return '<div class="tag-badge' + active + '" data-tag="' + escapeHtml(g) + '" data-intensity="' + intensity + '" style="--tag-intensity:' + intensity + '%">' +
      escapeHtml(g) + ' <span class="tag-count">' + genreCounts[g] + '</span>' +
      (stock > 0 ? '<span class="tag-stock">' + stock + ' avail</span>' : '') + '</div>';
  }).join('');

  styleTagsEl.innerHTML = styleKeys.map(function(s) {
    var active = activeStyles.has(s) ? ' active' : '';
    var stock = styleInStock[s] || 0;
    var intensity = Math.round((stock / maxStyleStock) * 100);
    return '<div class="tag-badge' + active + '" data-tag="' + escapeHtml(s) + '" data-intensity="' + intensity + '" style="--tag-intensity:' + intensity + '%">' +
      escapeHtml(s) + ' <span class="tag-count">' + styleCounts[s] + '</span>' +
      (stock > 0 ? '<span class="tag-stock">' + stock + ' avail</span>' : '') + '</div>';
  }).join('');

  // Attach click handlers — update both tags + grid on click
  genreTagsEl.querySelectorAll('.tag-badge').forEach(function(el) {
    el.addEventListener('click', function() {
      var tag = el.dataset.tag;
      if (activeGenres.has(tag)) { activeGenres.delete(tag); } else { activeGenres.add(tag); }
      updateStats();
      render();
    });
  });
  styleTagsEl.querySelectorAll('.tag-badge').forEach(function(el) {
    el.addEventListener('click', function() {
      var tag = el.dataset.tag;
      if (activeStyles.has(tag)) { activeStyles.delete(tag); } else { activeStyles.add(tag); }
      updateStats();
      render();
    });
  });
}

function getActiveStores() {
  return [].slice.call(document.querySelectorAll('.store-badge.active')).map(function(el) { return el.dataset.store; });
}

function getDiscogsPrice(item) {
  if (item.discogsPrice && item.discogsPrice.lowestPrice) return item.discogsPrice.lowestPrice;
  return Infinity;
}

function render() {
  var search = document.getElementById('search').value.toLowerCase();
  var sort = document.getElementById('sort').value;
  var activeStores = getActiveStores();
  var inStockOnly = document.querySelector('#inStockOnly input').checked;

  var filtered = resultsData.filter(function(item) {
    if (search) {
      var haystack = (item.item.artist + ' ' + item.item.title + ' ' + item.item.label + ' ' + item.item.catno).toLowerCase();
      if (haystack.indexOf(search) === -1) return false;
    }
    if (activeGenres.size > 0) {
      var itemGenres = item.item.genres ? item.item.genres.split(', ') : [];
      var matchesGenre = itemGenres.some(function(g) { return activeGenres.has(g); });
      if (!matchesGenre) return false;
    }
    if (activeStyles.size > 0) {
      var itemStyles = item.item.styles ? item.item.styles.split(', ') : [];
      var matchesStyle = itemStyles.some(function(s) { return activeStyles.has(s); });
      if (!matchesStyle) return false;
    }
    if (inStockOnly) {
      var hasStockInActiveStore = item.stores.some(function(s) {
        return activeStores.indexOf(s.store) !== -1 && s.inStock && !s.linkOnly;
      });
      if (!hasStockInActiveStore) return false;
    }
    return true;
  });

  filtered.sort(function(a, b) {
    switch(sort) {
      case 'date-new': return (b.item.dateAdded || '').localeCompare(a.item.dateAdded || '');
      case 'date-old': return (a.item.dateAdded || '').localeCompare(b.item.dateAdded || '');
      case 'artist': return a.item.artist.localeCompare(b.item.artist);
      case 'price-low': return getLowestPrice(a) - getLowestPrice(b);
      case 'price-high': return getLowestPrice(b) - getLowestPrice(a);
      case 'stores': return getStoreCount(b) - getStoreCount(a);
      case 'discogs-low': return getDiscogsPrice(a) - getDiscogsPrice(b);
      default: return 0;
    }
  });

  var grid = document.getElementById('grid');
  var noResults = document.getElementById('noResults');

  if (filtered.length === 0) {
    grid.innerHTML = '';
    noResults.style.display = 'block';
    return;
  }

  noResults.style.display = 'none';

  // Store filtered IDs for modal navigation (swipe prev/next)
  currentFilteredIds = filtered.map(function(item) { return item.item.id; });

  grid.innerHTML = filtered.map(function(item) {
    var visibleStores = item.stores.filter(function(s) { return activeStores.indexOf(s.store) !== -1; });
    var inStockCount = visibleStores.filter(function(s) { return s.inStock && !s.linkOnly; }).length;
    var linkOnlyCount = visibleStores.filter(function(s) { return s.linkOnly; }).length;

    // Stock summary line
    var stockSummaryHtml = '';
    if (inStockCount > 0) {
      stockSummaryHtml = '<div class="stock-summary">' +
        '<span class="stock-count">' + inStockCount + ' store' + (inStockCount > 1 ? 's' : '') + '</span>' +
        '<span class="stock-label">in stock</span>' +
        (linkOnlyCount > 0 ? '<span class="link-count">' + linkOnlyCount + ' links</span>' : '') +
      '</div>';
    }

    // In-stock rows first, then not-found, then link-only
    var sortedStores = visibleStores.slice().sort(function(a, b) {
      var scoreA = a.inStock && !a.linkOnly ? 0 : (!a.linkOnly ? 1 : 2);
      var scoreB = b.inStock && !b.linkOnly ? 0 : (!b.linkOnly ? 1 : 2);
      return scoreA - scoreB;
    });

    var storeRows = stockSummaryHtml + sortedStores.map(function(s) {
        var cls = storeClassMap[s.store] || '';
        var name = storeDisplayName[s.store] || s.store;

        var shippingHtml = s.usShipping ? '<span class="shipping">+' + s.usShipping + ' US ship</span>' : '';
        var logoFile = storeLogoMap[s.store] || '';
        var logoHtml = logoFile ? '<img class="store-logo" src="img/' + logoFile + '" alt="">' : '';

        if (s.linkOnly) {
          return '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' link-only-row" onclick="event.stopPropagation()">' +
            '<span class="store-status link-only-dot"></span>' +
            '<span class="store-name">' + logoHtml + name + '</span>' +
            '<span class="match-info"><span class="link-only">Go to Store</span></span>' +
            shippingHtml +
            '</a>';
        }

        if (!s.inStock || !s.matches || s.matches.length === 0) {
          return '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' out-of-stock" onclick="event.stopPropagation()">' +
            '<span class="store-status not-found"></span>' +
            '<span class="store-name">' + logoHtml + name + '</span>' +
            '<span class="match-info"><span class="not-found">Not found</span></span>' +
            '<span class="arrow">&rarr;</span></a>';
        }

        var cheapest = s.matches.reduce(function(min, m) { return parsePrice(m.price) < parsePrice(min.price) ? m : min; }, s.matches[0]);
        var extras = s.matches.length > 1 ? ' +' + (s.matches.length - 1) + ' more' : '';

        return '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' in-stock-row" onclick="event.stopPropagation()">' +
          '<span class="store-status in-stock"></span>' +
          '<span class="store-name">' + logoHtml + name + '</span>' +
          '<span class="match-info">' + escapeHtml(cheapest.title || '') + extras + '</span>' +
          '<span class="price">' + escapeHtml(cheapest.price || '') + '</span>' +
          shippingHtml +
          '<span class="arrow">&rarr;</span></a>';
      }).join('');

    var lowest = getLowestPrice(item);
    var bestPriceHtml = lowest < Infinity
      ? '<div class="price-compare">' +
          '<span class="best-price-label">Best Store Price</span>' +
          '<span class="best-price-value">' + lowest.toFixed(2) + '</span>' +
        '</div>'
      : '';

    // Discogs marketplace price
    var discogsPriceHtml = '';
    if (item.discogsPrice && item.discogsPrice.lowestPrice) {
      var dShipping = item.discogsPrice.shipping ? '<span class="shipping">+' + item.discogsPrice.shipping + ' ship</span>' : '';
      var currSymbol = item.discogsPrice.currency === 'USD' ? '$' : item.discogsPrice.currency === 'GBP' ? '\u00a3' : item.discogsPrice.currency === 'JPY' ? '\u00a5' : '\u20ac';
      discogsPriceHtml = '<a href="' + (item.discogsPrice.marketplaceUrl || '#') + '" target="_blank" class="store-row discogs" onclick="event.stopPropagation()">' +
        '<span class="store-name"><img class="store-logo" src="img/discogs.png" alt="">Discogs</span>' +
        '<span class="match-info">' + item.discogsPrice.numForSale + ' for sale (ships to US)</span>' +
        '<span class="price">' + currSymbol + item.discogsPrice.lowestPrice.toFixed(2) + '</span>' +
        dShipping +
        '<span class="arrow">&rarr;</span></a>';
    } else if (item.discogsPrice) {
      discogsPriceHtml = '<a href="' + (item.discogsPrice.marketplaceUrl || '#') + '" target="_blank" class="store-row discogs out-of-stock" onclick="event.stopPropagation()">' +
        '<span class="store-name"><img class="store-logo" src="img/discogs.png" alt="">Discogs</span>' +
        '<span class="match-info"><span class="not-found">None for sale</span></span>' +
        '<span class="arrow">&rarr;</span></a>';
    }

    // Thumbnail
    var thumbHtml = '';
    if (item.item.thumb) {
      thumbHtml = '<img class="card-thumb" src="' + escapeHtml(item.item.thumb) + '" alt="" loading="lazy">';
    } else {
      thumbHtml = '<div class="card-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px;color:#555;">&#9835;</div>';
    }

    var hasStock = inStockCount > 0;
    var cardClass = hasStock ? 'card has-stock' : 'card no-stock';

    return '<div class="' + cardClass + '" data-discogs-id="' + item.item.id + '" onclick="openReleaseDetail(' + item.item.id + ')">' +
      '<div class="card-header">' +
        thumbHtml +
        '<div class="card-info">' +
          '<div class="card-artist">' + escapeHtml(item.item.artist) + '</div>' +
          '<div class="card-title">' + escapeHtml(item.item.title) + '</div>' +
          '<div class="card-meta">' +
            (item.item.year ? '<span>' + item.item.year + '</span>' : '') +
            (item.item.label ? '<span>' + escapeHtml(item.item.label) + '</span>' : '') +
            (item.item.catno ? '<span>' + escapeHtml(item.item.catno) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="store-results">' + storeRows + discogsPriceHtml + '</div>' +
      bestPriceHtml +
    '</div>';
  }).join('');
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════
// RELEASE DETAIL MODAL
// ═══════════════════════════════════════════════════════════════

var _navLock = false;
function navigateModal(direction) {
  if (_navLock || !currentModalId || currentFilteredIds.length === 0) return;
  var idx = currentFilteredIds.indexOf(currentModalId);
  if (idx === -1) return;
  var newIdx = idx + direction;
  if (newIdx < 0) newIdx = currentFilteredIds.length - 1;
  if (newIdx >= currentFilteredIds.length) newIdx = 0;

  _navLock = true;
  var mc = document.querySelector('.modal-content');
  var slideOut = direction > 0 ? 'slide-out-left' : 'slide-out-right';
  var slideIn = direction > 0 ? 'slide-in-right' : 'slide-in-left';

  if (mc) mc.classList.add(slideOut);

  setTimeout(function() {
    // Remove slide-out before opening new detail
    if (mc) mc.classList.remove('slide-out-left', 'slide-out-right');
    openReleaseDetail(currentFilteredIds[newIdx]);
    // Re-grab modal (same element, new content)
    var mc2 = document.querySelector('.modal-content');
    if (mc2) {
      mc2.classList.add(slideIn);
      setTimeout(function() {
        mc2.classList.remove('slide-in-left', 'slide-in-right');
        _navLock = false;
      }, 250);
    } else {
      _navLock = false;
    }
  }, 150);
}

function openReleaseDetail(discogsId) {
  var overlay = document.getElementById('modalOverlay');
  var content = document.getElementById('modalBody');

  currentModalId = discogsId;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Show loading state
  content.innerHTML = '<div class="modal-loading"><div class="spinner"></div> Loading release details...</div>';

  // Find the item in resultsData for store info
  var resultItem = resultsData.find(function(r) { return r.item.id === discogsId; });

  // Fetch release details
  fetch('api/release/' + discogsId)
    .then(function(res) { return res.json(); })
    .then(function(response) {
      if (response.error) {
        content.innerHTML = '<div class="modal-loading">Error: ' + escapeHtml(response.error) + '</div>';
        return;
      }
      renderReleaseDetail(response.data, resultItem);
    })
    .catch(function(err) {
      content.innerHTML = '<div class="modal-loading">Failed to load details</div>';
    });
}

function closeModal() {
  var overlay = document.getElementById('modalOverlay');
  overlay.classList.remove('active');
  document.body.style.overflow = '';
  currentModalId = null;

  // Stop any playing videos
  var iframes = overlay.querySelectorAll('iframe');
  iframes.forEach(function(iframe) { iframe.src = ''; });
}

function renderReleaseDetail(data, resultItem) {
  var content = document.getElementById('modalBody');

  // Subtle position indicator (no buttons — swipe to navigate)
  var navIdx = currentModalId ? currentFilteredIds.indexOf(currentModalId) : -1;
  var navHtml = '';
  if (currentFilteredIds.length > 1 && navIdx !== -1) {
    navHtml = '<div class="modal-nav-indicator">' + (navIdx + 1) + ' / ' + currentFilteredIds.length + '</div>';
  }

  // Album art: prefer high-res from release details, fall back to thumb
  var albumArt = '';
  if (data.images && data.images.length > 0) {
    albumArt = data.images[0].uri || data.images[0].uri150 || '';
  }
  if (!albumArt && resultItem && resultItem.item.thumb) {
    albumArt = resultItem.item.thumb;
  }

  var artistName = (data.artists && data.artists.length > 0)
    ? data.artists.map(function(a) { return a.name; }).join(', ')
    : (resultItem ? resultItem.item.artist : '');

  // Rating stars
  var ratingHtml = '';
  if (data.community && data.community.rating && data.community.rating.count > 0) {
    var avg = data.community.rating.average;
    var fullStars = Math.floor(avg);
    var halfStar = (avg - fullStars) >= 0.5;
    var starsStr = '';
    for (var i = 0; i < fullStars; i++) starsStr += '\u2605';
    if (halfStar) starsStr += '\u2606';
    ratingHtml = '<div class="modal-rating">' +
      '<span class="modal-stars">' + starsStr + '</span>' +
      '<span>' + avg.toFixed(1) + '/5</span>' +
      '<span class="modal-rating-count">(' + data.community.rating.count + ' ratings)</span>' +
    '</div>';
  }

  // Community stats
  var communityHtml = '';
  if (data.community) {
    communityHtml = '<span><span class="label">Have:</span> ' + (data.community.have || 0) + '</span>' +
      '<span><span class="label">Want:</span> ' + (data.community.want || 0) + '</span>';
  }

  // Format info
  var formatHtml = '';
  if (data.formats && data.formats.length > 0) {
    formatHtml = data.formats.map(function(f) {
      var desc = f.descriptions ? f.descriptions.join(', ') : '';
      return f.qty + 'x ' + f.name + (desc ? ' (' + desc + ')' : '');
    }).join(', ');
  }

  // Hero section
  var html = navHtml + '<div class="modal-hero">';
  if (albumArt) {
    html += '<div class="modal-art-wrap">' +
      '<img class="modal-album-art" src="' + escapeHtml(albumArt) + '" alt="">' +
      '<div class="price-chart-wrap" id="priceChartWrap" data-discogs-id="' + (data.id || '') + '"></div>' +
    '</div>';
  }
  html += '<div class="modal-info">' +
    '<div class="modal-artist">' + escapeHtml(artistName) + '</div>' +
    '<div class="modal-title">' + escapeHtml(data.title || '') + '</div>' +
    '<div class="modal-meta">' +
      (data.released ? '<span><span class="label">Released:</span> ' + escapeHtml(data.released) + '</span>' : '') +
      (data.country ? '<span><span class="label">Country:</span> ' + escapeHtml(data.country) + '</span>' : '') +
      (formatHtml ? '<span><span class="label">Format:</span> ' + escapeHtml(formatHtml) + '</span>' : '') +
      communityHtml +
    '</div>' +
    ratingHtml +
  '</div></div>';

  // Tracklist section
  if (data.tracklistWithVideos && data.tracklistWithVideos.length > 0) {
    html += '<div class="modal-section"><div class="modal-section-title">Tracklist</div><ul class="tracklist">';
    data.tracklistWithVideos.forEach(function(track) {
      var playBtn = '';
      if (track.videoId) {
        playBtn = '<button class="track-play" onclick="playTrackVideo(\'' + track.videoId + '\', event)">Play</button>';
      }
      html += '<li>' +
        '<span class="track-position">' + escapeHtml(track.position || '') + '</span>' +
        '<span class="track-title">' + escapeHtml(track.title || '') + '</span>' +
        '<span class="track-duration">' + escapeHtml(track.duration || '') + '</span>' +
        playBtn +
      '</li>';
    });
    html += '</ul></div>';
  } else if (data.tracklist && data.tracklist.length > 0) {
    html += '<div class="modal-section"><div class="modal-section-title">Tracklist</div><ul class="tracklist">';
    data.tracklist.forEach(function(track) {
      html += '<li>' +
        '<span class="track-position">' + escapeHtml(track.position || '') + '</span>' +
        '<span class="track-title">' + escapeHtml(track.title || '') + '</span>' +
        '<span class="track-duration">' + escapeHtml(track.duration || '') + '</span>' +
      '</li>';
    });
    html += '</ul></div>';
  }

  // Video embeds (first 3 unique videos from Discogs)
  if (data.videos && data.videos.length > 0) {
    var videoIds = [];
    data.videos.forEach(function(v) {
      var vid = extractYoutubeId(v.url);
      if (vid && videoIds.indexOf(vid) === -1 && videoIds.length < 3) {
        videoIds.push(vid);
      }
    });

    if (videoIds.length > 0) {
      html += '<div class="modal-section"><div class="modal-section-title">Videos</div><div class="video-grid">';
      videoIds.forEach(function(vid) {
        html += '<div class="video-embed">' +
          '<iframe src="https://www.youtube.com/embed/' + vid + '" allowfullscreen loading="lazy"></iframe>' +
        '</div>';
      });
      html += '</div></div>';
    }
  }

  // Inline video player (hidden by default, shown when Play button is clicked)
  html += '<div class="modal-section" id="trackVideoPlayer" style="display:none">' +
    '<div class="modal-section-title">Now Playing</div>' +
    '<div class="video-embed" id="trackVideoEmbed"></div>' +
  '</div>';

  // Store price comparison
  if (resultItem && resultItem.stores) {
    html += '<div class="modal-section modal-stores"><div class="modal-section-title">Store Prices</div>';
    var activeStores = getActiveStores();
    resultItem.stores.forEach(function(s) {
      if (activeStores.indexOf(s.store) === -1) return;
      var cls = storeClassMap[s.store] || '';
      var name = storeDisplayName[s.store] || s.store;
      var shippingHtml = s.usShipping ? '<span class="shipping">+' + s.usShipping + ' US ship</span>' : '';

      if (s.linkOnly) {
        html += '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' link-only-row">' +
          '<span class="store-status link-only-dot"></span>' +
          '<span class="store-name">' + name + '</span>' +
          '<span class="match-info"><span class="link-only">Go to Store</span></span>' +
          shippingHtml +
          '</a>';
      } else if (s.inStock && s.matches && s.matches.length > 0) {
        var cheapest = s.matches.reduce(function(min, m) { return parsePrice(m.price) < parsePrice(min.price) ? m : min; }, s.matches[0]);
        html += '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' in-stock-row">' +
          '<span class="store-status in-stock"></span>' +
          '<span class="store-name">' + name + '</span>' +
          '<span class="match-info">' + escapeHtml(cheapest.title || '') + '</span>' +
          '<span class="price">' + escapeHtml(cheapest.price || '') + '</span>' +
          shippingHtml +
          '<span class="arrow">&rarr;</span></a>';
      } else {
        html += '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' out-of-stock">' +
          '<span class="store-status not-found"></span>' +
          '<span class="store-name">' + name + '</span>' +
          '<span class="match-info"><span class="not-found">Not found</span></span>' +
          '<span class="arrow">&rarr;</span></a>';
      }
    });

    // Discogs marketplace
    if (resultItem.discogsPrice && resultItem.discogsPrice.lowestPrice) {
      var currSymbol = resultItem.discogsPrice.currency === 'USD' ? '$' : resultItem.discogsPrice.currency === 'GBP' ? '\u00a3' : '\u20ac';
      html += '<a href="' + (resultItem.discogsPrice.marketplaceUrl || '#') + '" target="_blank" class="store-row discogs">' +
        '<span class="store-name"><img class="store-logo" src="img/discogs.png" alt="">Discogs</span>' +
        '<span class="match-info">' + resultItem.discogsPrice.numForSale + ' for sale</span>' +
        '<span class="price">' + currSymbol + resultItem.discogsPrice.lowestPrice.toFixed(2) + '</span>' +
        '<span class="arrow">&rarr;</span></a>';
    }
    html += '</div>';
  }

  // Credits
  if (data.extraartists && data.extraartists.length > 0) {
    html += '<div class="modal-section"><div class="modal-section-title">Credits</div><div class="credits-list">';
    data.extraartists.forEach(function(credit) {
      html += '<div class="credit-item">' +
        escapeHtml(credit.name) +
        '<div class="credit-role">' + escapeHtml(credit.role || '') + '</div>' +
      '</div>';
    });
    html += '</div></div>';
  }

  // Notes
  if (data.notes) {
    html += '<div class="modal-section"><div class="modal-section-title">Notes</div>' +
      '<p style="font-size:12px;font-weight:300;color:var(--text-sec);line-height:1.5;letter-spacing:0.3px">' +
      escapeHtml(data.notes).substring(0, 500) +
      (data.notes.length > 500 ? '...' : '') +
      '</p></div>';
  }

  // Discogs link
  var discogsUrl = 'https://www.discogs.com/release/' + (data.id || '');
  html += '<div class="modal-section">' +
    '<a href="' + discogsUrl + '" target="_blank" class="discogs-link">View on Discogs &rarr;</a>' +
  '</div>';

  content.innerHTML = html;

  // Fetch price history and render sparkline
  var chartWrap = document.getElementById('priceChartWrap');
  if (chartWrap && chartWrap.dataset.discogsId) {
    fetch('api/price-history/' + chartWrap.dataset.discogsId)
      .then(function(res) { return res.json(); })
      .then(function(ph) { renderPriceChart(chartWrap, ph); })
      .catch(function() {});
  }
}

function renderPriceChart(container, ph) {
  if (!ph || !ph.current) {
    container.innerHTML = '<div class="price-stat-mini">No price data</div>';
    return;
  }

  var currSymbol = ph.current.currency === 'USD' ? '$' : ph.current.currency === 'GBP' ? '\u00a3' : '\u20ac';

  // Stats line
  var statsHtml = '<div class="price-stat-mini">' +
    '<span class="price-current">' + currSymbol + ph.current.lowestPrice.toFixed(2) + '</span>' +
    '<span class="price-label">lowest</span>';

  if (ph.stats) {
    var trendIcon = ph.stats.trend === 'up' ? '\u2197' : ph.stats.trend === 'down' ? '\u2198' : '\u2192';
    var trendClass = ph.stats.trend === 'down' ? 'trend-down' : ph.stats.trend === 'up' ? 'trend-up' : '';
    statsHtml += '<span class="price-trend ' + trendClass + '">' + trendIcon + ' ' + currSymbol + ph.stats.trendAmount.toFixed(2) + '</span>';
  }
  statsHtml += '</div>';

  // SVG Sparkline
  var sparkHtml = '';
  if (ph.history && ph.history.length >= 2) {
    var prices = ph.history.map(function(h) { return h.lowest_price; });
    var minP = Math.min.apply(null, prices);
    var maxP = Math.max.apply(null, prices);
    var range = maxP - minP || 1;
    var w = 200, h = 40;
    var padding = 2;

    var points = prices.map(function(p, i) {
      var x = padding + (i / (prices.length - 1)) * (w - padding * 2);
      var y = h - padding - ((p - minP) / range) * (h - padding * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    // Fill area
    var fillPoints = points + ' ' + (w - padding).toFixed(1) + ',' + (h - padding) + ' ' + padding + ',' + (h - padding);

    sparkHtml = '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polygon points="' + fillPoints + '" fill="rgba(255,102,0,0.1)" />' +
      '<polyline points="' + points + '" fill="none" stroke="rgba(255,102,0,0.6)" stroke-width="1.5" />' +
      '<circle cx="' + points.split(' ').pop().split(',')[0] + '" cy="' + points.split(' ').pop().split(',')[1] + '" r="2.5" fill="var(--gold)" />' +
    '</svg>';

    // Min/max labels
    sparkHtml += '<div class="spark-range">' +
      '<span>' + currSymbol + minP.toFixed(2) + '</span>' +
      '<span>' + ph.history.length + ' days</span>' +
      '<span>' + currSymbol + maxP.toFixed(2) + '</span>' +
    '</div>';
  } else {
    sparkHtml = '<div class="price-stat-mini"><span class="price-label">Tracking started today</span></div>';
  }

  container.innerHTML = statsHtml + sparkHtml;
}

function extractYoutubeId(url) {
  if (!url) return null;
  try {
    var parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v') || null;
    }
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '') || null;
    }
  } catch (e) {}
  return null;
}

function playTrackVideo(videoId, event) {
  event.stopPropagation();
  var player = document.getElementById('trackVideoPlayer');
  var embed = document.getElementById('trackVideoEmbed');
  player.style.display = 'block';
  embed.innerHTML = '<iframe src="https://www.youtube.com/embed/' + videoId + '?autoplay=1" allowfullscreen allow="autoplay"></iframe>';
  player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Modal event listeners
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) {
  if (!currentModalId) return;
  if (e.key === 'Escape') closeModal();
  if (e.key === 'ArrowLeft') navigateModal(-1);
  if (e.key === 'ArrowRight') navigateModal(1);
});

// Touch swipe navigation for modal
(function() {
  var overlay = document.getElementById('modalOverlay');
  var touchStartX = 0;
  var touchStartY = 0;
  var touchStartTime = 0;
  var swiping = false;

  overlay.addEventListener('touchstart', function(e) {
    if (!currentModalId) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    swiping = true;
  }, { passive: true });

  overlay.addEventListener('touchend', function(e) {
    if (!swiping || !currentModalId) return;
    swiping = false;
    var touchEndX = e.changedTouches[0].clientX;
    var touchEndY = e.changedTouches[0].clientY;
    var dx = touchEndX - touchStartX;
    var dy = touchEndY - touchStartY;
    var elapsed = Date.now() - touchStartTime;

    // Must be a horizontal swipe: >60px, mostly horizontal, within 500ms
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && elapsed < 500) {
      if (dx > 0) {
        navigateModal(-1); // swipe right = previous
      } else {
        navigateModal(1); // swipe left = next
      }
    }
  }, { passive: true });
})();

// Mobile filter toggle
document.getElementById('filterToggle').addEventListener('click', function() {
  var controls = document.getElementById('controls');
  controls.classList.toggle('filters-open');
  this.classList.toggle('active');
  this.textContent = controls.classList.contains('filters-open') ? 'Hide Filters' : 'Filters';
});

// Event listeners
document.getElementById('search').addEventListener('input', render);
document.getElementById('sort').addEventListener('change', render);
// Genre/style tag click handlers are attached dynamically in updateFilters()

document.querySelectorAll('.store-badge').forEach(function(el) {
  el.addEventListener('click', function() {
    el.classList.toggle('active');
    render();
  });
});

document.getElementById('inStockOnly').addEventListener('click', function() {
  var cb = this.querySelector('input');
  cb.checked = !cb.checked;
  this.classList.toggle('active', cb.checked);
  render();
});

// ═══════════════════════════════════════════════════════════════
// AUTH & YOUTUBE PLAYLIST
// ═══════════════════════════════════════════════════════════════

var authState = { discogs: false, youtube: false };

async function checkAuthStatus() {
  try {
    var res = await fetch('api/auth/status');
    if (!res.ok) return;
    var data = await res.json();
    authState = data;

    var userBar = document.getElementById('userBar');
    var connectHeader = document.getElementById('connectDiscogsHeader');

    // Discogs connected — show user bar + scan section
    if (data.discogs && data.discogs.connected) {
      userBar.style.display = 'flex';
      connectHeader.style.display = 'none';
      document.getElementById('userBarName').textContent = data.discogs.username;
      document.getElementById('scanSection').style.display = 'flex';

      // Auto-fill username input if empty
      var usernameInput = document.getElementById('usernameInput');
      if (!usernameInput.value) {
        usernameInput.value = data.discogs.username;
      }
    } else if (data.discogsOAuthEnabled) {
      // Not connected but OAuth available — show connect button in header
      // (only when results are loaded, i.e. past the welcome page)
      userBar.style.display = 'none';
      if (resultsData.length > 0 || document.getElementById('welcome').style.display === 'none') {
        connectHeader.style.display = 'inline-flex';
      }
    }

    // YouTube button
    var youtubeBtn = document.getElementById('connectYoutube');
    var playlistBtn = document.getElementById('createPlaylistBtn');
    if (data.youtubeEnabled && data.discogs && data.discogs.connected) {
      if (data.youtube && data.youtube.connected) {
        youtubeBtn.style.display = 'none';
        playlistBtn.style.display = 'inline-flex';
      } else {
        youtubeBtn.style.display = 'inline-flex';
        playlistBtn.style.display = 'none';
      }
    }
  } catch(e) {}
}

async function disconnectDiscogs() {
  if (!confirm('Disconnect and return to the welcome page?')) return;
  try {
    await fetch('api/auth/discogs/disconnect', { method: 'POST' });
    await fetch('api/logout', { method: 'POST' });
  } catch(e) {}
  // Clear local state
  localStorage.removeItem('vinyl-checker-username');
  // Reset UI to welcome
  document.getElementById('userBar').style.display = 'none';
  document.getElementById('connectDiscogsHeader').style.display = 'none';
  document.getElementById('scanSection').style.display = 'none';
  document.getElementById('usernameInput').value = '';
  document.getElementById('welcome').style.display = '';
  document.getElementById('controls').style.display = 'none';
  document.getElementById('grid').innerHTML = '';
  document.getElementById('stats').innerHTML = '';
  document.getElementById('timestamp').textContent = '';
  document.getElementById('rescanBtn').style.display = 'none';
  resultsData = [];
  activeGenres = new Set();
  activeStyles = new Set();
}

async function createYoutubePlaylist() {
  if (!resultsData || resultsData.length === 0) {
    alert('No wantlist loaded. Scan first!');
    return;
  }

  var btn = document.getElementById('createPlaylistBtn');
  btn.disabled = true;
  btn.textContent = 'Creating playlist...';

  // Collect all video IDs from release details
  // We need to fetch release details for each item to get video IDs
  var videoIds = [];
  var statusEl = document.getElementById('authStatus');
  statusEl.textContent = 'Fetching track videos...';

  for (var i = 0; i < resultsData.length; i++) {
    var item = resultsData[i];
    try {
      var res = await fetch('api/release/' + item.item.id);
      if (res.ok) {
        var data = await res.json();
        if (data.data && data.data.tracklistWithVideos) {
          data.data.tracklistWithVideos.forEach(function(track) {
            if (track.videoId && videoIds.indexOf(track.videoId) === -1) {
              videoIds.push(track.videoId);
            }
          });
        } else if (data.data && data.data.videos) {
          data.data.videos.forEach(function(v) {
            var vid = extractYoutubeId(v.url);
            if (vid && videoIds.indexOf(vid) === -1) videoIds.push(vid);
          });
        }
      }
      statusEl.textContent = 'Fetching videos... ' + (i + 1) + '/' + resultsData.length + ' (' + videoIds.length + ' videos)';
    } catch(e) {}

    // Small delay to avoid rate limits
    if (i < resultsData.length - 1) {
      await new Promise(function(r) { setTimeout(r, 300); });
    }
  }

  if (videoIds.length === 0) {
    alert('No YouTube videos found in your wantlist releases.');
    btn.disabled = false;
    btn.innerHTML = '<span class="auth-icon">&#9835;</span> Create YouTube Playlist';
    statusEl.textContent = '';
    return;
  }

  statusEl.textContent = 'Creating playlist with ' + videoIds.length + ' videos...';

  var username = document.getElementById('usernameInput').value.trim();
  try {
    var res = await fetch('api/youtube/create-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: username + "'s Vinyl Wantlist",
        description: 'Auto-generated playlist from Discogs wantlist by Vinyl Checker. ' + videoIds.length + ' tracks from ' + resultsData.length + ' releases.',
        videoIds: videoIds
      })
    });
    var result = await res.json();
    if (result.ok) {
      statusEl.innerHTML = '<a href="' + result.playlistUrl + '" target="_blank" style="color:var(--green)">Playlist created! ' + result.added + '/' + result.total + ' videos added &rarr;</a>';
    } else {
      statusEl.textContent = 'Error: ' + (result.error || 'Unknown error');
    }
  } catch(e) {
    statusEl.textContent = 'Error creating playlist';
  }

  btn.disabled = false;
  btn.innerHTML = '<span class="auth-icon">&#9835;</span> Create YouTube Playlist';
}

// Handle auth redirects (check URL params)
var autoScanAfterAuth = false;
var autoScanUsername = '';
(function() {
  var params = new URLSearchParams(window.location.search);
  if (params.get('auth') === 'discogs') {
    var username = params.get('username');
    if (username) {
      document.getElementById('usernameInput').value = username;
      localStorage.setItem('vinyl-checker-username', username);
      autoScanAfterAuth = true;
      autoScanUsername = username;
    }
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('auth') === 'youtube') {
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('auth_error')) {
    document.getElementById('authStatus').textContent = 'Auth error: ' + params.get('auth_error');
    window.history.replaceState({}, '', window.location.pathname);
  }
})();

// If returning from OAuth, show a connected state on the welcome page before scanning
if (autoScanAfterAuth && autoScanUsername) {
  var welcomeEl = document.getElementById('welcome');
  var actionsEl = welcomeEl.querySelector('.welcome-actions');
  if (actionsEl) {
    actionsEl.innerHTML =
      '<div class="welcome-connected">' +
        '<div class="welcome-connected-icon">&#10003;</div>' +
        '<h3>Connected as ' + escapeHtml(autoScanUsername) + '</h3>' +
        '<p>Starting wantlist scan...</p>' +
      '</div>';
  }
}

// Init — check auth first, then decide what to show
checkAuthStatus().then(function() {
  if (autoScanAfterAuth) {
    // Just came from OAuth — show connected splash, then auto-scan
    setTimeout(function() { startScan(false); }, 1200);
  } else if (authState && authState.discogs && authState.discogs.connected) {
    // Already connected — load cached results directly
    return loadExisting(authState.discogs.username);
  } else {
    // Not OAuth-connected — check localStorage for a saved username (manual flow)
    var savedUsername = localStorage.getItem('vinyl-checker-username');
    if (savedUsername) {
      document.getElementById('usernameInput').value = savedUsername;
      return loadExisting(savedUsername);
    }
  }
  // No saved state — welcome page stays visible
});
