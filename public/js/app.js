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

// ─── Auto theme: sunrise/sunset switching ─────────────────────────────────────
// Modes stored in localStorage:
//   'auto'  – time-based, switches at sunrise/sunset  (default for new users)
//   'light' – manual light
//   'dark'  – manual dark

var _autoThemeTimer = null;
var _autoLatLng     = null;  // [lat, lng] resolved from geolocation/timezone

/** Simplified USNO sunrise/sunset for a given Date + coords. Returns {sunrise, sunset} in ms. */
function _sunTimes(date, lat, lng) {
  var JD = Math.floor(date.getTime() / 86400000) + 2440587.5;
  var n  = JD - 2451545.0;
  var Js = n - lng / 360;
  var M  = ((357.5291 + 0.98560028 * Js) % 360 + 360) % 360;
  var Mr = M * Math.PI / 180;
  var C  = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2*Mr) + 0.0003 * Math.sin(3*Mr);
  var L  = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
  var Lr = L * Math.PI / 180;
  var Jt = 2451545.0 + Js + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2*Lr);
  var sd = Math.sin(Lr) * Math.sin(23.45 * Math.PI / 180);
  var d  = Math.asin(sd);
  var la = lat * Math.PI / 180;
  var cw = (Math.sin(-0.8333 * Math.PI / 180) - Math.sin(la) * sd) / (Math.cos(la) * Math.cos(d));
  if (Math.abs(cw) > 1) return null;   // polar day/night
  var w  = Math.acos(cw) * 180 / Math.PI;
  var toMs = function(jd) { return (jd - 2440587.5) * 86400000; };
  return { sunrise: toMs(Jt - w/360), sunset: toMs(Jt + w/360) };
}

/** Derive approximate lat/lng from browser timezone offset (fallback). */
function _latLngFromTz() {
  var off = -(new Date().getTimezoneOffset()); // minutes east of UTC
  var lng = (off / 60) * 15;                  // 1 hr ≈ 15° longitude
  var tz  = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').toLowerCase();
  // Rough latitude by timezone region prefix
  var lat = tz.startsWith('australia') || tz.startsWith('pacific/auck') ? -33
          : tz.startsWith('america/sao') || tz.startsWith('america/buenos') ? -23
          : tz.startsWith('africa') ? 0
          : 45;  // default: mid Northern Hemisphere
  return [lat, Math.max(-170, Math.min(170, lng))];
}

/** Apply theme with a smooth flash-overlay transition. */
function _applyTheme(isLight, animate) {
  var flash = document.getElementById('themeFlash');
  if (animate && flash) {
    flash.style.background = isLight ? '#f4f4f4' : '#1a1a1a';
    flash.style.opacity = '1';
    setTimeout(function() {
      document.body.classList.toggle('light', isLight);
      flash.style.opacity = '0';
      _updateThemeBtn();
    }, 350);
  } else {
    document.body.classList.toggle('light', isLight);
    _updateThemeBtn();
  }
}

/** Update the gear button to reflect the current mode. */
function _updateThemeBtn() {
  var btn  = document.getElementById('themeToggle');
  if (!btn) return;
  var mode = localStorage.getItem('gold-digger-theme') || 'auto';
  var day  = document.body.classList.contains('light');
  if (mode === 'auto') {
    btn.textContent = day ? '☀' : '🌙';
    btn.title = 'Auto theme (' + (day ? 'day' : 'night') + ') — click to override';
  } else {
    btn.textContent = day ? '☀' : '🌙';
    btn.title = (day ? 'Light' : 'Dark') + ' mode — click to cycle · hold to reset auto';
  }
}

/** Schedule next auto-switch at the next sunrise or sunset. */
function _scheduleAutoSwitch(lat, lng) {
  if (_autoThemeTimer) { clearTimeout(_autoThemeTimer); _autoThemeTimer = null; }
  var now = Date.now();
  var t   = _sunTimes(new Date(), lat, lng);
  if (!t) return;

  var nextMs, toLight;
  if (now < t.sunrise) {
    nextMs = t.sunrise; toLight = true;
  } else if (now < t.sunset) {
    nextMs = t.sunset;  toLight = false;
  } else {
    // After sunset — use tomorrow's sunrise
    var tomorrow = new Date(now + 86400000);
    var t2 = _sunTimes(tomorrow, lat, lng);
    nextMs = t2 ? t2.sunrise : (now + 8 * 3600000);
    toLight = true;
  }

  var delay = nextMs - now;
  _autoThemeTimer = setTimeout(function() {
    if ((localStorage.getItem('gold-digger-theme') || 'auto') === 'auto') {
      _applyTheme(toLight, true);
      _scheduleAutoSwitch(lat, lng);
    }
  }, delay);
}

/** Init auto theme — tries geolocation, falls back to timezone. */
function _initAutoTheme() {
  function apply(lat, lng) {
    _autoLatLng = [lat, lng];
    var t = _sunTimes(new Date(), lat, lng);
    var isDay = t ? (Date.now() >= t.sunrise && Date.now() < t.sunset) : true;
    _applyTheme(isDay, false);
    _scheduleAutoSwitch(lat, lng);
  }
  if (navigator.geolocation) {
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; var ll = _latLngFromTz(); apply(ll[0], ll[1]); }
    }, 4000); // 4s timeout
    navigator.geolocation.getCurrentPosition(
      function(pos) {
        if (done) return; done = true; clearTimeout(timer);
        apply(pos.coords.latitude, pos.coords.longitude);
      },
      function() {
        if (done) return; done = true; clearTimeout(timer);
        var ll = _latLngFromTz(); apply(ll[0], ll[1]);
      },
      { timeout: 4000, maximumAge: 3600000 }
    );
  } else {
    var ll = _latLngFromTz(); apply(ll[0], ll[1]);
  }
}

// ─── Initialise on load ───────────────────────────────────────────────────────
(function() {
  var saved = localStorage.getItem('gold-digger-theme') || 'auto';
  if (saved === 'light') {
    document.body.classList.add('light');
    _updateThemeBtn();
  } else if (saved === 'dark') {
    document.body.classList.remove('light');
    _updateThemeBtn();
  } else {
    // 'auto' — compute from sunrise/sunset
    _initAutoTheme();
  }
})();

// ─── Gear button: cycle auto → manual-opposite → other-manual → auto ──────────
var _themeHoldTimer = null;
document.getElementById('themeToggle').addEventListener('mousedown', function() {
  _themeHoldTimer = setTimeout(function() {
    // Long-press (1 s) → reset to auto
    localStorage.setItem('gold-digger-theme', 'auto');
    _initAutoTheme();
  }, 1000);
});
document.getElementById('themeToggle').addEventListener('mouseup', function() {
  clearTimeout(_themeHoldTimer);
});
document.getElementById('themeToggle').addEventListener('click', function() {
  clearTimeout(_themeHoldTimer);
  var saved   = localStorage.getItem('gold-digger-theme') || 'auto';
  var isLight = document.body.classList.contains('light');
  if (saved === 'auto') {
    // First click: override to opposite
    var next = !isLight;
    localStorage.setItem('gold-digger-theme', next ? 'light' : 'dark');
    _applyTheme(next, true);
  } else if (saved === 'light') {
    localStorage.setItem('gold-digger-theme', 'dark');
    _applyTheme(false, true);
  } else {
    // Was dark → go back to auto
    localStorage.setItem('gold-digger-theme', 'auto');
    _initAutoTheme();
  }
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
  if (!username) return;
  if (isScanning && !resume) {
    // Already scanning — flash the progress bar instead of silently ignoring
    var prog = document.getElementById('progressSection');
    if (prog) { prog.style.outline = '2px solid var(--gold)'; setTimeout(function(){ prog.style.outline=''; }, 800); }
    return;
  }
  if (isScanning) return;

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
    var inStockCount = resultsData.filter(function(i) { return i.stores && i.stores.some(function(s) { return s.inStock; }); }).length;
    if (inStockCount > 0) {
      document.getElementById('optimizerBanner').style.display = 'flex';
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

  // Reset optimizer + discover state so a new user doesn't see the previous user's results
  if (_optimizerPollTimer) { clearInterval(_optimizerPollTimer); _optimizerPollTimer = null; }
  _lastOptimizerResult = null;
  _activeOptimizerJobId = null;
  _discoverCache = null;
  var overlay = document.getElementById('optimizerOverlay');
  if (overlay) overlay.style.display = 'none';
  var banner = document.getElementById('optimizerBanner');
  if (banner) banner.style.display = 'none';
  var trigger = document.getElementById('optimizeTrigger');
  if (trigger) trigger.style.display = 'none';

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
    // Filter out server-dismissed changes AND changes the user previously dismissed
    // locally (stored in localStorage for unauthenticated sessions).
    var localDismissed = new Set(JSON.parse(localStorage.getItem('dismissedChanges') || '[]'));

    var res = await fetch('api/changes/' + encodeURIComponent(username));
    if (!res.ok) return;
    var data = await res.json();
    var changes = (data.changes || []).filter(function(c) { return !localDismissed.has(c.id); });
    if (changes.length > 0) {
      showChangesBanner(changes);
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
  // Collect all IDs for dismiss tracking (all changes, not just the 5 shown)
  var allIds = changes.map(function(c) { return c.id; }).filter(Boolean);
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
      detailHtml += '<div class="changes-item" data-change-id="' + (c.id || '') + '">' +
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
  // Store all change IDs on the banner element for dismiss to collect
  banner.dataset.allIds = JSON.stringify(allIds);
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
  // Always hide the banner immediately — don't block on server response
  if (banner) {
    banner.classList.add('changes-hiding');
    setTimeout(function() { banner.remove(); }, 300);
  }

  // Collect all change IDs stored on the banner element
  var displayedIds = [];
  if (banner && banner.dataset.allIds) {
    try { displayedIds = JSON.parse(banner.dataset.allIds); } catch(e) {}
  }

  // Persist dismissed IDs in localStorage so they stay hidden on reload
  // even if the server dismiss fails (e.g. user isn't authenticated)
  if (displayedIds.length > 0) {
    try {
      var stored = JSON.parse(localStorage.getItem('dismissedChanges') || '[]');
      var merged = Array.from(new Set(stored.concat(displayedIds)));
      // Cap at 500 to avoid unbounded growth
      if (merged.length > 500) merged = merged.slice(merged.length - 500);
      localStorage.setItem('dismissedChanges', JSON.stringify(merged));
    } catch(e) {}
  }

  // Try server-side dismiss (authoritative, clears from DB for authenticated sessions)
  try {
    var res = await fetch('api/changes/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok && res.status === 401) {
      // Not authenticated — localStorage dismiss above is the fallback, that's fine
      console.log('[changes] Not authenticated — dismissed locally only');
    }
  } catch(e) {}
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

// Normalise Discogs genre/style strings to title case so
// "ELECTRONIC" renders as "Electronic", matching My Collection
function toTitleCase(str) {
  return (str || '').replace(/\b\w+/g, function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
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

  var genreRowEl = document.getElementById('wlGenreRow');
  var styleRowEl = document.getElementById('wlStyleRow');
  var filterPillsEl = document.getElementById('wlFilterPills');

  // Sort genres by count descending
  var genreKeys = Object.keys(genreCounts).sort(function(a, b) { return genreCounts[b] - genreCounts[a]; });
  // Top styles by count, capped
  var styleKeys = Object.keys(styleCounts).sort(function(a, b) { return styleCounts[b] - styleCounts[a]; }).slice(0, MAX_STYLES);

  // Show/hide the whole pill container
  if (filterPillsEl) filterPillsEl.style.display = genreKeys.length > 0 ? '' : 'none';

  // ── Genre row ─────────────────────────────────────────────────
  if (genreRowEl) {
    var allGenresActive = activeGenres.size === 0;
    genreRowEl.innerHTML =
      '<button class="wl-genre-pill' + (allGenresActive ? ' active' : '') + '" data-clear="genres">All</button>' +
      genreKeys.map(function(g) {
        var isActive = activeGenres.has(g);
        var stock = genreInStock[g] || 0;
        return '<button class="wl-genre-pill' + (isActive ? ' active' : '') + '" data-tag="' + escapeHtml(g) + '">' +
          escapeHtml(toTitleCase(g)) +
          ' <span class="wl-pill-count">' + genreCounts[g] + '</span>' +
          (stock > 0 ? '<span class="wl-pill-avail"> · ' + stock + '</span>' : '') +
          '</button>';
      }).join('');

    genreRowEl.querySelectorAll('.wl-genre-pill').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (btn.dataset.clear) {
          activeGenres = new Set();
        } else {
          var tag = btn.dataset.tag;
          if (activeGenres.has(tag)) { activeGenres.delete(tag); } else { activeGenres.add(tag); }
        }
        updateStats();
        render();
      });
    });
  }

  // ── Style row ─────────────────────────────────────────────────
  if (styleRowEl) {
    styleRowEl.style.display = styleKeys.length > 0 ? '' : 'none';
    var allStylesActive = activeStyles.size === 0;
    styleRowEl.innerHTML = styleKeys.length > 0
      ? '<button class="wl-genre-pill wl-style-pill' + (allStylesActive ? ' active' : '') + '" data-clear="styles">All</button>' +
        styleKeys.map(function(s) {
          var isActive = activeStyles.has(s);
          var stock = styleInStock[s] || 0;
          return '<button class="wl-genre-pill wl-style-pill' + (isActive ? ' active' : '') + '" data-tag="' + escapeHtml(s) + '">' +
            escapeHtml(toTitleCase(s)) +
            ' <span class="wl-pill-count">' + styleCounts[s] + '</span>' +
            (stock > 0 ? '<span class="wl-pill-avail"> · ' + stock + '</span>' : '') +
            '</button>';
        }).join('')
      : '';

    styleRowEl.querySelectorAll('.wl-genre-pill').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (btn.dataset.clear) {
          activeStyles = new Set();
        } else {
          var tag = btn.dataset.tag;
          if (activeStyles.has(tag)) { activeStyles.delete(tag); } else { activeStyles.add(tag); }
        }
        updateStats();
        render();
      });
    });
  }
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

    // Vinyl disc SVG — half peeking out from behind the sleeve
    var vinylDisc = '<svg class="card-vinyl-disc" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        // Subtle shine gradient — catches light on the right (visible) half
        '<radialGradient id="discShine" cx="65%" cy="35%" r="55%">' +
          '<stop offset="0%" stop-color="#2a2a2a"/>' +
          '<stop offset="60%" stop-color="#111"/>' +
          '<stop offset="100%" stop-color="#0a0a0a"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<circle cx="50" cy="50" r="50" fill="url(#discShine)"/>' +
      // Grooves — more rings for realism
      '<circle cx="50" cy="50" r="47" fill="none" stroke="#1e1e1e" stroke-width="0.8"/>' +
      '<circle cx="50" cy="50" r="44" fill="none" stroke="#252525" stroke-width="1"/>' +
      '<circle cx="50" cy="50" r="41" fill="none" stroke="#1a1a1a" stroke-width="1.2"/>' +
      '<circle cx="50" cy="50" r="38" fill="none" stroke="#252525" stroke-width="0.8"/>' +
      '<circle cx="50" cy="50" r="35" fill="none" stroke="#1a1a1a" stroke-width="1.2"/>' +
      '<circle cx="50" cy="50" r="32" fill="none" stroke="#222" stroke-width="0.8"/>' +
      '<circle cx="50" cy="50" r="29" fill="none" stroke="#1a1a1a" stroke-width="1"/>' +
      '<circle cx="50" cy="50" r="26" fill="none" stroke="#252525" stroke-width="0.8"/>' +
      '<circle cx="50" cy="50" r="23" fill="none" stroke="#1a1a1a" stroke-width="1"/>' +
      '<circle cx="50" cy="50" r="20" fill="none" stroke="#222" stroke-width="0.8"/>' +
      // Gold label area
      '<circle cx="50" cy="50" r="14" fill="#C9A227"/>' +
      '<circle cx="50" cy="50" r="14" fill="none" stroke="#a07c10" stroke-width="0.5"/>' +
      '<circle cx="50" cy="50" r="10" fill="none" stroke="#a07c10" stroke-width="0.4" opacity="0.6"/>' +
      // Centre spindle hole
      '<circle cx="50" cy="50" r="2.5" fill="#0a0a0a"/>' +
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

    // Build Discogs row — three tiers of data richness:
    //   1. discogsListings  — Chrome extension synced full per-listing details
    //   2. marketListings   — optimizer-cache summary (seller count, cheapest, US count)
    //   3. discogsPrice     — API summary only (lowest price + for-sale count)
    var discogsRowHtml = '';
    var dl = item.discogsListings;
    var ml = item.marketListings;
    var dp = item.discogsPrice;
    var discogsUrl = (dp && dp.marketplaceUrl) ? dp.marketplaceUrl : ('https://www.discogs.com/sell/release/' + item.item.id);

    if (dl && dl.numListings > 0) {
      // Tier 1: Extension has synced individual listings — richest data
      var currSym = (dp && dp.currency === 'GBP') ? '£' : (dp && dp.currency === 'EUR') ? '€' : '$';
      var cheapestDiscogsPrice = dl.cheapestUsd ? '$' + dl.cheapestUsd.toFixed(2) : (dp && dp.lowestPrice ? (currSym + dp.lowestPrice.toFixed(2)) : null);
      var usHtml = dl.usCount > 0
        ? '<span class="card-store-tag us-ship">🇺🇸 from $' + dl.cheapestUsUsd.toFixed(2) + '</span>'
        : '<span class="card-store-tag no-us">No US sellers</span>';
      discogsRowHtml = '<a class="card-store-row discogs-row" href="' + escapeHtml(discogsUrl) + '" target="_blank" onclick="event.stopPropagation()">' +
        '<img class="card-store-logo" src="img/discogs.png" alt="Discogs">' +
        '<span class="card-store-name">Discogs</span>' +
        '<span class="card-store-meta">' + dl.numListings + ' listings</span>' +
        usHtml +
        (cheapestDiscogsPrice ? '<span class="card-store-price">' + cheapestDiscogsPrice + '</span>' : '') +
        '</a>';
    } else if (ml && ml.numListings > 0) {
      // Tier 2: Optimizer has fetched marketplace listings — show seller details
      var mlUsHtml = ml.usCount > 0
        ? '<span class="card-store-tag us-ship">🇺🇸 from $' + ml.cheapestUsUsd.toFixed(2) + '</span>'
        : (ml.cheapestUsd ? '' : '<span class="card-store-tag no-us">No US sellers</span>');
      var mlPrice = ml.cheapestUsd ? '$' + ml.cheapestUsd.toFixed(2) : '';
      discogsRowHtml = '<a class="card-store-row discogs-row" href="' + escapeHtml(discogsUrl) + '" target="_blank" onclick="event.stopPropagation()">' +
        '<img class="card-store-logo" src="img/discogs.png" alt="Discogs">' +
        '<span class="card-store-name">Discogs</span>' +
        '<span class="card-store-meta">' + ml.numListings + ' listing' + (ml.numListings !== 1 ? 's' : '') + '</span>' +
        mlUsHtml +
        (mlPrice ? '<span class="card-store-price">' + mlPrice + '</span>' : '') +
        '</a>';
    } else if (dp && dp.lowestPrice) {
      // Tier 3: Only API price summary — prompt user to run optimizer for full details
      var currSym2 = dp.currency === 'GBP' ? '£' : dp.currency === 'EUR' ? '€' : '$';
      discogsRowHtml = '<a class="card-store-row discogs-row" href="' + escapeHtml(discogsUrl) + '" target="_blank" onclick="event.stopPropagation()">' +
        '<img class="card-store-logo" src="img/discogs.png" alt="Discogs">' +
        '<span class="card-store-name">Discogs</span>' +
        '<span class="card-store-meta">' + (dp.numForSale || '?') + ' for sale</span>' +
        '<span class="card-store-tag sync-hint">Run optimizer</span>' +
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
          (cheapestUrl !== '#'
            ? '<button class="btn-add-cart" onclick="event.stopPropagation();window.open(\'' + escapeHtml(cheapestUrl) + '\',\'_blank\')">Buy Now</button>'
            : '<button class="btn-add-cart" onclick="event.stopPropagation();window.open(\'' + discogsReleaseUrl + '/marketplace\',\'_blank\')">Buy Now</button>') +
          '<button class="btn-wishlist" onclick="event.stopPropagation();window.open(\'' + discogsReleaseUrl + '\',\'_blank\')">View on Discogs</button>' +
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
      var nameEl = document.getElementById('userBarName');
      nameEl.textContent = data.discogs.username;
      nameEl.style.cursor = 'pointer';
      nameEl.title = 'View your profile';
      nameEl.onclick = function() { switchView('profile', document.getElementById('profileNavLink')); };
      // Show profile nav link
      var profNav = document.getElementById('profileNavLink');
      if (profNav) profNav.style.display = '';
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
  // Handle ?view= URL param (and legacy ?profile=) — restore view after auth
  var _startView = _initialView || (_profileParam ? 'profile' : null);
  var _startUser = _initialUser || _profileParam || null;
  _profileParam = null; _initialView = null; _initialUser = null;
  if (_startView) {
    var profNav = document.getElementById('profileNavLink');
    if (profNav) profNav.style.display = '';
    setTimeout(function() {
      if (_startView === 'profile' && _startUser) {
        profLoadPublic(_startUser, { noPush: true }); // URL already set by IIFE
      } else {
        switchView(_startView, null, { noPush: true });
      }
    }, 300);
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
  // Clear genre/style pill filters
  var wlPills = document.getElementById('wlFilterPills');
  if (wlPills) wlPills.style.display = 'none';
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
// Also detect ?profile=username (legacy) and ?view=X[&user=Y] (new) for deep-links
var sharedMode = false;
var sharedUsername = '';
var _profileParam = null;
var _initialView  = null;  // restored from ?view= on load
var _initialUser  = null;  // restored from ?user= on load (public profile)
(function() {
  var params = new URLSearchParams(window.location.search);
  var share   = params.get('share');
  var profile = params.get('profile');   // legacy
  var view    = params.get('view');
  var user    = params.get('user');
  if (share) {
    sharedMode = true;
    sharedUsername = share;
    if (params.get('auth') || params.get('auth_error')) {
      params.delete('auth'); params.delete('auth_error'); params.delete('username');
      window.history.replaceState({}, '', '?' + params.toString());
    }
  }
  if (profile) {
    _profileParam = profile;
    // Upgrade legacy ?profile= to new scheme immediately
    params.delete('profile');
    params.set('view', 'profile');
    params.set('user', profile);
    window.history.replaceState({ view: 'profile', profileUser: profile }, '', '?' + params.toString());
  } else if (view && view !== 'wantlist') {
    _initialView = view;
    _initialUser = user || null;
    // Replace state so popstate baseline is clean
    window.history.replaceState({ view: view, profileUser: _initialUser }, '', window.location.search);
  }
})();

// ─── SPA URL routing ──────────────────────────────────────────────────────────
function buildViewUrl(view, profileUser) {
  if (!view || view === 'wantlist') return window.location.pathname;
  var q = '?view=' + encodeURIComponent(view);
  if (view === 'profile' && profileUser) q += '&user=' + encodeURIComponent(profileUser);
  return q;
}

window.addEventListener('popstate', function(e) {
  var state = e.state || {};
  var v = state.view || 'wantlist';
  if (v === 'profile' && state.profileUser) {
    // Public profile — skip pushing state again
    profLoadPublic(state.profileUser, { noPush: true });
  } else {
    switchView(v, null, { noPush: true });
  }
});

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

// When extension reports sync progress — update optimizer overlay AND discover Discogs UI
window.addEventListener('golddigger:syncstate', function (e) {
  var state = e.detail;
  if (!state) return;

  // ── 1. Store state for discover rendering ──
  var prev = _discogsSyncState || {};
  _discogsSyncState = state;

  // ── 2. Optimizer overlay elements (pre-existing) ──
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
    // Stamp sync time so we skip re-syncing for 30 min
    var syncUser = getCurrentUsername();
    if (syncUser) _lastDiscogsSyncTime[syncUser] = Date.now();
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

  // ── 3. Live discover Discogs tab update ──
  var discInStock = document.getElementById('discInStockBody');
  if (discInStock && _inStockVendor === 'discogs') {
    // Patch inline banner instead of full re-render so scroll position is preserved
    var banner = document.getElementById('dgSyncBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'dgSyncBanner';
      banner.className = 'dg-sync-banner';
      discInStock.insertBefore(banner, discInStock.firstChild);
    }
    if (state.running) {
      var p = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
      banner.innerHTML = '<span class="dg-sync-spin">⛏</span> Syncing Discogs marketplace… ' +
        state.done + ' / ' + state.total + ' releases · ' + (state.found || 0) + ' listings (' + p + '%)';
      banner.className = 'dg-sync-banner running';
    } else if (state.completedAt) {
      banner.innerHTML = '✓ Sync complete — ' + (state.found || 0) + ' listings saved';
      banner.className = 'dg-sync-banner done';
      // Auto-hide banner and reload discover data after a short delay
      setTimeout(function() {
        if (banner.parentNode) banner.parentNode.removeChild(banner);
        loadDiscover();
      }, 2000);
    } else if (state.error) {
      banner.innerHTML = '⚠ Sync error: ' + escapeHtml(state.error);
      banner.className = 'dg-sync-banner error';
    }
  }

  // ── 4. If sync just completed and discover is open, schedule a reload ──
  if (state.completedAt && !prev.completedAt && _discoverData && _discoverTab !== null) {
    // Reload in background even if not on discogs tab, so data is fresh when user switches
    if (_inStockVendor !== 'discogs') {
      setTimeout(function() { loadDiscover(); }, 2500);
    }
  }
});

// Show the prefs/settings panel inside the overlay (called by rerunOptimizer and fallback).
function _showOptimizerPrefsPanel(username) {
  document.getElementById('optimizerPrefs').style.display = 'block';
  document.getElementById('optimizerProgress').style.display = 'none';
  document.getElementById('optimizerResults').style.display = 'none';

  // Pre-fill saved preferences
  if (username) {
    fetch('api/preferences/' + encodeURIComponent(username))
      .then(function(r) { return r.json(); })
      .then(function(prefs) {
        if (prefs.postcode)          document.getElementById('optPostcode').value  = prefs.postcode;
        if (prefs.min_condition)     document.getElementById('optCondition').value = prefs.min_condition;
        if (prefs.min_seller_rating != null) document.getElementById('optRating').value = String(prefs.min_seller_rating);
        if (prefs.max_price_usd)     document.getElementById('optMaxPrice').value  = prefs.max_price_usd;
      })
      .catch(function() {});
  }

  // Kick off Discogs sync — but only if we haven't synced recently (< 30 min)
  var SYNC_STALE_MS = 30 * 60 * 1000;
  var lastSync = _lastDiscogsSyncTime[username] || 0;
  var syncIsStale = (Date.now() - lastSync) > SYNC_STALE_MS;

  if (_extInstalled && username && syncIsStale) {
    var serverUrl = (window.location.origin + window.location.pathname).replace(/\/$/, '');
    window.dispatchEvent(new CustomEvent('golddigger:startsync', {
      detail: { username: username, serverUrl: serverUrl }
    }));
  } else {
    checkDiscogsSyncStatus();
  }
}

// Tracks when we last triggered a Discogs sync per username
var _lastDiscogsSyncTime = {};

/**
 * Trigger a Discogs marketplace sync via the Chrome extension.
 * Called from the Discover Discogs tab — separate from openOptimizer().
 */
function triggerDiscogsSync() {
  var username = getCurrentUsername();
  if (!username) return;

  if (!_extInstalled) {
    // Show install prompt in the Discogs section
    var el = document.getElementById('discInStockBody');
    if (el) {
      var banner = document.getElementById('dgSyncBanner') || document.createElement('div');
      banner.id = 'dgSyncBanner';
      banner.className = 'dg-sync-banner error';
      banner.innerHTML = '⚠ Gold Digger Chrome Extension is not installed. ' +
        '<a href="https://github.com/solakli/vinyl-checker#extension" target="_blank" style="color:var(--gold)">Install it here</a> to sync Discogs prices.';
      el.insertBefore(banner, el.firstChild);
    }
    return;
  }

  // Dispatch to content script → background → sync-window
  var serverUrl = (window.location.origin + window.location.pathname).replace(/\/+$/, '');
  window.dispatchEvent(new CustomEvent('golddigger:startsync', {
    detail: { username: username, serverUrl: serverUrl }
  }));

  // Optimistically show running state in discover
  _discogsSyncState = { running: true, done: 0, total: 0, found: 0 };
  if (_inStockVendor === 'discogs') renderInStockBody();
}

/**
 * Open optimizer modal.
 * - If a result is already in memory → show it immediately.
 * - Else if the server has a completed result from the last 24 h → restore it.
 * - Else → show the prefs/run form.
 */
function openOptimizer() {
  document.getElementById('optimizerOverlay').style.display = 'flex';
  var username = getCurrentUsername();

  // 1. In-memory cache (same session) — show results immediately
  if (_lastOptimizerResult) {
    document.getElementById('optimizerPrefs').style.display = 'none';
    document.getElementById('optimizerProgress').style.display = 'none';
    document.getElementById('optimizerResults').style.display = 'block';
    showOptimizerResults(_lastOptimizerResult);
    return;
  }

  // 2. A job is actively running — re-attach to its progress view
  if (_activeOptimizerJobId) {
    document.getElementById('optimizerPrefs').style.display = 'none';
    document.getElementById('optimizerProgress').style.display = 'block';
    document.getElementById('optimizerResults').style.display = 'none';
    // Fetch current state and re-attach poll so user sees live progress
    fetch('api/optimize/job/' + _activeOptimizerJobId)
      .then(function(r) { return r.json(); })
      .then(function(job) {
        if (job.status === 'done') {
          // Completed while modal was closed — show result
          _lastOptimizerResult = job.result;
          _activeOptimizerJobId = null;
          document.getElementById('optimizerProgress').style.display = 'none';
          document.getElementById('optimizerResults').style.display = 'block';
          showOptimizerResults(job.result);
        } else if (job.status === 'failed') {
          _activeOptimizerJobId = null;
          _showOptimizerPrefsPanel(username);
        } else {
          // Still pending/processing — re-attach poll
          _updateOptimizerProgress(job);
          pollOptimizerJob(_activeOptimizerJobId);
        }
      })
      .catch(function() { _showOptimizerPrefsPanel(username); });
    return;
  }

  // 3. Show a brief "Loading…" state while we check the server cache
  document.getElementById('optimizerPrefs').style.display = 'none';
  document.getElementById('optimizerProgress').style.display = 'block';
  document.getElementById('optimizerResults').style.display = 'none';
  document.getElementById('optProgressFill').style.width = '10%';
  document.getElementById('optProgressText').textContent = 'Loading last result…';

  if (!username) { _showOptimizerPrefsPanel(username); return; }

  fetch('api/optimize/latest/' + encodeURIComponent(username))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.found && data.result) {
        // Restore cached result — no need to re-run
        _lastOptimizerResult = data.result;
        document.getElementById('optimizerProgress').style.display = 'none';
        document.getElementById('optimizerResults').style.display = 'block';
        showOptimizerResults(data.result);
      } else {
        // No recent result — fall through to the prefs form
        _showOptimizerPrefsPanel(username);
      }
    })
    .catch(function() {
      _showOptimizerPrefsPanel(username);
    });
}

/**
 * Force the prefs/run form — used by "↺ Optimise again" button
 * so users can change settings and re-run without the cache check.
 */
function rerunOptimizer() {
  document.getElementById('optimizerOverlay').style.display = 'flex';
  _showOptimizerPrefsPanel(getCurrentUsername());
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
  _stopOptimizerFlavor();
});

document.getElementById('optimizerOverlay').addEventListener('click', function(e) {
  if (e.target === this) { this.style.display = 'none'; _stopOptimizerFlavor(); }
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
var _optimizerFlavorTimer = null;
var _optimizerFlavorPhase = 'pending';
var _optimizerFlavorIdx = 0;
// Track the active job so re-opening the modal re-attaches to running progress
var _activeOptimizerJobId = null;

var _optimizerFlavor = {
  pending: [
    'Getting in line…',
    'Waiting for the worker to finish their coffee…',
    'Queued up behind another digger…',
  ],
  wantlist: [
    'Pulling your hit list…',
    'How many records do you even need?',
    'Counting the damage…',
  ],
  stores: [
    'Raiding Gramaphone, Further Records, Octopus…',
    'Checking what\'s actually on the shelves…',
    'Counting crates…',
  ],
  discogs: [
    'Hitting up the Discogs marketplace…',
    'Sorting through seller feedback scores…',
    'Filtering out the "VG++ plays like new" liars…',
    'Calculating overseas shipping nightmares…',
    'Checking who actually ships internationally…',
    'Reading between the lines of seller notes…',
    'Avoiding the guy with 83% positive feedback…',
    'Looking for the NM copy that won\'t bankrupt you…',
    'Cross-referencing 14 different countries…',
    'Doing the currency conversion math…',
    'Scrolling through seller profiles like it\'s a dating app…',
    'Spotting which "NM" is actually "EX at best"…',
    'Weighing up the "buyer pays exact postage" gamble…',
    'Ignoring the guy charging $12 for a $2 record…',
    'Finding Japanese pressings at US prices…',
    'Checking if that seller will actually respond…',
    'Reading the fine print on Media Mail shipping…',
    'Mentally adding up all the "small" shipping fees…',
    'Looking for sellers who won\'t use a paper bag…',
    'Praying the condition photos are accurate…',
  ],
  optimize: [
    'Crunching the numbers…',
    'Building your perfect cart…',
    'Finding the cheapest path through the crates…',
    'Running the algorithm…',
    'Doing the math so you don\'t have to…',
    'Minimizing the damage…',
  ]
};

function _startOptimizerFlavor(phase) {
  _optimizerFlavorPhase = phase || 'pending';
  _optimizerFlavorIdx = 0;
  if (_optimizerFlavorTimer) clearInterval(_optimizerFlavorTimer);

  var msgs = _optimizerFlavor[_optimizerFlavorPhase] || _optimizerFlavor.pending;
  var el = document.getElementById('optProgressFlavor');
  if (el) el.textContent = msgs[0];

  _optimizerFlavorTimer = setInterval(function() {
    var phMsgs = _optimizerFlavor[_optimizerFlavorPhase] || _optimizerFlavor.pending;
    _optimizerFlavorIdx = (_optimizerFlavorIdx + 1) % phMsgs.length;
    var el2 = document.getElementById('optProgressFlavor');
    if (el2) {
      el2.style.opacity = '0';
      setTimeout(function() {
        el2.textContent = phMsgs[_optimizerFlavorIdx];
        el2.style.opacity = '1';
      }, 150);
    }
  }, 3500);
}

function _stopOptimizerFlavor(finalMsg) {
  if (_optimizerFlavorTimer) { clearInterval(_optimizerFlavorTimer); _optimizerFlavorTimer = null; }
  var el = document.getElementById('optProgressFlavor');
  if (el && finalMsg) el.textContent = finalMsg;
}

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
  document.getElementById('optProgressFlavor').textContent = 'Getting in line…';
  document.getElementById('optProgressText').textContent = '';
  document.getElementById('optimizeRunBtn').disabled = true;
  _startOptimizerFlavor('pending');

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
    _activeOptimizerJobId = data.jobId;
    pollOptimizerJob(data.jobId);
  })
  .catch(function(e) {
    _activeOptimizerJobId = null;
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
        _activeOptimizerJobId = null;
        _stopOptimizerFlavor('Your cart is ready ⛏');
        document.getElementById('optimizeRunBtn').disabled = false;
        document.getElementById('optProgressFill').style.width = '100%';
        document.getElementById('optProgressText').textContent = '';
        setTimeout(function() { showOptimizerResults(job.result); }, 400);
        _notifyOptimizerDone();
      } else if (job.status === 'failed') {
        clearInterval(_optimizerPollTimer);
        _optimizerPollTimer = null;
        _activeOptimizerJobId = null;
        _stopOptimizerFlavor('Something went wrong');
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
    text.textContent = pos > 0 ? 'Position ' + (pos + 1) + ' in queue' : '';
    fill.style.width = '2%';
    _startOptimizerFlavor('pending');

  } else if (job.status === 'processing') {
    var p = job.progress || {};

    // Stats line (small, below bar) = server message with real numbers
    text.textContent = p.message || '';

    // Flavor phase — switch to right pool when phase changes
    if (p.phase && p.phase !== _optimizerFlavorPhase) {
      _startOptimizerFlavor(p.phase);
    }

    // Progress bar
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

// Store last result so the sidebar "View Cart" button can reopen it
var _lastOptimizerResult = null;

function viewFullCart() {
  if (!_lastOptimizerResult) { openOptimizer(); return; }
  // Open modal, skip prefs, jump straight to results
  document.getElementById('optimizerOverlay').style.display = 'flex';
  document.getElementById('optimizerPrefs').style.display = 'none';
  document.getElementById('optimizerProgress').style.display = 'none';
  document.getElementById('optimizerResults').style.display = 'block';
  showOptimizerResults(_lastOptimizerResult);
}

function updateSidebarOptimizer(result) {
  _lastOptimizerResult = result;

  var empty = document.getElementById('sidebarEmpty');
  var sidebarRes = document.getElementById('sidebarResults');
  if (!sidebarRes) return;

  if (empty) empty.style.display = 'none';
  sidebarRes.style.display = 'block';

  // ALL sellers sorted by record count
  var allEntries = (result.cart || []).slice()
    .sort(function(a, b) { return b.items.length - a.items.length || b.totalUsd - a.totalUsd; });

  var totalItems = (result.cart || []).reduce(function(s, e) { return s + e.items.length; }, 0);
  var covPct = result.total > 0 ? Math.round((result.covered / result.total) * 100) : 0;

  var sellerRowsHtml = allEntries.map(function(entry) {
    var logoFile = storeLogoMap[entry.sourceName] || '';
    var logoInner = logoFile
      ? '<img src="img/' + logoFile + '" alt="">'
      : entry.sourceName.charAt(0).toUpperCase();
    var isDiscogs = entry.sourceType !== 'store';
    var sellerLink = isDiscogs
      ? 'https://www.discogs.com/seller/' + encodeURIComponent(entry.sourceName) + '/profile'
      : (entry.items[0] && entry.items[0].url ? entry.items[0].url : '#');
    return '<a class="sidebar-seller" href="' + sellerLink + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + (isDiscogs ? 'View on Discogs' : 'Visit store') + '">' +
      '<div class="sidebar-seller-logo">' + logoInner + '</div>' +
      '<div class="sidebar-seller-info">' +
        '<div class="sidebar-seller-name">' + escapeHtml(entry.sourceName) + (isDiscogs ? ' <span class="sidebar-seller-source">Discogs</span>' : '') + '</div>' +
        '<div class="sidebar-seller-items">' + entry.items.length + ' record' + (entry.items.length !== 1 ? 's' : '') +
          (entry.shippingCostUsd === 0 ? ' · <span class="sidebar-free-ship">free ship</span>' : ' · +$' + entry.shippingCostUsd.toFixed(0) + ' ship') +
        '</div>' +
      '</div>' +
      '<div class="sidebar-seller-price">$' + entry.totalUsd.toFixed(2) + '</div>' +
    '</a>';
  }).join('');

  sidebarRes.innerHTML =
    '<div class="sidebar-opt-sub">' + result.covered + '/' + result.total + ' records covered · ' + covPct + '%</div>' +
    '<div class="sidebar-opt-stats">' +
      '<div class="sidebar-stat-row"><span>Records</span><span>$' + result.grandRecordsUsd.toFixed(2) + '</span></div>' +
      '<div class="sidebar-stat-row"><span>Est. Shipping</span><span>$' + result.grandShippingUsd.toFixed(2) + '</span></div>' +
      '<div class="sidebar-stat-row total"><span>Total Cost</span><span>$' + result.grandTotalUsd.toFixed(2) + '</span></div>' +
    '</div>' +
    '<div class="sidebar-sellers-scroll">' + sellerRowsHtml + '</div>' +
    '<button class="btn-checkout" onclick="viewFullCart()">⛏ VIEW FULL CART</button>' +
    '<button class="btn-rerun-optimizer" onclick="rerunOptimizer()">↺ Optimise again</button>';
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

      var isDiscogs = entry.sourceType === 'discogs' || entry.sourceType === 'discogs_seller';
      // Use the raw sellerUsername field; fall back to stripping " (Discogs)" from sourceName
      // so older cached results still work.
      var sellerUsername = entry.sellerUsername ||
        (isDiscogs ? entry.sourceName.replace(/\s*\(Discogs\)\s*$/, '').trim() : null);
      var sellerProfileUrl = sellerUsername
        ? 'https://www.discogs.com/seller/' + encodeURIComponent(sellerUsername) + '/profile'
        : null;
      var visitBtn = sellerProfileUrl
        ? '<a class="sc-visit-seller" href="' + sellerProfileUrl + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Visit Seller ↗</a>'
        : '';

      return '<div class="sc-seller' + (i === 0 ? ' open' : '') + '">' +
        '<div class="sc-seller-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
          '<div class="sc-seller-left">' +
            '<div class="sc-seller-name">' + escapeHtml(entry.sourceName) + visitBtn + '</div>' +
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

// ═══════════════════════════════════════════════════════════════
// VIEW SWITCHING — Wantlist / Dashboard / Collection
// ═══════════════════════════════════════════════════════════════

function switchView(view, linkEl, opts) {
  opts = opts || {};
  // Update active desktop nav link
  document.querySelectorAll('.nav-link').forEach(function(a) { a.classList.remove('active'); });
  if (linkEl) {
    linkEl.classList.add('active');
  } else {
    var matched = document.querySelector('.nav-link[data-view="' + view + '"]');
    if (matched) matched.classList.add('active');
  }
  // Sync mobile bottom tab bar
  document.querySelectorAll('.mobile-tab').forEach(function(t) { t.classList.remove('active'); });
  var mTab = document.querySelector('.mobile-tab[data-view="' + view + '"]');
  if (mTab) mTab.classList.add('active');

  // Show/hide views
  var isWantlist = view === 'wantlist';
  document.getElementById('view-dashboard').style.display  = view === 'dashboard'  ? 'block' : 'none';
  document.getElementById('view-collection').style.display = view === 'collection' ? 'block' : 'none';
  document.getElementById('view-discover').style.display   = view === 'discover'   ? 'block' : 'none';
  document.getElementById('view-profile').style.display    = view === 'profile'    ? 'block' : 'none';
  document.getElementById('headerControls').style.display  = isWantlist ? '' : 'none';
  document.querySelector('.app-layout').style.display      = isWantlist ? '' : 'none';

  // Push URL state (unless caller is restoring from popstate)
  if (!opts.noPush) {
    // For profile view: include user= param only if viewing someone else
    var loggedIn = getCurrentUsername() || '';
    var profileForUrl = (view === 'profile' && _profileUsername && _profileUsername !== loggedIn)
      ? _profileUsername : null;
    var url = buildViewUrl(view, profileForUrl);
    history.pushState({ view: view, profileUser: profileForUrl }, '', url);
  }

  // Load content (unless caller handles its own loading, e.g. profLoadPublic)
  if (!opts.noLoad) {
    if (view === 'dashboard')  renderDashboard();
    if (view === 'collection') loadCollection(false);
    if (view === 'discover')   loadDiscover();
    if (view === 'profile')    loadProfile();
  }
}

function renderDashboard() {
  if (!resultsData || resultsData.length === 0) {
    document.getElementById('dashStats').innerHTML = '<p style="color:#666;padding:24px">Load your wantlist first.</p>';
    return;
  }

  var total      = resultsData.length;
  var inStock    = resultsData.filter(function(i) { return i.stores && i.stores.some(function(s) { return s.inStock; }); });
  var inStockN   = inStock.length;
  var withDiscogs= resultsData.filter(function(i) { return i.discogsPrice && i.discogsPrice.lowestPrice; }).length;

  // Cheapest in-stock finds
  var cheapest = inStock.slice().sort(function(a, b) { return getLowestPrice(a) - getLowestPrice(b); }).slice(0, 6);

  // Store breakdown
  var storeCounts = {};
  resultsData.forEach(function(i) {
    (i.stores || []).forEach(function(s) {
      if (s.inStock && !s.linkOnly) storeCounts[s.store] = (storeCounts[s.store] || 0) + 1;
    });
  });

  // Genre breakdown (top 6)
  var genreCounts = {};
  resultsData.forEach(function(i) {
    if (!i.item.genres) return;
    i.item.genres.split(', ').forEach(function(g) { if (g) genreCounts[g] = (genreCounts[g] || 0) + 1; });
  });
  var topGenres = Object.keys(genreCounts).sort(function(a,b){return genreCounts[b]-genreCounts[a];}).slice(0,6);

  // Optimizer summary
  var optSummary = _lastOptimizerResult
    ? '<div class="dash-opt-summary">' +
        '<div class="dash-opt-label">Last Optimizer Run</div>' +
        '<div class="dash-opt-stats">' +
          '<span>$' + _lastOptimizerResult.grandTotalUsd.toFixed(2) + ' total</span>' +
          '<span>' + _lastOptimizerResult.covered + '/' + _lastOptimizerResult.total + ' covered</span>' +
          '<span>' + _lastOptimizerResult.numSellers + ' sellers</span>' +
        '</div>' +
        '<button class="dash-opt-btn" onclick="switchView(\'wantlist\',document.querySelector(\'[data-view=wantlist]\'));setTimeout(viewFullCart,100)">View Cart →</button>' +
      '</div>'
    : '<div class="dash-opt-summary empty"><p>Run the optimizer to see your best cart here.</p>' +
        '<button class="dash-opt-btn" onclick="switchView(\'wantlist\',document.querySelector(\'[data-view=wantlist]\'));setTimeout(openOptimizer,100)">⛏ Dig For Gold</button>' +
      '</div>';

  // Big stat blocks
  document.getElementById('dashStats').innerHTML =
    '<div class="dash-stat-row">' +
      dashStat(total, 'In Wantlist', '#888') +
      dashStat(inStockN, 'In Stock Now', '#4caf50') +
      dashStat(withDiscogs, 'Discogs Prices', '#C9A227') +
      dashStat(Object.keys(storeCounts).length, 'Stores Found In', '#6a9adf') +
    '</div>' +
    optSummary;

  // Best finds
  document.getElementById('dashInStock').innerHTML =
    '<div class="dash-section-title">Cheapest In Stock Right Now</div>' +
    '<div class="dash-finds">' +
    cheapest.map(function(item) {
      var price = getLowestPrice(item);
      var thumb = item.item.thumb ? '<img src="' + escapeHtml(item.item.thumb) + '" alt="">' : '<div class="dash-find-nothumb">♪</div>';
      return '<div class="dash-find" onclick="openReleaseDetail(' + item.item.id + ')">' +
        '<div class="dash-find-thumb">' + thumb + '</div>' +
        '<div class="dash-find-info">' +
          '<div class="dash-find-artist">' + escapeHtml(item.item.artist) + '</div>' +
          '<div class="dash-find-title">' + escapeHtml(item.item.title) + '</div>' +
        '</div>' +
        '<div class="dash-find-price">$' + price.toFixed(2) + '</div>' +
      '</div>';
    }).join('') +
    '</div>';

  // Store breakdown
  document.getElementById('dashStores').innerHTML =
    '<div class="dash-section-title">In Stock By Store</div>' +
    '<div class="dash-store-bars">' +
    Object.keys(storeCounts).sort(function(a,b){return storeCounts[b]-storeCounts[a];}).map(function(store) {
      var pct = Math.round((storeCounts[store] / total) * 100);
      var logo = storeLogoMap[store] ? '<img src="img/' + storeLogoMap[store] + '" alt="">' : '';
      return '<div class="dash-bar-row">' +
        '<div class="dash-bar-label">' + logo + escapeHtml(storeDisplayName[store] || store) + '</div>' +
        '<div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + Math.max(pct * 4, 4) + '%"></div></div>' +
        '<div class="dash-bar-count">' + storeCounts[store] + '</div>' +
      '</div>';
    }).join('') +
    '</div>';

  // Genre breakdown
  document.getElementById('dashGenres').innerHTML =
    '<div class="dash-section-title">Your Collection By Genre</div>' +
    '<div class="dash-genre-chips">' +
    topGenres.map(function(g) {
      var pct = Math.round((genreCounts[g] / total) * 100);
      return '<div class="dash-genre-chip"><span class="dash-genre-name">' + escapeHtml(g) + '</span><span class="dash-genre-count">' + genreCounts[g] + ' · ' + pct + '%</span></div>';
    }).join('') +
    '</div>';

  // Discover section — async, loads recommendations from server
  var discoverWrap = document.getElementById('dashDiscover');
  if (discoverWrap) {
    discoverWrap.style.display = '';
    loadDiscoverSection();
  }
}

// ─── Discovered For You ───────────────────────────────────────────────────────
var _discoverCache    = null;   // cached server response
var _discoverFilter   = 'all';  // active filter pill
var _discoverLoading  = false;

function loadDiscoverSection(forceRefresh) {
  if (_discoverLoading) return;
  var username = getCurrentUsername();
  if (!username) return;

  var wrap = document.getElementById('dashDiscover');
  if (!wrap) return;

  if (_discoverCache && !forceRefresh) {
    renderDiscoverSection(_discoverCache);
    return;
  }

  _discoverLoading = true;
  _discoverFilter  = 'all';

  wrap.innerHTML =
    '<div class="discover-header">' +
      '<span class="dash-section-title" style="margin-bottom:0">Discovered For You</span>' +
      '<span class="discover-status" id="discoverStatus">Analysing your taste profile…</span>' +
    '</div>' +
    '<div class="discover-rack discover-rack-skeleton">' +
      [0,1,2,3,4,5].map(function() {
        return '<div class="disc-card disc-card-skeleton"><div class="disc-art-skel"></div><div class="disc-info-skel"><div class="disc-skel-line"></div><div class="disc-skel-line short"></div></div></div>';
      }).join('') +
    '</div>';

  fetch('api/recommend/' + encodeURIComponent(username) + '?limit=40')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _discoverCache   = data;
      _discoverLoading = false;
      renderDiscoverSection(data);
    })
    .catch(function(e) {
      _discoverLoading = false;
      var wrap2 = document.getElementById('dashDiscover');
      if (wrap2) wrap2.innerHTML =
        '<div class="discover-header"><span class="dash-section-title" style="margin-bottom:0">Discovered For You</span>' +
        '<span class="discover-status discover-err">Could not load recommendations.</span></div>';
    });
}

function renderDiscoverSection(data) {
  var wrap = document.getElementById('dashDiscover');
  if (!wrap) return;

  var recs = (data && data.recommendations) || [];

  // Determine which filter tabs to show
  var hasArtist = recs.some(function(r) { return r.reasonTypes && r.reasonTypes.indexOf('artist') !== -1; });
  var hasLabel  = recs.some(function(r) { return r.reasonTypes && r.reasonTypes.indexOf('label')  !== -1; });
  var hasStyle  = recs.some(function(r) { return r.reasonTypes && r.reasonTypes.indexOf('style')  !== -1; });

  var filters = ['all'];
  if (hasArtist) filters.push('artist');
  if (hasLabel)  filters.push('label');
  if (hasStyle)  filters.push('style');

  var metaStr = data
    ? data.inventorySize + ' items scanned · ' + data.wantlistSize + ' in your taste profile · ' + (data.computeMs || 0) + 'ms'
    : '';

  var topStyleStr = (data && data.topStyles && data.topStyles.length)
    ? data.topStyles.slice(0, 4).join(', ')
    : '';

  wrap.innerHTML =
    '<div class="discover-header">' +
      '<div>' +
        '<span class="dash-section-title" style="margin-bottom:0">Discovered For You</span>' +
        (topStyleStr ? '<span class="discover-taste-pill">' + escapeHtml(topStyleStr) + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px">' +
        '<span class="discover-status">' + escapeHtml(metaStr) + '</span>' +
        '<button class="discover-refresh-btn" onclick="loadDiscoverSection(true)" title="Refresh recommendations">↻</button>' +
      '</div>' +
    '</div>' +
    // Filter pills
    '<div class="discover-filters" id="discoverFilters">' +
      filters.map(function(f) {
        var label = f === 'all' ? 'All' : f === 'artist' ? 'Artist Match' : f === 'label' ? 'Label Match' : 'Style Match';
        return '<button class="discover-filter-pill' + (f === _discoverFilter ? ' active' : '') +
               '" onclick="setDiscoverFilter(\'' + f + '\')">' + label + '</button>';
      }).join('') +
    '</div>' +
    // Cards rack
    '<div class="discover-rack" id="discoverRack">' +
      renderDiscoverCards(recs, _discoverFilter) +
    '</div>';
}

function setDiscoverFilter(filter) {
  _discoverFilter = filter;
  // Update pill active state
  var pills = document.querySelectorAll('.discover-filter-pill');
  pills.forEach(function(p) {
    p.classList.toggle('active', p.textContent.toLowerCase().indexOf(filter === 'all' ? 'all' : filter) !== -1);
  });
  // Re-render cards
  var rack = document.getElementById('discoverRack');
  if (rack && _discoverCache) {
    rack.innerHTML = renderDiscoverCards(_discoverCache.recommendations || [], filter);
  }
}

// Store display names + colours (matches optimizer card colours)
var _discoverStoreColour = {
  gramaphone:  '#c8102e',
  further:     '#d97706',
  octopus:     '#3a9bd5',
  uvs:         '#20c997',
};

function renderDiscoverCards(recs, filter) {
  var filtered = recs;
  if (filter && filter !== 'all') {
    filtered = recs.filter(function(r) {
      return r.reasonTypes && r.reasonTypes.indexOf(filter) !== -1;
    });
  }

  if (!filtered.length) {
    return '<div class="discover-empty">No items match this filter — try "All".</div>';
  }

  return filtered.slice(0, 30).map(function(rec) {
    var img = rec.image
      ? '<img class="disc-art-img" src="' + escapeHtml(rec.image) + '" loading="lazy" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
        + '<div class="disc-art-placeholder" style="display:none">♪</div>'
      : '<div class="disc-art-placeholder">♪</div>';

    var pct     = rec.matchPct || 0;
    var pctColor = pct >= 80 ? '#4ade80' : pct >= 60 ? '#C9A227' : '#888';

    var reasonPills = (rec.reasons || []).map(function(r, i) {
      var type  = (rec.reasonTypes || [])[i] || 'style';
      var cls   = 'disc-reason disc-reason-' + type;
      return '<span class="' + cls + '">' + escapeHtml(r) + '</span>';
    }).join('');

    var price  = rec.price ? '$' + rec.price.toFixed(2) : '';
    var year   = rec.year  ? rec.year : '';
    var store  = rec.store || '';
    var storeColour = _discoverStoreColour[store.toLowerCase()] || '#666';
    var storeLabel  = store.charAt(0).toUpperCase() + store.slice(1);

    var cardUrl = rec.url ? ' onclick="window.open(\'' + escapeHtml(rec.url) + '\',\'_blank\')"' : '';

    return '<div class="disc-card"' + cardUrl + '>' +
      '<div class="disc-art">' + img + '</div>' +
      '<div class="disc-match-badge" style="background:' + pctColor + '">' + pct + '%</div>' +
      '<div class="disc-body">' +
        '<div class="disc-artist">' + escapeHtml(rec.artist || '') + '</div>' +
        '<div class="disc-title">' + escapeHtml(rec.title || '') + '</div>' +
        '<div class="disc-meta">' +
          '<span class="disc-label">' + escapeHtml(rec.label || '') + '</span>' +
          (year ? '<span class="disc-year">' + year + '</span>' : '') +
        '</div>' +
        '<div class="disc-footer">' +
          '<div class="disc-reasons">' + reasonPills + '</div>' +
          '<div class="disc-price-store">' +
            (price ? '<span class="disc-price">' + price + '</span>' : '') +
            '<span class="disc-store-badge" style="background:' + storeColour + '">' + escapeHtml(storeLabel) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function dashStat(value, label, color) {
  return '<div class="dash-stat">' +
    '<div class="dash-stat-value" style="color:' + color + '">' + value + '</div>' +
    '<div class="dash-stat-label">' + label + '</div>' +
  '</div>';
}

// ═══════════════════════════════════════════════════════════════
// COLLECTION VIEW
// ═══════════════════════════════════════════════════════════════

var _collectionData    = null;   // raw items from server
var _collectionLoaded  = false;
var _collGenreFilter   = null;   // active genre pill

function loadCollection(forceRefresh) {
  var username = getCurrentUsername();
  if (!username) {
    document.getElementById('collGrid').innerHTML =
      '<div class="coll-empty">Enter your Discogs username above to see your collection.</div>';
    return;
  }

  if (_collectionLoaded && !forceRefresh) {
    renderCollectionGrid();
    return;
  }

  _collGenreFilter = null;
  document.getElementById('collGrid').innerHTML = '<div class="coll-loading">Syncing collection from Discogs…</div>';
  document.getElementById('collCount').textContent = '';
  document.getElementById('collStatsBar').innerHTML = '';
  document.getElementById('collGenreRow').innerHTML = '';

  var url = 'api/collection/' + encodeURIComponent(username) + (forceRefresh ? '?refresh=1' : '');

  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // If empty + error, show a helpful message (often means private collection / no OAuth)
      if ((!data.items || !data.items.length) && (data.error || data.total === 0)) {
        var msg = data.error || '';
        var hint = '';
        if (msg.indexOf('401') !== -1 || msg.toLowerCase().indexOf('auth') !== -1 ||
            msg.toLowerCase().indexOf('private') !== -1) {
          hint = 'Your Discogs collection may be private. ' +
                 '<a href="api/auth/discogs" style="color:var(--gold);text-decoration:underline">Connect Discogs OAuth</a> to access it.';
        } else {
          hint = msg ? 'Could not load: ' + escapeHtml(msg) : 'No collection found for ' + escapeHtml(username) + '.';
        }
        document.getElementById('collGrid').innerHTML = '<div class="coll-empty">' + hint + '</div>';
        return;
      }
      _collectionData   = data.items || [];
      _collectionLoaded = true;
      renderCollectionStats(data.stats);
      renderCollectionGenres();
      renderCollectionGrid();
    })
    .catch(function(e) {
      document.getElementById('collGrid').innerHTML =
        '<div class="coll-empty">Failed to connect to server. Please try again.</div>';
    });
}

function renderCollectionStats(stats) {
  var countEl = document.getElementById('collCount');
  if (countEl && _collectionData) countEl.textContent = _collectionData.length + ' records';

  var bar = document.getElementById('collStatsBar');
  if (!bar || !stats) return;
  var parts = [];
  if (stats.unique_artists) parts.push('<span>' + stats.unique_artists + ' artists</span>');
  if (stats.unique_labels)  parts.push('<span>' + stats.unique_labels  + ' labels</span>');
  if (stats.earliest_year && stats.latest_year && stats.earliest_year !== stats.latest_year)
    parts.push('<span>' + stats.earliest_year + ' – ' + stats.latest_year + '</span>');
  bar.innerHTML = parts.join('<span class="coll-stats-sep">·</span>');
}

function renderCollectionGenres() {
  var row = document.getElementById('collGenreRow');
  if (!row || !_collectionData) return;

  var genreCounts = {};
  _collectionData.forEach(function(item) {
    (item.genres || '').split('|').map(function(g) { return g.trim(); }).filter(Boolean)
      .forEach(function(g) { genreCounts[g] = (genreCounts[g] || 0) + 1; });
  });

  var genres = Object.keys(genreCounts).sort(function(a,b) { return genreCounts[b]-genreCounts[a]; }).slice(0, 12);
  if (!genres.length) { row.innerHTML = ''; return; }

  row.innerHTML =
    '<button class="coll-genre-pill' + (!_collGenreFilter ? ' active' : '') + '" onclick="setCollGenre(null)">All</button>' +
    genres.map(function(g) {
      return '<button class="coll-genre-pill' + (g === _collGenreFilter ? ' active' : '') +
             '" onclick="setCollGenre(\'' + escapeHtml(g) + '\')">' + escapeHtml(g) + ' <span class="coll-pill-count">' + genreCounts[g] + '</span></button>';
    }).join('');
}

function setCollGenre(genre) {
  _collGenreFilter = genre;
  renderCollectionGenres();
  renderCollectionGrid();
}

/**
 * Open the release detail modal from a collection card.
 * Populates currentFilteredIds with the current grid order so
 * swipe / arrow navigation moves through the collection.
 */
function openCollRelease(discogsId) {
  var search  = ((document.getElementById('collSearch') || {}).value || '').toLowerCase();
  var sort    = (document.getElementById('collSort')    || {}).value || 'date-new';

  var items = (_collectionData || []).filter(function(item) {
    if (_collGenreFilter) {
      var genres = (item.genres || '').split('|').map(function(g) { return g.trim(); });
      if (genres.indexOf(_collGenreFilter) === -1) return false;
    }
    if (search) {
      var hay = ((item.artist || '') + ' ' + (item.title || '') + ' ' + (item.label || '') + ' ' + (item.catno || '')).toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  }).sort(function(a, b) {
    switch (sort) {
      case 'date-new': return (b.date_added || '').localeCompare(a.date_added || '');
      case 'date-old': return (a.date_added || '').localeCompare(b.date_added || '');
      case 'artist':   return (a.artist || '').localeCompare(b.artist || '');
      case 'year-new': return (b.year || 0) - (a.year || 0);
      case 'year-old': return (a.year || 0) - (b.year || 0);
      default: return 0;
    }
  });

  // Set navigation context so swipe/arrow moves through collection
  currentFilteredIds = items.map(function(item) { return item.discogs_id; });
  openReleaseDetail(discogsId);
}

function renderCollectionGrid() {
  if (!_collectionData) return;

  var search = (document.getElementById('collSearch')  || {}).value || '';
  var sort   = (document.getElementById('collSort')    || {}).value || 'date-new';
  var searchL = search.toLowerCase();

  var items = _collectionData.filter(function(item) {
    if (_collGenreFilter) {
      var genres = (item.genres || '').split('|').map(function(g) { return g.trim(); });
      if (genres.indexOf(_collGenreFilter) === -1) return false;
    }
    if (searchL) {
      var hay = ((item.artist || '') + ' ' + (item.title || '') + ' ' + (item.label || '') + ' ' + (item.catno || '')).toLowerCase();
      if (hay.indexOf(searchL) === -1) return false;
    }
    return true;
  });

  items = items.slice().sort(function(a, b) {
    switch (sort) {
      case 'date-new': return (b.date_added || '').localeCompare(a.date_added || '');
      case 'date-old': return (a.date_added || '').localeCompare(b.date_added || '');
      case 'artist':   return (a.artist || '').localeCompare(b.artist || '');
      case 'year-new': return (b.year || 0) - (a.year || 0);
      case 'year-old': return (a.year || 0) - (b.year || 0);
      default: return 0;
    }
  });

  var grid = document.getElementById('collGrid');
  var countEl = document.getElementById('collCount');
  if (countEl) countEl.textContent = items.length + ' of ' + _collectionData.length + ' records';

  if (!items.length) {
    grid.innerHTML = '<div class="coll-empty">' + (search || _collGenreFilter ? 'No records match your filter.' : 'No collection items found.') + '</div>';
    return;
  }

  grid.innerHTML = items.map(function(item) {
    var thumb = item.thumb
      ? '<img class="coll-card-art" src="' + escapeHtml(item.thumb) + '" loading="lazy" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
        + '<div class="coll-card-art coll-art-placeholder" style="display:none">♪</div>'
      : '<div class="coll-card-art coll-art-placeholder">♪</div>';

    var genreChips = (item.genres || '').split('|').map(function(g) { return g.trim(); }).filter(Boolean).slice(0,2)
      .map(function(g) { return '<span class="coll-chip">' + escapeHtml(g) + '</span>'; }).join('');
    var styleChips = (item.styles || '').split('|').map(function(s) { return s.trim(); }).filter(Boolean).slice(0,2)
      .map(function(s) { return '<span class="coll-chip coll-chip-style">' + escapeHtml(s) + '</span>'; }).join('');

    var formats = item.formats ? '<span class="coll-format">' + escapeHtml(item.formats.split(';')[0].trim()) + '</span>' : '';
    var year    = item.year    ? '<span class="coll-year">' + item.year + '</span>' : '';
    var rating  = item.rating  ? '★'.repeat(item.rating) : '';

    var clickHandler = item.discogs_id
      ? ' onclick="openCollRelease(' + item.discogs_id + ')"'
      : '';

    return '<div class="coll-card"' + clickHandler + '>' +
      '<div class="coll-art-wrap">' + thumb + '</div>' +
      '<div class="coll-card-body">' +
        '<div class="coll-card-artist">' + escapeHtml(item.artist || '') + '</div>' +
        '<div class="coll-card-title">'  + escapeHtml(item.title  || '') + '</div>' +
        '<div class="coll-card-meta">' +
          '<span class="coll-label">' + escapeHtml(item.label || '') + '</span>' +
          year +
        '</div>' +
        '<div class="coll-card-tags">' + genreChips + styleChips + '</div>' +
        '<div class="coll-card-footer">' +
          formats +
          (rating ? '<span class="coll-rating">' + rating + '</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Wire search/sort inputs to re-render
document.addEventListener('DOMContentLoaded', function() {
  var searchEl = document.getElementById('collSearch');
  var sortEl   = document.getElementById('collSort');
  if (searchEl) searchEl.addEventListener('input',  function() { if (_collectionLoaded) renderCollectionGrid(); });
  if (sortEl)   sortEl.addEventListener('change', function() { if (_collectionLoaded) renderCollectionGrid(); });
});

// ═══════════════════════════════════════════════════════════════
// DISCOVER VIEW — "For You" + "In Stock" tabs
// ═══════════════════════════════════════════════════════════════

var _discoverData        = null;
var _discoverTab         = 'forYou';   // 'forYou' | 'inStock'
var _discoverSort        = 'items';
var _discoverGenreFilter = null;
var _activeDiscoverStore = null;
var _discoverCartSet     = {};
var _forYouFilter        = 'all';      // 'all' | 'artist' | 'style'
var _forYouStoreFilter   = 'all';      // 'all' | storeName
var _inStockVendor       = 'all';      // 'all' | storeName | 'discogs'
var _discogsSyncState    = null;       // live state from extension: {running, done, total, found, completedAt, error}
var _dgPriceMap          = {};         // wantlistId → cheapestUsd from discogsListings

function loadDiscover() {
  var username = getCurrentUsername();
  if (!username) {
    document.getElementById('discBody').innerHTML =
      '<div class="disc-empty">Connect your Discogs account to use Discover.</div>';
    return;
  }
  document.getElementById('discBody').innerHTML =
    '<div class="disc-loading" style="display:flex"><div class="disc-spinner"></div>Loading discover data…</div>';

  fetch('api/discover/' + encodeURIComponent(username))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _discoverData    = data;
      _discoverCartSet = data.cartSet || {};
      // Only reset filters if no pending profile→discover navigation
      if (!_pendingDiscoverNav) {
        _forYouStoreFilter   = 'all';
        _discoverGenreFilter = null;
      }
      renderDiscover();
      updateCartBadge(Object.keys(_discoverCartSet).length);
    })
    .catch(function(e) {
      document.getElementById('discBody').innerHTML =
        '<div class="disc-empty">Error loading discover data.</div>';
      console.error('[discover]', e);
    });
}

function switchDiscoverTab(tab) {
  _discoverTab = tab;
  document.querySelectorAll('.disc-tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  renderDiscoverBody();
}

function renderDiscover() {
  if (!_discoverData) return;

  // Apply pending navigation from profile sections
  if (_pendingDiscoverNav) {
    var nav = _pendingDiscoverNav;
    _pendingDiscoverNav = null;
    _discoverTab = nav.tab || 'forYou';
    if (nav.genre !== undefined) { _discoverGenreFilter = nav.genre; _forYouStoreFilter = 'all'; }
    if (nav.store !== undefined) { _inStockVendor = nav.store; }
  }

  var tp = _discoverData.tasteProfile || {};
  var forYou = _discoverData.forYou || [];
  var stores = _discoverData.stores || [];

  var inventoryLine = tp.inventorySize
    ? tp.inventorySize.toLocaleString() + ' items scanned · ' + (_discoverData.totalInStock || 0) + ' in your wantlist · ' + (tp.computeMs || 0) + 'ms'
    : (_discoverData.totalInStock || 0) + ' in-stock items across ' + stores.length + ' stores';

  document.getElementById('discWrap').innerHTML =
    // Header
    '<div class="disc-header">' +
      '<div class="disc-title-row">' +
        '<span class="disc-title">Discover</span>' +
        '<span class="disc-subtitle">' + escapeHtml(inventoryLine) + '</span>' +
      '</div>' +
      '<div class="disc-cart-row" id="discCartRow" style="display:none">' +
        '<span class="disc-cart-count" id="discCartCount"></span>' +
        '<button class="disc-clear-btn" onclick="discoverClearCart()">Clear cart</button>' +
      '</div>' +
    '</div>' +
    // Tabs
    '<div class="disc-tabs">' +
      '<button class="disc-tab-btn' + (_discoverTab === 'forYou' ? ' active' : '') + '" data-tab="forYou" onclick="switchDiscoverTab(\'forYou\')">For You</button>' +
      '<button class="disc-tab-btn' + (_discoverTab === 'inStock' ? ' active' : '') + '" data-tab="inStock" onclick="switchDiscoverTab(\'inStock\')">In Stock</button>' +
    '</div>' +
    // Body
    '<div id="discBody"></div>';

  renderDiscoverBody();
  updateDiscCartRow();
}

function renderDiscoverBody() {
  if (!_discoverData) return;
  if (_discoverTab === 'forYou') renderForYouTab();
  else renderInStockTab();
}

// ─── FOR YOU TAB ─────────────────────────────────────────────────────────────

function setForYouStoreFilter(store, btn) {
  _forYouStoreFilter = store;
  document.querySelectorAll('.disc-store-filter-pill').forEach(function(p) { p.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderForYouTab();
}

function renderForYouTab() {
  var forYou = _discoverData.forYou || [];
  var tp     = _discoverData.tasteProfile || {};

  // Build Discogs price lookup map (wantlistId → cheapest listing)
  _dgPriceMap = {};
  (_discoverData.discogsListings || []).forEach(function(dl) {
    if (dl.wantlistId && dl.cheapestUsd) _dgPriceMap[dl.wantlistId] = dl;
  });

  // Collect unique stores present in forYou (with counts)
  var storeCounts = {};
  forYou.forEach(function(item) {
    if (item.store) storeCounts[item.store] = (storeCounts[item.store] || 0) + 1;
  });
  var storesPresent = Object.keys(storeCounts).sort(function(a,b){ return storeCounts[b]-storeCounts[a]; });

  // Filter by match type + store
  var filtered = forYou.filter(function(item) {
    if (_forYouStoreFilter !== 'all' && item.store !== _forYouStoreFilter) return false;
    if (_discoverGenreFilter) {
      var g = (item.genres + '|' + item.styles).toLowerCase();
      if (g.indexOf(_discoverGenreFilter.toLowerCase()) === -1) return false;
    }
    if (_forYouFilter === 'artist') return item.reasons && item.reasons.indexOf('artist') !== -1 || item.source === 'wantlist';
    if (_forYouFilter === 'style')  return item.reasons && item.reasons.some(function(r){ return r.indexOf('style') !== -1 || r.indexOf('genre') !== -1; }) || item.source === 'wantlist';
    return true;
  });

  // Build taste tag cloud from profile top genres/styles
  var tasteTagsHtml = (tp.topGenres || []).concat(tp.topStyles || []).slice(0, 8)
    .map(function(t) { return '<span class="disc-taste-tag">' + escapeHtml(t) + '</span>'; }).join('');

  // Genre filter pills from forYou items
  var genreCounts = {};
  forYou.forEach(function(item) {
    (item.genres + '|' + item.styles).split('|').forEach(function(g) {
      g = g.trim();
      if (g && g.length > 2) genreCounts[g] = (genreCounts[g] || 0) + 1;
    });
  });
  var topGenres = Object.keys(genreCounts).sort(function(a,b){ return genreCounts[b]-genreCounts[a]; }).slice(0,8);

  // Discogs price count for stat line
  var dgCount = Object.keys(_dgPriceMap).length;
  var wantlistInForYou = forYou.filter(function(i) { return i.source === 'wantlist'; }).length;
  var statLine = filtered.length + ' records';
  if (wantlistInForYou > 0) statLine += ' · ' + wantlistInForYou + ' on your wantlist';
  if (dgCount > 0) statLine += ' · ' + dgCount + ' Discogs prices';

  var html =
    '<div class="disc-fy-statline">' + statLine + '</div>' +
    '<div class="disc-foryou-controls">' +
      // Match type filters
      '<div class="disc-foryou-filters">' +
        '<button class="disc-filter-btn' + (_forYouFilter === 'all' ? ' active' : '') + '" onclick="setForYouFilter(\'all\',this)">All</button>' +
        '<button class="disc-filter-btn' + (_forYouFilter === 'artist' ? ' active' : '') + '" onclick="setForYouFilter(\'artist\',this)">Artist Match</button>' +
        '<button class="disc-filter-btn' + (_forYouFilter === 'style' ? ' active' : '') + '" onclick="setForYouFilter(\'style\',this)">Style Match</button>' +
        (tasteTagsHtml ? '<div class="disc-taste-tags">' + tasteTagsHtml + '</div>' : '') +
      '</div>' +
      // Genre pills
      (topGenres.length ?
        '<div class="disc-genre-row">' +
          '<button class="disc-genre-pill' + (!_discoverGenreFilter ? ' active' : '') + '" onclick="setDiscoverGenre(null,this)">All</button>' +
          topGenres.map(function(g) {
            return '<button class="disc-genre-pill' + (_discoverGenreFilter === g ? ' active' : '') +
              '" onclick="setDiscoverGenre(\'' + escapeAttr(g) + '\',this)">' + escapeHtml(g) + '</button>';
          }).join('') +
        '</div>' : '') +
      // Store filter pills (compact row — only when >1 store)
      (storesPresent.length > 1 ?
        '<div class="disc-store-filter-row">' +
          '<button class="disc-store-filter-pill' + (_forYouStoreFilter === 'all' ? ' active' : '') +
            '" onclick="setForYouStoreFilter(\'all\',this)">All stores</button>' +
          storesPresent.map(function(s) {
            var cls = storeClassMap[s] || '';
            return '<button class="disc-store-filter-pill ' + cls + (_forYouStoreFilter === s ? ' active' : '') +
              '" onclick="setForYouStoreFilter(\'' + escapeAttr(s) + '\',this)">' +
              escapeHtml(storeDisplayName[s] || s) + ' <span class="disc-vendor-count">' + storeCounts[s] + '</span></button>';
          }).join('') +
        '</div>' : '') +
    '</div>';

  if (filtered.length === 0) {
    html += '<div class="disc-empty">No items found. Run a scan and sync your streaming data to see recommendations.</div>';
  } else {
    html += '<div class="disc-card-grid">' + filtered.map(renderForYouCard).join('') + '</div>';
  }

  document.getElementById('discBody').innerHTML = html;
}

function renderForYouCard(item) {
  // Match badge
  var isWantlist = item.source === 'wantlist';
  var pct = item.matchPct || 0;
  var badgeClass = isWantlist ? 'disc-match-badge wantlist' : 'disc-match-badge' + (pct >= 85 ? ' high' : pct >= 70 ? ' mid' : '');
  var badgeLabel = isWantlist ? '✓' : pct + '%';

  // Art
  var artHtml = item.image || item.thumb
    ? '<img class="disc-card-art" src="' + escapeHtml(item.image || item.thumb) + '" loading="lazy" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
      '<div class="disc-card-art-placeholder" style="display:none">♪</div>'
    : '<div class="disc-card-art-placeholder">♪</div>';

  // Genre chip (first style tag)
  var firstStyle = (item.styles || item.genres || '').split('|')[0].trim();
  var genreChip = firstStyle ? '<span class="disc-card-genre-chip">' + escapeHtml(firstStyle) + '</span>' : '';

  // Store badge
  var storeCls = storeClassMap[item.store] || '';
  var storeBadge = item.store
    ? '<span class="disc-card-store-badge ' + storeCls + '">' + escapeHtml(storeDisplayName[item.store] || item.store) + '</span>'
    : '';

  // Store price
  var priceHtml = item.priceStr
    ? '<span class="disc-card-price">' + escapeHtml(item.priceStr) + '</span>'
    : (item.priceUsd ? '<span class="disc-card-price">$' + item.priceUsd.toFixed(2) + '</span>' : '');

  // Discogs cheapest listing badge (cross-reference by wantlistId)
  var dgBadge = '';
  if (item.wantlistId && _dgPriceMap[item.wantlistId]) {
    var dl = _dgPriceMap[item.wantlistId];
    var dgLabel = dl.cheapestStr || ('$' + dl.cheapestUsd.toFixed(2));
    var condAbbr = dl.condition ? ' · ' + dl.condition.charAt(0) : '';
    dgBadge = '<span class="disc-card-dg-price" title="Cheapest on Discogs: ' + escapeAttr(dl.condition || '') + ' from ' + escapeAttr(dl.seller || '') + '">' +
      '<img src="img/discogs.png" style="width:9px;height:9px;opacity:0.6;vertical-align:middle;margin-right:2px">' +
      escapeHtml(dgLabel) + escapeHtml(condAbbr) +
      '</span>';
  }

  // Cart button (only for wantlist items that have wantlistId)
  var cartBtn = '';
  if (item.wantlistId) {
    var cartKey  = String(item.wantlistId) + ':' + item.store;
    var inCart   = !!_discoverCartSet[cartKey];
    cartBtn = '<button class="disc-card-cart-btn' + (inCart ? ' in-cart' : '') + '" data-key="' + escapeAttr(cartKey) + '" ' +
      'onclick="toggleCart(' + item.wantlistId + ',\'' + escapeAttr(item.store) + '\',\'' + escapeAttr(item.priceStr) + '\',' +
      (item.priceUsd !== null ? item.priceUsd : 'null') + ')">' +
      (inCart ? '✓' : '+') + '</button>';
  }

  var linkAttr = item.url ? ' onclick="window.open(\'' + escapeAttr(item.url) + '\',\'_blank\')"' : '';

  return '<div class="disc-fy-card"' + linkAttr + '>' +
    '<div class="disc-card-art-wrap">' +
      artHtml +
      '<span class="' + badgeClass + '">' + badgeLabel + '</span>' +
      (isWantlist ? '<span class="disc-wantlist-badge">WANTLIST</span>' : '') +
    '</div>' +
    '<div class="disc-card-body">' +
      '<div class="disc-card-artist">' + escapeHtml(item.artist || '') + '</div>' +
      '<div class="disc-card-title">'  + escapeHtml(item.title  || '') + '</div>' +
      '<div class="disc-card-footer">' +
        genreChip + storeBadge + priceHtml + dgBadge + cartBtn +
      '</div>' +
    '</div>' +
  '</div>';
}

// ─── IN STOCK TAB ─────────────────────────────────────────────────────────────

function setInStockVendor(vendor, btn) {
  _inStockVendor = vendor;
  document.querySelectorAll('.disc-vendor-pill').forEach(function(p) { p.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderInStockBody();
}

function renderInStockTab() {
  var stores  = _discoverData.stores || [];
  var dgItems = _discoverData.discogsListings || [];

  // Vendor filter pills
  var pillsHtml = '<button class="disc-vendor-pill' + (_inStockVendor === 'all' ? ' active' : '') +
    '" onclick="setInStockVendor(\'all\',this)">All <span class="disc-vendor-count">' + stores.reduce(function(n,s){ return n + s.itemCount; }, 0) + '</span></button>';
  stores.forEach(function(s) {
    var cls = storeClassMap[s.store] || '';
    pillsHtml += '<button class="disc-vendor-pill ' + cls + (_inStockVendor === s.store ? ' active' : '') +
      '" onclick="setInStockVendor(\'' + escapeAttr(s.store) + '\',this)">' +
      escapeHtml(storeDisplayName[s.store] || s.store) +
      ' <span class="disc-vendor-count">' + s.itemCount + '</span></button>';
  });
  // Discogs pill — always shown; count from synced listings
  var dgCount = dgItems.length;
  pillsHtml += '<button class="disc-vendor-pill discogs' + (_inStockVendor === 'discogs' ? ' active' : '') +
    '" onclick="setInStockVendor(\'discogs\',this)">' +
    '<img src="img/discogs.png" style="width:10px;height:10px;opacity:0.7;vertical-align:middle;margin-right:4px">' +
    'Discogs' + (dgCount > 0 ? ' <span class="disc-vendor-count">' + dgCount + '</span>' : '') + '</button>';

  document.getElementById('discBody').innerHTML =
    '<div class="disc-vendor-filter">' + pillsHtml + '</div>' +
    '<div id="discInStockBody"></div>';

  renderInStockBody();
}

function renderInStockBody() {
  var el = document.getElementById('discInStockBody');
  if (!el) return;

  if (_inStockVendor === 'discogs') {
    el.innerHTML = renderDiscogsSection();
    return;
  }

  var stores = _discoverData.stores || [];

  var sortControls =
    '<div class="disc-controls" style="display:flex;margin-bottom:14px">' +
      '<div class="disc-sort-row">' +
        '<span class="disc-sort-label">Sort by</span>' +
        '<button class="disc-sort-btn' + (_discoverSort === 'items' ? ' active' : '') + '" onclick="setDiscoverSort(\'items\',this)">Most Items</button>' +
        '<button class="disc-sort-btn' + (_discoverSort === 'total' ? ' active' : '') + '" onclick="setDiscoverSort(\'total\',this)">Lowest Total</button>' +
        '<button class="disc-sort-btn' + (_discoverSort === 'alpha' ? ' active' : '') + '" onclick="setDiscoverSort(\'alpha\',this)">A–Z</button>' +
      '</div>' +
    '</div>';

  var filtered = (_inStockVendor === 'all' ? stores : stores.filter(function(s) { return s.store === _inStockVendor; }))
    .slice().sort(function(a, b) {
      if (_discoverSort === 'total') {
        return (a.totalWithShipping !== null ? a.totalWithShipping : 9999) - (b.totalWithShipping !== null ? b.totalWithShipping : 9999);
      }
      if (_discoverSort === 'alpha') return a.store.localeCompare(b.store);
      return b.itemCount - a.itemCount;
    });

  if (filtered.length === 0) {
    el.innerHTML = sortControls + '<div class="disc-empty">No in-stock items found. Run a scan first.</div>';
    return;
  }

  el.innerHTML = sortControls + '<div class="disc-store-grid">' + filtered.map(renderStoreCard).join('') + '</div>';

  if (_activeDiscoverStore) {
    var card = document.querySelector('.disc-store-card[data-store="' + CSS.escape(_activeDiscoverStore) + '"]');
    if (card) card.classList.add('expanded');
  }
}

// ─── DISCOGS MARKETPLACE SECTION ─────────────────────────────────────────────

function renderDiscogsSection() {
  var items = _discoverData.discogsListings || [];
  var syncing = _discogsSyncState && _discogsSyncState.running;

  // Sync-in-progress banner (shown at top regardless of items)
  var syncBannerHtml = '';
  if (syncing) {
    var p = _discogsSyncState.total > 0
      ? Math.round((_discogsSyncState.done / _discogsSyncState.total) * 100) : 0;
    syncBannerHtml = '<div id="dgSyncBanner" class="dg-sync-banner running">' +
      '<span class="dg-sync-spin">⛏</span> Syncing Discogs marketplace… ' +
      _discogsSyncState.done + ' / ' + _discogsSyncState.total + ' releases · ' +
      (_discogsSyncState.found || 0) + ' listings (' + p + '%)' +
      '</div>';
  }

  if (items.length === 0 && !syncing) {
    var extBtn = _extInstalled
      ? '<button class="disc-discogs-ext-btn" onclick="triggerDiscogsSync()">⛏ Sync Discogs Prices</button>'
      : '<div class="disc-discogs-ext-hint">Install the Gold Digger Chrome Extension to sync seller prices from your Discogs account.</div>';
    return syncBannerHtml +
      '<div class="disc-discogs-empty">' +
        '<img src="img/discogs.png" style="width:20px;height:20px;opacity:0.5;margin-bottom:10px">' +
        '<div class="disc-discogs-empty-title">No Discogs listings synced yet</div>' +
        '<div class="disc-discogs-empty-hint">Syncing scrapes your Discogs wantlist marketplace pages to find cheapest seller prices.</div>' +
        extBtn +
      '</div>';
  }

  if (items.length === 0) return syncBannerHtml; // syncing, no items yet — just show progress

  var totalUsd = items.reduce(function(n, i) { return n + (i.cheapestUsd || 0); }, 0);
  var withPrice = items.filter(function(i) { return i.cheapestUsd > 0; }).length;
  var syncAgeMs = _lastDiscogsSyncTime[getCurrentUsername()] ? Date.now() - _lastDiscogsSyncTime[getCurrentUsername()] : null;
  var syncAgeLabel = syncAgeMs ? (syncAgeMs < 3600000 ? Math.round(syncAgeMs / 60000) + 'm ago' : Math.round(syncAgeMs / 3600000) + 'h ago') : '';

  var summaryHtml =
    '<div class="disc-discogs-summary">' +
      '<span>' + items.length + ' release' + (items.length !== 1 ? 's' : '') + ' with listings</span>' +
      (withPrice > 0 ? '<span class="disc-discogs-total">~$' + totalUsd.toFixed(0) + ' cheapest total</span>' : '') +
      (syncAgeLabel ? '<span class="disc-discogs-age">synced ' + syncAgeLabel + '</span>' : '') +
      (!syncing
        ? '<button class="disc-discogs-resync-btn" onclick="triggerDiscogsSync()">↻ Re-sync</button>'
        : '<span class="disc-discogs-syncing">⛏ syncing…</span>') +
    '</div>';

  var gridHtml = '<div class="disc-discogs-grid">' +
    items.map(function(item) {
      var artHtml = item.thumb
        ? '<img class="disc-dg-art" src="' + escapeHtml(item.thumb) + '" loading="lazy" alt="" onerror="this.style.display=\'none\';">'
        : '<div class="disc-dg-art-placeholder">♪</div>';

      var priceHtml = item.cheapestUsd
        ? '<span class="disc-dg-price">' + escapeHtml(item.cheapestStr || ('$' + item.cheapestUsd.toFixed(2))) + '</span>'
        : '<span class="disc-dg-price-na">—</span>';

      var condBadge = item.condition
        ? '<span class="disc-dg-cond">' + escapeHtml(item.condition.split(' ')[0]) + '</span>'
        : '';

      var sellerHtml = item.seller
        ? '<span class="disc-dg-seller">' + escapeHtml(item.seller) +
          (item.sellerRating ? ' <span class="disc-dg-rating">' + item.sellerRating.toFixed(1) + '%</span>' : '') +
          '</span>'
        : '';

      var shipsHtml = item.shipsFrom ? '<span class="disc-dg-ships">ships ' + escapeHtml(item.shipsFrom) + '</span>' : '';

      var listingsLabel = item.numListings > 1 ? item.numListings + ' listings' : '1 listing';

      var linkAttr = item.listingUrl ? ' onclick="window.open(\'' + escapeAttr(item.listingUrl) + '\',\'_blank\')"' : '';

      return '<div class="disc-dg-card"' + linkAttr + '>' +
        '<div class="disc-dg-art-wrap">' + artHtml + '</div>' +
        '<div class="disc-dg-body">' +
          '<div class="disc-dg-artist">' + escapeHtml(item.artist) + '</div>' +
          '<div class="disc-dg-title">' + escapeHtml(item.title) + '</div>' +
          '<div class="disc-dg-footer">' +
            priceHtml + condBadge +
          '</div>' +
          '<div class="disc-dg-meta">' +
            sellerHtml + shipsHtml +
            '<span class="disc-dg-count">' + listingsLabel + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('') +
  '</div>';

  return summaryHtml + gridHtml;
}

function renderStoreCard(s) {
  var logo = storeLogoMap[s.store] || '';
  var logoImg = logo
    ? '<img class="disc-card-logo" src="img/' + logo + '" alt="" onerror="this.style.display=\'none\'">'
    : '<div class="disc-card-logo" style="background:#222;border-radius:3px"></div>';

  var costHtml = s.itemsWithPrice > 0
    ? '<div class="disc-cost-records">~$' + s.totalRecordUsd.toFixed(0) + ' records</div>' +
      '<span class="disc-cost-sep">+</span>' +
      '<div class="disc-cost-ship">~$' + s.shippingUsd.toFixed(0) + ' ship</div>' +
      '<div class="disc-cost-total">~$' + (s.totalWithShipping || 0).toFixed(0) + '</div>'
    : '<div class="disc-cost-ship" style="color:#555">' + s.itemCount + ' item' + (s.itemCount !== 1 ? 's' : '') + ' — prices not available</div>';

  var tagHtml = s.topGenres.slice(0,3).map(function(g) {
    return '<span class="disc-tag genre">' + escapeHtml(g) + '</span>';
  }).join('') + s.topStyles.slice(0,5).map(function(st) {
    return '<span class="disc-tag">' + escapeHtml(st) + '</span>';
  }).join('');

  return '<div class="disc-store-card" data-store="' + escapeHtml(s.store) + '">' +
    '<div class="disc-card-header" onclick="toggleDiscoverStore(\'' + escapeAttr(s.store) + '\')">' +
      logoImg +
      '<span class="disc-card-store-name">' + escapeHtml(s.store) + '</span>' +
      '<span class="disc-card-count">' + s.itemCount + ' item' + (s.itemCount !== 1 ? 's' : '') + '</span>' +
      '<span class="disc-card-expand-btn">▾</span>' +
    '</div>' +
    '<div class="disc-card-cost">' + costHtml + '</div>' +
    (tagHtml ? '<div class="disc-card-tags">' + tagHtml + '</div>' : '') +
    '<div class="disc-item-list">' +
      '<div class="disc-item-list-header">' +
        '<span></span><span>Record</span><span style="text-align:right">Store</span><span style="text-align:right">Discogs</span><span></span>' +
      '</div>' +
      renderDiscoverItems(s) +
    '</div>' +
  '</div>';
}

function renderDiscoverItems(s) {
  return s.items.map(function(item) {
    var thumbHtml = item.thumb
      ? '<img class="disc-item-thumb" src="' + escapeHtml(item.thumb) + '" loading="lazy" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
        '<div class="disc-item-thumb-placeholder" style="display:none">♪</div>'
      : '<div class="disc-item-thumb-placeholder">♪</div>';
    var priceHtml = item.priceStr
      ? '<div class="disc-item-price">' + escapeHtml(item.priceStr) + '</div>'
      : '<div class="disc-item-price-na">—</div>';
    var discogsHtml = item.discogsLowest
      ? '<div class="disc-item-discogs-price">$' + item.discogsLowest.toFixed(2) + '</div>' +
        (item.numForSale ? '<div class="disc-item-discogs-forsale">' + item.numForSale + ' for sale</div>' : '')
      : '<div class="disc-item-discogs-forsale" style="color:#444">—</div>';
    var cartKey  = String(item.wantlistId) + ':' + s.store;
    var inCart   = !!_discoverCartSet[cartKey];
    var cartClick = 'toggleCart(' + item.wantlistId + ',\'' + escapeAttr(s.store) + '\',\'' +
      escapeAttr(item.priceStr) + '\',' + (item.priceUsd !== null ? item.priceUsd : 'null') + ')';
    var linkHtml = item.url
      ? '<a class="disc-item-link" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener">View ↗</a>'
      : '';
    var meta = [item.label, item.catno, item.year].filter(Boolean).join(' · ');
    return '<div class="disc-item-row">' +
      '<div>' + thumbHtml + '</div>' +
      '<div class="disc-item-info">' +
        '<div class="disc-item-artist">' + escapeHtml(item.artist || '') + '</div>' +
        '<div class="disc-item-title">'  + escapeHtml(item.title  || '') + '</div>' +
        (meta ? '<div class="disc-item-meta">' + escapeHtml(meta) + '</div>' : '') +
      '</div>' +
      '<div class="disc-item-price-col">' + priceHtml + '</div>' +
      '<div class="disc-item-discogs">'   + discogsHtml + '</div>' +
      '<div class="disc-item-actions">' + linkHtml +
        '<button class="disc-cart-btn' + (inCart ? ' in-cart' : '') + '" data-key="' + escapeAttr(cartKey) + '" onclick="' + cartClick + '">' +
          (inCart ? '✓ In Cart' : '+ Cart') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleDiscoverStore(storeName) {
  var card = document.querySelector('.disc-store-card[data-store="' + CSS.escape(storeName) + '"]');
  if (!card) return;
  var isExpanded = card.classList.contains('expanded');
  document.querySelectorAll('.disc-store-card.expanded').forEach(function(c) { c.classList.remove('expanded'); });
  if (!isExpanded) { card.classList.add('expanded'); _activeDiscoverStore = storeName; }
  else { _activeDiscoverStore = null; }
}

function setDiscoverSort(sort, btn) {
  _discoverSort = sort;
  document.querySelectorAll('.disc-sort-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderInStockBody();
}

function setDiscoverGenre(genre, btn) {
  _discoverGenreFilter = genre;
  document.querySelectorAll('.disc-genre-pill').forEach(function(p) { p.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderForYouTab();
}

function setForYouFilter(filter, btn) {
  _forYouFilter = filter;
  document.querySelectorAll('.disc-filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderForYouTab();
}

function toggleCart(wantlistId, store, priceStr, priceUsd) {
  var username = getCurrentUsername();
  if (!username) return;
  var cartKey = String(wantlistId) + ':' + store;
  var inCart  = !!_discoverCartSet[cartKey];

  if (inCart) {
    // Remove from cart
    fetch('api/cart/' + encodeURIComponent(username) + '/' + wantlistId + '/' + encodeURIComponent(store), {
      method: 'DELETE'
    }).then(function(r) { return r.json(); }).then(function(data) {
      delete _discoverCartSet[cartKey];
      updateCartBadge(data.count || 0);
      updateCartButtons(cartKey, false);
      updateDiscCartRow();
    }).catch(function(e) { console.error('[cart]', e); });
  } else {
    // Add to cart
    fetch('api/cart/' + encodeURIComponent(username), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wantlistId: wantlistId, store: store, price: priceStr, priceUsd: priceUsd })
    }).then(function(r) { return r.json(); }).then(function(data) {
      _discoverCartSet[cartKey] = true;
      updateCartBadge(data.count || 0);
      updateCartButtons(cartKey, true);
      updateDiscCartRow();
    }).catch(function(e) { console.error('[cart]', e); });
  }
}

function updateCartButtons(cartKey, inCart) {
  document.querySelectorAll('[data-key="' + CSS.escape(cartKey) + '"]').forEach(function(btn) {
    btn.textContent = inCart ? '✓ In Cart' : '+ Cart';
    if (inCart) btn.classList.add('in-cart'); else btn.classList.remove('in-cart');
  });
}

function updateDiscCartRow() {
  var count = Object.keys(_discoverCartSet).length;
  var row = document.getElementById('discCartRow');
  if (row) {
    if (count > 0) {
      row.style.display = 'flex';
      document.getElementById('discCartCount').textContent = count + ' item' + (count !== 1 ? 's' : '') + ' in cart';
    } else {
      row.style.display = 'none';
    }
  }
}

function discoverClearCart() {
  var username = getCurrentUsername();
  if (!username) return;
  if (!confirm('Clear your entire cart?')) return;
  fetch('api/cart/' + encodeURIComponent(username), { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function() {
      _discoverCartSet = {};
      updateCartBadge(0);
      updateDiscCartRow();
      // Re-render to reset all cart buttons
      renderDiscover();
    }).catch(function(e) { console.error('[cart clear]', e); });
}

function updateCartBadge(count) {
  var badge = document.getElementById('cartBadge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// Helper: escape for use in HTML attribute onclick= strings
function escapeAttr(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}



// ═══════════════════════════════════════════════════════════════
// PROFILE VIEW
// ═══════════════════════════════════════════════════════════════

var _profileCache = null;
var _profileUsername = null;

function loadProfile() {
  var username = getCurrentUsername();
  if (!username) {
    document.getElementById('profileBody').innerHTML =
      '<div class="prof-empty">Connect your Discogs account to view your profile.</div>';
    return;
  }
  // Serve from cache if same user
  if (_profileCache && _profileUsername === username) {
    renderProfile(_profileCache);
    return;
  }
  document.getElementById('profileBody').innerHTML =
    '<div class="disc-loading" style="display:flex"><div class="disc-spinner"></div>Loading profile…</div>';

  fetch('api/profile/' + encodeURIComponent(username))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _profileCache    = data;
      _profileUsername = username;
      renderProfile(data);
    })
    .catch(function(e) {
      document.getElementById('profileBody').innerHTML =
        '<div class="prof-empty">Error loading profile.</div>';
      console.error('[profile]', e);
    });
}

function renderProfile(p) {
  var memberYear = p.memberSince ? new Date(p.memberSince).getFullYear() : '—';
  var lastScanLabel = p.lastScan ? formatRelativeTime(p.lastScan) : 'Never';
  var inStockPct = p.inStockPct || 0;

  // ── Circular progress SVG ──
  var r = 44, circ = 2 * Math.PI * r;
  var dash = (inStockPct / 100) * circ;
  var ringHtml =
    '<svg class="prof-ring-svg" viewBox="0 0 100 100">' +
      '<circle class="prof-ring-bg" cx="50" cy="50" r="' + r + '"/>' +
      '<circle class="prof-ring-fill" cx="50" cy="50" r="' + r + '" ' +
        'stroke-dasharray="' + dash.toFixed(1) + ' ' + circ.toFixed(1) + '" ' +
        'stroke-dashoffset="0" transform="rotate(-90 50 50)"/>' +
      '<text class="prof-ring-pct" x="50" y="54" text-anchor="middle">' + inStockPct.toFixed(1) + '%</text>' +
      '<text class="prof-ring-label" x="50" y="67" text-anchor="middle">in stock</text>' +
    '</svg>';

  // ── Stat cards ──
  var stats = [
    { label: 'Collection', value: p.collectionSize || 0, sub: 'records owned' },
    { label: 'Wantlist',   value: p.wantlistSize || 0,  sub: '' },
    { label: 'In Stock',   value: p.inStockCount || 0,  sub: p.wantlistSize ? Math.round((p.inStockCount/p.wantlistSize)*100)+'% of wantlist' : '' },
    { label: 'Scans Run',  value: p.totalScans || 0,    sub: p.avgScanMinutes ? 'avg ' + p.avgScanMinutes + 'm' : '' },
  ];
  var statsHtml = stats.map(function(s) {
    return '<div class="prof-stat-card">' +
      '<div class="prof-stat-value">' + s.value.toLocaleString() + '</div>' +
      '<div class="prof-stat-label">' + s.label + '</div>' +
      (s.sub ? '<div class="prof-stat-sub">' + escapeHtml(s.sub) + '</div>' : '') +
    '</div>';
  }).join('');

  // ── isOwnProfile (can navigate to discover) ──
  var isOwn = p.username === getCurrentUsername();

  // ── Taste match (shown on public profiles when logged in) ──
  var tasteMatchHtml = '';
  if (!isOwn && getCurrentUsername()) {
    // Look up from diggers cache (loaded with forUser=currentUser)
    var matchVal = null;
    if (_diggersCache && _diggersCacheUser === getCurrentUsername()) {
      var dEntry = _diggersCache.filter(function(d) { return d.username === p.username; })[0];
      if (dEntry && typeof dEntry.tasteMatch === 'number') matchVal = dEntry.tasteMatch;
    }
    if (matchVal !== null) {
      var mCls = matchVal >= 70 ? 'match-high' : matchVal >= 40 ? 'match-mid' : 'match-low';
      tasteMatchHtml = '<div class="prof-hero-match ' + mCls + '">' +
        '<span class="prof-match-num">' + matchVal + '%</span> taste match with you' +
      '</div>';
    }
  }

  // ── Personality tags ──
  var tagsHtml = '';
  if (p.personalityTags && p.personalityTags.length > 0) {
    var tagPills = p.personalityTags.map(function(t) {
      return '<span class="prof-archetype-tag prof-archetype-' + (t.color||'gold') + '">' +
        (t.icon ? '<span class="prof-archetype-icon">' + t.icon + '</span>' : '') +
        escapeHtml(t.label) +
      '</span>';
    }).join('');
    tagsHtml = '<div class="prof-archetype-row">' + tagPills + '</div>';
  }

  // ── Meta-sync progress bar (own profile only) ──
  var metaSyncHtml = '';
  if (isOwn && typeof p.metaTotal === 'number' && p.metaTotal > 0) {
    var syncPct = Math.round((p.metaSynced / p.metaTotal) * 100);
    var enriched = p.metaSynced + ' / ' + p.metaTotal + ' releases enriched';
    var enrichedSub = p.avgHave ? ' · avg ' + p.avgHave + ' collectors' : '';
    if (p.rarePct !== null && p.rarePct !== undefined) enrichedSub += ' · ' + p.rarePct + '% rare (<200 collectors)';
    metaSyncHtml =
      '<div class="prof-meta-sync-row">' +
        '<div class="prof-meta-sync-label">' +
          '<span>' + enriched + enrichedSub + '</span>' +
          (syncPct < 100
            ? '<button class="prof-meta-sync-btn" onclick="profTriggerMetaSync(\'' + escapeAttr(p.username) + '\')" id="metaSyncBtn">' +
                (syncPct === 0 ? '✨ Enrich Releases' : '↻ Continue Enrichment') +
              '</button>'
            : '<span class="prof-meta-sync-done">✓ Fully enriched</span>') +
        '</div>' +
        '<div class="prof-meta-sync-bar-wrap">' +
          '<div class="prof-meta-sync-bar" style="width:' + syncPct + '%"></div>' +
        '</div>' +
      '</div>';
  }

  // ── Decade distribution mini-chart ──
  var decadeHtml = '';
  if (p.decadeCounts && Object.keys(p.decadeCounts).length > 0) {
    var decadeOrder = ['60s','70s','80s','90s','00s','10s','20s'];
    var maxDecade = Math.max.apply(null, decadeOrder.map(function(d){ return p.decadeCounts[d]||0; }));
    var decadeBars = decadeOrder.filter(function(d){ return p.decadeCounts[d]>0; }).map(function(d) {
      var h = maxDecade > 0 ? Math.round((p.decadeCounts[d]/maxDecade)*48) : 0;
      var isTop = d === p.topDecade;
      return '<div class="prof-decade-col' + (isTop ? ' top' : '') + '">' +
        '<div class="prof-decade-bar" style="height:' + h + 'px"></div>' +
        '<div class="prof-decade-label">' + d + '</div>' +
      '</div>';
    }).join('');
    decadeHtml = '<div class="prof-section prof-decade-section">' +
      '<div class="prof-section-title">Era Profile</div>' +
      '<div class="prof-decade-chart">' + decadeBars + '</div>' +
    '</div>';
  }

  // ── Taste DNA: genres (clickable if own profile) ──
  var maxGenreCount = p.topGenres.length > 0 ? p.topGenres[0].count : 1;
  var genreHtml = p.topGenres.map(function(g) {
    var pct = Math.round((g.count / maxGenreCount) * 100);
    var rowClick = isOwn ? ' onclick="profGoToGenre(\'' + escapeAttr(g.name) + '\')" title="See ' + escapeAttr(g.name) + ' in For You →" style="cursor:pointer"' : '';
    return '<div class="prof-dna-row' + (isOwn ? ' prof-dna-link' : '') + '"' + rowClick + '>' +
      '<span class="prof-dna-name">' + escapeHtml(g.name) + '</span>' +
      '<div class="prof-dna-bar-wrap"><div class="prof-dna-bar" style="width:' + pct + '%"></div></div>' +
      '<span class="prof-dna-count">' + g.count + '</span>' +
      (isOwn ? '<span class="prof-dna-arrow">→</span>' : '') +
    '</div>';
  }).join('');

  // ── Taste DNA: styles (pill cloud, clickable) ──
  var maxStyleCount = p.topStyles.length > 0 ? p.topStyles[0].count : 1;
  var styleHtml = p.topStyles.map(function(s) {
    var sz = 10 + Math.round((s.count / maxStyleCount) * 8);
    var pillClick = isOwn ? ' onclick="profGoToGenre(\'' + escapeAttr(s.name) + '\')" title="See ' + escapeAttr(s.name) + ' in For You →"' : '';
    return '<span class="prof-style-pill' + (isOwn ? ' prof-style-link' : '') + '" style="font-size:' + sz + 'px"' + pillClick + '>' +
      escapeHtml(s.name) + ' <span class="prof-style-count">' + s.count + '</span>' +
    '</span>';
  }).join('');

  // ── Store breakdown (clickable → In Stock filtered) ──
  var maxStoreCount = p.storeBreakdown.length > 0 ? p.storeBreakdown[0].count : 1;
  var storeHtml = p.storeBreakdown.length > 0
    ? p.storeBreakdown.map(function(s) {
        var cls = storeClassMap[s.store] || '';
        var pct = Math.round((s.count / maxStoreCount) * 100);
        var rowClick = isOwn ? ' onclick="profGoToStore(\'' + escapeAttr(s.store) + '\')" title="See ' + escapeAttr(storeDisplayName[s.store]||s.store) + ' in In Stock →" style="cursor:pointer"' : '';
        return '<div class="prof-store-row' + (isOwn ? ' prof-dna-link' : '') + '"' + rowClick + '>' +
          '<span class="prof-store-name ' + cls + '">' + escapeHtml(storeDisplayName[s.store] || s.store) + '</span>' +
          '<div class="prof-store-bar-wrap"><div class="prof-store-bar ' + cls + '" style="width:' + pct + '%"></div></div>' +
          '<span class="prof-store-count">' + s.count + ' item' + (s.count !== 1 ? 's' : '') + '</span>' +
          (isOwn ? '<span class="prof-dna-arrow">→</span>' : '') +
        '</div>';
      }).join('')
    : '<div class="prof-empty-small">No in-stock data yet — run a scan first.</div>';

  // ── Scan history ──
  var scanHistHtml = p.recentScans.length > 0
    ? '<div class="prof-scan-list">' + p.recentScans.map(function(sr) {
        var label = { full: 'Full', force: 'Force', daily: 'Daily', background: 'BG' }[sr.run_type] || sr.run_type;
        var dur   = sr.duration_ms ? (sr.duration_ms / 60000).toFixed(1) + 'm' : '—';
        var errCls = sr.error ? ' prof-scan-err' : (sr.items_error > 0 ? ' prof-scan-warn' : '');
        var dateStr = sr.started_at ? new Date(sr.started_at).toLocaleDateString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
        return '<div class="prof-scan-row' + errCls + '">' +
          '<span class="prof-scan-type">' + label + '</span>' +
          '<span class="prof-scan-date">' + dateStr + '</span>' +
          '<span class="prof-scan-items">' + (sr.items_checked || 0) + ' checked</span>' +
          '<span class="prof-scan-stock">' + (sr.items_in_stock || 0) + ' in stock</span>' +
          '<span class="prof-scan-dur">' + dur + '</span>' +
          (sr.items_error > 0 ? '<span class="prof-scan-errs">' + sr.items_error + ' err</span>' : '<span></span>') +
        '</div>';
      }).join('') + '</div>'
    : '<div class="prof-empty-small">No completed scans yet.</div>';

  // ── Recent finds ──
  var findsHtml = p.recentFinds.length > 0
    ? '<div class="prof-finds-grid">' + p.recentFinds.map(function(f) {
        var artHtml = f.thumb
          ? '<img class="prof-find-art" src="' + escapeHtml(f.thumb) + '" loading="lazy" alt="" onerror="this.style.display=\'none\'">'
          : '<div class="prof-find-art-ph">♪</div>';
        var storeCls = storeClassMap[f.store] || '';
        var linkAttr = f.url ? ' onclick="window.open(\'' + escapeAttr(f.url) + '\',\'_blank\')"' : '';
        var ageLabel = f.foundAt ? formatRelativeTime(f.foundAt) : '';
        return '<div class="prof-find-card"' + linkAttr + '>' +
          artHtml +
          '<div class="prof-find-body">' +
            '<div class="prof-find-artist">' + escapeHtml(f.artist || '') + '</div>' +
            '<div class="prof-find-title">'  + escapeHtml(f.title  || '') + '</div>' +
            '<div class="prof-find-meta">' +
              '<span class="prof-find-store ' + storeCls + '">' + escapeHtml(storeDisplayName[f.store] || f.store) + '</span>' +
              (f.price ? '<span class="prof-find-price">' + escapeHtml(f.price) + '</span>' : '') +
              (ageLabel ? '<span class="prof-find-age">' + escapeHtml(ageLabel) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>'
    : '<div class="prof-empty-small">No recent finds — check back after your next scan.</div>';

  // ── Full layout ──
  document.getElementById('profileBody').innerHTML =
    // Hero
    '<div class="prof-hero">' +
      '<div class="prof-ring">' + ringHtml + '</div>' +
      '<div class="prof-hero-info">' +
        '<div class="prof-username-row">' +
          '<div class="prof-username">' + escapeHtml(p.username) + '</div>' +
          tasteMatchHtml +
        '</div>' +
        (tagsHtml) +
        '<div class="prof-meta-row">' +
          '<span class="prof-meta-item">🎵 Digger since ' + memberYear + '</span>' +
          '<span class="prof-meta-item">⏱ Last scan ' + lastScanLabel + '</span>' +
          (p.discogsCount > 0 ? '<span class="prof-meta-item">💿 ' + p.discogsCount + ' Discogs prices synced</span>' : '') +
        '</div>' +
        metaSyncHtml +
        '<div class="prof-stat-row">' + statsHtml + '</div>' +
      '</div>' +
      '<div class="prof-hero-btns">' +
        '<button class="prof-share-btn" onclick="profShareProfile(\'' + escapeAttr(p.username) + '\')" title="Copy shareable link">Share ↗</button>' +
        (isOwn ? '<button class="prof-refresh-btn" onclick="_profileCache=null;loadProfile()" title="Refresh">↻</button>' : '') +
      '</div>' +
    '</div>' +

    // Decade chart (full width, below hero)
    decadeHtml +

    // Two-column body
    '<div class="prof-body">' +

      // Left column
      '<div class="prof-col">' +
        '<div class="prof-section">' +
          '<div class="prof-section-title">Taste DNA — Genres</div>' +
          (genreHtml || '<div class="prof-empty-small">Run a scan to build your taste profile.</div>') +
        '</div>' +
        '<div class="prof-section">' +
          '<div class="prof-section-title">Style Cloud</div>' +
          '<div class="prof-style-cloud">' + (styleHtml || '<div class="prof-empty-small">—</div>') + '</div>' +
        '</div>' +
        '<div class="prof-section">' +
          '<div class="prof-section-title">Stores with your records</div>' +
          storeHtml +
        '</div>' +
      '</div>' +

      // Right column
      '<div class="prof-col">' +
        '<div class="prof-section">' +
          '<div class="prof-section-title">Recent finds <span class="prof-section-sub">last 30 days</span></div>' +
          findsHtml +
        '</div>' +
        '<div class="prof-section">' +
          '<div class="prof-section-title">Scan history</div>' +
          scanHistHtml +
        '</div>' +
      '</div>' +

    '</div>' +

    // Diggers panel — full width below the columns
    '<div class="prof-diggers-section">' +
      '<div class="prof-section-title">Other Diggers <span class="prof-section-sub">click to view their profile</span></div>' +
      '<div id="diggersGrid" class="prof-diggers-grid">Loading…</div>' +
    '</div>';

  // Load diggers async
  _loadDiggers(p.username);
}

var _diggersCache     = null;
var _diggersCacheUser = null; // which user's taste-match is baked in

function _loadDiggers(currentUser) {
  // Use cache only if the forUser matches (taste-match is per-user)
  if (_diggersCache && _diggersCacheUser === (currentUser || null)) {
    _renderDiggers(_diggersCache, currentUser);
    return;
  }
  var url = 'api/diggers';
  if (currentUser) url += '?forUser=' + encodeURIComponent(currentUser);
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _diggersCache     = data;
      _diggersCacheUser = currentUser || null;
      _renderDiggers(data, currentUser);
    })
    .catch(function() {
      var el = document.getElementById('diggersGrid');
      if (el) el.innerHTML = '<span class="prof-empty-small">Could not load diggers.</span>';
    });
}

function _renderDiggers(diggers, currentUser) {
  var el = document.getElementById('diggersGrid');
  if (!el) return;
  var others = diggers.filter(function(d) { return d.username !== currentUser; });
  if (others.length === 0) { el.innerHTML = '<span class="prof-empty-small">No other diggers yet.</span>'; return; }
  el.innerHTML = others.map(function(d) {
    var pct = d.inStockPct || 0;
    var ageLabel = d.lastScan ? formatRelativeTime(d.lastScan) : 'Never';
    var genreHtml = d.topGenres.slice(0,3).map(function(g) {
      return '<span class="prof-digger-genre">' + escapeHtml(g) + '</span>';
    }).join('');
    // Taste match badge (shown when computed)
    var matchHtml = '';
    if (typeof d.tasteMatch === 'number') {
      var matchCls = d.tasteMatch >= 70 ? 'match-high' : d.tasteMatch >= 40 ? 'match-mid' : 'match-low';
      matchHtml = '<div class="prof-taste-badge ' + matchCls + '">' + d.tasteMatch + '<span class="prof-taste-pct-sym">%</span><span class="prof-taste-label">match</span></div>';
    }
    return '<div class="prof-digger-card" onclick="profLoadPublic(\'' + escapeAttr(d.username) + '\')">' +
      '<div class="prof-digger-avatar">' + escapeHtml(d.username.charAt(0).toUpperCase()) + '</div>' +
      '<div class="prof-digger-info">' +
        '<div class="prof-digger-name">' + escapeHtml(d.username) + '</div>' +
        '<div class="prof-digger-stats">' +
          '<span class="prof-digger-stat">' + d.wantlist + ' want</span>' +
          '<span class="prof-digger-dot">·</span>' +
          '<span class="prof-digger-stat gold">' + d.inStock + ' in stock</span>' +
          '<span class="prof-digger-dot">·</span>' +
          '<span class="prof-digger-stat dim">' + ageLabel + '</span>' +
        '</div>' +
        (genreHtml ? '<div class="prof-digger-genres">' + genreHtml + '</div>' : '') +
      '</div>' +
      matchHtml +
      '<div class="prof-digger-pct">' + pct.toFixed(1) + '%</div>' +
    '</div>';
  }).join('');
}

// ─── Profile cross-navigation helpers ────────────────────────────────────────

// Pending navigation applied after discover data loads
var _pendingDiscoverNav = null;

function profGoToGenre(genre) {
  _pendingDiscoverNav = { tab: 'forYou', genre: genre };
  switchView('discover', document.querySelector('.nav-link[data-view="discover"]'));
}

function profGoToStore(store) {
  _pendingDiscoverNav = { tab: 'inStock', store: store };
  switchView('discover', document.querySelector('.nav-link[data-view="discover"]'));
}

function profTriggerMetaSync(username) {
  var btn = document.getElementById('metaSyncBtn');
  if (btn) { btn.textContent = '⏳ Starting…'; btn.disabled = true; }
  fetch('api/meta-sync/' + encodeURIComponent(username) + '?trigger=1')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (btn) {
        if (d.running) {
          btn.textContent = '⏳ Enriching… (' + d.pct + '%)';
          // Poll every 15s
          var poll = setInterval(function() {
            fetch('api/meta-sync/' + encodeURIComponent(username))
              .then(function(r){ return r.json(); })
              .then(function(s) {
                if (btn) btn.textContent = '⏳ Enriching… (' + s.pct + '%)';
                if (!s.running) {
                  clearInterval(poll);
                  _profileCache = null;
                  loadProfile();
                }
              }).catch(function() { clearInterval(poll); });
          }, 15000);
        } else {
          btn.textContent = '✓ Done';
          setTimeout(function() { _profileCache = null; loadProfile(); }, 1000);
        }
      }
    })
    .catch(function() { if (btn) { btn.textContent = '✨ Enrich Releases'; btn.disabled = false; } });
}

function profShareProfile(username) {
  var url = window.location.origin + window.location.pathname + '?view=profile&user=' + encodeURIComponent(username);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function() {
      var btn = document.querySelector('.prof-share-btn');
      if (btn) { var orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = orig; }, 1800); }
    });
  } else {
    window.prompt('Copy this link:', url);
  }
}

function profLoadPublic(username, opts) {
  opts = opts || {};
  // Load another user's profile (read-only view)
  _profileCache    = null;
  _profileUsername = username;
  // Push URL first (unless restoring from popstate)
  if (!opts.noPush) {
    var loggedIn = getCurrentUsername() || '';
    var isOwn = (username === loggedIn);
    var url = buildViewUrl('profile', isOwn ? null : username);
    history.pushState({ view: 'profile', profileUser: isOwn ? null : username }, '', url);
  }
  // Switch to profile view (no push, no auto-load — we load below)
  switchView('profile', document.querySelector('.nav-link[data-view="profile"]'), { noPush: true, noLoad: true });
  document.getElementById('profileBody').innerHTML =
    '<div class="disc-loading" style="display:flex"><div class="disc-spinner"></div>Loading profile…</div>';
  fetch('api/profile/' + encodeURIComponent(username))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _profileCache = data;
      renderProfile(data);
    })
    .catch(function() {
      document.getElementById('profileBody').innerHTML = '<div class="prof-empty">Profile not found.</div>';
    });
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return '';
  var ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return 'just now';
  var min = Math.floor(ms / 60000);
  if (min < 1)   return 'just now';
  if (min < 60)  return min + 'm ago';
  var hr = Math.floor(min / 60);
  if (hr < 24)   return hr + 'h ago';
  var d = Math.floor(hr / 24);
  if (d < 30)    return d + 'd ago';
  return Math.floor(d / 30) + 'mo ago';
}

// ═══════════════════════════════════════════════════════════════════════════
// GOLDIE CHAT
// ═══════════════════════════════════════════════════════════════════════════

var _goldieSessionId = null;
var _goldieOpen = false;
var _goldieStreaming = false;

function goldieToggle() {
  _goldieOpen = !_goldieOpen;
  var panel = document.getElementById('goldiePanel');
  var btn   = document.getElementById('goldieNavBtn');
  if (panel) panel.style.display = _goldieOpen ? 'flex' : 'none';
  if (btn)   btn.classList.toggle('active', _goldieOpen);
  if (_goldieOpen) {
    var input = document.getElementById('goldieInput');
    if (input) input.focus();
  }
}

function goldieNewChat() {
  _goldieSessionId = null;
  var msgs = document.getElementById('goldieMessages');
  if (msgs) msgs.innerHTML =
    '<div class="goldie-welcome">' +
      '<div class="goldie-welcome-icon">✦</div>' +
      '<div class="goldie-welcome-text"><strong>New conversation started.</strong><br>What do you want to know?</div>' +
      '<div class="goldie-starters">' +
        '<button onclick="goldieSend(\'What\\\'s in stock for me right now?\')">What\'s in stock?</button>' +
        '<button onclick="goldieSend(\'Suggest a cart for this month\')">Suggest a cart</button>' +
        '<button onclick="goldieSend(\'What are my rarest in-stock finds?\')">Rarest finds</button>' +
        '<button onclick="goldieSend(\'Explain my taste profile\')">My taste profile</button>' +
      '</div>' +
    '</div>';
}

function goldieSendFromInput() {
  var input = document.getElementById('goldieInput');
  if (!input) return;
  var msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = '';
  goldieSend(msg);
}

function goldieSend(message) {
  if (_goldieStreaming) return;
  if (!message) return;

  var msgs = document.getElementById('goldieMessages');
  if (!msgs) return;

  // Remove welcome block on first real message
  var welcome = msgs.querySelector('.goldie-welcome');
  if (welcome) welcome.remove();

  // Append user bubble
  var userBubble = document.createElement('div');
  userBubble.className = 'goldie-msg goldie-msg-user';
  userBubble.textContent = message;
  msgs.appendChild(userBubble);

  // Create assistant bubble (will stream into it)
  var asstBubble = document.createElement('div');
  asstBubble.className = 'goldie-msg goldie-msg-asst';
  asstBubble.innerHTML = '<span class="goldie-thinking">✦ thinking…</span>';
  msgs.appendChild(asstBubble);
  msgs.scrollTop = msgs.scrollHeight;

  _goldieStreaming = true;
  var sendBtn = document.getElementById('goldieSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  var username = getCurrentUsername() || '';
  var body = JSON.stringify({ sessionId: _goldieSessionId, username: username, message: message });

  fetch('api/goldie/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body
  }).then(function(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var textSoFar = '';
    var thinkingRemoved = false;

    function read() {
      reader.read().then(function(result) {
        if (result.done) {
          _goldieStreaming = false;
          if (sendBtn) sendBtn.disabled = false;
          msgs.scrollTop = msgs.scrollHeight;
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(function(line) {
          if (!line.startsWith('data:')) return;
          var json = line.slice(5).trim();
          if (!json) return;
          try {
            var ev = JSON.parse(json);
            if (ev.type === 'session') { _goldieSessionId = ev.sessionId; }
            else if (ev.type === 'text') {
              if (!thinkingRemoved) {
                asstBubble.innerHTML = '';
                thinkingRemoved = true;
              }
              textSoFar += ev.text;
              asstBubble.innerHTML = goldieFormatText(textSoFar);
              msgs.scrollTop = msgs.scrollHeight;
            } else if (ev.type === 'tool_call') {
              if (!thinkingRemoved) {
                asstBubble.innerHTML = '';
                thinkingRemoved = true;
              }
              // Show tool call indicator
              var tc = document.createElement('div');
              tc.className = 'goldie-tool-call';
              tc.innerHTML = '<span class="goldie-tool-icon">⚙</span> ' + escapeHtml(ev.name.replace(/_/g,' '));
              tc.id = 'goldie-tc-' + ev.name;
              asstBubble.appendChild(tc);
              msgs.scrollTop = msgs.scrollHeight;
            } else if (ev.type === 'tool_result') {
              var tcEl = document.getElementById('goldie-tc-' + ev.name);
              if (tcEl) tcEl.classList.add('done');
            } else if (ev.type === 'done') {
              _goldieStreaming = false;
              if (sendBtn) sendBtn.disabled = false;
            } else if (ev.type === 'error') {
              asstBubble.innerHTML = '<span class="goldie-error">Error: ' + escapeHtml(ev.message) + '</span>';
              _goldieStreaming = false;
              if (sendBtn) sendBtn.disabled = false;
            }
          } catch(e) {}
        });
        read();
      }).catch(function() {
        _goldieStreaming = false;
        if (sendBtn) sendBtn.disabled = false;
      });
    }
    read();
  }).catch(function(e) {
    asstBubble.innerHTML = '<span class="goldie-error">Could not reach GOLDIE. Is it running?</span>';
    _goldieStreaming = false;
    if (sendBtn) sendBtn.disabled = false;
  });
}

function goldieFormatText(text) {
  // Minimal markdown: bold, bullets, line breaks
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// Auto-resize textarea
document.addEventListener('DOMContentLoaded', function() {
  var inp = document.getElementById('goldieInput');
  if (inp) inp.addEventListener('input', function() {
    this.style.height = '';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });
});
