'use strict';

var serverUrlInput = document.getElementById('serverUrl');
var usernameInput  = document.getElementById('username');
var syncBtn        = document.getElementById('syncBtn');
var progressWrap   = document.getElementById('progressWrap');
var progressFill   = document.getElementById('progressFill');
var progressText   = document.getElementById('progressText');
var statusEl       = document.getElementById('status');
var lastSyncedEl   = document.getElementById('lastSynced');
var openAppBtn     = document.getElementById('openApp');

var pollTimer = null;

// ── Load saved settings ───────────────────────────────────────────────────────
chrome.storage.local.get(['serverUrl', 'username', 'syncState', 'lastSynced'], function (data) {
    if (data.serverUrl) serverUrlInput.value = data.serverUrl;
    if (data.username)  usernameInput.value  = data.username;
    updateOpenBtn();

    if (data.lastSynced) {
        lastSyncedEl.textContent = 'Last synced: ' + new Date(data.lastSynced).toLocaleString();
    }

    var state = data.syncState;
    if (!state) return;

    // Detect stale "running" state — if it's been > 3 min with no progress, clear it
    if (state.running) {
        var age = Date.now() - (state.startedAt || 0);
        var stale = age > 3 * 60 * 1000 && state.done === 0;
        if (stale) {
            chrome.storage.local.set({ syncState: null });
            return; // show fresh UI
        }
        setSyncing(true);
        startPolling();
    } else if (state.completedAt) {
        showDone(state);
    }
});

serverUrlInput.addEventListener('input', save);
usernameInput.addEventListener('input', save);

function save() {
    chrome.storage.local.set({
        serverUrl: serverUrlInput.value.trim().replace(/\/$/, ''),
        username:  usernameInput.value.trim()
    });
    updateOpenBtn();
}

function updateOpenBtn() {
    var url = serverUrlInput.value.trim().replace(/\/$/, '');
    openAppBtn.onclick = function () {
        chrome.tabs.create({ url: url || 'https://stream.ronautradio.la/vinyl' });
    };
}

// ── Sync button ───────────────────────────────────────────────────────────────
syncBtn.addEventListener('click', function () {
    var server   = serverUrlInput.value.trim().replace(/\/$/, '');
    var username = usernameInput.value.trim();
    if (!server || !username) { showStatus('Fill in server URL and username.', 'error'); return; }

    // Clear stale state
    chrome.storage.local.set({ syncState: { running: true, startedAt: Date.now(), done: 0, total: 0, found: 0 } });
    statusEl.style.display = 'none';
    save();

    // Open dedicated sync window (stays alive when popup closes)
    chrome.windows.create({
        url: chrome.runtime.getURL('sync-window.html'),
        type: 'popup',
        width: 380,
        height: 220,
        focused: true
    });

    window.close(); // close the popup — sync window takes over
});

// ── Polling (shown when sync window is open and running) ──────────────────────
function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
        chrome.storage.local.get('syncState', function (data) {
            var state = data.syncState;
            if (!state) return;

            var pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
            progressFill.style.width = pct + '%';
            progressText.textContent = state.done + ' / ' + state.total +
                ' releases · ' + (state.found || 0) + ' listings found';

            if (!state.running) {
                clearInterval(pollTimer);
                pollTimer = null;
                setSyncing(false);
                if (state.error) {
                    showStatus('Error: ' + state.error, 'error');
                } else {
                    showDone(state);
                }
            }
        });
    }, 1000);
}

function setSyncing(on) {
    syncBtn.disabled           = on;
    syncBtn.textContent        = on ? 'Syncing...' : '⛏ Sync & Build Cart';
    progressWrap.style.display = on ? 'block' : 'none';
    if (on) progressFill.style.width = '0%';
}

function showDone(state) {
    progressWrap.style.display = 'block';
    progressFill.style.width   = '100%';
    progressText.textContent   = state.done + ' releases · ' + (state.found || 0) + ' listings synced';
    showStatus('✓ Done! Open Gold Digger to run the optimizer.', 'success');
    var ts = state.completedAt ? new Date(state.completedAt).toLocaleString() : '';
    if (ts) lastSyncedEl.textContent = 'Last synced: ' + ts;
    chrome.storage.local.set({ lastSynced: state.completedAt });
}

function showStatus(msg, type) {
    statusEl.textContent   = msg;
    statusEl.className     = 'status ' + type;
    statusEl.style.display = 'block';
}
