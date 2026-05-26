'use strict';

/**
 * Health Monitor
 *
 * Runs lightweight checks every few minutes and self-heals where possible.
 * Nothing here should throw — all checks are wrapped and failures logged.
 *
 * Checks:
 *   1. Pipeline stall    — no job completed in >30 min → re-seed all users
 *   2. Chrome lock       — held >90 min → force-release (scanner hard-limit is 4h)
 *   3. Site self-check   — HTTP GET /api/health every 10 min → log if fails
 *   4. Stale wantlists   — any user not synced in >6 h → warn + re-enqueue
 *   5. Rolling scan      — not run in >5 h → warn
 *   6. Memory            — heap > 500 MB → warn
 *   7. YouTube quota     — pipeline_events table: quota_exhausted in last 24h
 */

const http  = require('http');
const db    = require('../db');

// ── State ─────────────────────────────────────────────────────────────────────
var state = {
    startedAt:          new Date().toISOString(),
    lastCheckAt:        null,
    checks: {
        pipeline:       { status: 'unknown', lastOk: null, detail: null },
        chromeLock:     { status: 'unknown', lastOk: null, detail: null },
        selfCheck:      { status: 'unknown', lastOk: null, detail: null },
        staleWantlists: { status: 'unknown', lastOk: null, detail: null },
        rollingScna:    { status: 'unknown', lastOk: null, detail: null },
        memory:         { status: 'unknown', lastOk: null, detail: null },
        ytQuota:        { status: 'unknown', lastOk: null, detail: null },
    },
    healActions: [],   // last 20 self-heal actions taken
};

function recordHeal(action) {
    state.healActions.unshift({ action, at: new Date().toISOString() });
    if (state.healActions.length > 20) state.healActions.length = 20;
    console.log('[health] 🔧 Self-heal:', action);
}

function ok(key, detail) {
    state.checks[key] = { status: 'ok', lastOk: new Date().toISOString(), detail: detail || null };
}
function warn(key, detail) {
    state.checks[key] = { status: 'warn', lastOk: state.checks[key] && state.checks[key].lastOk, detail };
    console.warn('[health] ⚠️', key + ':', detail);
}
function fail(key, detail) {
    state.checks[key] = { status: 'fail', lastOk: state.checks[key] && state.checks[key].lastOk, detail };
    console.error('[health] 🔴', key + ':', detail);
}

// ── 1. Pipeline stall ─────────────────────────────────────────────────────────
function checkPipeline(pipelineWorker) {
    try {
        var d = db.getDb();

        // When was the last pipeline job completed?
        var lastDone = d.prepare(
            "SELECT MAX(completed_at) as t FROM pipeline_jobs WHERE status IN ('done','failed')"
        ).get();
        var lastDoneAt = lastDone && lastDone.t ? new Date(lastDone.t) : null;
        var msSinceDone = lastDoneAt ? Date.now() - lastDoneAt.getTime() : Infinity;

        // How many jobs are pending/running?
        var pending = d.prepare("SELECT COUNT(*) as c FROM pipeline_jobs WHERE status='pending'").get().c;
        var running = d.prepare("SELECT COUNT(*) as c FROM pipeline_jobs WHERE status='running'").get().c;

        var minutesSince = Math.round(msSinceDone / 60000);

        if (msSinceDone > 30 * 60 * 1000 && pending > 0) {
            // Pipeline has pending work but nothing completed in 30+ min — stalled
            warn('pipeline', pending + ' pending jobs, last completion ' + minutesSince + ' min ago — reseeding');
            // Re-seed all users to kick things loose
            if (pipelineWorker && typeof pipelineWorker.seedAllUsers === 'function') {
                pipelineWorker.seedAllUsers(8);
                recordHeal('Reseeded pipeline after ' + minutesSince + 'min stall (' + pending + ' pending)');
            }
        } else if (msSinceDone > 60 * 60 * 1000 && pending === 0 && running === 0) {
            // No jobs at all for >1h — likely all done, seed a fresh cycle
            warn('pipeline', 'No jobs for ' + minutesSince + ' min — seeding new cycle');
            if (pipelineWorker && typeof pipelineWorker.seedAllUsers === 'function') {
                pipelineWorker.seedAllUsers(9);
                recordHeal('Seeded new pipeline cycle after ' + minutesSince + 'min quiet period');
            }
        } else {
            ok('pipeline', pending + ' pending, ' + running + ' running, last done ' + minutesSince + ' min ago');
        }
    } catch (e) {
        warn('pipeline', 'Check error: ' + e.message);
    }
}

// ── 2. Chrome lock watchdog ───────────────────────────────────────────────────
// lockSince is set by scanner when it acquires the lock
var _chromeLockSince = null;
function markChromeLocked()   { _chromeLockSince = Date.now(); }
function markChromeUnlocked() { _chromeLockSince = null; }

function checkChromeLock(scanner) {
    try {
        var locked = scanner && scanner.chromeLock;
        if (!locked) {
            _chromeLockSince = null;
            ok('chromeLock', 'not held');
            return;
        }
        // Lock is held — how long?
        if (!_chromeLockSince) _chromeLockSince = Date.now(); // start tracking
        var heldMs  = Date.now() - _chromeLockSince;
        var heldMin = Math.round(heldMs / 60000);

        if (heldMs > 90 * 60 * 1000) {
            // 90 min — scanner's own limit is 4h, but 90 min suggests a hang
            fail('chromeLock', 'Lock held for ' + heldMin + ' min — possible hang (scanner will auto-release at 4h)');
        } else if (heldMs > 30 * 60 * 1000) {
            warn('chromeLock', 'Lock held for ' + heldMin + ' min — watching');
        } else {
            ok('chromeLock', 'held for ' + heldMin + ' min (normal during scan)');
        }
    } catch (e) {
        warn('chromeLock', 'Check error: ' + e.message);
    }
}

// ── 3. Site self-check ────────────────────────────────────────────────────────
var _selfCheckFails = 0;
function checkSelf(port) {
    try {
        var req = http.get('http://localhost:' + (port || 5052) + '/api/health', function(res) {
            if (res.statusCode === 200) {
                _selfCheckFails = 0;
                ok('selfCheck', 'HTTP 200 on /api/health');
            } else {
                _selfCheckFails++;
                warn('selfCheck', '/api/health returned HTTP ' + res.statusCode + ' (fail #' + _selfCheckFails + ')');
            }
            res.resume();
        });
        req.on('error', function(e) {
            _selfCheckFails++;
            if (_selfCheckFails >= 3) {
                fail('selfCheck', '/api/health unreachable ' + _selfCheckFails + 'x: ' + e.message);
            } else {
                warn('selfCheck', '/api/health error (fail #' + _selfCheckFails + '): ' + e.message);
            }
        });
        req.setTimeout(5000, function() { req.destroy(); });
    } catch (e) {
        warn('selfCheck', 'Check error: ' + e.message);
    }
}

// ── 4. Stale wantlists ────────────────────────────────────────────────────────
function checkStaleWantlists(pipelineWorker) {
    try {
        var d = db.getDb();
        // Users who have OAuth but last_sync is null or >6h old
        var stale = d.prepare(`
            SELECT u.id, u.username, u.last_sync
            FROM users u
            WHERE u.last_sync IS NULL
               OR datetime(u.last_sync) < datetime('now', '-6 hours')
            ORDER BY u.last_sync ASC NULLS FIRST
            LIMIT 10
        `).all();

        if (stale.length === 0) {
            ok('staleWantlists', 'All users synced within 6 h');
            return;
        }

        var names = stale.map(function(u) { return u.username; }).join(', ');
        warn('staleWantlists', stale.length + ' user(s) stale (>6 h): ' + names);

        // Re-enqueue wantlist_sync for stale users (low priority so active scans stay first)
        if (pipelineWorker && typeof pipelineWorker.seedAllUsers !== 'function') return;
        stale.forEach(function(u) {
            db.enqueuePipelineJob('wantlist_sync', u.id, 9);
        });
        recordHeal('Re-enqueued wantlist_sync for ' + stale.length + ' stale users: ' + names);
    } catch (e) {
        warn('staleWantlists', 'Check error: ' + e.message);
    }
}

// ── 5. Rolling scan watchdog ──────────────────────────────────────────────────
function checkRollingScan(scanner) {
    try {
        var health = scanner && scanner.getJobHealth && scanner.getJobHealth();
        if (!health) { ok('rollingScna', 'no health data yet'); return; }

        var lastRolling = health.lastDailyRescan; // scanner reuses this key for rolling too
        if (!lastRolling) {
            ok('rollingScna', 'Not yet run (startup)');
            return;
        }
        var msAgo = Date.now() - new Date(lastRolling).getTime();
        var hAgo  = (msAgo / 3600000).toFixed(1);

        if (msAgo > 5 * 3600000) {
            warn('rollingScna', 'Rolling scan last ran ' + hAgo + ' h ago — expected every 3 h');
        } else {
            ok('rollingScna', 'Last run ' + hAgo + ' h ago');
        }
    } catch (e) {
        warn('rollingScna', 'Check error: ' + e.message);
    }
}

// ── 6. Memory watchdog ───────────────────────────────────────────────────────
function checkMemory() {
    try {
        var mem = process.memoryUsage();
        var heapMb = Math.round(mem.heapUsed / 1024 / 1024);
        var rssMb  = Math.round(mem.rss / 1024 / 1024);

        if (heapMb > 500) {
            fail('memory', 'Heap ' + heapMb + ' MB — risk of OOM (RSS ' + rssMb + ' MB)');
        } else if (heapMb > 300) {
            warn('memory', 'Heap ' + heapMb + ' MB — elevated (RSS ' + rssMb + ' MB)');
        } else {
            ok('memory', 'Heap ' + heapMb + ' MB, RSS ' + rssMb + ' MB');
        }
    } catch (e) {
        warn('memory', 'Check error: ' + e.message);
    }
}

// ── 7. YouTube quota ─────────────────────────────────────────────────────────
function checkYtQuota() {
    try {
        var d = db.getDb();
        // pipeline_events with status='quota_exhausted' in last 24h
        var quotaFails = d.prepare(`
            SELECT COUNT(*) as c FROM pipeline_events
            WHERE status = 'quota_exhausted'
              AND created_at > datetime('now', '-24 hours')
        `).get();

        if (quotaFails && quotaFails.c > 0) {
            warn('ytQuota', quotaFails.c + ' quota_exhausted event(s) in last 24 h — YouTube enrichment partially disabled');
        } else {
            ok('ytQuota', 'No quota failures in last 24 h');
        }
    } catch (e) {
        // pipeline_events may not exist on older DBs — not critical
        ok('ytQuota', 'Table check skipped: ' + e.message);
    }
}

// ── Master tick ───────────────────────────────────────────────────────────────
function runChecks(deps) {
    state.lastCheckAt = new Date().toISOString();
    var scanner        = deps && deps.scanner;
    var pipelineWorker = deps && deps.pipelineWorker;
    var port           = deps && deps.port;

    checkPipeline(pipelineWorker);
    checkChromeLock(scanner);
    checkStaleWantlists(pipelineWorker);
    checkRollingScan(scanner);
    checkMemory();
    checkYtQuota();
    // Self-check runs less frequently (10 min) — handled separately
}

// ── Public API ────────────────────────────────────────────────────────────────
function getState() {
    return state;
}

/**
 * Start the monitor.
 * @param {object} deps  { scanner, pipelineWorker, port }
 */
function start(deps) {
    var MAIN_INTERVAL  = 10 * 60 * 1000;  // 10 min — pipeline + lock + stale + memory + quota
    var SELF_INTERVAL  = 10 * 60 * 1000;  // 10 min — HTTP self-check

    // Initial run after 2 min (let startup jobs settle)
    setTimeout(function() {
        runChecks(deps);
        checkSelf(deps && deps.port);
    }, 2 * 60 * 1000);

    setInterval(function() { runChecks(deps); }, MAIN_INTERVAL);
    setInterval(function() { checkSelf(deps && deps.port); }, SELF_INTERVAL);

    console.log('[health] Monitor started — checks every ' + (MAIN_INTERVAL / 60000) + ' min');
}

module.exports = { start, getState, markChromeLocked, markChromeUnlocked };
