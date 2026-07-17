/**
 * Waves AI Assistant — Channel-agnostic conversational engine
 *
 * Core design:
 *  - Channel-agnostic: doesn't know if message came from SMS, portal, or WhatsApp
 *  - Tool-use based: Claude decides when to look up data, escalate, or respond
 *  - Escalation-first: schedule changes, cancellations, complaints → escalate to human
 *  - 30-min conversation timeout: context resets after inactivity
 *  - Data-minimized: only authenticated scheduling facts are exposed to the model
 */

const db = require('../../models/db');
const logger = require('../logger');
const { TOOLS, executeToolCall } = require('./tools');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MODEL = require('../../config/models').FLAGSHIP;

// Prompt-cache breakpoint (same pattern as admin-intelligence-bar.js). Applied
// to a shallow copy of the messages array at call time — never to the array we
// keep appending to — so markers don't accumulate across tool-use rounds past
// the API's 4-breakpoint limit.
const EPHEMERAL_CACHE = { cache_control: { type: 'ephemeral' } };
const MINIMAL_CONTEXT_VERSION = 2;

function parsedContextSnapshot(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function safeFirstNameFromSnapshot(raw) {
  const snapshot = parsedContextSnapshot(raw);
  if (snapshot?.version !== MINIMAL_CONTEXT_VERSION || typeof snapshot.firstName !== 'string') return '';
  return snapshot.firstName.trim().replace(/[^\p{L}\p{M}' -]/gu, '').slice(0, 80);
}

function withCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  let content = last.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, ...EPHEMERAL_CACHE }];
  } else if (Array.isArray(content) && content.length) {
    content = [...content.slice(0, -1), { ...content[content.length - 1], ...EPHEMERAL_CACHE }];
  } else {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

// Escalation triggers — Phase 1: escalate all sensitive actions
const ESCALATION_TRIGGERS = [
  'cancel', 'cancellation', 'stop service', 'end service', 'discontinue',
  'reschedule', 'change my appointment', 'move my service',
  'complaint', 'not happy', 'terrible', 'worst', 'never coming back', 'lawsuit', 'bbb',
  'refund', 'charge back', 'dispute',
  'manager', 'supervisor', 'owner', 'adam',
];

const SYSTEM_PROMPT = `You are the Waves Pest Control AI assistant. You help customers with questions about their pest control and lawn care services in Southwest Florida.

PERSONALITY:
- Friendly, knowledgeable, direct — like a helpful neighbor who knows pest control
- Use the customer's first name naturally
- Keep responses concise for SMS (2-4 sentences max) or longer for portal chat
- Reference SWFL-specific conditions (sandy soil, afternoon storms, St. Augustine grass)
- Never sound robotic or corporate

WHAT YOU CAN DO:
- Answer general questions about services, products, pests, and lawn care
- Look up the authenticated customer's upcoming services
- Provide pest/lawn care advice specific to SWFL
- Escalate account, billing, and service-change questions to the Waves team

WHAT YOU MUST ESCALATE (use the escalate tool):
- Any request to cancel, pause, or downgrade service
- Any request to reschedule or change an appointment
- Complaints about service quality or technician behavior
- Billing disputes or refund requests
- Anything you're uncertain about
- Requests to speak with a manager/owner

SCHEDULING QUESTIONS — HARD RULE:
If the customer asks anything about their schedule, upcoming visit, arrival
window, appointment time, or "when are you coming", you MUST call the
get_upcoming_services tool first before replying. Never assert "we're
booked" or "we don't have you on the schedule" without checking. If the
tool returns at least one upcoming service for this customer, confirm the
soonest one by date + time window. If the tool returns no upcoming
services, escalate — do not guess availability.

Also never state a specific date or month unless it came from a tool
response. If you need to reference "tomorrow" or "this week", phrase it
relative to the current context rather than inventing a specific date.

ESCALATION FORMAT: When escalating, explain to the customer that you're connecting them with the team, and use the escalate tool with a clear summary of the issue.

RULES:
- Never make up service dates, prices, or technician names — always look them up
- Never promise specific times without checking availability
- Do not expose or request addresses, phone numbers, payment details, balances, service notes, or call history
- Do not quote account-specific pricing; escalate billing and pricing questions
- If you detect the customer is frustrated, acknowledge it before solving
- End every conversation with an offer to help with anything else`;

class WavesAssistant {

  /**
   * Process an incoming message from any channel.
   * Returns { reply, conversationId, escalated, escalationId }
   */
  async processMessage({ message, channel, channelIdentifier, customerId, customerPhone }) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      logger.warn('[ai-assistant] ANTHROPIC_API_KEY not configured');
      return { reply: "Thanks for reaching out! One of our team members will get back to you shortly. — Waves Pest Control", escalated: false };
    }

    // 1. Find or create conversation (respecting 30-min timeout)
    let conversation;
    try {
      conversation = await this.getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone);
    } catch (convErr) {
      logger.error(`[ai-assistant] getOrCreateConversation failed: ${convErr.message}`, { stack: convErr.stack });
      return { reply: "I'm having a brief connection issue. Please try again in a moment, or call us at (941) 318-7612.", escalated: false };
    }

    // 2. Check for escalation triggers in the raw message
    const needsEscalation = this.checkEscalationTriggers(message);

    // 3. Save the user message
    try {
      await db('agent_messages').insert({
        conversation_id: conversation.id,
        role: 'user',
        content: message,
        channel,
      });
      await db('agent_sessions').where('id', conversation.id).update({
        message_count: (conversation.message_count || 0) + 1,
        last_activity_at: new Date(),
        timeout_at: new Date(Date.now() + CONVERSATION_TIMEOUT_MS),
      });
    } catch (msgErr) {
      logger.error(`[ai-assistant] Failed to save user message: ${msgErr.message}`);
    }

    // 4. If escalation trigger detected, escalate immediately
    if (needsEscalation) {
      return this.escalate(conversation, message, 'Sensitive topic detected in customer message');
    }

    // 5. Build conversation history for Claude
    const history = await this.buildHistory(conversation.id);

    // 6. Build a data-minimized context string. Older active rows may still
    // contain the legacy full-account summary; never forward that shape to the
    // model during the rollout window.
    let contextStr = '';
    if (conversation.context_snapshot) {
      const firstName = safeFirstNameFromSnapshot(conversation.context_snapshot);
      if (firstName) contextStr = `Customer first name: ${firstName}`;
    }

    // 7. Call Claude with tools
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      let messages = history;
      let finalReply = '';
      let escalated = false;
      let escalationId = null;

      // Two system blocks: the static prompt carries a 1-hour cache breakpoint
      // (tools render before system, so the entry covers TOOLS + SYSTEM_PROMPT
      // and is shared across every customer and conversation); the
      // per-conversation context block sits AFTER the breakpoint so it never
      // fragments that shared entry. 1h TTL because customer replies routinely
      // arrive more than 5 minutes apart.
      const system = [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ];
      if (contextStr) {
        system.push({ type: 'text', text: `CUSTOMER CONTEXT:\n${contextStr}` });
      }

      // Tool-use loop — Claude may call multiple tools before responding
      for (let turn = 0; turn < 5; turn++) {
        const response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 800,
          system,
          tools: TOOLS,
          messages: withCacheBreakpoint(messages),
        });

        // Cache-hit visibility: cache_read > 0 on later rounds / follow-up
        // customer turns is the prod verification signal.
        const u = response.usage || {};
        logger.info(
          `[ai-assistant] usage turn=${turn} in=${u.input_tokens ?? 0} ` +
          `cache_write=${u.cache_creation_input_tokens ?? 0} ` +
          `cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? 0}`
        );

        // Check if Claude wants to use tools
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        const textBlocks = response.content.filter(c => c.type === 'text');

        if (toolUses.length === 0) {
          // No tools — just a text response
          finalReply = textBlocks.map(t => t.text).join('');
          break;
        }

        // Execute tool calls
        const toolResults = [];
        for (const toolUse of toolUses) {
          // Check if it's an escalation
          if (toolUse.name === 'escalate') {
            const escResult = await this.escalate(conversation, message, toolUse.input.reason || 'AI-initiated escalation');
            return escResult;
          }

          const result = await executeToolCall(toolUse.name, toolUse.input, customerId);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });

          // Log tool usage
          await db('agent_messages').insert({
            conversation_id: conversation.id,
            role: 'tool_use',
            content: toolUse.name,
            tool_calls: JSON.stringify(toolUse.input),
            tool_results: JSON.stringify(result),
          }).catch(e => logger.error(`[ai-assistant] Failed to log tool use: ${e.message}`));
        }

        // Continue the loop with tool results
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];
      }

      // If every loop turn was tool_use (e.g. a tool kept erroring and the
      // model kept retrying it), finalReply is still empty — degrade to the
      // canned reply instead of persisting a blank customer-visible message.
      if (!finalReply.trim()) {
        logger.warn(`[ai-assistant] Tool-use loop exhausted with no text reply`, { customerId, channel, conversationId: conversation.id });
        return { reply: "I'm having trouble right now. Please try calling us at (941) 318-7612.", conversationId: conversation.id, escalated: false };
      }

      // Save the assistant reply
      await db('agent_messages').insert({
        conversation_id: conversation.id,
        role: 'assistant',
        content: finalReply,
        channel,
        sent_to_customer: true,
      }).catch(e => logger.error(`[ai-assistant] Failed to save reply: ${e.message}`));

      // generated marks true model output — canned fallbacks and the
      // deterministic escalation template never carry it, so the portal's
      // "report AI content" affordance only attaches to real AI replies.
      return { reply: finalReply, conversationId: conversation.id, escalated, escalationId, generated: true };

    } catch (err) {
      logger.error(`[ai-assistant] Claude API error: ${err.message}`, { stack: err.stack, model: MODEL, customerId, channel });
      return { reply: "I'm having trouble right now. Please try calling us at (941) 318-7612.", escalated: false };
    }
  }

  /**
   * Get or create an active conversation. Timeout after 30 min of inactivity.
   */
  async getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone) {
    const now = new Date();
    const identifier = channelIdentifier || customerPhone;

    if (!channel || !identifier) {
      throw new Error('Conversation channel and identifier are required');
    }

    // Client session IDs and phone identifiers are not authorization. Scope
    // every lookup by channel AND the already-resolved customer identity (or
    // explicitly to an anonymous lead) so a guessed identifier can never
    // attach another customer's message history.
    const existingQuery = db('agent_sessions')
      .where({ channel, channel_identifier: identifier, status: 'active' });
    if (customerId) existingQuery.where({ customer_id: customerId });
    else existingQuery.whereNull('customer_id');
    const existing = await existingQuery
      .where('timeout_at', '>', now)
      .orderBy('last_activity_at', 'desc')
      .first();

    // Do not carry legacy full-context snapshots/history across this security
    // boundary. Those conversations may contain model replies grounded in
    // billing, call-summary, contact, or service-note data. Anonymous lead
    // sessions had no customer snapshot and remain safe to reuse.
    if (existing && (!existing.customer_id
      || parsedContextSnapshot(existing.context_snapshot)?.version === MINIMAL_CONTEXT_VERSION)) {
      return existing;
    }

    // Timeout any stale conversations for this identifier
    const staleQuery = db('agent_sessions')
      .where({ channel, channel_identifier: identifier, status: 'active' });
    if (customerId) staleQuery.where({ customer_id: customerId });
    else staleQuery.whereNull('customer_id');
    await staleQuery
      .update({ status: 'timeout', resolved_by: 'timeout', updated_at: now });

    // Keep model context deliberately small. The legacy full-context
    // aggregator included payment history, property flags, SMS/call summaries,
    // service notes and contact details. The model only needs a first name for
    // natural phrasing; schedule facts come through the scoped tool above.
    let contextSnapshot = null;
    try {
      if (customerId) {
        const customer = await db('customers')
          .where({ id: customerId })
          .select('first_name')
          .first();
        if (customer?.first_name) {
          contextSnapshot = { version: MINIMAL_CONTEXT_VERSION, firstName: customer.first_name };
        } else {
          contextSnapshot = { version: MINIMAL_CONTEXT_VERSION };
        }
      }
    } catch (ctxErr) {
      logger.warn(`[ai-assistant] Minimal context lookup failed (non-blocking): ${ctxErr.message}`);
    }

    // Create new conversation — pass plain object for jsonb column (Knex serializes it)
    const [conv] = await db('agent_sessions').insert({
      customer_id: customerId || null,
      channel,
      channel_identifier: identifier,
      status: 'active',
      last_activity_at: now,
      timeout_at: new Date(now.getTime() + CONVERSATION_TIMEOUT_MS),
      message_count: 0,
      context_snapshot: contextSnapshot,
    }).returning('*');

    return conv;
  }

  /**
   * Build Claude message history from conversation.
   */
  async buildHistory(conversationId) {
    const msgs = await db('agent_messages')
      .where('conversation_id', conversationId)
      .whereIn('role', ['user', 'assistant'])
      .orderBy('created_at', 'asc')
      .limit(20);

    return msgs.map(m => ({ role: m.role, content: m.content }));
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

    // Update conversation
    await db('agent_sessions').where('id', conversation.id).update({
      escalated: true,
      escalation_reason: reason,
      status: 'escalated',
      updated_at: new Date(),
    });

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
    });

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

    logger.info(`AI escalated: ${conversation.id} reason="${reason}" priority=${priority}`);

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

  /**
   * Transcribe a call recording using Claude (for when Twilio transcription isn't available).
   */
  async transcribeRecording(callSid, recordingUrl) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY || !recordingUrl) return;

    // For now, mark as pending — actual audio transcription requires Whisper or Twilio
    // This is a placeholder that updates status; real implementation would use
    // Twilio's built-in transcription (already configured in the voice webhook)
    // or OpenAI Whisper API for higher quality
    await db('call_log').where('twilio_call_sid', callSid).update({
      transcription_status: 'pending',
      updated_at: new Date(),
    });

    logger.info(`Transcription queued for call ${callSid}`);
  }
}

module.exports = new WavesAssistant();
