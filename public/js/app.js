/* Gold Digger Frontend */

let resultsData = [];
let isScanning = false;
let isOAuthed = false; // Track if user connected via Discogs OAuth
let activeGenres = new Set();
let activeStyles = new Set();
let currentFilteredIds = []; // Track filtered item IDs for modal navigation
let currentModalId = null; // Currently open modal item ID

// Store logo filenames
var storeLogoMap = {
  'HHV': 'hhv.png', 'Deejay.de': 'deejay.png', 'Hardwax': 'hardwax.png',
  'Juno': 'juno.png', 'Turntable Lab': 'ttlab.png', 'Underground Vinyl': 'uvs.png',
  'Decks.de': 'decks.png', 'Phonica': 'phonica.png', 'Yoyaku': 'yoyaku.png',
  'Gramaphone': 'gramaphone.png', 'Further Records': 'further.png',
  'Octopus Records NYC': 'octopus.png', 'Discogs': 'discogs.png'
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
  'Comparing prices across 12 stores...',
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
  'Decks.de': 'decks', 'Phonica': 'phonica', 'Yoyaku': 'yoyaku',
  'Gramaphone': 'gramaphone', 'Further Records': 'further',
  'Octopus Records NYC': 'octopus'
};

const storeDisplayName = {
  'HHV': 'HHV', 'Deejay.de': 'Deejay', 'Hardwax': 'Hardwax',
  'Juno': 'Juno', 'Turntable Lab': 'TT Lab', 'Underground Vinyl': 'UVS',
  'Decks.de': 'Decks', 'Phonica': 'Phonica', 'Yoyaku': 'Yoyaku',
  'Gramaphone': 'Gramaphone', 'Further Records': 'Further',
  'Octopus Records NYC': 'Octopus'
};

// Theme toggle (persisted)
(function() {
  var saved = localStorage.getItem('gold-digger-theme');
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
  localStorage.setItem('gold-digger-theme', isLight ? 'light' : 'dark');
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
  msgEl.innerHTML = '<span class="progress-item-name" style="font-style:italic;color:var(--gold);opacity:0.7">' + loadingMessages[lastLoadingMsgIndex] + '</span>';
  // Rotate every 3 seconds
  loadingMessageInterval = setInterval(function() {
    var idx;
    do { idx = Math.floor(Math.random() * loadingMessages.length); } while (idx === lastLoadingMsgIndex);
    lastLoadingMsgIndex = idx;
    msgEl.classList.add('msg-fade');
    setTimeout(function() {
      msgEl.innerHTML = '<span class="progress-item-name" style="font-style:italic;color:var(--gold);opacity:0.7">' + loadingMessages[idx] + '</span>';
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

var sseReconnectCount = 0;
var maxSseReconnects = 3;

function startScan(force, resume) {
  var username = document.getElementById('usernameInput').value.trim();
  if (!username || isScanning) return;

  localStorage.setItem('gold-digger-username', username);

  // Remove resume banner if present
  var rb = document.getElementById('resumeBanner');
  if (rb) rb.remove();

  // Create session cookie via API
  fetch('api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username })
  }).catch(function() {});

  isScanning = true;
  if (!resume) {
    resultsData = [];
    activeGenres = new Set();
    activeStyles = new Set();
    document.getElementById('grid').innerHTML = '';
  }
  sseReconnectCount = 0;

  // UI updates
  document.getElementById('scanBtn').disabled = true;
  document.getElementById('scanBtn').textContent = 'Scanning...';
  document.getElementById('rescanBtn').style.display = 'none';
  document.getElementById('liveBadge').style.display = 'inline-flex';
  document.getElementById('progressSection').classList.add('active');
  document.getElementById('welcome').style.display = 'none';
  if (!isOAuthed) document.getElementById('scanSection').style.display = 'flex';
  // Hide rescan in user bar during scan
  if (isOAuthed) document.getElementById('userBarRescan').style.display = 'none';
  document.getElementById('controls').style.display = 'flex';
  document.getElementById('noResults').style.display = 'none';

  // Start fun loading messages
  startLoadingMessages();

  // Connect to SSE
  connectSSE(username, force);}

function connectSSE(username, force) {
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
    document.getElementById('progressCurrent').innerHTML = '<span class="progress-item-name">' + escapeHtml(itemText) + '</span>' +
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
    if (isOAuthed) {
      document.getElementById('userBarRescan').style.display = 'inline-block';
    } else {
      document.getElementById('rescanBtn').style.display = 'inline-block';
    }
    document.getElementById('liveBadge').style.display = 'none';
    document.getElementById('progressSection').classList.remove('active');
    document.getElementById('shareBtn').style.display = 'inline-block';
    var msg = data.checked > 0
      ? 'Scanned ' + data.checked + ' new items \u00b7 ' + (data.cached || 0) + ' from cache'
      : 'All results loaded from cache';
    document.getElementById('timestamp').textContent = msg + ' \u00b7 ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    updateStats();
    render();
    // Show optimizer banner when there are in-stock results
    var inStockCount = allItems.filter(function(i) { return i.stores && i.stores.some(function(s) { return s.inStock; }); }).length;
    if (inStockCount > 0) {
      document.getElementById('optimizerBanner').style.display = 'flex';
      var nb = document.getElementById('navbarCartBtn');
      if (nb) { nb.style.display = 'inline-block'; nb.textContent = 'Dig For Gold (' + inStockCount + ')'; }
    }
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
    if (isOAuthed) document.getElementById('userBarRescan').style.display = 'inline-block';
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

    // Try auto-reconnect (Safari background tab, network blip)
    if (sseReconnectCount < maxSseReconnects) {
      sseReconnectCount++;
      document.getElementById('progressText').innerHTML = 'Reconnecting... (attempt ' + sseReconnectCount + '/' + maxSseReconnects + ')' +
        '<span class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
      setTimeout(function() {
        if (isScanning) connectSSE(username, false);
      }, 2000);
      return;
    }

    // Max reconnects exhausted — show lost state
    stopLoadingMessages();
    isScanning = false;
    document.getElementById('scanBtn').disabled = false;
    document.getElementById('scanBtn').textContent = 'Check Wantlist';
    if (isOAuthed) {
      document.getElementById('userBarRescan').style.display = 'inline-block';
    } else {
      document.getElementById('rescanBtn').style.display = 'inline-block';
    }
    document.getElementById('liveBadge').style.display = 'none';
    document.getElementById('progressSection').classList.remove('active');
    // Show connection lost message
    var partial = resultsData.length > 0 ? ' (' + resultsData.length + ' items loaded)' : '';
    document.getElementById('timestamp').textContent = 'Connection lost \u2014 scan may still be running on server' + partial;
    // Load whatever results we have cached
    if (resultsData.length === 0) {
      loadResultsForUser(username);
    } else {
      updateStats();
      render();
    }
  };
}

// Check if a scan is still running on the server (for resume after tab switch / browser close)
async function checkScanAndResume(username) {
  try {
    var res = await fetch('api/scan-status/' + encodeURIComponent(username));
    if (!res.ok) return false;
    var status = await res.json();

    if (status.active && !status.done && status.total > 0) {
      // Scan is still running — show resume banner
      showResumeBanner(username, status);
      return true;
    }
    if (status.done && status.total > 0 && status.completed < status.total) {
      // Scan finished but was partial — just load results
      return false;
    }
  } catch(e) {}
  return false;
}

function showResumeBanner(username, status) {
  // Remove existing
  var existing = document.getElementById('resumeBanner');
  if (existing) existing.remove();

  var pct = status.total > 0 ? Math.round(status.completed / status.total * 100) : 0;
  var banner = document.createElement('div');
  banner.id = 'resumeBanner';
  banner.className = 'resume-banner';
  banner.innerHTML =
    '<div class="resume-title">Welcome back!</div>' +
    '<div class="resume-progress">' +
      'Your scan is still running \u2014 <strong>' + status.completed + ' / ' + status.total + '</strong> items checked (' + pct + '%)' +
      (status.lastItem ? '<br><span style="font-size:12px;opacity:0.6">Last: ' + escapeHtml(status.lastItem) + '</span>' : '') +
    '</div>' +
    '<button class="resume-btn" onclick="resumeScan()">Resume Scan</button>';

  var container = document.querySelector('.container');
  container.insertBefore(banner, container.firstChild);

  // Also load cached results behind the banner
  loadResultsForUser(username);
}

function resumeScan() {
  var username = document.getElementById('usernameInput').value.trim();
  if (!username) return;
  startScan(false, true);
}

// Load cached results for a connected user
async function loadExisting(username) {
  if (!username) return;
  document.getElementById('usernameInput').value = username;
  // Check if a scan is still running on the server
  var scanning = await checkScanAndResume(username);
  if (!scanning) await loadResultsForUser(username);
}

async function loadResultsForUser(username) {
  try {
    var res = await fetch('api/results/' + encodeURIComponent(username));
    if (res.ok) {
      var data = await res.json();
      if (data.results && data.results.length > 0) {
        resultsData = data.results;
        document.getElementById('welcome').style.display = 'none';
        if (!isOAuthed) {
          document.getElementById('scanSection').style.display = 'flex';
          document.getElementById('rescanBtn').style.display = 'inline-block';
        } else {
          document.getElementById('userBarRescan').style.display = 'inline-block';
        }
        document.getElementById('controls').style.display = 'flex';
        document.getElementById('shareBtn').style.display = 'inline-block';
        var lastScan = data.lastScan ? new Date(data.lastScan).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
        document.getElementById('timestamp').textContent = 'Cached \u00b7 Last full scan: ' + lastScan;
        updateStats();
        render();
        // Show optimizer banner if any in-stock items exist
        var inStockCount = resultsData.filter(function(i) { return i.stores && i.stores.some(function(s) { return s.inStock; }); }).length;
        if (inStockCount > 0) {
          document.getElementById('optimizerBanner').style.display = 'flex';
          var nb = document.getElementById('navbarCartBtn');
          if (nb) { nb.style.display = 'inline-block'; nb.textContent = 'Dig For Gold (' + inStockCount + ')'; }
        }
        // Check for changes after loading results
        fetchChanges(username);
      }
    }
  } catch(e) {
    console.error('Failed to load results:', e);
    document.getElementById('timestamp').textContent = 'Failed to load results \u2014 try refreshing the page';
  }
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
    if (resultsData.length === 0) {
      noResults.textContent = 'No wantlist items found \u2014 add records to your Discogs wantlist and scan again';
    } else if (inStockOnly) {
      var totalInStock = resultsData.filter(function(i) { return i.stores.some(function(s) { return s.inStock && !s.linkOnly; }); }).length;
      noResults.textContent = totalInStock === 0 ? 'Nothing in stock right now \u2014 we check daily and will show new finds here' : 'No in-stock items match your current store/genre filters';
    } else {
      noResults.textContent = 'No items match your filters';
    }
    noResults.style.display = 'block';
    return;
  }

  noResults.style.display = 'none';

  // Store filtered IDs for modal navigation (swipe prev/next)
  currentFilteredIds = filtered.map(function(item) { return item.item.id; });

  grid.innerHTML = filtered.map(function(item) {
    var visibleStores = item.stores.filter(function(s) { return activeStores.indexOf(s.store) !== -1; });
    var inStockCount = visibleStores.filter(function(s) { return s.inStock && !s.linkOnly; }).length;

    // Find cheapest in-stock store + URL for "Add to Cart" button
    var cheapestStore = null;
    var cheapestPrice = Infinity;
    var cheapestUrl = '#';
    visibleStores.forEach(function(s) {
      if (s.inStock && !s.linkOnly && s.matches && s.matches.length > 0) {
        s.matches.forEach(function(m) {
          var p = parsePrice(m.price);
          if (p < cheapestPrice) {
            cheapestPrice = p;
            cheapestStore = s;
            cheapestUrl = s.searchUrl || '#';
          }
        });
      }
    });

    // Discogs release URL for Wishlist button
    var discogsReleaseUrl = 'https://www.discogs.com/release/' + item.item.id;

    // Vinyl disc SVG — always shown peeking behind the cover
    var vinylDisc = '<svg class="card-vinyl-disc" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="50" cy="50" r="50" fill="#111"/>' +
      '<circle cx="50" cy="50" r="46" fill="none" stroke="#222" stroke-width="1.5"/>' +
      '<circle cx="50" cy="50" r="42" fill="none" stroke="#1e1e1e" stroke-width="3"/>' +
      '<circle cx="50" cy="50" r="37" fill="none" stroke="#222" stroke-width="2"/>' +
      '<circle cx="50" cy="50" r="32" fill="none" stroke="#1e1e1e" stroke-width="2.5"/>' +
      '<circle cx="50" cy="50" r="27" fill="none" stroke="#222" stroke-width="1.5"/>' +
      '<circle cx="50" cy="50" r="22" fill="none" stroke="#1e1e1e" stroke-width="2"/>' +
      '<circle cx="50" cy="50" r="17" fill="none" stroke="#222" stroke-width="1.5"/>' +
      '<circle cx="50" cy="50" r="10" fill="#1a1a1a"/>' +
      '<circle cx="50" cy="50" r="10" fill="none" stroke="#C9A227" stroke-width="0.8" opacity="0.5"/>' +
      '<circle cx="50" cy="50" r="3" fill="#C9A227" opacity="0.7"/>' +
    '</svg>';

    // Album art
    var artHtml = '';
    if (item.item.thumb) {
      artHtml = '<img class="card-cover" src="' + escapeHtml(item.item.thumb) + '" alt="" loading="lazy">' + vinylDisc;
    } else {
      artHtml = '<div class="card-art-placeholder">' +
        '<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<circle cx="50" cy="50" r="48" stroke="#C9A227" stroke-width="2"/>' +
          '<circle cx="50" cy="50" r="32" stroke="#C9A227" stroke-width="1.5"/>' +
          '<circle cx="50" cy="50" r="18" stroke="#C9A227" stroke-width="1"/>' +
          '<circle cx="50" cy="50" r="5" fill="#C9A227" opacity="0.6"/>' +
        '</svg>' +
      '</div>' + vinylDisc;
    }

    // Price display
    var lowest = getLowestPrice(item);
    var priceHtml = '';
    if (lowest < Infinity) {
      priceHtml = '<div class="card-price-label">Current Lowest Price</div>' +
        '<div class="card-price-v2">$' + lowest.toFixed(2) + '</div>';
    } else if (item.discogsPrice && item.discogsPrice.lowestPrice) {
      var currSymbol = item.discogsPrice.currency === 'USD' ? '$' : item.discogsPrice.currency === 'GBP' ? '\u00a3' : item.discogsPrice.currency === 'JPY' ? '\u00a5' : '\u20ac';
      priceHtml = '<div class="card-price-label">Discogs Marketplace</div>' +
        '<div class="card-price-v2">' + currSymbol + item.discogsPrice.lowestPrice.toFixed(2) + '</div>';
    } else {
      priceHtml = '<div class="card-price-label">Not found in stores</div>' +
        '<div class="card-price-v2 no-price">—</div>';
    }

    // Meta: year + format hint + label/catno
    var metaParts = [];
    if (item.item.year) metaParts.push(item.item.year);
    if (item.item.formats && item.item.formats.length > 0) {
      var fmt = item.item.formats[0];
      var fmtStr = fmt.name || '12"';
      if (fmt.descriptions && fmt.descriptions.length > 0) fmtStr += ' ' + fmt.descriptions[0];
      metaParts.push(fmtStr);
    } else {
      metaParts.push('12" LP');
    }

    // Label / catno for meta
    if (item.item.label) metaParts.push(escapeHtml(item.item.label));
    if (item.item.catno && item.item.catno !== 'none') metaParts.push(escapeHtml(item.item.catno));

    // Stock badge shown in condition slot when in stock
    var condBadge = inStockCount > 0
      ? '<div class="card-condition">' + inStockCount + (inStockCount === 1 ? ' store' : ' stores') + '</div>'
      : '';

    var cardExtraClass = inStockCount > 0 ? ' card-v2-instock' : ' card-v2-nostock';

    // ── Store availability rows ──────────────────────────────────
    var storeRowsHtml = '';
    var inStockStores = visibleStores.filter(function(s) { return s.inStock || s.linkOnly; });

    // Build Discogs row — either from extension-synced listings or API price summary
    var discogsRowHtml = '';
    var dl = item.discogsListings;
    var dp = item.discogsPrice;
    if (dl && dl.numListings > 0) {
      // Extension has synced individual listings — show rich data
      var currSym = (dp && dp.currency === 'GBP') ? '£' : (dp && dp.currency === 'EUR') ? '€' : '$';
      var cheapestDiscogsPrice = dl.cheapestUsd ? (currSym + dl.cheapestUsd.toFixed(2)) : (dp && dp.lowestPrice ? (currSym + dp.lowestPrice.toFixed(2)) : null);
      var usHtml = dl.usCount > 0
        ? '<span class="card-store-tag us-ship">🇺🇸 from $' + dl.cheapestUsUsd.toFixed(2) + '</span>'
        : '<span class="card-store-tag no-us">No US sellers</span>';
      var discogsUrl = (dp && dp.marketplaceUrl) ? dp.marketplaceUrl : ('https://www.discogs.com/sell/release/' + item.item.id);
      discogsRowHtml = '<a class="card-store-row discogs-row" href="' + escapeHtml(discogsUrl) + '" target="_blank" onclick="event.stopPropagation()">' +
        '<img class="card-store-logo" src="img/discogs.png" alt="Discogs">' +
        '<span class="card-store-name">Discogs</span>' +
        '<span class="card-store-meta">' + dl.numListings + ' listings</span>' +
        usHtml +
        (cheapestDiscogsPrice ? '<span class="card-store-price">' + cheapestDiscogsPrice + '</span>' : '') +
        '</a>';
    } else if (dp && dp.lowestPrice) {
      // Only API price summary available
      var currSym2 = dp.currency === 'GBP' ? '£' : dp.currency === 'EUR' ? '€' : '$';
      var discogsUrl2 = dp.marketplaceUrl || ('https://www.discogs.com/sell/release/' + item.item.id);
      discogsRowHtml = '<a class="card-store-row discogs-row" href="' + escapeHtml(discogsUrl2) + '" target="_blank" onclick="event.stopPropagation()">' +
        '<img class="card-store-logo" src="img/discogs.png" alt="Discogs">' +
        '<span class="card-store-name">Discogs</span>' +
        '<span class="card-store-meta">' + (dp.numForSale || '?') + ' for sale</span>' +
        '<span class="card-store-tag sync-hint">Sync for details</span>' +
        '<span class="card-store-price">' + currSym2 + dp.lowestPrice.toFixed(2) + '</span>' +
        '</a>';
    }

    if (inStockStores.length > 0 || discogsRowHtml) {
      storeRowsHtml = '<div class="card-store-rows">';

      // In-stock and link-only store rows
      inStockStores.forEach(function(s) {
        var logoFile = storeLogoMap[s.store] || '';
        var logoHtml = logoFile
          ? '<img class="card-store-logo" src="img/' + logoFile + '" alt="' + escapeHtml(s.store) + '">'
          : '<span class="card-store-initials">' + escapeHtml((storeDisplayName[s.store] || s.store).charAt(0)) + '</span>';
        var storeName = storeDisplayName[s.store] || s.store;

        // Shipping tag (every store has usShipping)
        var shipHtml = s.usShipping
          ? '<span class="card-store-tag ship-cost">+' + escapeHtml(s.usShipping) + ' ship</span>'
          : '';

        if (s.linkOnly) {
          storeRowsHtml += '<a class="card-store-row link-only" href="' + escapeHtml(s.searchUrl || '#') + '" target="_blank" onclick="event.stopPropagation()">' +
            logoHtml +
            '<span class="card-store-name">' + escapeHtml(storeName) + '</span>' +
            shipHtml +
            '<span class="card-store-price link-only-label">Check →</span>' +
            '</a>';
        } else if (s.inStock && s.matches && s.matches.length > 0) {
          var cheapestM = s.matches.reduce(function(min, m) { return parsePrice(m.price) < parsePrice(min.price) ? m : min; }, s.matches[0]);
          var copiesHtml = s.matches.length > 1
            ? '<span class="card-store-meta">' + s.matches.length + ' copies</span>'
            : '';
          storeRowsHtml += '<a class="card-store-row in-stock" href="' + escapeHtml(s.searchUrl || '#') + '" target="_blank" onclick="event.stopPropagation()">' +
            logoHtml +
            '<span class="card-store-name">' + escapeHtml(storeName) + '</span>' +
            copiesHtml +
            shipHtml +
            '<span class="card-store-price">' + escapeHtml(cheapestM.price || '') + '</span>' +
            '</a>';
        }
      });

      // Discogs row at the bottom
      storeRowsHtml += discogsRowHtml;
      storeRowsHtml += '</div>';
    }

    return '<div class="card-v2' + cardExtraClass + '" data-discogs-id="' + item.item.id + '" onclick="openReleaseDetail(' + item.item.id + ')">' +
      '<div class="card-art">' +
        artHtml +
        condBadge +
      '</div>' +
      '<div class="card-body">' +
        '<div class="card-artist">' + escapeHtml(item.item.artist) + '</div>' +
        '<div class="card-title-v2">' + escapeHtml(item.item.title) + '</div>' +
        '<div class="card-meta">' + metaParts.join(' · ') + '</div>' +
        priceHtml +
        storeRowsHtml +
        '<div class="card-actions">' +
          '<button class="btn-add-cart" onclick="event.stopPropagation();window.open(\'' + escapeHtml(cheapestUrl) + '\',\'_blank\')">Add to Cart</button>' +
          '<button class="btn-wishlist" onclick="event.stopPropagation();window.open(\'' + discogsReleaseUrl + '\',\'_blank\')">Wishlist</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
        var verifyId = 'verify-' + s.store.replace(/[^a-zA-Z]/g, '') + '-' + (data.id || '');
        html += '<div class="store-row-wrap">' +
          '<a href="' + s.searchUrl + '" target="_blank" class="store-row ' + cls + ' in-stock-row">' +
          '<span class="store-status in-stock"></span>' +
          '<span class="store-name">' + name + '</span>' +
          '<span class="match-info">' + escapeHtml(cheapest.title || '') + '</span>' +
          '<span class="price">' + escapeHtml(cheapest.price || '') + '</span>' +
          shippingHtml +
          '<span class="arrow">&rarr;</span></a>' +
          '<button class="verify-btn" id="' + verifyId + '" onclick="verifyStore(\'' + escapeHtml(s.store) + '\', \'' + escapeHtml(s.searchUrl) + '\', \'' + escapeHtml(resultItem.item.artist) + '\', \'' + escapeHtml(resultItem.item.title) + '\', ' + (data.id || 0) + ', this); event.stopPropagation();">Verify</button>' +
          '</div>';
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

  // Stock history timeline (loaded async)
  html += '<div class="modal-section" id="stockHistorySection" style="display:none">' +
    '<div class="modal-section-title">Availability History</div>' +
    '<div id="stockHistoryContent"></div>' +
  '</div>';

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

    // Fetch full history (store stock + discogs prices)
    fetch('api/history/' + chartWrap.dataset.discogsId)
      .then(function(res) { return res.json(); })
      .then(function(hist) { renderStockHistory(hist); })
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

function verifyStore(store, searchUrl, artist, title, discogsId, btn) {
  btn.disabled = true;
  btn.textContent = 'Checking...';
  btn.classList.add('verifying');

  fetch('api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store: store, searchUrl: searchUrl, artist: artist, title: title, discogsId: discogsId })
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    btn.classList.remove('verifying');
    if (result.error) {
      btn.textContent = 'Error';
      btn.title = result.error;
      return;
    }

    // Build step-by-step tooltip
    var steps = result.steps || {};
    var stepLabels = {
      '1a_url_resolves': 'Page loaded',
      '1b_products_in_dom': 'Products found',
      '2a_artist_match': 'Artist match',
      '2b_title_match': 'Title match',
      '3a_no_soldout': 'Not sold out',
      '3b_no_oos': 'No OOS signals',
      '3c_stock_signals': 'Stock confirmed'
    };
    var tipParts = [];
    Object.keys(stepLabels).forEach(function(key) {
      tipParts.push((steps[key] ? '\u2705' : '\u274c') + ' ' + stepLabels[key]);
    });
    var tip = tipParts.join('\n');
    if (result.reason) tip += '\n\nReason: ' + result.reason;

    if (result.verdict) {
      btn.textContent = '\u2705 Confirmed';
      btn.classList.add('verified-ok');
    } else {
      btn.textContent = '\u274c Not in stock';
      btn.classList.add('verified-bad');
      // Update the store row visual
      var row = btn.parentElement.querySelector('.store-row');
      if (row) {
        row.classList.remove('in-stock-row');
        row.classList.add('out-of-stock');
        var statusDot = row.querySelector('.store-status');
        if (statusDot) { statusDot.classList.remove('in-stock'); statusDot.classList.add('not-found'); }
      }
    }
    btn.title = tip;
  })
  .catch(function(e) {
    btn.classList.remove('verifying');
    btn.textContent = 'Failed';
    btn.title = e.message;
  });
}

function renderStockHistory(hist) {
  var section = document.getElementById('stockHistorySection');
  var container = document.getElementById('stockHistoryContent');
  if (!section || !container) return;
  if (!hist || (!hist.stores.length && !hist.discogs.length)) return;

  section.style.display = '';

  // Group store history by store
  var byStore = {};
  hist.stores.forEach(function(h) {
    if (!byStore[h.store]) byStore[h.store] = [];
    byStore[h.store].push(h);
  });

  // Get all unique dates across all stores
  var allDates = [];
  hist.stores.forEach(function(h) {
    if (allDates.indexOf(h.recorded_at) === -1) allDates.push(h.recorded_at);
  });
  allDates.sort();

  if (allDates.length < 2) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-weight:300">Tracking started today — history will appear after more scans</div>';
    return;
  }

  // Build availability grid: rows = stores, columns = dates
  var storeNames = Object.keys(byStore).sort();
  var cellW = Math.max(6, Math.min(16, Math.floor(280 / allDates.length)));
  var cellH = 14;
  var labelW = 60;
  var svgW = labelW + allDates.length * cellW + 4;
  var svgH = storeNames.length * (cellH + 2) + 20;

  var html = '<svg class="stock-grid" width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';

  // Date labels (first and last)
  html += '<text x="' + labelW + '" y="10" fill="var(--text-muted)" font-size="9" font-family="Oswald">' + allDates[0] + '</text>';
  html += '<text x="' + (labelW + (allDates.length - 1) * cellW) + '" y="10" fill="var(--text-muted)" font-size="9" font-family="Oswald" text-anchor="end">' + allDates[allDates.length - 1] + '</text>';

  storeNames.forEach(function(store, si) {
    var y = 18 + si * (cellH + 2);

    // Store label
    var shortName = (storeDisplayName[store] || store).substring(0, 8);
    html += '<text x="' + (labelW - 4) + '" y="' + (y + cellH - 2) + '" fill="var(--text-sec)" font-size="9" font-family="Oswald" text-anchor="end">' + shortName + '</text>';

    // Build date lookup for this store
    var dateMap = {};
    byStore[store].forEach(function(h) { dateMap[h.recorded_at] = h; });

    // Cells for each date
    allDates.forEach(function(date, di) {
      var x = labelW + di * cellW;
      var entry = dateMap[date];
      var color = 'rgba(255,255,255,0.04)'; // no data
      if (entry) {
        color = entry.in_stock ? 'var(--green)' : 'rgba(255,0,0,0.25)';
      }
      html += '<rect x="' + x + '" y="' + y + '" width="' + (cellW - 1) + '" height="' + cellH + '" rx="1" fill="' + color + '">';
      if (entry) {
        var tip = store + ' · ' + date + (entry.in_stock ? ' · In Stock' : ' · Out of Stock') + (entry.price ? ' · ' + entry.price : '');
        html += '<title>' + escapeHtml(tip) + '</title>';
      }
      html += '</rect>';
    });
  });

  html += '</svg>';

  // Legend
  html += '<div class="stock-legend">' +
    '<span><span class="legend-dot" style="background:var(--green)"></span> In Stock</span>' +
    '<span><span class="legend-dot" style="background:rgba(255,0,0,0.4)"></span> Out of Stock</span>' +
    '<span style="color:var(--text-muted);font-size:10px">' + allDates.length + ' days tracked</span>' +
  '</div>';

  container.innerHTML = html;
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

// Touch swipe navigation for modal — card follows finger
(function() {
  var overlay = document.getElementById('modalOverlay');
  var touchStartX = 0;
  var touchStartY = 0;
  var touchStartTime = 0;
  var tracking = false;
  var locked = false; // locked to horizontal once determined

  overlay.addEventListener('touchstart', function(e) {
    if (!currentModalId || _navLock) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    tracking = true;
    locked = false;
    var mc = document.querySelector('.modal-content');
    if (mc) mc.style.transition = 'none'; // disable transition during drag
  }, { passive: true });

  overlay.addEventListener('touchmove', function(e) {
    if (!tracking || !currentModalId) return;
    var dx = e.touches[0].clientX - touchStartX;
    var dy = e.touches[0].clientY - touchStartY;

    // Determine direction lock on first significant movement
    if (!locked && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical scroll — stop tracking
        tracking = false;
        var mc = document.querySelector('.modal-content');
        if (mc) { mc.style.transform = ''; mc.style.opacity = ''; mc.style.transition = ''; }
        return;
      }
      locked = true;
    }

    if (locked) {
      var mc = document.querySelector('.modal-content');
      if (mc) {
        var opacity = Math.max(0.3, 1 - Math.abs(dx) / 400);
        mc.style.transform = 'translateX(' + dx + 'px)';
        mc.style.opacity = opacity;
      }
    }
  }, { passive: true });

  overlay.addEventListener('touchend', function(e) {
    if (!tracking || !currentModalId) { tracking = false; return; }
    tracking = false;
    var mc = document.querySelector('.modal-content');
    var dx = e.changedTouches[0].clientX - touchStartX;
    var elapsed = Date.now() - touchStartTime;

    // Reset transition
    if (mc) mc.style.transition = '';

    // Threshold: >80px drag or fast flick (>40px in <200ms)
    var isSwipe = (Math.abs(dx) > 80) || (Math.abs(dx) > 40 && elapsed < 200);

    if (isSwipe && locked) {
      // Snap card off screen, then navigate
      if (mc) {
        mc.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
        mc.style.transform = 'translateX(' + (dx > 0 ? '120%' : '-120%') + ')';
        mc.style.opacity = '0';
      }
      var direction = dx > 0 ? -1 : 1;
      setTimeout(function() {
        if (mc) { mc.style.transform = ''; mc.style.opacity = ''; mc.style.transition = ''; }
        navigateModal(direction);
      }, 150);
    } else {
      // Snap back
      if (mc) {
        mc.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        mc.style.transform = '';
        mc.style.opacity = '';
        setTimeout(function() { if (mc) mc.style.transition = ''; }, 200);
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

    // Discogs connected — show user bar, hide redundant scan section
    if (data.discogs && data.discogs.connected) {
      isOAuthed = true;
      userBar.style.display = 'flex';
      connectHeader.style.display = 'none';
      document.getElementById('userBarName').textContent = data.discogs.username;
      // Set username for scan functions but don't show the input
      document.getElementById('usernameInput').value = data.discogs.username;
      document.getElementById('scanSection').style.display = 'none';
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

function shareWantlist() {
  var username = document.getElementById('usernameInput').value.trim();
  if (!username) return;
  var shareUrl = window.location.origin + window.location.pathname + '?share=' + encodeURIComponent(username);

  // Try native share (mobile), fall back to clipboard
  if (navigator.share) {
    navigator.share({
      title: username + ' — Gold Digger Wantlist',
      url: shareUrl
    }).catch(function() {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(function() {
      var btn = document.getElementById('shareBtn');
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = 'Share'; }, 2000);
    });
  } else {
    prompt('Share this link:', shareUrl);
  }
}

function handleConnectDiscogs() {
  if (authState && authState.discogsOAuthEnabled) {
    window.location.href = 'api/auth/discogs';
  } else {
    // OAuth not configured — show username input inline on welcome page
    var form = document.getElementById('welcomeUsernameForm');
    var hint = document.getElementById('welcomeHint');
    if (form) { form.style.display = 'block'; }
    if (hint) { hint.style.display = 'none'; }
    var inp = document.getElementById('welcomeUsernameInput');
    if (inp) { inp.focus(); }
  }
}

function handleWelcomeUsernameSubmit() {
  var inp = document.getElementById('welcomeUsernameInput');
  var username = inp ? inp.value.trim() : '';
  if (!username) return;
  // Copy into main input and trigger scan
  var mainInput = document.getElementById('usernameInput');
  if (mainInput) mainInput.value = username;
  // Show results section, hide welcome
  var welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';
  var scanSection = document.getElementById('scanSection');
  if (scanSection) scanSection.style.display = 'flex';
  loadExisting(username);
}

async function disconnectDiscogs() {
  if (!confirm('Disconnect and return to the welcome page?')) return;
  try {
    await fetch('api/auth/discogs/disconnect', { method: 'POST' });
    await fetch('api/logout', { method: 'POST' });
  } catch(e) {}
  // Clear local state
  isOAuthed = false;
  localStorage.removeItem('gold-digger-username');
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
  document.getElementById('userBarRescan').style.display = 'none';
  document.getElementById('shareBtn').style.display = 'none';
  // Clear changes banner
  var changesBanner = document.getElementById('changesBanner');
  if (changesBanner) changesBanner.remove();
  // Clear genre/style filters
  document.getElementById('genreSection').style.display = 'none';
  document.getElementById('styleSection').style.display = 'none';
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
        description: 'Auto-generated playlist from Discogs wantlist by Gold Digger. ' + videoIds.length + ' tracks from ' + resultsData.length + ' releases.',
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
      localStorage.setItem('gold-digger-username', username);
      autoScanAfterAuth = true;
      autoScanUsername = username;
    }
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('auth') === 'youtube') {
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('auth_error')) {
    var errCode = params.get('auth_error');
    var errMsg = errCode === 'denied' ? 'You declined the Discogs authorization \u2014 click Connect to try again' :
                 errCode === 'not_configured' ? 'Discogs OAuth is not configured on this server' :
                 'Connection failed: ' + errCode + ' \u2014 please try again';
    document.getElementById('authStatus').textContent = errMsg;
    document.getElementById('authStatus').style.cssText = 'display:block;color:#ff6b6b;font-size:13px;margin-top:12px;text-align:center';
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

// Shared/read-only mode: detect ?share=username param
var sharedMode = false;
var sharedUsername = '';
(function() {
  var params = new URLSearchParams(window.location.search);
  var share = params.get('share');
  if (share) {
    sharedMode = true;
    sharedUsername = share;
    // Clean URL but keep share param
    if (params.get('auth') || params.get('auth_error')) {
      params.delete('auth'); params.delete('auth_error'); params.delete('username');
      window.history.replaceState({}, '', '?' + params.toString());
    }
  }
})();

if (sharedMode) {
  // Read-only shared view — hide all auth/scan controls
  document.getElementById('authSection').style.display = 'none';
  document.getElementById('scanSection').style.display = 'none';
  document.getElementById('themeToggle').style.display = 'none';
  document.querySelector('h1').innerHTML = '<span>' + escapeHtml(sharedUsername) + '</span> Wantlist';
  document.getElementById('usernameInput').value = sharedUsername;
  // Load results directly
  loadResultsForUser(sharedUsername).then(function() {
    if (resultsData.length === 0) {
      document.getElementById('welcome').style.display = '';
      var hero = document.querySelector('.welcome-hero');
      if (hero) hero.innerHTML = '<h2>No results yet</h2><p class="welcome-sub">This wantlist hasn\'t been scanned yet</p>';
      var actions = document.querySelector('.welcome-actions');
      if (actions) actions.style.display = 'none';
      var stores = document.querySelector('.welcome-stores');
      if (stores) stores.style.display = 'none';
    }
  });
} else {
// Init — check auth first, then decide what to show
checkAuthStatus().then(function() {
  if (autoScanAfterAuth) {
    // Just came from OAuth — show connected splash, then auto-scan
    document.getElementById('welcome').style.display = '';
    setTimeout(function() { startScan(false); }, 1200);
  } else if (authState && authState.discogs && authState.discogs.connected) {
    // Already connected — load cached results directly
    return loadExisting(authState.discogs.username);
  } else {
    // Not OAuth-connected — check localStorage for a saved username (manual flow)
    var savedUsername = localStorage.getItem('gold-digger-username');
    if (savedUsername) {
      document.getElementById('usernameInput').value = savedUsername;
      return loadExisting(savedUsername);
    }
    // No saved state — show welcome page
    document.getElementById('welcome').style.display = '';
  }
});
}

// Safari/mobile: when user switches back from another app, check if scan is still running
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (isScanning) return; // Already connected to SSE
  var username = document.getElementById('usernameInput').value.trim();
  if (!username) return;
  // Quick check — is a scan still running on the server?
  fetch('api/scan-status/' + encodeURIComponent(username))
    .then(function(r) { return r.json(); })
    .then(function(status) {
      if (status.active && !status.done && status.total > 0) {
        showResumeBanner(username, status);
      }
    })
    .catch(function() {});
});

// ═══════════════════════════════════════════════════════════
// CART OPTIMIZER
// ═══════════════════════════════════════════════════════════

// Track whether the Gold Digger extension is installed (content script sets this)
var _extInstalled = false;

window.addEventListener('golddigger:ready', function () {
  _extInstalled = true;
});

// When extension reports sync progress, update the Discogs sync row
window.addEventListener('golddigger:syncstate', function (e) {
  var state = e.detail;
  if (!state) return;
  var hint     = document.getElementById('discogsExtHint');
  var doneEl   = document.getElementById('discogsSyncDone');
  var runBtn   = document.getElementById('optimizeRunBtn');

  if (state.running) {
    var pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    if (hint)   hint.style.display   = 'none';
    if (doneEl) {
      doneEl.style.display = 'block';
      doneEl.style.color   = 'var(--text-sec)';
      doneEl.textContent   = '⛏ Syncing Discogs… ' + state.done + ' / ' + state.total +
                             ' releases · ' + (state.found || 0) + ' listings found (' + pct + '%)';
    }
    if (runBtn) runBtn.disabled = true;
  } else if (state.completedAt) {
    if (hint)   hint.style.display   = 'none';
    if (doneEl) {
      doneEl.style.display = 'block';
      doneEl.style.color   = 'var(--green)';
      doneEl.textContent   = '✓ ' + (state.found || 0) + ' Discogs listings synced — included in optimizer';
    }
    if (runBtn) runBtn.disabled = false;
  } else if (state.error) {
    if (doneEl) {
      doneEl.style.display = 'block';
      doneEl.style.color   = 'var(--red-soft, #f87171)';
      doneEl.textContent   = '⚠ Sync error: ' + state.error;
    }
    if (runBtn) runBtn.disabled = false;
  }
});

function openOptimizer() {
  document.getElementById('optimizerOverlay').style.display = 'flex';
  document.getElementById('optimizerPrefs').style.display = 'block';
  document.getElementById('optimizerProgress').style.display = 'none';
  document.getElementById('optimizerResults').style.display = 'none';

  // Pre-fill preferences
  var username = getCurrentUsername();
  if (username) {
    fetch('api/preferences/' + encodeURIComponent(username))
      .then(function(r) { return r.json(); })
      .then(function(prefs) {
        if (prefs.postcode) document.getElementById('optPostcode').value = prefs.postcode;
        if (prefs.min_condition) document.getElementById('optCondition').value = prefs.min_condition;
        if (prefs.min_seller_rating != null) document.getElementById('optRating').value = String(prefs.min_seller_rating);
        if (prefs.max_price_usd) document.getElementById('optMaxPrice').value = prefs.max_price_usd;
      })
      .catch(function() {});
  }

  // If extension is installed, kick off Discogs sync automatically
  if (_extInstalled && username) {
    var serverUrl = (window.location.origin + window.location.pathname).replace(/\/$/, '');
    window.dispatchEvent(new CustomEvent('golddigger:startsync', {
      detail: { username: username, serverUrl: serverUrl }
    }));
  } else {
    checkDiscogsSyncStatus();
  }
}

function checkDiscogsSyncStatus() {
  var username = getCurrentUsername();
  if (!username) return;
  fetch('api/discogs-listings-count/' + encodeURIComponent(username))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var hint   = document.getElementById('discogsExtHint');
      var doneEl = document.getElementById('discogsSyncDone');
      if (data.count > 0) {
        if (hint)   hint.style.display = 'none';
        if (doneEl) {
          doneEl.textContent   = '✓ ' + data.count + ' Discogs seller listings ready — included in optimizer';
          doneEl.style.color   = 'var(--green)';
          doneEl.style.display = 'block';
        }
      }
    }).catch(function() {});
}

document.getElementById('optimizerClose').addEventListener('click', function() {
  document.getElementById('optimizerOverlay').style.display = 'none';
});

document.getElementById('optimizerOverlay').addEventListener('click', function(e) {
  if (e.target === this) this.style.display = 'none';
});

document.getElementById('optPostcode').addEventListener('input', function() {
  var hint = document.getElementById('postcodeHint');
  var pc = this.value.trim();
  if (!pc) { hint.textContent = ''; return; }
  // Simple postcode-to-country detection for hint display only
  if (/^\d{5}(-\d{4})?$/.test(pc)) hint.textContent = 'US';
  else if (/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(pc)) hint.textContent = 'UK';
  else if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/i.test(pc)) hint.textContent = 'Canada';
  else if (/^[2-9]\d{3}$/.test(pc)) hint.textContent = 'Australia';
  else if (/^\d{4}[A-Z]{2}$/i.test(pc)) hint.textContent = 'Netherlands';
  else if (/^\d{3}-?\d{4}$/.test(pc)) hint.textContent = 'Japan';
  else if (/^\d{5}$/.test(pc)) hint.textContent = 'DE / FR / IT / ES';
  else hint.textContent = '';
});

function showOptimizerPrefs() {
  document.getElementById('optimizerPrefs').style.display = 'block';
  document.getElementById('optimizerProgress').style.display = 'none';
  document.getElementById('optimizerResults').style.display = 'none';
}

function getCurrentUsername() {
  var el = document.getElementById('usernameInput');
  if (el && el.value.trim()) return el.value.trim();
  var barName = document.getElementById('userBarName');
  if (barName && barName.textContent.trim()) return barName.textContent.trim();
  return null;
}

var _optimizerPollTimer = null;

function runOptimizer() {
  var username = getCurrentUsername();
  if (!username) { alert('No username found. Please scan your wantlist first.'); return; }

  var postcode  = document.getElementById('optPostcode').value.trim();
  var condition = document.getElementById('optCondition').value;
  var rating    = document.getElementById('optRating').value;
  var maxPrice  = document.getElementById('optMaxPrice').value.trim();

  // Switch to progress view
  document.getElementById('optimizerPrefs').style.display = 'none';
  document.getElementById('optimizerProgress').style.display = 'block';
  document.getElementById('optimizerResults').style.display = 'none';
  document.getElementById('optProgressFill').style.width = '2%';
  document.getElementById('optProgressText').textContent = 'Submitting…';
  document.getElementById('optimizeRunBtn').disabled = true;

  var body = { postcode: postcode, minCondition: condition, minSellerRating: parseFloat(rating) };
  if (maxPrice) body.maxPriceUsd = parseFloat(maxPrice);

  // Submit job
  fetch('api/optimize/' + encodeURIComponent(username), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) throw new Error(data.error);
    pollOptimizerJob(data.jobId);
  })
  .catch(function(e) {
    document.getElementById('optimizeRunBtn').disabled = false;
    document.getElementById('optProgressText').textContent = '⚠ ' + e.message;
  });
}

function pollOptimizerJob(jobId) {
  if (_optimizerPollTimer) clearInterval(_optimizerPollTimer);

  _optimizerPollTimer = setInterval(function() {
    fetch('api/optimize/job/' + jobId)
    .then(function(r) { return r.json(); })
    .then(function(job) {
      _updateOptimizerProgress(job);

      if (job.status === 'done') {
        clearInterval(_optimizerPollTimer);
        _optimizerPollTimer = null;
        document.getElementById('optimizeRunBtn').disabled = false;
        document.getElementById('optProgressFill').style.width = '100%';
        setTimeout(function() { showOptimizerResults(job.result); }, 300);
        _notifyOptimizerDone();
      } else if (job.status === 'failed') {
        clearInterval(_optimizerPollTimer);
        _optimizerPollTimer = null;
        document.getElementById('optimizeRunBtn').disabled = false;
        document.getElementById('optProgressText').textContent = '⚠ ' + (job.error || 'Optimization failed');
      }
    })
    .catch(function() {});
  }, 2500);
}

function _updateOptimizerProgress(job) {
  var fill = document.getElementById('optProgressFill');
  var text = document.getElementById('optProgressText');

  if (job.status === 'pending') {
    var pos = job.queuePosition || 0;
    text.textContent = pos === 0
      ? 'Starting soon…'
      : 'In queue — position ' + (pos + 1);
    fill.style.width = '2%';

  } else if (job.status === 'processing') {
    var p = job.progress || {};
    text.textContent = p.message || 'Processing…';

    if (p.phase === 'discogs' && p.total > 0) {
      var pct = Math.min(95, 10 + Math.round(((p.done || 0) / p.total) * 80));
      fill.style.width = pct + '%';
    } else if (p.phase === 'optimize') {
      fill.style.width = '97%';
    } else if (p.phase === 'stores') {
      fill.style.width = '8%';
    } else if (p.phase === 'wantlist') {
      fill.style.width = '4%';
    }
  }
}

function _notifyOptimizerDone() {
  // Browser notification if user is on a different tab / window
  if (document.visibilityState !== 'visible') {
    if (window.Notification) {
      if (Notification.permission === 'granted') {
        new Notification('GOLDY 🎵', { body: 'Your best cart is ready!' });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(function(p) {
          if (p === 'granted') new Notification('GOLDY 🎵', { body: 'Your best cart is ready!' });
        });
      }
    }
  }
}

function updateSidebarOptimizer(result) {
  var empty = document.getElementById('sidebarEmpty');
  var sidebarRes = document.getElementById('sidebarResults');
  if (!sidebarRes) return;

  if (empty) empty.style.display = 'none';
  sidebarRes.style.display = 'block';

  // Build top sellers list (up to 4)
  var allEntries = (result.cart || []).slice()
    .sort(function(a, b) { return b.items.length - a.items.length || b.totalUsd - a.totalUsd; });
  var topEntries = allEntries.slice(0, 4);

  var totalItems = (result.cart || []).reduce(function(s, e) { return s + e.items.length; }, 0);

  var sellerRowsHtml = topEntries.map(function(entry) {
    var logoFile = storeLogoMap[entry.sourceName] || '';
    var logoInner = logoFile
      ? '<img src="img/' + logoFile + '" alt="">'
      : entry.sourceName.charAt(0).toUpperCase();
    return '<div class="sidebar-seller">' +
      '<div class="sidebar-seller-logo">' + logoInner + '</div>' +
      '<div class="sidebar-seller-info">' +
        '<div class="sidebar-seller-name">' + escapeHtml(entry.sourceName) + '</div>' +
        '<div class="sidebar-seller-items">' + entry.items.length + ' record' + (entry.items.length !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '<div class="sidebar-seller-price">$' + entry.totalUsd.toFixed(2) + '</div>' +
    '</div>';
  }).join('');

  sidebarRes.innerHTML =
    '<div class="sidebar-opt-sub">Optimizing for ' + totalItems + ' item' + (totalItems !== 1 ? 's' : '') + '</div>' +
    '<div class="sidebar-opt-stats">' +
      '<div class="sidebar-stat-row"><span>Best Combined Price</span><span>$' + result.grandRecordsUsd.toFixed(2) + '</span></div>' +
      '<div class="sidebar-stat-row"><span>Est. Shipping</span><span>$' + result.grandShippingUsd.toFixed(2) + '</span></div>' +
      '<div class="sidebar-stat-row total"><span>Total Cost</span><span>$' + result.grandTotalUsd.toFixed(2) + '</span></div>' +
    '</div>' +
    '<div class="sidebar-sellers">' + sellerRowsHtml + '</div>' +
    '<button class="btn-checkout" onclick="openOptimizer()">CHECKOUT WITH OPTIMIZED CART</button>' +
    '<button class="sidebar-alt-link" onclick="openOptimizer()">View Alternative Carts</button>';
}

function showOptimizerResults(result) {
  document.getElementById('optimizerProgress').style.display = 'none';
  document.getElementById('optimizerResults').style.display = 'block';

  // Also populate sidebar
  updateSidebarOptimizer(result);

  // ── Summary stats ─────────────────────────────────────────────
  var summaryEl = document.getElementById('optSummary');
  summaryEl.innerHTML = [
    statBlock('$' + result.grandTotalUsd.toFixed(2), 'Total Cost'),
    statBlock('$' + result.grandRecordsUsd.toFixed(2), 'Records'),
    statBlock('$' + result.grandShippingUsd.toFixed(2), 'Shipping'),
    statBlock(result.covered + ' / ' + result.total, 'Wantlist Covered'),
    statBlock(result.numSellers, result.numSellers === 1 ? 'Seller' : 'Sellers'),
  ].join('');

  // ── Coverage bar ──────────────────────────────────────────────
  var covPct = result.total > 0 ? Math.round((result.covered / result.total) * 100) : 0;
  var covColor = covPct >= 80 ? 'var(--green)' : covPct >= 50 ? '#ff9900' : 'var(--orange)';

  // ── Split cards ───────────────────────────────────────────────
  var stores = result.cart.filter(function(e) { return e.sourceType === 'store'; })
    .sort(function(a, b) { return b.items.length - a.items.length || b.totalUsd - a.totalUsd; });
  var discogs = result.cart.filter(function(e) { return e.sourceType !== 'store'; })
    .sort(function(a, b) { return b.items.length - a.items.length || b.totalUsd - a.totalUsd; });

  function sellerRows(entries) {
    return entries.map(function(entry, i) {
      var isStore = entry.sourceType === 'store';
      var ratingHtml = entry.sellerRating
        ? ' · <span class="sc-star">★ ' + entry.sellerRating.toFixed(1) + '</span>' +
          (entry.sellerNumRatings ? ' <span class="sc-rating-count">(' + entry.sellerNumRatings.toLocaleString() + ')</span>' : '')
        : '';
      var country = entry.country ? entry.country + ' ' : '';
      var shipping = entry.shippingCostUsd === 0
        ? '<span class="sc-free">Free shipping</span>'
        : '+$' + entry.shippingCostUsd.toFixed(2) + ' shipping';

      var itemsHtml = entry.items.map(function(item) {
        var priceHtml = item.url
          ? '<a href="' + item.url + '" target="_blank" rel="noopener" class="sc-item-price">' + '$' + item.priceUsd.toFixed(2) + '</a>'
          : '<span class="sc-item-price">$' + item.priceUsd.toFixed(2) + '</span>';
        return '<div class="sc-item">' +
          '<span class="sc-item-title">' + escapeHtml(item.title) +
            (item.artist ? ' <span class="sc-item-artist">— ' + escapeHtml(item.artist) + '</span>' : '') +
          '</span>' +
          (item.catno ? '<span class="sc-item-catno">' + escapeHtml(item.catno) + '</span>' : '') +
          '<span class="sc-item-cond">' + (item.condition || '') + '</span>' +
          priceHtml +
        '</div>';
      }).join('');

      return '<div class="sc-seller' + (i === 0 ? ' open' : '') + '">' +
        '<div class="sc-seller-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
          '<div class="sc-seller-left">' +
            '<div class="sc-seller-name">' + escapeHtml(entry.sourceName) + '</div>' +
            '<div class="sc-seller-sub">' + country + ratingHtml + ' · ' + shipping + '</div>' +
          '</div>' +
          '<div class="sc-seller-right">' +
            '<div class="sc-seller-price">$' + entry.totalUsd.toFixed(2) + '</div>' +
            '<div class="sc-seller-rec">' + entry.items.length + ' record' + (entry.items.length !== 1 ? 's' : '') + '</div>' +
          '</div>' +
          '<div class="sc-chevron">▼</div>' +
        '</div>' +
        '<div class="sc-items">' + itemsHtml + '</div>' +
      '</div>';
    }).join('');
  }

  function cardTotal(entries) {
    return entries.reduce(function(s, e) { return s + e.totalUsd; }, 0);
  }
  function cardRecords(entries) {
    return entries.reduce(function(s, e) { return s + e.items.length; }, 0);
  }

  var storeTotal = cardTotal(stores);
  var storeRecs  = cardRecords(stores);
  var discogsTotal = cardTotal(discogs);
  var discogsRecs  = cardRecords(discogs);

  var breakdownEl = document.getElementById('optBreakdown');
  breakdownEl.innerHTML =
    '<div class="bk-coverage">' +
      '<div class="bk-coverage-label">' +
        '<span>Wantlist coverage</span>' +
        '<span style="color:' + covColor + ';font-weight:700">' + covPct + '% — ' + result.covered + ' of ' + result.total + ' records found</span>' +
      '</div>' +
      '<div class="bk-coverage-track"><div class="bk-coverage-fill" style="width:' + covPct + '%;background:' + covColor + '"></div></div>' +
    '</div>' +
    '<div class="sc-split">' +
      (stores.length > 0
        ? '<div class="sc-card stores">' +
            '<div class="sc-card-header">' +
              '<div>' +
                '<div class="sc-card-label stores">Retail Stores</div>' +
                '<div class="sc-card-desc">' + storeRecs + ' record' + (storeRecs !== 1 ? 's' : '') + ' · ' + stores.length + ' store' + (stores.length !== 1 ? 's' : '') + ' · fixed prices</div>' +
              '</div>' +
              '<div class="sc-card-total">$' + storeTotal.toFixed(2) + '</div>' +
            '</div>' +
            sellerRows(stores) +
          '</div>'
        : '') +
      (discogs.length > 0
        ? '<div class="sc-card disco">' +
            '<div class="sc-card-header">' +
              '<div>' +
                '<div class="sc-card-label disco">Discogs Marketplace</div>' +
                '<div class="sc-card-desc">' + discogsRecs + ' record' + (discogsRecs !== 1 ? 's' : '') + ' · ' + discogs.length + ' seller' + (discogs.length !== 1 ? 's' : '') + ' · reseller prices</div>' +
              '</div>' +
              '<div class="sc-card-total">$' + discogsTotal.toFixed(2) + '</div>' +
            '</div>' +
            sellerRows(discogs) +
          '</div>'
        : '') +
    '</div>';

  // Clear old cart — replaced by split cards above
  document.getElementById('optCart').innerHTML = '';

  // Uncovered items
  var uncoveredEl = document.getElementById('optUncovered');
  if (result.uncoveredItems && result.uncoveredItems.length > 0) {
    uncoveredEl.innerHTML = '<h3>' + result.uncoveredItems.length + ' not found anywhere</h3>' +
      '<div class="opt-uncovered-list">' +
      result.uncoveredItems.map(function(w) {
        var discogsUrl = w.discogsId
          ? 'https://www.discogs.com/release/' + w.discogsId
          : 'https://www.discogs.com/search/?q=' + encodeURIComponent((w.artist || '') + ' ' + (w.title || ''));
        return '<div class="opt-uncovered-item">' +
          '<span>' + escapeHtml((w.artist ? w.artist + ' — ' : '') + w.title) + '</span>' +
          (w.catno ? '<span class="opt-item-catno">' + escapeHtml(w.catno) + '</span>' : '') +
          '<a href="' + discogsUrl + '" target="_blank" rel="noopener">Search Discogs ↗</a>' +
        '</div>';
      }).join('') +
      '</div>';
  } else {
    uncoveredEl.innerHTML = '<p style="color:var(--green);font-size:13px;margin-top:16px">✓ Every item in your wantlist was found!</p>';
  }
}

function statBlock(value, label) {
  return '<div class="opt-stat">' +
    '<div class="opt-stat-value">' + value + '</div>' +
    '<div class="opt-stat-label">' + label + '</div>' +
  '</div>';
}


