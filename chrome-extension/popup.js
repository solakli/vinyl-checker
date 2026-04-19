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

var pollInterval = null;

// ── Load saved settings ───────────────────────────────────────
chrome.storage.local.get(['serverUrl', 'username', 'lastSynced'], function (data) {
    if (data.serverUrl) serverUrlInput.value = data.serverUrl;
    if (data.username)  usernameInput.value  = data.username;
    if (data.lastSynced) {
        lastSyncedEl.textContent = 'Last synced: ' + new Date(data.lastSynced).toLocaleString();
    }
    updateOpenBtn();
});

serverUrlInput.addEventListener('change', save);
usernameInput.addEventListener('change', save);

function save() {
    chrome.storage.local.set({
        serverUrl: serverUrlInput.value.trim().replace(/\/$/, ''),
        username:  usernameInput.value.trim()
    });
    updateOpenBtn();
}

function updateOpenBtn() {
    var url = serverUrlInput.value.trim().replace(/\/$/, '');
    openAppBtn.onclick = function () { chrome.tabs.create({ url: url || 'https://stream.ronautradio.la/vinyl' }); };
}

// ── Sync button ───────────────────────────────────────────────
syncBtn.addEventListener('click', async function () {
    var server   = serverUrlInput.value.trim().replace(/\/$/, '');
    var username = usernameInput.value.trim();

    if (!server || !username) {
        showStatus('Please fill in server URL and username.', 'error');
        return;
    }

    save();
    syncBtn.disabled = true;
    statusEl.style.display = 'none';
    progressWrap.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'Starting sync...';

    try {
        var res = await fetch(server + '/api/marketplace-sync/' + encodeURIComponent(username), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        var data = await res.json();

        if (!res.ok || data.error) {
            throw new Error(data.error || 'Server error');
        }

        if (!data.started) {
            showStatus(data.message || 'Sync already running.', 'info');
            syncBtn.disabled = false;
            startPolling(server, username);
            return;
        }

        progressText.textContent = '0 / ' + data.total + ' releases';
        startPolling(server, username);

    } catch (e) {
        showStatus('Error: ' + e.message, 'error');
        syncBtn.disabled = false;
        progressWrap.style.display = 'none';
    }
});

function startPolling(server, username) {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async function () {
        try {
            var res  = await fetch(server + '/api/marketplace-sync/' + encodeURIComponent(username) + '/status');
            var data = await res.json();

            var pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
            progressFill.style.width = pct + '%';
            progressText.textContent = data.done + ' / ' + data.total + ' releases';

            if (!data.running) {
                clearInterval(pollInterval);
                pollInterval = null;
                syncBtn.disabled = false;

                if (data.error) {
                    showStatus('Sync failed: ' + data.error, 'error');
                } else {
                    var now = Date.now();
                    chrome.storage.local.set({ lastSynced: now });
                    lastSyncedEl.textContent = 'Last synced: ' + new Date(now).toLocaleString();
                    showStatus('Sync complete! ' + data.done + ' releases fetched.', 'success');
                    progressFill.style.width = '100%';
                }
            }
        } catch (e) {
            // Network blip — keep polling
        }
    }, 2000);
}

function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className   = 'status ' + type;
    statusEl.style.display = 'block';
}
