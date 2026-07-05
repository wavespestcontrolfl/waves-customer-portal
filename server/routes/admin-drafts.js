const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { evaluateClickFollowupGate } = require('../services/click-followup-gate');
const { isEnabled } = require('../config/feature-gates');
const { CAMPAIGN_GATE } = require('../services/campaign-drafts');
const {
  evaluateCampaignSendGate,
  parseOpportunityRef,
  TERMINAL_CODES: CAMPAIGN_TERMINAL_CODES,
  HOLD_CODES: CAMPAIGN_HOLD_CODES,
} = require('../services/campaign-drafts-gate');
const { SUPPRESSION_SENTINELS } = require('../services/sms-auto-send');

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

// Send-policy mapping for owner-approved drafts. Click-followup drafts are
// PROACTIVE estimate nudges, so they must ride the same policy rails as
// every other estimate follow-up SMS: purpose 'estimate_followup'
// (transactional consent + quiet hours enforced by the messaging
// validators), estimateId threaded, and the same consentBasis shape
// estimate-follow-up.js passes for lead-only contacts. They carry no
// message_drafts.purpose value, so the intent branch runs FIRST; every
// other draft (campaign or legacy inbound-reply) rides
// draftSendPolicyFields' purpose passthrough below.
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
  return draftSendPolicyFields(draft, recipient);
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
  let estimate = null;
  if (flags.estimate_id) {
    try {
      estimate = (await db('estimates').where({ id: flags.estimate_id }).first()) || null;
    } catch (err) {
      // A transient estimate-read failure must not masquerade as a MISSING
      // estimate: the gate would answer estimate_terminal and this route
      // would PERMANENTLY retire a perfectly sendable draft. Same
      // fail-closed contract as the gate's guard_error verdict — 503, claim
      // released, draft stays pending for a retry. Only a read that
      // SUCCEEDS and finds no row is truly terminal.
      logger.warn(`[admin-drafts] click-followup estimate lookup failed - holding draft ${draft.id}: ${err.message}`);
      return { transient: true };
    }
  }
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
    // Draft retire + linked action transition commit or roll back TOGETHER
    // (same atomicity rule as the send-success and reject paths): a failure
    // between the two writes would retire the draft but strand the action
    // in 'drafted' — an open claim for hasOpenAction and the partial unique
    // indexes, blocking a fresh re-click from re-qualifying the contact
    // until the 14-day sweep.
    await db.transaction(async (trx) => {
      await trx('message_drafts').where({ id: draft.id }).update({
        status: 'rejected',
        flags: JSON.stringify({ ...flags, reason: retire.reason }),
      });
      await trx('click_followup_actions')
        .where({ draft_id: draft.id })
        .update({
          status: retire.actionStatus,
          ...(retire.actionStatus === 'converted' ? { converted_at: new Date() } : {}),
          updated_at: db.fn.now(),
        });
    });
    return { blocked: true, message: retire.message };
  }

  return { hold: true, message: GATE_HOLD_MESSAGES[verdict.code] || 'Draft held by pre-send checks - retry later' };
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
 * 2. Shared pre-send gate (services/campaign-drafts-gate.js) — the SAME
 *    guard stack the generators ran at draft time, re-evaluated against
 *    CURRENT state, because every predicate can flip while a draft sits
 *    pending. Verdict mapping:
 *      terminal (customer deleted / upsell target no longer live /
 *      reactivation target no longer lapsed / opportunity gone or already
 *      pitched-accepted-declined-deferred elsewhere / prefs revoked)
 *        → draft retired: status 'rejected' + flags.campaign_rejected_reason,
 *          422 CAMPAIGN_INELIGIBLE. If the condition recurs legitimately
 *          (customer lapses again), the next generator run writes a FRESH draft.
 *      hold (unified 30d cooldown hit — another campaign lane touched the
 *      customer after this draft was written; the draft's own row is excluded)
 *        → claim released, draft LEFT PENDING, 409 CAMPAIGN_COOLDOWN_HOLD.
 *      transient (guard lookup failed — fail closed)
 *        → claim released, draft left pending, 503.
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

  const verdict = await evaluateCampaignSendGate({
    campaignType: draft.campaign_type,
    customerId: draft.customer_id,
    sourceRef: draft.source_ref,
    excludeDraftId: draft.id,
  });
  if (verdict.ok) return { blocked: false, customer: verdict.customer };

  if (CAMPAIGN_HOLD_CODES.has(verdict.code)) {
    await releaseDraftClaim(draft.id, releaseFields);
    res.status(409).json({
      error: `Campaign send held (${verdict.reason || verdict.code}) — another campaign lane touched this customer in the last 30 days; draft left pending`,
      code: 'CAMPAIGN_COOLDOWN_HOLD',
      reason: verdict.reason || verdict.code,
    });
    return { blocked: true };
  }

  if (!CAMPAIGN_TERMINAL_CODES.has(verdict.code)) {
    // guard_error (or an unknown future code) — fail closed but transient:
    // nothing about the draft is known to be stale, so keep it pending.
    await releaseDraftClaim(draft.id, releaseFields);
    res.status(503).json({
      error: 'Campaign pre-send check unavailable — draft left pending, try again',
      code: 'CAMPAIGN_GUARD_ERROR',
    });
    return { blocked: true };
  }

  await db('message_drafts').where({ id: draft.id }).update({
    status: 'rejected',
    approved_by: req.technicianId,
    approved_at: new Date(),
    flags: JSON.stringify({
      ...parseFlags(draft.flags),
      campaign_rejected_reason: verdict.code,
      ...(verdict.reason ? { campaign_rejected_detail: verdict.reason } : {}),
    }),
  });
  res.status(422).json({
    error: `Customer is no longer eligible for this campaign (${verdict.code}) — draft rejected`,
    code: 'CAMPAIGN_INELIGIBLE',
    reason: verdict.code,
  });
  return { blocked: true };
}

/**
 * sendCustomerMessage reports sent:true for upstream SUPPRESSION paths where
 * no customer SMS actually left — the provider id is a sentinel (e.g. the
 * admin-sms-templates kill switch returns sid 'template-disabled'), not a
 * Twilio sid. Same contract sms-auto-send.js enforces via
 * SUPPRESSION_SENTINELS. Campaign drafts map messageType to
 * 'upsell'/'reactivation', which are real per-template kill-switch keys, so
 * this path is reachable: finalizing would mark the draft sent while the
 * customer received nothing. Returns the sentinel id, or null for a real send.
 */
function suppressedSendSentinel(smsResult) {
  const id = smsResult && smsResult.providerMessageId;
  return id && SUPPRESSION_SENTINELS.has(id) ? id : null;
}

/**
 * Finalize a draft after a REAL provider send. A draft's linked row moves in
 * the SAME transaction as the draft finalization:
 *
 *  - Upsell campaign drafts (source_ref names their upsell_opportunities
 *    row): flip that row to 'pitched' — customer-intel metrics and UI derive
 *    pitched/accepted counts from upsell_opportunities.status, so a sent
 *    pitch must move the row. Scoped to status='identified' so an outcome
 *    set concurrently (accepted/declined via the customer-intel route) is
 *    never regressed back to 'pitched'.
 *  - Click-followup drafts: release the linked click_followup_actions claim
 *    to 'sent' (same atomicity rule as the reject path, the queue's
 *    draft-insert + action-link pair, and the stale sweep). The send
 *    SUCCEEDED, so the action's open claim ('drafted' — held open by
 *    hasOpenAction and the partial unique indexes) must end here: 'sent' is
 *    terminal for claim purposes, so a later click from the same
 *    customer/lead/phone re-qualifies immediately instead of waiting out the
 *    14-day sweep, while staying distinguishable from 'dismissed' in outcome
 *    telemetry. Scoped to open statuses so a more specific outcome is never
 *    overwritten.
 *
 * Drafts with neither linkage (legacy inbound-reply, reactivation campaigns)
 * finalize with a plain update — no transaction.
 */
async function finalizeDraftSend(draft, updates) {
  const oppId = draft.campaign_type === 'upsell' ? parseOpportunityRef(draft.source_ref) : null;
  const isClickFollowup = draft.intent === 'click_followup';
  if (!oppId && !isClickFollowup) {
    await db('message_drafts').where({ id: draft.id }).update(updates);
    return;
  }
  await db.transaction(async (trx) => {
    await trx('message_drafts').where({ id: draft.id }).update(updates);
    if (isClickFollowup) {
      await trx('click_followup_actions')
        .where({ draft_id: draft.id })
        .whereIn('status', ['pending', 'drafted'])
        .update({ status: 'sent', updated_at: db.fn.now() });
    }
    if (oppId) {
      await trx('upsell_opportunities')
        .where({ id: oppId, status: 'identified' })
        .update({
          status: 'pitched',
          pitched_at: new Date(),
          pitched_by: 'campaign_draft',
          updated_at: new Date(),
        });
    }
  });
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

    // Shared pre-send gate recheck (campaign drafts only).
    const campaignGuard = await guardCampaignSend(draft, req, res);
    if (campaignGuard.blocked) return;

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
        // Unified policy passthrough: click-followup drafts ride the
        // estimate rails (purpose 'estimate_followup' + estimateId +
        // transactional consentBasis for lead-only); campaign drafts pass
        // their real purpose through (marketing-grade purposes carry the
        // stored-preference consentBasis); legacy null-purpose drafts keep
        // the conversational shape exactly.
        ...sendPolicy,
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
    // Suppression sentinel (campaign drafts): sent:true but nothing actually
    // left (e.g. the 'upsell'/'reactivation' SMS template is disabled). Do NOT
    // finalize as sent — release the claim so the draft stays actionable once
    // the template is re-enabled, and tell the operator what happened.
    const suppressed = draft.campaign_type ? suppressedSendSentinel(smsResult) : null;
    if (suppressed) {
      await releaseDraftClaim(draft.id);
      return res.status(422).json({
        error: `No SMS was sent — the send was suppressed upstream (${suppressed}); draft left pending`,
        code: 'SEND_SUPPRESSED',
        reason: suppressed,
      });
    }

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    // Draft finalization + linked-row release (click action → 'sent';
    // upsell opportunity → 'pitched') commit or roll back TOGETHER — see
    // finalizeDraftSend.
    await finalizeDraftSend(draft, {
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

    // Shared pre-send gate recheck (campaign drafts only).
    const campaignGuard = await guardCampaignSend(draft, req, res, { revised_response: null, final_response: null });
    if (campaignGuard.blocked) return;

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
        // Unified policy passthrough: click-followup drafts ride the
        // estimate rails (purpose 'estimate_followup' + estimateId +
        // transactional consentBasis for lead-only); campaign drafts pass
        // their real purpose through (marketing-grade purposes carry the
        // stored-preference consentBasis); legacy null-purpose drafts keep
        // the conversational shape exactly.
        ...sendPolicy,
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
    // Suppression sentinel (campaign drafts) — same contract as approve: a
    // sentinel provider id means nothing left, so never finalize as sent.
    const suppressed = draft.campaign_type ? suppressedSendSentinel(smsResult) : null;
    if (suppressed) {
      await releaseDraftClaim(draft.id, { revised_response: null, final_response: null });
      return res.status(422).json({
        error: `No SMS was sent — the send was suppressed upstream (${suppressed}); draft left pending`,
        code: 'SEND_SUPPRESSED',
        reason: suppressed,
      });
    }

    const responseTime = Math.round((Date.now() - new Date(draft.created_at)) / 1000);

    // Same atomic finalization + linked-row release as the approve route —
    // see finalizeDraftSend.
    await finalizeDraftSend(draft, {
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
router._internals = {
  draftSendPolicyFields, blockedSendResponse, draftMessageType,
  CAMPAIGN_MESSAGE_TYPES, suppressedSendSentinel, finalizeDraftSend,
};

module.exports = router;
