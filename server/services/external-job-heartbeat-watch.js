/**
 * External job heartbeat watch — the portal's side of "did the outside job
 * run today?".
 *
 * Some daily jobs run outside the portal (first entry: the plan gap sweep on
 * the office Mac). Each one writes ONE row in `job_health` (job_name = the
 * registry's jobName) at the END of a run, never "running": a complete run
 * sets last_status 'success' and last_success_at; a failed or partial run sets
 * 'failed' and leaves last_success_at alone. This cron reads those rows and
 * rings ONE standing admin bell when a job has no complete run for today (ET)
 * by its due time, then closes that bell by itself when a complete run lands.
 *
 * Alerts are keyed per silence EPISODE (`external-heartbeat:<job>:<last
 * success ISO | never>`), not per calendar day, so a multi-day outage keeps
 * one standing bell instead of a new unread one each morning. The key changes
 * only when a new success lands and the job later goes silent again; older
 * episode keys of the same job are closed. Before the due time, with no
 * complete run yet, nothing is raised and nothing is closed.
 *
 * Writes only admin notifications. No row locks, no customer messages, no
 * customer data. Dark behind GATE_EXTERNAL_HEARTBEAT_WATCH (call-time read;
 * unset = off = kill). Scheduled in scheduler.js hourly 07:05-22:05 ET.
 */

const db = require('../models/db');
const logger = require('./logger');
const alertEpisodes = require('./admin-alert-episodes');
const { composeAdminAlert } = require('./admin-alert-compose');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, etParts, formatETDate, formatETTime } = require('../utils/datetime-et');

const GATE = 'GATE_EXTERNAL_HEARTBEAT_WATCH';
const KEY_ROOT = 'external-heartbeat';
const MAX_ERROR_CHARS = 120;

// One entry per outside job. `dueBy` is an ET wall-clock 'HH:MM'.
const EXTERNAL_JOBS = [
  {
    jobName: 'appt-sweep',
    dueBy: '07:00',
    label: 'Daily plan gap sweep (office Mac)',
    // Composed per docs/admin-notifications.md: headline = `System — <action>`; the why is one
    // sentence with no date, path or env name (those ride in detail).
    action: 'Check why the daily plan sweep did not run',
    why: 'The office Mac has not finished a full daily plan gap sweep today.',
    where: '~/ops-oneshots/appt-sweep/run.log',
    link: '/admin/schedule',
  },
];

function keyPrefix(jobName) {
  return `${KEY_ROOT}:${jobName}:`;
}

function dueMinutes(dueBy) {
  const [h, m] = String(dueBy).split(':').map(Number);
  return h * 60 + (m || 0);
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A short, single-line, secret-safe version of the job's own error text.
function sanitizeError(text) {
  if (!text) return '';
  const tidy = String(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\S+@\S+/g, '[email]')
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return tidy.length > MAX_ERROR_CHARS ? `${tidy.slice(0, MAX_ERROR_CHARS - 3).trimEnd()}...` : tidy;
}

function describeRun(at) {
  return at ? `${formatETDate(at)}, ${formatETTime(at)} ET` : 'never';
}

async function readRow(jobName) {
  return db('job_health').where({ job_name: jobName })
    .first('last_status', 'last_success_at', 'last_finished_at', 'last_error', 'consecutive_failures');
}

// Closes every open alert key under the job's prefix except `keep`.
async function closeOpenKeys(prefix, keep, reason, resolution, now) {
  const open = (await alertEpisodes.openAdminAlertKeys(db, prefix)).filter((k) => k !== keep);
  if (!open.length) return 0;
  return Number(await alertEpisodes.closeAdminAlertKeys(db, open, reason, { now, resolution })) || 0;
}

async function checkJob(job, now) {
  const prefix = keyPrefix(job.jobName);
  const row = await readRow(job.jobName);
  const lastSuccess = toDate(row && row.last_success_at);
  const today = etDateString(now);
  // A success stamped today is a complete run, even if a later rerun failed: last_success_at only
  // moves on a complete run, and the day's sweep has already been done.
  const complete = !!lastSuccess && etDateString(lastSuccess) === today;

  if (complete) {
    const closed = await closeOpenKeys(prefix, null, 'the job finished a complete run', 'The job finished a complete run', now);
    return { jobName: job.jobName, complete: true, alerted: 0, closed };
  }

  const { hour, minute } = etParts(now);
  if (hour * 60 + minute < dueMinutes(job.dueBy)) {
    return { jobName: job.jobName, complete: false, due: false, alerted: 0, closed: 0 };
  }

  const dedupeKey = `${prefix}${lastSuccess ? lastSuccess.toISOString() : 'never'}`;
  const status = (row && row.last_status) || 'no row';
  const error = sanitizeError(row && row.last_error);
  const lastText = describeRun(lastSuccess);
  const composed = composeAdminAlert({
    area: 'System', action: job.action, why: job.why, severity: 'needs-you', who: 'claude',
    subject: { type: 'check', id: job.jobName }, doneWhen: 'external_job_completed_today', link: job.link,
  });
  const detail = [
    `${job.label} has not finished a complete run today (due by ${job.dueBy} ET).`,
    `Last complete run: ${lastText}. Last status: ${status}.`,
    error ? `Last error: ${error}.` : null,
    'Likely causes: the Mac was asleep or off, its Railway login expired, or the run failed.',
    `Look at ${job.where}.`,
  ].filter(Boolean).join(' ');

  const raised = await alertEpisodes.raiseAdminAlertWithReopen(
    'system',
    composed.headline,
    composed.why,
    {
      link: composed.link,
      detail,
      bell: true,
      dedupeKey,
      metadata: {
        ...composed.metadata,
        dedupeKey,
        job_name: job.jobName,
        last_success_at: lastSuccess ? lastSuccess.toISOString() : null,
        last_status: status,
        due_by: job.dueBy,
      },
    },
  );
  if (!raised || (raised.id == null && !raised.suppressed)) {
    // Throw so the cron wrapper records THIS job as failing: a lost bell must
    // never read as a quiet, healthy portal.
    logger.error(`[external-heartbeat-watch] bell did not persist for ${job.jobName} — silence is unannounced`);
    throw new Error(`external heartbeat bell did not persist for ${job.jobName}`);
  }

  // Older episodes of this job are over (a complete run landed in between).
  const closed = await closeOpenKeys(prefix, dedupeKey, 'a newer silence episode replaced this one', 'Replaced by a newer alert for the same job', now);
  return { jobName: job.jobName, complete: false, due: true, alerted: raised.rang ? 1 : 0, closed };
}

async function runExternalHeartbeatWatch({ now = new Date() } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: true };
  const results = [];
  for (const job of EXTERNAL_JOBS) {
    results.push(await checkJob(job, now));
  }
  return {
    skipped: false,
    checked: results.length,
    alerted: results.reduce((n, r) => n + r.alerted, 0),
    closed: results.reduce((n, r) => n + r.closed, 0),
    results,
  };
}

module.exports = { runExternalHeartbeatWatch, EXTERNAL_JOBS, sanitizeError };
