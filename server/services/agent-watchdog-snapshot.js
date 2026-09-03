/**
 * Agent watchdog snapshot — the ONE health read the external Hermes watchdog
 * polls (docs/hermes/waves-agent-watchdog-skill.md).
 *
 * Why it exists: the Hostinger Hermes box sits outside Railway, so it is the
 * only observer that can report the portal down, the database degraded, or the
 * scheduler silent. Everything it needs to judge that is already recorded:
 *   - job_health (advisory-locked crons) through the SAME classifier the Ops
 *     queue and the IB job-health tool use, so the three can never disagree;
 *   - the ops queue's per-lane pending / parked / failed counts;
 *   - the link-worker audit + prospect leases (Hermes's own claim → report loop).
 *
 * PII rule: this payload leaves the portal. Only COUNTS, job names and fixed
 * state words cross the wire — ops-queue item titles/hrefs carry customer
 * names and are dropped; job_health.last_error is only digit-masked, so it
 * stays inside too (the Agents → Queue tab shows it); a failing sub-read
 * reports a fixed `unavailable` marker, never its message.
 *
 * `reasons` are stable string keys (job:<name>:<state>, ops:<lane>:failed=<n>,
 * db:degraded, link_worker:stale_leases=<n>) so the Hermes side diffs them
 * against its last poll without a model call and pages only on CHANGE.
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

// A failed read reports ONLY that it is unavailable — the message stays in
// the server log (SQL/provider errors can carry bound customer data).
function contain(label, fn, fallback) {
  return fn().catch((err) => {
    logger.warn(`[agent-watchdog] ${label} read failed: ${err.message}`);
    return { ...fallback, available: false };
  });
}

async function readDatabase() {
  const started = Date.now();
  const ok = await isDatabaseReady(db);
  return { ok, latency_ms: Date.now() - started };
}

async function readJobs() {
  const health = await getScheduledJobHealth();
  return {
    available: true,
    total: health.total,
    unhealthy: health.unhealthy,
    items: health.jobs
      .filter((j) => ATTENTION_JOB_STATES.has(j.state))
      .map((j) => ({
        job: j.job,
        state: j.state,
        last_success_age_minutes: j.last_success_age_minutes,
        consecutive_failures: j.consecutive_failures,
      })),
  };
}

// Counts only — never the items (customer names live in the titles).
async function readOpsQueue() {
  if (!gateEnvValue('GATE_ADMIN_OPS_QUEUE')) {
    return { available: false, reason: 'GATE_ADMIN_OPS_QUEUE off', pending: 0, parked: 0, failed: 0, lanes: [] };
  }
  const q = await getOpsQueue();
  return {
    available: true,
    pending: q.totals.pending,
    parked: q.totals.parked,
    failed: q.totals.failed,
    lanes: q.lanes.map((l) => ({
      key: l.key,
      label: l.label,
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
function judge({ database, jobs, ops_queue: ops, link_worker: lw }) {
  const reasons = [];
  if (database && database.ok === false) reasons.push('db:degraded');
  if (jobs && jobs.available === false) reasons.push('jobs:unavailable');
  for (const j of (jobs && jobs.items) || []) reasons.push(`job:${j.job}:${j.state}`);
  if (ops && ops.available) {
    for (const l of ops.lanes || []) {
      if (l.error) reasons.push(`ops:${l.key}:error`);
      else if (l.failed > 0) reasons.push(`ops:${l.key}:failed=${l.failed}`);
    }
  }
  if (lw && lw.available === false) reasons.push('link_worker:unavailable');
  if (lw && lw.stale_leases > 0) reasons.push(`link_worker:stale_leases=${lw.stale_leases}`);
  return { verdict: reasons.length ? 'attention' : 'healthy', reasons };
}

async function buildWatchdogSnapshot() {
  const [database, jobs, opsQueue, linkWorker] = await Promise.all([
    contain('database', readDatabase, { ok: false, latency_ms: null }),
    contain('jobs', readJobs, { total: 0, unhealthy: 0, items: [] }),
    contain('ops_queue', readOpsQueue, { pending: 0, parked: 0, failed: 0, lanes: [] }),
    contain('link_worker', readLinkWorker, { last_claim_at: null, last_report_at: null, open_leases: 0, stale_leases: 0 }),
  ]);
  const parts = { database, jobs, ops_queue: opsQueue, link_worker: linkWorker };
  return {
    observed_at: new Date().toISOString(),
    environment: config.nodeEnv,
    uptime_s: Math.round(process.uptime()),
    ...parts,
    ...judge(parts),
  };
}

module.exports = { buildWatchdogSnapshot, STALE_LEASE_HOURS };
module.exports._test = { judge, readOpsQueue, readLinkWorker };
