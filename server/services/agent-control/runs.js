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
// Which work_items status (the CHECK vocabulary) a finished run's result
// settles the linked item on; a result not listed leaves it open.
const WORK_ITEM_STATUS = Object.freeze({ succeeded: 'done', canceled: 'canceled' });
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
    isOpen: () => false,
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

async function insertRun(conn, args, laneId, policy, traceId, now) {
  const sourceSystem = clip(args.sourceSystem, 60);
  const sourceRunId = clip(args.sourceRunId, 180);
  const lease = new Date(now.getTime() + policy.stall_after_ms);
  // fail() never re-queues a run without an idempotency key or on a money /
  // irreversible lane (a retry there could act twice), so such a run
  // stores ONE attempt: a terminal row must not read 1/3 against a limit
  // that was never permitted (Codex r14)
  const retryable = !!args.idempotencyKey && !NO_RETRY_CLASSES.has(policy.side_effect_class);
  await conn('agent_runs')
    .insert({
      work_item_id: null, // bound by bindOnce once the start owns the run (Codex r17)
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
      // ms-precision JS Dates for BOTH (not the DB default's µs): the read
      // adapter pages on COALESCE(started_at, created_at) with a JS cursor
      created_at: now,
      started_at: now,
      last_heartbeat_at: now,
      last_progress_at: now,
      attempts: 0,
      max_attempts: retryable ? Math.max(1, Number(args.maxAttempts) || 1 + Number(policy.budget?.max_retries || 0)) : 1,
      idempotency_key: clip(args.idempotencyKey, 260),
      side_effect_class: policy.side_effect_class || null,
      risk_tier: tierFor(policy),
      summary: jsonb(args.summary),
      link: clip(args.link, 2000),
    })
    .onConflict(['source_system', 'source_run_id'])
    .ignore();
  // LOCKED for the rest of the start transaction: two concurrent starts on
  // one key serialize here, and the second re-reads the row the first
  // committed (a fresh lease, attempts + 1) — so exactly one of them opens
  // an attempt and the other is held (pre-push audit on Codex r15).
  return conn('agent_runs').where({ source_system: sourceSystem, source_run_id: sourceRunId }).forUpdate().first();
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
  // a prior attempt still open here belongs to a handle that never closed
  // it (a crashed worker): stamp it superseded so the history holds one
  // open attempt at most — its handle, should it come back, may still
  // replace the placeholder with its real outcome (closeAttempt) (Codex r8)
  await conn('agent_attempts').where({ run_id: run.id }).whereNull('finished_at')
    .update({ finished_at: now, result: 'canceled', error_code: 'superseded', error_message: 'superseded by a new attempt' });
  const [attempt] = await conn('agent_attempts')
    .insert({ run_id: run.id, attempt_no: attemptNo, worker_id: WORKER_ID, started_at: now })
    .returning('id');
  // step seq is per RUN: a retry's steps continue the numbering so the
  // timeline orders across attempts
  const last = await conn('agent_run_steps').where({ run_id: run.id }).max('seq as max_seq').first();
  run.max_seq = Number((last && last.max_seq) || 0);
  return { attemptId: attempt ? attempt.id || attempt : null, attemptNo };
}

// A run whose current attempt is LIVE: opened, neither terminal nor queued
// for a retry, and its lease unexpired — a worker is still heartbeating it
// (a crashed worker's lease lapses after the policy's stall_after_ms).
const WAITING = new Set(['waiting_human', 'waiting_external']);
// Why a start on an EXISTING run may not open an attempt (null = it may):
//   in_progress  the current attempt is live — parked in a wait (wait()
//                stopped extending its lease on purpose: owned until resume /
//                finish / fail / supersede, however long the human or the
//                external party takes; Codex r16), or running with its lease
//                unexpired (a RUNNING worker's liveness; it lapses after
//                stall_after_ms = crashed) (Codex r15)
//   completed    the run is terminal — its outcome is recorded; a repeated
//                queue delivery must not reopen it (Codex r17)
//   exhausted    a lapsed attempt at the cap: fail() would not have queued a
//                retry, so a restart must not either — max_attempts = 1 on a
//                money / irreversible lane is the whole point (Codex r17)
// A queued retry (fail() schedules it only under the cap) and a lapsed
// attempt under the cap reopen. `supersede: true` overrides every reason.
function refusalOf(run, now) {
  if (!(Number(run.attempts || 0) > 0)) return null;
  if (run.lifecycle === 'terminal') return 'completed';
  if (run.lifecycle === 'queued') return null;
  if (WAITING.has(run.lifecycle)) return 'in_progress';
  if (run.lease_expires_at && new Date(run.lease_expires_at).getTime() > now.getTime()) return 'in_progress';
  return Number(run.attempts) >= Number(run.max_attempts || 1) ? 'exhausted' : null;
}

// A later start's work item / agent version / workflow bind ON THE ROW,
// once, when the row has none: the ledger's readers (not just this handle)
// see the link finish() will mark done, the calls stamp the persisted
// version, and the handle's scope stamps the same workflow the run reports
// (Codex r2 / r3 / r16). The persisted value always wins.
async function bindOnce(trx, run, fields, now) {
  const patch = {};
  for (const [col, value] of Object.entries(fields)) if (!run[col] && value) patch[col] = value;
  if (!Object.keys(patch).length) return;
  await trx('agent_runs').where({ id: run.id }).update({ ...patch, updated_at: now });
  Object.assign(run, patch);
}


// The handle a refused start gets: inert (writes nothing) and `held` names
// the reason and the run that holds the key, so runManaged can refuse the body.
function heldHandle(args, run, reason) {
  return Object.freeze({
    ...inertHandle(args),
    held: {
      reason, runId: run.id, attemptNo: Number(run.attempts), lifecycle: run.lifecycle, result: run.result || null,
      workerId: run.worker_id || null, leaseExpiresAt: run.lease_expires_at ? new Date(run.lease_expires_at) : null,
    },
  });
}

function refuse(run, reason) {
  // ids and states only — safe to log in full, and rare enough not to rate-limit
  logger.warn(`[agent-runs] startRun refused (${reason}): ${run.source_system}/${run.source_run_id} attempt ${run.attempts} is ${run.lifecycle}${run.result ? ` / ${run.result}` : ''} on ${run.worker_id || 'unknown worker'}`);
  return { held: run, reason };
}

// The refusals a start meets before it may touch anything, every read
// LOCKED for the transaction: the run under this source key, then the run
// that already holds this idempotency key under ANOTHER source key — that
// insert would hit the separate UNIQUE (idempotency_key) and throw, and a
// thrown start degrades to an inert handle whose body still runs, so the
// key meant to make retries safe would fail OPEN (Codex r17).
async function refusalBefore(trx, args, now) {
  const sourceSystem = clip(args.sourceSystem, 60);
  const sourceRunId = clip(args.sourceRunId, 180);
  const key = clip(args.idempotencyKey, 260);
  // A NEW key has no row to lock: two starts under different source ids
  // sharing it would both pass the lookup, and the loser's insert would
  // hit the unique index — the thrown start degrading to an inert handle
  // whose body runs. Serialized on the key for the transaction instead
  // (the session recorder's pattern), so the second start's lookup finds
  // the first's committed row (pre-push audit on Codex r17).
  if (key) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`agent_runs:idempotency:${key}`]);
  const existing = await trx('agent_runs').where({ source_system: sourceSystem, source_run_id: sourceRunId }).forUpdate().first();
  const reason = existing ? refusalOf(existing, now) : null;
  if (reason && !args.supersede) return { existing, refused: refuse(existing, reason) };
  if (key) {
    const byKey = await trx('agent_runs').where({ idempotency_key: key }).forUpdate().first();
    if (byKey && (byKey.source_system !== sourceSystem || byKey.source_run_id !== sourceRunId)) return { existing, refused: refuse(byKey, 'idempotency_conflict') };
  }
  return { existing, refused: null };
}

/**
 * startRun({ laneId, workflowId, sourceSystem, sourceRunId, workItem?,
 *            traceId?, idempotencyKey?, maxAttempts?, agentVersionId?,
 *            summary?, link?, supersede? })
 * Requires laneId or workflowId (CHECK constraint) and sourceSystem +
 * sourceRunId (UNIQUE key). Returns a handle; never throws. A start is
 * REFUSED — the handle is inert with `held.reason` set and nothing (no work
 * item either) is written for it — when the key's attempt is live
 * (`in_progress`: running with its lease unexpired, or parked in a wait),
 * when the run is terminal (`completed`), when a lapsed attempt sits at its
 * cap (`exhausted`), or when the idempotency key already belongs to another
 * source run (`idempotency_conflict`): reopening would rewrite the ledger
 * while the operation runs, waits, or is already done, so it could run
 * twice (Codex r15–r17). `supersede: true` is the explicit override for a
 * manual replay of this key's run (never of an idempotency conflict); the
 * S4 watchdog's stall handling is the other way out of a wait whose worker
 * died. A queued retry and a lapsed attempt under the cap reopen as a new
 * attempt.
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
    // A refused start leaves nothing behind — not even a work item minted
    // for it (Codex r16 / r17): the work item is upserted and bound only
    // once ownership is established. Two starts on a NEW key both miss the
    // locked lookup and serialize on insertRun's locked read instead.
    const { existing, refused } = await refusalBefore(trx, args, now);
    if (refused) return refused;
    const run = existing || await insertRun(trx, args, laneId, policy, traceId, now);
    if (!run) throw new Error('run row missing after insert');
    // the new-key race: the row insertRun read was the other start's
    const late = refusalOf(run, now);
    if (late && !args.supersede) return refuse(run, late);
    const workItemId = await upsertWorkItem(trx, args, laneId, policy);
    await bindOnce(trx, run, { work_item_id: workItemId, agent_version_id: args.agentVersionId, workflow_id: clip(args.workflowId, 80) }, now);
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
  if (opened.held) return heldHandle(args, opened.held, opened.reason);
  // a reopened run keeps the trace its ledger rows already carry
  return liveHandle({ ...opened, traceId: opened.run.trace_id || traceId, workflowId: opened.run.workflow_id || null, agentVersionId: opened.run.agent_version_id || null });
}

// ── Live handle ──────────────────────────────────────────────────────

function liveHandle({ run, attemptId, attemptNo, workItemId, laneId, policy, traceId, workflowId, agentVersionId = null }) {
  const runId = run.id;
  const budget = policy.budget || {};
  let seq = Number(run.max_seq || 0); // timeline numbering, continues across attempts (openAttempt reads the max)
  let stepsThisAttempt = 0; // the budget's unit: this attempt starts its budget over
  let toolCalls = 0;
  let budgetFlagged = false;
  let budgetMarking = null; // the in-flight marker: parallel over-budget steps share ONE transition
  // this handle's attempt is the run's current one (see openAttempt) and
  // the run is still open: a terminal run is changed only by openAttempt,
  // and a QUEUED one (a retryable fail) awaits its next attempt — the
  // handle that queued it is done with it, so a finish / second fail racing
  // that commit moves nothing (pre-push audit)
  const fenced = (conn = db) => conn('agent_runs').where({ id: runId, attempts: attemptNo }).whereNot('lifecycle', 'terminal').whereNot('lifecycle', 'queued');
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
  // true = moved; false = the fence refused it (a newer attempt owns the
  // run); null = the write itself failed (rolled back, nothing recorded).
  async function transition(eventType, patch, { extendLease = true, message = null, metadata = null } = {}) {
    return guarded(eventType, () => db.transaction(async (trx) => {
      const n = await stamp(trx, patch, extendLease);
      if (!Number(n)) return false;
      await trx('run_events').insert(eventRow(runId, eventType, message, metadata));
      return true;
    }), null);
  }

  // Progress is incremented IN the fenced update, not written from a
  // process-local count: two overlapping heartbeats (parallel steps) can
  // take the row lock in either order, and an absolute value from the
  // later caller would regress the earlier one; a rolled-back write must
  // not skip a number either (Codex r12). openAttempt reset the persisted
  // counter, so a retry still counts from zero.
  async function heartbeat({ progress: progressed = false } = {}) {
    if (spent()) return null;
    const patch = progressed ? { progress_sequence: db.raw('progress_sequence + 1'), last_progress_at: new Date() } : {};
    return touch(patch);
  }

  async function flagBudget(kind) {
    if (budgetFlagged) return;
    // the event only when the fenced stamp moved the run: a stale handle
    // (a newer attempt opened) must not narrate a budget transition the
    // current attempt never made (Codex r3). Flagged once it persisted or
    // the fence refused it — a write that FAILED recorded nothing, so the
    // next over-budget step tries again (Codex r13). Steps crossing the
    // budget in parallel await the same in-flight marker, so the retry
    // never becomes a second event (pre-push audit).
    if (!budgetMarking) {
      budgetMarking = transition('budget_exceeded', { summary: db.raw("summary || ?::jsonb", [jsonb({ budget_exceeded: kind })]) }, { extendLease: false, metadata: { kind, max_steps: budget.max_steps, max_tool_calls: budget.max_tool_calls } })
        .then((moved) => { budgetFlagged = moved !== null; })
        .finally(() => { budgetMarking = null; });
    }
    await budgetMarking;
  }

  // Every step body runs under the handle's RESOLVED identity (a reopen
  // keeps the persisted lane / workflow): a standalone handle's LLM calls
  // then carry this run id / trace / lane in the ledger the same as a
  // runManaged body's, so getRun() finds them (pre-push audit). Joining
  // the ambient scope when it is already this trace keeps its step nesting.
  const inScope = (fn) => {
    const scoped = () => context.runInRun({ runId, workItemId: workItemId || null, attemptId: attemptId || null, traceId, agentVersionId, workflowId }, fn);
    return laneId ? context.runInLane(laneId, scoped) : scoped();
  };

  async function step({ key, label = null, toolName = null } = {}, fn) {
    if (spent()) return inScope(() => context.withStep(crypto.randomUUID(), () => fn()));
    // this step's number is taken BEFORE any await: parallel steps each
    // advance the shared counter, and one that read it after awaiting the
    // budget marker would take a sibling's number (pre-push audit)
    seq += 1;
    const stepSeq = seq;
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
        seq: stepSeq,
        step_key: clip(key || `step_${stepSeq}`, 80),
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
    return inScope(() => context.withStep(stepId, async () => {
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
    }));
  }

  // Transitions write their event only when the fenced update moved the
  // run: an older handle (a newer attempt opened) must not narrate
  // transitions on the current attempt's timeline (Codex r1).
  async function wait(kind = 'external', reason = null) {
    if (spent()) return null;
    const lifecycle = kind === 'human' ? 'waiting_human' : 'waiting_external';
    return transition('waiting', { lifecycle, last_progress_at: new Date() }, { extendLease: false, message: clip(reason, 2000), metadata: { kind } });
  }

  // A resume opens a fresh ACTIVE span: started_at is the run's current
  // active span (the attempt row keeps the attempt's own start), so a run
  // that waited on a human longer than the lane's hard timeout is judged
  // from when it resumed, not labelled stalled the moment it moves again
  // (pre-push audit; the same rule the legacy adapters apply to an
  // executing approval).
  async function resume(reason = null) {
    if (spent()) return null;
    const now = new Date();
    return transition('resumed', { lifecycle: 'running', started_at: now, last_progress_at: now }, { message: clip(reason, 2000) });
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
  // closes its own attempt row and nothing else. Fenced on the row being
  // open — or holding openAttempt's superseded placeholder — so a second
  // finish / fail racing on one handle cannot rewrite a recorded outcome
  // (Codex r8). LOCK ORDER: the run row first, then attempts — the same
  // order openAttempt takes (agent_runs, then the open attempts), so a
  // reopen racing an older handle's completion cannot deadlock (pre-push
  // audit); a stale handle's fenced update touches no run row and so
  // holds no run lock when it closes its attempt.
  function closeAttempt(trx, result, failure = {}) {
    if (!attemptId) return null;
    return trx('agent_attempts').where({ id: attemptId }).where((q) => q.whereNull('finished_at').orWhere({ error_code: 'superseded' })).update({
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
      await closeAttempt(trx, res); // after the run row (lock order), stale or not
      if (!Number(n)) return 'stale';
      // the linked item follows the outcome: done on success, canceled on a
      // canceled run (Codex r11); an errored / timed-out run leaves it open
      // for the next attempt
      if (workItemId && WORK_ITEM_STATUS[res]) await trx('work_items').where({ id: workItemId }).update({ status: WORK_ITEM_STATUS[res], updated_at: now });
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
    // own properties only: an error code named like a prototype member
    // ('constructor') must not resolve to a function (the taxonomy rule)
    const result = (Object.hasOwn(CODE_RESULT, code) ? CODE_RESULT[code] : null) ?? CLASS_RESULT[klass] ?? 'errored';
    const transition = canRetry
      ? { lifecycle: 'queued', result: null, finished_at: null, event: 'retry_scheduled' }
      : { lifecycle: 'terminal', result, finished_at: now, event: 'failed' };
    // the attempt close, the transition and its events in one transaction (see finish)
    const outcome = await guarded('fail', () => db.transaction(async (trx) => {
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
      await closeAttempt(trx, result, { failureClass: klass, errorCode: code, errorMessage: message }); // after the run row (lock order)
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
    isOpen: () => !closed, // false once finish / fail persisted or proved stale
    inScope,
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
  // a refused start never runs the body: the operation is in flight on
  // another worker, already done, out of attempts, or another source run's
  // under this idempotency key (code `run_<reason>`; `supersede: true`
  // overrides all but the idempotency conflict)
  if (handle.held) {
    const err = new Error(`run ${handle.held.reason.replace(/_/g, ' ')}: ${clip(startArgs.sourceSystem, 60)}/${clip(startArgs.sourceRunId, 180)} — attempt ${handle.held.attemptNo} is ${handle.held.lifecycle}${handle.held.result ? ` / ${handle.held.result}` : ''}`);
    err.code = `run_${handle.held.reason}`;
    err.held = handle.held;
    throw err;
  }
  // the handle's own scope: its RESOLVED identity (a reopen keeps the
  // persisted lane / workflow, which may differ from what was asked); an
  // inert handle has none, so its body runs in the ambient scope
  const body = () => (handle.inert ? fn(handle) : handle.inScope(() => fn(handle)));
  // a terminal write that rolled back leaves the handle open: one more try
  // before the wrapper lets go of it (Codex r8) — still never a throw
  try {
    const value = await body();
    const shaped = value && typeof value === 'object' && !Array.isArray(value) && ('result' in value || 'disposition' in value || 'summary' in value || 'artifacts' in value);
    const outcome = shaped ? value : {};
    if (!(await handle.finish(outcome)) && handle.isOpen()) await handle.finish(outcome);
    return value;
  } catch (err) {
    const failure = { error: err, errorCode: err && err.code, retryable: !!(err && err.retryable) };
    const r = await handle.fail(failure);
    if (r && r.persisted === false && handle.isOpen()) await handle.fail(failure);
    throw err;
  }
}

module.exports = { startRun, runManaged, runGateOn, WORKER_ID, NO_RETRY_CLASSES, ARTIFACT_KINDS, WORK_ITEM_STATUS };
