/**
 * Outside watchdog liveness — the reciprocal check.
 *
 * The outside watchdog (the MacBook Air job in ops/outside-watchdog/ since
 * 2026-11-06; the Hostinger Hermes box until 2026-09-05) proves it is alive by
 * polling GET /api/integrations/watchdog-worker/status. Each served poll
 * finalizes a seo_link_worker_requests row as endpoint='watchdog',
 * result='observed'. This cron asks "when did the watchdog last watch?". When
 * the answer is never or too long ago, it writes ONE engineering fault row
 * (Agents → Activity and Claude's fault queue, never the owner's bell: a
 * broken alert, docs/admin-notifications.md section 7). Otherwise a dead
 * outside watchdog would look exactly like a quiet, healthy portal.
 *
 * One row per silence episode: its text names the last poll, so it does not
 * change while the watchdog stays silent, and the first fresh poll retires it
 * (ops-digest-fall-off.js). A retired row drops its dedupe key, so the next
 * silence opens a new row.
 *
 * Dark behind GATE_HERMES_WATCHDOG (call-time read) AND the shared
 * GATE_HERMES_WORKER the endpoint's auth requires. Kill = unset either.
 * Scheduled in scheduler.js every 23 min, coprime with the watchdog's 10-min
 * cadence so the sample walks through every phase offset (the call-stall
 * watchdog's '*\/7' reasoning). The same job's job_health row is the
 * scheduler heartbeat the snapshot reads (agent-watchdog-snapshot.js).
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { composeAdminAlert } = require('./admin-alert-compose');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');
const sendgrid = require('./sendgrid-mail');

const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

// One fallback email per silence episode (keyed by the last poll time), not
// one per 23-min tick. In memory: a redeploy mid-episode sends one more.
let emailedEpisode = null;

const DEFAULT_STALE_MINUTES = 45;
const OPS_KEY = 'outside-watchdog-silent';
const QUEUE_LINK = '/admin/agents?tab=queue';

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

const etStamp = (at) => `${formatETDayDate(at)} at ${formatETTime(at)}`.replace(/\s+/g, ' ');

// The row's words depend only on the last poll and the limit, never on the
// age, so every tick of one silence episode writes the same row.
function composeSilentRow(last, limit) {
  const alert = composeAdminAlert({
    area: 'System',
    action: 'check the outside watchdog on the Air',
    why: last
      ? `Its last poll was ${etStamp(last)}; the limit is ${limit} min.`
      : 'It has never polled the portal since its lane was turned on.',
    severity: 'broken',
    link: QUEUE_LINK,
    subject: { type: 'check', id: 'outside-watchdog' },
    doneWhen: 'watchdog_polling',
    who: 'claude',
  });
  const text = [
    last
      ? `The outside watchdog has not polled the portal since ${etStamp(last)} ET (the limit is ${limit} min).`
      : 'The outside watchdog has never polled the portal since its lane was turned on.',
    'While it is silent, nothing outside the portal reports the portal down or its job runner stopped.',
    'It runs on the office MacBook Air: launchd job com.waves.portal-watchdog, every 10 min (runbook: ops/outside-watchdog/README.md).',
    'Check it from this Mac:',
    "  ssh adams-air 'launchctl print gui/$(id -u)/com.waves.portal-watchdog | head -20'",
    "  ssh adams-air 'tail -20 ~/waves-ops/portal-watchdog/run.log'",
    'A "Not logged in" or "Unauthorized" line in that log means the Air\'s Railway login expired.',
    'Only the owner can sign in again: ssh -tt adams-air railway login --browserless',
    'This row closes itself on the first poll that arrives.',
  ].join('\n');
  return { alert, text };
}

async function runWatchdogLivenessCheck({ now = new Date(), mailer = sendgrid } = {}) {
  // The endpoint sits behind BOTH gates (linkWorkerAuth answers 403 while the
  // shared worker integration is off, so no observed row can land); a
  // "watchdog silent" row then would report a deliberate state.
  if (!gateEnvValue('GATE_HERMES_WATCHDOG') || !isEnabled('hermesWorker')) return { skipped: true };
  const last = await lastObservedAt();
  const ageMinutes = last ? Math.round((now.getTime() - last.getTime()) / 60000) : null;
  const limit = staleMinutes();
  if (last && ageMinutes <= limit) {
    const closed = await retireIfClean(OPS_KEY, { resolvedBy: 'outside-watchdog:polling' });
    return { skipped: false, silent: false, closed, ageMinutes, limit };
  }

  const { alert, text } = composeSilentRow(last, limit);
  const result = await deliverOpsDigest({
    key: OPS_KEY,
    subject: 'FIX: outside watchdog silent',
    headline: alert.headline,
    summary: alert.why,
    text,
    audience: 'engineering',
    link: alert.link,
    // One standing row per episode, refreshed in place; no dedupeWindowMs (a
    // retired row drops its key, so the next silence opens a new row).
    dedupeKey: OPS_KEY,
    refreshOnDedupe: true,
    fallOff: true,
    metadata: { ...alert.metadata, last_observed_at: last ? last.toISOString() : null, limit_minutes: limit },
    // Fallback only (the in-app digest gates are off, or the row write
    // failed): the office inbox gets the same words, so the silence is
    // still reported. No customer address is ever used here.
    sendEmail: async () => {
      const episode = last ? last.toISOString() : 'never';
      if (emailedEpisode === episode) return { ok: true, skipped: 'already emailed this episode' };
      if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
        return { ok: false, error: 'mailer not configured' };
      }
      const sent = await mailer.sendOne({
        to: OPS_INBOX,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject: 'FIX: outside watchdog silent',
        text,
        categories: ['ops', OPS_KEY],
        suppressErrorLog: true,
      });
      if (!sent || sent.ok !== false) emailedEpisode = episode;
      return sent;
    },
  });
  if (!result || result.ok === false || (result.channel !== 'in_app' && result.channel !== 'email')) {
    // Throw, don't just log: runExclusive then records THIS job as failing in
    // job_health (the Agents → Queue tab), so a broken reciprocal alarm is
    // not silent twice.
    logger.error('[hermes-watchdog-liveness] neither the silent row nor its email landed — silence is unannounced');
    throw new Error('outside watchdog silent row did not persist');
  }
  return { skipped: false, silent: true, ageMinutes, limit, channel: result.channel };
}

function resetEmailedEpisodeForTests() { emailedEpisode = null; }

module.exports = { runWatchdogLivenessCheck, DEFAULT_STALE_MINUTES, OPS_KEY, OPS_INBOX, resetEmailedEpisodeForTests };
