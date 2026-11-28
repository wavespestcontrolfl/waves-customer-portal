'use strict';

/**
 * Extended New-Lead Phone-Only Residential SMS Follow-Up Drip (owner 2026-11-27 "ok go", Decision 2).
 *
 * Ships 100% DARK behind GATE_NEW_LEAD_DRIP_EXTENDED (`newLeadDripExtendedLive()`, strict `=== 'true'`,
 * unset by default). While off, `processPhoneOnlyLeadSmsDrip()` returns immediately with zero queries
 * and zero sends.
 *
 * Audience: open residential leads (`is_commercial IS NOT TRUE`) that have a phone number and NO email
 * address, no linked/recent estimate, no booked visit, not a paying customer, and no inbound/outbound
 * human conversation since creation.
 *
 * Touches (brand copy = "Waves" ONLY, zero owner name, STOP opt-out on Touch 1, 8 AM–8 PM ET only):
 *   - Touch 1 (Day 2, 48h–96h after lead creation)
 *   - Touch 2 (Day 5, 120h–168h after lead creation, >=48h after Touch 1)
 *
 * Safety: fail-closed on suppression lookup error (never sends when opt-out status is uncertain),
 * routes through canonical `sendCustomerMessage` (`audience: 'lead'`, `purpose: 'missed_call_followup'`,
 * `entryPoint: 'new_lead_phone_sms_drip'`), and stamps idempotent `lead_activities`
 * (`phone_drip_sms_step_1` / `phone_drip_sms_step_2`) plus checks `sms_log` history so a lead can
 * never be double-texted even across retries or uncertain provider outcomes.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const { toE164 } = require('../utils/phone');
const { applyOpenLeadPredicate, isOpenLeadRow } = require('./lead-statuses');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { NON_LIVE_APPOINTMENT_STATUSES } = require('./estimate-conversion-guard');
const { HUMAN_REPLY_TYPES, SENT_STATUSES } = require('./sms-suggest-mode');

const STEP_1_ACTIVITY = 'phone_drip_sms_step_1';
const STEP_2_ACTIVITY = 'phone_drip_sms_step_2';
const DRIP_ENTRY_POINT = 'new_lead_phone_sms_drip';
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

function pickDueStep(lead, sentActivities, now = new Date()) {
  if (!lead || lead.deleted_at || lead.is_commercial === true || !isOpenLeadRow(lead)) return null;
  if (!String(lead.phone || '').trim() || String(lead.email || '').trim()) return null;
  if (lead.converted_at || lead.estimate_id) return null;

  const createdMs = new Date(lead.created_at).getTime();
  if (!Number.isFinite(createdMs)) return null;
  const ageHours = (now.getTime() - createdMs) / HOUR_MS;

  const step1 = sentActivities.find((a) => a.activity_type === STEP_1_ACTIVITY);
  const step2 = sentActivities.find((a) => a.activity_type === STEP_2_ACTIVITY);
  if (step2) return null;

  if (!step1) {
    return ageHours >= 48 && ageHours <= 96 ? 1 : null;
  }
  const sinceStep1Hours = (now.getTime() - new Date(step1.created_at).getTime()) / HOUR_MS;
  return ageHours >= 120 && ageHours <= 168 && sinceStep1Hours >= 48 ? 2 : null;
}

async function leadShouldStop(conn, lead, step) {
  const phoneDigits = String(lead.phone || '').replace(/\D/g, '').slice(-10);
  if (phoneDigits.length < 10) return 'invalid_phone';

  const activityType = step === 1 ? STEP_1_ACTIVITY : STEP_2_ACTIVITY;
  const priorDripSms = await conn('sms_log')
    .where('direction', 'outbound')
    .whereRaw("metadata->>'lead_id' = ?", [String(lead.id)])
    .whereRaw("metadata->>'original_message_type' = ?", [activityType])
    .whereIn('status', [...SENT_STATUSES, 'scheduled', 'sending'])
    .first('id');
  if (priorDripSms) return 'already_sent';

  const est = await conn('estimates')
    .where((w) => {
      w.whereRaw("estimate_data->>'lead_id' = ?", [String(lead.id)]);
      if (lead.customer_id) {
        w.orWhere((c) => c.where('customer_id', lead.customer_id).andWhere('created_at', '>=', lead.created_at));
      }
    })
    .first('id');
  if (est) return 'has_estimate';

  if (lead.customer_id) {
    const booked = await conn('scheduled_services')
      .where({ customer_id: lead.customer_id })
      .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
      .first('id');
    if (booked) return 'visit_booked';

    const paid = await conn('invoices').where({ customer_id: lead.customer_id, status: 'paid' }).first('id');
    if (paid) return 'paying_customer';

    const cust = await conn('customers').where({ id: lead.customer_id }).first('pipeline_stage');
    if (cust && CUSTOMER_STAGES.includes(cust.pipeline_stage)) return 'existing_customer';
  }

  const recentSms = await conn('sms_log')
    .where('created_at', '>=', lead.created_at)
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
  if (recentSms) return 'already_engaged';

  const phoneCandidates = [...new Set([lead.phone, toE164(lead.phone)].filter(Boolean))];
  const suppressed = await conn('messaging_suppression')
    .whereIn('phone', phoneCandidates)
    .where({ active: true })
    .first('phone');
  if (suppressed) return 'opted_out';

  return null;
}

async function recordDripActivity(dbh, leadId, activityType, step, deliveryOutcome) {
  const description = deliveryOutcome === 'uncertain'
    ? `Phone-only lead drip step ${step} delivery uncertain (not retried)`
    : `Phone-only lead drip step ${step} sent`;
  await dbh('lead_activities').insert({
    lead_id: leadId,
    activity_type: activityType,
    description,
    performed_by: 'System',
    metadata: JSON.stringify({ step, channel: 'sms', delivery_outcome: deliveryOutcome }),
  });
}

async function processOnePhoneLead(dbh, lead, { now, sender }) {
  const sentActivities = await dbh('lead_activities')
    .where({ lead_id: lead.id })
    .whereIn('activity_type', [STEP_1_ACTIVITY, STEP_2_ACTIVITY])
    .select('activity_type', 'created_at');

  const step = pickDueStep(lead, sentActivities, now);
  if (!step) return 'skip';

  const stopReason = await leadShouldStop(dbh, lead, step);
  if (stopReason) return 'stopped';

  const activityType = step === 1 ? STEP_1_ACTIVITY : STEP_2_ACTIVITY;
  const result = await sender({
    to: lead.phone,
    body: buildPhoneDripCopy(step, lead),
    channel: 'sms',
    audience: 'lead',
    purpose: 'missed_call_followup',
    customerId: lead.customer_id || undefined,
    leadId: lead.id,
    identityTrustLevel: 'phone_provided_unverified',
    consentBasis: { status: 'transactional_allowed', source: DRIP_ENTRY_POINT },
    entryPoint: DRIP_ENTRY_POINT,
    metadata: { original_message_type: activityType, lead_id: lead.id, drip_step: step },
  });

  if (result?.deliveryOutcome === 'accepted' || result?.sent === true) {
    await recordDripActivity(dbh, lead.id, activityType, step, result?.deliveryOutcome || 'accepted');
    return 'sent';
  }
  if (result?.deliveryOutcome === 'uncertain') {
    await recordDripActivity(dbh, lead.id, activityType, step, 'uncertain');
    return 'deferred';
  }
  return result?.retryable === true ? 'deferred' : 'stopped';
}

async function processPhoneOnlyLeadSmsDrip({
  now = new Date(),
  limit = 25,
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
  const leads = await applyOpenLeadPredicate(
    dbh('leads')
      .whereNull('deleted_at')
      .whereNull('estimate_id')
      .whereRaw('COALESCE(is_commercial, false) = false')
      .whereRaw("NULLIF(TRIM(COALESCE(phone, '')), '') IS NOT NULL")
      .whereRaw("NULLIF(TRIM(COALESCE(email, '')), '') IS NULL")
      .where('created_at', '>=', cutoffOldest)
      .where('created_at', '<=', cutoffNewest),
  )
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('id', 'first_name', 'phone', 'email', 'customer_id', 'estimate_id', 'converted_at', 'is_commercial', 'status', 'deleted_at', 'created_at');

  const sender = sendMessage || require('./messaging/send-customer-message').sendCustomerMessage;
  const counts = { sent: 0, stopped: 0, deferred: 0 };

  for (const lead of leads) {
    try {
      const outcome = await processOnePhoneLead(dbh, lead, { now, sender });
      if (outcome in counts) counts[outcome] += 1;
    } catch (err) {
      counts.deferred += 1;
      logger.warn(`[new-lead-phone-sms-drip] deferred lead ${lead.id}: ${err?.code || err?.name || 'error'}`);
    }
  }

  return { skipped: null, checked: leads.length, ...counts };
}

module.exports = {
  STEP_1_ACTIVITY,
  STEP_2_ACTIVITY,
  DRIP_ENTRY_POINT,
  buildPhoneDripCopy,
  isWithinSendHoursET,
  pickDueStep,
  leadShouldStop,
  processPhoneOnlyLeadSmsDrip,
};
