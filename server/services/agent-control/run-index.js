/**
 * Run index (agent-control S3) — one list and one detail read over every
 * run ledger: the canonical agent_runs family first, then the legacy
 * ledgers through sources/*.js, deduped on (source_system, source_run_id)
 * so a legacy row a lane already mirrors into agent_runs appears once.
 *
 *   listRuns({ lane, area, status, window, cursor, limit, now })
 *   getRun(source, id, { now })
 *
 * Windows are the Control center's ET presets (hub-read.resolveWindow);
 * live runs (not terminal) are listed however old they are. Health and
 * attention are derived per row by health.js against the lane policy —
 * never stored. Status buckets:
 *   active     queued | leased | running | waiting_external
 *   waiting    waiting_human
 *   attention  health ≠ healthy, a human wait past the policy alert, or a
 *              terminal run that did not succeed
 *   done       terminal + succeeded
 *   failed     terminal + not succeeded
 *
 * Paging is a keyset cursor over (pagedAt desc, key) — pagedAt is each
 * source's IMMUTABLE creation / recording stamp, never the active span it
 * displays as startedAt (which moves on a resume, a scheduled send, a
 * publishing claim: a row crossing the cursor would repeat or vanish;
 * Codex r14) — so a run that lands or changes between two pages never
 * shifts the next page. Read-only.
 */

const db = require('../../models/db');
const modelSwitchboard = require('../model-switchboard');
const { policyFor } = require('./lane-policies');
const { deriveHealth } = require('./health');
const { resolveWindow } = require('./hub-read');
const { runGateOn } = require('./runs');
const { isMissingSchema, defined } = require('./sources/shape');
const agentRuns = require('./sources/agent-runs');
const autonomousRuns = require('./sources/autonomous-runs');
const messageDrafts = require('./sources/message-drafts');
const agentDecisions = require('./sources/agent-decisions');
const callLog = require('./sources/call-log');
const jobHealth = require('./sources/job-health');
const managedSessions = require('./sources/managed-sessions');

const LEGACY_SOURCES = [autonomousRuns, messageDrafts, agentDecisions, callLog, jobHealth, managedSessions];
const SOURCES = new Map([agentRuns, ...LEGACY_SOURCES].map((s) => [s.SOURCE, s]));
// Sources keyed by a uuid column (job_health = job name, managed_sessions =
// the provider's session id). An id that is not a uuid matches nothing —
// and asked of PostgreSQL it is a 22P02 error, not a miss — so it is
// answered here: not found for a read, a bad cursor for a bookmark.
const UUID_KEYED = new Set([agentRuns, autonomousRuns, messageDrafts, agentDecisions, callLog].map((s) => s.SOURCE));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyed = (source, id) => !UUID_KEYED.has(source) || UUID_RE.test(String(id));
const STATUSES = Object.freeze(['all', 'active', 'waiting', 'attention', 'done', 'failed']);
const ACTIVE = new Set(['queued', 'leased', 'running', 'waiting_external']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// First page: every source is read up to this many rows inside the window
// so the status counts cover the window (countsCapped says when a source
// hit it — a cursor still walks past it).
const COUNT_SCAN_LIMIT = 2000;
const CALL_COLUMNS = [
  'id', 'created_at', 'provider', 'requested_model', 'served_model', 'ok', 'error_code', 'error_class', 'fallback_used',
  'input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens', 'latency_ms',
  'lane_id', 'chain_id', 'step_id', 'span_id', 'parent_span_id', 'prompt_version', 'trace_id', 'row_kind',
];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

let laneIds = null;
function knownLane(laneId) {
  if (!laneIds) laneIds = new Set(modelSwitchboard.LANES.map((l) => l.id));
  return laneIds.has(laneId);
}

function annotate(run, now) {
  const policy = policyFor(run.laneId);
  const { health, reason, attention } = deriveHealth(run, policy, now);
  return { ...run, health, healthReason: reason, attention };
}

function bucketsOf(run) {
  const failedTerminal = run.lifecycle === 'terminal' && run.result !== 'succeeded';
  return {
    active: ACTIVE.has(run.lifecycle),
    waiting: run.lifecycle === 'waiting_human',
    attention: run.health !== 'healthy' || !!run.attention || failedTerminal,
    done: run.lifecycle === 'terminal' && run.result === 'succeeded',
    failed: failedTerminal,
  };
}

function sortKey(run) {
  return `${run.pagedAt || run.createdAt || ''}|${run.key}`;
}

function validate({ preset, status, area, lane, limit, now }) {
  const checks = [
    ['window', preset, (v) => !!resolveWindow(v, now)],
    ['status', status, (v) => STATUSES.includes(v)],
    ['area', area, (v) => !v || modelSwitchboard.AREAS.some((a) => a.key === v)],
    ['lane', lane, (v) => !v || knownLane(v)],
    // an integer page size, or the default; a float / word can neither slice nor snapshot a cursor
    ['limit', limit, (v) => v === DEFAULT_LIMIT || Number.isInteger(Number(v))],
  ];
  for (const [name, value, ok] of checks) if (!ok(value)) throw badRequest(`unknown ${name}: ${value}`);
}

const LIST_DEFAULTS = Object.freeze({ lane: null, area: null, status: 'all', window: '7d', cursor: null, limit: DEFAULT_LIMIT, now: null });

// Cursor = every source's keyset position { at, id } after the last row
// that source contributed (or was read past) — base64url JSON. `at` is the
// row's pagedAt stamp as TEXT (microsecond precision), bound as-is to the
// adapter's raw column compare.
function encodeCursor(positions) {
  const p = {};
  for (const [source, pos] of positions) if (pos) p[source] = [pos.at, pos.id];
  return Buffer.from(JSON.stringify({ p }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.p !== 'object' || !parsed.p) throw new Error('shape');
    const positions = new Map();
    for (const [source, pair] of Object.entries(parsed.p)) {
      if (!SOURCES.has(source) || !Array.isArray(pair) || typeof pair[1] !== 'string' || !keyed(source, pair[1])) throw new Error('shape');
      const at = typeof pair[0] === 'string' ? pair[0] : null;
      if (!at || Number.isNaN(new Date(at).getTime())) throw new Error('shape');
      positions.set(source, { at, id: pair[1] });
    }
    return positions;
  } catch {
    throw badRequest('bad cursor');
  }
}

function positionOf(run) {
  return { at: run.pagedAt, id: run.id };
}

function countBuckets(scoped) {
  const counts = { all: scoped.length, active: 0, waiting: 0, attention: 0, done: 0, failed: 0 };
  for (const run of scoped) for (const [k, hit] of Object.entries(bucketsOf(run))) counts[k] += Number(hit);
  return counts;
}

// One page: a k-way merge over the sources, newest pagedAt first. Every
// source is read from its own keyset position (the cursor) in slices —
// the whole window on the first page (the counting scan, COUNT_SCAN_LIMIT
// per source), `pageSize + 1` on cursor pages — and refilled when its
// slice runs dry while another source still has rows, so a page never
// ends early because one slice held only filtered-out rows. Legacy rows a
// canonical run mirrors are excluded by each adapter's SQL anti-join
// (sources/shape.js notMirrored), so no per-request dedupe state exists.
// A scan that spends MAX_SCAN_ROUNDS on non-matching rows returns an EMPTY
// page WITH the advanced cursor — the client keeps paging.
const MAX_SCAN_ROUNDS = 8;

// The merge step: yields the newest head across the sources, advancing that
// source's position, for as long as every source that may still hold newer
// rows has a head to compare — it returns when one runs dry (the caller
// refills) or all are spent.
function* readyRows(state) {
  for (;;) {
    const sources = [...state.values()];
    if (sources.some((st) => !st.done && !st.buf.length)) return;
    const heads = sources.filter((st) => st.buf.length);
    if (!heads.length) return;
    const top = heads.reduce((best, st) => (sortKey(st.buf[0]) > sortKey(best.buf[0]) ? st : best));
    const run = top.buf.shift();
    top.pos = positionOf(run);
    yield run;
  }
}

async function collectPage({ window, lane, area, status, after, pageSize, now }) {
  const readers = [agentRuns, ...LEGACY_SOURCES].filter((s) => !lane || !s.LANE || s.LANE === lane);
  const scan = after ? pageSize + 1 : COUNT_SCAN_LIMIT;
  const inScope = (run) => (!lane || run.laneId === lane) && (!area || run.area === area);
  const matches = (run) => status === 'all' || bucketsOf(run)[status];
  const state = new Map(readers.map((s) => [s.SOURCE, { reader: s, pos: (after && after.get(s.SOURCE)) || null, buf: [], done: false }]));
  const unavailable = [];
  const page = [];
  let counts = null;
  let capped = false;
  let snapshot = null;

  for (let round = 0; round < MAX_SCAN_ROUNDS; round += 1) {
    const dry = [...state.values()].filter((st) => !st.done && !st.buf.length);
    if (!dry.length) break; // round 0: every source is dry
    await Promise.all(dry.map(async (st) => {
      const r = await st.reader.list({ from: window.from, cursor: st.pos, laneId: lane, limit: scan });
      if (r.unavailable) unavailable.push(st.reader.SOURCE);
      st.done = r.runs.length < scan;
      st.buf = r.runs.map((run) => annotate(run, now));
    }));
    if (round === 0) {
      capped = [...state.values()].some((st) => !st.done);
      if (!after) counts = countBuckets([...state.values()].flatMap((st) => st.buf).filter(inScope));
    }
    for (const run of readyRows(state)) {
      if (inScope(run) && matches(run)) {
        page.push(run);
        if (page.length === pageSize) snapshot = new Map([...state].map(([k, st]) => [k, st.pos]));
      }
      if (page.length > pageSize) break;
    }
    if (page.length > pageSize || [...state.values()].every((st) => st.done && !st.buf.length)) break;
  }
  const runs = page.slice(0, pageSize);
  // more = a further match was seen, or some source still has unread rows;
  // an empty page then still carries the advanced positions
  const more = page.length > pageSize || [...state.values()].some((st) => !st.done || st.buf.length);
  const positions = snapshot || new Map([...state].map(([k, st]) => [k, st.pos]));
  return { runs, counts, countsCapped: !after && capped, nextCursor: more ? encodeCursor(positions) : null, unavailable };
}

async function listRuns(params = {}) {
  const { lane, area, status, window: preset, cursor, limit } = { ...LIST_DEFAULTS, ...defined(params) };
  const now = params.now ?? new Date();
  validate({ preset, status, area, lane, limit, now });
  const window = resolveWindow(preset, now);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const after = decodeCursor(cursor);
  const page = await collectPage({ window, lane, area, status, after, pageSize, now });
  return {
    runs: page.runs,
    counts: page.counts,
    countsCapped: page.countsCapped,
    nextCursor: page.nextCursor,
    window: { key: window.key, from: window.from.toISOString(), to: window.to.toISOString() },
    unavailableSources: page.unavailable,
    phases: { runs: runGateOn() },
    generatedAt: now.toISOString(),
  };
}

// The detail's call ledger: the NEWEST calls up to the cap (the terminal
// failure under investigation is at the end), oldest first, with `capped`
// saying older calls exist beyond it (Codex r8).
const CALLS_CAP = 500;
const NO_CALLS = Object.freeze({ calls: [], capped: false });

async function loadCalls({ canonicalId = null, sessionId = null }) {
  if (!canonicalId && !sessionId) return NO_CALLS;
  try {
    const rows = await db('llm_dispatch_log')
      .select(CALL_COLUMNS)
      .whereIn('row_kind', ['call', 'session_turn'])
      .where((q) => {
        if (canonicalId) q.where('run_id', canonicalId);
        if (sessionId) q.orWhere({ provider_ref: sessionId });
      })
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(CALLS_CAP + 1);
    return { calls: rows.slice(0, CALLS_CAP).reverse(), capped: rows.length > CALLS_CAP };
  } catch (err) {
    if (isMissingSchema(err)) return NO_CALLS;
    throw err;
  }
}

const NO_CANONICAL = Object.freeze({ attempts: [], artifacts: [], events: [], workItem: null });

// Both doors lead to the same pair: a legacy id finds its canonical mirror
// (findMirror); a canonical id finds the legacy row it mirrors by its
// source_system + source_run_id, when that system is a ledger read here.
async function resolveSides(reader, id) {
  if (reader === agentRuns) {
    const canonical = await agentRuns.get(id);
    const legacyReader = canonical ? SOURCES.get(canonical.run.sourceSystem) : null;
    const legacy = legacyReader && legacyReader !== agentRuns && keyed(legacyReader.SOURCE, canonical.run.sourceRunId) ? await legacyReader.get(canonical.run.sourceRunId) : null;
    return { canonical, legacy, legacySource: legacy ? legacyReader : null };
  }
  // both sides independently: a legacy row that was pruned (llm_dispatch_log
  // keeps 30 days) or deleted still has its durable mirror (Codex r4)
  const [legacy, canonicalId] = await Promise.all([reader.get(id), agentRuns.findMirror(reader.SOURCE, id)]);
  return { canonical: canonicalId ? await agentRuns.get(canonicalId) : null, legacy, legacySource: legacy ? reader : null };
}

async function getRun(source, id, { now = new Date() } = {}) {
  const reader = SOURCES.get(String(source));
  if (!reader) throw badRequest(`unknown source: ${source}`);
  if (!id) throw badRequest('missing id');
  if (!keyed(reader.SOURCE, id)) return null;
  const { canonical, legacy, legacySource } = await resolveSides(reader, id);
  if (!canonical && !legacy) return null;

  const primary = canonical || legacy;
  const secondary = legacy || canonical;
  const steps = primary.run.steps.length ? primary.run.steps : secondary.run.steps;
  // the timeline lists every step; the counts (and so budget health) stay
  // the run's own — the current attempt's for a canonical run
  const run = annotate({ ...primary.run, steps }, now);
  const detail = canonical || NO_CANONICAL;
  const { calls, capped } = await loadCalls({ canonicalId: canonical ? canonical.run.id : null, sessionId: legacySource === managedSessions ? legacy.run.id : null });
  return {
    run,
    workItem: detail.workItem,
    attempts: detail.attempts,
    steps,
    calls,
    artifacts: detail.artifacts,
    evaluations: [],
    humanReviews: [],
    events: detail.events,
    trace: { id: run.traceId, calls: calls.length, capped },
    legacy: legacy && canonical ? { source: legacySource.SOURCE, id: legacy.run.id } : null,
  };
}

module.exports = { listRuns, getRun, STATUSES, SOURCES: Object.freeze([...SOURCES.keys()]), annotate, bucketsOf };
