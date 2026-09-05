/**
 * Read adapter: Managed Agents sessions from the call ledger
 * (llm_dispatch_log row_kind='session', one cumulative row per session
 * written by recordSessionUsage; its session_turn rows are the steps) →
 * canonical runs keyed by provider_ref (the Anthropic session id).
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, isMissingSchema } = require('./shape');
const { classifyFailure } = require('../taxonomy');

const SOURCE = 'managed_sessions';
const START = 'created_at';
const COLUMNS = [
  'id', 'lane_id', 'workflow_id', 'provider_ref', 'ok', 'error_code', 'error_class', 'served_model', 'requested_model',
  'latency_ms', 'input_tokens', 'output_tokens', 'created_at', 'run_id', 'trace_id', 'workload',
  db.raw("(SELECT count(*) FROM llm_dispatch_log t WHERE t.row_kind = 'session_turn' AND t.provider_ref = llm_dispatch_log.provider_ref) AS turns"),
];

function fromRow(s) {
  const turns = Number(s.turns || 0);
  const errored = s.ok === false;
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
    createdAt: s.created_at,
    startedAt: s.created_at,
    finishedAt: s.latency_ms == null ? s.created_at : new Date(new Date(s.created_at).getTime() + Number(s.latency_ms)),
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

async function list({ from, before = null, limit = 200 } = {}) {
  try {
    const rows = await baseQuery()
      .where(START, '>=', from)
      .modify((q) => { if (before) q.where(START, '<=', before); })
      .orderBy(START, 'desc')
      .limit(limit);
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
