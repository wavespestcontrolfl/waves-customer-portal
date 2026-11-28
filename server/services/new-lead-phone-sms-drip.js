'use strict';

/**
 * Extended New-Lead Phone-Only Residential SMS Follow-Up Drip (owner 2026-11-27 "ok go", Decision 2).
 *
 * Ships 100% DARK behind GATE_NEW_LEAD_DRIP_EXTENDED (`newLeadDripExtendedLive()`, strict `=== 'true'`,
 * unset by default). While off, the scheduler exits before taking any DB lock and
 * `processPhoneOnlyLeadSmsDrip()` returns immediately with zero queries and zero sends.
 *
 * Audience: unquoted open residential leads (`status IN ('new', 'contacted')`, `is_commercial IS NOT TRUE`)
 * with a phone number, NO email address, explicit stored promotional SMS opt-in bound to that exact destination
 * phone (`customers` + `notification_prefs`: canonical E.164 equality + complete `phoneMatchDigits`,
 * `marketing_offers === true`, explicit `'sms'` or `'both'` `marketing_channel` — null/blank defaults to email),
 * no explicit marketing opt-out across linked/matching customers, no linked/created/sent estimate (including
 * phone-matched customers and standalone `customer_phone` estimates), no booked visit, not a paying
 * customer, and no prior SMS engagement (including Leads-page `lead_outreach` and Lead Response Agent `lead_response`).
 *
 * Durability & safety:
 *   - Durable pre-dispatch claim in `new_lead_phone_drip_sends (lead_id, step)` before calling Twilio
 *     (deleted ONLY on definitive `deliveryOutcome === 'not_sent'`; `'uncertain'` stays locked).
 *   - Holds `lockCustomerComms` (sorted matched customer IDs) then `lockSmsPhone` inside `withSmsHandoff`
 *     through final suppression/consent/stop/window rechecks (`providerPreSendCheck` reading through `dbi`
 *     with current clock) and Twilio dispatch.
 *   - Uses `purpose: 'lead_promotional_followup'` (`requireConsent: 'marketing'`, `prefsColumn: 'marketing_offers'`)
 *     and passes the consenting customer ID (if any) so `loadContactState` finds formatted customer phones.
 *   - Keyset-paginates using PostgreSQL `created_at::text` so microseconds are never truncated.
 *   - Brand copy = "Waves" ONLY, zero owner name, approved "per application" unit, STOP on Touch 1, 8 AM–8 PM ET.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const { toE164, phoneMatchDigits } = require('../utils/phone');
const { lockCustomerComms, lockSmsPhone } = require('../utils/customer-comms-lock');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { NON_LIVE_APPOINTMENT_STATUSES } = require('./estimate-conversion-guard');
const { HUMAN_REPLY_TYPES, SENT_STATUSES } = require('./sms-suggest-mode');
const { callVetoesForNumber } = require('./messaging/auto-text-holds');

const STEP_1_ACTIVITY = 'phone_drip_sms_step_1';
const STEP_2_ACTIVITY = 'phone_drip_sms_step_2';
const DRIP_ENTRY_POINT = 'new_lead_phone_sms_drip';
const DRIP_PURPOSE = 'lead_promotional_followup';
const UNQUOTED_OPEN_STATUSES = Object.freeze(['new', 'contacted']);
const QUIET_START_HOUR_ET = 8;
const QUIET_END_HOUR_ET = 20;
const HOUR_MS = 3600 * 1000;
const ENGAGEMENT_OUTBOUND_TYPES = [
  ...HUMAN_REPLY_TYPES,
  'lead_outreach',
  'lead_response',
  'voicemail_quote_link',
  'missed_call_text_back',
  'call_booking_link_text',
  'auto_reply',
  'ai_autosent',
  'ai_gratitude',
];

const LEAD_SELECT_COLS = Object.freeze([
  'id', 'first_name', 'phone', 'email', 'customer_id', 'estimate_id',
  'converted_at', 'is_commercial', 'is_residential', 'status', 'deleted_at', 'created_at',
  'twilio_call_sid', 'twilio_message_sid', 'lead_type',
]);

function firstNameOrDefault(lead) {
  const raw = String(lead?.first_name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'-]{1,24}$/.test(raw) ? raw : null;
}

function buildPhoneDripCopy(step, lead) {
  const name = firstNameOrDefault(lead);
  const hi = name ? `Hi ${name}, it's Waves.` : "Hi, it's Waves.";
  if (step === 1) {
    return `${hi} Most homes here run $105-$120 per application for quarterly pest control with no contract. Reply with your address if you'd like your exact price. Reply STOP to opt out.`;
  }
  return `${hi} Quick check: are you seeing ants, roaches, lawn issues, or something else? Reply with one word and we'll let you know the best fix.`;
}

function isWithinSendHoursET(now = new Date()) {
  const { hour } = etParts(now);
  return hour >= QUIET_START_HOUR_ET && hour < QUIET_END_HOUR_ET;
}

function isEligibleUnquotedLeadRow(lead) {
  if (!lead || lead.deleted_at || lead.is_commercial === true || lead.is_residential === false) return false;
  if (lead.converted_at || lead.estimate_id) return false;
  if (!UNQUOTED_OPEN_STATUSES.includes(lead.status)) return false;
  return Boolean(String(lead.phone || '').trim()) && !String(lead.email || '').trim();
}

function canonicalE164(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const e164 = toE164(text);
  if (!/^\+[1-9]\d{7,14}$/.test(e164 || '')) return null;
  const digits = text.replace(/\D/g, '');
  if (!text.startsWith('+') && !/^(?:1)?\d{10}$/.test(digits)) return null;
  return e164;
}

function phonesShareIdentity(phoneA, phoneB) {
  const a = canonicalE164(phoneA);
  const b = canonicalE164(phoneB);
  return Boolean(a && b && a === b);
}

/**
 * Portal treats a blank/null `marketing_channel` as email-only default.
 * Customer-based promotional SMS requires explicit `'sms'` or `'both'`.
 */
function isSmsCapableMarketingChannel(channel) {
  const normalized = String(channel || '').trim().toLowerCase();
  return normalized === 'sms' || normalized === 'both';
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
  if (step1.destination_phone && !phonesShareIdentity(step1.destination_phone, lead.phone)) return null;
  const step1At = new Date(step1.sent_at || step1.created_at).getTime();
  if (!Number.isFinite(step1At)) return null;
  const sinceStep1Hours = (now.getTime() - step1At) / HOUR_MS;
  return ageHours >= 120 && ageHours <= 168 && sinceStep1Hours >= 48 ? 2 : null;
}

/**
 * Loads all active customer/notification_prefs rows linked by `lead.customer_id` OR matching
 * the lead's exact destination phone identity, evaluates stored promotional SMS consent, and returns
 * `{ consentBasis, consentingCustomerId, matchedCustomerIds }`.
 */
async function resolveLeadPromotionalConsent(conn, lead, matchDigitsInput = null) {
  const leadE164 = canonicalE164(lead?.phone);
  const matchDigits = Array.isArray(matchDigitsInput) && matchDigitsInput.length
    ? matchDigitsInput
    : phoneMatchDigits(lead?.phone);
  if (!leadE164 || !matchDigits.length) {
    return { consentBasis: null, consentingCustomerId: null, matchedCustomerIds: [] };
  }

  const prefRows = await conn('customers as c')
    .leftJoin('notification_prefs as np', 'np.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    .where((w) => {
      if (lead.customer_id) w.where('c.id', lead.customer_id);
      w.orWhereRaw("REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits]);
    })
    .select(
      'c.id', 'c.phone',
      'np.sms_enabled', 'np.marketing_offers', 'np.marketing_channel', 'np.marketing_sms_consent_phone',
    );

  const rows = (Array.isArray(prefRows) ? prefRows : []).filter((r) => (
    (lead.customer_id && String(r.id) === String(lead.customer_id)) || phonesShareIdentity(r.phone, leadE164)
  ));
  const matchedCustomerIds = [...new Set([lead.customer_id, ...rows.map((r) => r.id)].filter(Boolean))];
  if (rows.some((r) => r.sms_enabled === false || r.marketing_offers === false || String(r.marketing_channel || '').trim().toLowerCase() === 'email')) {
    return { consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  const matchedOptedInCustomer = rows.find((r) => (
    r.marketing_offers === true
    && isSmsCapableMarketingChannel(r.marketing_channel)
    && phonesShareIdentity(r.phone, leadE164)
    && phonesShareIdentity(r.marketing_sms_consent_phone, leadE164)
  ));
  if (matchedOptedInCustomer) {
    return {
      consentBasis: { status: 'opted_in', source: 'customer_notification_prefs', phoneBound: true },
      consentingCustomerId: matchedOptedInCustomer.id,
      matchedCustomerIds,
    };
  }

  return { consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
}

async function verifyLeadSmsConsent(conn, lead, matchDigitsInput = null) {
  const { consentBasis } = await resolveLeadPromotionalConsent(conn, lead, matchDigitsInput);
  return consentBasis;
}

async function hasBlockingEstimate(conn, lead, customerIds, matchDigits) {
  const leadE164 = canonicalE164(lead?.phone);
  const rows = await conn('estimates')
    .where((w) => {
      w.whereRaw("estimate_data->>'lead_id' = ?", [String(lead.id)]);
      if (customerIds.length) {
        w.orWhere((c) => c.whereIn('customer_id', customerIds)
          .andWhere((when) => when.where('created_at', '>=', lead.created_at).orWhere('sent_at', '>=', lead.created_at)));
      }
      if (matchDigits.length) {
        w.orWhere((p) => p.whereRaw("REGEXP_REPLACE(COALESCE(customer_phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits])
          .andWhere((when) => when.where('created_at', '>=', lead.created_at).orWhere('sent_at', '>=', lead.created_at)));
      }
    })
    .select('id', 'customer_id', 'customer_phone', 'estimate_data');

  const list = Array.isArray(rows) ? rows : [];
  return list.some((est) => {
    const linkedLeadId = est.estimate_data && typeof est.estimate_data === 'object' ? est.estimate_data.lead_id : null;
    if (String(linkedLeadId || '') === String(lead.id)) return true;
    if (est.customer_id && customerIds.some((cid) => String(cid) === String(est.customer_id))) return true;
    if (!est.customer_phone && !est.customer_id && !est.estimate_data) return true;
    return Boolean(leadE164 && est.customer_phone && phonesShareIdentity(est.customer_phone, leadE164));
  });
}

async function hasCustomerConversion(conn, customerIds) {
  if (!customerIds.length) return null;
  const booked = await conn('scheduled_services')
    .whereIn('customer_id', customerIds)
    .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
    .first('id');
  if (booked) return 'visit_booked';

  const paid = await conn('invoices').whereIn('customer_id', customerIds).where({ status: 'paid' }).first('id');
  if (paid) return 'paying_customer';

  const cust = await conn('customers').whereIn('id', customerIds).whereIn('pipeline_stage', CUSTOMER_STAGES).first('id');
  if (cust) return 'existing_customer';
  return null;
}

async function hasOverlappingPhoneDrip(conn, leadId, leadE164, matchDigits, now = new Date()) {
  const activeWindowStart = new Date(now.getTime() - 168 * HOUR_MS);
  const rows = await conn('new_lead_phone_drip_sends as s')
    .join('leads as l', 'l.id', 's.lead_id')
    .whereNot('s.lead_id', leadId)
    .whereIn('s.status', ['claimed', 'sent', 'uncertain'])
    .whereRaw("REGEXP_REPLACE(COALESCE(s.destination_phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits])
    .whereNull('l.deleted_at')
    .whereNull('l.converted_at')
    .whereNull('l.estimate_id')
    .whereIn('l.status', UNQUOTED_OPEN_STATUSES)
    .where('l.created_at', '>=', activeWindowStart)
    .select('s.id', 's.destination_phone');
  return (Array.isArray(rows) ? rows : []).some((r) => phonesShareIdentity(r.destination_phone, leadE164));
}

async function leadShouldStop(conn, lead, { now = new Date(), checkCallVetoes = callVetoesForNumber } = {}) {
  const leadE164 = canonicalE164(lead?.phone);
  const matchDigits = phoneMatchDigits(lead?.phone);
  // US/NANP only: guarantees shared sender normalizeRecipient preserves the exact consented E.164 destination.
  if (!leadE164 || !/^\+1\d{10}$/.test(leadE164) || !matchDigits.length) {
    return { stop: 'invalid_phone', consentBasis: null, consentingCustomerId: null, matchedCustomerIds: [] };
  }

  const { consentBasis, consentingCustomerId, matchedCustomerIds } = await resolveLeadPromotionalConsent(conn, lead, matchDigits);
  if (!consentBasis) {
    return { stop: 'no_recorded_consent', consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  if (await hasBlockingEstimate(conn, lead, matchedCustomerIds, matchDigits)) {
    return { stop: 'has_estimate', consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  const converted = await hasCustomerConversion(conn, matchedCustomerIds);
  if (converted) {
    return { stop: converted, consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  if (await hasOverlappingPhoneDrip(conn, lead.id, leadE164, matchDigits, now)) {
    return { stop: 'phone_already_in_drip', consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  const recentSms = await conn('sms_log')
    .where('created_at', '>=', lead.created_at)
    .where((w) => {
      if (lead.twilio_message_sid) w.whereRaw("COALESCE(twilio_sid, '') <> ?", [lead.twilio_message_sid]);
    })
    .where((w) => {
      w.whereRaw("REGEXP_REPLACE(COALESCE(from_phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits])
        .orWhereRaw("REGEXP_REPLACE(COALESCE(to_phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits]);
    })
    .where((w) => {
      w.where('direction', 'inbound')
        .orWhere((o) => o.where('direction', 'outbound')
          .whereIn('message_type', ENGAGEMENT_OUTBOUND_TYPES)
          .whereIn('status', [...SENT_STATUSES, 'scheduled', 'sending']));
    })
    .first('id');
  if (recentSms) {
    return { stop: 'already_engaged', consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  const phoneCandidates = [...new Set([lead.phone, leadE164].filter(Boolean))];
  const suppressed = await conn('messaging_suppression')
    .whereIn('phone', phoneCandidates)
    .where({ active: true })
    .first('phone');
  if (suppressed) {
    return { stop: 'opted_out', consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  const vetoes = await checkCallVetoes(leadE164, { dbi: conn });
  if (vetoes?.doNotContact || vetoes?.smsDeclined) {
    return { stop: 'call_veto', consentBasis: null, consentingCustomerId: null, matchedCustomerIds };
  }

  return { stop: null, consentBasis, consentingCustomerId, matchedCustomerIds };
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
  if (outcome === 'stopped') {
    await dbh('new_lead_phone_drip_sends').where({ id: claimId }).update({ status: 'stopped' });
    return;
  }
  await dbh('new_lead_phone_drip_sends').where({ id: claimId }).update({ status: 'uncertain' });
}

/**
 * Lock order contract (`customer-comms-lock.js`): acquire sorted `customer-comms:<id>`
 * locks for every linked/phone-matched customer BEFORE `lockSmsPhone`, serializing
 * against concurrent notification_prefs opt-outs and STOP/START writers.
 */
function buildPhoneDripHandoff(dbh, { customerIds = [], phone }) {
  const sortedIds = [...new Set(customerIds.filter(Boolean).map(String))].sort();
  return (dispatch) => dbh.transaction(async (trx) => {
    for (const cid of sortedIds) await lockCustomerComms(trx, cid);
    await lockSmsPhone(trx, phone);
    return dispatch(trx);
  });
}

async function verifyLockedDripState(conn, {
  leadId, expectedPhone, claimId, lockedSet, nowFn, checkCallVetoes,
}) {
  const now = nowFn();
  // Lock order: lockCustomerComms -> lockSmsPhone -> customers FOR NO KEY UPDATE -> leads FOR NO KEY UPDATE.
  const lockedIds = [...lockedSet].sort();
  if (lockedIds.length) {
    const cq = conn('customers').whereIn('id', lockedIds).orderBy('id', 'asc');
    await (typeof cq.forNoKeyUpdate === 'function' ? cq.forNoKeyUpdate() : cq).select('id');
  }
  const leadQ = conn('leads').where({ id: leadId });
  const freshLead = await (typeof leadQ.forNoKeyUpdate === 'function' ? leadQ.forNoKeyUpdate() : leadQ).first(...LEAD_SELECT_COLS);
  if (!isEligibleUnquotedLeadRow(freshLead)) {
    return { ok: false, code: 'LEAD_DRIP_INELIGIBLE', reason: 'Lead is no longer an open unquoted phone-only residential lead' };
  }
  if (!phonesShareIdentity(freshLead.phone, expectedPhone)) {
    return { ok: false, code: 'LEAD_PHONE_CHANGED', reason: 'Lead phone number changed before SMS handoff' };
  }
  const check = await leadShouldStop(conn, freshLead, { now, ...(checkCallVetoes ? { checkCallVetoes } : {}) });
  if (check.stop) {
    return { ok: false, code: `LEAD_DRIP_STOP_${check.stop.toUpperCase()}`, reason: `Lead stopped at handoff (${check.stop})` };
  }
  if ((check.matchedCustomerIds || []).some((cid) => !lockedSet.has(String(cid)))) {
    return { ok: false, code: 'LEAD_DRIP_LOCK_SET_CHANGED', reason: 'Matched customer set changed before SMS handoff', retryable: true };
  }
  const ownedClaim = claimId
    ? await conn('new_lead_phone_drip_sends').where({ id: claimId }).first('status')
    : null;
  if (!ownedClaim || ownedClaim.status !== 'claimed') {
    return { ok: false, code: 'LEAD_DRIP_CLAIM_NOT_OWNED', reason: 'Drip claim missing or already settled' };
  }
  // Re-check 8 AM–8 PM ET right before synchronous provider dispatch after lock wait + DB reads.
  if (!isWithinSendHoursET(nowFn())) {
    return { ok: false, code: 'OUTSIDE_DRIP_SEND_HOURS', reason: 'Outside 8 AM–8 PM ET drip send hours after handoff checks', retryable: true };
  }
  return { ok: true };
}

function buildHandoffPreSendCheck({ dbh, leadId, expectedPhone, claimId, clock, checkCallVetoes, lockedCustomerIds = [] }) {
  const nowFn = clock || (() => new Date());
  const lockedSet = new Set((lockedCustomerIds || []).filter(Boolean).map(String));
  return async ({ dbi, database } = {}) => {
    if (!isWithinSendHoursET(nowFn())) {
      return { ok: false, code: 'OUTSIDE_DRIP_SEND_HOURS', reason: 'Outside 8 AM–8 PM ET drip send hours at handoff', retryable: true };
    }
    try {
      return await verifyLockedDripState(dbi || database || dbh, {
        leadId, expectedPhone, claimId, lockedSet, nowFn, checkCallVetoes,
      });
    } catch (err) {
      logger.warn(`[new-lead-phone-sms-drip] handoff pre-send check read failed for lead ${leadId}: ${err?.code || err?.name || 'error'}`);
      return {
        ok: false,
        code: 'LEAD_DRIP_HANDOFF_READ_FAILED',
        reason: 'Transient DB error during lead drip handoff check',
        retryable: true,
      };
    }
  };
}

async function settleDispatchResult(dbh, { claimId, leadId, step, activityType, result }) {
  if (result?.deliveryOutcome === 'accepted') {
    await settleDripClaim(dbh, { claimId, leadId, step, activityType, outcome: 'sent', providerMessageId: result?.providerMessageId });
    return 'sent';
  }
  if (result?.deliveryOutcome === 'not_sent') {
    const retryable = result?.retryable === true || result?.code === 'CONSENT_LOOKUP_FAILED';
    await settleDripClaim(dbh, { claimId, leadId, step, activityType, outcome: retryable ? 'release' : 'stopped' });
    return retryable ? 'deferred' : 'stopped';
  }
  await settleDripClaim(dbh, { claimId, leadId, step, activityType, outcome: 'uncertain' });
  return 'deferred';
}

async function processOnePhoneLead(dbh, lead, { now, clock, sender, checkCallVetoes }) {
  const claims = await dbh('new_lead_phone_drip_sends')
    .where({ lead_id: lead.id })
    .select('step', 'status', 'sent_at', 'claimed_at', 'destination_phone');

  const step = pickDueStep(lead, claims, now);
  if (!step) return 'skip';

  const stopCheck = await leadShouldStop(
    dbh,
    lead,
    { now, ...(checkCallVetoes ? { checkCallVetoes } : {}) },
  );
  if (stopCheck.stop || !stopCheck.consentingCustomerId) return 'stopped';

  const destinationPhone = canonicalE164(lead.phone);
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
      purpose: DRIP_PURPOSE,
      customerId: stopCheck.consentingCustomerId,
      leadId: lead.id,
      identityTrustLevel: 'phone_matches_customer',
      consentBasis: stopCheck.consentBasis,
      entryPoint: DRIP_ENTRY_POINT,
      metadata: { original_message_type: activityType, lead_id: lead.id, drip_step: step, delivery_key: deliveryKey },
      withSmsHandoff: buildPhoneDripHandoff(dbh, { customerIds: stopCheck.matchedCustomerIds, phone: destinationPhone }),
      providerPreSendCheck: buildHandoffPreSendCheck({
        dbh,
        leadId: lead.id,
        expectedPhone: destinationPhone,
        claimId,
        clock,
        checkCallVetoes,
        lockedCustomerIds: stopCheck.matchedCustomerIds,
      }),
    });
  } catch (err) {
    const definitive = err?.providerOutcome?.deliveryOutcome === 'not_sent';
    await settleDripClaim(dbh, { claimId, leadId: lead.id, step, activityType, outcome: definitive ? 'release' : 'uncertain' });
    throw err;
  }

  return settleDispatchResult(dbh, { claimId, leadId: lead.id, step, activityType, result });
}

async function fetchPhoneDripLeadPage(dbh, { cutoffOldest, cutoffNewest, cursor, batchSize }) {
  let q = dbh('leads')
    .whereNull('deleted_at')
    .whereNull('converted_at')
    .whereNull('estimate_id')
    .whereIn('status', UNQUOTED_OPEN_STATUSES)
    .whereRaw('COALESCE(is_commercial, false) = false')
    .whereRaw('COALESCE(is_residential, true) = true')
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
    .limit(batchSize);
  if (cursor) {
    q = q.whereRaw('(created_at, id) > (?::timestamptz, ?)', [cursor.created_at, cursor.id]);
  }
  return q.select(...LEAD_SELECT_COLS, dbh.raw('created_at::text as cursor_created_at'));
}

async function processPhoneOnlyLeadSmsDrip(opts) {
  const cfg = {
    now: new Date(),
    limit: 25,
    pageSize: null,
    dbh: db,
    gates: null,
    sendMessage: null,
    clock: null,
    checkCallVetoes: null,
    ...opts,
  };
  const featureGates = cfg.gates || require('../config/feature-gates');
  if (featureGates.newLeadDripExtendedLive?.() !== true) {
    return { skipped: 'gate_off', checked: 0, sent: 0, stopped: 0, deferred: 0 };
  }
  if (!isWithinSendHoursET(cfg.now)) {
    return { skipped: 'quiet_hours', checked: 0, sent: 0, stopped: 0, deferred: 0 };
  }

  const cutoffOldest = new Date(cfg.now.getTime() - 168 * HOUR_MS);
  const cutoffNewest = new Date(cfg.now.getTime() - 48 * HOUR_MS);
  const batchSize = Math.min(200, Number(cfg.pageSize) > 0 ? Number(cfg.pageSize) : Math.max(cfg.limit * 2, 50));
  const sender = cfg.sendMessage || require('./messaging/send-customer-message').sendCustomerMessage;
  const clock = cfg.clock || (() => new Date());
  const counts = { checked: 0, sent: 0, stopped: 0, deferred: 0 };
  let cursor = null;

  while (counts.sent < cfg.limit && isWithinSendHoursET(clock())) {
    const leads = await fetchPhoneDripLeadPage(cfg.dbh, { cutoffOldest, cutoffNewest, cursor, batchSize });
    if (!leads.length) break;

    for (const lead of leads) {
      if (counts.sent >= cfg.limit || !isWithinSendHoursET(clock())) break;
      counts.checked += 1;
      try {
        const outcome = await processOnePhoneLead(cfg.dbh, lead, {
          now: cfg.now, clock, sender, checkCallVetoes: cfg.checkCallVetoes,
        });
        if (outcome in counts) counts[outcome] += 1;
      } catch (err) {
        counts.deferred += 1;
        logger.warn(`[new-lead-phone-sms-drip] deferred lead ${lead.id}: ${err?.code || 'error'}`);
      }
    }

    if (leads.length < batchSize) break;
    const last = leads[leads.length - 1];
    cursor = { created_at: last.cursor_created_at || last.created_at, id: last.id };
  }

  return { skipped: null, ...counts };
}

module.exports = {
  STEP_1_ACTIVITY,
  STEP_2_ACTIVITY,
  DRIP_ENTRY_POINT,
  DRIP_PURPOSE,
  UNQUOTED_OPEN_STATUSES,
  ENGAGEMENT_OUTBOUND_TYPES,
  buildPhoneDripCopy,
  isWithinSendHoursET,
  canonicalE164,
  phonesShareIdentity,
  isSmsCapableMarketingChannel,
  pickDueStep,
  resolveLeadPromotionalConsent,
  verifyLeadSmsConsent,
  leadShouldStop,
  buildPhoneDripHandoff,
  processPhoneOnlyLeadSmsDrip,
};
