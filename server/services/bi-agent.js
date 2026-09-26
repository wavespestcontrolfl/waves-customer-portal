/**
 * Weekly BI Agent — Session Manager
 *
 * Usage:
 *   const BIAgent = require('./bi-agent');
 *   await BIAgent.run(); // full Monday briefing
 *
 * Protocol: managed-agents-2026-04-01. Events POST is `{ events: [...] }`;
 * the stream lives at GET /sessions/{id}/events/stream (opened BEFORE the
 * kickoff user.message — the stream does not replay events emitted before it
 * opened); custom tool calls surface as `agent.custom_tool_use` events and
 * are executed in a batch when `session.status_idle` arrives with
 * `stop_reason: { type: 'requires_action', event_ids }` — every result for
 * that idle goes back in ONE POST as `user.custom_tool_result` events. Same
 * shape as server/services/seo/backlink-strategy-agent.js, minus its legacy
 * `tool_use` branch (that protocol predates this one).
 */

const logger = require('./logger');
const { executeBITool } = require('./bi-agent-tools');
const { BI_AGENT_CONFIG } = require('./bi-agent-config');
const { recordSessionUsage } = require('./llm-dispatch-metrics');
const { isSessionTerminal, isSessionError } = require('./agent-control/session-events');
const { readSessionFrames } = require('./agent-control/session-stream');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BI_AGENT_ID = process.env.BI_AGENT_ID;
const BI_AGENT_ENVIRONMENT_ID = process.env.BI_AGENT_ENVIRONMENT_ID || process.env.ANTHROPIC_ENVIRONMENT_ID;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Defensive parse: an unset, blank, non-numeric, or non-positive override
// falls back to the default rather than producing a NaN/zero/negative
// deadline that would time out (or never time out) the run.
function resolveTimeoutMs() {
  const raw = process.env.BI_AGENT_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function buildUserMessageEvent(text) {
  return { type: 'user.message', content: [{ type: 'text', text }] };
}

function buildToolResultEvent(toolUseId, toolResult, isError) {
  return {
    type: 'user.custom_tool_result',
    custom_tool_use_id: toolUseId,
    content: [{ type: 'text', text: JSON.stringify(toolResult) }],
    ...(isError ? { is_error: true } : {}),
  };
}

function toolUseIdFromEvent(data = {}) {
  return data.id || data.custom_tool_use_id || data.tool_use_id;
}

function stopReasonFromEvent(data = {}) {
  return typeof data.stop_reason === 'string' ? { type: data.stop_reason } : data.stop_reason;
}

// Our own deadline, not the provider's — the ledger files it as a timeout.
// Same shape as server/services/content/agents/agent-dispatcher.js.
function deadlineError(sessionId, deadline) {
  return Object.assign(new Error(`session ${sessionId} timed out at its ${new Date(deadline).toISOString()} deadline`), { code: 'session_timeout' });
}

async function apiCall(method, path, body, signal) {
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers: {
      'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER, 'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`API ${res.status}: ${await res.text()}`), { status: res.status, code: `anthropic_${res.status}` });
  return res.json();
}

function remainingMs(sessionId, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError(sessionId, deadline);
  return remaining;
}

// Every API request — session creation included — is bounded by the run's
// deadline: a stalled request must not keep run() pending past it.
async function apiCallWithinDeadline(method, path, body, sessionId, deadline) {
  const signal = AbortSignal.timeout(remainingMs(sessionId, deadline));
  try {
    return await apiCall(method, path, body, signal);
  } catch (err) {
    if (signal.aborted) throw deadlineError(sessionId, deadline);
    throw err;
  }
}

function sendSessionEvents(sessionId, events, deadline) {
  return apiCallWithinDeadline('POST', `/sessions/${sessionId}/events`, { events }, sessionId, deadline);
}

// A local tool call cannot be cancelled, but the run stops waiting for it at
// the deadline and starts no further tool after it. That includes the two
// side effects: a send abandoned in flight cannot become a second text,
// because the owner text is claimed once per ET week before it is sent
// (bi-briefing-sms.js), and a saved report row is this run's own record.
async function withinDeadline(promise, sessionId, deadline) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(deadlineError(sessionId, deadline)), remainingMs(sessionId, deadline));
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Opens the SSE fetch and returns once the response headers are in — the
// caller sends the kickoff message only after this resolves, per the
// protocol's stream-first requirement. The AbortController fires at the
// wall-clock deadline so a session that never terminates doesn't hang the
// run forever; readStreamFrames below also checks the deadline per-frame.
async function openSessionStream(sessionId, deadline) {
  const controller = new AbortController();
  const timeoutMs = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER, accept: 'text/event-stream',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw deadlineError(sessionId, deadline);
    throw err;
  }
  if (!res.ok || !res.body) {
    // The deadline stays armed through the error-body read — a non-2xx
    // response that stalls mid-body must still end as session_timeout.
    let errText = '';
    try {
      errText = res.body ? await res.text() : '';
    } catch (err) {
      if (err?.name === 'AbortError') throw deadlineError(sessionId, deadline);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    throw Object.assign(new Error(`Stream ${res.status}: ${errText}`), { status: res.status, code: `anthropic_${res.status}` });
  }
  return { res, timer, controller };
}

// One classification per frame, carrying everything the run loop acts on;
// `end` marks the frame that ends the session — including a final
// agent.message that carries stop_reason end_turn alongside its text. The
// JSON `type` is authoritative: the SSE `event:` line may be absent, and
// readSessionFrames then reports 'message'.
function classifyFrame(event, data) {
  const type = data?.type || event;
  if (type === 'agent.message' || event === 'assistant' || event === 'text') {
    return { kind: 'text', end: isSessionTerminal(event, data) };
  }
  if (type === 'agent.custom_tool_use') return { kind: 'tool_use' };
  if (type === 'session.status_idle') {
    const stop = stopReasonFromEvent(data);
    if (stop?.type === 'requires_action') return { kind: 'requires_action', eventIds: stop.event_ids || [] };
    if (stop?.type === 'end_turn') return { kind: 'other', end: true };
    // retries_exhausted, budget_reached, or an unknown stop reason
    return { kind: 'failed', failure: `session_idle_${stop?.type || 'unknown'}` };
  }
  if (isSessionTerminal(event, data)) return { kind: 'other', end: true };
  if (isSessionError(event) || type === 'session.error' || type === 'error') {
    return { kind: 'failed', failure: 'session_error_event', detail: JSON.stringify(data) };
  }
  return { kind: 'other' };
}

function frameText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return (data?.text || '') + blocks.filter(b => b?.type === 'text').map(b => b.text).join('');
}

// Whatever the agent asks, one briefing run makes at most MAX_TOOL_CALLS tool
// calls, runs a tool use id once, and completes each side-effecting tool (the
// SMS to the owner, the saved report) at most once — a looping session must
// not text the owner repeatedly or stack duplicate reports. A side effect
// counts as done only when it actually happened. This set is per run; the
// once-per-ET-week guarantee for the owner text across runs and instances is
// the durable claim in bi-briefing-sms.js, and the Monday cron itself runs
// under runExclusive (scheduler.js).
const MAX_TOOL_CALLS = 30;
const SIDE_EFFECT_DONE = {
  send_briefing_sms: (result) => result?.sent === true,
  save_weekly_report: (result) => Boolean(result) && !result.error,
};
// Run failures that are recorded on the ledger rather than thrown.
const RECORDED_FAILURES = new Set(['session_timeout', 'max_tool_calls']);

// Executes every pending custom tool use a requires_action idle names, then
// replies to ALL of them in ONE POST (the protocol requires the whole batch
// in a single events call, not one per tool). An id this run already
// answered gets its cached result event again — the session is waiting on
// it, and the tool is never re-run (Codex r4). An id with neither a pending
// entry nor a cached answer is logged and skipped — the run still sends the
// results it does have rather than hanging on a name it never saw registered.
async function runRequiresActionBatch(sessionId, deadline, eventIds, pendingCustomToolUses, executeToolUse, answeredResults) {
  const toolResultEvents = [];
  for (const toolUseId of new Set(eventIds)) {
    const pending = pendingCustomToolUses.get(toolUseId);
    if (!pending) {
      const cached = answeredResults.get(toolUseId);
      if (cached) {
        toolResultEvents.push(cached);
        continue;
      }
      logger.error(`[bi-agent] Missing pending custom tool use for required event ${toolUseId}`);
      continue;
    }
    pendingCustomToolUses.delete(toolUseId);
    const { toolResult, threw } = await executeToolUse(toolUseId, pending.toolName, pending.toolInput);
    const resultEvent = buildToolResultEvent(toolUseId, toolResult, threw);
    answeredResults.set(toolUseId, resultEvent);
    toolResultEvents.push(resultEvent);
  }
  if (toolResultEvents.length) await sendSessionEvents(sessionId, toolResultEvents, deadline);
}

async function* readStreamFrames(sessionId, res, deadline) {
  try {
    for await (const { event, data: text } of readSessionFrames(res.body)) {
      if (Date.now() >= deadline) throw deadlineError(sessionId, deadline);
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      yield { event, data };
    }
  } catch (err) {
    // The AbortController firing at the deadline rejects reader.read() with
    // an AbortError — our own timeout, filed as such.
    if (err?.name === 'AbortError') throw deadlineError(sessionId, deadline);
    throw err;
  }
}

const BIAgent = {
  async run(opts = {}) {
    if (!ANTHROPIC_API_KEY || !BI_AGENT_ID) throw new Error('Missing ANTHROPIC_API_KEY or BI_AGENT_ID');
    if (!BI_AGENT_ENVIRONMENT_ID) throw new Error('Missing BI_AGENT_ENVIRONMENT_ID (or ANTHROPIC_ENVIRONMENT_ID)');

    const startTime = Date.now();
    const deadline = startTime + resolveTimeoutMs();
    const notify = opts.onProgress || (() => {});

    let prompt = 'Run the Monday morning business intelligence briefing. Pull all metrics, analyze trends, identify anomalies, send the SMS to Adam, and save the full report.';
    if (opts.skipSMS) prompt += '\n\nSkip the SMS — just generate and save the report.';

    notify('starting', 'Creating BI session...');

    const session = await apiCallWithinDeadline('POST', '/sessions', {
      agent: BI_AGENT_ID,
      environment_id: BI_AGENT_ENVIRONMENT_ID,
    }, 'new session', deadline);
    const sessionId = session.id;
    logger.info(`[bi-agent] Session ${sessionId}`);
    let report = '';
    const toolsExecuted = [];
    let smsSent = false;

    // Call ledger (never throws): one session row with the session's token
    // usage, written however the session ends from here on — a failed first
    // event, a stream that throws or times out, all still consumed tokens —
    // carrying this runner's own outcome. Upserted by session id, so
    // re-billing is safe.
    let failure = null;
    // Set only by a terminal event: any other stream exit is a failure.
    let sessionEnded = false;
    // The run's own end — the ledger's usage GET after it is observability
    // time, not agent time, and stays out of the reported duration.
    let runEndedAt = null;
    let stream = null;

    const pendingCustomToolUses = new Map();
    const resolvedToolUseIds = new Set();
    const answeredResults = new Map();
    const completedSideEffects = new Set();
    let toolCalls = 0;

    const registerToolUse = (event, data) => {
      const toolUseId = toolUseIdFromEvent(data);
      if (!toolUseId) {
        // Tool inputs can carry customer names (the briefing names at-risk
        // customers) — log identifiers only, never the event body.
        logger.error(`[bi-agent] Tool ${data?.name || '(unknown)'} (${data?.type || event}) missing tool use id in session ${sessionId}`);
        return;
      }
      if (resolvedToolUseIds.has(toolUseId)) return; // already answered — the batch resends the cached result
      pendingCustomToolUses.set(toolUseId, { toolName: data.name, toolInput: data.input || {} });
    };

    const executeToolUse = async (toolUseId, toolName, toolInput) => {
      remainingMs(sessionId, deadline); // no tool starts after the deadline
      resolvedToolUseIds.add(toolUseId);
      if (++toolCalls > MAX_TOOL_CALLS) {
        throw Object.assign(new Error(`session ${sessionId} exceeded ${MAX_TOOL_CALLS} tool calls`), { code: 'max_tool_calls' });
      }
      if (completedSideEffects.has(toolName)) {
        return { toolResult: { skipped: true, reason: `${toolName} already completed in this briefing` }, threw: false };
      }
      // A report-only run (skipSMS) never reaches the send, even if the model
      // asks: it must not text the owner or use up the week's briefing text.
      if (opts.skipSMS && toolName === 'send_briefing_sms') {
        return { toolResult: { skipped: true, reason: 'This run is report-only; do not send the SMS.' }, threw: false };
      }
      notify('pulling', `Tool: ${toolName}`);
      logger.info(`[bi-agent] Tool: ${toolName}`);

      let toolResult;
      let threw = false;
      try {
        toolResult = await withinDeadline(executeBITool(toolName, toolInput), sessionId, deadline);
      } catch (err) {
        if (err?.code === 'session_timeout') throw err;
        toolResult = { error: `Tool failed: ${err.message}` };
        threw = true;
        logger.error(`[bi-agent] Tool ${toolName} error: ${err.message}`);
      }
      if (!threw && SIDE_EFFECT_DONE[toolName]?.(toolResult)) completedSideEffects.add(toolName);
      if (toolName === 'send_briefing_sms' && toolResult?.sent) smsSent = true;
      toolsExecuted.push(toolName);
      return { toolResult, threw };
    };

    try {
      // Open the stream BEFORE the kickoff — the stream does not replay
      // events emitted before it opened.
      stream = await openSessionStream(sessionId, deadline);
      await sendSessionEvents(sessionId, [buildUserMessageEvent(prompt)], deadline);

      for await (const { event, data } of readStreamFrames(sessionId, stream.res, deadline)) {
        const frame = classifyFrame(event, data);
        if (frame.kind === 'text') report += frameText(data);
        else if (frame.kind === 'tool_use') registerToolUse(event, data);
        else if (frame.kind === 'requires_action') await runRequiresActionBatch(sessionId, deadline, frame.eventIds, pendingCustomToolUses, executeToolUse, answeredResults);
        else if (frame.kind === 'failed') {
          logger.error(`[bi-agent] Session ${sessionId} failed: ${frame.failure} ${frame.detail || ''}`);
          failure = frame.failure;
          break;
        }
        if (frame.end) { sessionEnded = true; break; }
      }
      // The stream closed (or was left) before the session said it ended:
      // not a success, whatever the session GET reports later.
      if (!failure && !sessionEnded) { logger.error(`[bi-agent] Stream ended without a terminal event for session ${sessionId}`); failure = 'session_stream_eof'; }

    } catch (err) {
      if (!RECORDED_FAILURES.has(err?.code)) {
        failure = err;
        throw err;
      }
      logger.error(`[bi-agent] ${err.message}`);
      failure = err.code;
    } finally {
      // Close the SSE connection on every exit — including a kickoff POST
      // that failed before the stream was ever read (a no-op once the reader
      // has already finished).
      if (stream) {
        clearTimeout(stream.timer);
        stream.controller.abort();
      }
      runEndedAt = Date.now();
      await recordSessionUsage({ laneId: 'agent_bi', sessionId, agentId: BI_AGENT_ID, model: BI_AGENT_CONFIG.model, startedAt: startTime, failure });
    }

    const durationSeconds = Math.round((runEndedAt - startTime) / 1000);
    notify('complete', `Done in ${durationSeconds}s`);

    logger.info(`[bi-agent] Complete: SMS=${smsSent}, ${toolsExecuted.length} tools, ${durationSeconds}s`);
    return { sessionId, smsSent, toolsExecuted, durationSeconds, report };
  },
};

module.exports = BIAgent;
module.exports._test = {
  buildUserMessageEvent,
  buildToolResultEvent,
  toolUseIdFromEvent,
  stopReasonFromEvent,
  resolveTimeoutMs,
  deadlineError,
};
