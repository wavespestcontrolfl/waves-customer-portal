'use strict';

/**
 * Propagate an agreed one-time price confirmed on a follow-up call back onto
 * the customer's recent un-invoiced call-booked visit (within 60 minutes), when
 * the follow-up call was NOT an active/incomplete booking attempt (call 73b3b240 -> f391c6b9).
 *
 * Rules:
 * - Requires V2 extraction with ONE final, staff-stated, caller-accepted one-time price
 *   (no V1 fallback, no unaccepted/tentative amounts, no multi-service/multi-property quotes).
 * - Excludes ALL active or unsuccessful booking requests (`confirmed`, `requested`, `offered`,
 *   `reschedule_requested`, `ambiguous`, or `v2_routing_blocked` when a date/appointment existed).
 * - Fetches ALL plausible recent future visits (including priced, staff-booked, callback,
 *   included follow-up, and recurring rows) BEFORE checking billing/source eligibility.
 * - Requires BOTH explicit prior-visit pricing linkage AND compatible service/category
 *   (exact catalog ID/alias or canonical schema `primary_service_category` e.g. `pest_general`, `lawn_care`)
 *   plus visit-level address/property agreement.
 * - Locks `call_log` (`processing_token = procToken`) AND `scheduled_services` (`FOR UPDATE`) inside
 *   a customer-comms-locked transaction, rechecking everything under lock before enabling invoicing.
 */

const logger = require('./logger');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { isAssessmentServiceRow, isAssessmentServiceType } = require('./assessment-booking');
const { etDateString } = require('../utils/datetime-et');
const {
  isPlanRateV2Price,
  v2StructuredPriceEntries,
  isReServiceCatalogRow,
  findServiceByName,
  hasMultipleServicesOrProperties,
  callBookingDateOnly,
} = require('./call-booking-catalog');
const { resolveCallAgreedPrice } = require('../utils/call-agreed-price');
const { normalizeServiceKey } = require('../config/recurring-pest-programs');
const { statesNewAddress } = require('./call-triage-flags');

const CALLBACK_PRICE_WINDOW_MS = 60 * 60 * 1000;
const CALL_BOOKED_SOURCE_ACTIONS = new Set(['ai_call_pipeline', 'ai_call_pipeline_followup']);
const BOOKING_ATTEMPT_STATUSES = new Set(['confirmed', 'requested', 'offered', 'reschedule_requested', 'ambiguous']);
const EXPLICIT_PRIOR_VISIT_PRICE_LINK_RE = /\b(?:price|quote|rate|total|cost|payment)\s+(?:for|on|of)\s+(?:the|that|my|our|earlier|this|today'?s|upcoming|booked|scheduled)\s+(?:visit|appointment|booking)\b|\b(?:price|quote|rate|total|cost|payment)\s+(?:for|on|of)\s+(?:that|the|our|my)\s+(?:earlier|upcoming|booked|scheduled)\s+service\b|\bconfirm(?:ing)?\s+(?:the\s+)?(?:\$?\d[\d,.]*\s+)?(?:price|quote|total)\s+(?:for|on|of)\s+(?:that|the|today'?s|earlier|upcoming|booked|scheduled)\s+(?:visit|appointment|booking)\b|\b(?:price|quote|rate|total|cost|payment|confirm(?:ing)?|agreed|pay(?:ing)?)\b[^.!?\n]{0,35}\b(?:earlier|upcoming|booked|scheduled)\s+(?:visit|appointment|booking|service)\b|\b(?:earlier|upcoming|booked|scheduled)\s+(?:visit|appointment|booking|service)\b[^.!?\n]{0,35}\b(?:price|quote|rate|total|cost|payment|confirm(?:ing)?|agreed)\b/i;

const PEST_GENERAL_KEYS = new Set([
  'one_time_pest_control',
  'pest_one_time',
  'cockroach_control',
  'ant_control',
  'spider_control',
  'silverfish_control',
  'flea_tick_control',
  'general_pest_control',
]);
const PEST_GENERAL_CATEGORIES = new Set(['pest_control', 'pest', 'general_pest']);
const LAWN_CATEGORIES = new Set(['lawn_care', 'lawn', 'ornamental']);

function isLawnRow(cat, key) {
  return LAWN_CATEGORIES.has(cat) || /^lawn(?:_|$)/i.test(key);
}

const CATEGORY_FAMILY_MATCHERS = {
  pest_general: (cat, key) => !isLawnRow(cat, key) && (PEST_GENERAL_CATEGORIES.has(cat) || PEST_GENERAL_KEYS.has(key)),
  general_pest: (cat, key) => !isLawnRow(cat, key) && (PEST_GENERAL_CATEGORIES.has(cat) || PEST_GENERAL_KEYS.has(key)),
  rodent: (cat, key) => !isLawnRow(cat, key) && (cat === 'rodent' || /rodent|rat|mice|mouse/i.test(key)),
  wdo: (cat, key) => cat === 'wdo' || /wdo|wood_destroying/i.test(key),
  termite: (cat, key) => cat === 'termite' || /termite/i.test(key),
  mosquito: (cat, key) => cat === 'mosquito' || /mosquito/i.test(key),
  stinging_insect: (cat, key) => cat === 'stinging_insect' || /bee|wasp|hornet|yellow_?jacket|stinging/i.test(key),
  bed_bug: (cat, key) => cat === 'bed_bug' || /bed_?bug/i.test(key),
  palm_injection: (cat, key) => cat === 'palm_injection' || /palm/i.test(key),
  exclusion: (cat, key) => cat === 'exclusion' || /exclusion/i.test(key),
  lawn_care: (cat, key) => isLawnRow(cat, key),
  lawn: (cat, key) => isLawnRow(cat, key),
  wildlife: (cat, key) => cat === 'wildlife' || /wildlife|trapping/i.test(key),
};

function isSingleAcceptedStaffOneTimeEntry(v2Extraction) {
  const sr = v2Extraction?.service_request;
  if (!sr?.price_accepted_by_caller || sr?.price_is_final !== true) return false;
  if (sr.service_intent === 'recurring_membership_inquiry' || sr.billing_choice || sr.waveguard_tier_mentioned) {
    return false;
  }
  if (hasMultipleServicesOrProperties(v2Extraction)) return false;
  const entries = v2StructuredPriceEntries(sr);
  if (entries.length !== 1) return false;
  const entry = entries[0];
  return entry.stated_by === 'agent'
    && entry.caller_response === 'accepted'
    && entry.amount_max_usd == null
    && entry.unit !== 'per_application'
    && !isPlanRateV2Price(entry);
}

function extractConfirmedCallbackOneTimePrice(v2Extraction) {
  if (!isSingleAcceptedStaffOneTimeEntry(v2Extraction)) return null;
  const agreed = resolveCallAgreedPrice(v2Extraction);
  if (!agreed || agreed.additionalTerms || agreed.amountMax != null) return null;
  if (['per_month', 'per_quarter', 'per_year', 'per_application'].includes(agreed.unit)) return null;
  if (agreed.amount < 20 || agreed.amount > 20000) return null;
  return Math.round(agreed.amount * 100) / 100;
}

function visitEffectiveAddressShape(visitRow, fallbackCustomer) {
  const line1 = String(visitRow?.service_address_line1 || visitRow?.prop_line1 || '').trim();
  if (line1) {
    return {
      hasAddress: true,
      addressLine1: line1,
      addressLine2: visitRow.service_address_line2 || visitRow.prop_line2 || null,
      addressCity: visitRow.service_address_city || visitRow.prop_city || null,
      addressState: visitRow.prop_state || fallbackCustomer?.state || null,
      addressZip: visitRow.service_address_zip || visitRow.prop_zip || null,
    };
  }
  if (!fallbackCustomer) return null;
  return {
    hasAddress: Boolean(String(fallbackCustomer.address_line1 || '').trim()),
    addressLine1: fallbackCustomer.address_line1,
    addressLine2: fallbackCustomer.address_line2,
    addressCity: fallbackCustomer.city,
    addressState: fallbackCustomer.state,
    addressZip: fallbackCustomer.zip,
  };
}

function hasCompetingPropertyOrMultiWork(v2Extraction, visitRow, customer) {
  if (hasMultipleServicesOrProperties(v2Extraction)) return true;
  const targetAddress = visitEffectiveAddressShape(visitRow, customer);
  return Boolean(targetAddress && statesNewAddress(v2Extraction, targetAddress));
}

function categoryCompatibleWithVisit(category, visitRow) {
  const cat = String(category || '').trim().toLowerCase();
  if (!cat || cat === 'other' || cat === 'unknown') return false;
  const matcher = CATEGORY_FAMILY_MATCHERS[cat];
  if (!matcher) return false;
  const svcCategory = String(visitRow?.svc_category || '').trim().toLowerCase();
  const svcKey = String(visitRow?.svc_key || '').trim().toLowerCase();
  if (!svcCategory && !svcKey) return false;
  return matcher(svcCategory, svcKey);
}

function requestedMatchesVisitExactly(requestedName, visitRow, catalogRows = []) {
  const reqKey = normalizeServiceKey(requestedName);
  const directMatch = [visitRow.service_type, visitRow.svc_name, visitRow.svc_key]
    .filter(Boolean)
    .some((n) => normalizeServiceKey(n) === reqKey);
  if (directMatch) return true;
  if (!visitRow.service_id || !Array.isArray(catalogRows) || !catalogRows.length) return false;
  const resolved = findServiceByName(catalogRows, requestedName);
  return Boolean(resolved && String(resolved.id) === String(visitRow.service_id));
}

const SEPARATE_FROM_PRIOR_VISIT_RE = /\b(?:separate\s+from|not\s+(?:for|part\s+of|including)|different\s+from|in\s+addition\s+to|aside\s+from|other\s+than|unrelated\s+to)\b[^.!?\n]{0,40}\b(?:price|quote|rate|total|cost|visit|appointment|booking|service)\b|\b(?:want|need|book(?:ing)?|schedul(?:e|ing)|quote|asking\s+for|looking\s+for)\s+(?:a\s+|an\s+)?(?:separate|different|additional|another|new)\s+(?:treatment|job|visit|appointment|service|booking)\b/i;
const QUESTION_CLAUSE_RE = /\?$|^(?:(?:agent|caller)\s*:\s*)?(?:are|is|was|were|do|did|does|would|could|can)\s+you\b/i;

function hasExplicitPriorVisitLink(v2Extraction, transcription) {
  const sr = v2Extraction?.service_request || {};
  const contextText = [
    sr.price?.evidence_quote,
    v2Extraction?.meta?.call_summary,
    v2Extraction?.scheduling?.scheduling_notes_raw,
    transcription,
  ].filter(Boolean).join('\n');
  if (!contextText) return false;
  // Any explicit separation / separate-job statement in the call blocks retroactive pricing on the earlier visit.
  if (SEPARATE_FROM_PRIOR_VISIT_RE.test(contextText)) return false;
  // Preserve `?` so unanswered or rejected questions ("Are you calling about the price for the earlier visit?")
  // cannot satisfy affirmative prior-visit linkage.
  const clauses = contextText.split(/(?<=\?)|[.!\n;]+/).map((s) => s.trim()).filter(Boolean);
  return clauses.some((clause) => !QUESTION_CLAUSE_RE.test(clause) && EXPLICIT_PRIOR_VISIT_PRICE_LINK_RE.test(clause));
}

function callbackMatchesVisitService(v2Extraction, visitRow, transcription = '', { customer = null, catalogRows = [] } = {}) {
  if (hasCompetingPropertyOrMultiWork(v2Extraction, visitRow, customer)) return false;
  if (!hasExplicitPriorVisitLink(v2Extraction, transcription)) return false;

  const sr = v2Extraction?.service_request || {};
  const requestedName = String(sr.specific_service_name || '').trim();
  if (requestedName) return requestedMatchesVisitExactly(requestedName, visitRow, catalogRows);
  return categoryCompatibleWithVisit(sr.primary_service_category, visitRow);
}

function isVisitRowEligibleForPricing(row, { customerId = null, minDate = null } = {}) {
  if (!row || row.estimated_price != null) return false;
  if (!CALL_BOOKED_SOURCE_ACTIONS.has(row.source_action)) return false;
  if (customerId && String(row.customer_id) !== String(customerId)) return false;
  const visitDate = callBookingDateOnly(row.scheduled_date);
  if (minDate && visitDate && visitDate < minDate) return false;
  if (!['pending', 'confirmed'].includes(row.status)) return false;
  if (row.is_callback || row.followup_included || row.is_recurring || row.recurring_parent_id) return false;
  if (row.svc_billing_type !== 'one_time') return false;
  if (isReServiceCatalogRow({ service_key: row.svc_key, name: row.svc_name })) return false;
  return !isAssessmentServiceType(row.service_type)
    && !isAssessmentServiceRow({ service_key: row.svc_key, name: row.svc_name });
}

function isBookingAttemptCall(v2Extraction, appointmentResult, extracted = {}) {
  if (appointmentResult?.scheduledServiceId || appointmentResult?.scheduleCreated) return true;
  if (appointmentResult?.error || appointmentResult?.held) return true;
  if (appointmentResult?.skippedReason) {
    if (appointmentResult.skippedReason !== 'v2_routing_blocked') return true;
    if (appointmentResult.dateTime || extracted?.appointment_confirmed) return true;
  }
  const sched = v2Extraction?.scheduling;
  return Boolean(sched && (BOOKING_ATTEMPT_STATUSES.has(sched.status) || sched.confirmed_start_at || sched.proposed_start_at));
}

async function loadLockedVisitDetails(trx, lockedRow) {
  const lockedSvc = lockedRow.service_id
    ? (await trx('services').where({ id: lockedRow.service_id }).first('id', 'service_key', 'name', 'category', 'billing_type')) || {}
    : {};
  const lockedProp = lockedRow.property_id
    ? (await trx('customer_properties').where({ id: lockedRow.property_id }).first('address_line1', 'address_line2', 'city', 'state', 'zip').catch(() => null)) || {}
    : {};
  return {
    ...lockedRow,
    svc_key: lockedSvc.service_key || null,
    svc_name: lockedSvc.name || null,
    svc_category: lockedSvc.category || null,
    svc_billing_type: lockedSvc.billing_type || null,
    prop_line1: lockedProp.address_line1 || null,
    prop_line2: lockedProp.address_line2 || null,
    prop_city: lockedProp.city || null,
    prop_state: lockedProp.state || null,
    prop_zip: lockedProp.zip || null,
  };
}

async function lockAndVerifyVisitCandidate(trx, candidateId, { call, procToken, customerId, todayET, v2Extraction, transcription, catalogRows }) {
  if (procToken != null) {
    const owned = await trx('call_log')
      .where({ id: call.id, processing_token: procToken })
      .forUpdate()
      .first('id');
    if (!owned) return { abortReason: 'call_ownership_lost' };
  }

  const lockedRow = await trx('scheduled_services')
    .where({ id: candidateId })
    .forUpdate()
    .first('id', 'customer_id', 'service_id', 'service_type', 'scheduled_date', 'status', 'source_action',
      'estimated_price', 'is_callback', 'followup_included', 'is_recurring', 'recurring_parent_id',
      'property_id', 'service_address_line1', 'service_address_line2', 'service_address_city',
      'service_address_zip', 'internal_notes');
  if (!lockedRow || String(lockedRow.customer_id) !== String(customerId)) return { abortReason: 'concurrent_update' };

  const merged = await loadLockedVisitDetails(trx, lockedRow);
  if (!isVisitRowEligibleForPricing(merged, { customerId, minDate: todayET })) return { abortReason: 'concurrent_update' };

  const customer = await trx('customers')
    .where({ id: customerId })
    .first('id', 'address_line1', 'address_line2', 'city', 'state', 'zip');
  if (!callbackMatchesVisitService(v2Extraction, merged, transcription, { customer, catalogRows })) {
    return { abortReason: 'concurrent_update' };
  }

  const existingInvoice = await trx('invoices').where({ scheduled_service_id: merged.id }).first('id');
  return existingInvoice ? { abortReason: 'invoiced' } : { lockedRow: merged };
}

async function propagateCallbackPriceToRecentVisit({
  conn,
  call,
  procToken = null,
  customerId,
  v2Extraction = null,
  appointmentResult = null,
  extracted = {},
  transcription = '',
  callSid = null,
} = {}) {
  if (!conn || !call?.id || !customerId) return { updated: false, reason: 'missing_context' };
  if (isBookingAttemptCall(v2Extraction, appointmentResult, extracted)) {
    return { updated: false, reason: 'booking_attempt_call' };
  }
  const amount = extractConfirmedCallbackOneTimePrice(v2Extraction);
  if (amount == null) return { updated: false, reason: 'no_agreed_one_time_price' };

  const callAt = call.created_at ? new Date(call.created_at) : new Date();
  const windowStartAt = new Date(callAt.getTime() - CALLBACK_PRICE_WINDOW_MS);
  const todayET = etDateString(callAt);

  return conn.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);

    const catalogRows = await trx('services')
      .select('id', 'service_key', 'name', 'short_name', 'billing_type')
      .catch(() => []);
    const customer = await trx('customers')
      .where({ id: customerId })
      .first('id', 'address_line1', 'address_line2', 'city', 'state', 'zip');

    // Fetch ALL recent future visits (including staff-booked, priced, covered, and recurring rows)
    // BEFORE filtering eligibility so competing siblings prevent misattribution.
    const candidates = await trx('scheduled_services as ss')
      .leftJoin('services as s', 'ss.service_id', 's.id')
      .leftJoin('customer_properties as cp', 'ss.property_id', 'cp.id')
      .leftJoin('call_log as cl', 'ss.source_call_log_id', 'cl.id')
      .where('ss.customer_id', customerId)
      .whereIn('ss.status', ['pending', 'confirmed', 'rescheduled'])
      .where('ss.scheduled_date', '>=', todayET)
      .whereRaw('COALESCE(cl.created_at, ss.created_at) >= ?', [windowStartAt])
      .whereRaw('COALESCE(cl.created_at, ss.created_at) <= ?', [callAt])
      .orderByRaw('COALESCE(cl.created_at, ss.created_at) DESC')
      .select('ss.id', 'ss.customer_id', 'ss.service_id', 'ss.service_type', 'ss.scheduled_date', 'ss.status', 'ss.source_action',
        'ss.estimated_price', 'ss.is_callback', 'ss.followup_included', 'ss.is_recurring', 'ss.recurring_parent_id',
        'ss.property_id', 'ss.service_address_line1', 'ss.service_address_line2', 'ss.service_address_city', 'ss.service_address_zip',
        'cp.address_line1 as prop_line1', 'cp.address_line2 as prop_line2', 'cp.city as prop_city', 'cp.state as prop_state', 'cp.zip as prop_zip',
        's.service_key as svc_key', 's.name as svc_name', 's.category as svc_category', 's.billing_type as svc_billing_type');

    const serviceMatched = (candidates || []).filter((r) =>
      callbackMatchesVisitService(v2Extraction, r, transcription, { customer, catalogRows }),
    );
    if (serviceMatched.length !== 1) {
      return { updated: false, reason: serviceMatched.length === 0 ? 'no_matching_unpriced_visit' : 'ambiguous_multiple_visits' };
    }
    if (!isVisitRowEligibleForPricing(serviceMatched[0], { customerId, minDate: todayET })) {
      return { updated: false, reason: 'target_visit_not_eligible' };
    }

    const verified = await lockAndVerifyVisitCandidate(trx, serviceMatched[0].id, {
      call, procToken, customerId, todayET, v2Extraction, transcription, catalogRows,
    });
    if (!verified.lockedRow) return { updated: false, reason: verified.abortReason };

    const { lockedRow } = verified;
    const sidTag = callSid || call.twilio_call_sid || String(call.id).slice(0, 8);
    const noteLine = `Price confirmed on follow-up call (${sidTag}): $${amount.toFixed(2)}.`;
    const existingNotes = String(lockedRow.internal_notes || '').trim();
    const nextNotes = existingNotes.includes(noteLine)
      ? existingNotes
      : [existingNotes, noteLine].filter(Boolean).join('\n');

    await trx('scheduled_services')
      .where({ id: lockedRow.id })
      .update({
        estimated_price: amount,
        create_invoice_on_complete: true,
        internal_notes: nextNotes,
        updated_at: new Date(),
      });

    logger.info(`[call-callback-price-sync] Propagated $${amount.toFixed(2)} from call ${sidTag} onto visit ${lockedRow.id}`);
    return { updated: true, scheduledServiceId: lockedRow.id, amount };
  });
}

async function syncCallbackPriceIfEligible({
  scheduledServiceId, appointmentResult, extracted, procToken, customerId, isOutbound, conn, call, v2DrivesRouting = false, v2Extraction, v2CanonicalExtraction, transcription, callSid,
}) {
  if (scheduledServiceId || appointmentResult?.scheduledServiceId || !customerId || isOutbound) {
    return { updated: false, reason: 'not_eligible' };
  }
  if (v2DrivesRouting !== true) return { updated: false, reason: 'v2_routing_disabled' };
  const effectiveV2 = v2Extraction || v2CanonicalExtraction;
  if (!effectiveV2) return { updated: false, reason: 'no_live_v2_extraction' };
  try {
    return await propagateCallbackPriceToRecentVisit({
      conn,
      call,
      procToken,
      customerId,
      v2Extraction: effectiveV2,
      appointmentResult,
      extracted,
      transcription,
      callSid,
    });
  } catch (err) {
    logger.warn(`[call-proc] callback price sync failed for ${callSid || call?.id}: ${err.message}`);
    return { updated: false, reason: 'error' };
  }
}

module.exports = {
  extractConfirmedCallbackOneTimePrice,
  propagateCallbackPriceToRecentVisit,
  syncCallbackPriceIfEligible,
  callbackMatchesVisitService,
  CALLBACK_PRICE_WINDOW_MS,
};
