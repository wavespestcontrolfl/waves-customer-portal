/**
 * Read adapter: Managed Agents sessions from the call ledger
 * (llm_dispatch_log row_kind='session', one cumulative row per session
 * written by recordSessionUsage; its session_turn rows are the steps) →
 * canonical runs keyed by provider_ref (the Anthropic session id).
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, keyset, notMirrored, isMissingSchema } = require('./shape');
const { classifyFailure } = require('../taxonomy');

const SOURCE = 'managed_sessions';
// recordSessionUsage inserts AFTER the runner finishes: created_at is the
// recording time (= the finish); the start is that minus latency_ms (the
// wall time since the runner's startedAt). Sort / page on the same
// projected start so the cursor and the rows agree. A session the
// assistant re-records per turn keeps its first turn's created_at and its
// longest turn's latency — an approximation, stated in the subtitle.
const START = db.raw("date_trunc('milliseconds', created_at - make_interval(secs => COALESCE(latency_ms, 0) / 1000.0))");
const ID = 'provider_ref';
const COLUMNS = [
  'id', 'lane_id', 'workflow_id', 'provider_ref', 'ok', 'error_code', 'error_class', 'served_model', 'requested_model',
  'latency_ms', 'input_tokens', 'output_tokens', 'created_at', 'run_id', 'trace_id', 'workload',
  db.raw("(SELECT count(*) FROM llm_dispatch_log t WHERE t.row_kind = 'session_turn' AND t.provider_ref = llm_dispatch_log.provider_ref) AS turns"),
];

function fromRow(s) {
  const turns = Number(s.turns || 0);
  const errored = s.ok === false;
  // the row lands when the session is billed: start = that minus its latency
  const startedAt = new Date(new Date(s.created_at).getTime() - Number(s.latency_ms || 0));
  return canonicalRun({
    source: SOURCE,
    id: s.provider_ref,
    laneId: s.lane_id,
    workflowId: s.workflow_id,
    title: `${humanize(s.lane_id) || 'Managed agent'} session`,
    subtitle: [s.served_model || s.requested_model, turns ? `${turns} turn${turns === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || null,
    // a session row exists once a runner has billed it: the session is over
    lifecycle: 'terminal',
    result: errored ? 'errored' : 'succeeded',
    failureClass: errored ? s.error_class || classifyFailure(s.error_code || 'error') : null,
    errorCode: errored ? s.error_code : null,
    createdAt: startedAt,
    startedAt,
    finishedAt: s.created_at,
    durationMs: s.latency_ms == null ? null : Number(s.latency_ms),
    stepsDone: turns,
    stepsTotal: turns,
    steps: [],
    link: '/admin/agents?tab=models',
    entity: { type: 'managed_session', id: s.provider_ref },
    traceId: s.trace_id || null,
    workItemId: null,
  });
}

function baseQuery() {
  return db('llm_dispatch_log').select(COLUMNS).where({ row_kind: 'session' }).whereNotNull('provider_ref')
    .where((q) => q.whereNull('workload').orWhere('workload', 'live'));
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(baseQuery()
      .where(START, '>=', from), { source: SOURCE, idColumn: 'llm_dispatch_log.provider_ref' }), { start: START, id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(sessionId) {
  try {
    const row = await baseQuery().where({ provider_ref: sessionId }).first();
    if (!row) return null;
    const turns = await db('llm_dispatch_log')
      .select('id', 'step_id', 'ok', 'error_code', 'latency_ms', 'input_tokens', 'output_tokens', 'created_at')
      .where({ row_kind: 'session_turn', provider_ref: sessionId })
      .orderBy('created_at', 'asc');
    const run = fromRow(row);
    run.steps = turns.map((t, i) => ({
      key: `turn_${i + 1}`, label: `Turn ${i + 1}`, status: t.ok === false ? 'failed' : 'done',
      detail: t.ok === false ? t.error_code || null : null, ms: t.latency_ms == null ? null : Number(t.latency_ms), toolName: null,
      startedAt: t.created_at, spanId: null,
    }));
    return { run };
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, list, get, fromRow };
