const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { isEnabled } = require('../config/feature-gates');
const { CAMPAIGN_GATE, campaignApprovalState } = require('../services/campaign-drafts');

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

// Purposes whose policy row requires marketing-grade consent
// (policy.js requireConsent: 'marketing').
const MARKETING_GRADE_PURPOSES = new Set(['marketing', 'retention']);

/**
 * Audience/purpose/consent fields for a draft send.
 *
 * Null-purpose drafts (the inbound-reply lane) keep the legacy behavior
 * exactly: audience 'lead', purpose 'conversational', no consentBasis.
 *
 * Campaign drafts carry a non-null `purpose` — pass it through so the send
 * runs under the REAL policy row instead of bypassing consent as
 * 'conversational'. Marketing-grade purposes get the same stored-preference
 * consent basis the existing campaign senders assert (seasonal-reactivation /
 * upsell-trigger / retention agent: 'customer_marketing_preferences'); the
 * consent validator still enforces sms_enabled + seasonal_tips prefs,
 * customerId presence, and identity trust — this helper only stops the
 * bypass, it does not manufacture consent.
 */
function draftSendPolicyFields(draft, recipient) {
  if (!draft.purpose) {
    return { audience: 'lead', purpose: 'conversational' };
  }
  const fields = {
    audience: recipient.customerId ? 'customer' : 'lead',
    purpose: draft.purpose,
  };
  if (MARKETING_GRADE_PURPOSES.has(draft.purpose)) {
    fields.consentBasis = {
      status: 'opted_in',
      source: 'customer_marketing_preferences',
      capturedAt: new Date(draft.created_at || Date.now()).toISOString(),
    };
  }
  return fields;
}

/**
 * 422 body for a blocked/failed send. Surfaces the block code and — for
 * retryable holds like QUIET_HOURS_HOLD — the nextAllowedAt timestamp, so the
 * operator sees "held until 8am" instead of an opaque failure. The draft has
 * already been released back to pending, so it can simply be approved again
 * after the window opens.
 */
function blockedSendResponse(res, smsResult) {
  return res.status(422).json({
    error: smsResult.reason || smsResult.code || 'SMS send blocked/failed',
    code: smsResult.code,
    held: smsResult.code === 'QUIET_HOURS_HOLD' ? true : undefined,
    nextAllowedAt: smsResult.nextAllowedAt,
  });
}

// sms_log.message_type for approved campaign sends — aligned with what the
// legacy workflows historically logged ('reactivation' / 'upsell') so the
// campaign cooldown's CAMPAIGN_SMS_TYPES filter and readers like
// /api/admin/workflows/status see these sends. Null-campaign drafts keep the
// legacy 'ai_approved' / 'ai_revised' provenance value.
const CAMPAIGN_MESSAGE_TYPES = { reactivation: 'reactivation', upsell: 'upsell' };

function draftMessageType(draft, legacyValue) {
  if (!draft.campaign_type) return legacyValue;
  return CAMPAIGN_MESSAGE_TYPES[draft.campaign_type] || draft.campaign_type;
}

/**
 * Pre-send guard for campaign drafts (both approve and revise). Legacy
 * (null campaign_type) drafts pass straight through.
 *
 * 1. Gate kill switch: with GATE_CAMPAIGN_DRAFTS off, approving an EXISTING
 *    pending campaign draft must not send either — the gate's contract is
 *    zero campaign sends, not just zero new drafts. The claim is released so
 *    the draft stays pending and the 409 tells the operator why.
 * 2. Eligibility recheck (campaignApprovalState): customer soft-deleted /
 *    no-longer-live (upsell) / prefs flipped since generation → the draft is
 *    marked rejected with flags.campaign_rejected_reason instead of sending.
 *
 * Sends the HTTP response itself when blocking. Returns
 *   { blocked: true }                    — response already sent, caller returns
 *   { blocked: false, customer }         — proceed; customer carries
 *                                          nearest_location_id for the send
 */
async function guardCampaignSend(draft, req, res, releaseFields = {}) {
  if (!draft.campaign_type) return { blocked: false, customer: null };

  if (!isEnabled(CAMPAIGN_GATE)) {
    await releaseDraftClaim(draft.id, releaseFields);
    res.status(409).json({
      error: 'Campaign drafts are disabled (GATE_CAMPAIGN_DRAFTS is off) — draft left pending',
      code: 'CAMPAIGN_GATE_OFF',
    });
    return { blocked: true };
  }

  const { blockReason, customer } = await campaignApprovalState(draft);
  if (blockReason) {
    await db('message_drafts').where({ id: draft.id }).update({
      status: 'rejected',
      approved_by: req.technicianId,
      approved_at: new Date(),
      flags: JSON.stringify({ ...parseFlags(draft.flags), campaign_rejected_reason: blockReason }),
    });
    res.status(422).json({
      error: `Customer is no longer eligible for this campaign (${blockReason}) — draft rejected`,
      code: 'CAMPAIGN_INELIGIBLE',
      reason: blockReason,
    });
    return { blocked: true };
  }

  return { blocked: false, customer };
}

// GET /api/admin/drafts — pending drafts
// Optional ?campaign_type= filter: 'reactivation' | 'upsell' scopes to that
// campaign; 'none' scopes to legacy non-campaign drafts (inbound-reply lane).
router.get('/', async (req, res, next) => {
  try {
    const { status = 'pending', campaign_type: campaignType } = req.query;
    let query = db('message_drafts')
      .where(status === 'all' ? {} : { status })
      .leftJoin('customers', 'message_drafts.customer_id', 'customers.id')
      .select('message_drafts.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.waveguard_tier', 'customers.pipeline_stage')
      .orderBy('message_drafts.created_at', 'desc')
      .limit(50);
    if (campaignType === 'none') {
      query = query.whereNull('message_drafts.campaign_type');
    } else if (campaignType) {
      query = query.where('message_drafts.campaign_type', campaignType);
    }
    const drafts = await query;

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
          campaignType: d.campaign_type || null,
          purpose: d.purpose || null,
          sourceRef: d.source_ref || null,
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

    const campaignGuard = await guardCampaignSend(draft, req, res);
    if (campaignGuard.blocked) return;

    const recipient = await resolveDraftRecipient(draft);
    const toPhone = recipient.toPhone;
    const fromNumber = requestedFromNumber || recipient.fromNumber || undefined;

    if (!toPhone) {
      await releaseDraftClaim(draft.id);
      return res.status(400).json({ error: 'Cannot determine recipient phone' });
    }

    let smsResult;
    try {
      smsResult = await sendCustomerMessage({
        to: toPhone,
        body: draft.draft_response,
        channel: 'sms',
        ...draftSendPolicyFields(draft, recipient),
        customerId: recipient.customerId || undefined,
        identityTrustLevel: recipient.identityTrustLevel,
        entryPoint: 'admin_draft_approve',
        metadata: {
          original_message_type: draftMessageType(draft, 'ai_approved'),
          draft_id: draft.id,
          campaign_type: draft.campaign_type || undefined,
          source_ref: draft.source_ref || undefined,
          // Campaign drafts have no inbound sms_log to anchor a fromNumber —
          // originate from the customer's local office number the way the
          // legacy workflows did (TwilioService resolves it from this id).
          customerLocationId: campaignGuard.customer?.nearest_location_id || undefined,
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
      return blockedSendResponse(res, smsResult);
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

    const campaignGuard = await guardCampaignSend(draft, req, res, { revised_response: null, final_response: null });
    if (campaignGuard.blocked) return;

    const recipient = await resolveDraftRecipient(draft);
    const toPhone = recipient.toPhone;
    const fromNumber = requestedFromNumber || recipient.fromNumber || undefined;

    if (!toPhone) {
      await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
      return res.status(400).json({ error: 'Cannot determine recipient' });
    }

    let smsResult;
    try {
      smsResult = await sendCustomerMessage({
        to: toPhone,
        body: revisedResponse,
        channel: 'sms',
        ...draftSendPolicyFields(draft, recipient),
        customerId: recipient.customerId || undefined,
        identityTrustLevel: recipient.identityTrustLevel,
        entryPoint: 'admin_draft_revise',
        metadata: {
          original_message_type: draftMessageType(draft, 'ai_revised'),
          draft_id: draft.id,
          campaign_type: draft.campaign_type || undefined,
          source_ref: draft.source_ref || undefined,
          // Campaign drafts have no inbound sms_log to anchor a fromNumber —
          // originate from the customer's local office number the way the
          // legacy workflows did (TwilioService resolves it from this id).
          customerLocationId: campaignGuard.customer?.nearest_location_id || undefined,
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
      return blockedSendResponse(res, smsResult);
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
    await db('message_drafts').where({ id: req.params.id }).update({
      status: 'rejected', approved_by: req.technicianId, approved_at: new Date(),
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
      campaignType: d.campaign_type || null,
      purpose: d.purpose || null,
      sourceRef: d.source_ref || null,
      status: d.status,
      responseTimeSeconds: d.response_time_seconds,
      createdAt: d.created_at,
      approvedAt: d.approved_at,
      sentAt: d.sent_at,
    });
  } catch (err) { next(err); }
});

// Exposed for tests
router._internals = { draftSendPolicyFields, blockedSendResponse, draftMessageType, CAMPAIGN_MESSAGE_TYPES };

module.exports = router;
