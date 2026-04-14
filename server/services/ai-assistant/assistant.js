/**
 * Waves AI Assistant — Channel-agnostic conversational engine
 *
 * Core design:
 *  - Channel-agnostic: doesn't know if message came from SMS, portal, or WhatsApp
 *  - Tool-use based: Claude decides when to look up data, escalate, or respond
 *  - Escalation-first: schedule changes, cancellations, complaints → escalate to human
 *  - 30-min conversation timeout: context resets after inactivity
 *  - Uses ALL portal data: SMS history, call transcripts, Square billing, service records
 */

const db = require('../../models/db');
const logger = require('../logger');
const ContextAggregator = require('../context-aggregator');
const { TOOLS, executeToolCall } = require('./tools');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MODEL = 'claude-sonnet-4-20250514';

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
- Answer questions about services, scheduling, products, pricing
- Look up customer accounts, upcoming services, billing
- Provide pest/lawn care advice specific to SWFL
- Send service reminders and confirmations

WHAT YOU MUST ESCALATE (use the escalate tool):
- Any request to cancel, pause, or downgrade service
- Any request to reschedule or change an appointment
- Complaints about service quality or technician behavior
- Billing disputes or refund requests
- Anything you're uncertain about
- Requests to speak with a manager/owner

ESCALATION FORMAT: When escalating, explain to the customer that you're connecting them with the team, and use the escalate tool with a clear summary of the issue.

RULES:
- Never make up service dates, prices, or technician names — always look them up
- Never promise specific times without checking availability
- If a customer asks about pricing, give the general range but note it depends on property size
- Always mention the WaveGuard tier benefits when relevant
- If you detect the customer is frustrated, acknowledge it before solving
- End every conversation with an offer to help with anything else`;

class WavesAssistant {

  /**
   * Process an incoming message from any channel.
   * Returns { reply, conversationId, escalated, escalationId }
   */
  async processMessage({ message, channel, channelIdentifier, customerId, customerPhone }) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { reply: "Thanks for reaching out! One of our team members will get back to you shortly. — Waves Pest Control", escalated: false };
    }

    // 1. Find or create conversation (respecting 30-min timeout)
    const conversation = await this.getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone);

    // 2. Check for escalation triggers in the raw message
    const needsEscalation = this.checkEscalationTriggers(message);

    // 3. Save the user message
    await db('ai_messages').insert({
      conversation_id: conversation.id,
      role: 'user',
      content: message,
      channel,
    });
    await db('ai_conversations').where('id', conversation.id).update({
      message_count: conversation.message_count + 1,
      last_activity_at: new Date(),
      timeout_at: new Date(Date.now() + CONVERSATION_TIMEOUT_MS),
    });

    // 4. If escalation trigger detected, escalate immediately
    if (needsEscalation) {
      return this.escalate(conversation, message, 'Sensitive topic detected in customer message');
    }

    // 5. Build conversation history for Claude
    const history = await this.buildHistory(conversation.id);

    // 6. Call Claude with tools
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      let messages = history;
      let finalReply = '';
      let escalated = false;
      let escalationId = null;

      // Tool-use loop — Claude may call multiple tools before responding
      for (let turn = 0; turn < 5; turn++) {
        const response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 800,
          system: SYSTEM_PROMPT + (conversation.context_snapshot ? `\n\nCUSTOMER CONTEXT:\n${typeof conversation.context_snapshot === 'object' ? (conversation.context_snapshot.summary || JSON.stringify(conversation.context_snapshot)) : conversation.context_snapshot}` : ''),
          tools: TOOLS,
          messages,
        });

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
          await db('ai_messages').insert({
            conversation_id: conversation.id,
            role: 'tool_use',
            content: toolUse.name,
            tool_calls: JSON.stringify(toolUse.input),
            tool_results: JSON.stringify(result),
          });
        }

        // Continue the loop with tool results
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];
      }

      // Save the assistant reply
      await db('ai_messages').insert({
        conversation_id: conversation.id,
        role: 'assistant',
        content: finalReply,
        channel,
        sent_to_customer: true,
      });

      return { reply: finalReply, conversationId: conversation.id, escalated, escalationId };

    } catch (err) {
      logger.error(`AI Assistant error: ${err.message}`);
      return { reply: "I'm having trouble right now. Let me connect you with our team. — Waves Pest Control", escalated: false };
    }
  }

  /**
   * Get or create an active conversation. Timeout after 30 min of inactivity.
   */
  async getOrCreateConversation(channel, channelIdentifier, customerId, customerPhone) {
    const now = new Date();

    // Look for an active conversation on this channel
    const existing = await db('ai_conversations')
      .where({ channel_identifier: channelIdentifier || customerPhone, status: 'active' })
      .where('timeout_at', '>', now)
      .orderBy('last_activity_at', 'desc')
      .first();

    if (existing) return existing;

    // Timeout any stale conversations for this identifier
    await db('ai_conversations')
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

    // Create new conversation — context_snapshot is jsonb so wrap string in valid JSON
    const [conv] = await db('ai_conversations').insert({
      customer_id: customerId || null,
      channel,
      channel_identifier: channelIdentifier || customerPhone,
      status: 'active',
      last_activity_at: now,
      timeout_at: new Date(now.getTime() + CONVERSATION_TIMEOUT_MS),
      message_count: 0,
      context_snapshot: contextSnapshot ? JSON.stringify({ summary: contextSnapshot }) : null,
    }).returning('*');

    return conv;
  }

  /**
   * Build Claude message history from conversation.
   */
  async buildHistory(conversationId) {
    const msgs = await db('ai_messages')
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
    await db('ai_conversations').where('id', conversation.id).update({
      escalated: true,
      escalation_reason: reason,
      status: 'escalated',
      updated_at: new Date(),
    });

    // Reply to customer
    const reply = customer
      ? `Thanks ${customer.first_name} — I'm connecting you with our team right now. Someone will follow up shortly. Is there anything else you'd like me to note for them?`
      : "Thanks for reaching out — I'm connecting you with our team right now. Someone will follow up with you shortly.";

    await db('ai_messages').insert({
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
