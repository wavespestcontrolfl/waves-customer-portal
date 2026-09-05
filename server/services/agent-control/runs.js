/**
 * Agent runs — the write API (agent-control S3). One supervised unit of
 * work = work item → run → attempt → steps, recorded in the agent_runs
 * family (migration 20260905000010) while GATE_AGENT_RUNS is on.
 *
 *   startRun(args)                   → handle (always; inert when the gate
 *                                      is off or the DB refused)
 *   runManaged(args, fn)             start → fn(handle) → finish / fail
 *   handle.heartbeat({ progress })   lease + heartbeat columns only, no event
 *   handle.step(spec, fn)            one timed agent_run_steps row around fn
 *   handle.wait(kind, reason) / resume()
 *   handle.checkpoint(data)          summary merge + event
 *   handle.finish({ result, disposition, summary, artifacts })
 *   handle.fail({ error, errorCode, failureClass, retryable })
 *
 * Contract: the BUSINESS PATH NEVER THROWS BECAUSE OF THIS LEDGER. Every
 * write is guarded — a failure logs once and the handle keeps working (or
 * goes inert). `step` re-throws the wrapped fn's error after recording it;
 * that is the caller's error, not the ledger's.
 *
 * Identity: `source_system` + `source_run_id` name the run (UNIQUE) so a
 * legacy ledger row mirrors onto one run and a retried start joins the
 * existing run instead of opening a second (INSERT … ON CONFLICT DO
 * NOTHING, then select). The work item is keyed the same way on
 * `source_ref`. Leases come from the lane policy (`stall_after_ms`);
 * heartbeats extend them.
 *
 * Retry: `fail({ retryable: true })` re-queues only when attempts <
 * max_attempts, an idempotency_key is set and the side-effect class is
 * neither money nor irreversible_external (a retry there could act twice).
 * A quality failure class (taxonomy QUALITY_FAILURE_CLASSES) also writes an
 * `eval_candidate` event — the hook S7's evaluations pick up; a no-op now.
 *
 * Budget: `step` past policy.budget.max_steps, or a tool step past
 * max_tool_calls, records one `budget_exceeded` event and stamps
 * summary.budget_exceeded — it does NOT stop the caller (a ledger never
 * decides business flow); `fail({ errorCode: 'budget_exhausted' })` is how
 * a caller that honours the budget reports it, and health.js reports
 * budget_risk on the way there.
 */

const os = require('os');
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { sanitizeJobError } = require('../../utils/cron-lock');
const { policyFor } = require('./lane-policies');
const { classifyFailure, isQualityFailure, riskTierFor, RESULT, DISPOSITION } = require('./taxonomy');
const context = require('./context');

const NO_RETRY_CLASSES = new Set(['money', 'irreversible_external']);
// Which taxonomy RESULT a failure lands on: by error code first, then class.
const CODE_RESULT = Object.freeze({ budget_exhausted: 'budget_exhausted' });
const CLASS_RESULT = Object.freeze({ timeout: 'timed_out' });
const WARN_INTERVAL_MS = 60_000;
const WORKER_ID = `${os.hostname()}:${process.pid}`.slice(0, 120);

let lastWarnAt = 0;
function warn(where, err) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  logger.warn(`[agent-runs] ${where} failed: ${err && err.message ? err.message : err}`);
}

function runGateOn() {
  return gateEnvValue('GATE_AGENT_RUNS');
}

// Every ledger write goes through here: a failure is logged (rate-limited)
// and swallowed, and the caller gets `fallback`.
async function guarded(where, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    warn(where, err);
    return fallback;
  }
}

function clip(value, max) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function jsonb(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

async function insertEvent(runId, eventType, message = null, metadata = null) {
  return guarded('run_events', () => db('run_events').insert({
    run_id: runId,
    event_type: clip(eventType, 40),
    message: clip(message, 2000),
    metadata: jsonb(metadata),
  }));
}

// ── Inert handle (gate off / DB refused) ─────────────────────────────

function inertHandle(args = {}) {
  const laneId = args.laneId || null;
  const noop = async () => null;
  return Object.freeze({
    inert: true,
    id: null,
    workItemId: null,
    attemptId: null,
    attemptNo: 0,
    traceId: args.traceId || context.current().traceId || context.newTraceId(),
    laneId,
    workflowId: args.workflowId || null,
    heartbeat: noop,
    wait: noop,
    resume: noop,
    checkpoint: noop,
    finish: noop,
    fail: async () => ({ retry: false }),
    // the wrapped work still runs, under the same step scope
    step: (spec, fn) => context.withStep(crypto.randomUUID(), () => fn()),
  });
}

// ── Start ────────────────────────────────────────────────────────────

async function upsertWorkItem(args, laneId, policy) {
  const wi = args.workItem;
  if (!wi || !wi.sourceRef) return null;
  const sourceSystem = clip(wi.sourceSystem || args.sourceSystem, 60);
  const sourceRef = clip(wi.sourceRef, 180);
  await db('work_items')
    .insert({
      lane_id: laneId,
      workflow_id: clip(args.workflowId, 80),
      source_system: sourceSystem,
      source_ref: sourceRef,
      entity_type: clip(wi.entityType, 80),
      entity_id: clip(wi.entityId, 120),
      customer_id: wi.customerId || null,
      title: clip(wi.title, 300),
      risk_tier: riskTierFor(policy.side_effect_class),
      priority: clip(wi.priority, 4),
    })
    .onConflict(['source_system', 'source_ref'])
    .ignore();
  const row = await db('work_items').where({ source_system: sourceSystem, source_ref: sourceRef }).first('id');
  return row ? row.id : null;
}

async function insertRun(args, laneId, policy, workItemId, traceId, now) {
  const sourceSystem = clip(args.sourceSystem, 60);
  const sourceRunId = clip(args.sourceRunId, 180);
  const lease = new Date(now.getTime() + policy.stall_after_ms);
  await db('agent_runs')
    .insert({
      work_item_id: workItemId,
      lane_id: laneId,
      workflow_id: clip(args.workflowId, 80),
      agent_version_id: args.agentVersionId || null,
      source_system: sourceSystem,
      source_run_id: sourceRunId,
      trace_id: traceId,
      lifecycle: 'running',
      worker_id: WORKER_ID,
      leased_at: now,
      lease_expires_at: lease,
      started_at: now,
      last_heartbeat_at: now,
      last_progress_at: now,
      attempts: 0,
      max_attempts: Math.max(1, Number(args.maxAttempts) || 1 + Number(policy.budget?.max_retries || 0)),
      idempotency_key: clip(args.idempotencyKey, 260),
      side_effect_class: policy.side_effect_class || null,
      risk_tier: riskTierFor(policy.side_effect_class),
      summary: jsonb(args.summary),
      link: clip(args.link, 2000),
    })
    .onConflict(['source_system', 'source_run_id'])
    .ignore();
  return db('agent_runs').where({ source_system: sourceSystem, source_run_id: sourceRunId }).first();
}

async function openAttempt(run, policy, now) {
  const attemptNo = Number(run.attempts || 0) + 1;
  const [attempt] = await db('agent_attempts')
    .insert({ run_id: run.id, attempt_no: attemptNo, worker_id: WORKER_ID, started_at: now })
    .onConflict(['run_id', 'attempt_no'])
    .ignore()
    .returning('id');
  const attemptId = attempt ? attempt.id || attempt : (await db('agent_attempts').where({ run_id: run.id, attempt_no: attemptNo }).first('id'))?.id || null;
  // A reopened run gets a fresh lease and a clean current outcome — the
  // previous attempt's result and error live on in agent_attempts.
  await db('agent_runs').where({ id: run.id }).update({
    attempts: attemptNo,
    lifecycle: 'running',
    worker_id: WORKER_ID,
    leased_at: now,
    lease_expires_at: new Date(now.getTime() + policy.stall_after_ms),
    started_at: run.started_at || now,
    finished_at: null,
    result: null,
    disposition: null,
    failure_class: null,
    error_code: null,
    error_message: null,
    last_heartbeat_at: now,
    updated_at: now,
  });
  return { attemptId, attemptNo };
}

/**
 * startRun({ laneId, workflowId, sourceSystem, sourceRunId, workItem?,
 *            traceId?, idempotencyKey?, maxAttempts?, agentVersionId?,
 *            summary?, link? })
 * Requires laneId or workflowId (CHECK constraint) and sourceSystem +
 * sourceRunId (UNIQUE key). Returns a handle; never throws.
 */
async function startRun(args = {}) {
  if (!runGateOn()) return inertHandle(args);
  if (!args.sourceSystem || !args.sourceRunId || (!args.laneId && !args.workflowId)) {
    warn('startRun', new Error('sourceSystem, sourceRunId and laneId|workflowId are required'));
    return inertHandle(args);
  }
  const laneId = args.laneId ? clip(args.laneId, 80) : null;
  const policy = policyFor(laneId);
  const ambient = context.current();
  const traceId = args.traceId || ambient.traceId || context.newTraceId();
  const now = new Date();

  const opened = await guarded('startRun', async () => {
    const workItemId = await upsertWorkItem(args, laneId, policy);
    const run = await insertRun(args, laneId, policy, workItemId, traceId, now);
    if (!run) throw new Error('run row missing after insert');
    const resumed = Number(run.attempts || 0) > 0 || run.lifecycle !== 'running';
    const { attemptId, attemptNo } = await openAttempt(run, policy, now);
    await insertEvent(run.id, resumed ? 'resumed' : 'started', null, { attempt: attemptNo, worker: WORKER_ID });
    return { run, attemptId, attemptNo, workItemId: run.work_item_id || workItemId };
  });
  if (!opened) return inertHandle(args);
  return liveHandle({ ...opened, laneId, policy, traceId, workflowId: args.workflowId || null });
}

// ── Live handle ──────────────────────────────────────────────────────

function liveHandle({ run, attemptId, attemptNo, workItemId, laneId, policy, traceId, workflowId }) {
  const runId = run.id;
  const budget = policy.budget || {};
  let seq = 0;
  let toolCalls = 0;
  let budgetFlagged = false;
  let progress = Number(run.progress_sequence || 0);

  async function touch(patch, extendLease = true) {
    const now = new Date();
    return guarded('heartbeat', () => db('agent_runs').where({ id: runId }).update({
      last_heartbeat_at: now,
      ...(extendLease ? { lease_expires_at: new Date(now.getTime() + policy.stall_after_ms) } : {}),
      updated_at: now,
      ...patch,
    }));
  }

  async function heartbeat({ progress: progressed = false } = {}) {
    const patch = {};
    if (progressed) {
      progress += 1;
      patch.progress_sequence = progress;
      patch.last_progress_at = new Date();
    }
    return touch(patch);
  }

  async function flagBudget(kind) {
    if (budgetFlagged) return;
    budgetFlagged = true;
    await guarded('budget', () => db('agent_runs').where({ id: runId }).update({
      summary: db.raw("summary || ?::jsonb", [jsonb({ budget_exceeded: kind })]),
      updated_at: new Date(),
    }));
    await insertEvent(runId, 'budget_exceeded', null, { kind, max_steps: budget.max_steps, max_tool_calls: budget.max_tool_calls });
  }

  async function step({ key, label = null, toolName = null } = {}, fn) {
    seq += 1;
    if (toolName) toolCalls += 1;
    if (budget.max_steps && seq > budget.max_steps) await flagBudget('steps');
    else if (toolName && budget.max_tool_calls && toolCalls > budget.max_tool_calls) await flagBudget('tool_calls');
    const stepId = crypto.randomUUID();
    const startedAt = new Date();
    // The row is written INSIDE the step scope so its span ids are the ones
    // every ledger call row made by fn records (context.withStep mints
    // them): step ↔ calls link on span_id.
    const open = () => {
      const scope = context.current();
      return guarded('step.open', () => db('agent_run_steps').insert({
        id: stepId,
        run_id: runId,
        attempt_id: attemptId,
        seq,
        step_key: clip(key || `step_${seq}`, 80),
        label: clip(label, 200),
        status: 'running',
        tool_name: clip(toolName, 120),
        started_at: startedAt,
        span_id: scope.spanId || null,
        parent_span_id: scope.parentSpanId || null,
      }));
    };
    const close = (status, detail) => {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      if (toolName) {
        // one tool ledger: the IB tool-health recorder, keyed back by run id
        const { recordToolEvent } = require('../intelligence-bar/tool-events');
        recordToolEvent({
          source: 'agent_run', context: laneId || workflowId, toolName, success: status === 'done', durationMs,
          errorMessage: status === 'done' ? null : detail, metadata: { run_id: runId, step_id: stepId },
        });
      }
      return guarded('step.close', () => db('agent_run_steps').where({ id: stepId }).update({
        status, finished_at: finishedAt, duration_ms: durationMs, detail: clip(detail, 2000),
      }));
    };
    return context.withStep(stepId, async () => {
      await open();
      try {
        const value = await fn();
        await close('done', null);
        await heartbeat({ progress: true });
        return value;
      } catch (err) {
        await close('failed', sanitizeJobError(err && err.message ? err.message : err));
        await touch({});
        throw err;
      }
    });
  }

  async function wait(kind = 'external', reason = null) {
    const lifecycle = kind === 'human' ? 'waiting_human' : 'waiting_external';
    await touch({ lifecycle, last_progress_at: new Date() }, false);
    await insertEvent(runId, 'waiting', clip(reason, 2000), { kind });
  }

  async function resume(reason = null) {
    await touch({ lifecycle: 'running', last_progress_at: new Date() });
    await insertEvent(runId, 'resumed', clip(reason, 2000));
  }

  async function checkpoint(data = {}) {
    await touch({ summary: db.raw('summary || ?::jsonb', [jsonb(data)]), last_progress_at: new Date() });
    await insertEvent(runId, 'checkpoint', null, data);
  }

  async function writeArtifacts(artifacts) {
    if (!Array.isArray(artifacts) || !artifacts.length) return;
    const rows = artifacts
      .filter((a) => a && a.kind)
      .map((a) => ({
        run_id: runId,
        kind: clip(a.kind, 12),
        label: clip(a.label, 200),
        ref: clip(a.ref, 4000),
        content_redacted: clip(a.content, 8192),
        redaction_confidence: clip(a.redactionConfidence, 8),
      }));
    if (rows.length) await guarded('artifacts', () => db('run_artifacts').insert(rows));
  }

  async function closeAttempt(result, failure = {}) {
    if (!attemptId) return;
    await guarded('attempt.close', () => db('agent_attempts').where({ id: attemptId }).update({
      finished_at: new Date(),
      result,
      failure_class: failure.failureClass || null,
      error_code: clip(failure.errorCode, 80),
      error_message: failure.errorMessage || null,
    }));
  }

  async function finish({ result = 'succeeded', disposition = null, summary = null, artifacts = null } = {}) {
    const now = new Date();
    const res = RESULT.includes(result) ? result : 'succeeded';
    const dispo = DISPOSITION.includes(disposition) ? disposition : null;
    await guarded('finish', () => db('agent_runs').where({ id: runId }).update({
      lifecycle: 'terminal',
      result: res,
      disposition: dispo,
      // a successful retry clears the previous attempt's error from the
      // run's current outcome (it stays on that attempt row)
      failure_class: null,
      error_code: null,
      error_message: null,
      finished_at: now,
      last_heartbeat_at: now,
      lease_expires_at: null,
      ...(summary ? { summary: db.raw('summary || ?::jsonb', [jsonb(summary)]) } : {}),
      updated_at: now,
    }));
    if (workItemId && res === 'succeeded') {
      await guarded('work_item.done', () => db('work_items').where({ id: workItemId }).update({ status: 'done', updated_at: now }));
    }
    await writeArtifacts(artifacts);
    await closeAttempt(res);
    await insertEvent(runId, 'finished', null, { result: res, disposition: dispo });
    if (dispo) await insertEvent(runId, 'disposition', null, { disposition: dispo });
  }

  async function fail({ error = null, errorCode = null, failureClass = null, retryable = false } = {}) {
    const now = new Date();
    const err = error && typeof error === 'object' ? error : { message: error, code: null };
    const code = clip(errorCode ?? err.code, 80);
    const message = sanitizeJobError(err.message ?? code ?? 'failed');
    const klass = failureClass ?? classifyFailure(code ?? message);
    const canRetry = retryable
      && attemptNo < Number(run.max_attempts)
      && !!run.idempotency_key
      && !NO_RETRY_CLASSES.has(policy.side_effect_class);
    const result = CODE_RESULT[code] ?? CLASS_RESULT[klass] ?? 'errored';
    const outcome = canRetry
      ? { lifecycle: 'queued', result: null, finished_at: null, event: 'retry_scheduled' }
      : { lifecycle: 'terminal', result, finished_at: now, event: 'failed' };
    await closeAttempt(result, { failureClass: klass, errorCode: code, errorMessage: message });
    await guarded('fail', () => db('agent_runs').where({ id: runId }).update({
      lifecycle: outcome.lifecycle,
      result: outcome.result,
      failure_class: klass,
      error_code: code,
      error_message: message,
      finished_at: outcome.finished_at,
      last_heartbeat_at: now,
      lease_expires_at: null,
      updated_at: now,
    }));
    await insertEvent(runId, outcome.event, message, { failure_class: klass, error_code: code, attempt: attemptNo, result: outcome.result });
    if (isQualityFailure(klass)) await insertEvent(runId, 'eval_candidate', null, { failure_class: klass });
    return { retry: canRetry, failureClass: klass, result: outcome.result };
  }

  return Object.freeze({
    inert: false,
    id: runId,
    workItemId: workItemId || null,
    attemptId: attemptId || null,
    attemptNo,
    traceId,
    laneId,
    workflowId,
    heartbeat,
    step,
    wait,
    resume,
    checkpoint,
    finish,
    fail,
  });
}

/**
 * runManaged(startArgs, fn) — start a run, execute fn(handle) inside the
 * run's context scope (runInRun + runInLane when a lane is given), then
 * finish on return or fail on throw (the error is re-thrown unchanged). fn
 * may return `{ result, disposition, summary, artifacts }` to shape the
 * finish; any other value finishes as succeeded and is returned.
 */
async function runManaged(startArgs, fn) {
  const handle = await startRun(startArgs);
  const scoped = () => context.runInRun({
    runId: handle.id,
    workItemId: handle.workItemId,
    attemptId: handle.attemptId,
    traceId: handle.traceId,
    agentVersionId: startArgs.agentVersionId || null,
    workflowId: startArgs.workflowId || null,
  }, () => fn(handle));
  const body = () => (startArgs.laneId ? context.runInLane(startArgs.laneId, scoped) : scoped());
  try {
    const value = await body();
    const shaped = value && typeof value === 'object' && !Array.isArray(value) && ('result' in value || 'disposition' in value || 'summary' in value || 'artifacts' in value);
    await handle.finish(shaped ? value : {});
    return value;
  } catch (err) {
    await handle.fail({ error: err, errorCode: err && err.code, retryable: !!(err && err.retryable) });
    throw err;
  }
}

module.exports = { startRun, runManaged, runGateOn, WORKER_ID, NO_RETRY_CLASSES };
