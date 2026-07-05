const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { evaluateClickFollowupGate } = require('../services/click-followup-gate');

router.use(adminAuthenticate, requireTechOrAdmin);

function parseFlags(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return {};
  }
}

function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : trimmed || null;
}

function samePhone(a, b) {
  const left = String(a || '').replace(/\D/g, '');
  const right = String(b || '').replace(/\D/g, '');
  return Boolean(left && right && left.slice(-10) === right.slice(-10));
}

async function resolveDraftRecipient(draft) {
  const flags = parseFlags(draft.flags);
  if (draft.sms_log_id) {
    const smsLog = await db('sms_log').where({ id: draft.sms_log_id }).first();
    if (smsLog?.from_phone) {
      return {
        toPhone: smsLog.from_phone,
        fromNumber: TWILIO_NUMBERS.findByNumber(smsLog.to_phone) ? smsLog.to_phone : undefined,
        customerId: draft.customer_id || smsLog.customer_id || null,
        identityTrustLevel: draft.customer_id || smsLog.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      };
    }
  }

  const customer = draft.customer_id
    ? await db('customers').where({ id: draft.customer_id }).select('id', 'phone').first()
    : null;
  const metadataPhone = normalizeE164(flags.toPhone || flags.phone || flags.leadPhone);
  if (metadataPhone) {
    const customerMatches = customer?.phone && samePhone(metadataPhone, customer.phone);
    return {
      toPhone: metadataPhone,
      customerId: customerMatches ? customer.id : null,
      identityTrustLevel: customerMatches ? 'phone_matches_customer' : 'phone_provided_unverified',
    };
  }

  if (draft.customer_id) {
    if (customer?.phone) {
      return {
        toPhone: customer.phone,
        customerId: customer.id,
        identityTrustLevel: 'phone_matches_customer',
      };
    }
  }

  return { toPhone: null, customerId: draft.customer_id || null, identityTrustLevel: 'phone_provided_unverified' };
}

async function releaseDraftClaim(draftId, fields = {}) {
  await db('message_drafts').where({ id: draftId }).update({
    status: 'pending',
    approved_by: null,
    approved_at: null,
    ...fields,
  }).catch(() => {});
}

// Send-policy mapping for owner-approved drafts. The route's default shape
// (audience 'lead', purpose 'conversational', no consentBasis) exists for
// the legacy inbound-reply queue — the messaging policy's anonymous-lead
// conversational carve-out is safe there because the contact texted us
// first. Click-followup drafts are PROACTIVE estimate nudges, so they must
// ride the same policy rails as every other estimate follow-up SMS: purpose
// 'estimate_followup' (transactional consent + quiet hours enforced by the
// messaging validators), estimateId threaded, and the same consentBasis
// shape estimate-follow-up.js passes for lead-only contacts. Narrowly
// scoped on intent — PR #2357 is generalizing purpose passthrough in this
// route; whichever merges second reconciles with the other.
function sendPolicyForDraft(draft, recipient) {
  if (draft.intent === 'click_followup') {
    const flags = parseFlags(draft.flags);
    return {
      audience: recipient.customerId ? 'customer' : 'lead',
      purpose: 'estimate_followup',
      estimateId: flags.estimate_id || undefined,
      consentBasis: recipient.customerId ? undefined : {
        status: 'transactional_allowed',
        source: 'click_followup_draft',
        capturedAt: draft.created_at || new Date().toISOString(),
      },
    };
  }
  return { audience: 'lead', purpose: 'conversational' };
}

// Terminal gate verdicts → retire the draft (it will never be sendable):
// which flags.reason to stamp, what the linked action becomes, and the
// operator-facing message.
const GATE_RETIRE = {
  converted: {
    reason: 'converted_before_send',
    actionStatus: 'converted',
    message: 'Contact already converted - draft retired, no send needed',
  },
  estimate_terminal: {
    reason: 'estimate_closed_before_send',
    actionStatus: 'dismissed',
    message: 'Estimate is no longer open (declined/expired/archived) - draft retired',
  },
  suppressed: {
    reason: 'recipient_suppressed',
    actionStatus: 'dismissed',
    message: 'Recipient is suppressed (opt-out/landline) - draft retired',
  },
};

// Transient gate verdicts → HOLD: block this send with a clear reason but
// leave the draft pending so the owner can retry once the condition passes.
const GATE_HOLD_MESSAGES = {
  cadence_due: 'An automated estimate follow-up is due within 24h - draft left pending, retry after it goes out',
  recent_outbound: 'Contact already received an SMS in the last 48h - draft left pending, retry later',
  replied_recently: 'Contact replied by SMS recently - handle the conversation in Communications; draft left pending',
};

// Click-followup drafts (services/click-followup.js) are queued hours or days
// before the owner approves them, and every guard the queue applied at draft
// time can flip while the draft sits pending: the contact converts, the
// estimate is declined/expires/archives, an opt-out lands, another SMS goes
// out, they reply, or a cadence stage comes due. Re-run the SAME shared gate
// (services/click-followup-gate.js) at approval time. Narrowly scoped to
// intent='click_followup'; every other intent is untouched.
//
// Returns null (send may proceed), { transient: true } (a conversion lookup
// failed — 503, claim released, retry re-checks), { hold: true, message }
// (transient touch-guard — 409, draft stays pending), or
// { blocked: true, message } after retiring the draft + updating the action.
async function guardClickFollowupSend(draft) {
  if (draft.intent !== 'click_followup') return null;
  const flags = parseFlags(draft.flags);
  const estimate = flags.estimate_id
    ? await db('estimates').where({ id: flags.estimate_id }).first().catch(() => null)
    : null;
  const verdict = await evaluateClickFollowupGate({
    estimate,
    // Which link kind the click landed on decides the 'accepted' semantics
    // (booking-kind clicks on accepted estimates stay live — see the gate).
    // Missing on pre-kind drafts → default to the stricter 'estimate' rules.
    kind: flags.kind || 'estimate',
    customerId: draft.customer_id || (estimate && estimate.customer_id) || null,
    leadId: flags.lead_id || null,
    phone: flags.toPhone || null,
    sinceTs: flags.clicked_at || draft.created_at,
  });
  if (verdict.ok) return null;
  if (verdict.code === 'guard_error') return { transient: true };

  const retire = GATE_RETIRE[verdict.code];
  if (retire) {
    await db('message_drafts').where({ id: draft.id }).update({
      status: 'rejected',
      flags: JSON.stringify({ ...flags, reason: retire.reason }),
    });
    await db('click_followup_actions')
      .where({ draft_id: draft.id })
      .update({
        status: retire.actionStatus,
        ...(retire.actionStatus === 'converted' ? { converted_at: new Date() } : {}),
        updated_at: db.fn.now(),
      })
      .catch(() => {});
    return { blocked: true, message: retire.message };
  }

  return { hold: true, message: GATE_HOLD_MESSAGES[verdict.code] || 'Draft held by pre-send checks - retry later' };
}

// GET /api/admin/drafts — pending drafts
router.get('/', async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const drafts = await db('message_drafts')
      .where(status === 'all' ? {} : { status })
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select('message_drafts.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.waveguard_tier', 'customers.pipeline_stage')
      .orderBy('message_drafts.created_at', 'desc')
      .limit(50);

    res.json({
      drafts: drafts.map(d => {
        const flags = parseFlags(d.flags);
        return {
          id: d.id, smsLogId: d.sms_log_id,
          customerId: d.customer_id,
          customerName: d.first_name ? `${d.first_name} ${d.last_name}` : 'Unknown',
          customerPhone: d.phone || null,
          recipientPhone: flags.phone || flags.toPhone || flags.leadPhone || d.phone || null,
          tier: d.waveguard_tier, stage: d.pipeline_stage,
          inboundMessage: d.inbound_message,
          draftResponse: d.draft_response,
          revisedResponse: d.revised_response,
          finalResponse: d.final_response,
          intent: d.intent, intentConfidence: d.intent_confidence,
          contextSummary: d.context_summary,
          flags,
          status: d.status, responseTimeSeconds: d.response_time_seconds,
          createdAt: d.created_at, approvedAt: d.approved_at, sentAt: d.sent_at,
        };
      }),
      pendingCount: await db('message_drafts').where({ status: 'pending' }).count('* as count').first().then(r => parseInt(r.count)),
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/approve — approve and send as-is
router.put('/:id/approve', async (req, res, next) => {
  try {
    const requestedFromNumber = req.body?.fromNumber || null;
    if (requestedFromNumber && !TWILIO_NUMBERS.findByNumber(requestedFromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    const claimTime = new Date();
    const [draft] = await db('message_drafts')
      .where({ id: req.params.id, status: 'pending' })
      .update({
        status: 'approved',
        approved_by: req.technicianId,
        approved_at: claimTime,
      })
      .returning('*');
    if (!draft) {
      const existing = await db('message_drafts').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      return res.status(409).json({ error: 'Draft is no longer pending' });
    }

    // Shared pre-send gate recheck (click-followup drafts only).
    const gateBlock = await guardClickFollowupSend(draft);
    if (gateBlock) {
      if (gateBlock.transient) {
        await releaseDraftClaim(draft.id);
        return res.status(503).json({ error: 'Pre-send check unavailable - draft left pending, try again' });
      }
      if (gateBlock.hold) {
        await releaseDraftClaim(draft.id);
        return res.status(409).json({ error: gateBlock.message });
      }
      return res.status(409).json({ error: gateBlock.message });
    }

    const recipient = await resolveDraftRecipient(draft);
    const toPhone = recipient.toPhone;
    const fromNumber = requestedFromNumber || recipient.fromNumber || undefined;

    if (!toPhone) {
      await releaseDraftClaim(draft.id);
      return res.status(400).json({ error: 'Cannot determine recipient phone' });
    }

    const sendPolicy = sendPolicyForDraft(draft, recipient);
    let smsResult;
    try {
      smsResult = await sendCustomerMessage({
        to: toPhone,
        body: draft.draft_response,
        channel: 'sms',
        audience: sendPolicy.audience,
        purpose: sendPolicy.purpose,
        estimateId: sendPolicy.estimateId,
        consentBasis: sendPolicy.consentBasis,
        customerId: recipient.customerId || undefined,
        identityTrustLevel: recipient.identityTrustLevel,
        entryPoint: 'admin_draft_approve',
        metadata: {
          original_message_type: 'ai_approved',
          draft_id: draft.id,
          adminUserId: req.technicianId,
          fromNumber,
        },
      });
    } catch (sendErr) {
      await releaseDraftClaim(draft.id);
      throw sendErr;
    }
    if (!smsResult.sent) {
      await releaseDraftClaim(draft.id);
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    await db('message_drafts').where({ id: draft.id }).update({
      final_response: draft.draft_response,
      sent_at: new Date(),
      response_time_seconds: responseTime,
    });

    res.json({ success: true, responseTimeSeconds: responseTime });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/revise — edit and send
router.put('/:id/revise', async (req, res, next) => {
  try {
    const { revisedResponse } = req.body;
    if (!revisedResponse) return res.status(400).json({ error: 'revisedResponse required' });
    const requestedFromNumber = req.body?.fromNumber || null;
    if (requestedFromNumber && !TWILIO_NUMBERS.findByNumber(requestedFromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    const claimTime = new Date();
    const [draft] = await db('message_drafts')
      .where({ id: req.params.id, status: 'pending' })
      .update({
        status: 'revised',
        revised_response: revisedResponse,
        final_response: revisedResponse,
        approved_by: req.technicianId,
        approved_at: claimTime,
      })
      .returning('*');
    if (!draft) {
      const existing = await db('message_drafts').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      return res.status(409).json({ error: 'Draft is no longer pending' });
    }

    // Shared pre-send gate recheck (click-followup drafts only).
    const gateBlock = await guardClickFollowupSend(draft);
    if (gateBlock) {
      if (gateBlock.transient) {
        await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
        return res.status(503).json({ error: 'Pre-send check unavailable - draft left pending, try again' });
      }
      if (gateBlock.hold) {
        await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
        return res.status(409).json({ error: gateBlock.message });
      }
      return res.status(409).json({ error: gateBlock.message });
    }

    const recipient = await resolveDraftRecipient(draft);
    const toPhone = recipient.toPhone;
    const fromNumber = requestedFromNumber || recipient.fromNumber || undefined;

    if (!toPhone) {
      await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
      return res.status(400).json({ error: 'Cannot determine recipient' });
    }

    const sendPolicy = sendPolicyForDraft(draft, recipient);
    let smsResult;
    try {
      smsResult = await sendCustomerMessage({
        to: toPhone,
        body: revisedResponse,
        channel: 'sms',
        audience: sendPolicy.audience,
        purpose: sendPolicy.purpose,
        estimateId: sendPolicy.estimateId,
        consentBasis: sendPolicy.consentBasis,
        customerId: recipient.customerId || undefined,
        identityTrustLevel: recipient.identityTrustLevel,
        entryPoint: 'admin_draft_revise',
        metadata: {
          original_message_type: 'ai_revised',
          draft_id: draft.id,
          adminUserId: req.technicianId,
          fromNumber,
        },
      });
    } catch (sendErr) {
      await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
      throw sendErr;
    }
    if (!smsResult.sent) {
      await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    await db('message_drafts').where({ id: draft.id }).update({
      sent_at: new Date(),
      response_time_seconds: responseTime,
    });

    res.json({ success: true, responseTimeSeconds: responseTime });
  } catch (err) { next(err); }
});

// PUT /api/admin/drafts/:id/reject
router.put('/:id/reject', async (req, res, next) => {
  try {
    // Draft rejection + linked click-followup action release commit or roll
    // back TOGETHER (same atomicity rule as the queue's draft-insert +
    // action-link pair and the stale sweep). 'drafted' is an OPEN status for
    // hasOpenAction and the partial unique indexes, so leaving the action
    // behind after an owner reject would block a fresh re-click from
    // re-qualifying the contact until the 14-day sweep. 'dismissed' is
    // terminal — outside both — so a re-click re-qualifies immediately.
    // Scoped to open statuses: an action the approval gate already retired
    // (converted/dismissed) keeps its more specific outcome. Non-click
    // intents have no linked action row and the update is a no-op.
    await db.transaction(async (trx) => {
      await trx('message_drafts').where({ id: req.params.id }).update({
        status: 'rejected', approved_by: req.technicianId, approved_at: new Date(),
      });
      await trx('click_followup_actions')
        .where({ draft_id: req.params.id })
        .whereIn('status', ['pending', 'drafted'])
        .update({ status: 'dismissed', updated_at: db.fn.now() });
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/drafts/stats — response time analytics
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await db('message_drafts')
      .whereIn('status', ['approved', 'revised'])
      .where('created_at', '>', new Date(Date.now() - 30 * 86400000))
      .select(
        db.raw('AVG(response_time_seconds) as avg_seconds'),
        db.raw('MIN(response_time_seconds) as min_seconds'),
        db.raw('MAX(response_time_seconds) as max_seconds'),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds < 300) as under_5min"),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds < 900) as under_15min"),
        db.raw("COUNT(*) FILTER (WHERE response_time_seconds > 3600) as over_1hr"),
        db.raw('COUNT(*) as total'),
      ).first();

    res.json({
      avgMinutes: stats.avg_seconds ? Math.round(parseFloat(stats.avg_seconds) / 60 * 10) / 10 : 0,
      under5min: parseInt(stats.under_5min || 0),
      under15min: parseInt(stats.under_15min || 0),
      over1hr: parseInt(stats.over_1hr || 0),
      total: parseInt(stats.total || 0),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/drafts/:id — single draft for compose deep-links
router.get('/:id', async (req, res, next) => {
  try {
    const d = await db('message_drafts')
      .where('message_drafts.id', req.params.id)
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select(
        'message_drafts.*',
        'customers.first_name',
        'customers.last_name',
        'customers.phone',
        'customers.waveguard_tier',
        'customers.pipeline_stage'
      )
      .first();
    if (!d) return res.status(404).json({ error: 'Draft not found' });

    const flags = parseFlags(d.flags);
    res.json({
      id: d.id,
      smsLogId: d.sms_log_id,
      customerId: d.customer_id,
      customerName: d.first_name ? `${d.first_name} ${d.last_name}` : 'Unknown',
      customerPhone: d.phone || null,
      recipientPhone: flags.phone || flags.toPhone || flags.leadPhone || d.phone || null,
      tier: d.waveguard_tier,
      stage: d.pipeline_stage,
      inboundMessage: d.inbound_message,
      draftResponse: d.draft_response,
      revisedResponse: d.revised_response,
      finalResponse: d.final_response,
      intent: d.intent,
      intentConfidence: d.intent_confidence,
      contextSummary: d.context_summary,
      flags,
      status: d.status,
      responseTimeSeconds: d.response_time_seconds,
      createdAt: d.created_at,
      approvedAt: d.approved_at,
      sentAt: d.sent_at,
    });
  } catch (err) { next(err); }
});

module.exports = router;
