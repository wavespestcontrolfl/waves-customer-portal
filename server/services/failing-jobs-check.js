// Nightly check: which scheduled jobs are failing?
//
// Each advisory-locked cron (runExclusive, utils/cron-lock.js) records its
// runs in job_health, and the Agents → Queue tab lists the failing ones.
// Nothing pushed that list to a person: the outside Hermes watchdog that read
// it (agent-watchdog-snapshot.js) last polled on 2026-09-05. This job reads the
// same classifier once a night and posts one engineering FIX row to the ops
// digest. The row lists each job that has had no good run for 2 hours and
// whose last run failed or has not ended. It retires itself on the first
// clean night (ops-digest-fall-off.js).
//
// Two rules keep jobs that are off on purpose, and jobs that recovered, off
// the list:
// - A failed run counts only when it started in the last RECENT_RUN_DAYS. A
//   job with no run for longer has stopped firing: its gate is off or its code
//   is gone. The classifier's `stale` jobs (no good run for that long, last run
//   fine) are not listed for the same reason. A monthly job's failed run is
//   listed on its first 8 nights only.
// - The job has had no good run for 2 hours, so a frequent job's one-off
//   failure (a dropped connection) is never listed.
//
// Read-only: it writes no business record, texts or emails no customer, and
// calls no paid API. Its only write is the ops digest row (or, when the in-app
// feed is off, one email to the internal ops inbox). The row names jobs only:
// job_health.last_error is digit-masked, not free of customer data, so the
// error stays on the Queue tab.

const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { getScheduledJobHealth } = require('./intelligence-bar/job-health-tools');
const { DEAD_RUN_ERROR } = require('../utils/cron-lock');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');

const OPS_KEY = 'failing-jobs-check';
// The classifier's stale floor (STALE_SUCCESS_DAYS in
// intelligence-bar/job-health-tools.js): even a weekly job runs inside it.
const RECENT_RUN_DAYS = 8;
const RECENT_RUN_MS = RECENT_RUN_DAYS * 24 * 60 * 60 * 1000;
const NO_GOOD_RUN_MS = 2 * 60 * 60 * 1000;
const QUEUE_LINK = '/admin/agents?tab=queue';
const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function msOf(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// `jobs` is getScheduledJobHealth().jobs. Returns the jobs to list, sorted by
// name. kind: 'failed' (the run threw), 'killed' (a deploy restart ended the
// run; cron-lock settled the row), 'hung' (still running, its lock held).
function failingJobs(jobs, nowMs) {
  const out = [];
  for (const j of jobs || []) {
    const startedMs = msOf(j.last_started_at);
    const successMs = msOf(j.last_success_at);
    if (startedMs === null) continue;
    if (successMs !== null && nowMs - successMs < NO_GOOD_RUN_MS) continue;
    let kind = null;
    if (j.state === 'failing' && nowMs - startedMs <= RECENT_RUN_MS) {
      kind = j.last_error === DEAD_RUN_ERROR ? 'killed' : 'failed';
    } else if (j.state === 'stuck' && nowMs - startedMs >= NO_GOOD_RUN_MS) {
      kind = 'hung';
    }
    if (kind) {
      out.push({
        job: j.job,
        kind,
        failures: j.consecutive_failures || 0,
        startedAt: j.last_started_at,
        lastSuccessAt: j.last_success_at,
      });
    }
  }
  return out.sort((a, b) => a.job.localeCompare(b.job));
}

function when(iso) {
  const ms = msOf(iso);
  if (ms === null) return 'never';
  const d = new Date(ms);
  return `${formatETDayDate(d)}, ${formatETTime(d)} ET`;
}

function describeJob(item) {
  const lastGood = `Last good run: ${when(item.lastSuccessAt)}.`;
  const streak = item.failures > 1 ? ` (${item.failures} in a row)` : '';
  if (item.kind === 'hung') return `the run that started ${when(item.startedAt)} has not ended. ${lastGood}`;
  if (item.kind === 'killed') return `a deploy restart killed the last run${streak}. ${lastGood}`;
  return `the last run failed${streak}. ${lastGood}`;
}

function composeDigest(items) {
  const n = items.length;
  const jobs = `scheduled job${n === 1 ? '' : 's'}`;
  const url = `${adminPortalUrl()}${QUEUE_LINK}`;
  const notes = ['Agents → Queue shows the last error of each job.'];
  if (items.some((i) => i.kind === 'killed')) {
    notes.push('A run that a deploy restart killed did not finish its work. The job runs again at its next scheduled time.');
  }
  const intro = `${n} ${jobs} ${n === 1 ? 'has' : 'have'} had no good run for 2 hours:`;
  return {
    subject: `FIX: ${n} ${jobs} failing`,
    headline: `System — fix ${n} failing ${jobs}`,
    summary: `${n} ${jobs} ${n === 1 ? 'has' : 'have'} had no good run for 2 hours: the last run failed or has not ended.`,
    text: [
      intro,
      '',
      ...items.map((i) => `- ${i.job}: ${describeJob(i)}`),
      '',
      ...notes,
      '',
      `Queue: ${url}`,
    ].join('\n'),
    html: [
      `<p>${esc(intro)}</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${items.map((i) => `<li style="margin:0 0 6px 0;"><strong>${esc(i.job)}</strong>: ${esc(describeJob(i))}</li>`).join('')}</ul>`,
      `<p>${esc(notes.join(' '))}</p>`,
      `<p><a href="${esc(url)}">Open Agents → Queue</a></p>`,
    ].join('\n'),
  };
}

function postDigest(items, mailer) {
  const composed = composeDigest(items);
  return deliverOpsDigest({
    fallOff: true, // retired by retireIfClean on the first clean night
    key: OPS_KEY,
    subject: composed.subject,
    headline: composed.headline,
    summary: composed.summary,
    html: composed.html,
    text: composed.text,
    link: QUEUE_LINK,
    count: items.length,
    itemKeys: items.map((i) => i.job),
    // One standing row while jobs keep failing, rewritten when the list
    // changes. No dedupeWindowMs: a retired row drops its dedupeKey, so the
    // next failure opens a new row.
    dedupeKey: OPS_KEY,
    refreshOnDedupe: true,
    // Fallback only: the in-app feed is off, or the row write failed.
    sendEmail: async () => {
      if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
        throw new Error('mailer not configured');
      }
      return mailer.sendOne({
        to: OPS_INBOX,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        categories: ['ops', OPS_KEY],
        suppressErrorLog: true,
      });
    },
  });
}

/**
 * One nightly run. When the job_health read throws, this throws too, so
 * runExclusive records a failed run and the standing row stays: a check that
 * did not run proves nothing. Returns { failing, delivery? }: `failing` is
 * the listed job names.
 */
async function runFailingJobsCheck({
  readHealth = getScheduledJobHealth,
  now = () => Date.now(),
  mailer = sendgrid,
} = {}) {
  const health = await readHealth();
  if (!Array.isArray(health?.jobs)) throw new Error('failing-jobs-check: the job_health read returned no job list');
  const items = failingJobs(health.jobs, now());
  if (!items.length) {
    await retireIfClean(OPS_KEY);
    return { failing: [] };
  }
  const names = items.map((i) => i.job);
  logger.warn(`[failing-jobs-check] ${names.length} job(s) failing: ${names.join(', ')}`);
  const delivery = await postDigest(items, mailer);
  return { failing: names, delivery };
}

module.exports = {
  runFailingJobsCheck,
  OPS_KEY,
  RECENT_RUN_DAYS,
  NO_GOOD_RUN_MS,
  _private: { failingJobs, composeDigest },
};
