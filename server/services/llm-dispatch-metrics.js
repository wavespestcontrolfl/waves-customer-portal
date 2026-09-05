/**
 * LLM dispatch observability — passive scorekeeping for the cross-provider
 * dispatcher plus a daily exception digest.
 *
 * Why: dispatchWithFallback fails QUIETLY by design — a dead primary route
 * degrades to the fallback provider, and a dead chain degrades to each
 * caller's safe-copy path, so provider trouble only surfaces as scattered
 * log lines under live traffic (#2814 ran 7 days unnoticed this way). The
 * sms-draft-canary actively probes two SMS routes; this module covers the
 * rest passively: every real dispatch chain writes one row to
 * llm_dispatch_log, and a daily cron emails ONLY exceptions to the company
 * inbox. Green days send nothing (hands-off + exception-based).
 *
 * Silence is load-bearing here, so recorder health is proven rather than
 * assumed. An hourly cron writes a heartbeat row through the same insert path
 * real recording uses; the digest then asks whether heartbeats exist for the
 * day it is summarizing. Three things make that necessary:
 *   - insert failures are swallowed at debug level by design (metrics must
 *     never cascade into the LLM call they observe), so a dead write path is
 *     otherwise invisible;
 *   - traffic volume cannot stand in for health — the SMS canary uses bare
 *     `dispatch` (writes no row) and every other instrumented job is
 *     candidate-driven, so a quiet ET day legitimately records nothing;
 *   - a probe at digest time would only prove the recorder works at 6:25am,
 *     so a write path broken all day but recovered overnight would pass while
 *     the entire lost day reported clean.
 * And because a dead database takes out the digest's own reads, DB failures
 * are caught and emailed over SMTP rather than throwing silently.
 *
 * Dark until GATE_LLM_DISPATCH_METRICS=true. Kill switch: unset — recording
 * and the digest both no-op instantly; existing rows just age out.
 *
 * The same table is also the CALL LEDGER (agent-control S2a): behind the
 * separate GATE_LLM_CALL_LEDGER, every provider call through the llm adapters
 * writes one row_kind='call' row (tokens, latency, served model, error
 * class) and every Managed Agents session one row_kind='session' row (the
 * cumulative session) plus one row_kind='session_turn' row per recorded
 * turn carrying that turn's DELTA of the counters — what a windowed read
 * sums, so a session live across a window edge never drags its earlier
 * turns along. Each is stamped with the ambient agent-control lane / chain
 * / run / step ids. Chain
 * rows and heartbeats keep their row_kind so the digest above reads exactly
 * what it always did. Redacted bodies (GATE_LLM_CALL_TRACES + a lane policy
 * that opts in) live in llm_call_traces, keyed to the call row and pruned
 * after TRACE_RETENTION_DAYS. Every recorder here has the same contract as
 * recordDispatch: never throws, never blocks the call it observes.
 */

const logger = require('./logger');
const { v5: uuidv5 } = require('uuid');

const { classifyFailure } = require('./agent-control/taxonomy');
const { policyFor } = require('./agent-control/lane-policies');

const DIGEST_TO = 'contact@wavespestcontrol.com';
const RETENTION_DAYS = 30;
// Traces are debugging material, not history: pruned independently of the
// ledger rows they hang off, gate or no gate.
const TRACE_RETENTION_DAYS = 7;
const TRACE_BODY_CAP = 8 * 1024;

// Exception thresholds. Volumes are per ET day per policy.
const FALLBACK_RATE_THRESHOLD = 0.2; // fallback on >=20% of a policy's calls
const FALLBACK_MIN_VOLUME = 5;       // ...but only with enough calls to mean it
const SILENT_MIN_WEEKLY = 10;        // policy had >=10 calls in prior 7 days...
                                     // ...and ZERO yesterday => "gone silent"

// One quiet day only means something for policies that run essentially every
// day. Event-driven lanes are bursty — visionAnalysis did 10 calls in one day
// then legitimately nothing, and the weekly-average check emailed "may have
// stopped running" every quiet day after (2026-08-17). A policy active on
// fewer than DAILY_CADENCE_MIN_DAYS of the prior 7 must instead be silent for
// SILENT_CONSECUTIVE_DAYS full ET days (yesterday inclusive) before alarming.
const DAILY_CADENCE_MIN_DAYS = 5;
const SILENT_CONSECUTIVE_DAYS = 3;

// Episodic one-shot workloads (sealed exams burst >=10 items then
// intentionally no-op until the prompt/profile changes; backfill drains a
// finite backlog; eval harnesses replay a fixed fixture weekly) — expected
// inactivity, so they are excluded from gone-silent detection. Their
// failure/fallback exceptions still report. Convention: episodic lanes tag
// one of these suffixes on their policy name.
const EPISODIC_LANE_RE = /:(?:sealed|backfill|replay)$/;

// Synthetic policy used only by the write-path probe; inserted and deleted
// within probeRecorder, and excluded from stats so a failed cleanup can never
// masquerade as a real policy in the digest.
const HEARTBEAT_POLICY = '__heartbeat__';

// The hourly cron gives ~24 heartbeats a day. Absence signals (gone_silent)
// are only trustworthy on a day that was covered nearly end to end: a day the
// gate was off for part of, or that a deploy interrupted, produces a handful
// of heartbeats, and "policy X recorded nothing" during a partial window says
// nothing about whether X stopped running.
const MIN_DAY_COVERAGE = 20;

// Ambient replay context. Eval harnesses replay fixed fixtures through the
// SAME live service functions real traffic uses (call extraction, email
// classification, fact-check), often many layers below where the harness can
// pass an option — so replay traffic would otherwise be recorded under the
// live policy label, diluting its fallback/failure rates and keeping a dead
// live lane looking active. Carried by the agent-control context's workload
// scope (AsyncLocalStorage, not a module flag) so a replay running
// concurrently with live traffic cannot mislabel the live calls.
const agentContext = require('./agent-control/context');

/**
 * Run `fn` with every LLM dispatch inside it recorded under the replay
 * workload. Harnesses wrap their whole run; nested live-service calls inherit
 * it. `lane` names the switchboard lane being replayed when the harness knows
 * it (none of the in-repo harnesses pass one today).
 */
function runAsReplay(fn, lane = null) {
  const replay = () => agentContext.withWorkload('replay', fn);
  return lane ? agentContext.runInLane(lane, replay) : replay();
}

// Explicit workload names on the policy itself (smsShadow:<p>:sealed) win —
// they are more specific than the ambient workload.
function applyReplayLane(label) {
  if (agentContext.current().workload !== 'replay' || EPISODIC_LANE_RE.test(label)) return label;
  return `${label}:replay`;
}

// The `policy` column EVERY row of a chain carries — the chain row and each
// leg's call row — so aggregation by policy never splits a chain, and replay
// traffic is never attributed to the live policy (Codex r5 on #3846).
function recordedPolicyLabel(policy) {
  return applyReplayLane(policyLabel(policy));
}

// Named TEXT_POLICIES entries carry their registry key as `name` (set in
// config/models.js). Route-signature matching is NOT safe here: with current
// env defaults customerCopy/visionAnalysis and highStakes/deepAnalysis
// resolve to identical route pairs, which would merge their stats and mask a
// gone-silent policy behind its twin's traffic.
function policyLabel(policy) {
  if (!policy) return 'unknown';
  if (typeof policy.name === 'string' && policy.name) return policy.name;
  // Anonymous { primary, fallback } pairs: label by the FULL route pair —
  // primary-only labels merged distinct lanes sharing a primary (codex r2).
  // Every in-repo ad-hoc policy now carries `name`; this is the safety net
  // for future unnamed ones.
  const leg = (r) => (r && r.provider && r.model ? `${r.provider}/${r.model}` : null);
  const primary = leg(policy.primary || policy);
  if (!primary) return 'unknown';
  const fallback = leg(policy.fallback);
  return fallback ? `${primary}→${fallback}` : primary;
}

function isEnabled() {
  return require('../config/feature-gates').isEnabled('llmDispatchMetrics');
}
// Both ledger gates are read at CALL time (gateEnvValue) so a flip needs no
// redeploy and unset = off = kill.
function ledgerEnabled() {
  return require('../config/feature-gates').gateEnvValue('GATE_LLM_CALL_LEDGER');
}
function tracesEnabled() {
  return require('../config/feature-gates').gateEnvValue('GATE_LLM_CALL_TRACES');
}

// The correlation columns every ledger row carries, straight from the
// agent-control context. All null outside any scope.
function contextColumns(ctx) {
  return {
    chain_id: ctx.chainId || null,
    lane_id: ctx.laneId || null,
    workload: ctx.workload || null,
    run_id: ctx.runId || null,
    attempt_id: ctx.attemptId || null,
    step_id: ctx.stepId || null,
    work_item_id: ctx.workItemId || null,
    trace_id: ctx.traceId || null,
    span_id: ctx.spanId || null,
    parent_span_id: ctx.parentSpanId || null,
    agent_version_id: ctx.agentVersionId || null,
    workflow_id: ctx.workflowId || null,
  };
}

/**
 * Record one completed dispatch chain. Fire-and-forget from the dispatcher's
 * hot path: never throws, never blocks, logs at debug on insert failure so a
 * DB blip can't cascade into the LLM call it was only supposed to observe.
 */
function buildRow(policy, result, rowKind = 'chain') {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  const ctx = agentContext.current();
  return {
    ...contextColumns(ctx),
    row_kind: rowKind,
    policy: recordedPolicyLabel(policy).slice(0, 120),
    ok: !!result?.ok,
    // WHY the chain failed, from the first leg's code — the class the alert
    // rules and eval selection key on; null on success. A rejection from the
    // caller's validate hook keeps that provenance (its codes are the
    // lane's own vocabulary — model-quality, not plumbing).
    error_class: result?.ok ? null : classifyFailure(failures[0]?.reason || result?.reason || 'error', { validator: failures[0]?.validator === true }),
    provider: result?.ok ? result.provider || null : null,
    model: result?.ok ? result.model || null : null,
    fallback_used: !!result?.fallbackUsed,
    failure_reasons: failures.length
      ? JSON.stringify(failures.map((f) => ({
        provider: f.provider,
        model: f.model,
        // Reasons are short codes or validator messages — cap length so a
        // pathological error string can't bloat the row.
        reason: String(f.reason || '').slice(0, 300),
        ...(f.validator === true ? { validator: true } : {}),
      })))
      : null,
  };
}

// The single write path. The heartbeat probe goes through it too, so the
// probe genuinely exercises what real recording does rather than a lookalike.
function insertRow(row) {
  return require('../models/db')('llm_dispatch_log').insert(row);
}

function recordDispatch(policy, result) {
  if (!isEnabled()) return;
  try {
    void insertRow(buildRow(policy, result)).catch((err) => {
      logger.debug(`[llm-dispatch-metrics] insert failed: ${err.message}`);
    });
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] record skipped: ${err.message}`);
  }
}

/**
 * Prove the recorder can actually write, by writing. Business volume can NOT
 * stand in for this: the 6-hourly SMS canary uses bare `dispatch` (no row),
 * and every other instrumented job is candidate-driven, so a genuinely quiet
 * ET day legitimately records zero rows. Inferring breakage from an empty day
 * would email a recorder-failure alarm every quiet weekend.
 *
 * Resolves on success; rejects with the underlying error when the write path
 * is broken — which is the only sound basis for a not_recording exception.
 */
/**
 * Write one heartbeat row through the SAME insert path recordDispatch uses.
 * Called hourly by the scheduler while the gate is on, and deliberately NOT
 * deleted: the rows are the durable evidence that the recorder was alive
 * DURING a given ET day. A digest-time probe could only prove the recorder
 * works at 6:25am — a write path that was broken all day but recovered
 * overnight would pass it, and the whole lost day would report as a healthy
 * quiet day. Heartbeats are excluded from policy stats and pruned by
 * retention like any other row.
 *
 * Throws on failure so the cron logs it (this is not the hot path).
 */
async function recordHeartbeat() {
  if (!isEnabled()) return { skipped: 'gate_off' };
  await insertRow(buildRow({ name: HEARTBEAT_POLICY }, { ok: true }, 'heartbeat'));
  return { ok: true };
}

// ── Call ledger ───────────────────────────────────────────────────────────

const toCount = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

/**
 * Normalise a provider's usage block into the ledger's five token columns.
 * Pure; absent fields are null; never throws — an unexpected body shape must
 * cost the row its token counts, not the call its result.
 *   anthropic  usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}
 *   openai     usage.{input_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens}
 *   gemini     usageMetadata.{promptTokenCount, cachedContentTokenCount, candidatesTokenCount, thoughtsTokenCount}
 */
function extractUsage(provider, data) {
  const out = { input_tokens: null, cached_input_tokens: null, cache_write_tokens: null, output_tokens: null, reasoning_tokens: null };
  try {
    if (provider === 'anthropic') {
      const u = data?.usage;
      if (!u || typeof u !== 'object') return out;
      out.input_tokens = toCount(u.input_tokens);
      out.cached_input_tokens = toCount(u.cache_read_input_tokens);
      out.cache_write_tokens = toCount(u.cache_creation_input_tokens);
      out.output_tokens = toCount(u.output_tokens);
    } else if (provider === 'openai') {
      const u = data?.usage;
      if (!u || typeof u !== 'object') return out;
      out.input_tokens = toCount(u.input_tokens);
      out.cached_input_tokens = toCount(u.input_tokens_details?.cached_tokens);
      out.output_tokens = toCount(u.output_tokens);
      out.reasoning_tokens = toCount(u.output_tokens_details?.reasoning_tokens);
    } else if (provider === 'gemini') {
      const u = data?.usageMetadata;
      if (!u || typeof u !== 'object') return out;
      out.input_tokens = toCount(u.promptTokenCount);
      out.cached_input_tokens = toCount(u.cachedContentTokenCount);
      out.output_tokens = toCount(u.candidatesTokenCount);
      out.reasoning_tokens = toCount(u.thoughtsTokenCount);
    }
  } catch { /* unexpected shape — counts stay null */ }
  return out;
}

// Run a ledger write and resolve the row id it produced (null when the DB
// says no). Separate from insertRow because the trace writer needs the id
// back and the heartbeat/chain path must keep its exact mocked shape.
async function writtenId(query) {
  const rows = typeof query.returning === 'function' ? await query.returning('id') : await query;
  const first = Array.isArray(rows) ? rows[0] : rows;
  const id = first && typeof first === 'object' ? first.id : first;
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

// Every column a call or session row normalises: ONE place decides how a
// value is clipped, counted or classified, so a schema change is audited
// here and nowhere else. `ok` follows from the error code (a failed row
// always carries one — `errorCode`, else `error`); `tokens` is an
// extractUsage shape.
const clip = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));
function ledgerRow({ ctx, rowKind, laneId, policyLabel, provider, requestedModel, servedModel, ok, errorCode, tokens, latencyMs, promptVersion, providerRef }) {
  const code = ok ? null : (errorCode || 'error');
  return {
    ...contextColumns(ctx),
    lane_id: laneId,
    row_kind: rowKind,
    policy: clip(policyLabel, 120),
    ok: !code,
    provider: provider || null,
    requested_model: clip(requestedModel, 120),
    served_model: clip(servedModel, 120),
    input_tokens: toCount(tokens.input_tokens),
    cached_input_tokens: toCount(tokens.cached_input_tokens),
    cache_write_tokens: toCount(tokens.cache_write_tokens),
    output_tokens: toCount(tokens.output_tokens),
    reasoning_tokens: toCount(tokens.reasoning_tokens),
    latency_ms: toCount(latencyMs),
    error_code: clip(code, 80),
    error_class: code && classifyFailure(code),
    prompt_version: clip(promptVersion, 60),
    provider_ref: clip(providerRef, 120),
  };
}

// The ledger's write path for call rows: one row, resolves the new id.
async function insertLedgerRow(row) {
  try {
    return await writtenId(require('../models/db')('llm_dispatch_log').insert(row));
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] ledger insert failed: ${err.message}`);
    return null;
  }
}

/**
 * Record one provider call. Resolves the ledger row id (null when the gate
 * is off, the insert failed, or the arguments were unusable) and NEVER
 * rejects — adapters fire-and-forget it on the hot path.
 *
 * Explicit `laneId` / `promptVersion` beat the ambient context (that is the
 * caller's job per agent-control/context.js). `policyLabel` is the chain's
 * registry name when the call ran inside dispatchWithFallback; otherwise the
 * row is labelled by lane, then by provider/model, so loadStats (chain rows
 * only) is untouched either way.
 */
async function recordCall({
  provider, requestedModel, servedModel = null, ok, errorCode = null, usage = null,
  latencyMs = null, promptVersion = null, providerRef = null, laneId = null, policyLabel: label = null,
} = {}) {
  try {
    if (!ledgerEnabled()) return null;
    const ctx = agentContext.current();
    const lane = laneId || ctx.laneId || null;
    return await insertLedgerRow(ledgerRow({
      ctx,
      rowKind: 'call',
      laneId: lane,
      policyLabel: label || lane || `${provider}/${requestedModel}`,
      provider,
      requestedModel,
      servedModel,
      ok,
      errorCode,
      tokens: usage || extractUsage(null, null),
      latencyMs,
      promptVersion: promptVersion || ctx.promptVersion,
      providerRef,
    }));
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] recordCall skipped: ${err.message}`);
    return null;
  }
}

/**
 * Flip a recorded call row to a failure after the fact: the adapter filed
 * the answer as ok (it arrived whole), then the chain rejected it — the
 * validate hook's own code or `empty_text` — so the row carries what the
 * caller saw, and the success rate / quality-failure selection are not
 * counting a rejected answer. Same fire-and-forget contract as recordCall:
 * resolves the id promise the adapter kept, never throws, no-op off-gate.
 */
function failCall(callIdPromise, errorCode, { validator = false } = {}) {
  try {
    if (!ledgerEnabled()) return;
    const code = clip(errorCode, 80) || 'error';
    const errorClass = classifyFailure(code, { validator });
    void Promise.resolve(callIdPromise).then((callId) => {
      if (callId === null || callId === undefined) return null;
      return require('../models/db')('llm_dispatch_log')
        .where({ id: callId })
        .update({ ok: false, error_code: code, error_class: errorClass });
    }).catch((err) => logger.debug(`[llm-dispatch-metrics] failCall skipped: ${err.message}`));
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] failCall skipped: ${err.message}`);
  }
}

/**
 * Run one raw provider call under the ledger. `fn` resolves the provider's
 * own value — an SDK Message or a parsed JSON body — which is returned
 * UNCHANGED; a throw is recorded as a failed call and rethrown unchanged, so
 * every caller's catch / fallback path sees exactly what it saw before.
 * `trace: { system, prompt }` hands the request bodies to recordTrace (the
 * response is read from the resolved Message's text blocks), so a direct-SDK
 * lane traces exactly like an adapter lane once its policy opts in.
 */
async function ledgerCall(provider, requestedModel, fn, { promptVersion = null, laneId = null, policyLabel: label = null, trace = null } = {}) {
  // Monotonic clock: callers' own budget math uses Date.now (and tests pin it).
  const t0 = performance.now();
  let value;
  try {
    value = await fn();
  } catch (err) {
    // The adapters' own reason (`<provider>_<status>`, `<provider>_timeout`);
    // llm/call.js requires this module, so its require is lazy.
    let errorCode = 'error';
    try { errorCode = require('./llm/call').providerErrorReason(provider, err); } catch { /* keep the generic code */ }
    const failedId = recordCall({ provider, requestedModel, ok: false, errorCode, latencyMs: Math.round(performance.now() - t0), promptVersion, laneId, policyLabel: label });
    // The calls most worth debugging are the ones that failed: an opted-in
    // lane keeps the request bodies of a rejected call too (no response).
    if (trace) recordTrace(failedId, { system: trace.system, prompt: trace.prompt, laneId });
    throw err;
  }
  // An Anthropic Message that resolved with stop_reason 'refusal' is a
  // failed call (the model declined; the DEEP helper falls over to OpenAI),
  // billed for its tokens like any other answered request. 'max_tokens' is
  // an incomplete one — the output was cut off (the DEEP helper warns and
  // hands it back unchanged) — filed the way OpenAI's `incomplete` status
  // already is, so the ledger's success rate and failure classes do not
  // depend on which provider truncated (Codex r7 on #3846).
  const errorCode = provider !== 'anthropic' ? null
    : value?.stop_reason === 'refusal' ? 'anthropic_refusal'
    : value?.stop_reason === 'max_tokens' ? 'anthropic_incomplete'
    : null;
  const callId = recordCall({
    provider,
    requestedModel,
    servedModel: value?.model || value?.modelVersion,
    ok: !errorCode,
    errorCode,
    usage: extractUsage(provider, value),
    latencyMs: Math.round(performance.now() - t0),
    providerRef: value?.id,
    promptVersion,
    laneId,
    policyLabel: label,
  });
  if (trace) recordTrace(callId, { system: trace.system, prompt: trace.prompt, response: messageText(value), laneId });
  return value;
}

// The text an SDK Message answered with (thinking blocks skipped) — the
// response body a trace keeps. Null when the value carries no text blocks.
function messageText(value) {
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  return text || null;
}

// One row per session, keyed by the session id in provider_ref (unique
// partial index llm_dispatch_log_session_ref_uidx, migration 000010). The
// customer assistant re-records after EVERY turn of its long-lived session
// with cumulative usage, and two turns can overlap, so the write is ONE
// atomic INSERT … ON CONFLICT whose every merged column is MONOTONE — no
// ordering between writers is assumed: token counters keep the GREATEST
// snapshot (cumulative counts only grow), latency keeps the longest turn,
// and a terminal status is sticky (ok can only go false, the first error
// code / class stays), so a delayed pre-termination snapshot can never
// resurrect a terminated session. A runner's finally re-bills safely; a sum
// over session rows never counts a session twice.
//
// Beside it, ONE row_kind='session_turn' row per turn carries that turn's
// share: the counters minus the session row's previous snapshot, this
// turn's latency and outcome. Windowed reads (agent-control hub) sum turn
// rows, so a session live across a window edge contributes only what it
// did inside the window (GH codex #3869 r2). The read-then-write runs in
// one short transaction under a per-session advisory lock (no network I/O
// inside it), so two overlapping records of one session cannot both
// subtract the same snapshot: the deltas always sum to the cumulative row.
//
// Attribution WITHIN a session is exact when its turns are sequential —
// every runner but the customer assistant is one turn per session, and
// the assistant's turns are one per inbound customer message. If two
// turns of one session DO overlap, or a turn's failed usage GET is only
// recovered after a later turn landed, the later record carries the
// earlier turn's tokens (the total stays exact); the provider exposes no
// per-turn usage to do better with. The hub states this as
// basis.sessions = 'per_turn' with its caveat.
//
// A turn is identified by step_id = uuid v5 of (session id, turn id) —
// the caller's `turnId` when it passes one (the assistant mints one per
// turn; a start time alone could collide inside one millisecond), else
// the turn start — unique per turn row (migration 000030). Every re-record of the
// same turn — a runner's finally re-billing, a retried terminal write, a
// recovered usage GET — lands on the SAME row through the same monotone
// merge the session row uses (pre-push audits on #3869): counters and
// latency only grow, ok only goes false, the first error stays. A record
// with unknown usage (the GET failed) still writes its turn row with null
// counters; the recovered snapshot fills it in place.
const SESSION_COUNTERS = ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens'];
const SESSION_TURN_NS = '60c2b5a4-2f0e-4f3b-9a4e-3f7e6d2c1b0a';
function sessionTurnKey(sessionId, startedAt, turnId) {
  const turn = turnId || (startedAt ? Number(startedAt) : null);
  return turn ? uuidv5(`${sessionId}:${turn}`, SESSION_TURN_NS) : null;
}
function sessionTurnRow(row, prev, turnKey) {
  const turn = { ...row, row_kind: 'session_turn', step_id: turnKey };
  for (const col of SESSION_COUNTERS) {
    // null = this turn's usage GET failed; no number is better than a false zero
    turn[col] = row[col] == null ? null : Math.max(row[col] - Number(prev?.[col] || 0), 0);
  }
  return turn;
}
// Every merged column is MONOTONE — no ordering between writers is assumed.
// The session row's counters are cumulative snapshots → GREATEST. A turn
// row's counters are DELTAS since the session row's previous snapshot, so a
// re-record of the same turn carries only what arrived since its last
// record (0 for an identical snapshot, everything for one recovered from a
// failed GET, the increment for a snapshot that grew) → they ADD; null
// only while every record of the turn has had unknown usage.
function monotoneMerge(db, { counters = 'greatest' } = {}) {
  const greatest = (col) => db.raw(`GREATEST(EXCLUDED.${col}, llm_dispatch_log.${col})`);
  const first = (col) => db.raw(`COALESCE(llm_dispatch_log.${col}, EXCLUDED.${col})`);
  const add = (col) => db.raw(`CASE WHEN llm_dispatch_log.${col} IS NULL AND EXCLUDED.${col} IS NULL THEN NULL ELSE COALESCE(llm_dispatch_log.${col}, 0) + COALESCE(EXCLUDED.${col}, 0) END`);
  return {
    ok: db.raw('(llm_dispatch_log.ok AND EXCLUDED.ok)'),
    error_code: first('error_code'),
    error_class: first('error_class'),
    latency_ms: greatest('latency_ms'),
    // the session's start is its EARLIEST recorded turn start; a turn's
    // re-record carries the same start (LEAST skips a null side)
    started_at: db.raw('LEAST(llm_dispatch_log.started_at, EXCLUDED.started_at)'),
    served_model: first('served_model'),
    ...Object.fromEntries(SESSION_COUNTERS.map((col) => [col, counters === 'add' ? add(col) : greatest(col)])),
  };
}
// Inside recordSessionUsage's locked transaction (`trx`); the caller's catch
// turns any failure into a null id.
async function upsertSessionRow(trx, row, turnKey) {
  const db = require('../models/db');
  const prev = await trx('llm_dispatch_log').where({ provider_ref: row.provider_ref, row_kind: 'session' }).first(SESSION_COUNTERS);
  const id = await writtenId(trx('llm_dispatch_log')
    .insert(row)
    .onConflict(db.raw("(provider_ref) WHERE row_kind = 'session'"))
    .merge(monotoneMerge(db)));
  if (turnKey) {
    await trx('llm_dispatch_log')
      .insert(sessionTurnRow(row, prev || null, turnKey))
      .onConflict(db.raw("(step_id) WHERE row_kind = 'session_turn'"))
      .merge(monotoneMerge(db, { counters: 'add' }));
  }
  return id;
}

/**
 * One row_kind='session' row per Managed Agents session, from the session's
 * own usage block (GET /v1/sessions/{id}). Called by the six agent runners in
 * their `finally` once the SSE loop ends (however it ends); never throws into
 * them. The one-shot runners AWAIT it, so a preview / CLI process that exits
 * after the run cannot lose the row; the customer assistant fires it without
 * waiting (a reply must not wait on the usage GET). Re-recording the same session id updates its row (see
 * upsertSessionRow). `latency_ms` is the wall time since `startedAt`, taken
 * BEFORE the usage GET so a slow or timed-out fetch is never billed as agent
 * latency: the run for one-shot runners, the longest turn for the assistant.
 * `failure` is the runner's OWN outcome — null on success, else the Error it
 * threw or a short code (`initial_message_failed`, `missing_draft`,
 * `session_error_event`, `session_timeout` for a runner's own deadline,
 * `max_events` / `max_tool_calls` when its own cap ended the stream, or a
 * helper's `anthropic_<status>`) — combined with the remote status: the row is ok
 * only when the session is not terminated AND the runner succeeded, so an
 * application-level failure is never hidden behind an idle session. When
 * the usage GET itself fails (429, network, the 15 s timeout) the session
 * is still written — from the id the runner already holds, with null token
 * counts a later re-record fills in (GREATEST treats null as absent) — so a
 * billed session never vanishes from the ledger during API degradation.
 * `agentId` is accepted for the runners' convenience but has no column yet —
 * the session id (provider_ref) resolves it in the Console.
 */
async function recordSessionUsage({ laneId, sessionId, agentId = null, model = null, startedAt = null, turnId = null, failure = null } = {}) {
  try {
    if (!ledgerEnabled() || !sessionId) return null;
    const latencyMs = startedAt ? toCount(Date.now() - Number(startedAt)) : null;
    const ctx = agentContext.current();
    const lane = laneId || ctx.laneId || null;
    // The usage GET runs OUTSIDE the transaction below: a pooled connection
    // is never held across network I/O (pre-push audit on #3869).
    // Empty when the GET misses: the row still lands, without counts.
    let session = {};
    try {
      const { anthropicSessionsFetch } = require('./intelligence-bar/managed-agents-ops-tools');
      session = (await anthropicSessionsFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`)) || {};
    } catch (err) {
      logger.warn(`[llm-dispatch-metrics] session ${sessionId} usage unavailable (${err.message}) — recording the session without token counts`);
    }
    const tokens = extractUsage('anthropic', { usage: session.usage });
    // The runner's own outcome first (session_error_event, max_events, an
    // anthropic_429 — the codes the taxonomy classifies); a terminated
    // session only names the failure when the runner had none (Codex r10).
    const errorCode = failureCode(failure) || (session.status === 'terminated' ? 'session_terminated' : null);
    logger.debug(`[llm-dispatch-metrics] session ${sessionId} (${agentId}) usage in=${tokens.input_tokens} out=${tokens.output_tokens} ${errorCode || 'ok'}`);
    const db = require('../models/db');
    return await db.transaction(async (trx) => {
      // Short: lock, read the previous snapshot, write both rows.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [sessionId]);
      return await upsertSessionRow(trx, {
        ...ledgerRow({
          ctx,
          rowKind: 'session',
          laneId: lane,
          policyLabel: lane || `anthropic/${model || 'session'}`,
          provider: 'anthropic',
          requestedModel: model,
          servedModel: session.model,
          ok: !errorCode,
          errorCode,
          tokens,
          latencyMs,
          providerRef: sessionId,
        }),
        // the start the runner captured, persisted: created_at is the
        // recording time, AFTER the usage GET, so a start derived from it
        // drifts by the whole fetch (Codex r12 on #3891)
        started_at: startedAt ? new Date(Number(startedAt)) : null,
      }, sessionTurnKey(sessionId, startedAt, turnId));
    });
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] recordSessionUsage skipped: ${err.message}`);
    return null;
  }
}

// The runner's outcome as a ledger error code: a thrown Error keeps its own
// `code` when it has one, otherwise `runner_error`; a string is a code.
function failureCode(failure) {
  if (!failure) return null;
  if (failure instanceof Error) return String(failure.code || 'runner_error').slice(0, 80);
  return String(failure).slice(0, 80);
}

/**
 * Keep the redacted bodies of one call, fire-and-forget. Only when
 * GATE_LLM_CALL_TRACES is on AND the lane's runtime policy opts in
 * (`trace: true`). A LOW-confidence redaction is never persisted, on any
 * lane: the redactor reports low exactly when its name / address heuristics
 * may be blind, and a report or draft lane carries customer names as
 * readily as an inbound one — "redacted" has to mean it. Bodies are
 * redacted in full and THEN capped, so a cap can never split a phone number
 * into an unredacted half. Nothing is written when the call row itself was
 * not (null id).
 */
function recordTrace(callIdPromise, { system = null, prompt = null, response = null, laneId = null } = {}) {
  try {
    if (!tracesEnabled()) return;
    const ctx = agentContext.current();
    const lane = laneId || ctx.laneId || null;
    if (!lane || policyFor(lane).trace !== true) return;
    const runId = ctx.runId || null;
    void Promise.resolve(callIdPromise).then((callId) => {
      if (callId === null || callId === undefined) return null;
      const { redact } = require('./content/pii-redactor');
      const RANK = { high: 0, medium: 1, low: 2 };
      let worst = 'high';
      const clean = (body) => {
        if (body === null || body === undefined) return null;
        const r = redact(String(body));
        if (RANK[r.confidence] > RANK[worst]) worst = r.confidence;
        return r.text.slice(0, TRACE_BODY_CAP);
      };
      const row = {
        system_redacted: clean(system),
        prompt_redacted: clean(prompt),
        response_redacted: clean(response),
      };
      if (worst === 'low') {
        logger.debug(`[llm-dispatch-metrics] trace for call ${callId} (${lane}) skipped: low redaction confidence`);
        return null;
      }
      return require('../models/db')('llm_call_traces').insert({
        call_id: callId,
        lane_id: lane,
        run_id: runId,
        ...row,
        redaction_confidence: worst,
      });
    }).catch((err) => {
      logger.debug(`[llm-dispatch-metrics] trace insert failed: ${err.message}`);
    });
  } catch (err) {
    logger.debug(`[llm-dispatch-metrics] trace skipped: ${err.message}`);
  }
}

/**
 * Render and send the exception email. Shared by the normal path and the
 * DB-failure path, which must be able to alert over SMTP precisely when the
 * database it reports on is unreadable.
 */
function emailExceptions(day, exceptions) {
  const items = exceptions
    .map((e) => `<li style="margin:0 0 10px 0;"><strong>${e.policy}</strong> — ${e.detail}</li>`)
    .join('');
  return require('./email').send({
    to: DIGEST_TO,
    subject: `FIX: LLM dispatch exceptions — ${day}`,
    heading: 'AI dispatch exceptions',
    body: `${exceptions.length === 1 ? 'One exception' : `${exceptions.length} exceptions`} on ${day}:<ul style="padding-left:20px;margin:12px 0;">${items}</ul>Normal traffic is never reported — this email only sends when something degraded, or when nothing was recorded at all.`,
  });
}

/**
 * Send an alert and NEVER let its own failure be silent. `email.send` resolves
 * `{ ok: false }` instead of rejecting, so a bare `.catch()` would miss an
 * undelivered alert entirely — the precise way this feature could lose the
 * message it exists to deliver. Used by the paths that cannot throw onward.
 */
async function emailAlert(day, exceptions) {
  try {
    const sent = await emailExceptions(day, exceptions);
    if (!sent?.ok) {
      logger.error(`[llm-dispatch-metrics] ALERT UNDELIVERED (${sent?.error || 'unknown email error'}): ${exceptions.map((e) => e.detail).join(' | ')}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    logger.error(`[llm-dispatch-metrics] ALERT UNDELIVERED (${err.message}): ${exceptions.map((e) => e.detail).join(' | ')}`);
    return { ok: false };
  }
}

/**
 * Alert that the recorder could not even be reached — used when the cron lock
 * cannot acquire a DB connection, so runLlmDispatchDigest never runs at all.
 *
 * `acquireConnection` rejecting proves only that THIS process's pool had no
 * connection at that instant — a local pool timeout under load, not
 * necessarily a database outage (codex r7). So before alarming, CONFIRM with
 * one direct cheap query: if it answers, the DB is fine (and on an overlap
 * the other instance is running the digest) — log and stand down. Only when
 * the confirm also fails is "unreachable" earned, and the alert email itself
 * touches no database.
 */
async function alertRecorderUnreachable(reason) {
  if (!isEnabled()) return { skipped: 'gate_off' };
  try {
    // The confirm must NOT ride the shared knex pool: `acquireConnection`
    // rejecting usually means THIS process's pool is saturated, and a query
    // queued behind that same pool would time out too — reading a busy-but-
    // healthy database as an outage (codex #3123 r8, accepted residual then,
    // fixed here). A dedicated single-use pg.Client answers the only question
    // that matters: does PostgreSQL itself accept a connection right now?
    // SSL mirrors server/knexfile.js production settings.
    const { Client } = require('pg');
    // Connection settings are INHERITED from the live knex instance, not
    // re-derived: a string-match heuristic ("localhost" ⇒ no SSL) would
    // misclassify 127.0.0.1-style local URLs and demand TLS from a plain
    // local Postgres — failing the probe and false-alarming an outage
    // (codex #3130 r1). Whatever connection shape knex is successfully using
    // is by definition the right one to probe with.
    const liveConn = require('../models/db')?.client?.config?.connection;
    const connCfg = typeof liveConn === 'string'
      ? { connectionString: liveConn }
      : (liveConn || { connectionString: process.env.DATABASE_URL });
    const probe = new Client({
      ...connCfg,
      connectionTimeoutMillis: 4000,
      query_timeout: 4000,
    });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
    } finally {
      await probe.end().catch(() => {});
    }
    logger.warn(`[llm-dispatch-metrics] digest tick failed (${reason}) but PostgreSQL accepts a fresh connection — local pool saturation or a transient query failure, not a database outage; standing down`);
    return { skipped: 'db_reachable' };
  } catch (confirmErr) {
    logger.error(`[llm-dispatch-metrics] DB unreachable confirmed (${reason}; independent-connection probe: ${confirmErr.message})`);
  }
  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = etDateString(addETDays(new Date(), -1));
  return emailAlert(day, [{
    policy: '(recorder)',
    kind: 'not_recording',
    detail: `the digest could not run at all — the database was unreachable (${reason}). Recording status for ${day} is UNKNOWN; treat this as an outage, not a quiet day.`,
  }]);
}

/**
 * How many DISTINCT HOURS of a window the recorder proved itself in.
 *
 * Counting rows would overstate coverage: the heartbeat cron runs without the
 * exclusive lock (a duplicate heartbeat is harmless, a skipped one is not), so
 * multiple replicas — or old and new instances overlapping at :50 during a
 * deploy — each insert a row for the same hour. Two replicas covering only the
 * morning would reach 20 rows and make a half-dead day look fully covered.
 * Hour buckets are the honest unit. (ET offsets are whole hours, so bucketing
 * in the session's UTC does not change the count over an ET-day window.)
 */
async function countHeartbeats(db, start, end) {
  const row = await db('llm_dispatch_log')
    .where('created_at', '>=', start)
    .andWhere('created_at', '<', end)
    .andWhere('row_kind', 'heartbeat')
    .count({ n: db.raw("DISTINCT date_trunc('hour', created_at)") })
    .first();
  return Number(row?.n || 0);
}

/** [startOfDay, startOfNextDay) as real Dates for the ET day N days ago. */
function etDayWindow(daysAgo) {
  const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
  const start = parseETDateTime(`${etDateString(addETDays(new Date(), -daysAgo))}T00:00`);
  const end = parseETDateTime(`${etDateString(addETDays(new Date(), -(daysAgo - 1)))}T00:00`);
  return { start, end };
}

/**
 * Compute yesterday's exceptions. Exported for tests; takes rows already
 * aggregated per policy: { policy, total, fallbacks, failed } plus the
 * prior-7-day totals { policy, total }.
 */
function detectExceptions(yesterdayStats, priorWeekStats, recorderIssue = null, absenceJudgeable = true, recentActivePolicies = null) {
  const exceptions = [];

  // Recording health FIRST — without it, "no email" is ambiguous between
  // "nothing was wrong" and "nothing was recorded at all". `recorderIssue` is
  // a COMPLETE sentence composed by the caller and rendered VERBATIM: the
  // caller is the one that knows whether the evidence says "failed", "gate
  // was off", or "partial coverage", and an earlier version of this wrapper
  // prefixed "could not write" onto an UNKNOWN-status message, contradicting
  // it (codex r7).
  if (recorderIssue) {
    exceptions.push({
      policy: '(recorder)',
      kind: 'not_recording',
      detail: recorderIssue,
    });
  }

  // Per-policy findings below come from rows that DO exist, so they are real
  // regardless of the probe — a transient probe failure must never suppress a
  // genuine provider incident that was already recorded.
  for (const s of yesterdayStats) {
    if (s.failed > 0) {
      exceptions.push({
        policy: s.policy,
        kind: 'all_providers_failed',
        // Single-leg policies (pinned sealed-exam lanes) have no fallback BY
        // DESIGN — "failed on BOTH providers" would be false for them.
        detail: s.singleLeg
          ? `${s.failed} of ${s.total} calls failed (single-leg policy, no fallback configured — callers fell back to safe copy or errored)`
          : `${s.failed} of ${s.total} calls failed on BOTH providers (callers fell back to safe copy or errored)`,
      });
    }
    if (s.total >= FALLBACK_MIN_VOLUME && s.fallbacks / s.total >= FALLBACK_RATE_THRESHOLD) {
      exceptions.push({
        policy: s.policy,
        kind: 'fallback_rate',
        detail: `fallback provider answered ${s.fallbacks} of ${s.total} calls (${Math.round((s.fallbacks / s.total) * 100)}%) — primary route is degraded`,
      });
    }
  }
  // gone-silent is the ONE check a broken recorder fully explains: it fires on
  // the ABSENCE of rows, which is exactly what a dead write path produces. So
  // it — and only it — is skipped when the recorder was down, or every
  // prior-week policy would report a duplicate symptom of that root cause.
  // It is likewise skipped when the day has no heartbeat coverage at all
  // (first deploy / gate previously off), where absence proves nothing.
  const yesterdayByPolicy = new Map(yesterdayStats.map((s) => [s.policy, s]));
  for (const w of (recorderIssue || !absenceJudgeable) ? [] : priorWeekStats) {
    if (EPISODIC_LANE_RE.test(w.policy)) continue; // one-shot lanes go quiet by design
    if (w.total < SILENT_MIN_WEEKLY || yesterdayByPolicy.has(w.policy)) continue;
    // Cadence split: near-daily policies (or legacy stats without activeDays)
    // alarm on one zero day; bursty ones need the whole recent window silent.
    // `recentActivePolicies` = policies with >=1 call in the last
    // SILENT_CONSECUTIVE_DAYS ET days; null (legacy caller/tests) means no
    // recent-window evidence, which falls back to the immediate alarm.
    const nearDaily = w.activeDays == null || w.activeDays >= DAILY_CADENCE_MIN_DAYS;
    if (nearDaily) {
      exceptions.push({
        policy: w.policy,
        kind: 'gone_silent',
        detail: `averaged ${Math.round(w.total / 7)} calls/day over the prior week but made ZERO calls yesterday — the feature may have stopped running`,
      });
    } else if (!recentActivePolicies || !recentActivePolicies.has(w.policy)) {
      exceptions.push({
        policy: w.policy,
        kind: 'gone_silent',
        detail: `made ${w.total} calls across ${w.activeDays} day(s) of the prior week but has now been silent for ${SILENT_CONSECUTIVE_DAYS}+ days — the feature may have stopped running`,
      });
    }
  }
  return exceptions;
}

async function loadStats(db, start, end) {
  const rows = await db('llm_dispatch_log')
    .where('created_at', '>=', start)
    .andWhere('created_at', '<', end)
    // Chain rows only: per-call and per-session ledger rows share the table
    // but describe legs, not outcomes, and would double-count every chain.
    .where('row_kind', 'chain')
    .whereNot('policy', HEARTBEAT_POLICY)
    .groupBy('policy')
    .select('policy')
    .count({ total: '*' })
    .sum({ fallbacks: db.raw('CASE WHEN fallback_used THEN 1 ELSE 0 END') })
    .sum({ failed: db.raw('CASE WHEN ok THEN 0 ELSE 1 END') })
    // Legs actually attempted on the worst failed chain: pinned single-leg
    // policies (the sealed exams disable cross-provider fallback so provider
    // A's exam can't be graded on provider B's draft) record exactly one
    // failure entry, and the digest must not report their misses as "failed
    // on BOTH providers".
    .max({ max_failure_legs: db.raw("CASE WHEN ok THEN NULL ELSE jsonb_array_length(COALESCE(failure_reasons, '[]'::jsonb)) END") })
    // Distinct ET days the policy actually ran — the cadence evidence the
    // gone-silent check splits on. Window bounds are already ET-day-aligned.
    .countDistinct({ active_days: db.raw("(created_at AT TIME ZONE 'America/New_York')::date") });
  return rows.map((r) => ({
    policy: r.policy,
    total: Number(r.total),
    fallbacks: Number(r.fallbacks || 0),
    failed: Number(r.failed || 0),
    singleLeg: Number(r.failed || 0) > 0 && Number(r.max_failure_legs) === 1,
    activeDays: Number(r.active_days || 0),
  }));
}

/**
 * Daily digest tick. Aggregates yesterday's ET day, emails the company inbox
 * ONLY when exceptions exist, then prunes rows past retention.
 */
// One retention DELETE: the rows older than `days` ET days. Never throws —
// the digest treats a failed prune as maintenance-only (see the call site).
async function pruneOlderThan(db, table, days) {
  try {
    const pruned = await db(table).where('created_at', '<', etDayWindow(days).start).del();
    logger.debug(`[llm-dispatch-metrics] pruned ${pruned} ${table} row(s) older than ${days} days`);
    return { pruned, error: null };
  } catch (err) {
    const error = err.message || String(err);
    logger.error(`[llm-dispatch-metrics] ${table} retention prune failed (maintenance only — digest continues): ${error}`);
    return { pruned: 0, error };
  }
}

async function runLlmDispatchDigest() {
  const db = require('../models/db');

  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = etDateString(addETDays(new Date(), -1));

  // EVERY table read/write below can throw — a missing table or a dead DB
  // takes out the retention DELETE and the stats SELECTs before any analysis
  // runs. The alert must not depend on the thing it is alerting about, so a
  // DB failure is caught here and emailed over SMTP, then rethrown so
  // cron-lock job health records the failed run too. Without this, the single
  // worst case (table gone) produced silence — the exact failure this whole
  // lane exists to eliminate.
  let yesterdayStats;
  let priorWeekStats;
  let recentStats;
  let heartbeats = 0;
  let priorHeartbeats = 0;

  // Retention pruning runs regardless of the gate (codex r2 P2: a kill-switch
  // flip must not park rows forever); traces age out on their own shorter
  // window for the same reason. Each prune FAILS INDEPENDENTLY (codex r7): a
  // DELETE deadlock or lost DELETE grant says nothing about recorder health,
  // and must not abort the digest or masquerade as an outage while INSERT and
  // SELECT still work. Maintenance failure = log and carry on; a genuinely
  // dead table fails the stats reads below, which DO alert.
  const { pruned, error: pruneError } = await pruneOlderThan(db, 'llm_dispatch_log', RETENTION_DAYS);
  await pruneOlderThan(db, 'llm_call_traces', TRACE_RETENTION_DAYS);

  if (!isEnabled()) return { skipped: 'gate_off', pruned, ...(pruneError ? { pruneError } : {}) };

  try {
    const yesterday = etDayWindow(1);
    const weekBefore = etDayWindow(8);
    // Recent window for the bursty-policy silence check: the last
    // SILENT_CONSECUTIVE_DAYS full ET days, yesterday inclusive. A partial-
    // coverage day inside it can only read as MORE silence (alarm-leaning),
    // and such days already send their own partial-coverage notice.
    const recent = etDayWindow(SILENT_CONSECUTIVE_DAYS);
    [yesterdayStats, priorWeekStats, recentStats, heartbeats, priorHeartbeats] = await Promise.all([
      loadStats(db, yesterday.start, yesterday.end),
      loadStats(db, weekBefore.start, yesterday.start),
      loadStats(db, recent.start, yesterday.end),
      countHeartbeats(db, yesterday.start, yesterday.end),
      countHeartbeats(db, weekBefore.start, yesterday.start),
    ]);
  } catch (err) {
    // Stats reads failing means the day genuinely cannot be analyzed — alert
    // over SMTP (which does not depend on the DB being reported on), then
    // rethrow so cron-lock job health records the failed run. The gate check
    // above already returned, so a dark deployment cannot reach this email.
    const reason = err.message || String(err);
    logger.error(`[llm-dispatch-metrics] digest could not read llm_dispatch_log: ${reason}`);
    const sent = await emailAlert(day, [{
      policy: '(recorder)',
      kind: 'not_recording',
      detail: `the digest could not read llm_dispatch_log (${reason}). Recording status for ${day} is UNKNOWN — treat this as an outage until it clears, not as a quiet day.`,
    }]);
    // Tell the scheduler's catch this failure already produced its alert —
    // otherwise it would fire alertRecorderUnreachable on top and double-email
    // the same outage. Only when delivery actually SUCCEEDED (codex #3130
    // r1): claiming alerted on a failed send would suppress the scheduler's
    // fallback — the one retry that could still reach the operator after a
    // transient mail failure.
    err.alerted = !!sent?.ok;
    throw err;
  }

  // Recorder health is judged from the DAY BEING SUMMARIZED, via heartbeats
  // written hourly during it — not from a probe at digest time, which an
  // overnight recovery would pass while the lost day reported clean.
  //
  // But a day with no heartbeats is only an OUTAGE if coverage was actually
  // running: on first deploy, or after the gate was off, recordHeartbeat
  // no-opped and the day is simply unjudgeable. priorHeartbeats > 0 is the
  // evidence that coverage existed.
  // Every message is deliberately phrased as UNKNOWN rather than "the
  // recorder broke": low/zero heartbeats are equally consistent with the gate
  // having been off, and telling those apart would need persisted gate
  // history for a state only the operator can cause and would recognise.
  // What the digest owes the reader is the true statement either way: this
  // day cannot be read as healthy. Statelessness is also why EVERY
  // low-coverage state emails instead of only logging — an info log was the
  // old behavior, and it meant a recorder broken from first deploy (or an
  // outage older than the 7-day lookback) stayed silent FOREVER (codex r7).
  // The zero/zero notice self-qualifies: it is expected once on enablement
  // day, and its daily repetition is precisely the outage signal.
  let recorderIssue = null;
  if (heartbeats === 0 && priorHeartbeats > 0) {
    recorderIssue = `no heartbeat rows were recorded during ${day}, though the recorder was writing earlier in the week — either it failed or the feature was disabled for that day. Recording status for ${day} is UNKNOWN; it cannot be read as a healthy quiet day.`;
  } else if (heartbeats === 0 && priorHeartbeats === 0) {
    recorderIssue = `no recorder heartbeats exist for ${day} or the 7 days before it. This is expected if GATE_LLM_DISPATCH_METRICS was enabled (or this feature deployed) within the last day — but if this message repeats tomorrow, the recorder has never successfully written and should be treated as down.`;
  } else if (heartbeats < MIN_DAY_COVERAGE) {
    recorderIssue = `only ${heartbeats} of ~24 hours of ${day} have recorder heartbeats — partial coverage (deploy gap, gate toggle, or a partial outage). Dispatches during the uncovered hours may be missing from these stats, so ${day} cannot be fully trusted.`;
  }

  // Absence checks need a day covered nearly end to end. On a partial day
  // (gate toggled, deploy gap) "policy X recorded nothing" is uninformative,
  // and with zero heartbeats it is meaningless.
  const exceptions = detectExceptions(
    yesterdayStats, priorWeekStats, recorderIssue, heartbeats >= MIN_DAY_COVERAGE,
    new Set(recentStats.map((s) => s.policy)),
  );
  let sendError = null;
  if (exceptions.length) {
    const sent = await emailExceptions(day, exceptions);
    if (!sent.ok) sendError = sent.error || 'unknown email error';
  }

  // An undeliverable exception email must FAIL the job (retention pruning
  // already ran above, independently) — otherwise runExclusive records a
  // healthy run, tomorrow's tick moves to a new window, and the alert is
  // silently lost. The throw lands in the scheduler's catch -> logger.error
  // -> Sentry, and cron-lock job health shows the miss.
  if (sendError) {
    throw new Error(`digest email failed with ${exceptions.length} undelivered exception(s): ${sendError}`);
  }

  logger.info(`[llm-dispatch-metrics] digest: ${exceptions.length} exception(s), emailed=${exceptions.length > 0}, pruned=${pruned}${pruneError ? ` pruneError=${pruneError}` : ''}`);
  return { exceptions, emailed: exceptions.length > 0, pruned, ...(pruneError ? { pruneError } : {}) };
}

module.exports = {
  RETENTION_DAYS,
  recordDispatch,
  recordHeartbeat,
  recordCall,
  failCall,
  ledgerCall,
  recordSessionUsage,
  recordTrace,
  extractUsage,
  TRACE_RETENTION_DAYS,
  TRACE_BODY_CAP,
  runLlmDispatchDigest,
  alertRecorderUnreachable,
  detectExceptions,
  policyLabel,
  runAsReplay,
  recordedPolicyLabel,
  HEARTBEAT_POLICY,
  FALLBACK_RATE_THRESHOLD,
  FALLBACK_MIN_VOLUME,
  SILENT_MIN_WEEKLY,
  DAILY_CADENCE_MIN_DAYS,
  SILENT_CONSECUTIVE_DAYS,
};
