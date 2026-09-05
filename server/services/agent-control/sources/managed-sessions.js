/**
 * Read adapter: Managed Agents sessions from the call ledger
 * (llm_dispatch_log row_kind='session', one cumulative row per session
 * written by recordSessionUsage; its session_turn rows are the steps) →
 * canonical runs keyed by provider_ref (the Anthropic session id).
 */

const db = require('../../../models/db');
const { pagedAtColumn, canonicalRun, humanize, keyset, notMirrored, isMissingSchema } = require('./shape');
const { classifyFailure } = require('../taxonomy');

const SOURCE = 'managed_sessions';
// recordSessionUsage inserts AFTER the runner finishes AND after its usage
// GET. The session's start is its FIRST turn's: the recorder persists the
// start the runner captured (started_at; the session row's is the LEAST
// across its RECORDED turns — Codex r12: created_at − latency_ms drifts
// late by the whole fetch, up to its timeout). Rows recorded before that
// column derive it: the first turn row's recording time minus its own latency (the
// session row's latency_ms is GREATEST across turns, so a longer later turn
// would move a start derived from it — and with it an already-paged row
// behind its cursor; pre-push audit), else the session row's own.
// The window and the display use that start; the PAGE key is the session
// row's own created_at (PAGED below). The
// latest activity is the newest turn's FINISH — its start + latency, the
// wall time the recorder measured before the usage GET (created_at is
// after it, so a slow fetch would push the finish and the duration out by
// the fetch; Codex r14) — created_at only for a row with no start: the
// WINDOW is judged on it, so a long-lived assistant conversation stays
// listed while it still turns instead of ageing out with its first turn
// (Codex r1).
const TURNS = "FROM llm_dispatch_log t WHERE t.row_kind = 'session_turn' AND t.provider_ref = llm_dispatch_log.provider_ref";
const TURN_START = 'COALESCE(t.started_at, t.created_at - make_interval(secs => COALESCE(t.latency_ms, 0) / 1000.0))';
const FIRST_TURN_START = `(SELECT ${TURN_START} ${TURNS} ORDER BY ${TURN_START} ASC LIMIT 1)`;
// LEAST, not COALESCE-first: a session that already had turns before the
// column existed carries the FIRST POST-COLUMN turn's start on its row,
// while the earlier turns are still reconstructable from their rows (Codex r17)
const SESSION_START = `COALESCE(LEAST(started_at, ${FIRST_TURN_START}), created_at - make_interval(secs => COALESCE(latency_ms, 0) / 1000.0))`;
// the page key: the session row's recording time, immutable (SESSION_START
// can move earlier when a re-record recovers a first turn; Codex r14); the
// window is judged on LAST_TURN
const PAGED = 'created_at';
const TURN_END = 'COALESCE(t.started_at + make_interval(secs => COALESCE(t.latency_ms, 0) / 1000.0), t.created_at)';
const LAST_TURN = `COALESCE((SELECT max(${TURN_END}) ${TURNS}), started_at + make_interval(secs => COALESCE(latency_ms, 0) / 1000.0), created_at)`;
const ID = 'provider_ref';
const COLUMNS = () => [
  'id', 'lane_id', 'workflow_id', 'provider_ref', 'ok', 'error_code', 'error_class', 'served_model', 'requested_model',
  'latency_ms', 'input_tokens', 'output_tokens', 'created_at', 'run_id', 'trace_id', 'workload',
  db.raw(`(SELECT count(*) ${TURNS}) AS turns`),
  db.raw(`(SELECT count(*) ${TURNS} AND t.ok IS NOT FALSE) AS turns_ok`),
  // shadows the raw column: the resolved start, whichever record carried it
  db.raw(`${SESSION_START} AS started_at`),
  db.raw(`${LAST_TURN} AS last_turn_at`),
  pagedAtColumn(db, 'created_at'),
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
    pagedAt: s.paged_at,
    // the latency for one turn; the wall span for a session that kept turning
    durationMs: s.latency_ms == null ? null : finishedAt.getTime() - startedAt.getTime(),
    // a failed turn (ok = false) is not done — the detail timeline labels it failed
    stepsDone: s.turns_ok == null ? turns : Number(s.turns_ok),
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
      .whereRaw(`${LAST_TURN} >= ?`, [from]), { source: SOURCE, idColumn: 'llm_dispatch_log.provider_ref' }), { start: PAGED, id: ID, cursor, limit });
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
    // aliased `t`: TURN_START is the list's expression, so the timeline orders the way the list starts
    const turns = await db({ t: 'llm_dispatch_log' })
      .select('t.id', 't.step_id', 't.ok', 't.error_code', 't.latency_ms', 't.input_tokens', 't.output_tokens', 't.created_at', 't.started_at')
      .where({ 't.row_kind': 'session_turn', 't.provider_ref': sessionId })
      .orderByRaw(`${TURN_START} ASC`);
    const run = fromRow(row);
    // a turn's start is the one the runner captured; a row recorded before
    // that column lands after the turn finished, so it is that minus its latency (Codex r5 / r12)
    run.steps = turns.map((t, i) => ({
      key: `turn_${i + 1}`, label: `Turn ${i + 1}`, status: t.ok === false ? 'failed' : 'done',
      detail: t.ok === false ? t.error_code || null : null, ms: t.latency_ms == null ? null : Number(t.latency_ms), toolName: null,
      startedAt: t.started_at ? new Date(t.started_at) : new Date(new Date(t.created_at).getTime() - Number(t.latency_ms || 0)), spanId: null,
    }));
    return { run };
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, list, get, fromRow };
