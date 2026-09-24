/**
 * Hermes watchdog liveness — the reciprocal check.
 *
 * The external watchdog proves it is alive by polling
 * GET /api/integrations/watchdog-worker/status; each served poll finalizes a
 * seo_link_worker_requests row as endpoint='watchdog', result='observed'. This
 * cron asks "when did the watchdog last watch?" and rings ONE standing admin
 * bell per silence EPISODE (keyed to the last successful poll, not the
 * calendar day) when the answer is never / too long ago — otherwise a dead
 * Hermes cron would look exactly like a quiet, healthy portal, and a
 * multi-day outage would ring a fresh unread row every ET day.
 *
 * Dark behind GATE_HERMES_WATCHDOG (call-time read) AND the shared
 * GATE_HERMES_WORKER the endpoint's auth requires. Kill = unset either.
 * Scheduled in scheduler.js every 23 min — coprime with the watchdog's 10-min
 * cadence so the sample walks through every phase offset (the call-stall
 * watchdog's '*\/7' reasoning).
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { gateEnvValue, isEnabled } = require('../config/feature-gates');

const DEFAULT_STALE_MINUTES = 45;

function staleMinutes() {
  const n = Number(process.env.HERMES_WATCHDOG_STALE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MINUTES;
}

async function lastObservedAt() {
  const row = await db('seo_link_worker_requests')
    .where({ endpoint: 'watchdog', result: 'observed' })
    .max('received_at as at')
    .first();
  return row && row.at ? new Date(row.at) : null;
}

async function runWatchdogLivenessCheck({ now = new Date() } = {}) {
  // The endpoint sits behind BOTH gates (linkWorkerAuth answers 403 while the
  // shared worker integration is off, so no observed row can land); ringing
  // "watchdog silent" then would page for a deliberate state.
  if (!gateEnvValue('GATE_HERMES_WATCHDOG') || !isEnabled('hermesWorker')) return { skipped: true };
  const last = await lastObservedAt();
  const ageMinutes = last ? Math.round((now.getTime() - last.getTime()) / 60000) : null;
  const limit = staleMinutes();
  if (last && ageMinutes <= limit) return { skipped: false, alerted: 0, ageMinutes, limit };

  const detail = last
    ? `Last successful poll ${ageMinutes} min ago (${last.toISOString()}); the limit is ${limit} min.`
    : 'It has never polled since the lane was enabled.';
  const notif = await NotificationService.notifyAdmin(
    'alert',
    'FIX: Hermes watchdog silent',
    `The external agent watchdog on the Hermes box has stopped polling the portal. ${detail} `
    + 'Check the Hermes cron on Hostinger and the LINK_WORKER_SECRET_HERMES_WATCHDOG secret file.',
    {
      link: '/admin/agents?tab=queue',
      // Keyed per silence EPISODE (the last successful poll's timestamp),
      // not per calendar day: the old `:${today}` key rang a fresh bell
      // every ET day the watchdog stayed silent (7 days running for one
      // outage). The key only changes when `last` changes — i.e. once the
      // watchdog resumes polling and then goes silent again.
      dedupeKey: `hermes-watchdog-silent:${last ? last.toISOString() : 'never'}`,
      bell: true,
      metadata: { last_observed_at: last ? last.toISOString() : null, age_minutes: ageMinutes, limit_minutes: limit },
    },
  );
  if (!notif) {
    // Throw, don't just log: runExclusive then records THIS job as failing in
    // job_health, so the snapshot (and Hermes) can see that the reciprocal
    // alarm itself is broken — otherwise silence would be unannounced twice.
    logger.error('[hermes-watchdog-liveness] bell did not persist — silence is unannounced');
    throw new Error('hermes watchdog silent bell did not persist');
  }
  // notifyAdmin returns the EXISTING row with deduped:true on every later
  // tick of the same ET day; that is not a new alert (or the scheduler
  // would log a warning every 23 min all day).
  return { skipped: false, alerted: notif && !notif.deduped ? 1 : 0, ageMinutes, limit };
}

module.exports = { runWatchdogLivenessCheck, DEFAULT_STALE_MINUTES };
