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

async function apiCall(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
  return res.json();
}

async function sendSessionEvents(sessionId, events) {
  return apiCall('POST', `/sessions/${sessionId}/events`, { events });
}

async function* streamSessionEvents(sessionId) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'accept': 'text/event-stream',
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stream error ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    let currentEvent = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          yield { event: currentEvent, data: JSON.parse(line.slice(6)) };
        } catch { /* skip */ }
        currentEvent = null;
      }
    }
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

    try {
      const session = await apiCall('POST', '/sessions', {
        agent: LEAD_AGENT_ID,
        environment_id: LEAD_AGENT_ENVIRONMENT_ID,
      });

      const sessionId = session.id;
      logger.info(`[lead-agent] Session ${sessionId} for lead ${lead.leadId}`);

      await sendSessionEvents(sessionId, [{
        type: 'user.message',
        content: [{ type: 'text', text: prompt }],
      }]);

      let report = '';
      let toolsExecuted = [];
      let actionTaken = null;
      let maxIterations = 25;
      const criticalFailures = [];

      for await (const { event, data } of streamSessionEvents(sessionId)) {
        if (--maxIterations <= 0) break;

        if (event === 'assistant' || event === 'text') {
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
              await executeLeadTool('queue_for_adam', {
                lead_id: lead.leadId,
                customer_id: lead.customerId,
                reason: `Auto-send blocked — critical context tools failed (${criticalFailures.join(', ')}). Please review and follow up.`,
                draft_response: toolInput.message || '',
              });
              toolResult = {
                sent: false,
                queued: true,
                autoSendSuppressed: true,
                note: 'Queued for human review due to missing context; no fallback SMS sent.',
              };
              actionTaken = 'auto_send_suppressed_queued';
            } catch (err) {
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
              toolResult = await executeLeadTool(toolName, toolInput);
              if (isToolFailure(toolResult)) {
                failed = true;
                toolError = toolResult.error || 'tool returned error';
                leadToolBreaker.recordFailure();
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
                if (toolName === 'queue_for_adam') actionTaken = 'queued_for_adam';
              }
            } catch (err) {
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
          }]);
        }

        const stopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : data?.stop_reason?.type;
        if (event === 'done' || event === 'session_complete' || event === 'session.status_idle' || stopReason === 'end_turn') break;
        if (event === 'error' || event === 'session.error') {
          logger.error(`[lead-agent] Agent error: ${JSON.stringify(data)}`);
          break;
        }
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
      logger.error(`[lead-agent] Failed for lead ${lead.leadId}: ${err.message}`);

      // Non-fatal — the webhook already sent a basic auto-reply as fallback
      return null;
    }
  },
};

module.exports = LeadResponseAgent;
