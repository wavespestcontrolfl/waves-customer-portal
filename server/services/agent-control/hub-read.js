/**
 * Agent-control hub read (S2d, phase 1) — the Control center's numbers,
 * read from the call ledger (llm_dispatch_log row_kind call / session,
 * written under GATE_LLM_CALL_LEDGER) and folded onto the model switchboard's
 * lane catalog. Read-only; nothing here writes.
 *
 *   readAreas({ window })                 one card per product area
 *   readLanes({ area, window, status })   one row per lane, with status
 *
 * Windows are ET calendar windows (utils/datetime-et.js): `today` = ET
 * midnight → now, bucketed by hour; `7d` / `30d` = the last N ET days
 * including today, bucketed by day. `deltaVsPrior` compares against the
 * window of the same length ending where this one starts.
 *
 * Status (highest wins): `attention` — an attention reason on the lane
 * (ledger error rate > 20 % over the last hour with ≥ 5 calls; a failed
 * ops-queue row or a failed / blocked Activity item mapped to the lane by
 * SOURCE_LANE below); `active` — ≥ 1 ledger row in the window; else `idle`.
 * Incidents proper (open admin_alerts on a lane) arrive with S4; until then
 * the p0…p3 counts come from the reasons above (P1 failed, P2 blocked).
 *
 * The ops-queue and Activity reads are each behind their own gate and each
 * isolated: unavailable → that source contributes no reasons, never an
 * error. Cost (`estCostUsd`), runs and verification are null until S6 / S3
 * / S7 fill them in.
 */

const db = require('../../models/db');
const logger = require('../logger');
const modelSwitchboard = require('../model-switchboard');
const { policyFor } = require('./lane-policies');
const { riskTierFor } = require('./taxonomy');
const { gateEnvValue } = require('../../config/feature-gates');
const { etParts, etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const TABLE = 'llm_dispatch_log';
const TZ = 'America/New_York';
const WINDOWS = Object.freeze({ today: { days: 1, unit: 'hour' }, '7d': { days: 7, unit: 'day' }, '30d': { days: 30, unit: 'day' } });
const STATUSES = Object.freeze(['all', 'active', 'attention', 'idle']);
const STATUS_RANK = Object.freeze({ attention: 0, active: 1, idle: 2 });

// Ledger error-rate rule: over the trailing hour, at least this many calls
// and more than this share failed.
const ERROR_RATE_MIN_CALLS = 5;
const ERROR_RATE_THRESHOLD = 0.2;

// Which switchboard lane a failed row in another read belongs to. Coarse by
// design — each queue lane / Activity kind is one pipeline whose model work
// is one lane — and only the pipelines whose failures ARE that lane's
// failures are listed: report delivery, follow-ups and admin alerts are
// business rows, not model outcomes. S4 replaces this with per-lane
// incidents.
const SOURCE_LANE = Object.freeze({
  queue: Object.freeze({ calls: 'call_extraction', content: 'blog_draft', ib: 'ib_admin' }),
  activity: Object.freeze({ content_run: 'blog_draft', sms_draft: 'sms_draft' }),
});

function readGateOn() {
  return gateEnvValue('GATE_AGENT_CONTROL_READ');
}

// ── Windows ──────────────────────────────────────────────────────────

function etStartOfDay(date) {
  return parseETDateTime(`${etDateString(date)}T00:00`);
}

// { key, unit, from, to, prior:{from,to}, buckets:[key…] } or null for an
// unknown preset. Bucket keys match the SQL to_char formats below so a
// quiet bucket still renders as a zero.
function resolveWindow(preset = '7d', now = new Date()) {
  const spec = WINDOWS[preset];
  if (!spec) return null;
  const from = etStartOfDay(addETDays(now, -(spec.days - 1)));
  const to = now;
  const prior = { from: new Date(from.getTime() - (to.getTime() - from.getTime())), to: from };
  const buckets = [];
  if (spec.unit === 'hour') {
    const { hour } = etParts(now);
    const day = etDateString(now);
    for (let h = 0; h <= hour; h += 1) buckets.push(`${day}T${String(h).padStart(2, '0')}`);
  } else {
    for (let d = spec.days - 1; d >= 0; d -= 1) buckets.push(etDateString(addETDays(now, -d)));
  }
  return { key: preset, unit: spec.unit, from, to, prior, buckets };
}

// ── Ledger SQL ───────────────────────────────────────────────────────

// Only live work counts: a replay / sealed / backfill evaluator keeps the
// production lane_id with its workload stamped, and would otherwise inflate
// the lane's calls, tokens and error rate (Codex r1 P1). null = a call made
// outside any agent-control scope = live.
const LIVE_WORKLOAD = "(workload IS NULL OR workload = 'live')";

// When a row happened. A call row happens at created_at. A session row is
// ONE row per Managed Agents session, re-recorded after every turn with
// cumulative usage and latency_ms = GREATEST(now - startedAt) — the session
// duration — while created_at stays the first write; its activity is the
// end of that span, so a session that crosses ET midnight lands in the
// window it last moved in, not the one it started in (Codex r1 P2).
const ACTIVITY_AT = "(CASE WHEN row_kind = 'session' THEN created_at + COALESCE(latency_ms, 0) * interval '1 millisecond' ELSE created_at END)";
// Index-friendly pre-filter for the activity window: a session lives at most
// its hard_timeout (1 h, lane-policies AGENT_SESSION), so created_at can be
// at most that far before its activity — 2 h keeps a margin.
const SESSION_LOOKBACK_MS = 2 * 60 * 60 * 1000;

function ledgerRows(from, to) {
  return db(TABLE)
    .whereIn('row_kind', ['call', 'session'])
    .whereNotNull('lane_id')
    .whereRaw(LIVE_WORKLOAD)
    .where('created_at', '>=', new Date(from.getTime() - SESSION_LOOKBACK_MS))
    .andWhere('created_at', '<', to)
    .whereRaw(`${ACTIVITY_AT} >= ? AND ${ACTIVITY_AT} < ?`, [from, to]);
}

// Per-lane aggregates over [from, to).
function laneAggregates(from, to) {
  return ledgerRows(from, to).groupBy('lane_id').select(
    'lane_id',
    db.raw('COUNT(*)::int AS calls'),
    db.raw('COUNT(*) FILTER (WHERE ok)::int AS ok_calls'),
    db.raw('COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens'),
    db.raw('COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens'),
    db.raw('COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens'),
    db.raw('COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens'),
    db.raw('(percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS p50_latency_ms'),
    db.raw('(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS p95_latency_ms'),
    db.raw(`MAX(${ACTIVITY_AT}) AS last_active_at`),
  );
}

// The trailing hour the error-rate rule reads — its own range, NOT a filter
// inside the display window: right after ET midnight the `today` window
// starts inside that hour and would clip it (pre-push audit P1).
function recentAggregates(since, to) {
  return ledgerRows(since, to).groupBy('lane_id').select(
    'lane_id',
    db.raw('COUNT(*)::int AS recent_calls'),
    db.raw('COUNT(*) FILTER (WHERE NOT ok)::int AS recent_errors'),
  );
}

// Fallback rate lives on the chain rows (one per dispatchWithFallback chain,
// `fallback_used` when the primary leg missed); call rows only know their
// own provider.
function chainAggregates(from, to) {
  return db(TABLE)
    .where('row_kind', 'chain')
    .whereNotNull('lane_id')
    .whereRaw(LIVE_WORKLOAD)
    .where('created_at', '>=', from)
    .andWhere('created_at', '<', to)
    .groupBy('lane_id')
    .select(
      'lane_id',
      db.raw('COUNT(*)::int AS chains'),
      db.raw('COUNT(*) FILTER (WHERE fallback_used)::int AS fallbacks'),
    );
}

// Sparkline buckets: ET hour or ET day, keyed as text so the bucket never
// passes through a timezone-dependent Date parse. `created_at` is
// timestamptz — one AT TIME ZONE yields the ET wall clock (waves-db §2).
function bucketRows(from, to, unit) {
  const fmt = unit === 'hour' ? 'YYYY-MM-DD"T"HH24' : 'YYYY-MM-DD';
  const bucket = db.raw(`to_char(date_trunc(?, ${ACTIVITY_AT} AT TIME ZONE ?), ?)`, [unit, TZ, fmt]);
  // GROUP BY the output alias: binding the expression twice would number
  // its parameters differently and Postgres would not match the two.
  return ledgerRows(from, to)
    .groupBy('lane_id', 'bucket')
    .select(
      'lane_id',
      db.raw('? AS bucket', [bucket]),
      db.raw('COUNT(*)::int AS calls'),
      db.raw('COUNT(*) FILTER (WHERE NOT ok)::int AS errors'),
    );
}

// The area p95 has to come from the latency rows themselves — a percentile
// of lane percentiles is not a percentile (pre-push audit P1). The lane →
// area map is JS-side, so it rides in as a VALUES list.
function areaLatency(from, to, laneArea) {
  if (!laneArea.length) return Promise.resolve([]);
  const values = laneArea.map(() => '(?, ?)').join(', ');
  return db(TABLE)
    .joinRaw(`JOIN (VALUES ${values}) AS m(lane_id, area) ON m.lane_id = ${TABLE}.lane_id`, laneArea.flat())
    .whereIn('row_kind', ['call', 'session'])
    .whereNotNull('latency_ms')
    .whereRaw(LIVE_WORKLOAD)
    .where('created_at', '>=', new Date(from.getTime() - SESSION_LOOKBACK_MS))
    .andWhere('created_at', '<', to)
    .whereRaw(`${ACTIVITY_AT} >= ? AND ${ACTIVITY_AT} < ?`, [from, to])
    .groupBy('m.area')
    .select(
      'm.area',
      db.raw('(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms'),
    );
}

async function loadLedger(window, now) {
  const recentSince = new Date(now.getTime() - 60 * 60 * 1000);
  const [current, prior, chains, buckets, recent] = await Promise.all([
    laneAggregates(window.from, window.to),
    laneAggregates(window.prior.from, window.prior.to),
    chainAggregates(window.from, window.to),
    bucketRows(window.from, window.to, window.unit),
    recentAggregates(recentSince, now),
  ]);
  return { current, prior, chains, buckets, recent };
}

// ── Other sources (each gated, each isolated) ────────────────────────

async function loadQueueReasons() {
  if (!gateEnvValue('GATE_ADMIN_OPS_QUEUE')) return [];
  try {
    const { getOpsQueue } = require('../ops-queue');
    const queue = await getOpsQueue();
    const reasons = [];
    for (const lane of queue.lanes || []) {
      const laneId = SOURCE_LANE.queue[lane.key];
      if (!laneId || !(lane.failed > 0)) continue;
      reasons.push({ laneId, priority: 'P1', kind: 'queue_failed', detail: `${lane.failed} failed in ${lane.label}` });
    }
    return reasons;
  } catch (err) {
    logger.warn(`[agent-control] hub read: ops queue unavailable: ${err.message}`);
    return [];
  }
}

async function loadActivityReasons(windowHours) {
  if (!gateEnvValue('GATE_AGENT_ACTIVITY')) return [];
  try {
    const { getActivity } = require('../agent-activity');
    const feed = await getActivity({ windowHours });
    if (!feed.available) return [];
    const counts = new Map();
    for (const item of feed.items || []) {
      const laneId = SOURCE_LANE.activity[item.kind];
      if (!laneId || (item.status !== 'failed' && item.status !== 'blocked')) continue;
      const key = `${laneId}:${item.status}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].map(([key, n]) => {
      const [laneId, status] = key.split(':');
      return {
        laneId,
        priority: status === 'failed' ? 'P1' : 'P2',
        kind: `activity_${status}`,
        detail: `${n} ${status} run${n === 1 ? '' : 's'} in the Activity feed`,
      };
    });
  } catch (err) {
    logger.warn(`[agent-control] hub read: activity unavailable: ${err.message}`);
    return [];
  }
}

// ── Assembly (pure) ──────────────────────────────────────────────────

const num = (v) => (v == null ? 0 : Number(v));
const rate = (part, whole) => (whole > 0 ? part / whole : null);
const round = (v, places = 3) => (v == null ? null : Number(v.toFixed(places)));

function emptyAttention() {
  return { p0: 0, p1: 0, p2: 0, p3: 0 };
}

function countAttention(reasons) {
  const out = emptyAttention();
  for (const r of reasons) out[r.priority.toLowerCase()] += 1;
  return out;
}

function sparkFor(window, rows) {
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return window.buckets.map((key) => {
    const r = byBucket.get(key);
    return { t: key, calls: r ? num(r.calls) : 0, errors: r ? num(r.errors) : 0 };
  });
}

function sumSparks(sparks, window) {
  return window.buckets.map((key, i) => ({
    t: key,
    calls: sparks.reduce((n, s) => n + (s[i]?.calls || 0), 0),
    errors: sparks.reduce((n, s) => n + (s[i]?.errors || 0), 0),
  }));
}

function laneReasons(recent, extra) {
  const reasons = [...extra];
  const recentCalls = num(recent?.recent_calls);
  const recentErrors = num(recent?.recent_errors);
  if (recentCalls >= ERROR_RATE_MIN_CALLS && recentErrors / recentCalls > ERROR_RATE_THRESHOLD) {
    reasons.push({
      priority: 'P1',
      kind: 'error_rate',
      detail: `${recentErrors} of ${recentCalls} calls failed in the last hour`,
    });
  }
  return reasons;
}

function riskTierOf(sideEffectClass) {
  if (!sideEffectClass) return null;
  try { return riskTierFor(sideEffectClass); } catch { return null; }
}

/**
 * Fold the switchboard lanes, their runtime policies, the ledger rows and
 * the external attention reasons into hub lane rows. Pure: every input is
 * an argument, so the assembly is testable without the DB.
 */
function buildLanes({ lanes, window, ledger, reasons = [] }) {
  const current = new Map(ledger.current.map((r) => [r.lane_id, r]));
  const prior = new Map(ledger.prior.map((r) => [r.lane_id, r]));
  const chains = new Map(ledger.chains.map((r) => [r.lane_id, r]));
  const recent = new Map((ledger.recent || []).map((r) => [r.lane_id, r]));
  const buckets = new Map();
  for (const r of ledger.buckets) {
    if (!buckets.has(r.lane_id)) buckets.set(r.lane_id, []);
    buckets.get(r.lane_id).push(r);
  }
  const extraByLane = new Map();
  for (const r of reasons) {
    if (!extraByLane.has(r.laneId)) extraByLane.set(r.laneId, []);
    extraByLane.get(r.laneId).push({ priority: r.priority, kind: r.kind, detail: r.detail });
  }

  return lanes.map((lane) => {
    const row = current.get(lane.id) || null;
    const metrics = laneMetrics(row, prior.get(lane.id) || null, chains.get(lane.id) || null);
    const attentionReasons = laneReasons(recent.get(lane.id) || null, extraByLane.get(lane.id) || []);
    return {
      ...laneIdentity(lane, policyFor(lane.id)),
      status: attentionReasons.length ? 'attention' : metrics.calls > 0 ? 'active' : 'idle',
      ...metrics,
      attention: countAttention(attentionReasons),
      attentionReasons,
      spark: sparkFor(window, buckets.get(lane.id) || []),
      runs: null,
      cost: null,
      verification: null,
    };
  });
}

// The static half of a lane row: the switchboard entry + its runtime policy.
function laneIdentity(lane, policy) {
  return {
    id: lane.id,
    name: lane.name,
    describe: lane.describe,
    area: lane.area,
    modelNow: lane.primary?.model || null,
    backup: lane.fallback?.model || null,
    continuity: lane.continuity,
    maturity: policy.maturity,
    riskTier: riskTierOf(policy.side_effect_class),
    sideEffectClass: policy.side_effect_class,
    ledger: policy.ledger,
    unrecordableReason: policy.ledger === 'unrecordable' ? policy.unrecordable_reason || null : null,
  };
}

// The ledger half: this window's aggregate row, the prior window's, and the
// chain row the fallback rate comes from — any of them null for a quiet lane.
function laneMetrics(row, before, chain) {
  const calls = num(row?.calls);
  const okRate = rate(num(row?.ok_calls), calls);
  const priorCalls = num(before?.calls);
  const priorOkRate = rate(num(before?.ok_calls), priorCalls);
  return {
    calls,
    okRate: round(okRate),
    fallbackRate: round(rate(num(chain?.fallbacks), num(chain?.chains))),
    p50LatencyMs: row?.p50_latency_ms == null ? null : num(row.p50_latency_ms),
    p95LatencyMs: row?.p95_latency_ms == null ? null : num(row.p95_latency_ms),
    tokens: {
      input: num(row?.input_tokens),
      cachedInput: num(row?.cached_input_tokens),
      output: num(row?.output_tokens),
      reasoning: num(row?.reasoning_tokens),
    },
    estCostUsd: null,
    lastActiveAt: row?.last_active_at ? new Date(row.last_active_at).toISOString() : null,
    deltaVsPrior: {
      calls: calls - priorCalls,
      okRate: okRate == null || priorOkRate == null ? null : round(okRate - priorOkRate),
    },
  };
}

// Area numbers come from the RAW ledger counts (ok calls, chains,
// fallbacks summed per area — weighted by construction) and the area-level
// percentile query; the lane rows only supply membership and the per-lane
// sparks, which sum exactly.
function buildAreas({ areas, laneRows, window, ledger }) {
  const areaOf = new Map(laneRows.map((l) => [l.id, l.area]));
  const sumBy = (rows, field) => {
    const out = new Map();
    for (const r of rows) {
      const area = areaOf.get(r.lane_id);
      if (area) out.set(area, (out.get(area) || 0) + num(r[field]));
    }
    return out;
  };
  const okCalls = sumBy(ledger.current, 'ok_calls');
  const chains = sumBy(ledger.chains, 'chains');
  const fallbacks = sumBy(ledger.chains, 'fallbacks');
  const p95 = new Map((ledger.areaLatency || []).map((r) => [r.area, num(r.p95_latency_ms)]));
  return areas.map((area) => {
    const rows = laneRows.filter((l) => l.area === area.key);
    const calls = rows.reduce((n, l) => n + l.calls, 0);
    const attention = emptyAttention();
    for (const l of rows) for (const k of Object.keys(attention)) attention[k] += l.attention[k];
    const priorCalls = rows.reduce((n, l) => n + (l.calls - l.deltaVsPrior.calls), 0);
    return {
      key: area.key,
      label: area.label,
      description: area.description,
      lanes: rows.length,
      calls,
      attention,
      okRate: round(rate(okCalls.get(area.key) || 0, calls)),
      fallbackRate: round(rate(fallbacks.get(area.key) || 0, chains.get(area.key) || 0)),
      p95LatencyMs: p95.has(area.key) ? p95.get(area.key) : null,
      estCostUsd: null,
      deltaVsPrior: { calls: calls - priorCalls },
      spark: sumSparks(rows.map((l) => l.spark), window),
    };
  });
}

function phases() {
  return { ledger: readGateOn(), runs: false, cost: false, verification: false };
}

function basisFor(window) {
  return {
    source: TABLE,
    rowKinds: ['call', 'session'],
    workloads: ['live'],
    // A session row is attributed to the window of its last activity; its
    // latency_ms is the session duration, so a session lane's p50 / p95 read
    // as session durations.
    sessionAttribution: 'last_activity',
    // Off = no new rows are being written; what is shown is history.
    ledgerRecording: gateEnvValue('GATE_LLM_CALL_LEDGER'),
    window: { key: window.key, from: window.from.toISOString(), to: window.to.toISOString(), unit: window.unit },
  };
}

async function loadHub(window, now) {
  const [ledger, queueReasons, activityReasons] = await Promise.all([
    loadLedger(window, now),
    loadQueueReasons(),
    loadActivityReasons(window.key === '30d' ? 168 : 24),
  ]);
  const { lanes } = modelSwitchboard.getSwitchboard();
  return { ledger, laneRows: buildLanes({ lanes, window, ledger, reasons: [...queueReasons, ...activityReasons] }) };
}

/**
 * GET /control/lanes — every lane (optionally one area, one status), sorted
 * attention → active → idle, then by calls desc, then name.
 */
async function readLanes({ area = null, window: preset = '7d', status = 'all', now = new Date() } = {}) {
  const window = resolveWindow(preset, now);
  if (!window) throw badRequest(`window must be one of ${Object.keys(WINDOWS).join(', ')}`);
  if (!STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  if (area && !modelSwitchboard.AREAS.some((a) => a.key === area)) throw badRequest(`unknown area: ${area}`);
  const { laneRows: all } = await loadHub(window, now);
  const scoped = area ? all.filter((l) => l.area === area) : all;
  const counts = { all: scoped.length, active: 0, attention: 0, idle: 0 };
  for (const l of scoped) counts[l.status] += 1;
  const lanes = (status === 'all' ? scoped : scoped.filter((l) => l.status === status))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.calls - a.calls || a.name.localeCompare(b.name));
  return { generatedAt: now.toISOString(), phases: phases(), basis: basisFor(window), counts, lanes };
}

/** GET /control/areas — one card per switchboard area. */
async function readAreas({ window: preset = '7d', now = new Date() } = {}) {
  const window = resolveWindow(preset, now);
  if (!window) throw badRequest(`window must be one of ${Object.keys(WINDOWS).join(', ')}`);
  const { ledger, laneRows } = await loadHub(window, now);
  ledger.areaLatency = await areaLatency(window.from, window.to, laneRows.map((l) => [l.id, l.area]));
  return {
    generatedAt: now.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    basis: basisFor(window),
    areas: buildAreas({ areas: modelSwitchboard.AREAS, laneRows, window, ledger }),
  };
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

module.exports = {
  readAreas,
  readLanes,
  readGateOn,
  // exported for tests
  resolveWindow,
  buildLanes,
  buildAreas,
  laneAggregates,
  recentAggregates,
  chainAggregates,
  bucketRows,
  areaLatency,
  SOURCE_LANE,
  WINDOWS,
  STATUSES,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_THRESHOLD,
};
