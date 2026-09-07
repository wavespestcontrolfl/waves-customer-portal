/**
 * Waves AI Assistant — Managed Agents Session Manager
 *
 * Replaces the old WavesAssistant class that ran its own tool-use loop.
 * Now Anthropic's Managed Agent infrastructure runs the agent loop —
 * this class just manages sessions and executes custom tool calls.
 *
 * Flow:
 *   1. Customer message arrives (SMS, portal chat, etc.)
 *   2. Get or create a Managed Agent session for this conversation
 *   3. Send the message as a session event
 *   4. Stream SSE events — when a custom tool_use event arrives,
 *      execute it locally and send the result back
 *   5. Collect the final text reply and return it
 *
 * What moved to Anthropic:
 *   - The tool-use loop (was: for turn 0..5)
 *   - Context management and compaction
 *   - Error recovery and retries
 *   - System prompt injection
 *
 * What stays here:
 *   - Session lifecycle (create, resume, timeout)
 *   - Custom tool execution (DB queries via executeToolCall)
 *   - Escalation logic (DB insert + Twilio SMS to Adam)
 *   - Conversation/escalation records in PostgreSQL
 */

const db = require('../../models/db');
const logger = require('../logger');
const ContextAggregator = require('../context-aggregator');
const { executeToolCall } = require('./tools-expanded');
const { AGENT_CONFIG } = require('./managed-agent-config');
const { recordSessionUsage } = require('../llm-dispatch-metrics');
const { isSessionTerminal, isSessionError } = require('../agent-control/session-events');

const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MANAGED_AGENT_ID = process.env.MANAGED_AGENT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_BASE = 'https://api.anthropic.com/v1';
const BETA_HEADER = 'managed-agents-2026-04-01';

// Escalation triggers — keep as pre-filter (belt and suspenders)
const ESCALATION_TRIGGERS = [
  'cancel', 'cancellation', 'stop service', 'end service', 'discontinue',
  'reschedule', 'change my appointment', 'move my service',
  'complaint', 'not happy', 'terrible', 'worst', 'never coming back', 'lawsuit', 'bbb',
  'refund', 'charge back', 'dispute',
  'manager', 'supervisor', 'owner', 'adam',
];

// ─── API helpers ────────────────────────────────────────────────

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
    throw Object.assign(new Error(`Anthropic API ${res.status}: ${err}`), { status: res.status, code: `anthropic_${res.status}` });
  }

  return res.json();
}

/**
 * Stream SSE events from a session.
 * Yields parsed event objects { event, data } as they arrive.
 */
async function* streamSessionEvents(sessionId) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events?stream=true`, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'accept': 'text/event-stream',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw Object.assign(new Error(`Stream error ${res.status}: ${err}`), { status: res.status, code: `anthropic_${res.status}` });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    let currentEvent = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          yield { event: currentEvent, data };
        } catch { /* skip malformed */ }
        currentEvent = null;
      }
    }
  }
}

// ─── Main class ─────────────────────────────────────────────────

class ManagedAssistant {

  /**
   * Process an incoming message from any channel.
   * Returns { reply, conversationId, escalated, escalationId }
   */
  async processMessage({ message, channel, channelIdentifier, customerId, customerPhone }) {
    if (!ANTHROPIC_API_KEY || !MANAGED_AGENT_ID) {
      logger.warn('[managed-assistant] Missing ANTHROPIC_API_KEY or MANAGED_AGENT_ID');
      return {
        reply: "Thanks for reaching out! One of our team members will get back to you shortly. — Waves Pest Control",
        escalated: false,
      };
    }

    // 1. Check escalation triggers (pre-filter — belt and suspenders)
    if (this.checkEscalationTriggers(message)) {
      const conversation = await this.getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone);
      return this.escalate(conversation, message, 'Sensitive topic detected in customer message');
    }

    // 2. Get or create conversation record (tracks session mapping)
    const conversation = await this.getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone);

    // 3. Save the user message
    await db('agent_messages').insert({
      conversation_id: conversation.id,
      role: 'user',
      content: message,
      channel,
    });

    let sessionId = conversation.managed_session_id;
    const turnStartedAt = Date.now();
    // This turn's identity in the call ledger (one session_turn row per turn;
    // a start time alone could collide for two turns in one millisecond).
    const turnId = require('crypto').randomUUID();
    let failure = null;
    try {

      // 4. Create or resume Managed Agent session
      if (!sessionId) {
        // Build context snapshot for the first message
        const contextPrefix = conversation.context_snapshot
          ? `CUSTOMER CONTEXT:\n${conversation.context_snapshot}\n\nCustomer message: `
          : '';

        const session = await apiCall('POST', '/sessions', {
          agent: MANAGED_AGENT_ID,
        });

        sessionId = session.id;

        // Save session ID on conversation
        await db('agent_sessions').where('id', conversation.id).update({
          managed_session_id: sessionId,
        });

        // Send the first user event with context
        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'user',
          content: [{ type: 'text', text: contextPrefix + message }],
        });
      } else {
        // Send follow-up message to existing session
        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'user',
          content: [{ type: 'text', text: message }],
        });
      }

      // 5. Stream events and handle custom tool calls
      const { reply, failure: streamFailure } = await this.processSessionEvents(sessionId, conversation, customerId);
      // A stream that ended on an error event or on our event cap still
      // hands back a reply to send; the turn itself failed, and the ledger
      // row below says so.
      failure = streamFailure;

      // 6. Save assistant reply
      await db('agent_messages').insert({
        conversation_id: conversation.id,
        role: 'assistant',
        content: reply,
        channel,
        sent_to_customer: true,
      });

      // Update conversation activity
      await db('agent_sessions').where('id', conversation.id).update({
        message_count: conversation.message_count + 1,
        last_activity_at: new Date(),
        timeout_at: new Date(Date.now() + CONVERSATION_TIMEOUT_MS),
      });

      return {
        reply,
        conversationId: conversation.id,
        escalated: false,
      };

    } catch (err) {
      failure = failure || err;
      logger.error(`[managed-assistant] Error: ${err.message}`);
      return {
        reply: "I'm having trouble right now. Let me connect you with our team. — Waves Pest Control",
        escalated: false,
      };
    } finally {
      // Call ledger (never throws): a conversation is ONE long-lived session,
      // so every turn re-records the session's cumulative usage and the
      // recorder updates that session's single row in place (latency = this
      // turn). Runs on the error path too — a turn that threw mid-stream
      // still consumed tokens, and marks the session row failed for good.
      // Fire-and-forget ON PURPOSE (the recorder never throws): the
      // customer's reply must not wait on a usage GET — up to 15 s on a slow
      // provider — and this server process is long-lived, unlike the
      // one-shot runners, which await it.
      if (sessionId) void recordSessionUsage({ laneId: 'agent_assistant', sessionId, agentId: MANAGED_AGENT_ID, model: AGENT_CONFIG.model, startedAt: turnStartedAt, turnId, failure }).catch((err) => logger.error(`[managed-assistant] session ledger: ${err.message}`));
    }
  }

  /**
   * Stream session events, execute custom tool calls, return the final text
   * with this turn's stream outcome. `failure` is null when the agent ended
   * the turn, `session_error_event` when the stream emitted an error (the
   * reply is then whatever text arrived first, else the fallback copy),
   * `session_stream_eof` when the stream closed before any terminal event
   * and `max_events` when our own event cap ended it. The caller sends the
   * reply either way; the call ledger records the turn as failed.
   */
  async processSessionEvents(sessionId, conversation, customerId) {
    let finalReply = '';
    let failure = null;
    let sessionEnded = false; // set only by a terminal event: any other stream exit is a failure
    let maxIterations = 30; // expanded assistant needs more room for multi-step workflows

    for await (const { event, data } of streamSessionEvents(sessionId)) {
      if (--maxIterations <= 0) {
        logger.warn(`[managed-assistant] Hit max iterations for session ${sessionId}`);
        failure = 'max_events';
        break;
      }

      // ── Text output ──
      if (event === 'assistant' || event === 'text') {
        if (data.type === 'text' || data.text) {
          finalReply += data.text || '';
        }
        // Handle content blocks
        if (data.content) {
          for (const block of data.content) {
            if (block.type === 'text') finalReply += block.text;
          }
        }
      }

      // ── Custom tool call — execute locally ──
      if (event === 'tool_use' || data?.type === 'tool_use') {
        const toolName = data.name;
        const toolInput = data.input || {};
        const toolUseId = data.id;

        logger.info(`[managed-assistant] Tool call: ${toolName}(${JSON.stringify(toolInput).slice(0, 200)})`);

        // Special handling for escalation
        if (toolName === 'escalate') {
          const escResult = await this.escalate(
            conversation,
            toolInput.reason || 'AI-initiated escalation',
            toolInput.reason || 'AI-initiated escalation'
          );
          // Send the tool result back so the agent knows it escalated
          await apiCall('POST', `/sessions/${sessionId}/events`, {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{ type: 'text', text: JSON.stringify({ escalated: true, reason: toolInput.reason }) }],
          });
          // The agent will generate a customer-facing reply after seeing the escalation result
          continue;
        }

        // Execute the tool against our DB
        let toolResult;
        try {
          toolResult = await executeToolCall(toolName, toolInput, customerId);
        } catch (err) {
          toolResult = { error: `Tool failed: ${err.message}` };
          logger.error(`[managed-assistant] Tool ${toolName} error: ${err.message}`);
        }

        // Log tool usage
        await db('agent_messages').insert({
          conversation_id: conversation.id,
          role: 'tool_use',
          content: toolName,
          tool_calls: JSON.stringify(toolInput),
          tool_results: JSON.stringify(toolResult),
        });

        // Send result back to the agent
        await apiCall('POST', `/sessions/${sessionId}/events`, {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
        });
      }

      // ── Session complete ──
      if (isSessionTerminal(event, data)) {
        sessionEnded = true;
        break;
      }

      // ── Error from agent ──
      if (isSessionError(event)) {
        logger.error(`[managed-assistant] Agent error: ${JSON.stringify(data)}`);
        failure = 'session_error_event';
        if (!finalReply) {
          finalReply = "I'm having trouble right now. Let me connect you with our team. — Waves Pest Control";
        }
        break;
      }
    }
    // The stream closed before the session said it ended: the customer still
    // gets whatever was said, but the turn is not a success, whatever the
    // session GET reports later.
    if (!failure && !sessionEnded) {
      logger.error(`[managed-assistant] Stream ended without a terminal event for session ${sessionId}`);
      failure = 'session_stream_eof';
    }

    return { reply: finalReply || "I'm here to help! Could you tell me a bit more about what you need? — Waves Pest Control", failure };
  }

  /**
   * Get or create an active conversation. Timeout after 30 min of inactivity.
   */
  async getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone) {
    const now = new Date();

    // Look for an active conversation on this channel
    const existing = await db('agent_sessions')
      .where({ channel_identifier: channelIdentifier || customerPhone, status: 'active' })
      .where('timeout_at', '>', now)
      .orderBy('last_activity_at', 'desc')
      .first();

    if (existing) return existing;

    // Timeout any stale conversations for this identifier
    await db('agent_sessions')
      .where({ channel_identifier: channelIdentifier || customerPhone, status: 'active' })
      .update({ status: 'timeout', resolved_by: 'timeout', updated_at: now });

    // Build customer context snapshot
    let contextSnapshot = '';
    try {
      if (customerPhone) {
        const ctx = await ContextAggregator.getFullCustomerContext(customerPhone);
        contextSnapshot = ctx.summary || '';
        if (!customerId && ctx.customer?.id) customerId = ctx.customer.id;
      }
    } catch { /* context unavailable */ }

    // Create new conversation
    const [conv] = await db('agent_sessions').insert({
      customer_id: customerId || null,
      channel,
      channel_identifier: channelIdentifier || customerPhone,
      status: 'active',
      last_activity_at: now,
      timeout_at: new Date(now.getTime() + CONVERSATION_TIMEOUT_MS),
      message_count: 0,
      context_snapshot: contextSnapshot,
      managed_session_id: null, // set when session is created
    }).returning('*');

    return conv;
  }

  /**
   * Check if message contains escalation trigger keywords.
   */
  checkEscalationTriggers(message) {
    const lower = (message || '').toLowerCase();
    return ESCALATION_TRIGGERS.some(trigger => lower.includes(trigger));
  }

  /**
   * Escalate to human — create escalation record, update conversation, notify Adam.
   */
  async escalate(conversation, customerMessage, reason) {
    const customer = conversation.customer_id
      ? await db('customers').where('id', conversation.customer_id).first()
      : null;

    // Determine priority
    const lower = (customerMessage || '').toLowerCase();
    let priority = 'normal';
    if (lower.includes('cancel') || lower.includes('lawsuit') || lower.includes('bbb')) priority = 'urgent';
    if (lower.includes('complaint') || lower.includes('not happy') || lower.includes('refund')) priority = 'urgent';

    const [escalation] = await db('ai_escalations').insert({
      conversation_id: conversation.id,
      customer_id: conversation.customer_id,
      reason: this.classifyEscalation(customerMessage),
      summary: reason,
      customer_message: customerMessage,
      ai_draft_response: null,
      priority,
      status: 'pending',
    }).returning('*');

    // The ai_escalations row above is the source of truth. Once it exists,
    // the customer must get the escalation reply — session bookkeeping and
    // transcript logging are best-effort (a failed UPDATE here once surfaced
    // as the generic error fallback mid-escalation).
    await db('agent_sessions').where('id', conversation.id).update({
      escalated: true,
      escalation_reason: reason,
      status: 'escalated',
      updated_at: new Date(),
    }).catch(e => logger.error(`[managed-assistant] Failed to mark session escalated: ${e.message}`, { conversationId: conversation.id }));

    // Reply to customer
    const reply = customer
      ? `Thanks ${customer.first_name} — I'm connecting you with our team right now. Someone will follow up shortly. Is there anything else you'd like me to note for them?`
      : "Thanks for reaching out — I'm connecting you with our team right now. Someone will follow up with you shortly.";

    await db('agent_messages').insert({
      conversation_id: conversation.id,
      role: 'assistant',
      content: reply,
      channel: conversation.channel,
      sent_to_customer: true,
    }).catch(e => logger.error(`[managed-assistant] Failed to save escalation reply: ${e.message}`, { conversationId: conversation.id }));

    // Notify Adam via SMS for urgent escalations
    if (priority === 'urgent') {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `🚨 AI Escalation (${priority})\n${customer ? customer.first_name + ' ' + customer.last_name : 'Unknown'}\nReason: ${reason}\nMsg: "${(customerMessage || '').substring(0, 100)}"`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* SMS notification is best-effort */ }
    }

    logger.info(`[managed-assistant] Escalated: ${conversation.id} reason="${reason}" priority=${priority}`);

    return { reply, conversationId: conversation.id, escalated: true, escalationId: escalation.id };
  }

  classifyEscalation(message) {
    const lower = (message || '').toLowerCase();
    if (lower.includes('cancel') || lower.includes('stop service') || lower.includes('end service')) return 'cancellation';
    if (lower.includes('reschedule') || lower.includes('change') || lower.includes('move')) return 'schedule_change';
    if (lower.includes('complaint') || lower.includes('not happy') || lower.includes('terrible')) return 'complaint';
    if (lower.includes('refund') || lower.includes('charge') || lower.includes('dispute')) return 'billing_dispute';
    if (lower.includes('manager') || lower.includes('supervisor') || lower.includes('owner')) return 'manager_request';
    return 'ai_uncertain';
  }
}

module.exports = new ManagedAssistant();
