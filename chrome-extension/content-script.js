'use strict';

// Tell the page the extension is installed
window.dispatchEvent(new CustomEvent('golddigger:ready'));

// Relay storage → page (sync progress updates)
chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.syncState) {
        window.dispatchEvent(new CustomEvent('golddigger:syncstate', {
            detail: changes.syncState.newValue
        }));
    }
});

// Send current state to page on load (in case sync is already running / completed)
chrome.storage.local.get(['syncState', 'serverUrl', 'username'], function (data) {
    if (data.syncState) {
        window.dispatchEvent(new CustomEvent('golddigger:syncstate', { detail: data.syncState }));
    }
});

// Listen for sync trigger from the page
window.addEventListener('golddigger:startsync', function (e) {
    var detail = e.detail || {};
    chrome.storage.local.set({
        serverUrl: detail.serverUrl,
        username:  detail.username,
        syncState: { running: true, startedAt: Date.now(), done: 0, total: 0, found: 0 }
    }, function () {
        chrome.runtime.sendMessage({ action: 'openSyncWindow' });
    });
});
