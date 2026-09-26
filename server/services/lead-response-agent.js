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

// Every events POST is bounded by the run's deadline: a stalled request must
// not keep processLead() pending past it.
async function sendSessionEvents(sessionId, events, deadline) {
  const signal = AbortSignal.timeout(remainingMs(sessionId, deadline));
  try {
    return await apiCall('POST', `/sessions/${sessionId}/events`, { events }, signal);
  } catch (err) {
    if (signal.aborted) throw deadlineError(sessionId, deadline);
    throw err;
  }
}

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
    if (lead.message) prompt += `Message/Service Interest: ${lead.message}\n`;
    if (lead.address) prompt += `Address: ${lead.address}\n`;
    if (lead.city) prompt += `City: ${lead.city}\n`;
    if (lead.leadSource) prompt += `Lead Source: ${lead.leadSource}\n`;
    if (lead.pageUrl) prompt += `Page URL: ${lead.pageUrl}\n`;
    if (lead.formName) prompt += `Form: ${lead.formName}\n`;
    prompt += `\nTime is ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET.`;
    prompt += `\n\nFollow your workflow: analyze → gather context → draft response → decide auto-send vs queue → set up follow-up → save report.`;

    let sessionId = null;
    let failure = null;
    // Set only by a terminal event: any other stream exit is a failure.
    let sessionEnded = false;
    let openedStream = null;
    try {
      const session = await apiCall('POST', '/sessions', {
        agent: LEAD_AGENT_ID,
        environment_id: LEAD_AGENT_ENVIRONMENT_ID,
      });

      sessionId = session.id;
      logger.info(`[lead-agent] Session ${sessionId} for lead ${lead.leadId}`);

      const deadline = Date.now() + leadAgentTimeoutMs();
      // Open the stream first — the kickoff message is posted only once the
      // SSE connection is live, so no early event is emitted before we're
      // listening for it.
      openedStream = await openSessionStream(sessionId, deadline);

      await sendSessionEvents(sessionId, [{
        type: 'user.message',
        content: [{ type: 'text', text: prompt }],
      }], deadline);

      let report = '';
      let toolsExecuted = [];
      let actionTaken = null;
      const criticalFailures = [];

      for await (const { event, data } of readOpenedStream(openedStream)) {
        // Agent text arrives as `agent.message` (content blocks); the SSE
        // `event:` line may be absent, so the JSON `type` is authoritative.
        if (event === 'assistant' || event === 'text' || event === 'agent.message' || data?.type === 'agent.message') {
          if (data.text) report += data.text;
          if (data.content) {
            for (const block of data.content) {
              if (block.type === 'text') report += block.text;
            }
          }
        }

        if (
          event === 'tool_use' ||
          event === 'agent.custom_tool_use' ||
          data?.type === 'tool_use' ||
          data?.type === 'agent.custom_tool_use'
        ) {
          const toolName = data.name;
          const toolInput = data.input || {};
          const toolUseId = data.id;
          const toolContext = { leadId: lead.leadId, customerId: lead.customerId, sessionId, toolUseId };

          remainingMs(sessionId, openedStream.deadline); // no tool starts after the deadline
          logger.info(`[lead-agent] Tool: ${toolName}`);

          let toolResult;
          let failed = false;
          let circuitOpen = false;
          let toolError = null;
          const toolStartedAt = Date.now();

          // Pre-send quality check: if critical context is missing, don't
          // let the agent auto-send a personalized SMS. Queue the draft for
          // human review without sending a generic customer acknowledgment.
          if (toolName === 'send_lead_response' && criticalFailures.length > 0) {
            logger.warn(`[lead-agent] Blocking auto-send — critical tool failures: ${criticalFailures.join(', ')}. Queueing draft for human review.`);
            try {
              const queued = await withinDeadline(executeLeadTool('queue_for_adam', {
                lead_id: lead.leadId,
                customer_id: lead.customerId,
                reason: `Auto-send blocked — critical context tools failed (${criticalFailures.join(', ')}). Please review and follow up.`,
                draft_response: toolInput.message || '',
              }, toolContext), sessionId, openedStream.deadline);
              if (queued?.queued !== true) throw new Error(queued?.error || 'Draft was not saved');
              toolResult = {
                ...queued,
                sent: false,
                queued: true,
                autoSendSuppressed: true,
                note: 'Queued for human review due to missing context; no fallback SMS sent.',
              };
              if (isToolFailure(queued)) {
                failed = true;
                toolError = queued.error || 'Owner alert delivery failed';
                if (!queued.validationError) leadToolBreaker.recordFailure();
              } else {
                actionTaken = 'auto_send_suppressed_queued';
              }
            } catch (err) {
              if (err?.code === 'session_timeout') throw err;
              toolResult = { error: `Human-review queue failed: ${err.message}` };
              failed = true;
              logger.error(`[lead-agent] Human-review queue failed: ${err.message}`);
            }
          } else if (leadToolBreaker.isTripped()) {
            toolResult = leadToolBreaker.fastFailResult();
            failed = true;
            circuitOpen = true;
            toolError = toolResult.message;
            if (CRITICAL_CONTEXT_TOOLS.has(toolName)) criticalFailures.push(toolName);
          } else {
            try {
              toolResult = await withinDeadline(executeLeadTool(toolName, toolInput, toolContext), sessionId, openedStream.deadline);
              if (isToolFailure(toolResult)) {
                failed = true;
                toolError = toolResult.error || 'tool returned error';
                if (!toolResult.validationError) leadToolBreaker.recordFailure();
                if (CRITICAL_CONTEXT_TOOLS.has(toolName)) criticalFailures.push(toolName);
              } else {
                leadToolBreaker.recordSuccess();
                // Gate auto_sent on actual delivery, not just absence-of-error.
                // send_lead_response now distinguishes:
                //   { sent: true, ... }                 — provider accepted (auto_sent)
                //   { sent: false, blocked: true, ... } — wrapper-policy block,
                //                                        non-failure, NOT auto_sent
                //   { sent: false, failed: true, ... }  — provider failure
                //                                        (caught by isToolFailure above)
                if (toolName === 'send_lead_response' && toolResult && toolResult.sent === true) {
                  actionTaken = 'auto_sent';
                }
                if (toolName === 'queue_for_adam' && toolResult?.queued === true) actionTaken = 'queued_for_adam';
              }
            } catch (err) {
              if (err?.code === 'session_timeout') throw err;
              toolResult = { error: `Tool failed: ${err.message}` };
              failed = true;
              toolError = err.message;
              leadToolBreaker.recordFailure();
              if (CRITICAL_CONTEXT_TOOLS.has(toolName)) criticalFailures.push(toolName);
              logger.error(`[lead-agent] Tool ${toolName} error: ${err.message}`);
            }
          }

          recordToolEvent({
            source: 'lead-response-agent',
            context: 'lead-response',
            toolName,
            success: !failed,
            durationMs: Date.now() - toolStartedAt,
            circuitOpen,
            errorMessage: toolError,
          });

          toolsExecuted.push(toolName);

          await sendSessionEvents(sessionId, [{
            type: 'user.custom_tool_result',
            custom_tool_use_id: toolUseId,
            content: [{ type: 'text', text: JSON.stringify(toolResult) }],
            ...(failed ? { is_error: true } : {}),
          }], openedStream.deadline);
        }

        // session.status_idle is NOT terminal on its own (it arrives with
        // requires_action while the agent waits for the tool result sent
        // above) — the shared predicate reads only real terminals.
        if (isSessionTerminal(event, data)) { sessionEnded = true; break; }
        if (isSessionError(event)) {
          logger.error(`[lead-agent] Agent error: ${JSON.stringify(data)}`);
          failure = 'session_error_event';
          break;
        }
      }
      // The stream closed before the session said it ended: not a success,
      // whatever the session GET reports later.
      if (!failure && !sessionEnded) {
        logger.error(`[lead-agent] Stream ended without a terminal event for session ${sessionId}`);
        failure = 'session_stream_eof';
      }

      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      logger.info(`[lead-agent] Completed: ${lead.name} | ${actionTaken || 'no_action'} | ${durationSeconds}s | tools: ${toolsExecuted.join(', ')}`);

      return {
        sessionId,
        leadId: lead.leadId,
        actionTaken,
        toolsExecuted,
        durationSeconds,
        report,
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
