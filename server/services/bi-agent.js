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

// Every events POST is bounded by the run's deadline too: a stalled request
// must not keep run() pending past it.
async function sendSessionEvents(sessionId, events, deadline) {
  const signal = AbortSignal.timeout(remainingMs(sessionId, deadline));
  try {
    return await apiCall('POST', `/sessions/${sessionId}/events`, { events }, signal);
  } catch (err) {
    if (signal.aborted) throw deadlineError(sessionId, deadline);
    throw err;
  }
}

// A local tool call cannot be cancelled, but the run stops waiting for it at
// the deadline and starts no further tool after it.
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
    clearTimeout(timer);
    const errText = res.body ? await res.text() : '';
    throw Object.assign(new Error(`Stream ${res.status}: ${errText}`), { status: res.status, code: `anthropic_${res.status}` });
  }
  return { res, timer, controller };
}

// Executes every pending custom tool use a requires_action idle names, then
// replies to ALL of them in ONE POST (the protocol requires the whole batch
// in a single events call, not one per tool). An id with no pending entry is
// logged and skipped — the run still sends the results it does have rather
// than hanging on a name it never saw registered.
async function runRequiresActionBatch(sessionId, deadline, eventIds, pendingCustomToolUses, executeToolUse) {
  const toolResultEvents = [];
  for (const toolUseId of eventIds) {
    const pending = pendingCustomToolUses.get(toolUseId);
    if (!pending) {
      logger.error(`[bi-agent] Missing pending custom tool use for required event ${toolUseId}`);
      continue;
    }
    const { toolResult, threw } = await executeToolUse(pending.toolName, pending.toolInput);
    pendingCustomToolUses.delete(toolUseId);
    toolResultEvents.push(buildToolResultEvent(toolUseId, toolResult, threw));
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
    const notify = opts.onProgress || (() => {});

    let prompt = 'Run the Monday morning business intelligence briefing. Pull all metrics, analyze trends, identify anomalies, send the SMS to Adam, and save the full report.';
    if (opts.skipSMS) prompt += '\n\nSkip the SMS — just generate and save the report.';

    notify('starting', 'Creating BI session...');

    const session = await apiCall('POST', '/sessions', {
      agent: BI_AGENT_ID,
      environment_id: BI_AGENT_ENVIRONMENT_ID,
    });
    const sessionId = session.id;
    logger.info(`[bi-agent] Session ${sessionId}`);
    let report = '';
    let toolsExecuted = [];
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
    let streamTimer = null;
    let streamController = null;
    const deadline = Date.now() + resolveTimeoutMs();

    try {
      // Open the stream BEFORE the kickoff — the stream does not replay
      // events emitted before it opened.
      const { res: streamRes, timer, controller } = await openSessionStream(sessionId, deadline);
      streamTimer = timer;
      streamController = controller;

      await sendSessionEvents(sessionId, [buildUserMessageEvent(prompt)], deadline);

      const pendingCustomToolUses = new Map();

      const executeToolUse = async (toolName, toolInput) => {
        remainingMs(sessionId, deadline); // no tool starts after the deadline
        notify('pulling', `Tool: ${toolName}`);
        logger.info(`[bi-agent] Tool: ${toolName}`);

        let toolResult;
        let threw = false;
        try {
          toolResult = await withinDeadline(executeBITool(toolName, toolInput), sessionId, deadline);
          if (toolName === 'send_briefing_sms' && toolResult.sent) smsSent = true;
        } catch (err) {
          if (err?.code === 'session_timeout') throw err;
          toolResult = { error: `Tool failed: ${err.message}` };
          threw = true;
          logger.error(`[bi-agent] Tool ${toolName} error: ${err.message}`);
        }

        toolsExecuted.push(toolName);
        return { toolResult, threw };
      };

      for await (const { event, data } of readStreamFrames(sessionId, streamRes, deadline)) {
        // Agent text arrives as `agent.message` (content blocks); the SSE
        // `event:` line may be absent, so the JSON `type` is authoritative.
        if (event === 'assistant' || event === 'text' || event === 'agent.message' || data?.type === 'agent.message') {
          if (data.text) report += data.text;
          if (data.content) { for (const b of data.content) { if (b.type === 'text') report += b.text; } }
        }

        const isCustomToolUse = event === 'agent.custom_tool_use' || data?.type === 'agent.custom_tool_use';
        if (isCustomToolUse) {
          const toolName = data.name;
          const toolInput = data.input || {};
          const toolUseId = toolUseIdFromEvent(data);
          if (!toolUseId) {
            logger.error(`[bi-agent] Tool ${toolName || '(unknown)'} missing tool use id: ${JSON.stringify(data).slice(0, 500)}`);
            continue;
          }
          pendingCustomToolUses.set(toolUseId, { toolName, toolInput });
        }

        const isIdle = event === 'session.status_idle' || data?.type === 'session.status_idle';
        if (isIdle) {
          const stopReason = stopReasonFromEvent(data);
          const stopType = stopReason?.type;

          if (stopType === 'requires_action') {
            await runRequiresActionBatch(sessionId, deadline, stopReason?.event_ids || [], pendingCustomToolUses, executeToolUse);
            continue;
          }

          if (stopType !== 'end_turn') {
            // requires_action and end_turn are the only non-terminal-failure
            // idle reasons; retries_exhausted, budget_reached, or an unknown
            // stop reason are a failed run.
            failure = `session_idle_${stopType || 'unknown'}`;
            logger.error(`[bi-agent] Session ${sessionId} idle with stop reason ${stopType || '(none)'}: ${failure}`);
            break;
          }
          // stopType === 'end_turn' falls through to isSessionTerminal below.
        }

        if (isSessionTerminal(event, data)) { sessionEnded = true; break; }
        if (isSessionError(event) || data?.type === 'session.error' || data?.type === 'error') {
          logger.error(`[bi-agent] Error: ${JSON.stringify(data)}`);
          failure = 'session_error_event';
          break;
        }
      }
      // The stream closed (or was left) before the session said it ended:
      // not a success, whatever the session GET reports later.
      if (!failure && !sessionEnded) { logger.error(`[bi-agent] Stream ended without a terminal event for session ${sessionId}`); failure = 'session_stream_eof'; }

    } catch (err) {
      if (err && err.code === 'session_timeout') {
        logger.error(`[bi-agent] ${err.message}`);
        failure = 'session_timeout';
      } else {
        failure = err;
        throw err;
      }
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      // Close the SSE connection on every exit — including a kickoff POST
      // that failed before the stream was ever read (a no-op once the reader
      // has already finished).
      streamController?.abort();
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
