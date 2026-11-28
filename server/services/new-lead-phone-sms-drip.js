'use strict';

/**
 * Extended New-Lead Phone-Only Residential SMS Follow-Up Drip (owner 2026-11-27 "ok go", Decision 2).
 *
 * Ships 100% DARK behind GATE_NEW_LEAD_DRIP_EXTENDED (`newLeadDripExtendedLive()`, strict `=== 'true'`,
 * unset by default). While off, the scheduler exits before taking any DB lock and
 * `processPhoneOnlyLeadSmsDrip()` returns immediately with zero queries and zero sends.
 *
 * Audience: unquoted open residential leads (`status IN ('new', 'contacted')`, `is_commercial IS NOT TRUE`)
 * with a phone number, NO email address, explicit promotional SMS opt-in bound to that exact destination
 * phone (complete phone identity via `phoneMatchDigits`, SMS-capable `marketing_channel`, or explicit
 * web-form `marketing_sms_opt_in === true` bound to submitted phone), no explicit marketing opt-out,
 * no linked/created/sent estimate (including any phone-matched customer), no booked visit, not a paying
 * customer, and no prior SMS engagement (including Leads-page `lead_outreach`).
 *
 * Durability & safety:
 *   - Durable pre-dispatch claim in `new_lead_phone_drip_sends (lead_id, step)` before calling Twilio
 *     (deleted ONLY on definitive `deliveryOutcome === 'not_sent'`; `'uncertain'` stays locked).
 *   - Holds the canonical phone lock (`withSmsHandoff`) through final suppression/consent/stop/window
 *     rechecks (`providerPreSendCheck` reading through `dbi` with current clock) and Twilio dispatch.
 *   - Uses `purpose: 'lead_promotional_followup'` (`requireConsent: 'marketing'`, `prefsColumn: 'marketing_offers'`).
 *   - Keyset-paginates using PostgreSQL `created_at::text` so microseconds are never truncated.
 *   - Brand copy = "Waves" ONLY, zero owner name, approved "per application" unit, STOP on Touch 1, 8 AM–8 PM ET.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const { toE164, phoneMatchDigits } = require('../utils/phone');
const { lockSmsPhone, withSmsConsentLock } = require('../utils/customer-comms-lock');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { NON_LIVE_APPOINTMENT_STATUSES } = require('./estimate-conversion-guard');
const { HUMAN_REPLY_TYPES, SENT_STATUSES } = require('./sms-suggest-mode');

const STEP_1_ACTIVITY = 'phone_drip_sms_step_1';
const STEP_2_ACTIVITY = 'phone_drip_sms_step_2';
const DRIP_ENTRY_POINT = 'new_lead_phone_sms_drip';
const DRIP_PURPOSE = 'lead_promotional_followup';
const UNQUOTED_OPEN_STATUSES = Object.freeze(['new', 'contacted']);
const CONSENTED_WEB_LEAD_TYPES = new Set(['form_submission', 'quote_wizard', 'website_chat']);
const QUIET_START_HOUR_ET = 8;
const QUIET_END_HOUR_ET = 20;
const HOUR_MS = 3600 * 1000;
const ENGAGEMENT_OUTBOUND_TYPES = [...HUMAN_REPLY_TYPES, 'lead_outreach', 'ai_autosent', 'ai_gratitude'];

const LEAD_SELECT_COLS = Object.freeze([
  'id', 'first_name', 'phone', 'email', 'customer_id', 'estimate_id',
  'converted_at', 'is_commercial', 'status', 'deleted_at', 'created_at',
  'twilio_call_sid', 'twilio_message_sid', 'lead_type', 'extracted_data',
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
  if (!lead || lead.deleted_at || lead.is_commercial === true) return false;
  if (lead.converted_at || lead.estimate_id) return false;
  if (!UNQUOTED_OPEN_STATUSES.includes(lead.status)) return false;
  return Boolean(String(lead.phone || '').trim()) && !String(lead.email || '').trim();
}

function phonesShareIdentity(phoneA, phoneB) {
  const a = phoneMatchDigits(phoneA);
  const b = phoneMatchDigits(phoneB);
  if (!a.length || !b.length) return false;
  return a.some((digits) => b.includes(digits));
}

function isSmsCapableMarketingChannel(channel) {
  const normalized = String(channel || '').trim().toLowerCase();
  return !normalized || normalized === 'sms' || normalized === 'both';
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
 * Loads all active customer/notification_prefs rows linked by `lead.customer_id` OR matching
 * the lead's exact destination phone identity (`phoneMatchDigits`), evaluates promotional SMS
 * consent, and returns `{ consentBasis, matchedCustomerIds }`.
 *
 * Rules:
 *   - Any linked or phone-matched customer with `sms_enabled=false`, `marketing_offers=false`,
 *     or `marketing_channel='email'` blocks promotional SMS immediately.
 *   - Customer opt-in requires `marketing_offers === true`, SMS-capable `marketing_channel`,
 *     and complete phone identity match against `lead.phone`.
 *   - Web-form opt-in requires `extracted.marketing_sms_opt_in === true` (generic transactional
 *     `sms_opt_in` does NOT qualify and an explicit `marketing_sms_opt_in === false` never passes)
 *     bound to the original submitted phone matching `lead.phone`.
 */
async function resolveLeadPromotionalConsent(conn, lead, matchDigitsInput = null) {
  const matchDigits = Array.isArray(matchDigitsInput) && matchDigitsInput.length
    ? matchDigitsInput
    : phoneMatchDigits(lead?.phone);
  if (!matchDigits.length) return { consentBasis: null, matchedCustomerIds: [] };

  const prefRows = await conn('customers as c')
    .leftJoin('notification_prefs as np', 'np.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    .where((w) => {
      if (lead.customer_id) w.where('c.id', lead.customer_id);
      w.orWhereRaw("REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits]);
    })
    .select('c.id', 'c.phone', 'np.sms_enabled', 'np.marketing_offers', 'np.marketing_channel');

  const rows = Array.isArray(prefRows) ? prefRows : [];
  const matchedCustomerIds = [...new Set([lead.customer_id, ...rows.map((r) => r.id)].filter(Boolean))];
  if (rows.some((r) => r.sms_enabled === false || r.marketing_offers === false || !isSmsCapableMarketingChannel(r.marketing_channel))) {
    return { consentBasis: null, matchedCustomerIds };
  }

  const matchedOptedInCustomer = rows.find((r) => (
    r.marketing_offers === true
    && isSmsCapableMarketingChannel(r.marketing_channel)
    && phonesShareIdentity(r.phone, lead.phone)
  ));
  if (matchedOptedInCustomer) {
    return {
      consentBasis: { status: 'opted_in', source: 'customer_notification_prefs', phoneBound: true },
      matchedCustomerIds,
    };
  }

  const extracted = parseExtractedData(lead.extracted_data);
  const webPromoOptIn = CONSENTED_WEB_LEAD_TYPES.has(lead.lead_type) && extracted.marketing_sms_opt_in === true;
  const submittedPhone = extracted.sms_consent_phone || extracted.submitted_phone || extracted.phone || null;
  if (webPromoOptIn && submittedPhone && phonesShareIdentity(submittedPhone, lead.phone)) {
    return {
      consentBasis: { status: 'opted_in', source: 'web_form_sms_opt_in', phoneBound: true },
      matchedCustomerIds,
    };
  }

  return { consentBasis: null, matchedCustomerIds };
}

async function verifyLeadSmsConsent(conn, lead, matchDigitsInput = null) {
  const { consentBasis } = await resolveLeadPromotionalConsent(conn, lead, matchDigitsInput);
  return consentBasis;
}

async function hasBlockingEstimate(conn, lead, customerIds) {
  const est = await conn('estimates')
    .where((w) => {
      w.whereRaw("estimate_data->>'lead_id' = ?", [String(lead.id)]);
      if (customerIds.length) {
        w.orWhere((c) => c.whereIn('customer_id', customerIds)
          .andWhere((when) => when.where('created_at', '>=', lead.created_at).orWhere('sent_at', '>=', lead.created_at)));
      }
    })
    .first('id');
  return Boolean(est);
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

async function leadShouldStop(conn, lead) {
  const matchDigits = phoneMatchDigits(lead?.phone);
  if (!matchDigits.length) return { stop: 'invalid_phone', consentBasis: null };

  const { consentBasis, matchedCustomerIds } = await resolveLeadPromotionalConsent(conn, lead, matchDigits);
  if (!consentBasis) return { stop: 'no_recorded_consent', consentBasis: null };

  if (await hasBlockingEstimate(conn, lead, matchedCustomerIds)) return { stop: 'has_estimate', consentBasis: null };

  const converted = await hasCustomerConversion(conn, matchedCustomerIds);
  if (converted) return { stop: converted, consentBasis: null };

  // Match complete phone identity (`phoneMatchDigits`) so domestic and international numbers
  // sharing a last-10 suffix never collide and international replies are never missed.
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

function buildPhoneDripHandoff(dbh, { customerId, phone }) {
  return (dispatch) => {
    if (customerId) {
      return withSmsConsentLock(dbh, { phone, customerId }, dispatch);
    }
    return dbh.transaction(async (trx) => {
      await lockSmsPhone(trx, phone);
      return dispatch(trx);
    });
  };
}

function buildHandoffPreSendCheck({ dbh, leadId, expectedPhone, step, clock }) {
  const nowFn = clock || (() => new Date());
  return async ({ dbi, database } = {}) => {
    if (!isWithinSendHoursET(nowFn())) {
      return { ok: false, code: 'OUTSIDE_DRIP_SEND_HOURS', reason: 'Outside 8 AM–8 PM ET drip send hours at handoff', retryable: true };
    }
    const conn = dbi || database || dbh;
    const freshLead = await conn('leads').where({ id: leadId }).first(...LEAD_SELECT_COLS);
    if (!isEligibleUnquotedLeadRow(freshLead)) {
      return { ok: false, code: 'LEAD_DRIP_INELIGIBLE', reason: 'Lead is no longer an open unquoted phone-only residential lead' };
    }
    if (!phonesShareIdentity(freshLead.phone, expectedPhone)) {
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

async function processOnePhoneLead(dbh, lead, { now, clock, sender }) {
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
      purpose: DRIP_PURPOSE,
      customerId: lead.customer_id || undefined,
      leadId: lead.id,
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis,
      entryPoint: DRIP_ENTRY_POINT,
      metadata: { original_message_type: activityType, lead_id: lead.id, drip_step: step, delivery_key: deliveryKey },
      withSmsHandoff: buildPhoneDripHandoff(dbh, { customerId: lead.customer_id, phone: destinationPhone }),
      providerPreSendCheck: buildHandoffPreSendCheck({ dbh, leadId: lead.id, expectedPhone: destinationPhone, step, clock }),
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

async function fetchPhoneDripLeadPage(dbh, { cutoffOldest, cutoffNewest, cursor, batchSize }) {
  let q = dbh('leads')
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
        const outcome = await processOnePhoneLead(cfg.dbh, lead, { now: cfg.now, clock, sender });
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
  phonesShareIdentity,
  isSmsCapableMarketingChannel,
  pickDueStep,
  resolveLeadPromotionalConsent,
  verifyLeadSmsConsent,
  leadShouldStop,
  buildPhoneDripHandoff,
  processPhoneOnlyLeadSmsDrip,
};
