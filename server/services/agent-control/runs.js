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
const { classifyFailure, isQualityFailure, riskTierFor, RESULT, DISPOSITION, FAILURE_CLASS } = require('./taxonomy');
const context = require('./context');

const NO_RETRY_CLASSES = new Set(['money', 'irreversible_external']);
// Which taxonomy RESULT a failure lands on: by error code first, then class.
const CODE_RESULT = Object.freeze({ budget_exhausted: 'budget_exhausted' });
// run_artifacts.kind CHECK (migration 20260905000010): anything else would
// reject the whole batch insert and lose the valid artifacts beside it.
const ARTIFACT_KINDS = new Set(['draft', 'report', 'json', 'url', 'record_ref']);
const CLASS_RESULT = Object.freeze({ timeout: 'timed_out' });
const WARN_INTERVAL_MS = 60_000;
const WORKER_ID = `${os.hostname()}:${process.pid}`.slice(0, 120);

let lastWarnAt = 0;
// Logs the operation and the driver's error CODE only: a knex error message
// carries the compiled SQL, and a ledger write carries work-item titles,
// summaries and artifact text (AGENTS.md: no PII in logs).
function warn(where, err) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const code = (err && (err.code || err.name)) || 'error';
  logger.warn(`[agent-runs] ${where} failed (${code})`);
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

// Serialisation is part of the ledger write: a caller's summary with a
// cycle or a BigInt must not throw into the business path either.
// A workflow-only run (no lane) has no side-effect class and so no tier.
function tierFor(policy) {
  return policy.side_effect_class ? riskTierFor(policy.side_effect_class) : null;
}

function jsonb(value) {
  try {
    return JSON.stringify(value && typeof value === 'object' ? value : {});
  } catch (err) {
    warn('jsonb', err);
    return '{}';
  }
}

// Every event is written inside the transaction of the transition it
// narrates, on the trx DIRECTLY (never through guarded): a swallowed error
// there leaves the PostgreSQL transaction aborted, so its COMMIT silently
// rolls back while the callback reports success — the write must throw to
// the transaction's own guard.
function eventRow(runId, eventType, message = null, metadata = null) {
  return { run_id: runId, event_type: clip(eventType, 40), message: clip(message, 2000), metadata: jsonb(metadata) };
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
    agentVersionId: args.agentVersionId || null,
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

async function upsertWorkItem(conn, args, laneId, policy) {
  const wi = args.workItem;
  if (!wi || !wi.sourceRef) return null;
  const sourceSystem = clip(wi.sourceSystem || args.sourceSystem, 60);
  const sourceRef = clip(wi.sourceRef, 180);
  await conn('work_items')
    .insert({
      lane_id: laneId,
      workflow_id: clip(args.workflowId, 80),
      source_system: sourceSystem,
      source_ref: sourceRef,
      entity_type: clip(wi.entityType, 80),
      entity_id: clip(wi.entityId, 120),
      customer_id: wi.customerId || null,
      title: clip(wi.title, 300),
      risk_tier: tierFor(policy),
      priority: clip(wi.priority, 4),
    })
    .onConflict(['source_system', 'source_ref'])
    .ignore();
  const row = await conn('work_items').where({ source_system: sourceSystem, source_ref: sourceRef }).first('id');
  return row ? row.id : null;
}

async function insertRun(conn, args, laneId, policy, workItemId, traceId, now) {
  const sourceSystem = clip(args.sourceSystem, 60);
  const sourceRunId = clip(args.sourceRunId, 180);
  const lease = new Date(now.getTime() + policy.stall_after_ms);
  await conn('agent_runs')
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
      risk_tier: tierFor(policy),
      summary: jsonb(args.summary),
      link: clip(args.link, 2000),
    })
    .onConflict(['source_system', 'source_run_id'])
    .ignore();
  return conn('agent_runs').where({ source_system: sourceSystem, source_run_id: sourceRunId }).first();
}

// The attempt number is allocated by an atomic UPDATE … attempts + 1
// RETURNING, so two concurrent starts on one source key get distinct
// attempts (never one attempt id shared by two handles). Every later write
// from a handle is fenced on `attempts = its attemptNo` (fenced() below):
// once a newer attempt opened, the older handle's finish / fail / heartbeat
// no longer touch the run — only its own attempt row.
async function openAttempt(conn, run, policy, now) {
  // A reopened run gets a fresh lease, a clean current outcome and a fresh
  // clock — started_at / last_progress_at are THIS attempt's, so health.js
  // judges the retry from its own start (the previous attempt's timing,
  // result and error live on in agent_attempts).
  const [updated] = await conn('agent_runs').where({ id: run.id }).update({
    attempts: db.raw('attempts + 1'),
    lifecycle: 'running',
    worker_id: WORKER_ID,
    leased_at: now,
    lease_expires_at: new Date(now.getTime() + policy.stall_after_ms),
    started_at: now,
    last_progress_at: now,
    progress_sequence: 0,
    finished_at: null,
    result: null,
    disposition: null,
    // a new attempt's output is unjudged until someone judges it — a prior
    // attempt's verdict must not carry over (Codex r1); the attempt rows
    // and run_events keep the history
    verification: 'unjudged',
    failure_class: null,
    error_code: null,
    error_message: null,
    last_heartbeat_at: now,
    updated_at: now,
  }).returning('attempts');
  // the work item is open again while a new attempt runs at it
  if (run.work_item_id) await conn('work_items').where({ id: run.work_item_id }).update({ status: 'open', updated_at: now });
  const attemptNo = Number(updated && updated.attempts != null ? updated.attempts : updated);
  const [attempt] = await conn('agent_attempts')
    .insert({ run_id: run.id, attempt_no: attemptNo, worker_id: WORKER_ID, started_at: now })
    .returning('id');
  // step seq is per RUN: a retry's steps continue the numbering so the
  // timeline orders across attempts
  const last = await conn('agent_run_steps').where({ run_id: run.id }).max('seq as max_seq').first();
  run.max_seq = Number((last && last.max_seq) || 0);
  return { attemptId: attempt ? attempt.id || attempt : null, attemptNo };
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
  // an unknown lane would take the unclassified default policy — no
  // side-effect class, so a money / irreversible lane misspelled here would
  // regain retries; refuse it (the workflow-only form stays) (Codex r5)
  if (laneId && !context.isKnownLane(laneId)) {
    logger.warn(`[agent-runs] startRun refused: unknown lane ${laneId} (source ${clip(args.sourceSystem, 60)})`);
    return inertHandle(args);
  }
  const policy = policyFor(laneId);
  const ambient = context.current();
  const traceId = args.traceId || ambient.traceId || context.newTraceId();
  const now = new Date();

  // Work item, run, the attempts counter and the attempt row land together
  // or not at all: a crash between the counter bump and the attempt insert
  // would otherwise leave a run whose current attempt has no row.
  const opened = await guarded('startRun', () => db.transaction(async (trx) => {
    const workItemId = await upsertWorkItem(trx, args, laneId, policy);
    const run = await insertRun(trx, args, laneId, policy, workItemId, traceId, now);
    if (!run) throw new Error('run row missing after insert');
    // a run first started without a work item binds one supplied by a later
    // start ON THE ROW — the ledger's readers (not just this handle) must
    // see the link finish() will mark done (Codex r2)
    if (!run.work_item_id && workItemId) {
      await trx('agent_runs').where({ id: run.id }).update({ work_item_id: workItemId, updated_at: now });
      run.work_item_id = workItemId;
    }
    // likewise the agent version: the persisted one is the run's (its calls
    // stamp the same id through the context), a later start's binds only
    // when the row has none (Codex r3)
    if (!run.agent_version_id && args.agentVersionId) {
      await trx('agent_runs').where({ id: run.id }).update({ agent_version_id: args.agentVersionId, updated_at: now });
      run.agent_version_id = args.agentVersionId;
    }
    // A reopened run keeps ITS lane and policy: the persisted row decides
    // (a money lane cannot be reopened under a read-only one and gain a
    // retry — Codex r1). A mismatch is logged, never honoured.
    const persistedLane = run.lane_id || null;
    // lane ids only — safe to log in full, and rare enough not to rate-limit
    if (persistedLane !== laneId) logger.warn(`[agent-runs] lane mismatch on reopen: persisted ${persistedLane}, requested ${laneId} — keeping ${persistedLane}`);
    const runPolicy = policyFor(persistedLane);
    const resumed = Number(run.attempts || 0) > 0 || run.lifecycle !== 'running';
    const { attemptId, attemptNo } = await openAttempt(trx, run, runPolicy, now);
    await trx('run_events').insert({ run_id: run.id, event_type: resumed ? 'resumed' : 'started', message: null, metadata: jsonb({ attempt: attemptNo, worker: WORKER_ID }) });
    return { run, attemptId, attemptNo, workItemId: run.work_item_id, laneId: persistedLane, policy: runPolicy };
  }));
  if (!opened) return inertHandle(args);
  // a reopened run keeps the trace its ledger rows already carry
  return liveHandle({ ...opened, traceId: opened.run.trace_id || traceId, workflowId: opened.run.workflow_id || args.workflowId || null, agentVersionId: opened.run.agent_version_id || null });
}

// ── Live handle ──────────────────────────────────────────────────────

function liveHandle({ run, attemptId, attemptNo, workItemId, laneId, policy, traceId, workflowId, agentVersionId = null }) {
  const runId = run.id;
  const budget = policy.budget || {};
  let seq = Number(run.max_seq || 0); // timeline numbering, continues across attempts (openAttempt reads the max)
  let stepsThisAttempt = 0; // the budget's unit: this attempt starts its budget over
  let toolCalls = 0;
  let budgetFlagged = false;
  let progress = 0; // this attempt's count: openAttempt reset the persisted one (a reopen's row is pre-reset)
  // this handle's attempt is the run's current one (see openAttempt) and
  // the run is still open: a terminal run is changed only by openAttempt
  const fenced = (conn = db) => conn('agent_runs').where({ id: runId, attempts: attemptNo }).whereNot('lifecycle', 'terminal');
  // one-shot: after finish / fail PERSISTED (or proved stale — a newer
  // attempt owns the run) this handle is spent and every later call is a
  // no-op (a retry goes through startRun → openAttempt). A terminal
  // transaction that failed to commit leaves the handle open so the caller
  // can close the run again (Codex r7).
  let closed = false;
  const spent = () => closed;

  // The fenced stamp (unguarded: inside a transaction it must throw, see insertEvent).
  function stamp(conn, patch, extendLease) {
    const now = new Date();
    return fenced(conn).update({
      last_heartbeat_at: now,
      ...(extendLease ? { lease_expires_at: new Date(now.getTime() + policy.stall_after_ms) } : {}),
      updated_at: now,
      ...patch,
    });
  }

  async function touch(patch, extendLease = true) {
    return guarded('heartbeat', () => stamp(db, patch, extendLease));
  }

  // A transition and its event are one transaction: the event exists only
  // when the fenced stamp moved the run, and a reopen racing the commit
  // cannot interleave its `resumed` event with this attempt's (Codex r6).
  async function transition(eventType, patch, { extendLease = true, message = null, metadata = null } = {}) {
    return guarded(eventType, () => db.transaction(async (trx) => {
      const n = await stamp(trx, patch, extendLease);
      if (!Number(n)) return false;
      await trx('run_events').insert(eventRow(runId, eventType, message, metadata));
      return true;
    }), false);
  }

  async function heartbeat({ progress: progressed = false } = {}) {
    if (spent()) return null;
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
    // the event only when the fenced stamp moved the run: a stale handle
    // (a newer attempt opened) must not narrate a budget transition the
    // current attempt never made (Codex r3)
    await transition('budget_exceeded', { summary: db.raw("summary || ?::jsonb", [jsonb({ budget_exceeded: kind })]) }, { extendLease: false, metadata: { kind, max_steps: budget.max_steps, max_tool_calls: budget.max_tool_calls } });
  }

  async function step({ key, label = null, toolName = null } = {}, fn) {
    if (spent()) return context.withStep(crypto.randomUUID(), () => fn());
    seq += 1;
    stepsThisAttempt += 1;
    if (toolName) toolCalls += 1;
    if (budget.max_steps && stepsThisAttempt > budget.max_steps) await flagBudget('steps');
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

  // Transitions write their event only when the fenced update moved the
  // run: an older handle (a newer attempt opened) must not narrate
  // transitions on the current attempt's timeline (Codex r1).
  async function wait(kind = 'external', reason = null) {
    if (spent()) return null;
    const lifecycle = kind === 'human' ? 'waiting_human' : 'waiting_external';
    return transition('waiting', { lifecycle, last_progress_at: new Date() }, { extendLease: false, message: clip(reason, 2000), metadata: { kind } });
  }

  async function resume(reason = null) {
    if (spent()) return null;
    return transition('resumed', { lifecycle: 'running', last_progress_at: new Date() }, { message: clip(reason, 2000) });
  }

  async function checkpoint(data = {}) {
    if (spent()) return null;
    return transition('checkpoint', { summary: db.raw('summary || ?::jsonb', [jsonb(data)]), last_progress_at: new Date() }, { metadata: data });
  }

  // Rows for the finish transaction (inserted on the trx directly, see insertEvent).
  function artifactRows(artifacts) {
    if (!Array.isArray(artifacts)) return [];
    return artifacts
      .filter((a) => a && ARTIFACT_KINDS.has(a.kind))
      .map((a) => ({
        run_id: runId,
        kind: clip(a.kind, 12),
        label: clip(a.label, 200),
        ref: clip(a.ref, 4000),
        content_redacted: clip(a.content, 8192),
        redaction_confidence: clip(a.redactionConfidence, 8),
      }));
  }

  // The attempt row closes in the SAME transaction as the run's transition
  // (atomic: never a closed attempt on a still-running run); a stale handle
  // closes its own attempt row and nothing else.
  function closeAttempt(trx, result, failure = {}) {
    if (!attemptId) return null;
    return trx('agent_attempts').where({ id: attemptId }).update({
      finished_at: new Date(),
      result,
      failure_class: failure.failureClass || null,
      error_code: clip(failure.errorCode, 80),
      error_message: failure.errorMessage || null,
    });
  }

  // Shared effects (work item, artifacts, events) follow ONLY a fenced
  // transition that moved the run — a stale handle (a newer attempt opened)
  // closes its own attempt row and nothing else — and land INSIDE that
  // transaction, unguarded: a reopen racing the commit cannot slip its
  // `resumed` event in before this attempt's `finished` / artifacts, and a
  // failed write rolls the whole transition back (the outer guard warns,
  // the run stays as it was) rather than committing half of it (Codex r5 +
  // pre-push audit).
  async function finish({ result = 'succeeded', disposition = null, summary = null, artifacts = null } = {}) {
    if (spent()) return false;
    const now = new Date();
    const res = RESULT.includes(result) ? result : 'succeeded';
    const dispo = DISPOSITION.includes(disposition) ? disposition : null;
    const rows = artifactRows(artifacts);
    // 'moved' | 'stale' | null (the transaction failed and rolled back)
    const outcome = await guarded('finish', () => db.transaction(async (trx) => {
      await closeAttempt(trx, res);
      const n = await fenced(trx).update({
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
      });
      if (!Number(n)) return 'stale';
      if (workItemId && res === 'succeeded') await trx('work_items').where({ id: workItemId }).update({ status: 'done', updated_at: now });
      if (rows.length) await trx('run_artifacts').insert(rows);
      await trx('run_events').insert(eventRow(runId, 'finished', null, { result: res, disposition: dispo }));
      if (dispo) await trx('run_events').insert(eventRow(runId, 'disposition', null, { disposition: dispo }));
      return 'moved';
    }), null);
    closed = outcome !== null;
    return outcome === 'moved';
  }

  async function fail({ error = null, errorCode = null, failureClass = null, retryable = false } = {}) {
    if (spent()) return { retry: false, failureClass: null, result: null, stale: true };
    const now = new Date();
    const err = error && typeof error === 'object' ? error : { message: error, code: null };
    const code = clip(errorCode ?? err.code, 80);
    const message = sanitizeJobError(err.message ?? code ?? 'failed');
    // an explicit class must be in the taxonomy (the column has no CHECK);
    // anything else is classified from the code / message like an omission
    const klass = FAILURE_CLASS.includes(failureClass) ? failureClass : classifyFailure(code ?? message);
    const canRetry = [retryable, attemptNo < Number(run.max_attempts), run.idempotency_key, !NO_RETRY_CLASSES.has(policy.side_effect_class)].every(Boolean);
    const result = CODE_RESULT[code] ?? CLASS_RESULT[klass] ?? 'errored';
    const transition = canRetry
      ? { lifecycle: 'queued', result: null, finished_at: null, event: 'retry_scheduled' }
      : { lifecycle: 'terminal', result, finished_at: now, event: 'failed' };
    // the attempt close, the transition and its events in one transaction (see finish)
    const outcome = await guarded('fail', () => db.transaction(async (trx) => {
      await closeAttempt(trx, result, { failureClass: klass, errorCode: code, errorMessage: message });
      const n = await fenced(trx).update({
        lifecycle: transition.lifecycle,
        result: transition.result,
        failure_class: klass,
        error_code: code,
        error_message: message,
        finished_at: transition.finished_at,
        last_heartbeat_at: now,
        lease_expires_at: null,
        updated_at: now,
      });
      if (!Number(n)) return 'stale';
      await trx('run_events').insert(eventRow(runId, transition.event, message, { failure_class: klass, error_code: code, attempt: attemptNo, result: transition.result }));
      if (isQualityFailure(klass)) await trx('run_events').insert(eventRow(runId, 'eval_candidate', null, { failure_class: klass }));
      return 'moved';
    }), null);
    closed = outcome !== null;
    // nothing persisted: the handle stays open for another fail / finish
    if (outcome === null) return { retry: false, failureClass: klass, result: null, stale: false, persisted: false };
    // stale handle: its attempt row carries the failure; the run belongs to a newer attempt
    if (outcome === 'stale') return { retry: false, failureClass: klass, result: null, stale: true };
    return { retry: canRetry, failureClass: klass, result: transition.result };
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
    agentVersionId,
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
  // the scope carries the handle's RESOLVED identity (a reopen keeps the
  // persisted lane / workflow, which may differ from what was asked)
  const scoped = () => context.runInRun({
    runId: handle.id,
    workItemId: handle.workItemId,
    attemptId: handle.attemptId,
    traceId: handle.traceId,
    agentVersionId: handle.agentVersionId,
    workflowId: handle.workflowId,
  }, () => fn(handle));
  const body = () => (handle.laneId ? context.runInLane(handle.laneId, scoped) : scoped());
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

module.exports = { startRun, runManaged, runGateOn, WORKER_ID, NO_RETRY_CLASSES, ARTIFACT_KINDS };
