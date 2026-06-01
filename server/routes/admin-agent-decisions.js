const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { upsertReplyExampleFromAgentReview } = require('../services/reply-training-capture');

router.use(adminAuthenticate, requireTechOrAdmin);

const VALID_STATUSES = new Set(['pending_review', 'accepted', 'corrected', 'dismissed', 'all']);
const VALID_VERDICTS = new Set(['accepted', 'corrected', 'dismissed']);
const VALID_REPLY_VERDICTS = new Set(['accepted', 'edited', 'rejected', 'no_reply_needed']);

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

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, parsed));
}

function mapDecision(row) {
  const input = parseJson(row.input_snapshot, {});
  const customerName = [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ').trim();
  return {
    id: row.id,
    workflow: row.workflow,
    agentName: row.agent_name,
    decisionVersion: row.decision_version,
    mode: row.mode,
    status: row.status,
    entityType: row.entity_type,
    entityId: row.entity_id,
    customerId: row.customer_id,
    customerName: customerName || input?.estimate?.customer_name || input?.customer?.name || null,
    customerPhone: row.customer_phone || null,
    sourceFromPhone: row.sms_from_phone || null,
    sourceToPhone: row.sms_to_phone || null,
    leadId: row.lead_id,
    leadStatus: row.lead_status || null,
    estimateId: row.estimate_id,
    estimateStatus: row.estimate_status || null,
    estimateWaveguardTier: row.estimate_waveguard_tier || null,
    sourceChannel: row.source_channel,
    smsLogId: row.sms_log_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    detectedIntent: row.detected_intent,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    confidenceLabel: row.confidence_label,
    inputSnapshot: input,
    inboundMessage: row.sms_message_body || input?.sms?.body || null,
    recommendedActions: parseJson(row.recommended_actions, []),
    autoActionsAllowed: parseJson(row.auto_actions_allowed, []),
    blockedActions: parseJson(row.blocked_actions, []),
    safetyFlags: parseJson(row.safety_flags, []),
    suggestedMessage: row.suggested_message || null,
    reasoningSummary: row.reasoning_summary || null,
    model: row.model || null,
    promptVersion: row.prompt_version || null,
    humanVerdict: row.human_verdict || null,
    correctedActions: parseJson(row.corrected_actions, []),
    correctionNote: row.correction_note || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizePhoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function compactRecord(row, keys) {
  if (!row) return null;
  return Object.fromEntries(keys.map((key) => [key, row[key]]).filter(([, value]) => (
    value !== null && value !== undefined && value !== ''
  )));
}

function isAdminAuthoredSmsReply(row = {}) {
  const type = String(row.type || '').toLowerCase();
  if (['internal_alert', 'system_note'].includes(type)) return false;
  return !!row.adminUserId || type === 'manual';
}

async function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

function mapReplyTraining(row) {
  if (!row) return null;
  const metadata = parseJson(row.metadata, {});
  return {
    id: row.id,
    status: row.status,
    scenarioLabel: row.scenario_label || null,
    inboundBody: row.inbound_body || null,
    outboundBody: row.outbound_body || null,
    agentDraft: row.agent_draft || null,
    agentDraftEdited: row.agent_draft_edited,
    replyVerdict: row.review_verdict || null,
    reviewNote: row.review_note || row.edit_summary || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    captureReason: row.capture_reason || null,
    actualHumanReply: metadata.actualHumanReply || null,
    noReplyNeeded: !!metadata.noReplyNeeded || row.review_verdict === 'no_reply_needed',
    idealReplyProvided: !!metadata.idealReplyProvided,
    finalReplyProvided: !!metadata.finalReplyProvided,
    capturedAt: row.captured_at || row.created_at || null,
  };
}

function applyPhoneOrCustomerFilter(q, { customerId, phone }) {
  const last10 = normalizePhoneLast10(phone);
  q.where(function filterByIdentity() {
    if (customerId) this.where('customer_id', customerId);
    if (last10) {
      this.orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
        .orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10]);
    }
  });
}

async function loadDecision(id) {
  const row = await db('agent_decisions as ad')
    .leftJoin('customers as c', 'ad.customer_id', 'c.id')
    .leftJoin('leads as l', 'ad.lead_id', 'l.id')
    .leftJoin('estimates as e', 'ad.estimate_id', 'e.id')
    .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
    .where('ad.id', id)
    .select(
      'ad.*',
      'c.first_name as customer_first_name',
      'c.last_name as customer_last_name',
      'c.phone as customer_phone',
      'l.status as lead_status',
      'e.status as estimate_status',
      'e.waveguard_tier as estimate_waveguard_tier',
      's.message_body as sms_message_body',
      's.from_phone as sms_from_phone',
      's.to_phone as sms_to_phone'
    )
    .first();
  return row ? mapDecision(row) : null;
}

async function loadDecisionContext(decision) {
  const input = decision.inputSnapshot || {};
  const phone = decision.customerPhone || decision.sourceFromPhone || input?.sms?.from || input?.sms?.from_phone || null;
  const customerId = decision.customerId || null;

  const [
    customer,
    lead,
    estimate,
    smsRows,
    callRows,
    serviceRows,
  ] = await Promise.all([
    customerId ? db('customers').where({ id: customerId }).first() : null,
    decision.leadId ? db('leads').where({ id: decision.leadId }).first() : null,
    decision.estimateId ? db('estimates').where({ id: decision.estimateId }).first() : null,
    (async () => {
      if (!(customerId || normalizePhoneLast10(phone))) return [];
      const q = db('sms_log')
        .select('id', 'direction', 'from_phone', 'to_phone', 'message_body', 'message_type', 'status', 'admin_user_id', 'created_at')
        .orderBy('created_at', 'desc')
        .limit(18);
      applyPhoneOrCustomerFilter(q, { customerId, phone });
      const rows = await q;
      return rows.reverse();
    })(),
    (async () => {
      if (!(customerId || normalizePhoneLast10(phone))) return [];
      const q = db('call_log')
        .select('*')
        .orderBy('created_at', 'desc')
        .limit(6);
      applyPhoneOrCustomerFilter(q, { customerId, phone });
      return q;
    })(),
    customerId ? db('service_records')
      .where({ customer_id: customerId })
      .select('*')
      .orderByRaw('COALESCE(service_date, created_at) DESC')
      .limit(6) : [],
  ]);

  const smsThread = smsRows.map((row) => ({
    id: row.id,
    direction: row.direction,
    fromPhone: row.from_phone,
    toPhone: row.to_phone,
    body: row.message_body,
    type: row.message_type,
    status: row.status,
    adminUserId: row.admin_user_id || null,
    createdAt: row.created_at,
    isTrigger: row.id === decision.smsLogId,
  }));
  const trigger = smsThread.find((row) => row.isTrigger);
  const triggerTime = trigger?.createdAt ? new Date(trigger.createdAt).getTime() : null;
  const actualHumanReply = triggerTime
    ? smsThread.find((row) => (
      row.direction === 'outbound'
      && row.body
      && new Date(row.createdAt).getTime() > triggerTime
      && isAdminAuthoredSmsReply(row)
    ))
    : null;

  return {
    customer: compactRecord(customer, [
      'id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip',
      'waveguard_tier', 'monthly_rate', 'active', 'created_at',
    ]),
    lead: compactRecord(lead, [
      'id', 'status', 'lead_type', 'source', 'service_interest', 'waveguard_tier',
      'estimate_id', 'next_follow_up_at', 'notes', 'created_at', 'updated_at',
    ]),
    estimate: compactRecord(estimate, [
      'id', 'status', 'customer_name', 'customer_phone', 'customer_email', 'address',
      'category', 'service_interest', 'waveguard_tier', 'monthly_total', 'annual_total',
      'onetime_total', 'bill_by_invoice', 'sent_at', 'viewed_at', 'last_viewed_at',
      'accepted_at', 'scheduled_at', 'created_at', 'updated_at',
    ]),
    smsThread,
    actualHumanReply,
    calls: callRows.map((row) => ({
      id: row.id,
      direction: row.direction,
      status: row.status,
      fromPhone: row.from_phone,
      toPhone: row.to_phone,
      outcome: row.call_outcome || row.disposition || null,
      synopsis: row.lead_synopsis || row.ai_summary || null,
      transcription: row.transcription || null,
      notes: row.notes || null,
      createdAt: row.created_at,
    })),
    services: serviceRows.map((row) => ({
      id: row.id,
      serviceDate: row.service_date,
      serviceType: row.service_type,
      status: row.status,
      technicianNotes: row.technician_notes,
      fieldFlags: parseJson(row.field_flags, row.field_flags || null),
      createdAt: row.created_at,
    })),
  };
}

router.get('/', async (req, res, next) => {
  try {
    if (!(await tableExists('agent_decisions'))) {
      return res.json({ decisions: [], metrics: { pending: 0, accepted: 0, corrected: 0, dismissed: 0, total: 0 }, missingTable: true });
    }

    const status = VALID_STATUSES.has(String(req.query.status || 'pending_review'))
      ? String(req.query.status || 'pending_review')
      : 'pending_review';
    const workflow = String(req.query.workflow || '').trim();
    const limit = clampLimit(req.query.limit);

    const q = db('agent_decisions as ad')
      .leftJoin('customers as c', 'ad.customer_id', 'c.id')
      .leftJoin('leads as l', 'ad.lead_id', 'l.id')
      .leftJoin('estimates as e', 'ad.estimate_id', 'e.id')
      .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
      .select(
        'ad.*',
        'c.first_name as customer_first_name',
        'c.last_name as customer_last_name',
        'c.phone as customer_phone',
        'l.status as lead_status',
        'e.status as estimate_status',
        'e.waveguard_tier as estimate_waveguard_tier',
        's.message_body as sms_message_body',
        's.from_phone as sms_from_phone',
        's.to_phone as sms_to_phone'
      )
      .orderBy('ad.created_at', 'desc')
      .limit(limit);

    if (status !== 'all') q.where('ad.status', status);
    if (workflow) q.where('ad.workflow', workflow);

    const hasReplyTrainingTable = await tableExists('reply_training_examples');
    const [rows, metricsRows, replyMetricRows] = await Promise.all([
      q,
      db('agent_decisions')
        .select('status')
        .count('* as count')
        .groupBy('status'),
      hasReplyTrainingTable
        ? db('reply_training_examples')
          .select('status')
          .count('* as count')
          .groupBy('status')
        : [],
    ]);

    const metrics = {
      pending: 0,
      accepted: 0,
      corrected: 0,
      dismissed: 0,
      total: 0,
      replyTraining: { captured: 0, reviewed: 0, excluded: 0, total: 0 },
    };
    for (const row of metricsRows) {
      const count = Number(row.count || 0);
      metrics.total += count;
      if (row.status === 'pending_review') metrics.pending = count;
      if (row.status === 'accepted') metrics.accepted = count;
      if (row.status === 'corrected') metrics.corrected = count;
      if (row.status === 'dismissed') metrics.dismissed = count;
    }
    for (const row of replyMetricRows) {
      const count = Number(row.count || 0);
      metrics.replyTraining.total += count;
      if (row.status === 'captured') metrics.replyTraining.captured = count;
      if (row.status === 'reviewed') metrics.replyTraining.reviewed = count;
      if (row.status === 'excluded') metrics.replyTraining.excluded = count;
    }

    res.json({ decisions: rows.map(mapDecision), metrics, missingTable: false });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/context', async (req, res, next) => {
  try {
    if (!(await tableExists('agent_decisions'))) {
      return res.status(409).json({ error: 'agent_decisions table has not been migrated yet' });
    }

    const decision = await loadDecision(req.params.id);
    if (!decision) return res.status(404).json({ error: 'Decision not found' });

    const [context, replyTrainingRow] = await Promise.all([
      loadDecisionContext(decision),
      (await tableExists('reply_training_examples'))
        ? db('reply_training_examples')
          .where({ source_agent_decision_id: decision.id })
          .orderBy('updated_at', 'desc')
          .first()
        : null,
    ]);
    res.json({ decision, context, replyTraining: mapReplyTraining(replyTrainingRow) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reply-training', async (req, res, next) => {
  try {
    if (!(await tableExists('agent_decisions'))) {
      return res.status(409).json({ error: 'agent_decisions table has not been migrated yet' });
    }
    if (!(await tableExists('reply_training_examples'))) {
      return res.status(409).json({ error: 'reply_training_examples table has not been migrated yet' });
    }

    const decision = await loadDecision(req.params.id);
    if (!decision) return res.status(404).json({ error: 'Decision not found' });

    const replyVerdict = String(req.body?.replyVerdict || 'edited').trim();
    if (!VALID_REPLY_VERDICTS.has(replyVerdict)) {
      return res.status(400).json({ error: 'replyVerdict must be accepted, edited, rejected, or no_reply_needed' });
    }

    const finalReplyInput = String(req.body?.finalReply || req.body?.idealReply || '').trim().slice(0, 8000);
    const actualReply = String(req.body?.actualReply || '').trim().slice(0, 8000);
    const reviewNote = String(req.body?.reviewNote || '').trim().slice(0, 4000);
    const scenarioLabel = String(req.body?.scenarioLabel || '').trim().slice(0, 80);
    const finalReply = replyVerdict === 'accepted'
      ? finalReplyInput || selectedSuggestedReply(decision)
      : finalReplyInput;

    if (replyVerdict !== 'no_reply_needed' && !finalReply) {
      return res.status(400).json({ error: 'reply training requires a finalReply unless no_reply_needed is selected' });
    }

    const context = await loadDecisionContext(decision);
    const row = await upsertReplyExampleFromAgentReview({
      decision,
      context,
      finalReply,
      idealReply: finalReply,
      actualReply,
      replyVerdict,
      reviewNote,
      scenarioLabel,
      reviewedBy: actorName(req),
    });

    if (!row) return res.status(500).json({ error: 'Reply training example could not be saved' });
    res.json({ replyTraining: mapReplyTraining(row) });
  } catch (err) {
    next(err);
  }
});

function selectedSuggestedReply(decision) {
  return String(decision?.suggestedMessage || '').trim().slice(0, 8000);
}

router.post('/:id/review', async (req, res, next) => {
  try {
    if (!(await tableExists('agent_decisions'))) {
      return res.status(409).json({ error: 'agent_decisions table has not been migrated yet' });
    }

    const verdict = String(req.body?.verdict || '').trim();
    if (!VALID_VERDICTS.has(verdict)) {
      return res.status(400).json({ error: 'verdict must be accepted, corrected, or dismissed' });
    }

    const correctedActions = Array.isArray(req.body?.correctedActions)
      ? req.body.correctedActions.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const correctionNote = String(req.body?.correctionNote || req.body?.note || '').trim().slice(0, 4000);

    if (verdict === 'corrected' && !correctedActions.length && !correctionNote) {
      return res.status(400).json({ error: 'corrected decisions require correctedActions or a correctionNote' });
    }

    const [row] = await db('agent_decisions')
      .where({ id: req.params.id })
      .update({
        status: verdict,
        human_verdict: verdict,
        corrected_actions: verdict === 'corrected' ? JSON.stringify(correctedActions) : null,
        correction_note: correctionNote || null,
        reviewed_by: actorName(req),
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    if (!row) return res.status(404).json({ error: 'Decision not found' });
    res.json({ decision: mapDecision(row) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
