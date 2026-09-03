/**
 * Agent watchdog snapshot — the ONE health read the external Hermes watchdog
 * polls (docs/hermes/waves-agent-watchdog-skill.md).
 *
 * Why it exists: the Hostinger Hermes box sits outside Railway, so it is the
 * only observer that can report the portal down, the database degraded, or the
 * scheduler silent. Everything it needs to judge that is already recorded:
 *   - job_health (advisory-locked crons) through the SAME classifier the Ops
 *     queue and the IB job-health tool use, so the three can never disagree;
 *   - a prompt scheduler heartbeat: the hermes-watchdog-liveness cron ticks
 *     every 23 min under runExclusive (gate or no gate — the gate is read
 *     inside), so its job_health row's last_started_at says whether the
 *     scheduler is alive NOW; the shared classifier's stale floor is 8 days,
 *     far too slow for the "scheduler silent" case this watchdog exists for;
 *   - the ops queue's per-lane pending / parked / failed counts;
 *   - the link-worker audit + prospect leases (Hermes's own claim → report loop).
 *
 * PII rule: this payload leaves the portal. Only COUNTS, job names and fixed
 * state words cross the wire — ops-queue item titles/hrefs carry customer
 * names and are dropped; job_health.last_error is only digit-masked, so it
 * stays inside too (the Agents → Queue tab shows it); a failing sub-read
 * reports a fixed `unavailable` marker, never its message.
 *
 * `reasons` are stable string keys (job:<name>:<state>, ops:<lane>:failed,
 * db:degraded, scheduler:silent, link_worker:stale_leases, <read>:unavailable) so the Hermes side
 * diffs them against its last poll without a model call and pages only on
 * CHANGE. Keys carry NO counts — a worsening or draining incident keeps one
 * identity; the current numbers sit in the snapshot body next to it.
 *
 * Every sub-read is contained: a failing read reports `available: false` and the
 * verdict still computes from whatever succeeded (rule 6). The per-lane runtime
 * state (stall / loop health, incidents) is the agent-control S3/S4 phases —
 * nothing here grows into a sibling of that.
 */

const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { isDatabaseReady } = require('../utils/db-health');
const { getScheduledJobHealth } = require('./intelligence-bar/job-health-tools');
const { getOpsQueue } = require('./ops-queue');

// A prospect lease older than this with no report is a claim-without-report —
// the exact failure the 2026-08-30 Hermes run showed. The hourly
// sweepExpiredClaims releases at 6h; this flags well before that.
const STALE_LEASE_HOURS = 2;

const ATTENTION_JOB_STATES = new Set(['failing', 'stuck', 'stale']);
// job_health also holds per-run advisory-lock rows (e.g. the social studio's
// `social_autonomous_approve_<runId>`) that record health once and are never
// touched again — the 8-day floor marks each `stale` forever, which would page
// a permanent false incident. A job that ends in a UUID is a lock, not a
// scheduled sweep: it is excluded here (and from the total) rather than
// reported.
const PER_ENTITY_LOCK_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isScheduledJob = (j) => !PER_ENTITY_LOCK_RE.test(String(j.job || ''));

// The scheduler heartbeat job (scheduler.js '*/23 * * * *') and how late its
// tick may run before the scheduler counts as silent: two periods plus slack.
const SCHEDULER_HEARTBEAT_JOB = 'hermes-watchdog-liveness';
const SCHEDULER_SILENT_AFTER_MINUTES = 60;

// A failed read reports ONLY that it is unavailable. The message is not
// logged either — SQL/provider errors echo bound customer data (names, emails,
// phone numbers), and the underlying reader logs its own failure. Only the
// read label and the error's code/class survive.
function contain(label, fn, fallback) {
  return fn().catch((err) => {
    const kind = (err && (err.code || err.name)) || 'Error';
    logger.warn(`[agent-watchdog] ${label} read failed (${String(kind).slice(0, 40)})`);
    return { ...fallback, available: false };
  });
}

async function readDatabase() {
  const started = Date.now();
  const ok = await isDatabaseReady(db);
  return { ok, latency_ms: Date.now() - started };
}

// A fresh deployment has no row until the first tick; give the process one
// silence window before a missing row counts as a dead scheduler.
async function readScheduler() {
  const row = await db('job_health').where({ job_name: SCHEDULER_HEARTBEAT_JOB }).first();
  const lastTick = row && row.last_started_at ? new Date(row.last_started_at) : null;
  const ageMinutes = lastTick ? Math.round((Date.now() - lastTick.getTime()) / 60000) : null;
  const warming = !lastTick && process.uptime() < SCHEDULER_SILENT_AFTER_MINUTES * 60;
  return {
    available: true,
    heartbeat_job: SCHEDULER_HEARTBEAT_JOB,
    last_tick_at: lastTick ? lastTick.toISOString() : null,
    age_minutes: ageMinutes,
    silent_after_minutes: SCHEDULER_SILENT_AFTER_MINUTES,
    ok: warming || (ageMinutes !== null && ageMinutes <= SCHEDULER_SILENT_AFTER_MINUTES),
  };
}

async function readJobs() {
  const health = await getScheduledJobHealth();
  const scheduled = health.jobs.filter(isScheduledJob);
  const items = scheduled.filter((j) => ATTENTION_JOB_STATES.has(j.state));
  return {
    available: true,
    total: scheduled.length,
    unhealthy: items.length,
    items: items
      .map((j) => ({
        job: j.job,
        state: j.state,
        last_success_age_minutes: j.last_success_age_minutes,
        consecutive_failures: j.consecutive_failures,
      })),
  };
}

// Counts only — never the items (customer names live in the titles) and not
// even the lane label: keys only, so the payload holds no free text at all.
// GATE_ADMIN_OPS_QUEUE only decides whether the admin Queue TAB renders; the
// watchdog's coverage of failed lanes must not depend on a UI gate, so the
// read runs under the watchdog's own gate (the route) regardless.
async function readOpsQueue() {
  const q = await getOpsQueue();
  return {
    available: true,
    pending: q.totals.pending,
    parked: q.totals.parked,
    failed: q.totals.failed,
    lanes: q.lanes.map((l) => ({
      key: l.key,
      pending: l.pending,
      parked: l.parked,
      failed: l.failed,
      error: l.error ? true : false,
    })),
  };
}

async function readLinkWorker() {
  const lastAt = async (endpoint, result) => {
    const row = await db('seo_link_worker_requests').where({ endpoint, result }).max('received_at as at').first();
    return row && row.at ? new Date(row.at).toISOString() : null;
  };
  const staleCutoff = new Date(Date.now() - STALE_LEASE_HOURS * 60 * 60 * 1000);
  const [lastClaimAt, lastReportAt, open, stale] = await Promise.all([
    lastAt('claim', 'leased'),
    lastAt('report', 'report_accepted'),
    db('seo_link_prospects').whereNotNull('claimed_at').where({ status: 'prospect' }).count('* as n').first(),
    db('seo_link_prospects').whereNotNull('claimed_at').where({ status: 'prospect' }).where('claimed_at', '<', staleCutoff).count('* as n').first(),
  ]);
  return {
    available: true,
    last_claim_at: lastClaimAt,
    last_report_at: lastReportAt,
    open_leases: Number(open && open.n) || 0,
    stale_leases: Number(stale && stale.n) || 0,
  };
}

// Pure: derives verdict + reasons from the four reads. Exported for tests.
function judge({ database, scheduler, jobs, ops_queue: ops, link_worker: lw }) {
  const reasons = [];
  if (database && database.ok === false) reasons.push('db:degraded');
  if (scheduler && scheduler.available === false) reasons.push('scheduler:unavailable');
  else if (scheduler && scheduler.ok === false) reasons.push('scheduler:silent');
  if (jobs && jobs.available === false) reasons.push('jobs:unavailable');
  for (const j of (jobs && jobs.items) || []) reasons.push(`job:${j.job}:${j.state}`);
  if (ops && ops.available === false) reasons.push('ops:unavailable');
  if (ops && ops.available) {
    for (const l of ops.lanes || []) {
      if (l.error) reasons.push(`ops:${l.key}:error`);
      else if (l.failed > 0) reasons.push(`ops:${l.key}:failed`);
    }
  }
  if (lw && lw.available === false) reasons.push('link_worker:unavailable');
  if (lw && lw.stale_leases > 0) reasons.push('link_worker:stale_leases');
  return { verdict: reasons.length ? 'attention' : 'healthy', reasons };
}

async function buildWatchdogSnapshot() {
  const [database, scheduler, jobs, opsQueue, linkWorker] = await Promise.all([
    contain('database', readDatabase, { ok: false, latency_ms: null }),
    contain('scheduler', readScheduler, { heartbeat_job: SCHEDULER_HEARTBEAT_JOB, last_tick_at: null, age_minutes: null, silent_after_minutes: SCHEDULER_SILENT_AFTER_MINUTES, ok: false }),
    contain('jobs', readJobs, { total: 0, unhealthy: 0, items: [] }),
    contain('ops_queue', readOpsQueue, { pending: 0, parked: 0, failed: 0, lanes: [] }),
    contain('link_worker', readLinkWorker, { last_claim_at: null, last_report_at: null, open_leases: 0, stale_leases: 0 }),
  ]);
  const parts = { database, scheduler, jobs, ops_queue: opsQueue, link_worker: linkWorker };
  return {
    observed_at: new Date().toISOString(),
    environment: config.nodeEnv,
    uptime_s: Math.round(process.uptime()),
    ...parts,
    ...judge(parts),
  };
}

module.exports = { buildWatchdogSnapshot, STALE_LEASE_HOURS, SCHEDULER_HEARTBEAT_JOB, SCHEDULER_SILENT_AFTER_MINUTES };
module.exports._test = { judge, readOpsQueue, readLinkWorker, readScheduler };
