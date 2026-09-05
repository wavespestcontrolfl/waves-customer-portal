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
 * Paging is a keyset cursor over (startedAt desc, key) so a run that lands
 * between two pages never shifts the next page. Read-only.
 */

const db = require('../../models/db');
const modelSwitchboard = require('../model-switchboard');
const { policyFor } = require('./lane-policies');
const { deriveHealth } = require('./health');
const { resolveWindow } = require('./hub-read');
const { runGateOn } = require('./runs');
const { isMissingSchema } = require('./sources/shape');
const agentRuns = require('./sources/agent-runs');
const autonomousRuns = require('./sources/autonomous-runs');
const messageDrafts = require('./sources/message-drafts');
const agentDecisions = require('./sources/agent-decisions');
const callLog = require('./sources/call-log');
const jobHealth = require('./sources/job-health');
const managedSessions = require('./sources/managed-sessions');

const LEGACY_SOURCES = [autonomousRuns, messageDrafts, agentDecisions, callLog, jobHealth, managedSessions];
const SOURCES = new Map([agentRuns, ...LEGACY_SOURCES].map((s) => [s.SOURCE, s]));
const STATUSES = Object.freeze(['all', 'active', 'waiting', 'attention', 'done', 'failed']);
const ACTIVE = new Set(['queued', 'leased', 'running', 'waiting_external']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Per source, per read. Six legacy ledgers × this is the merge's upper bound.
const FETCH_LIMIT = 400;
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
  return `${run.startedAt || run.createdAt || ''}|${run.key}`;
}

function encodeCursor(run) {
  return Buffer.from(JSON.stringify({ at: run.startedAt || run.createdAt || '', key: run.key }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.key !== 'string') throw new Error('shape');
    return `${parsed.at || ''}|${parsed.key}`;
  } catch {
    throw badRequest('bad cursor');
  }
}

async function loadSources({ window, laneId, sourceFilter = null }) {
  const args = { from: window.from, to: null, laneId, limit: FETCH_LIMIT };
  const readers = [agentRuns, ...LEGACY_SOURCES].filter((s) => !sourceFilter || sourceFilter(s));
  const results = await Promise.all(readers.map((s) => s.list(args)));
  const unavailable = [];
  const canonicalKeys = new Set();
  const runs = [];
  results.forEach((r, i) => {
    const source = readers[i];
    if (r.unavailable) unavailable.push(source.SOURCE);
    for (const run of r.runs) {
      const mirrorKey = `${run.sourceSystem}:${run.sourceRunId}`;
      if (run.canonical) {
        canonicalKeys.add(mirrorKey);
        runs.push(run);
      } else if (!canonicalKeys.has(mirrorKey)) {
        runs.push(run);
      }
    }
  });
  return { runs, unavailable };
}

function validate({ preset, status, area, lane, now }) {
  const checks = [
    ['window', preset, (v) => !!resolveWindow(v, now)],
    ['status', status, (v) => STATUSES.includes(v)],
    ['area', area, (v) => !v || modelSwitchboard.AREAS.some((a) => a.key === v)],
    ['lane', lane, (v) => !v || knownLane(v)],
  ];
  for (const [name, value, ok] of checks) if (!ok(value)) throw badRequest(`unknown ${name}: ${value}`);
}

async function listRuns({ lane = null, area = null, status = 'all', window: preset = '7d', cursor = null, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  validate({ preset, status, area, lane, now });
  const window = resolveWindow(preset, now);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const after = decodeCursor(cursor);

  // A lane filter skips the single-lane adapters that cannot match.
  const sourceFilter = lane ? (s) => !s.LANE || s.LANE === lane : null;
  const loaded = await loadSources({ window, laneId: lane, sourceFilter });
  const scoped = loaded.runs
    .map((run) => annotate(run, now))
    .filter((run) => (!lane || run.laneId === lane) && (!area || run.area === area));

  const counts = { all: scoped.length, active: 0, waiting: 0, attention: 0, done: 0, failed: 0 };
  for (const run of scoped) for (const [k, hit] of Object.entries(bucketsOf(run))) counts[k] += Number(hit);
  const filtered = status === 'all' ? scoped : scoped.filter((run) => bucketsOf(run)[status]);
  filtered.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  const page = (after ? filtered.filter((run) => sortKey(run) < after) : filtered).slice(0, pageSize + 1);
  const runs = page.slice(0, pageSize);
  return {
    runs,
    counts,
    nextCursor: page.length > pageSize ? encodeCursor(runs[runs.length - 1]) : null,
    window: { key: window.key, from: window.from.toISOString(), to: window.to.toISOString() },
    unavailableSources: loaded.unavailable,
    phases: { runs: runGateOn() },
    generatedAt: now.toISOString(),
  };
}

async function loadCalls({ canonicalId = null, sessionId = null }) {
  if (!canonicalId && !sessionId) return [];
  try {
    return await db('llm_dispatch_log')
      .select(CALL_COLUMNS)
      .whereIn('row_kind', ['call', 'session_turn'])
      .where((q) => {
        if (canonicalId) q.where('run_id', canonicalId);
        if (sessionId) q.orWhere({ provider_ref: sessionId });
      })
      .orderBy('created_at', 'asc')
      .limit(500);
  } catch (err) {
    if (isMissingSchema(err)) return [];
    throw err;
  }
}

const NO_CANONICAL = Object.freeze({ attempts: [], artifacts: [], events: [], workItem: null });

async function getRun(source, id, { now = new Date() } = {}) {
  const reader = SOURCES.get(String(source));
  if (!reader) throw badRequest(`unknown source: ${source}`);
  if (!id) throw badRequest('missing id');

  const legacy = reader === agentRuns ? null : await reader.get(id);
  if (reader !== agentRuns && !legacy) return null;
  const canonicalId = reader === agentRuns ? id : await agentRuns.findMirror(reader.SOURCE, id);
  const canonical = canonicalId ? await agentRuns.get(canonicalId) : null;
  if (!canonical && !legacy) return null;

  const primary = canonical || legacy;
  const secondary = legacy || canonical;
  const steps = primary.run.steps.length ? primary.run.steps : secondary.run.steps;
  const run = annotate({ ...primary.run, steps, stepsDone: steps.filter((s) => s.status === 'done').length, stepsTotal: steps.length }, now);
  const detail = canonical || NO_CANONICAL;
  const calls = await loadCalls({ canonicalId: canonical ? canonical.run.id : null, sessionId: reader === managedSessions ? id : null });
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
    trace: { id: run.traceId, calls: calls.length },
    legacy: legacy && canonical ? { source: reader.SOURCE, id: String(id) } : null,
  };
}

module.exports = { listRuns, getRun, STATUSES, SOURCES: Object.freeze([...SOURCES.keys()]), annotate, bucketsOf };
