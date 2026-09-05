/**
 * Read adapter: the canonical agent_runs family (S3 migration). Rows are
 * already in the taxonomy vocabulary; this projects columns → shape and
 * loads the timeline for one run.
 */

const db = require('../../../models/db');
const { pagedAtColumn, canonicalRun, keyset, isMissingSchema } = require('./shape');

const SOURCE = 'agent_runs';

function fromRow(run, steps = []) {
  const summary = run.summary && typeof run.summary === 'object' ? run.summary : {};
  return canonicalRun({
    source: SOURCE,
    id: run.id,
    sourceSystem: run.source_system,
    sourceRunId: run.source_run_id,
    laneId: run.lane_id,
    workflowId: run.workflow_id,
    title: summary.title || run.work_item_title || null,
    subtitle: [run.workflow_id && run.lane_id ? run.workflow_id : null, run.attempts > 1 ? `attempt ${run.attempts}` : null].filter(Boolean).join(' · ') || null,
    lifecycle: run.lifecycle,
    result: run.result,
    verification: run.verification,
    disposition: run.disposition,
    failureClass: run.failure_class,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    createdAt: run.created_at,
    pagedAt: run.paged_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    lastHeartbeatAt: run.last_heartbeat_at,
    lastProgressAt: run.last_progress_at,
    progressSequence: run.progress_sequence,
    attempts: run.attempts,
    maxAttempts: run.max_attempts,
    stepsDone: run.steps_done != null ? Number(run.steps_done) : undefined,
    stepsTotal: run.steps_total != null ? Number(run.steps_total) : undefined,
    toolCalls: run.tool_calls != null ? Number(run.tool_calls) : 0,
    steps: steps.map((s) => ({
      id: s.id,
      key: s.step_key,
      label: s.label || s.step_key,
      status: s.status,
      detail: s.detail || null,
      ms: s.duration_ms == null ? null : Number(s.duration_ms),
      toolName: s.tool_name || null,
      attemptNo: s.attempt_no == null ? null : Number(s.attempt_no),
      startedAt: s.started_at,
      finishedAt: s.finished_at,
      spanId: s.span_id || null,
    })),
    sideEffectClass: run.side_effect_class,
    link: run.link,
    detail: run.error_message || summary.detail || null,
    entity: run.entity_type ? { type: run.entity_type, id: run.entity_id } : null,
    workItemId: run.work_item_id,
    traceId: run.trace_id,
    canonical: true,
  });
}

// The window is judged on the active span (started_at moves on a reopen /
// resume; created_at backs a queued row that never started). The page key
// is the raw created_at — the run's pagedAt — which the writer stamps ONCE
// (agent_runs_created_idx serves the scan). Paging on the span let a
// resumed run cross the cursor and repeat or vanish (Codex r14).
const START = () => db.raw('COALESCE(r.started_at, r.created_at)');
const PAGED = 'r.created_at';
const ID = 'r.id';
// Step / tool-call counts are the CURRENT attempt's (attempt_no = r.attempts):
// health.js reads them against the per-run budget, and a retry starts
// its budget over. Steps with no attempt (a pre-attempt write) count too.
const CURRENT_ATTEMPT = "(s.attempt_id IS NULL OR s.attempt_id = (SELECT a.id FROM agent_attempts a WHERE a.run_id = r.id AND a.attempt_no = r.attempts))";
const STEP_COUNTS = () => [
  db.raw(`(SELECT count(*) FROM agent_run_steps s WHERE s.run_id = r.id AND ${CURRENT_ATTEMPT} AND s.status = 'done') AS steps_done`),
  db.raw(`(SELECT count(*) FROM agent_run_steps s WHERE s.run_id = r.id AND ${CURRENT_ATTEMPT}) AS steps_total`),
  db.raw(`(SELECT count(*) FROM agent_run_steps s WHERE s.run_id = r.id AND ${CURRENT_ATTEMPT} AND s.tool_name IS NOT NULL) AS tool_calls`),
];

function baseQuery() {
  return db('agent_runs as r')
    .leftJoin('work_items as w', 'w.id', 'r.work_item_id')
    .select('r.*', 'w.title as work_item_title', 'w.entity_type', 'w.entity_id', pagedAtColumn(db, 'r.created_at'), ...STEP_COUNTS());
}

async function list({ from, cursor = null, laneId = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(baseQuery()
      .where((q) => {
        // live runs stay listed however old; terminal ones by the window
        q.where('r.lifecycle', '<>', 'terminal');
        q.orWhere(START(), '>=', from);
      })
      .modify((q) => { if (laneId) q.where('r.lane_id', laneId); }), { start: PAGED, id: ID, cursor, limit });
    return { runs: rows.map((r) => fromRow(r)), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const run = await baseQuery().where('r.id', id).first();
    if (!run) return null;
    const [steps, attempts, artifacts, events, workItem] = await Promise.all([
      // every attempt's steps, in attempt order then seq (seq is per run,
      // but a pre-fix retry may have restarted it)
      db('agent_run_steps as s').leftJoin('agent_attempts as a', 'a.id', 's.attempt_id').select('s.*', 'a.attempt_no')
        .where('s.run_id', id).orderBy([{ column: 'a.attempt_no', order: 'asc' }, { column: 's.seq', order: 'asc' }, { column: 's.started_at', order: 'asc' }]),
      db('agent_attempts').where({ run_id: id }).orderBy('attempt_no', 'asc'),
      db('run_artifacts').where({ run_id: id }).orderBy('created_at', 'asc'),
      // seq = insertion order: a transition's events share one transaction timestamp
      db('run_events').where({ run_id: id }).orderBy([{ column: 'seq', order: 'asc' }, { column: 'created_at', order: 'asc' }]),
      run.work_item_id ? db('work_items').where({ id: run.work_item_id }).first() : null,
    ]);
    return { run: fromRow(run, steps), attempts, artifacts, events, workItem: workItem || null };
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

// The mirror lookup run-index dedupes on: canonical rows keyed by the
// legacy ledger they shadow.
async function findMirror(sourceSystem, sourceRunId) {
  try {
    const run = await baseQuery().where({ 'r.source_system': sourceSystem, 'r.source_run_id': String(sourceRunId) }).first();
    return run ? run.id : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, list, get, findMirror, fromRow };
