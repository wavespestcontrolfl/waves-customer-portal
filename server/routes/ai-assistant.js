const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const WavesAssistant = require('../services/ai-assistant/assistant');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { preferredRouteDecisionForFeedback } = require('../services/call-route-decisions');

async function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function actorName(req) {
  return [req.technician?.first_name, req.technician?.last_name].filter(Boolean).join(' ')
    || req.technician?.email
    || req.technicianId
    || 'Admin';
}

const ROUTE_FEEDBACK_WRONG_FIELDS = new Set([
  'name',
  'address',
  'service',
  'scheduling',
  'consent',
  'spam_status',
  'routing',
]);

function sanitizeWrongFields(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input
    .map((item) => String(item || '').trim())
    .filter((item) => ROUTE_FEEDBACK_WRONG_FIELDS.has(item)))];
}

function mapRouteDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    recommendation: row.validator_recommendation,
    finalAction: row.final_action_taken,
    blockedReasons: parseJson(row.blocked_reasons, []),
    allowedReasons: parseJson(row.allowed_reasons, []),
    fieldWritePlan: parseJson(row.field_write_plan, []),
    appointmentWritePlan: parseJson(row.appointment_write_plan, null),
    decisionVersion: row.decision_version,
    mode: row.mode,
    createdAt: row.created_at,
  };
}

function mapRouteFeedback(row) {
  if (!row) return null;
  return {
    id: row.id,
    routeDecisionId: row.route_decision_id,
    triageItemId: row.triage_item_id,
    decisionKind: row.decision_kind,
    verdict: row.verdict,
    wrongFields: parseJson(row.wrong_fields, []),
    note: row.note || null,
    reviewedBy: row.reviewed_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
      await db('agent_sessions').where('id', esc.conversation_id).update({
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
    let query = db('agent_sessions as conv')
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
    const messages = await db('agent_messages')
      .where('conversation_id', req.params.id)
      .orderBy('created_at', 'asc');

    const conversation = await db('agent_sessions').where('id', req.params.id).first();

    res.json({ messages, conversation });
  } catch (err) { next(err); }
});

// POST /api/ai/admin/conversations/:id/reply — admin sends a reply in a conversation
router.post('/admin/conversations/:id/reply', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { message } = req.body;
    const conv = await db('agent_sessions').where('id', req.params.id).first();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // If SMS channel, actually send the SMS
    if (conv.channel === 'sms' && conv.channel_identifier) {
      try {
        const smsResult = await sendCustomerMessage({
          to: conv.channel_identifier,
          body: message,
          channel: 'sms',
          audience: 'lead',
          purpose: 'conversational',
          customerId: conv.customer_id || undefined,
          identityTrustLevel: conv.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
          entryPoint: 'ai_assistant_admin_reply',
          metadata: {
            original_message_type: 'manual',
            agent_session_id: conv.id,
            adminUserId: req.technicianId,
          },
        });
        if (!smsResult.sent) {
          return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
        }
      } catch (err) {
        logger.error(`Admin reply SMS failed: ${err.message}`);
        return res.status(502).json({ error: 'SMS send failed' });
      }
    }

    // Save only after the provider/policy path accepts the send, so the thread
    // cannot show a customer-visible reply that was blocked before delivery.
    await db('agent_messages').insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: message,
      channel: conv.channel,
      sent_to_customer: true,
    });

    await db('agent_sessions').where('id', conv.id).update({
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
      .select(
        'cl.*',
        'c.first_name',
        'c.last_name',
        'c.phone as customer_phone',
        'c.waveguard_tier'
      )
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
    const callIds = calls.map((call) => call.id).filter(Boolean);
    const routeDecisionByCall = new Map();
    const routeFeedbackByCall = new Map();

    if (callIds.length && await tableExists('route_decisions')) {
      const decisionRows = await db('route_decisions')
        .whereIn('call_log_id', callIds);
      for (const row of decisionRows) {
        const selected = preferredRouteDecisionForFeedback([
          routeDecisionByCall.get(row.call_log_id),
          row,
        ]);
        if (selected) routeDecisionByCall.set(row.call_log_id, selected);
      }
    }

    if (callIds.length && await tableExists('route_feedback')) {
      const feedbackRows = await db('route_feedback')
        .whereIn('call_log_id', callIds)
        .orderBy('updated_at', 'desc');
      for (const row of feedbackRows) {
        if (!routeFeedbackByCall.has(row.call_log_id)) routeFeedbackByCall.set(row.call_log_id, row);
      }
    }

    const callsWithRouting = calls.map((call) => ({
      ...call,
      routeDecision: mapRouteDecision(routeDecisionByCall.get(call.id)),
      routeFeedback: mapRouteFeedback(routeFeedbackByCall.get(call.id)),
    }));

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

    res.json({ calls: callsWithRouting, stats });
  } catch (err) { next(err); }
});

// GET /api/ai/admin/calls/route-calibration — Right/Wrong label summary
router.get('/admin/calls/route-calibration', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    if (!(await tableExists('route_feedback'))) {
      return res.json({
        missingTable: true,
        windowDays: Number.parseInt(req.query.days || '30', 10) || 30,
        total: 0,
        accepted: 0,
        denied: 0,
        denyRate: 0,
        byDecisionKind: {},
        byAction: [],
        byBlockedReason: [],
        wrongFields: [],
        recentDenied: [],
      });
    }

    const days = Math.max(1, Math.min(365, Number.parseInt(req.query.days || '30', 10) || 30));
    const since = new Date(Date.now() - days * 86400000);

    const rows = await db('route_feedback as rf')
      .leftJoin('route_decisions as rd', 'rf.route_decision_id', 'rd.id')
      .leftJoin('call_log as cl', 'rf.call_log_id', 'cl.id')
      .where('rf.created_at', '>=', since)
      .orderBy('rf.updated_at', 'desc')
      .select(
        'rf.*',
        'rd.final_action_taken',
        'rd.validator_recommendation',
        'rd.blocked_reasons',
        'cl.twilio_call_sid',
        'cl.from_phone',
        'cl.to_phone',
        'cl.created_at as call_created_at',
        'cl.processing_status'
      );

    const summary = {
      missingTable: false,
      windowDays: days,
      total: rows.length,
      accepted: 0,
      denied: 0,
      denyRate: 0,
      byDecisionKind: {
        auto_routed: { total: 0, accepted: 0, denied: 0 },
        triaged: { total: 0, accepted: 0, denied: 0 },
      },
      byAction: new Map(),
      byBlockedReason: new Map(),
      wrongFields: new Map(),
      recentDenied: [],
    };

    function bump(map, key, verdict) {
      const name = key || 'unknown';
      const row = map.get(name) || { key: name, total: 0, accepted: 0, denied: 0, denyRate: 0 };
      row.total += 1;
      if (verdict === 'accept') row.accepted += 1;
      if (verdict === 'deny') row.denied += 1;
      map.set(name, row);
    }

    for (const row of rows) {
      const verdict = row.verdict === 'deny' ? 'deny' : 'accept';
      if (verdict === 'accept') summary.accepted += 1;
      if (verdict === 'deny') summary.denied += 1;

      const kind = row.decision_kind === 'auto_routed' ? 'auto_routed' : 'triaged';
      summary.byDecisionKind[kind].total += 1;
      if (verdict === 'accept') summary.byDecisionKind[kind].accepted += 1;
      if (verdict === 'deny') summary.byDecisionKind[kind].denied += 1;

      bump(summary.byAction, row.final_action_taken || row.validator_recommendation || row.decision_kind, verdict);

      const blockedReasons = parseJson(row.blocked_reasons, []);
      for (const reason of Array.isArray(blockedReasons) ? blockedReasons : []) {
        bump(summary.byBlockedReason, reason, verdict);
      }

      const fields = parseJson(row.wrong_fields, []);
      for (const field of Array.isArray(fields) ? fields : []) {
        bump(summary.wrongFields, field, verdict);
      }

      if (verdict === 'deny' && summary.recentDenied.length < 10) {
        summary.recentDenied.push({
          id: row.id,
          callLogId: row.call_log_id,
          routeDecisionId: row.route_decision_id,
          action: row.final_action_taken || null,
          note: row.note || null,
          wrongFields: Array.isArray(fields) ? fields : [],
          reviewedBy: row.reviewed_by || null,
          reviewedAt: row.updated_at || row.created_at,
          callCreatedAt: row.call_created_at,
        });
      }
    }

    summary.denyRate = summary.total ? summary.denied / summary.total : 0;
    for (const value of Object.values(summary.byDecisionKind)) {
      value.denyRate = value.total ? value.denied / value.total : 0;
    }

    const ranked = (map) => [...map.values()]
      .map((row) => ({ ...row, denyRate: row.total ? row.denied / row.total : 0 }))
      .sort((a, b) => b.denied - a.denied || b.total - a.total || a.key.localeCompare(b.key))
      .slice(0, 12);

    res.json({
      ...summary,
      byAction: ranked(summary.byAction),
      byBlockedReason: ranked(summary.byBlockedReason),
      wrongFields: ranked(summary.wrongFields),
    });
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

// POST /api/ai/admin/calls/:id/route-feedback — calibration verdict
router.post('/admin/calls/:id/route-feedback', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    if (!(await tableExists('route_feedback'))) {
      return res.status(409).json({ error: 'route_feedback table has not been migrated yet' });
    }

    const call = await db('call_log').where('id', req.params.id).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });

    const verdict = String(req.body?.verdict || '').trim();
    if (!['accept', 'deny'].includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be accept or deny' });
    }

    const wrongFields = verdict === 'deny' ? sanitizeWrongFields(req.body?.wrongFields) : [];
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const requestedRouteDecisionId = String(req.body?.routeDecisionId || '').trim();
    const triageItemId = String(req.body?.triageItemId || '').trim() || null;

    let routeDecision = null;
    if (requestedRouteDecisionId && await tableExists('route_decisions')) {
      routeDecision = await db('route_decisions')
        .where({ id: requestedRouteDecisionId, call_log_id: call.id })
        .first();
      if (!routeDecision) return res.status(400).json({ error: 'routeDecisionId does not belong to this call' });
    } else if (await tableExists('route_decisions')) {
      const decisionRows = await db('route_decisions')
        .where({ call_log_id: call.id });
      routeDecision = preferredRouteDecisionForFeedback(decisionRows);
    }

    const finalAction = String(routeDecision?.final_action_taken || '').toLowerCase();
    const decisionKind = req.body?.decisionKind === 'triaged' || req.body?.decisionKind === 'auto_routed'
      ? req.body.decisionKind
      : (/^(auto_|upsert_|create_|reuse_)/.test(finalAction) ? 'auto_routed' : 'triaged');

    const payload = {
      call_log_id: call.id,
      route_decision_id: routeDecision?.id || null,
      triage_item_id: triageItemId,
      decision_kind: decisionKind,
      verdict,
      wrong_fields: JSON.stringify(wrongFields),
      note: note || null,
      reviewed_by: actorName(req),
      updated_at: new Date(),
    };

    const [row] = await db('route_feedback')
      .insert(payload)
      .onConflict('call_log_id')
      .merge(payload)
      .returning('*');

    res.json({ feedback: mapRouteFeedback(row) });
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

    const conversations = await db('agent_sessions').where('created_at', '>', since);
    const escalations = await db('ai_escalations').where('created_at', '>', since);
    const messages = await db('agent_messages').where('created_at', '>', since);

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
