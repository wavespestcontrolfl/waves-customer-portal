'use strict';

/**
 * Extended New-Lead Phone-Only Residential SMS Follow-Up Drip (owner 2026-11-27 "ok go", Decision 2).
 *
 * Ships 100% DARK behind GATE_NEW_LEAD_DRIP_EXTENDED (`newLeadDripExtendedLive()`, strict `=== 'true'`,
 * unset by default). While off, the scheduler exits before taking any DB lock and
 * `processPhoneOnlyLeadSmsDrip()` returns immediately with zero queries and zero sends.
 *
 * Audience: unquoted open residential leads (`status IN ('new', 'contacted')`, `is_commercial IS NOT TRUE`)
 * with a phone number, NO email address, verifiable SMS consent/inbound inquiry on that exact phone,
 * no linked/created/sent estimate, no booked visit, not a paying customer, and no human SMS engagement.
 *
 * Durability & safety:
 *   - Durable pre-dispatch claim in `new_lead_phone_drip_sends (lead_id, step)` before calling Twilio
 *     (deleted ONLY on definitive `deliveryOutcome === 'not_sent'`; `'uncertain'` stays locked).
 *   - Live lead, destination phone, consent, and stop recheck inside `providerPreSendCheck` at handoff.
 *   - Fail-closed `messaging_suppression` check + `VERIFIED_SUPPRESSION_ENTRY_POINTS`.
 *   - Paginates past stopped/completed leads so older ineligible rows never starve newer leads.
 *   - Brand copy = "Waves" ONLY, zero owner name, STOP opt-out on Touch 1, 8 AM–8 PM ET only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const { toE164, phoneIdentityKey } = require('../utils/phone');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { NON_LIVE_APPOINTMENT_STATUSES } = require('./estimate-conversion-guard');
const { HUMAN_REPLY_TYPES, SENT_STATUSES } = require('./sms-suggest-mode');

const STEP_1_ACTIVITY = 'phone_drip_sms_step_1';
const STEP_2_ACTIVITY = 'phone_drip_sms_step_2';
const DRIP_ENTRY_POINT = 'new_lead_phone_sms_drip';
const UNQUOTED_OPEN_STATUSES = Object.freeze(['new', 'contacted']);
const CONSENTED_WEB_LEAD_TYPES = new Set(['form_submission', 'quote_wizard', 'website_chat']);
const QUIET_START_HOUR_ET = 8;
const QUIET_END_HOUR_ET = 20;
const HOUR_MS = 3600 * 1000;
const ENGAGEMENT_OUTBOUND_TYPES = [...HUMAN_REPLY_TYPES, 'ai_autosent', 'ai_gratitude'];

function firstNameOrDefault(lead) {
  const raw = String(lead?.first_name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'-]{1,24}$/.test(raw) ? raw : null;
}

function buildPhoneDripCopy(step, lead) {
  const name = firstNameOrDefault(lead);
  const hi = name ? `Hi ${name}, it's Waves.` : "Hi, it's Waves.";
  if (step === 1) {
    return `${hi} Most homes here run $105-$120 per quarterly pest visit with no contract. Reply with your address if you'd like your exact price. Reply STOP to opt out.`;
  }
  return `${hi} Quick check: are you seeing ants, roaches, lawn issues, or something else? Reply with one word and we'll let you know the best fix.`;
}

function isWithinSendHoursET(now = new Date()) {
  const { hour } = etParts(now);
  return hour >= QUIET_START_HOUR_ET && hour < QUIET_END_HOUR_ET;
}

function isEligibleUnquotedLeadRow(lead) {
  if (!lead || lead.deleted_at || lead.is_commercial === true) return false;
  if (lead.converted_at || lead.estimate_id) return false;
  if (!UNQUOTED_OPEN_STATUSES.includes(lead.status)) return false;
  return Boolean(String(lead.phone || '').trim()) && !String(lead.email || '').trim();
}

function pickDueStep(lead, sentClaims, now = new Date()) {
  if (!isEligibleUnquotedLeadRow(lead)) return null;
  const createdMs = new Date(lead.created_at).getTime();
  if (!Number.isFinite(createdMs)) return null;
  const ageHours = (now.getTime() - createdMs) / HOUR_MS;

  const claims = Array.isArray(sentClaims) ? sentClaims : [];
  const step1 = claims.find((c) => Number(c.step) === 1 || c.activity_type === STEP_1_ACTIVITY);
  const step2 = claims.find((c) => Number(c.step) === 2 || c.activity_type === STEP_2_ACTIVITY);
  if (step2) return null;

  if (!step1) {
    return ageHours >= 48 && ageHours <= 96 ? 1 : null;
  }
  if (step1.status && step1.status !== 'sent') return null;
  const step1At = new Date(step1.sent_at || step1.created_at).getTime();
  if (!Number.isFinite(step1At)) return null;
  const sinceStep1Hours = (now.getTime() - step1At) / HOUR_MS;
  return ageHours >= 120 && ageHours <= 168 && sinceStep1Hours >= 48 ? 2 : null;
}

function parseExtractedData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

/**
 * Verifies positive SMS consent or a carrier-verified inbound inquiry matching `phoneDigits`.
 * Manually entered / cold leads without recorded consent return null and are NEVER texted.
 */
async function verifyLeadSmsConsent(conn, lead, phoneDigits) {
  if (lead.customer_id) {
    const prefs = await conn('notification_prefs')
      .where({ customer_id: lead.customer_id })
      .first('sms_enabled', 'marketing_offers');
    if (prefs && prefs.sms_enabled === false) return null;
    if (prefs && prefs.marketing_offers === true) {
      return { status: 'opted_in', source: 'customer_notification_prefs' };
    }
  }

  if (lead.twilio_call_sid) {
    const call = await conn('call_log')
      .where({ twilio_call_sid: lead.twilio_call_sid, direction: 'inbound' })
      .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_number, ''), '\\D', '', 'g'), 10) = ?", [phoneDigits])
      .first('id');
    if (call) return { status: 'transactional_allowed', source: 'inbound_call_inquiry' };
  }

  if (lead.twilio_message_sid) {
    const msg = await conn('sms_log')
      .where({ twilio_sid: lead.twilio_message_sid, direction: 'inbound' })
      .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '\\D', '', 'g'), 10) = ?", [phoneDigits])
      .first('id');
    if (msg) return { status: 'transactional_allowed', source: 'inbound_sms_inquiry' };
  }

  const extracted = parseExtractedData(lead.extracted_data);
  if (CONSENTED_WEB_LEAD_TYPES.has(lead.lead_type) && (extracted.sms_opt_in === true || extracted.sms_consent === true)) {
    return { status: 'opted_in', source: 'web_form_sms_opt_in' };
  }

  return null;
}

async function hasBlockingEstimate(conn, lead) {
  const est = await conn('estimates')
    .where((w) => {
      w.whereRaw("estimate_data->>'lead_id' = ?", [String(lead.id)]);
      if (lead.customer_id) {
        w.orWhere((c) => c.where('customer_id', lead.customer_id)
          .andWhere((when) => when.where('created_at', '>=', lead.created_at).orWhere('sent_at', '>=', lead.created_at)));
      }
    })
    .first('id');
  return Boolean(est);
}

async function hasCustomerConversion(conn, customerId) {
  if (!customerId) return null;
  const booked = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
    .first('id');
  if (booked) return 'visit_booked';

  const paid = await conn('invoices').where({ customer_id: customerId, status: 'paid' }).first('id');
  if (paid) return 'paying_customer';

  const cust = await conn('customers').where({ id: customerId }).first('pipeline_stage');
  if (cust && CUSTOMER_STAGES.includes(cust.pipeline_stage)) return 'existing_customer';
  return null;
}

async function leadShouldStop(conn, lead) {
  const phoneDigits = phoneIdentityKey(lead.phone);
  if (!phoneDigits || phoneDigits.length < 10) return { stop: 'invalid_phone', consentBasis: null };

  const consentBasis = await verifyLeadSmsConsent(conn, lead, phoneDigits);
  if (!consentBasis) return { stop: 'no_recorded_consent', consentBasis: null };

  if (await hasBlockingEstimate(conn, lead)) return { stop: 'has_estimate', consentBasis: null };

  const converted = await hasCustomerConversion(conn, lead.customer_id);
  if (converted) return { stop: converted, consentBasis: null };

  // Exclude the lead's own originating inbound message (twilio_message_sid) from engagement stop,
  // while stopping on any subsequent inbound reply or staff/auto outbound reply.
  const recentSms = await conn('sms_log')
    .where('created_at', '>=', lead.created_at)
    .where((w) => {
      if (lead.twilio_message_sid) w.whereRaw("COALESCE(twilio_sid, '') <> ?", [lead.twilio_message_sid]);
    })
    .where((w) => {
      w.whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '\\D', '', 'g'), 10) = ?", [phoneDigits])
        .orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '\\D', '', 'g'), 10) = ?", [phoneDigits]);
    })
    .where((w) => {
      w.where('direction', 'inbound')
        .orWhere((o) => o.where('direction', 'outbound')
          .whereIn('message_type', ENGAGEMENT_OUTBOUND_TYPES)
          .whereIn('status', [...SENT_STATUSES, 'scheduled', 'sending']));
    })
    .first('id');
  if (recentSms) return { stop: 'already_engaged', consentBasis: null };

  const phoneCandidates = [...new Set([lead.phone, toE164(lead.phone)].filter(Boolean))];
  const suppressed = await conn('messaging_suppression')
    .whereIn('phone', phoneCandidates)
    .where({ active: true })
    .first('phone');
  if (suppressed) return { stop: 'opted_out', consentBasis: null };

  return { stop: null, consentBasis };
}

async function claimLeadDripStep(dbh, { leadId, step, destinationPhone, deliveryKey }) {
  const rows = await dbh('new_lead_phone_drip_sends')
    .insert({
      lead_id: leadId,
      step,
      status: 'claimed',
      destination_phone: destinationPhone,
      delivery_key: deliveryKey,
      claimed_at: new Date(),
    })
    .onConflict(['lead_id', 'step'])
    .ignore()
    .returning('id');
  return Array.isArray(rows) && rows.length > 0 ? rows[0].id || rows[0] : null;
}

async function settleDripClaim(dbh, { claimId, leadId, step, activityType, outcome, providerMessageId }) {
  if (outcome === 'sent') {
    await dbh('new_lead_phone_drip_sends')
      .where({ id: claimId })
      .update({ status: 'sent', sent_at: new Date(), provider_message_id: providerMessageId || null });
    await dbh('lead_activities').insert({
      lead_id: leadId,
      activity_type: activityType,
      description: `Phone-only lead drip step ${step} sent`,
      performed_by: 'System',
      metadata: JSON.stringify({ step, channel: 'sms', delivery_outcome: 'accepted' }),
    }).catch((err) => logger.warn(`[new-lead-phone-sms-drip] activity log failed for lead ${leadId}: ${err?.code || err?.name || 'error'}`));
    return;
  }
  if (outcome === 'release') {
    await dbh('new_lead_phone_drip_sends').where({ id: claimId, status: 'claimed' }).del();
    return;
  }
  await dbh('new_lead_phone_drip_sends').where({ id: claimId }).update({ status: 'uncertain' });
}

function buildHandoffPreSendCheck({ dbh, leadId, expectedPhone, step }) {
  return async ({ database } = {}) => {
    const conn = database || dbh;
    const freshLead = await conn('leads')
      .where({ id: leadId })
      .first(
        'id', 'first_name', 'phone', 'email', 'customer_id', 'estimate_id',
        'converted_at', 'is_commercial', 'status', 'deleted_at', 'created_at',
        'twilio_call_sid', 'twilio_message_sid', 'lead_type', 'extracted_data',
      );
    if (!isEligibleUnquotedLeadRow(freshLead)) {
      return { ok: false, code: 'LEAD_DRIP_INELIGIBLE', reason: 'Lead is no longer an open unquoted phone-only residential lead' };
    }
    if (phoneIdentityKey(freshLead.phone) !== phoneIdentityKey(expectedPhone)) {
      return { ok: false, code: 'LEAD_PHONE_CHANGED', reason: 'Lead phone number changed before SMS handoff' };
    }
    const check = await leadShouldStop(conn, freshLead);
    if (check.stop) {
      return { ok: false, code: `LEAD_DRIP_STOP_${check.stop.toUpperCase()}`, reason: `Lead stopped at handoff (${check.stop})` };
    }
    const existingClaim = await conn('new_lead_phone_drip_sends')
      .where({ lead_id: leadId, step })
      .first('status');
    if (existingClaim && existingClaim.status !== 'claimed') {
      return { ok: false, code: 'LEAD_DRIP_ALREADY_SENT', reason: 'Drip step already settled' };
    }
    return { ok: true };
  };
}

async function processOnePhoneLead(dbh, lead, { now, sender }) {
  const claims = await dbh('new_lead_phone_drip_sends')
    .where({ lead_id: lead.id })
    .select('step', 'status', 'sent_at', 'claimed_at');

  const step = pickDueStep(lead, claims, now);
  if (!step) return 'skip';

  const { stop, consentBasis } = await leadShouldStop(dbh, lead);
  if (stop) return 'stopped';

  const destinationPhone = toE164(lead.phone) || lead.phone;
  const activityType = step === 1 ? STEP_1_ACTIVITY : STEP_2_ACTIVITY;
  const deliveryKey = `${DRIP_ENTRY_POINT}:${lead.id}:step_${step}`;
  const claimId = await claimLeadDripStep(dbh, { leadId: lead.id, step, destinationPhone, deliveryKey });
  if (!claimId) return 'skip';

  let result;
  try {
    result = await sender({
      to: destinationPhone,
      body: buildPhoneDripCopy(step, lead),
      channel: 'sms',
      audience: 'lead',
      purpose: 'missed_call_followup',
      customerId: lead.customer_id || undefined,
      leadId: lead.id,
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis,
      entryPoint: DRIP_ENTRY_POINT,
      metadata: { original_message_type: activityType, lead_id: lead.id, drip_step: step, delivery_key: deliveryKey },
      providerPreSendCheck: buildHandoffPreSendCheck({ dbh, leadId: lead.id, expectedPhone: destinationPhone, step }),
    });
  } catch (err) {
    const definitive = err?.providerOutcome?.deliveryOutcome === 'not_sent';
    await settleDripClaim(dbh, { claimId, leadId: lead.id, step, activityType, outcome: definitive ? 'release' : 'uncertain' });
    throw err;
  }

  if (result?.deliveryOutcome === 'accepted' || result?.sent === true) {
    await settleDripClaim(dbh, { claimId, leadId: lead.id, step, activityType, outcome: 'sent', providerMessageId: result?.providerMessageId });
    return 'sent';
  }
  if (result?.deliveryOutcome === 'not_sent') {
    await settleDripClaim(dbh, { claimId, leadId: lead.id, step, activityType, outcome: 'release' });
    return result?.retryable === true ? 'deferred' : 'stopped';
  }
  await settleDripClaim(dbh, { claimId, leadId: lead.id, step, activityType, outcome: 'uncertain' });
  return 'deferred';
}

async function processPhoneOnlyLeadSmsDrip({
  now = new Date(),
  limit = 25,
  pageSize = null,
  dbh = db,
  gates = null,
  sendMessage = null,
} = {}) {
  const featureGates = gates || require('../config/feature-gates');
  if (featureGates.newLeadDripExtendedLive?.() !== true) {
    return { skipped: 'gate_off', checked: 0, sent: 0, stopped: 0, deferred: 0 };
  }
  if (!isWithinSendHoursET(now)) {
    return { skipped: 'quiet_hours', checked: 0, sent: 0, stopped: 0, deferred: 0 };
  }

  const cutoffOldest = new Date(now.getTime() - 168 * HOUR_MS);
  const cutoffNewest = new Date(now.getTime() - 48 * HOUR_MS);
  const batchSize = Number(pageSize) > 0 ? Math.min(200, Number(pageSize)) : Math.min(200, Math.max(limit * 2, 50));
  const sender = sendMessage || require('./messaging/send-customer-message').sendCustomerMessage;
  const counts = { checked: 0, sent: 0, stopped: 0, deferred: 0 };
  let offset = 0;

  while (counts.sent < limit) {
    const leads = await dbh('leads')
      .whereNull('deleted_at')
      .whereNull('converted_at')
      .whereNull('estimate_id')
      .whereIn('status', UNQUOTED_OPEN_STATUSES)
      .whereRaw('COALESCE(is_commercial, false) = false')
      .whereRaw("NULLIF(TRIM(COALESCE(phone, '')), '') IS NOT NULL")
      .whereRaw("NULLIF(TRIM(COALESCE(email, '')), '') IS NULL")
      .where('created_at', '>=', cutoffOldest)
      .where('created_at', '<=', cutoffNewest)
      .whereNotExists(function step2Done() {
        this.select(dbh.raw('1'))
          .from('new_lead_phone_drip_sends as s2')
          .whereRaw('s2.lead_id = leads.id')
          .where('s2.step', 2);
      })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .offset(offset)
      .limit(batchSize)
      .select(
        'id', 'first_name', 'phone', 'email', 'customer_id', 'estimate_id',
        'converted_at', 'is_commercial', 'status', 'deleted_at', 'created_at',
        'twilio_call_sid', 'twilio_message_sid', 'lead_type', 'extracted_data',
      );

    if (!leads.length) break;

    for (const lead of leads) {
      counts.checked += 1;
      try {
        const outcome = await processOnePhoneLead(dbh, lead, { now, sender });
        if (outcome in counts) counts[outcome] += 1;
      } catch (err) {
        counts.deferred += 1;
        logger.warn(`[new-lead-phone-sms-drip] deferred lead ${lead.id}: ${err?.code || err?.name || 'error'}`);
      }
      if (counts.sent >= limit) break;
    }

    if (leads.length < batchSize) break;
    offset += batchSize;
  }

  return { skipped: null, ...counts };
}

module.exports = {
  STEP_1_ACTIVITY,
  STEP_2_ACTIVITY,
  DRIP_ENTRY_POINT,
  UNQUOTED_OPEN_STATUSES,
  buildPhoneDripCopy,
  isWithinSendHoursET,
  pickDueStep,
  verifyLeadSmsConsent,
  leadShouldStop,
  processPhoneOnlyLeadSmsDrip,
};
