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
// recordSessionUsage inserts AFTER the runner finishes. The session's
// start is its FIRST turn's: that turn row's recording time minus its own
// latency (the session row's latency_ms is GREATEST across turns, so a
// longer later turn would move a start derived from it — and with it an
// already-paged row behind its cursor; pre-push audit). A session recorded
// before turn rows existed falls back to its own created_at − latency.
// Sort / page on that same start so the cursor and the rows agree. The
// latest activity is the newest session_turn row (created_at for a
// one-turn session): that is the finish, and the WINDOW is judged on it,
// so a long-lived assistant conversation stays listed while it still
// turns instead of ageing out with its first turn (Codex r1).
const TURNS = "FROM llm_dispatch_log t WHERE t.row_kind = 'session_turn' AND t.provider_ref = llm_dispatch_log.provider_ref";
const FIRST_TURN_START = `(SELECT t.created_at - make_interval(secs => COALESCE(t.latency_ms, 0) / 1000.0) ${TURNS} ORDER BY t.created_at ASC LIMIT 1)`;
const SESSION_START = `COALESCE(${FIRST_TURN_START}, created_at - make_interval(secs => COALESCE(latency_ms, 0) / 1000.0))`;
const START = () => db.raw(`date_trunc('milliseconds', ${SESSION_START})`);
const LAST_TURN = `COALESCE((SELECT max(t.created_at) ${TURNS}), created_at)`;
const ID = 'provider_ref';
const COLUMNS = () => [
  'id', 'lane_id', 'workflow_id', 'provider_ref', 'ok', 'error_code', 'error_class', 'served_model', 'requested_model',
  'latency_ms', 'input_tokens', 'output_tokens', 'created_at', 'run_id', 'trace_id', 'workload',
  db.raw(`(SELECT count(*) ${TURNS}) AS turns`),
  db.raw(`${SESSION_START} AS started_at`),
  db.raw(`${LAST_TURN} AS last_turn_at`),
];

function fromRow(s) {
  const turns = Number(s.turns || 0);
  const errored = s.ok === false;
  // start = the first turn's (SESSION_START; the same fallback when a row
  // carries no started_at); the finish is the newest turn (= created_at for one turn)
  const startedAt = s.started_at ? new Date(s.started_at) : new Date(new Date(s.created_at).getTime() - Number(s.latency_ms || 0));
  const finishedAt = new Date(s.last_turn_at || s.created_at);
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
    finishedAt,
    // the latency for one turn; the wall span for a session that kept turning
    durationMs: s.latency_ms == null ? null : finishedAt.getTime() - startedAt.getTime(),
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
  return db('llm_dispatch_log').select(COLUMNS()).where({ row_kind: 'session' }).whereNotNull('provider_ref')
    .where((q) => q.whereNull('workload').orWhere('workload', 'live'));
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(baseQuery()
      // windowed on the latest turn, paged on the start (see LAST_TURN)
      .whereRaw(`${LAST_TURN} >= ?`, [from]), { source: SOURCE, idColumn: 'llm_dispatch_log.provider_ref' }), { start: START(), id: ID, cursor, limit });
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
