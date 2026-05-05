/**
 * ETL Pipeline Worker
 *
 * Polls pipeline_jobs every 4s, claims one pending job at a time, runs the
 * stage handler, writes results back, and enqueues the next stage in the chain.
 *
 * Sequential processing — one stage runs at a time. This shares the single
 * Playwright/Chromium budget with optimizer-worker.js (which uses 3s intervals),
 * so at worst only one process is active at once.
 *
 * Stage chain:
 *   wantlist_sync → meta_sync → yt_id_search → yt_enrich → gem_score
 */

'use strict';

const db = require('../db');

const POLL_INTERVAL_MS = 4000;  // offset from optimizer-worker's 3s

// Stage chain — what to auto-enqueue after each stage completes
const NEXT_STAGE = {
    wantlist_sync: 'meta_sync',
    meta_sync:     'yt_id_search',
    yt_id_search:  'yt_enrich',
    yt_enrich:     'gem_score',
    gem_score:     null,          // terminal
};

let isProcessing = false;

async function runStage(stageName, userId, username) {
    switch (stageName) {
        case 'wantlist_sync': return require('./pipeline-stages/wantlist-sync')(userId, username);
        case 'meta_sync':     return require('./pipeline-stages/meta-sync')(userId, username);
        case 'yt_id_search':  return require('./pipeline-stages/yt-id-search')(userId, username);
        case 'yt_enrich':     return require('./pipeline-stages/yt-enrich')(userId, username);
        case 'gem_score':     return require('./pipeline-stages/gem-score')(userId, username);
        default: throw new Error('Unknown pipeline stage: ' + stageName);
    }
}

async function tick() {
    if (isProcessing) return;

    var job = db.claimNextPipelineJob();
    if (!job) return;

    isProcessing = true;

    var d = db.getDb();
    var user = d.prepare('SELECT id, username FROM users WHERE id=?').get(job.user_id);
    if (!user) {
        db.failPipelineJob(job.id, job.stage, job.user_id, 'User not found');
        isProcessing = false;
        return;
    }

    console.log('[pipeline] Starting stage', job.stage, 'for', user.username, '(job', job.id + ')');
    db.updatePipelineState(job.stage, job.user_id, 'running');
    db.logPipelineEvent(job.stage, job.user_id, user.username, 'started');

    var startMs = Date.now();

    try {
        var result = await runStage(job.stage, job.user_id, user.username);
        if (!result || typeof result.itemsProcessed !== 'number') result = { itemsProcessed: 0 };

        var durationMs = Date.now() - startMs;
        db.completePipelineJob(job.id, job.stage, job.user_id, result);
        db.logPipelineEvent(job.stage, job.user_id, user.username, 'done', {
            itemsProcessed: result.itemsProcessed,
            durationMs:     durationMs,
            detail:         result.detail || null,   // stages can pass extra metadata
        });
        console.log('[pipeline] Stage', job.stage, 'done for', user.username,
                    '—', result.itemsProcessed, 'items in', Math.round(durationMs / 1000) + 's');

        // Auto-enqueue next stage (background priority = 8)
        var next = NEXT_STAGE[job.stage];
        if (next) {
            db.enqueuePipelineJob(next, job.user_id, 8);
            console.log('[pipeline] Enqueued', next, 'for', user.username);
        }
    } catch (e) {
        var durationMs = Date.now() - startMs;
        var isQuotaError = /quota|rate.limit|429|forbidden/i.test(e.message);
        var status = isQuotaError ? 'quota_exhausted' : 'failed';

        console.error('[pipeline] Stage', job.stage, status, 'for', user.username + ':', e.message);
        db.failPipelineJob(job.id, job.stage, job.user_id, e.message);
        db.logPipelineEvent(job.stage, job.user_id, user.username, status, {
            durationMs: durationMs,
            error:      e.message,
        });
    } finally {
        isProcessing = false;
    }
}

function start() {
    setInterval(tick, POLL_INTERVAL_MS);
    console.log('[pipeline] Worker started — polling every ' + (POLL_INTERVAL_MS / 1000) + 's');
}

// Seed all users into the pipeline on startup (called from server.js)
function seedAllUsers(priorityOverride) {
    var priority = priorityOverride || 8;
    var d = db.getDb();
    var users = d.prepare('SELECT id, username FROM users').all();
    var count = 0;
    users.forEach(function(u) {
        db.enqueuePipelineJob('wantlist_sync', u.id, priority);
        count++;
    });
    console.log('[pipeline] Seeded wantlist_sync for', count, 'users at priority', priority);
    return count;
}

module.exports = { start, seedAllUsers };
