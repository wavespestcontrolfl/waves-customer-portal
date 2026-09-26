/**
 * Lead Response Agent — Session Manager
 *
 * Called from the lead webhook after initial record creation.
 * Runs autonomously: triage → score → draft → send/queue → follow-up.
 *
 * Usage:
 *   const LeadResponseAgent = require('./lead-response-agent');
 *   await LeadResponseAgent.processLead({
 *     leadId: 'uuid',
 *     customerId: 'uuid',
 *     phone: '+19411234567',
 *     name: 'John Smith',
 *     message: 'I have ants everywhere',
 *     address: '123 Main St, Bradenton, FL',
 *     leadSource: 'google_ads',
 *     pageUrl: 'https://wavespestcontrol.com/pest-control-bradenton-fl/',
 *   });
 */

const logger = require('./logger');
const db = require('../models/db');
const { executeLeadTool } = require('./lead-response-tools');
const { getBreaker } = require('./intelligence-bar/circuit-breaker');
const { recordToolEvent } = require('./intelligence-bar/tool-events');
const { LEAD_RESPONSE_AGENT_CONFIG } = require('./lead-response-agent-config');
const { recordSessionUsage } = require('./llm-dispatch-metrics');
const { isSessionTerminal, isSessionError } = require('./agent-control/session-events');
const { readSessionFrames } = require('./agent-control/session-stream');

const leadToolBreaker = getBreaker('lead-response-agent');

// Tools whose failure means the agent is working with incomplete context.
// If any of these fail, we won't let the agent auto-send a personalized SMS —
// queue the draft for Virginia/Adam.
const CRITICAL_CONTEXT_TOOLS = new Set([
  'get_customer_context',
  'check_existing_estimates',
  'check_next_availability',
  'get_pest_context',
  'get_lead_details',
]);

function isToolFailure(result) {
  return result && typeof result === 'object' && (result.error || result.failed === true);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LEAD_AGENT_ID = process.env.LEAD_AGENT_ID;
// Managed Agents now require an environment_id when opening a session.
const LEAD_AGENT_ENVIRONMENT_ID = process.env.LEAD_AGENT_ENVIRONMENT_ID || process.env.ANTHROPIC_ENVIRONMENT_ID;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';

async function apiCall(method, path, body, signal) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    const err = await res.text();
    throw Object.assign(new Error(`Anthropic API ${res.status}: ${err}`), { status: res.status, code: `anthropic_${res.status}` });
  }
  return res.json();
}

// Every API request — session creation included — is bounded by the run's
// deadline: a stalled request must not keep processLead() pending past it.
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

// Whatever the agent asks, one lead run makes at most MAX_TOOL_CALLS tool
// calls, answers a tool use id once, and makes ONE reply decision: once a
// text went out or the lead was queued for the owner, a further
// send_lead_response / queue_for_adam is answered as skipped — a looping
// session must never text a lead twice or alert the owner twice. The other
// writes (estimate flag, saved report) likewise complete at most once. A
// side effect counts as done only when it actually happened — a draft saved
// for the owner counts even if the alert to the owner then failed, and a
// send converted into a queued draft counts as the reply.
const MAX_TOOL_CALLS = 20;
// Only tools with no writes and no provider spend may be abandoned at the
// deadline. Not here, so they run to completion like any write:
// check_existing_estimates (shortenOrPassthrough inserts short_codes),
// get_pest_context (WikiQA.query calls providers and inserts
// knowledge_queries) and triage_lead (an LLM dispatch).
const READ_ONLY_TOOLS = new Set([
  'get_lead_details', 'get_customer_context', 'check_next_availability',
]);
const replyDecided = (result) => result?.sent === true || result?.queued === true;
const SIDE_EFFECTS = {
  send_lead_response: { key: 'reply', done: replyDecided },
  queue_for_adam: { key: 'reply', done: replyDecided },
  flag_for_estimate: { key: 'flag_for_estimate', done: (result) => Boolean(result) && !result.error },
  save_lead_response_report: { key: 'save_lead_response_report', done: (result) => Boolean(result) && !result.error },
};

// What a frame carries for the run loop. The JSON `type` is authoritative:
// the SSE `event:` line may be absent, and readSessionFrames then reports
// 'message'. Terminal and error detection stay independent of this (a final
// agent.message can carry stop_reason end_turn).
function leadFrameKind(event, data) {
  const type = data?.type || event;
  if (type === 'agent.message' || event === 'assistant' || event === 'text') return 'text';
  if (type === 'agent.custom_tool_use' || type === 'tool_use' || event === 'tool_use') return 'tool_use';
  return 'other';
}

function frameText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return (data?.text || '') + blocks.filter(block => block?.type === 'text').map(block => block.text).join('');
}

// With critical context missing, send_lead_response never sends: the draft
// goes to the owner through queue_for_adam instead, with no generic customer
// acknowledgment either. A draft saved while its owner alert failed stays
// saved, and reaches the model as an error so it cannot claim a clean hand-off.
async function queueInsteadOfSend(toolInput, toolContext, criticalFailures) {
  logger.warn(`[lead-agent] Blocking auto-send — critical tool failures: ${criticalFailures.join(', ')}. Queueing draft for human review.`);
  try {
    const queued = await executeLeadTool('queue_for_adam', {
      lead_id: toolContext.leadId,
      customer_id: toolContext.customerId,
      reason: `Auto-send blocked — critical context tools failed (${criticalFailures.join(', ')}). Please review and follow up.`,
      draft_response: toolInput.message || '',
    }, toolContext);
    // A rejected draft, a validation failure included, never has queued: true.
    if (queued?.queued !== true) throw new Error(queued?.error || 'Draft was not saved');
    const toolResult = {
      ...queued,
      sent: false,
      queued: true,
      autoSendSuppressed: true,
      note: 'Queued for human review due to missing context; no fallback SMS sent.',
    };
    if (!isToolFailure(queued)) return { toolResult, failed: false };
    leadToolBreaker.recordFailure();
    return { toolResult, failed: true, toolError: queued.error || 'Owner alert delivery failed' };
  } catch (err) {
    // The draft write is awaited to completion, never raced against the run
    // deadline, so no deadline expiry can surface here.
    logger.error(`[lead-agent] Human-review queue failed: ${err.message}`);
    return { toolResult: { error: `Human-review queue failed: ${err.message}` }, failed: true };
  }
}

// Runs the tool itself. Only a known read may be abandoned at the deadline.
// Every other tool — the lead text, the owner draft, pipeline / estimate /
// report writes, and any tool added later — is awaited to completion, so the
// run never returns while a write may still land. A deadline expiry
// propagates; it never becomes a tool error.
async function executeWithinPolicy(toolName, toolInput, toolContext, deadline) {
  try {
    const call = executeLeadTool(toolName, toolInput, toolContext);
    const toolResult = READ_ONLY_TOOLS.has(toolName) ? await withinDeadline(call, toolContext.sessionId, deadline) : await call;
    if (!isToolFailure(toolResult)) {
      leadToolBreaker.recordSuccess();
      return { toolResult, failed: false };
    }
    if (!toolResult.validationError) leadToolBreaker.recordFailure();
    return { toolResult, failed: true, toolError: toolResult.error || 'tool returned error' };
  } catch (err) {
    if (err?.code === 'session_timeout') throw err;
    leadToolBreaker.recordFailure();
    logger.error(`[lead-agent] Tool ${toolName} error: ${err.message}`);
    return { toolResult: { error: `Tool failed: ${err.message}` }, failed: true, toolError: err.message };
  }
}

// The action a finished call took, for the run's result and log. auto_sent
// gates on actual delivery (sent === true), never on a policy block. A saved
// draft is reported even when its owner alert then failed, but as
// "_unalerted": a draft nobody was told about never reads as a successful
// hand-off (#4179).
function leadActionTaken(toolName, toolResult) {
  if (toolName === 'send_lead_response' && toolResult?.sent === true) return 'auto_sent';
  if (toolResult?.queued !== true) return null;
  // Only queue_for_adam saves a draft: called directly, or in place of a
  // blocked send.
  const action = toolResult.autoSendSuppressed ? 'auto_send_suppressed_queued' : 'queued_for_adam';
  return isToolFailure(toolResult) ? `${action}_unalerted` : action;
}

// Runs ONE lead tool call under the lead's send-safety policy and reports
// { toolResult, failed }:
//   - a side effect this lead already has (its reply decision, flag, report)
//     is answered as skipped, never repeated; it counts as had only once it
//     actually happened;
//   - with critical context missing, send_lead_response is converted into a
//     queue_for_adam draft — no text goes out;
//   - an open breaker fast-fails; any other call executes within the run
//     deadline;
//   - a failed critical-context read is remembered, so a later send queues.
async function runLeadToolCall(run, toolName, toolInput, toolUseId) {
  remainingMs(run.sessionId, run.deadline); // no tool starts after the deadline
  logger.info(`[lead-agent] Tool: ${toolName}`);
  const toolContext = { leadId: run.lead.leadId, customerId: run.lead.customerId, sessionId: run.sessionId, toolUseId };
  const sideEffect = SIDE_EFFECTS[toolName];
  const toolStartedAt = Date.now();

  let outcome;
  if (run.completedSideEffects.has(sideEffect?.key)) {
    outcome = { toolResult: { skipped: true, reason: `${toolName}: already done for this lead in this run` }, failed: false };
  } else if (toolName === 'send_lead_response' && run.criticalFailures.length > 0) {
    outcome = await queueInsteadOfSend(toolInput, toolContext, run.criticalFailures);
  } else if (leadToolBreaker.isTripped()) {
    const toolResult = leadToolBreaker.fastFailResult();
    outcome = { toolResult, failed: true, circuitOpen: true, toolError: toolResult.message };
  } else {
    outcome = await executeWithinPolicy(toolName, toolInput, toolContext, run.deadline);
  }
  if (outcome.failed && CRITICAL_CONTEXT_TOOLS.has(toolName)) run.criticalFailures.push(toolName);
  if (sideEffect?.done(outcome.toolResult)) run.completedSideEffects.add(sideEffect.key);

  recordToolEvent({
    source: 'lead-response-agent',
    context: 'lead-response',
    toolName,
    success: !outcome.failed,
    durationMs: Date.now() - toolStartedAt,
    circuitOpen: outcome.circuitOpen,
    errorMessage: outcome.toolError,
  });
  return outcome;
}

// Lead fields added to the kickoff prompt when present, in this order.
const OPTIONAL_PROMPT_FIELDS = [
  ['Message/Service Interest', 'message'],
  ['Address', 'address'],
  ['City', 'city'],
  ['Lead Source', 'leadSource'],
  ['Page URL', 'pageUrl'],
  ['Form', 'formName'],
];

const DEFAULT_LEAD_AGENT_TIMEOUT_MS = 180000;

// Defensive parse: an unset, non-numeric, or non-positive override falls
// back to the default rather than producing a NaN/zero/negative deadline.
function leadAgentTimeoutMs() {
  const raw = process.env.LEAD_AGENT_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LEAD_AGENT_TIMEOUT_MS;
}

// Our own deadline, not the provider's — the ledger files it as a timeout.
// Mirrors server/services/content/agents/agent-dispatcher.js's deadlineError.
function deadlineError(sessionId, deadline) {
  return Object.assign(new Error(`session ${sessionId} timed out at its ${new Date(deadline).toISOString()} deadline`), { code: 'session_timeout' });
}

function remainingMs(sessionId, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError(sessionId, deadline);
  return remaining;
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

// Opens the SSE connection and returns it unread. Callers must open the
// stream BEFORE posting the kickoff user.message — Managed Agents streams
// do not replay events emitted before the connection is established, so
// opening it after the kickoff can miss the run's earliest events entirely.
async function openSessionStream(sessionId, deadline) {
  const controller = new AbortController();
  const timeoutMs = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
        'accept': 'text/event-stream',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw deadlineError(sessionId, deadline);
    throw err;
  }
  if (!res.ok) {
    // The deadline stays armed through the error-body read — a non-2xx
    // response that stalls mid-body must still end as session_timeout.
    let errText = '';
    try {
      errText = await res.text();
    } catch (err) {
      if (err?.name === 'AbortError') throw deadlineError(sessionId, deadline);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    throw Object.assign(new Error(`Stream error ${res.status}: ${errText}`), { status: res.status, code: `anthropic_${res.status}` });
  }
  return { sessionId, deadline, res, timer, controller };
}

// Consumes an already-opened stream (see openSessionStream) against a
// wall-clock deadline — the AbortController above aborts the underlying
// fetch at the deadline; this checks it again per-frame so a fetch mock or
// an already-buffered response can't outrun it.
async function* readOpenedStream({ sessionId, deadline, res, timer }) {
  try {
    for await (const { event, data } of readSessionFrames(res.body)) {
      if (Date.now() >= deadline) throw deadlineError(sessionId, deadline);
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      yield { event, data: parsed };
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw deadlineError(sessionId, deadline);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Reads one lead run to its end: collects the agent's report text and answers
// each tool use once — a repeated request for a call already answered is
// ignored, and the run ends at MAX_TOOL_CALLS. Returns the run's failure, if
// any: an error event, or a stream that closed before the session ended.
async function readLeadRun(run, openedStream) {
  for await (const { event, data } of readOpenedStream(openedStream)) {
    const kind = leadFrameKind(event, data);
    if (kind === 'text') run.report += frameText(data);
    else if (kind === 'tool_use' && !run.answeredToolUseIds.has(data.id)) {
      run.answeredToolUseIds.add(data.id);
      if (run.answeredToolUseIds.size > MAX_TOOL_CALLS) {
        throw Object.assign(new Error(`session ${run.sessionId} exceeded ${MAX_TOOL_CALLS} tool calls`), { code: 'max_tool_calls' });
      }
      const outcome = await runLeadToolCall(run, data.name, data.input || {}, data.id);
      run.actionTaken = leadActionTaken(data.name, outcome.toolResult) || run.actionTaken;
      run.toolsExecuted.push(data.name);

      await sendSessionEvents(run.sessionId, [{
        type: 'user.custom_tool_result',
        custom_tool_use_id: data.id,
        content: [{ type: 'text', text: JSON.stringify(outcome.toolResult) }],
        ...(outcome.failed ? { is_error: true } : {}),
      }], run.deadline);
    }
    // session.status_idle is NOT terminal on its own (it arrives with
    // requires_action while the agent waits for the tool result sent
    // above) — the shared predicate reads only real terminals.
    if (isSessionTerminal(event, data)) return null;
    if (isSessionError(event)) {
      logger.error(`[lead-agent] Agent error: ${JSON.stringify(data)}`);
      return 'session_error_event';
    }
  }
  // The stream closed before the session said it ended: not a success,
  // whatever the session GET reports later.
  logger.error(`[lead-agent] Stream ended without a terminal event for session ${run.sessionId}`);
  return 'session_stream_eof';
}

const LeadResponseAgent = {

  /**
   * Process a new lead end-to-end.
   * Designed to be called fire-and-forget from the lead webhook.
   *
   * @param {object} lead
   * @param {string} lead.leadId — Lead UUID
   * @param {string} lead.customerId — Customer UUID
   * @param {string} lead.phone — Phone number
   * @param {string} lead.name — Lead name
   * @param {string} lead.message — Form message / service interest
   * @param {string} [lead.address] — Address
   * @param {string} [lead.city] — City
   * @param {string} [lead.leadSource] — Source (google_ads, gbp, website, etc.)
   * @param {string} [lead.pageUrl] — Submission page URL
   * @param {string} [lead.formName] — Form name
   */
  async processLead(lead) {
    if (!ANTHROPIC_API_KEY || !LEAD_AGENT_ID) {
      logger.warn('[lead-agent] Missing ANTHROPIC_API_KEY or LEAD_AGENT_ID — skipping agent processing');
      return null;
    }
    if (!LEAD_AGENT_ENVIRONMENT_ID) {
      logger.warn('[lead-agent] Missing LEAD_AGENT_ENVIRONMENT_ID (or ANTHROPIC_ENVIRONMENT_ID) — skipping agent processing');
      return null;
    }
    if (!lead?.leadId || !lead?.customerId) {
      logger.warn('[lead-agent] Skipping lead without assigned customer', { leadId: lead?.leadId || null });
      return { skipped: true, error: 'Agent processing requires an assigned lead and customer' };
    }

    const startTime = Date.now();

    // Build the prompt with all known lead context
    let prompt = `New lead just arrived — process it immediately:\n\n`;
    prompt += `Lead ID: ${lead.leadId}\n`;
    prompt += `Customer ID: ${lead.customerId}\n`;
    prompt += `Name: ${lead.name}\n`;
    prompt += `Phone: ${lead.phone}\n`;
    for (const [label, key] of OPTIONAL_PROMPT_FIELDS) {
      if (lead[key]) prompt += `${label}: ${lead[key]}\n`;
    }
    prompt += `\nTime is ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET.`;
    prompt += `\n\nFollow your workflow: analyze → gather context → draft response → decide auto-send vs queue → set up follow-up → save report.`;

    let sessionId = null;
    let failure = null;
    let openedStream = null;
    try {
      const deadline = Date.now() + leadAgentTimeoutMs();
      const session = await apiCallWithinDeadline('POST', '/sessions', {
        agent: LEAD_AGENT_ID,
        environment_id: LEAD_AGENT_ENVIRONMENT_ID,
      }, 'new session', deadline);

      sessionId = session.id;
      logger.info(`[lead-agent] Session ${sessionId} for lead ${lead.leadId}`);

      // Open the stream first — the kickoff message is posted only once the
      // SSE connection is live, so no early event is emitted before we're
      // listening for it.
      openedStream = await openSessionStream(sessionId, deadline);

      await sendSessionEvents(sessionId, [{
        type: 'user.message',
        content: [{ type: 'text', text: prompt }],
      }], deadline);

      const run = {
        lead,
        sessionId,
        deadline: openedStream.deadline,
        report: '',
        toolsExecuted: [],
        actionTaken: null,
        criticalFailures: [],
        answeredToolUseIds: new Set(),
        completedSideEffects: new Set(),
      };
      failure = await readLeadRun(run, openedStream);

      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      logger.info(`[lead-agent] Completed: ${lead.name} | ${run.actionTaken || 'no_action'} | ${durationSeconds}s | tools: ${run.toolsExecuted.join(', ')}`);

      return {
        sessionId,
        leadId: lead.leadId,
        actionTaken: run.actionTaken,
        toolsExecuted: run.toolsExecuted,
        durationSeconds,
        report: run.report,
      };

    } catch (err) {
      failure = err;
      logger.error(`[lead-agent] Failed for lead ${lead.leadId}: ${err.message}`);

      // Non-fatal — the webhook already sent a basic auto-reply as fallback
      return null;
    } finally {
      // Close the SSE connection on every exit — including a kickoff POST
      // that failed before the stream was ever read (a no-op once the reader
      // has already finished).
      if (openedStream) {
        clearTimeout(openedStream.timer);
        openedStream.controller.abort();
      }
      // Call ledger (never throws): one session row with the session's token
      // usage, written however the session ends — a stream that throws still
      // consumed tokens — carrying this runner's own outcome. No session id =
      // nothing was created, nothing to bill.
      if (sessionId) await recordSessionUsage({ laneId: 'agent_lead', sessionId, agentId: LEAD_AGENT_ID, model: LEAD_RESPONSE_AGENT_CONFIG.model, startedAt: startTime, failure });
    }
  },
};

module.exports = LeadResponseAgent;
