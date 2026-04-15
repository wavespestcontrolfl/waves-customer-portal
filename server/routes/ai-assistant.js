const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const WavesAssistant = require('../services/ai-assistant/assistant');
const logger = require('../services/logger');

// =========================================================================
// PORTAL CHAT — customer-facing (uses customer auth, not admin auth)
// =========================================================================

// POST /api/ai/chat — customer sends a message via portal chat
router.post('/chat', async (req, res, next) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    // Try to identify customer from auth token
    let customerId = null;
    let customerPhone = null;
    try {
      const jwt = require('jsonwebtoken');
      const config = require('../config');
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const decoded = jwt.verify(token, config.jwt.secret);
        if (decoded.customerId) {
          customerId = decoded.customerId;
          const customer = await db('customers').where('id', customerId).first();
          customerPhone = customer?.phone;
        }
      }
    } catch { /* unauthenticated chat is allowed */ }

    const result = await WavesAssistant.processMessage({
      message,
      channel: 'portal_chat',
      channelIdentifier: sessionId || customerId || `anon-${Date.now()}`,
      customerId,
      customerPhone,
    });

    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// ADMIN — escalation queue, conversation history, call log
// =========================================================================

// GET /api/ai/admin/escalations — pending escalations
router.get('/admin/escalations', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const escalations = await db('ai_escalations as e')
      .leftJoin('customers as c', 'e.customer_id', 'c.id')
      .where('e.status', status)
      .select('e.*', 'c.first_name', 'c.last_name', 'c.phone', 'c.waveguard_tier', 'c.monthly_rate')
      .orderByRaw("CASE WHEN e.priority = 'urgent' THEN 0 WHEN e.priority = 'normal' THEN 1 ELSE 2 END")
      .orderBy('e.created_at', 'desc');

    const counts = await db('ai_escalations').select('status').count('* as count').groupBy('status');
    const countMap = {};
    counts.forEach(c => { countMap[c.status] = parseInt(c.count); });

    res.json({ escalations, counts: countMap });
  } catch (err) { next(err); }
});

// PUT /api/ai/admin/escalations/:id — claim, resolve, or dismiss
router.put('/admin/escalations/:id', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { status, resolution_notes, claimed_by } = req.body;
    const updates = { status, updated_at: new Date() };
    if (claimed_by) updates.claimed_by = claimed_by;
    if (resolution_notes) updates.resolution_notes = resolution_notes;

    const [esc] = await db('ai_escalations').where('id', req.params.id).update(updates).returning('*');

    // If resolved, also close the conversation
    if (status === 'resolved' && esc.conversation_id) {
      await db('ai_conversations').where('id', esc.conversation_id).update({
        status: 'resolved', resolved_by: 'human', updated_at: new Date(),
      });
    }

    res.json({ escalation: esc });
  } catch (err) { next(err); }
});

// GET /api/ai/admin/conversations — recent conversations
router.get('/admin/conversations', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { status, limit = 30 } = req.query;
    let query = db('ai_conversations as conv')
      .leftJoin('customers as c', 'conv.customer_id', 'c.id')
      .select('conv.*', 'c.first_name', 'c.last_name', 'c.phone')
      .orderBy('conv.last_activity_at', 'desc')
      .limit(parseInt(limit));

    if (status) query = query.where('conv.status', status);

    const conversations = await query;
    res.json({ conversations });
  } catch (err) { next(err); }
});

// GET /api/ai/admin/conversations/:id/messages — full message thread
router.get('/admin/conversations/:id/messages', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const messages = await db('ai_messages')
      .where('conversation_id', req.params.id)
      .orderBy('created_at', 'asc');

    const conversation = await db('ai_conversations').where('id', req.params.id).first();

    res.json({ messages, conversation });
  } catch (err) { next(err); }
});

// POST /api/ai/admin/conversations/:id/reply — admin sends a reply in a conversation
router.post('/admin/conversations/:id/reply', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { message } = req.body;
    const conv = await db('ai_conversations').where('id', req.params.id).first();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Save the admin reply
    await db('ai_messages').insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: message,
      channel: conv.channel,
      sent_to_customer: true,
    });

    // If SMS channel, actually send the SMS
    if (conv.channel === 'sms' && conv.channel_identifier) {
      try {
        const TwilioService = require('../services/twilio');
        await TwilioService.sendSMS(conv.channel_identifier, message, {
          customerId: conv.customer_id,
          messageType: 'manual',
        });
      } catch (err) {
        logger.error(`Admin reply SMS failed: ${err.message}`);
      }
    }

    await db('ai_conversations').where('id', conv.id).update({
      last_activity_at: new Date(),
      status: 'active',
      resolved_by: null,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// CALL LOG — admin view of all calls
// =========================================================================

// GET /api/ai/admin/calls — call history
router.get('/admin/calls', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { days = 30, limit = 50, search } = req.query;
    const searchTerm = typeof search === 'string' ? search.trim() : '';

    let q = db('call_log as cl')
      .leftJoin('customers as c', 'cl.customer_id', 'c.id')
      .select('cl.*', 'c.first_name', 'c.last_name', 'c.waveguard_tier')
      .orderBy('cl.created_at', 'desc');

    if (!searchTerm) {
      const since = new Date(Date.now() - parseInt(days) * 86400000);
      q = q.where('cl.created_at', '>', since);
    } else {
      const like = `%${searchTerm}%`;
      q = q.where(b => b
        .where('c.first_name', 'ilike', like)
        .orWhere('c.last_name', 'ilike', like)
        .orWhereRaw("(c.first_name || ' ' || c.last_name) ILIKE ?", [like])
        .orWhere('cl.from_phone', 'ilike', like)
        .orWhere('cl.to_phone', 'ilike', like)
        .orWhere('cl.transcription', 'ilike', like)
      );
    }

    const effectiveLimit = searchTerm ? Math.max(parseInt(limit), 1000) : parseInt(limit);
    const calls = await q.limit(effectiveLimit);

    const stats = {
      total: calls.length,
      inbound: calls.filter(c => c.direction === 'inbound').length,
      outbound: calls.filter(c => c.direction === 'outbound').length,
      answered: calls.filter(c => c.answered_by === 'human').length,
      missed: calls.filter(c => c.answered_by === 'missed').length,
      avgDuration: calls.filter(c => c.duration_seconds > 0).length > 0
        ? Math.round(calls.filter(c => c.duration_seconds > 0).reduce((s, c) => s + c.duration_seconds, 0) / calls.filter(c => c.duration_seconds > 0).length)
        : 0,
      withRecordings: calls.filter(c => c.recording_url).length,
      withTranscriptions: calls.filter(c => c.transcription).length,
    };

    res.json({ calls, stats });
  } catch (err) { next(err); }
});

// GET /api/ai/admin/calls/:id — single call with transcription
router.get('/admin/calls/:id', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const call = await db('call_log').where('id', req.params.id).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json({ call });
  } catch (err) { next(err); }
});

// =========================================================================
// STATS — AI assistant overview
// =========================================================================

// GET /api/ai/admin/stats
router.get('/admin/stats', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || 30);
    const since = new Date(Date.now() - days * 86400000);

    const conversations = await db('ai_conversations').where('created_at', '>', since);
    const escalations = await db('ai_escalations').where('created_at', '>', since);
    const messages = await db('ai_messages').where('created_at', '>', since);

    res.json({
      conversations: {
        total: conversations.length,
        active: conversations.filter(c => c.status === 'active').length,
        escalated: conversations.filter(c => c.escalated).length,
        resolved: conversations.filter(c => c.status === 'resolved').length,
        timedOut: conversations.filter(c => c.status === 'timeout').length,
        avgMessages: conversations.length > 0 ? Math.round(conversations.reduce((s, c) => s + c.message_count, 0) / conversations.length) : 0,
      },
      escalations: {
        total: escalations.length,
        pending: escalations.filter(e => e.status === 'pending').length,
        urgent: escalations.filter(e => e.priority === 'urgent').length,
        resolved: escalations.filter(e => e.status === 'resolved').length,
        byReason: escalations.reduce((acc, e) => { acc[e.reason] = (acc[e.reason] || 0) + 1; return acc; }, {}),
      },
      messages: {
        total: messages.length,
        fromUsers: messages.filter(m => m.role === 'user').length,
        fromAI: messages.filter(m => m.role === 'assistant').length,
        toolCalls: messages.filter(m => m.role === 'tool_use').length,
      },
      period: `${days}d`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
