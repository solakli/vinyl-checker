'use strict';
/**
 * Stock-alert email digest.
 *
 * After the daily rescan, users who opted in get one email listing the
 * records that came in stock or dropped in price since their last alert.
 * Dedupe is via scan_changes.alerted_at — a change is only ever emailed once.
 *
 * Sends through Resend's REST API (plain HTTPS, no SDK). Disabled unless
 * RESEND_API_KEY is set in the environment, so dev machines and forks
 * never accidentally email anyone.
 */

var https = require('https');
var db = require('../db');

var FROM_ADDRESS = process.env.ALERT_FROM_EMAIL || 'Wax Digger <alerts@waxdigger.ai>';
var APP_URL = 'https://waxdigger.ai/';

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseNewValue(raw) {
    try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

function buildDigestHtml(username, changes) {
    var rows = changes.map(function (c) {
        var nv = parseNewValue(c.new_value);
        var isRestock = c.change_type === 'now_in_stock';
        var badge = isRestock
            ? '<span style="color:#3fb96d;font-weight:600">Back in stock</span>'
            : '<span style="color:#c8a44a;font-weight:600">Price drop</span>';
        var price = nv.price ? ' — ' + escapeHtml(nv.price) : '';
        var link = nv.url || (APP_URL);
        return '<tr>' +
            '<td style="padding:10px 14px;border-bottom:1px solid #222">' +
              '<div style="font-size:15px;color:#e8e8e8;font-weight:600">' + escapeHtml(c.artist) + '</div>' +
              '<div style="font-size:13px;color:#9a9a9a">' + escapeHtml(c.title) + '</div>' +
            '</td>' +
            '<td style="padding:10px 14px;border-bottom:1px solid #222;font-size:13px;color:#bbb">' + escapeHtml(c.store || '') + '</td>' +
            '<td style="padding:10px 14px;border-bottom:1px solid #222;font-size:13px">' + badge + price + '</td>' +
            '<td style="padding:10px 14px;border-bottom:1px solid #222"><a href="' + escapeHtml(link) + '" style="color:#a8b8c8;font-size:13px">View →</a></td>' +
        '</tr>';
    }).join('');

    return '<div style="background:#0c0c0c;padding:32px 16px;font-family:Helvetica,Arial,sans-serif">' +
      '<div style="max-width:600px;margin:0 auto">' +
        '<div style="font-size:22px;font-weight:700;letter-spacing:3px;color:#e8e8e8;margin-bottom:4px"><span style="color:#a8b8c8">WAX</span> DIGGER</div>' +
        '<div style="font-size:14px;color:#9a9a9a;margin-bottom:24px">' + changes.length + (changes.length === 1 ? ' record' : ' records') + ' from your wantlist ' + (changes.length === 1 ? 'is' : 'are') + ' worth a look, ' + escapeHtml(username) + ':</div>' +
        '<table style="width:100%;border-collapse:collapse;background:#141414;border-radius:8px;overflow:hidden">' + rows + '</table>' +
        '<div style="margin-top:24px"><a href="' + APP_URL + '" style="display:inline-block;background:#a8b8c8;color:#0c0c0c;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;text-decoration:none">Open Wax Digger</a></div>' +
        '<div style="margin-top:28px;font-size:11px;color:#666">You get these because stock alerts are on in your Wax Digger profile. Turn them off any time in Profile → Stock Alerts.</div>' +
      '</div>' +
    '</div>';
}

function sendViaResend(apiKey, to, subject, html) {
    return new Promise(function (resolve, reject) {
        var body = JSON.stringify({ from: FROM_ADDRESS, to: [to], subject: subject, html: html });
        var req = https.request({
            hostname: 'api.resend.com',
            path: '/emails',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 15000
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data || '{}'));
                else reject(new Error('Resend HTTP ' + res.statusCode + ': ' + data.substring(0, 200)));
            });
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('Resend request timeout')); });
        req.write(body);
        req.end();
    });
}

/**
 * Send the digest to every opted-in user with pending changes.
 * Safe to call repeatedly — already-alerted changes are skipped.
 */
async function sendStockAlerts() {
    var apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.log('[email-alerts] RESEND_API_KEY not set — skipping');
        return { sent: 0, skipped: 'no_api_key' };
    }

    var subscribers = db.getAlertSubscribers();
    if (!subscribers.length) {
        console.log('[email-alerts] No subscribers');
        return { sent: 0 };
    }

    var sent = 0, errors = 0;
    for (var i = 0; i < subscribers.length; i++) {
        var sub = subscribers[i];
        try {
            var changes = db.getUnalertedChanges(sub.user_id, 30);
            if (!changes.length) continue;

            var restocks = changes.filter(function (c) { return c.change_type === 'now_in_stock'; }).length;
            var subject = restocks > 0
                ? restocks + (restocks === 1 ? ' record from your wantlist is back in stock' : ' records from your wantlist are back in stock')
                : changes.length + ' price drop' + (changes.length === 1 ? '' : 's') + ' on your wantlist';

            await sendViaResend(apiKey, sub.email, subject, buildDigestHtml(sub.username, changes));
            db.markChangesAlerted(changes.map(function (c) { return c.id; }));
            sent++;
            console.log('[email-alerts] Sent digest to ' + sub.username + ' (' + changes.length + ' changes)');
        } catch (e) {
            errors++;
            console.error('[email-alerts] Failed for ' + sub.username + ':', e.message);
        }
    }
    console.log('[email-alerts] Done — ' + sent + ' sent, ' + errors + ' errors');
    return { sent: sent, errors: errors };
}

module.exports = { sendStockAlerts: sendStockAlerts };
