/**
 * Customer self-serve re-service scheduling — shared eligibility + lane
 * resolution for the /reservice/:token public page, the portal's schedule
 * payload, and the admin comms composer's link helper.
 *
 * A re-service (services/re-service.js) is a FREE callback visit between
 * regular service intervals for active recurring / WaveGuard customers —
 * pest (`pest_re_service`) and lawn (`lawn_re_service`) are the only two
 * lanes; every other family (mosquito, termite, tree & shrub, one-time work)
 * stays an office call, exactly as it is today.
 *
 * Everything here is gated behind GATE_RESERVICE_SELF_SERVE (feature-gates
 * `reserviceSelfServe`): while dark, no links mint, the portal payload
 * carries nothing, and the public route 404s — flipping one env var lights
 * the whole surface up.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { TERMINAL_STATUSES, isMembershipCustomerRow } = require('./waveguard-existing-services');
const { RE_SERVICE_SERVICE_KEYS, isReService } = require('./re-service');
const { PEST_PERSISTENCE_PHRASES_SOURCE } = require('./pest-persistence-phrases');
const { COVERED_PEST_NOUN_SOURCES, SEPARATE_SERVICE_PEST_NOUN_SOURCES, CATALOG_SEPARATE_PEST_NOUN_SOURCES, TURF_INSECT_NOUN_SOURCES, specialtyLedLabel, MOSQUITO_NOUN_SOURCE, TERMITE_NOUN_SOURCE } = require('./covered-pests');
const { ASSESSMENT_SERVICE_KEY, isAssessmentServiceType, isAssessmentBooking, scopeToAssessmentBookings } = require('./assessment-booking');

// The two self-bookable callback lanes. serviceKey resolves the catalog row
// (services.service_key) at commit time — id/name/duration are read live from
// the catalog so an admin rename or duration change flows through without a
// deploy. fallbackDuration only covers a missing/duration-less catalog row.
// Re-service callbacks are short visits (owner: 15–30 min on site) — the
// catalog rows carry 30; customers still see the standard 2-hour arrival
// window (arrivalWindowRange), which derives from the start time only.
const RESERVICE_LANES = {
  pest: { serviceKey: 'pest_re_service', label: 'Pest Control Re-Service', fallbackDuration: 30 },
  lawn: { serviceKey: 'lawn_re_service', label: 'Lawn Care Re-Service', fallbackDuration: 30 },
};

function reserviceSelfServeEnabled() {
  const { isEnabled } = require('../config/feature-gates');
  return isEnabled('reserviceSelfServe');
}

// Lane classification for a coverage row (recurring plan visit). Category
// from the services catalog wins; the free-text service_type label is the
// fallback for rows with no service_id link. Families outside the two lanes
// return null — a mosquito-only or termite-bait-only plan gets no lane.
function laneForCoverageRow({ category, serviceType } = {}) {
  const cat = String(category || '').toLowerCase();
  if (cat === 'lawn_care') return 'lawn';
  if (cat === 'pest_control') return 'pest';
  if (cat) return null;
  const label = String(serviceType || '').toLowerCase();
  if (!label) return null;
  // Out-of-lane families whose legacy labels can still contain "pest"
  // ("Rodent Pest Control" is rodent_general_one_time's canonical label —
  // same rodent-led carve-out toQualifyingKeys makes for tier math), plus
  // families that are never re-service lanes. Checked BEFORE BOTH lane
  // regexes so a combined label ("Commercial Turf Treatment Program",
  // "One-Time Lawn Care") can't grant a self-bookable lane to
  // office-handled work (codex #3194 r1 P2 + r2 P2).
  if (/rodent|termite|mosquito|tree|shrub|commercial|one[\s_-]?time|onetime/.test(label)) return null;
  if (/\blawn\b|\bturf\b/.test(label)) return 'lawn';
  if (/\bpest\b|waveguard/.test(label)) return 'pest';
  return null;
}

// Same lane split for an EXISTING callback row (open-callback dedupe): the
// catalog key is authoritative, the "Re-Service" label regex is the safety
// net (mirrors services/re-service.js).
//
// 'assessment' (Codex pre-push P1, 2026-09-24) is inspection-public.js's
// dedupe lane for the free Waves Assessment — checked FIRST so an
// assessment row can never fall through to the pest default below. It is
// deliberately NOT a RESERVICE_LANES member: that map is iterated by
// reservice-public.js's loadLaneCatalog to build the /reservice page's own
// two-lane (pest/lawn) catalog, and a third entry there would offer "Waves
// Assessment" as a bookable RE-SERVICE lane, which it categorically is not
// (a re-service is a free callback for an ACTIVE recurring/WaveGuard
// customer; an assessment is the free first-visit consultation for a lead).
function laneForCallbackRow({ serviceKey, serviceType } = {}) {
  if (serviceKey === ASSESSMENT_SERVICE_KEY || isAssessmentServiceType(serviceType)) return 'assessment';
  if (serviceKey === RESERVICE_LANES.lawn.serviceKey) return 'lawn';
  if (serviceKey === RESERVICE_LANES.pest.serviceKey) return 'pest';
  // Codex round-22 P2 (PR #5336): a rodent trapping follow-up is its own excluded specialty — it must not
  // occupy (or be counted as) the customer's PEST lane, or an ant/roach report is denied its covered callback.
  if (serviceKey === 'rodent_trapping_followup') return 'rodent';
  // ...and the same visit recorded WITHOUT a catalog key (legacy / unlinked rows: service_type 'Rodent Trapping
  // Follow-Up') — classified by its label before the pest fallback (Codex round-26 P2).
  // Codex round-33 P2: EVERY excluded specialty (termite, mosquito, tree & shrub, bed bug, flea, German roach, wildlife —
  // the same source reportedReserviceExcludedSpecialty reads) is its own non-pest lane, or an open termite / mosquito /
  // tree-and-shrub callback would populate booked.pest and suppress the covered pest offer. Only SPECIALTY-LED labels
  // qualify: a retained pest-led "Pest & Rodent Control" service stays pest.
  const label = String(serviceType || '');
  if (specialtyLedLabel(label)) return /\brodent/i.test(label) ? 'rodent' : 'specialty';
  return /\blawn\b|\bturf\b/i.test(String(serviceType || '')) ? 'lawn' : 'pest';
}

// Terminal statuses that are NOT delivered coverage: a cancelled /
// rescheduled-phantom / no-show / skipped pest row was never live pest
// service, so it cannot back a membership's pest lane (codex r3 P2).
// COMPLETED stays in — a delivered visit is the between-extensions evidence
// the membership grant exists for.
const NON_COVERAGE_STATUSES = TERMINAL_STATUSES.filter((s) => s !== 'completed');

/**
 * Coverage premise scoping (codex #3222 follow-up): restrict which coverage
 * rows may back a lane grant.
 *   null                                → account-wide (public-route behavior).
 *   { propertyId, includeUnlinked:true }  → the PRIMARY/on-file premise:
 *       legacy unlinked rows (null property_id) plus rows linked to the
 *       primary property. Coverage that lives ONLY at another property
 *       (a covered rental) no longer backs a free visit at the primary.
 *   { propertyId, includeUnlinked:false } → a specific NON-primary property:
 *       only rows linked to exactly that property.
 */
function applyCoverageScope(qb, alias, coverageScope) {
  if (!coverageScope) return;
  const { propertyId = null, includeUnlinked = false } = coverageScope;
  qb.where((inner) => {
    let started = false;
    if (includeUnlinked) { inner.whereNull(`${alias}.property_id`); started = true; }
    if (propertyId) {
      if (started) inner.orWhere(`${alias}.property_id`, propertyId);
      else inner.where(`${alias}.property_id`, propertyId);
      started = true;
    }
    if (!started) inner.whereRaw('false');
  });
}

/**
 * Pest-backed evidence for a WaveGuard membership: any recurring
 * pest-classified row in the account's service history that was live
 * coverage — upcoming rows and COMPLETED rows count ("between seeded
 * extensions", no upcoming rows yet, is exactly the case the membership
 * grant exists for); cancelled/no-show/skipped/rescheduled rows do not.
 * Callback/re-service rows never count (same exclusion the coverage loop
 * applies).
 */
async function membershipPestEvidence(customerId, dbh = db, { lockCoverage = false, coverageScope = null } = {}) {
  let q = dbh('scheduled_services as hist')
    .leftJoin('services as sv', 'hist.service_id', 'sv.id')
    .where('hist.customer_id', customerId)
    .where('hist.is_recurring', true)
    .whereNotIn('hist.status', NON_COVERAGE_STATUSES)
    .modify((qb) => applyCoverageScope(qb, 'hist', coverageScope))
    .select('hist.service_type', 'hist.is_callback', 'sv.service_key', 'sv.category')
    .orderBy('hist.scheduled_date', 'desc')
    .limit(500);
  // FOR UPDATE OF hist (the joined catalog side stays unlocked — PG forbids
  // locking the nullable side of an outer join): inside a booking trx the
  // qualifying rows stay put until the insert commits.
  if (lockCoverage) q = q.forUpdate('hist');
  const rows = await q;
  return rows.some((row) => row.is_callback !== true
    && !isReService({ serviceKey: row.service_key, serviceType: row.service_type })
    && laneForCoverageRow({ category: row.category, serviceType: row.service_type }) === 'pest');
}

/**
 * Which re-service lanes this customer may self-book, from LIVE plan state:
 * upcoming (today-or-later, non-terminal) recurring coverage rows classify
 * into pest/lawn; an active WaveGuard membership row (tier / legacy
 * monthly_rate — isMembershipCustomerRow) grants the pest lane across
 * seeded-extension gaps, but ONLY when the membership is pest-backed: with
 * auto tier enrollment (GATE_AUTO_WAVEGUARD_TIER) waveguard_tier can be
 * stamped from any qualifying family (mosquito / tree-shrub / termite-bait),
 * and those families get no lane (codex #3194 r2 P1). Callback rows
 * themselves never count as coverage (a free re-service must not entitle the
 * next one on its own — same exclusion serviceRowCountsTowardWaveGuard
 * applies for tier math).
 *
 * Fail-closed: a lookup error grants nothing (friendly not-eligible card,
 * never a free visit) — it must not 500 the portal payload, and the public
 * route re-checks at commit.
 *
 * Returns ['pest'], ['lawn'], ['pest','lawn'], or [] (not eligible).
 */
async function reserviceLanesForCustomer(customer, dbh = db, { lockCoverage = false, coverageScope = null, strict = false } = {}) {
  if (!customer?.id) return [];
  const lanes = new Set();
  try {
    let q = dbh('scheduled_services as s')
      .leftJoin('services as sv', 's.service_id', 'sv.id')
      .where('s.customer_id', customer.id)
      .where('s.is_recurring', true)
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .where('s.scheduled_date', '>=', etDateString())
      .modify((qb) => applyCoverageScope(qb, 's', coverageScope))
      .select('s.service_type', 's.is_callback', 'sv.service_key', 'sv.category')
      .limit(200);
    if (lockCoverage) q = q.forUpdate('s');
    const rows = await q;
    for (const row of rows) {
      if (row.is_callback === true) continue;
      if (isReService({ serviceKey: row.service_key, serviceType: row.service_type })) continue;
      const lane = laneForCoverageRow({ category: row.category, serviceType: row.service_type });
      if (lane) lanes.add(lane);
    }
    // The membership grant is account-level, address-less evidence — it can
    // back the PRIMARY/on-file premise but never a specific non-primary
    // property (coverageScope.includeUnlinked false).
    if (!lanes.has('pest') && isMembershipCustomerRow(customer)
        && (coverageScope === null || coverageScope.includeUnlinked !== false)
        && await membershipPestEvidence(customer.id, dbh, { lockCoverage, coverageScope })) {
      lanes.add('pest');
    }
  } catch (err) {
    logger.warn(`[reservice-scheduler] lane lookup failed for customer ${customer.id}: ${err.message}`);
    // strict: the caller must tell "not eligible" from "could not check" (admin link composer) — rethrow.
    if (strict) throw err;
  }
  return ['pest', 'lawn'].filter((lane) => lanes.has(lane));
}

/**
 * The ONE customer-row lookup every re-service surface shares (admin composer,
 * report / photo-ID / cancellation streamline, the SMS FREE RE-SERVICE fact and
 * send-time recheck): a live, non-deleted, active customer that carries a
 * reservice_token, else null. loadReserviceEligibility and
 * loadReserviceLaneAvailability both start here, so the predicate cannot drift
 * (Codex round-12, PR #5336). Throws on a lookup error; callers fail closed.
 */
// The customer row with NO active / token filter (still not deleted) — the by-id SMS path needs the identity to read open callbacks.
async function loadReserviceCustomerIdentity(customerId, dbh = db) {
  return (await dbh('customers')
    .where({ id: customerId })
    .whereNull('deleted_at')
    .first('id', 'active', 'waveguard_tier', 'monthly_rate', 'reservice_token')) || null;
}
async function loadReserviceCustomerRow(customerId, dbh = db) {
  const customer = await dbh('customers')
    .where({ id: customerId })
    .whereNull('deleted_at')
    .first('id', 'active', 'waveguard_tier', 'monthly_rate', 'reservice_token');
  return !customer || customer.active === false || !customer.reservice_token ? null : customer;
}

/**
 * The customer-row half of the eligibility predicate: a live, non-deleted
 * customer row that carries a reservice_token AND has at least one live
 * lane — the exact predicate the admin composer's /reservice-link route
 * already applied per candidate row (deleted_at IS NULL, active !== false,
 * reservice_token present, reserviceLanesForCustomer non-empty). Returns
 * null for a missing/deleted/inactive/tokenless row, a lookup error, or a
 * row with no qualifying lane; otherwise { customer, lanes } (lanes always
 * non-empty). Never throws: any lookup failure resolves null (fail-closed —
 * a lookup error must read as "not eligible", never crash the caller).
 *
 * Codex round-6 P1: this is now the ONE place that predicate is computed —
 * reservice-link.js's reserviceStreamlineAccess (the admin composer's
 * /reservice-link route, requests/photo-id/report-data/cancellation
 * surfaces) delegates to this loader too (adding its own extra
 * reserviceStreamline gate + token/lanes shaping on top) instead of
 * re-running its own copy of the same customer query, so all of those
 * surfaces and this module's own loadEligibleReserviceLanes agree on
 * exactly the same customer row and lane set.
 */
async function loadReserviceEligibility(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const customer = await loadReserviceCustomerRow(customerId, dbh);
    if (!customer) return null;
    const lanes = await reserviceLanesForCustomer(customer, dbh);
    if (!lanes.length) return null;
    return { customer, lanes };
  } catch (err) {
    logger.warn(`[reservice-scheduler] eligibility loader failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

/**
 * Codex round-11 P2 (PR #5336): the ONE lane-availability computation the
 * public /reservice page and the SMS promise validators share — plan coverage
 * (reserviceLanesForCustomer) MINUS lanes that already hold an open callback
 * (openReserviceCallbacks), i.e. exactly what the page renders as bookable vs
 * alreadyBooked. Coverage alone let a promise pass after another channel booked
 * the lane, while the page answered already_booked. Returns
 * { eligible, open, bookable }: eligible = covered lanes, open = the per-lane
 * open-callback map, bookable = eligible lanes with no open callback. An
 * inactive customer has no eligible lanes. Throws on a lookup error (callers
 * choose how to fail; the by-id loader below fails closed).
 */
// any live recurring row of ANY kind (upcoming, non-terminal, not a callback)
async function customerHasAnyRecurringRow(customerId, dbh = db) {
  const row = await dbh('scheduled_services as s')
    .where('s.customer_id', customerId)
    .where('s.is_recurring', true)
    .whereNotIn('s.status', TERMINAL_STATUSES)
    .where('s.scheduled_date', '>=', etDateString())
    .where((qb) => qb.whereNull('s.is_callback').orWhere('s.is_callback', false))
    .first('s.id');
  return Boolean(row);
}
async function reserviceLaneAvailability(customer, dbh = db, { strict = false } = {}) {
  const eligible = !customer || customer.active === false ? [] : await reserviceLanesForCustomer(customer, dbh, { strict });
  // Codex round-32 P2: open callbacks are loaded INDEPENDENTLY of current eligibility — a callback booked while the plan
  // covered the lane is still an appointment on the schedule after coverage changes. Eligibility is intersected only for
  // "newly bookable".
  // Codex round-36 P2: on the NON-strict path (the public /reservice page) a failed callback read fails CLOSED to the friendly
  // not-eligible state — the page used to render it when the eligibility dependency was down, and the unconditional read must not
  // turn that into a 500. The strict path (SMS facts / send-time rechecks) still rethrows.
  // Codex round-39 P2: "could not read the callbacks" is NOT "no callback is open" — treating it as none made every covered lane
  // bookable, so the public picker could offer a lane that already holds a booked re-service. A failed read yields NO bookable lane
  // (and no listed lane), which the public page renders as its friendly unavailable state.
  let open = {};
  let callbackReadFailed = false;
  if (customer?.id) {
    try {
      open = await openReserviceCallbacks(customer.id, dbh);
    } catch (err) {
      if (strict) throw err;
      callbackReadFailed = true;
      logger.warn(`[reservice-scheduler] open-callback read failed for customer ${customer.id}: ${err.message}; no lane is bookable (non-strict)`);
    }
  }
  // Codex round-33 P2: "no supported lane" is not "no plan" — a termite / mosquito / tree-and-shrub recurring customer has no
  // self-serve lane but IS a plan customer. hasRecurringPlan is the affirmative "NO recurring plan of ANY kind" evidence
  // (false) or its opposite (true); null when it could not be read (non-strict path).
  let hasRecurringPlan = eligible.length > 0;
  if (!hasRecurringPlan && customer) {
    try {
      hasRecurringPlan = isMembershipCustomerRow(customer) || await customerHasAnyRecurringRow(customer.id, dbh);
    } catch (err) {
      if (strict) throw err;
      hasRecurringPlan = null;
    }
  }
  if (callbackReadFailed) return { eligible: [], open, bookable: [], hasRecurringPlan, callbackReadFailed: true };
  return { eligible, open, bookable: eligible.filter((lane) => !open[lane]), hasRecurringPlan };
}

/**
 * By-id form for the SMS drafter's draft-time facts and send-time recheck: the
 * same customer-row predicate as loadReserviceEligibility (live, non-deleted,
 * tokened row) followed by reserviceLaneAvailability. Never throws — any lookup
 * failure resolves to no eligible lane (fail-closed).
 */
async function loadReserviceLaneAvailability(customerId, dbh = db) {
  // `verified` (Codex round-27 P1, PR #5336): true ONLY when the lookup ran to completion — the customer row
  // loaded and the lane/callback reads all succeeded. "Could not check" (a lookup error, a missing / inactive /
  // tokenless row) is verified:false, so a caller never mistakes an unavailable answer for a confirmed
  // "no recurring plan".
  const none = { eligible: [], open: {}, bookable: [], verified: false };
  if (!customerId) return none;
  try {
    // Codex round-38 P2: load the customer IDENTITY and the open callbacks BEFORE filtering on active / token. A cancellation can mark
    // the customer inactive before its callback is cancelled; that live booked callback must still render as "already booked" (the
    // SMS facts and the slot guard read it), or the pest flow offers paid times over it. An inactive or tokenless row still has NO
    // newly bookable lane and is not a confirmed prospect (verified:false).
    const identity = await loadReserviceCustomerIdentity(customerId, dbh);
    if (!identity) return none;
    if (identity.active === false) {
      return { eligible: [], open: await openReserviceCallbacks(identity.id, dbh), bookable: [], verified: false };
    }
    const availability = await reserviceLaneAvailability(identity, dbh, { strict: true });
    // Codex round-39 P2: ENTITLEMENT does not depend on the token. A restored customer (admin restore clears deleted_at only) can
    // be tokenless yet fully covered; the token gates only the booking LINK. Such a customer keeps every covered lane, marked
    // `linkMissing` so the fact renders the link-unavailable state (acknowledge + escalate, no paid times) instead of "not eligible".
    if (!identity.reservice_token) return { ...availability, bookable: [], linkMissing: true, verified: true };
    return { ...availability, verified: true };
  } catch (err) {
    logger.warn(`[reservice-scheduler] lane availability loader failed for customer ${customerId}: ${err.message}`);
    return none;
  }
}

async function loadEligibleReserviceLanes(customerId, dbh = db) {
  const eligibility = await loadReserviceEligibility(customerId, dbh);
  return eligibility ? eligibility.lanes : [];
}

/**
 * Codex round-21 P2 (PR #5336): the same predicate as loadEligibleReserviceLanes, but a lookup FAILURE
 * throws instead of collapsing to [] ("not eligible"). The admin link composer scans sibling properties
 * in order and takes the first eligible one — a swallowed error on the operator-selected row let the scan
 * fall through to a sibling and text a re-service link for the WRONG property. [] here means the row is
 * genuinely ineligible (missing / inactive / tokenless / no live lane).
 */
async function loadEligibleReserviceLanesStrict(customerId, dbh = db) {
  if (!customerId) return [];
  const customer = await loadReserviceCustomerRow(customerId, dbh);
  if (!customer) return [];
  return reserviceLanesForCustomer(customer, dbh, { strict: true });
}

// Free-text lane classification for a CUSTOMER-REPORTED issue — used by the
// re-service SMS promise validators (sms-shadow-drafter.js
// validateReserviceOffer / reservicePromiseStillEligible) to resolve which
// lane an inbound or outgoing message's own wording is about. Deliberately
// its OWN classifier, NOT sms-service-intent.js's lead-intake regexClassify:
// that classifier lumps termite/rodent/mosquito species words into its
// single 'pest' bucket for LEAD-INTAKE routing purposes, but those are
// separate service families laneForCoverageRow above explicitly EXCLUDES
// from the self-bookable pest lane — resolving "the termites are back" to
// 'pest' here would let a termite (or rodent/mosquito) report ride the free
// PEST re-service link (Codex round-4 P2). A report naming an excluded
// specialty, or mentioning both lawn and pest words, resolves to null
// (unresolved) rather than guessing.
//
// termites/rodents/mosquitoes are ALWAYS an excluded specialty — there is no
// "incidental mention" reading of those words. Tree & shrub is different
// (Codex round-6 P1): "the ants are back in the shrubs" is an ordinary pest
// report that happens to name a location, not a tree & shrub complaint, so a
// bare "shrub"/"tree" word is no longer enough — only genuine SERVICE-ISSUE
// phrasing about the plants/structures themselves counts as the specialty
// (a dedicated tree & shrub service/treatment/care call, the trees/shrubs
// themselves reported sick/dying/diseased, or disease/fungus/scale on them).
// An incidental location ("in/on/near/around/under the shrubs/trees") never
// trips this, so when a pest noun is ALSO present the report still resolves
// to the pest lane below.
// Codex round-26 P2 (PR #5336): bed bugs are their own specialty — protocols.json (bed_bug) says "Do not merge bed
// bug with general pest. This is a specialty treatment with separate prep, pricing, and follow-up." It is the
// ONLY program the protocols file explicitly separates from general pest (checked: every other "separate" note
// concerns scope within a program — rodent exclusion, palm injection billing, copper/oil tanks).
// Every pest under the estimate copy's "Separate services" row (derived in covered-pests.js: German roaches, fleas, bed bugs,
// rodents, wildlife) is an excluded specialty too — Codex round-31.
const EXCLUDED_RESERVICE_ALWAYS_SPECIALTY_RE = new RegExp(`\\b(${TERMITE_NOUN_SOURCE}|${MOSQUITO_NOUN_SOURCE}|${SEPARATE_SERVICE_PEST_NOUN_SOURCES.concat(CATALOG_SEPARATE_PEST_NOUN_SOURCES).join('|')})\\b`, 'i');
const TREE_SHRUB_SPECIALTY_ISSUE_RE = new RegExp(
  // A dedicated tree & shrub service/treatment/care/program/spray call, the
  // service word on EITHER side of the noun (Codex round-9, PR #5336: "the
  // treatment for my shrubs didn't work" is the same complaint as "shrub
  // treatment", and used to slip through as lawn).
  '\\b(?:tree|shrub)s?\\b(?:\\s*(?:and|\\/|&)\\s*(?:tree|shrub)s?\\b)?\\s*(?:service|treatment|care|program|spray(?:ing)?)\\b'
  + '|\\b(?:service|treatment|care|program|spray(?:ing)?)\\s+(?:for|on|of|to)\\s+(?:(?:my|our|the|your)\\s+)?(?:(?:tree|shrub)s?\\b)'
  // The trees/shrubs themselves reported sick, dying, or diseased.
  + '|\\b(?:my\\s+|our\\s+|the\\s+)?(?:trees?|shrubs?)\\s+(?:are|is|looks?)\\s+(?:sick|dying|diseased)\\b'
  // Disease/fungus/scale on the trees or shrubs, in either order.
  + '|\\b(?:trees?|shrubs?)\\b[^.?!\\n]{0,20}\\b(?:disease|fungus|scale)\\b'
  + '|\\b(?:disease|fungus|scale)\\b[^.?!\\n]{0,20}\\b(?:trees?|shrubs?)\\b'
  // Codex round-41 P2: PALM issues are the same specialty (palm_treatment; covered-pests specialtyLedLabel already reads "palm"):
  // "palm bugs / mites / weevils", "palm treatment", "service for my palms", "my palms are sick". "palmetto bugs" (a roach) has no
  // space after "palm", and "ants in the palm tree" stays an incidental location.
  + '|\\bpalms?\\s+(?:bugs?|mites?|weevils?|aphids?|scale|fungus|disease|issues?|problems?|treatments?|service|care|program|spray(?:ing)?|fertili[sz]\\w*|nutrition|fronds?)\\b'
  + '|\\b(?:service|treatment|care|program|spray(?:ing)?)\\s+(?:for|on|of|to)\\s+(?:(?:my|our|the|your)\\s+)?palms?\\b'
  + '|\\b(?:my\\s+|our\\s+|the\\s+)?palms?\\s+(?:are|is|look|looks)\\s+(?:sick|dying|diseased|dead|yellow|brown|yellowing|browning)\\b',
  'i',
);
// Codex round-21 P2 (PR #5336): the lawn SERVICE words are the SAME list the outgoing promise classifier
// (sms-shadow-drafter.js RESERVICE_LAWN_SERVICE_WORDS) reads — a test pins they cannot drift. "yard" is a
// LOCATION ("ants are back in the yard" is a pest report on a dual-lane account), a lawn word only when
// service-qualified ("yard treatment", "service for my yard"); "grass" keeps its own reading.
const RESERVICE_LAWN_SERVICE_WORDS = `lawn|turf|weeds?|fert|fertili[sz]er|fertili[sz]ation|mow(?:ing)?|sod|${TURF_INSECT_NOUN_SOURCES.join('|')}`; // + the lawn copy's covered TURF insects (covered-pests.js)
const RESERVICE_LAWN_LOCATION_SERVICE_QUALIFIED = '(?:yard|grass)\\s+(?:service|treatment|care|program|maintenance|spray(?:ing)?)'
  + '|(?:service|treatment|care|program|spray(?:ing)?)\\s+(?:for|on|of|to)\\s+(?:(?:my|our|the|your)\\s+)?(?:yard|grass)';
const RESERVICE_LAWN_WORDS_RE = new RegExp(`\\b(?:${RESERVICE_LAWN_SERVICE_WORDS}|grass|${RESERVICE_LAWN_LOCATION_SERVICE_QUALIFIED})\\b`, 'i');
// Codex round-15 P2 (PR #5336): the ONE pest-noun list. The lane vocabulary below and
// sms-shadow-drafter.js's PEST_REPORT_TEXT_RE (the open-times / pest-report prescreen) are both
// built from it, so a pest the prescreen accepts ("earwigs are back") can never be missing from
// the lane classifier. Termites / rodents / mosquitoes are deliberately NOT here — they are the
// excluded specialties (EXCLUDED_RESERVICE_ALWAYS_SPECIALTY_RE above), which the prescreen adds
// on its own since it only asks "is this a pest report", not "which lane".
const RESERVICE_PEST_NOUNS_SOURCE = COVERED_PEST_NOUN_SOURCES.join('|'); // one source: services/covered-pests.js (Codex round-31 P2)
const RESERVICE_PEST_WORDS_RE = new RegExp(`\\b(${RESERVICE_PEST_NOUNS_SOURCE}|exterminator)\\b`, 'i');
// Codex round-6 P1: the ONE lane vocabulary, shared by reportedReserviceLane
// below (a customer's INBOUND report) and sms-shadow-drafter.js's
// namedReserviceLanesInText (an outgoing reply's own wording) — the same
// words must resolve the same lane wherever they appear, or the two
// classifiers can (and did) drift: a reply naming "weed-treatment" named no
// lane at all under the reply-side classifier's old, narrower word list.
// Pest-first ordering matches this module's own ['pest','lawn'] convention
// elsewhere (loadEligibleReserviceLanes / reserviceLanesForCustomer).
const RESERVICE_LANE_WORD_PATTERNS = [
  ['pest', RESERVICE_PEST_WORDS_RE],
  ['lawn', RESERVICE_LAWN_WORDS_RE],
];

// ---------------------------------------------------------------------------
// ONE clause-level classifier for a customer's inbound pest/lawn report (Codex round-22, PR #5336 —
// after a long regex chase). Everything below derives from `reservicePestReportFacts`:
//   * reportedReserviceLane              which self-bookable lane the report is about
//   * reportedReserviceExcludedSpecialty an AFFIRMED termite/rodent/mosquito/tree-and-shrub issue
//   * isActivePestReport                 a pest noun bound to an activity predicate (sms-shadow-drafter's
//                                        PEST_REPORT_TEXT_RE, needsOpenTimes and reportedPestLane use it)
// The text is split into CLAUSES (. ! ? ; : , — – " - " and/but/however/though/although/yet/while/plus).
// A clause that is NEGATED ("I don't see ants", "not termites", "no ants") or RESOLVED ("gone", "anymore",
// "no more", "stopped") contributes nothing; the other clauses still count ("ants are gone and spiders are
// back" → spiders). lawn/grass/yard/turf/sod after a location preposition ("on the lawn", "in the grass")
// are LOCATIONS, not the lawn service — unless service-qualified ("lawn treatment").
// ---------------------------------------------------------------------------
const RESERVICE_CLAUSE_DELIMITER_RE = /[.!?;:,\n–—]+|\s-\s|\b(?:and|but|however|though|although|yet|while|whereas|plus)\b/gi;
const RESERVICE_NEG = "(?:not|no|never|none|nor|without|cannot|can'?t|don'?t|doesn'?t|didn'?t|won'?t|wasn'?t|isn'?t|aren'?t|weren'?t|haven'?t|hasn'?t|hadn'?t|couldn'?t|wouldn'?t)";
const RESERVICE_ANY_PEST_NOUN = `(?:${TURF_INSECT_NOUN_SOURCES.join('|')}|${SEPARATE_SERVICE_PEST_NOUN_SOURCES.concat(CATALOG_SEPARATE_PEST_NOUN_SOURCES).join('|')}|${RESERVICE_PEST_NOUNS_SOURCE}|exterminator|${TERMITE_NOUN_SOURCE}|${MOSQUITO_NOUN_SOURCE})`;
// Codex round-27/28 P2: only constructions that AFFIRM the sighting are exempt from negation — surprise
// ("I can't believe the ants are back"), puzzlement ("I don't know why ants are back", "not sure why …"). They are
// blanked before the negation test. "I don't think / don't believe / not sure ants are back" DENY or doubt it, so
// they stay negated.
const RESERVICE_AFFIRMING_EPISTEMIC_RE = new RegExp(
  "\\b(?:can'?t|couldn'?t|cannot|can\\s+not|could\\s+not)\\s+(?:even\\s+|really\\s+)?(?:believe|imagine|understand|fathom)\\b"
  + "|\\b(?:don'?t|doesn'?t|didn'?t|do\\s+not|does\\s+not|did\\s+not)\\s+(?:really\\s+|even\\s+)?(?:know|understand|get|see)\\s+(?:why|how)\\b"
  + "|\\b(?:not|no)\\s+(?:really\\s+)?(?:sure|idea|clue)\\s+(?:why|how)\\b",
  'gi',
);
const RESERVICE_CLAUSE_NEGATED_RE = new RegExp(
  // a negator shortly before a sighting / presence / return verb ("don't see", "aren't back", "not showing up");
  // "go away" is a report that PERSISTS ("didn't go away"), not a negated sighting
  `\\b${RESERVICE_NEG}\\b(?:\\W+[\\w'’-]+){0,3}?\\W+(?:see|seen|seeing|saw|find|finding|found|notice[ds]?|noticing|show(?:ed|ing|s)?|return\\w*|come|coming|came|have|had|get|getting|be|is|are|was|were|been|go(?!\\s+away)|going(?!\\s+away)|back|there|here|around|anymore)\\b`
  // a negator directly before the noun ("not termites", "no ants", "without any roaches")
  + `|\\b${RESERVICE_NEG}\\s+(?:(?:any|a|an|the|more|even|just|really|actually|about)\\s+)?${RESERVICE_ANY_PEST_NOUN}\\b`,
  'i',
);
const RESERVICE_CLAUSE_RESOLVED_RE = /\b(?:anymore|any\s+more|no\s+more|no\s+longer|nothing\s+since|nothing\s+left|no\s+(?:sign|signs|activity)|none\s+(?:left|since))\b/i;
// "gone / stopped / went away / left" resolve a sighting ONLY when not negated: "the ants never went away",
// "they haven't stopped", "won't go away" say the infestation PERSISTS (Codex round-23 P2).
const RESERVICE_CLAUSE_RESOLUTION_WORD_RE = /\b(?:gone|stopped|disappeared|went\s+away)\b/gi;
// "left" resolves ONLY as a DEPARTURE (Codex round-28 P2): "they left", "the ants all left the house / left for good /
// left already". As remaining ("I still have ants left", "still roaches left") or evidence ("the roaches left
// droppings again") it is not resolution.
const RESERVICE_LEFT_EVIDENCE_AHEAD = "(?!\\s+(?:droppings?|behind|marks?|trails?|holes?|mess|evidence|bites?|nests?|eggs?|stains?|webs?|damage|debris|shells?|casings?|carcasses?|smell|odor|residue))";
const RESERVICE_DEPARTURE_LEFT_RE = new RegExp(
  `\\b(?:they|it|them|all|everything)\\s+(?:(?:have|has|had|all|already|finally|just)\\s+)*left\\b${RESERVICE_LEFT_EVIDENCE_AHEAD}(?!\\s+(?:over|out)\\b)`
  + `|\\b${RESERVICE_ANY_PEST_NOUN}\\s+(?:(?:have|has|had|all|already|finally|just)\\s+)*left\\s+(?:now|for\\s+good|already|altogether|the\\s+(?:house|home|property|yard|building)|yesterday|last\\s+\\w+)\\b`,
  'i',
);
const RESERVICE_PERSISTENCE_NEGATOR_RE = new RegExp(`\\b${RESERVICE_NEG}\\b(?:\\W+(?:yet|even|really|fully|completely|entirely|quite|been|ever|just))*\\W*$`, 'i');
// Codex round-39 P2: "gone / stopped / disappeared / went away" resolve a sighting ONLY when they bind to the PEST subject ("the ants
// stopped", "they're gone", "it went away"). "Ants are back because the treatment stopped working" — the spray, the rain, the
// noise stopping is not the pest stopping. The subject phrase is what sits between the last clause connector and the word; a
// product-failure complement ("stopped working / helping / killing") never resolves, whoever the subject is.
const RESERVICE_RESOLUTION_CONNECTOR_RE = /\b(?:because|since|as|when|whenever|while|although|though|if|unless|until|and|but|so|or|then|after|before)\b|[;,:]/gi;
const RESERVICE_RESOLUTION_SUBJECT_RE = new RegExp(`\\b(?:${RESERVICE_ANY_PEST_NOUN}|they|them|it|these|those|all|both|everything|none)\\b`, 'i');
const RESERVICE_PRODUCT_FAILURE_AFTER_RE = /^\s+(?:working|helping|killing|protecting|holding|lasting|doing|being\s+(?:effective|useful)|to\s+work)\b/i;
function reserviceResolutionWordBindsToPest(before) {
  let segment = before;
  let last = -1;
  let lastLen = 0;
  for (const c of before.matchAll(RESERVICE_RESOLUTION_CONNECTOR_RE)) { last = c.index; lastLen = c[0].length; }
  if (last >= 0) segment = before.slice(last + lastLen);
  if (!segment.trim()) return true; // subjectless predicate after a connector inherits its subject (the pronoun pass reads the previous clause)
  return RESERVICE_RESOLUTION_SUBJECT_RE.test(segment);
}
function reserviceClauseResolved(clause) {
  if (RESERVICE_CLAUSE_RESOLVED_RE.test(clause) || RESERVICE_DEPARTURE_LEFT_RE.test(clause)) return true;
  for (const m of clause.matchAll(RESERVICE_CLAUSE_RESOLUTION_WORD_RE)) {
    const before = clause.slice(0, m.index);
    if (RESERVICE_PERSISTENCE_NEGATOR_RE.test(before)) continue;
    if (RESERVICE_PRODUCT_FAILURE_AFTER_RE.test(clause.slice(m.index + m[0].length))) continue;
    if (reserviceResolutionWordBindsToPest(before)) return true;
  }
  return false;
}
const RESERVICE_LOCATION_PHRASE_RE = new RegExp(
  '\\b(?:in|on|at|near|around|by|under|across|through|throughout|over|into|onto|from|outside|inside)\\s+(?:(?:the|my|our|your|a)\\s+)?(?:(?:front|back|side)\\s+)?(?:lawn|grass|yard|turf|sod)\\b'
  + '(?!\\s+(?:service|treatment|care|program|maintenance|spray(?:ing)?))',
  'gi',
);
// A pest noun that is really a SERVICE name ("pest control", "ant service", "ant plan") is not a sighting.
const RESERVICE_NOUN_NOT_SERVICE = '(?!\\s+(?:control|service|services|treatment|treatments|plan|plans|program|visit|visits|schedule|contract|guarantee|coverage|company|inspection|inspections|spray|application|appointment)\\b)';
// Codex round-37 P2: ongoing-presence predicates ("the ants remain", "they persist", "keep showing up") are active-report predicates too
const RESERVICE_ACTIVITY_AFTER = "(?:back|again|everywhere|remain(?:s|ed|ing)?\\b|persist(?:s|ed|ing)?\\b|(?:never|haven'?t|hasn'?t|hadn'?t|didn'?t|won'?t|wouldn'?t|can'?t|not)\\s+(?:(?:yet|even|really|fully|completely|entirely)\\s+)?(?:went\\s+away|gone(?:\\s+away)?|go(?:ne|ing)?\\s+away|stopp\\w+|stop|left|leave|leaving)\\b|returned?|returning|(?:show(?:ed|ing|s)?|popp(?:ed|ing)|crawl(?:ed|ing)|swarm(?:ed|ing)|came|come|coming|comes)\\b|infest\\w*|invad\\w*|multipl\\w*|appear\\w*|still\\s+(?:there|here|around|coming|showing|alive|crawling|active|appearing|seeing|see)\\b|all\\s+over|in\\s+(?:my|the|our)\\s+(?:house|home|kitchen|bathroom|garage|bedroom|room|pantry|attic|shed|lanai|patio|porch|walls?)\\b)";
// Codex round-41 P2: the covered pests' own qualified names ("carpenter ants", "ghost ants", "large roaches", "black widow spiders") — a
// BOUNDED modifier vocabulary (at most 2), so plain possession "I have carpenter ants" reads, while "I have a question about ants" does not.
const RESERVICE_PEST_MODIFIER = "(?:carpenter|ghost|big-?headed|fire|acrobat|crazy|argentine|white-?footed|pharaoh|odorous|sugar|house|large|big|huge|giant|little|small|tiny|flying|black|red|brown|american|australian|smoky-?brown|palmetto|wolf|jumping|widow|recluse|banded|cellar|camel|brown-?banded|oriental|field|cave|house)";
const RESERVICE_ACTIVITY_BOUND_RES = [
  // noun … activity ("the ants are back", "roaches keep coming", "ants are everywhere")
  new RegExp(`\\b${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}(?:\\W+[\\w'’-]+){0,6}?\\W+${RESERVICE_ACTIVITY_AFTER}`, 'i'),
  // sighting verb … noun ("still see ants", "found roaches"); "more/another/new" must sit right next to the noun
  new RegExp(`\\b(?:see|saw|seeing|seen|found|find|finding|spot(?:ted|ting)?|notic\\w*)\\b(?:\\W+(?!about\\b|regarding\\b|for\\b|with\\b)[\\w'’-]+){0,3}?\\W+${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}`, 'i'),
  new RegExp(`\\b(?:more|another|new)\\s+${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}`, 'i'),
  // possession / persistence ("I still have ants", "I'm still getting ants", "keep seeing roaches"): the SAME
  // persistence constructions SAVE_SALE_TEXT_RE reads (pest-persistence-phrases — one source)
  new RegExp(`\\b(?:${PEST_PERSISTENCE_PHRASES_SOURCE})\\b(?:\\W+(?!about\\b|regarding\\b|for\\b|with\\b)[\\w'’-]+){0,3}?\\W+${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}`, 'i'),
  // plain possession by the speaker ("I have ants", "we've got roaches") — never a service-context phrase
  // ("we have ants under contract / covered / in our plan / on the schedule")
  new RegExp(`\\b(?:i|we)(?:['’]ve|\\s+have|\\s+had|\\s+got|['’]ve\\s+got|\\s+have\\s+got|\\s+now\\s+have)\\s+(?:(?:a|an|some|the|these|those|many|several|few|a\\s+few)\\s+)?(?:${RESERVICE_PEST_MODIFIER}[\\s-]+){0,2}${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}(?!\\W+(?:under|covered|included|in\\s+(?:our|my|the)\\s+(?:plan|contract|program|package|coverage)|on\\s+(?:our|my|the)\\s+(?:plan|contract|schedule|list)|with\\s+(?:our|my|the)\\s+(?:plan|contract|program|service)|for\\s+(?:our|my|the)\\s+(?:plan|contract|program|service)))`, 'i'),
  // presence: "there are (still) roaches", "still roaches left" (LEFT as remaining — Codex round-28 P2)
  new RegExp(`\\bthere\\s+(?:are|is|were|was)\\s+(?:(?:still|now|more|so\\s+many|many|some|a\\s+few)\\s+)*(?:[\\w'’-]+\\s+){0,2}?${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}`, 'i'),
  new RegExp(`\\bstill\\b(?:\\W+[\\w'’-]+){0,4}?\\W+${RESERVICE_ANY_PEST_NOUN}\\b(?:\\W+[\\w'’-]+){0,2}?\\W+left\\b`, 'i'),
  // "have / got / getting" with a quantity right before the noun ("we have so many ants", "getting more roaches")
  new RegExp(`\\b(?:have|having|got|getting)\\s+(?:more|new|another|so\\s+many|a\\s+lot\\s+of|lots\\s+of|tons\\s+of|a\\s+bunch\\s+of)\\s+${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}`, 'i'),
];

// Codex round-41 P2: "haven't stopped coming", "didn't stop showing up", "won't stop", "can't stop seeing" say the pests PERSIST — a
// negator + stop + activity verb is a persistence construction, not a negated sighting ("haven't ... coming" once dropped it).
const RESERVICE_NOT_STOP_PERSIST_RE = new RegExp(`\\b${RESERVICE_NEG}\\b(?:\\W+(?:yet|even|really|fully|completely|entirely|quite|ever|just))*\\W+stop(?:ped|ping|s)?\\s+(?:to\\s+)?(?:coming|come|showing|show|appearing|appear|returning|return|crawling|swarming|multiplying|seeing|finding|getting|popping|invading|infesting)\\b`, 'gi');
function reserviceClauseDropped(clause) {
  const blanked = clause
    .replace(RESERVICE_AFFIRMING_EPISTEMIC_RE, (m) => ' '.repeat(m.length))
    .replace(RESERVICE_NOT_STOP_PERSIST_RE, (m) => ' '.repeat(m.length));
  return RESERVICE_CLAUSE_NEGATED_RE.test(blanked) || reserviceClauseResolved(clause);
}
// Codex round-28 P2: a QUESTION or HYPOTHETICAL is not a report ("Are the ants back?", "Can you tell me if ants are
// back?", "If ants are back, what should I do?"): the clause ends in "?", opens with an auxiliary inversion, or is
// governed by if / whether / unless. WHY-questions presuppose the sighting and stay reports. Such a clause is kept
// for lane / specialty reading but is never an ACTIVE report.
// An opener is an AUXILIARY followed by a SUBJECT ("can you", "are the ants", "is it", "do we") — never a contraction
// ("Can't believe the ants are back") or subjectless shorthand ("Can confirm the ants are back"), Codex round-30 P2.
const RESERVICE_QUESTION_OPEN_RE = new RegExp(`^\\W*(?:(?:and|but|so|also|please|then)\\W+)*(?:are|is|was|were|am|do|does|did|can|could|will|would|should|shall|may|might|have|has|had)\\s+(?:you|i|we|they|he|she|it|there|someone|somebody|anyone|anybody|everyone|the|my|our|your|these|those|this|that|any|some|no|a|an|${RESERVICE_ANY_PEST_NOUN})\\b`, 'i');
const RESERVICE_WHY_QUESTION_RE = /^\W*(?:(?:and|but|so)\W+)*(?:why|how\s+come)\b/i;
const RESERVICE_HYPOTHETICAL_RE = /\b(?:if|whether|unless|in\s+case|suppose|supposing)\b/i;
// Codex round-40 P2: an UNPUNCTUATED trailing request / question ("Ants are back can you help?", "Roaches are everywhere please help",
// "Ants are back what should I do?") makes the clause end in "?" without making the PEST ASSERTION a question. The trailing segment is
// split off before judging: the prefix is judged on its own (a genuine question — "Are the ants back?" — opens as one and stays
// non-assertive; so does a hypothetical prefix).
const RESERVICE_TRAILING_REQUEST_RE = /\b(?:(?:can|could|will|would)\s+(?:you|u|someone|somebody|anyone|anybody)\b|(?:please|pls)\s+(?:help|send|come|call|advise|fix|let)\b|(?:what|how)\s+(?:should|can|do|would|could)\s+(?:i|we|you)\b|what\s+now\b|any\s+(?:ideas|advice|suggestions|thoughts)\b|(?:do|did)\s+you\s+(?:have|know)\b)/i;
function reserviceClauseIsQuestion(clause, delimiter) {
  const trailing = RESERVICE_TRAILING_REQUEST_RE.exec(clause);
  if (trailing && trailing.index > 0 && clause.slice(0, trailing.index).trim() && !RESERVICE_QUESTION_OPEN_RE.test(clause) && !RESERVICE_WHY_QUESTION_RE.test(clause)) {
    return reserviceClauseIsQuestionCore(clause.slice(0, trailing.index), '');
  }
  return reserviceClauseIsQuestionCore(clause, delimiter);
}
function reserviceClauseIsQuestionCore(clause, delimiter) {
  // if / whether / unless make the clause hypothetical only when they GOVERN the pest activity — i.e. a pest noun
  // FOLLOWS the marker ("If ants are back…", "tell me if ants are back"). "Ants are back if you can believe it"
  // asserts the recurrence (Codex round-29 P2).
  const hyp = RESERVICE_HYPOTHETICAL_RE.exec(clause);
  const hypothetical = Boolean(hyp) && new RegExp(`\\b${RESERVICE_ANY_PEST_NOUN}\\b`, 'i').test(clause.slice(hyp.index + hyp[0].length));
  if (RESERVICE_WHY_QUESTION_RE.test(clause)) return hypothetical;
  return /\?/.test(delimiter || '') || RESERVICE_QUESTION_OPEN_RE.test(clause) || hypothetical;
}
// A clause that RESOLVES a sighting by pronoun ("…, but they are gone now", "…, but they disappeared") also resolves
// the sighting just before it (Codex round-27 P2): "I saw ants yesterday, but they are gone now". A resolution
// that names a pest of its own ("ants are gone but roaches are back" — the resolved clause names ants, the
// next names roaches) does not reach back.
// A coordinated list of pest NOUNS ("termites and ants", "termites, ants, and roaches") shares the predicate that
// follows, so its commas and its and/plus are not clause boundaries (Codex round-28/29 P2). A list needs the
// conjunction — "not bed bugs, the ants are back" is two clauses, not a list. Masked length-preservingly in the copy the
// delimiters are read from.
const RESERVICE_NOUN_LIST_RE = new RegExp(`\\b${RESERVICE_ANY_PEST_NOUN}\\b(?:\\s*,\\s*(?:the\\s+|some\\s+)?${RESERVICE_ANY_PEST_NOUN}\\b)*\\s*,?\\s+(?:and|plus)\\s+(?:the\\s+|some\\s+|those\\s+)?${RESERVICE_ANY_PEST_NOUN}\\b`, 'gi');
// ...but only when the list is a SUBJECT sharing the predicate. A list that is the OBJECT of a preceding verb ("I do not have
// termites and ants are back" — "have termites" is complete, "ants are back" is a new clause) is not masked (round-32 P2).
const RESERVICE_OBJECT_POSITION_BEFORE_RE = /\b(?:have|has|had|having|got|get|getting|see|saw|seen|seeing|find|found|finding|spot\w*|notic\w*|with|without|no|not|any|about|for|of|like|than)\s+(?:(?:the|some|any|these|those|many|more|all|a|an|of)\s+)*$/i;
const RESERVICE_NEW_PREDICATE_AFTER_RE = /^\s*(?:are|is|were|was|came|come|comes|keep|kept|have|has|had|seem|seems|appear\w*|returned|returns|showed|shows|started|starts|went|go|goes)\b/i;
function maskCoordinatedNouns(text) {
  const s = String(text);
  return s.replace(RESERVICE_NOUN_LIST_RE, (m, offset) => {
    // Codex round-33 P2: after "X and Y", a NEW predicate on Y ("… ants are back") makes the object-position list two clauses;
    // otherwise it is a shared object ("I have ants and termites", "I saw ants and bed bugs") and stays together.
    const objectPosition = RESERVICE_OBJECT_POSITION_BEFORE_RE.test(s.slice(Math.max(0, offset - 40), offset));
    const newPredicate = RESERVICE_NEW_PREDICATE_AFTER_RE.test(s.slice(offset + m.length, offset + m.length + 40));
    if (objectPosition && newPredicate) return m;
    return m.replace(/,/g, '&').replace(/\b(?:and|plus)\b/gi, (w) => '&'.repeat(w.length));
  });
}
const RESERVICE_SUBJECTLESS_PREDICATE_RE = /^\W*(?:(?:and|but|yet|then|now|so)\W+)*(?:came|come|comes|returned|returns|returning|reappeared|reappears|showed|shows|started|starts|keep|kept|are|is|were|was|have|has)\b/i;
const RESERVICE_PRONOUN_SUBJECT_RE = /^\W*(?:(?:but|and|yet|now|then|so|because)\W+)*(?:they|it|them|those|these|all\s+of\s+(?:them|it))\b/i;
// { kept: clauses that still count, survivingText: the original text with dropped clauses blanked }
function reservicePestReportFacts(text) {
  const s = String(text || '');
  const segs = [];
  let cursor = 0;
  const flush = (end, delimiter) => segs.push({ clause: s.slice(cursor, end), delimiter });
  // "termites and ants are back": an "and" that coordinates two pest NOUNS shares the following predicate, so it is
  // not a clause boundary (Codex round-28 P2). Masked length-preservingly in the copy the delimiters are read from.
  const splitCopy = maskCoordinatedNouns(s);
  for (const m of splitCopy.matchAll(RESERVICE_CLAUSE_DELIMITER_RE)) {
    flush(m.index, m[0]);
    cursor = m.index + m[0].length;
  }
  flush(s.length, '');
  // A SUBJECTLESS predicate clause ("The ants went away and came back": "came back") keeps the pest subject of the clause before
  // it (Codex round-32 P2): its effective text is "<noun> came back".
  segs.forEach((seg, i) => {
    seg.blank = !seg.clause.trim();
    seg.eff = seg.clause;
    if (!seg.blank && RESERVICE_SUBJECTLESS_PREDICATE_RE.test(seg.clause) && !RESERVICE_PEST_NOUN_UNBOUND_RE.test(seg.clause)) {
      const prevSeg = segs.slice(0, i).reverse().find((x) => !x.blank);
      const noun = prevSeg && RESERVICE_PEST_NOUN_UNBOUND_RE.exec(prevSeg.clause);
      if (noun) seg.eff = `${noun[0]} ${seg.clause.trim()}`;
    }
  });
  // A leading HISTORICAL time adjunct ("Back in 2024, the ants came back") is carried into the clause that follows it — the comma split
  // would otherwise drop it and read the sighting as current (Codex round-36 P2).
  segs.forEach((seg, i) => {
    if (seg.blank || RESERVICE_PEST_NOUN_UNBOUND_RE.test(seg.clause) || !RESERVICE_PAST_MARKER_RE.test(seg.clause)
      || seg.clause.trim().split(/\s+/).length > 6) return;
    const next = segs.slice(i + 1).find((x) => !x.blank);
    if (next) next.eff = `${seg.clause.trim()}, ${next.eff}`;
  });
  segs.forEach((seg) => {
    seg.dropped = seg.blank || reserviceClauseDropped(seg.eff);
    seg.question = !seg.blank && reserviceClauseIsQuestion(seg.eff, seg.delimiter);
  });
  segs.forEach((seg, i) => {
    const prev = segs.slice(0, i).reverse().find((x) => !x.blank);
    if (!prev || seg.blank || prev.dropped || !reserviceClauseResolved(seg.clause)) return;
    if (RESERVICE_PRONOUN_SUBJECT_RE.test(seg.clause) && !RESERVICE_PEST_NOUN_UNBOUND_RE.test(seg.clause)) prev.dropped = true;
  });
  const kept = [];
  const asserted = [];
  const clauses = [];
  let surviving = '';
  for (const seg of segs) {
    if (!seg.blank) clauses.push(seg.clause);
    if (!seg.dropped) { kept.push(seg.eff); if (!seg.question) asserted.push(seg.eff); surviving += seg.clause; } else surviving += ' '.repeat(seg.clause.length);
    surviving += seg.delimiter;
  }
  return { kept, asserted, clauses, survivingText: surviving };
}
// A pronoun return ("they're back", "it is coming back") in a clause that still counts, with a pest noun
// (not a service name) anywhere in another surviving clause: "the roach poison is not working, they are back".
const RESERVICE_PRONOUN_RETURN_RE = /\b(?:they|it)(?:'re|'s|\s+(?:are|is|were|was|keep|keeps))?\s+(?:(?:coming|showing)\s+(?:back|up)|back|everywhere|returned|returning|remain(?:s|ed|ing)?|persist(?:s|ed|ing)?)\b/i;
const RESERVICE_PEST_NOUN_UNBOUND_RE = new RegExp(`\\b${RESERVICE_ANY_PEST_NOUN}\\b${RESERVICE_NOUN_NOT_SERVICE}`, 'i');
// Codex round-32 P2: plain possession with an explicit PAST-TIME marker is history, not an active report ("Last year I had
// ants. What did you use?"). The persistence / sighting constructions are unaffected.
const RESERVICE_PAST_MARKER_RE = /\b(?:last\s+(?:year|month|decade)|(?:a\s+)?(?:year|month|decade)s?\s+ago|years\s+ago|used\s+to|previously|formerly|before\s+(?:we|i)\b|back\s+in\s+(?:\d{4}|the\s+day)|in\s+(?:19|20)\d{2}|when\s+(?:we|i)\s+(?:first\s+)?(?:moved|bought|lived))\b/i;
// ...unless the same clause also says it is happening NOW ("came back last year and they're still here" splits anyway; "again
// this week", "still", "right now", "today" override the historical reading).
const RESERVICE_PRESENT_MARKER_RE = /\b(?:still|right\s+now|currently|today|tonight|this\s+(?:week|month|morning|afternoon|evening)|again\s+now|as\s+of\s+now)\b/i;
// Codex round-35 P2: the past-time guard applies to EVERY activity pattern, not only "I had ants" ("Last year the ants came
// back. What did you use?" is not an active report).
function reserviceClauseIsHistorical(clause) {
  return RESERVICE_PAST_MARKER_RE.test(clause) && !RESERVICE_PRESENT_MARKER_RE.test(clause);
}
function activePestClauses(kept) {
  return kept.filter((clause) => !reserviceClauseIsHistorical(clause) && RESERVICE_ACTIVITY_BOUND_RES.some((re) => re.test(clause)));
}
// Does the message name ANOTHER service than `lane` (the other self-bookable lane, or an excluded specialty)?
// Location phrases ("on the lawn") are not a service. Used to keep the re-service the sole need (round-29 P1).
function namesOtherService(text, lane) {
  const s = String(text || '');
  if (reportedReserviceExcludedSpecialty(s)) return true;
  const located = s.replace(RESERVICE_LOCATION_PHRASE_RE, ' ');
  return RESERVICE_LANE_WORD_PATTERNS.some(([other, rx]) => other !== lane && rx.test(located));
}
function isActivePestReport(text) {
  const { kept, asserted } = reservicePestReportFacts(text);
  if (activePestClauses(asserted).length) return true;
  return asserted.some((clause) => RESERVICE_PRONOUN_RETURN_RE.test(clause)) && kept.some((clause) => RESERVICE_PEST_NOUN_UNBOUND_RE.test(clause));
}

// Codex round-24 P2: does the message AFFIRM a term (a hand-off word, an anger word)? A clause that mentions
// it behind a negator ("I don't need a refund", "I don't want to cancel", "not angry") does not count.
function mentionsAffirmed(text, termRe) {
  const s = String(text || '');
  const re = new RegExp(termRe.source, termRe.flags.includes('g') ? termRe.flags : `${termRe.flags}g`);
  const negatorBefore = new RegExp(`\\b${RESERVICE_NEG}\\b(?:\\W+[\\w'’-]+){0,4}\\W*$`, 'i');
  // match on the WHOLE text (a phrase like "sick and tired" spans a clause delimiter), then judge negation
  // only within the match's own clause
  const boundaries = [...s.matchAll(RESERVICE_CLAUSE_DELIMITER_RE)].map((d) => d.index + d[0].length);
  // Codex round-29 P2: negation may also FOLLOW the term ("A refund isn't needed", "cancellation isn't what I want").
  const negatedAfter = /^\W*(?:[\w'’-]+\W+){0,2}?(?:isn['’]?t|is\s+not|aren['’]?t|are\s+not|wasn['’]?t|won['’]?t|will\s+not|no\s+longer|not\s+(?:needed|necessary|required|wanted|something|what|the\s+issue|a\s+concern|a\s+priority))\b/i;
  for (const m of s.matchAll(re)) {
    const clauseStart = boundaries.filter((at) => at <= m.index).pop() || 0;
    const clauseEnd = boundaries.find((at) => at > m.index + m[0].length) ?? s.length;
    const tail = s.slice(m.index + m[0].length, clauseEnd);
    if (!negatorBefore.test(s.slice(clauseStart, m.index)) && !negatedAfter.test(tail)) return true;
  }
  return false;
}

// The lane is derived from the clause(s) carrying the ACTIVE report (Codex round-24 P2): "My lawn service is
// Tuesday, and the ants are back" is a pest report even though another clause names the lawn service. With no
// active clause (a bare lawn complaint, "tell me more about ants") every surviving clause is read.
const RESERVICE_TURF_INSECT_RE = new RegExp(`\\b(?:${TURF_INSECT_NOUN_SOURCES.join('|')})\\b`, 'i');
const RESERVICE_TURF_INSECT_G_RE = new RegExp(RESERVICE_TURF_INSECT_RE.source, 'gi');
// Codex round-41 P2 (scope-dependent): the general pest plan covers fire-ant MOUNDS NEAR THE STRUCTURE (estimate-service-details "Covered
// pests"); fire-ant control across the lawn is included only when the proposal says so ("Covered turf insects"). A fire-ant report with a
// lawn / yard location and no structure word is therefore scope-dependent — not an automatic pest re-service (treated like an excluded
// specialty: no owed / forced offer, a promise is rejected, a person decides).
const RESERVICE_FIRE_ANT_RE = /\bfire[- ]?ants?\b/i;
const RESERVICE_YARD_LOCATION_RE = /\b(?:in|on|across|throughout|over|around|all\s+over)\s+(?:(?:the|my|our|your)\s+)?(?:(?:front|back|side|whole|entire)\s+)*(?:lawn|yard|grass|turf|sod)\b/i;
const RESERVICE_STRUCTURE_LOCATION_RE = /\b(?:house|home|structure|foundation|walls?|kitchen|bathroom|garage|patio|lanai|porch|pool\s+cage|screen|inside|indoors?|door|windows?|slab|building|bedroom|roof|eaves?|attic)\b/i;
function fireAntYardClause(clause) {
  const c = String(clause || '');
  return RESERVICE_FIRE_ANT_RE.test(c) && RESERVICE_YARD_LOCATION_RE.test(c) && !RESERVICE_STRUCTURE_LOCATION_RE.test(c);
}
const EXCLUDED_ALWAYS_G_RE = new RegExp(EXCLUDED_RESERVICE_ALWAYS_SPECIALTY_RE.source, 'gi');
const TREE_SHRUB_G_RE = new RegExp(TREE_SHRUB_SPECIALTY_ISSUE_RE.source, 'gi');
// Codex round-39 P2: the SET of lanes the active report names, in ['pest','lawn'] order — "Ants and chinch bugs are back" reports BOTH.
// Codex round-42 P2: an excluded specialty in the SAME report no longer erases the covered lane — "Ants are back and termites are back"
// keeps pest (the specialty nouns are stripped before reading lanes; reportedReserviceExcludedSpecialty marks the specialty separately).
// [] for nothing reported / a specialty-only report. reportedReserviceLane is the single-lane view (null when the set is not exactly one,
// or when a specialty rides along).
function reportedReserviceLanes(text) {
  const facts = reservicePestReportFacts(text);
  if (!facts.survivingText.trim()) return [];
  const excluded = reportedReserviceExcludedSpecialty(text);
  const activeAll = activePestClauses(facts.asserted);
  const active = activeAll.filter((clause) => !fireAntYardClause(clause));
  if (activeAll.length && !active.length) return []; // only a scope-dependent fire-ant-in-the-yard report
  if (excluded && !active.length) return [];
  const basis = active.length ? active.join(' , ') : facts.survivingText;
  let located = basis.replace(RESERVICE_LOCATION_PHRASE_RE, ' ');
  if (excluded) located = located.replace(EXCLUDED_ALWAYS_G_RE, ' ').replace(TREE_SHRUB_G_RE, ' ');
  // TURF insects (chinch bugs, mole crickets, armyworms, grubs, sod webworms) are LAWN, matched before the generic
  // household nouns they contain (Codex round-33 P2)
  const turfHit = RESERVICE_TURF_INSECT_RE.test(located);
  const stripped = located.replace(RESERVICE_TURF_INSECT_G_RE, ' ');
  const hasLawn = turfHit || RESERVICE_LAWN_WORDS_RE.test(stripped);
  const hasPest = RESERVICE_PEST_WORDS_RE.test(stripped);
  return [hasPest && 'pest', hasLawn && 'lawn'].filter(Boolean);
}
function reportedReserviceLane(text) {
  if (reportedReserviceExcludedSpecialty(text)) return null;
  const lanes = reportedReserviceLanes(text);
  return lanes.length === 1 ? lanes[0] : null; // several lanes reported — let the reply itself name them
}

// Codex round-5 P1: reportedReserviceLane folds an excluded-specialty report
// (termites/rodents/mosquitoes/tree & shrub) into the same null it returns
// for an ambiguous or unmatched report — validateReserviceOffer needs to
// tell the two apart, since an excluded specialty must reject a re-service
// promise outright even when the reply itself names an eligible pest/lawn
// lane (a termite report never rides a free PEST re-service link, whatever
// the reply promises). Round 22: only an AFFIRMED specialty counts — "It's not termites — the ants are
// back" is a pest report.
function reportedReserviceExcludedSpecialty(text) {
  const facts = reservicePestReportFacts(text);
  // Codex round-25 P2: with an active report present, only the clause(s) CARRYING it are judged — "My termite
  // inspection is Tuesday, and the ants are back" is a pest report. With no active clause (a bare tree/shrub
  // health complaint, "my termites") every surviving clause is read.
  const active = activePestClauses(facts.asserted);
  const s = active.length ? active.join(' , ') : facts.survivingText;
  return EXCLUDED_RESERVICE_ALWAYS_SPECIALTY_RE.test(s) || TREE_SHRUB_SPECIALTY_ISSUE_RE.test(s)
    || (active.length ? active.some(fireAntYardClause) : fireAntYardClause(s));
}

// Statuses that keep a callback "open" for the lane dedupe: booked
// (pending/confirmed) AND live (en_route/on_site) — a tech already on the
// way is the strongest possible reason not to book a second free visit in
// the lane. Completed/cancelled/no_show/skipped/rescheduled release it.
const OPEN_CALLBACK_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

/**
 * Open (booked-or-live, today-or-later) callback visits for the customer,
 * keyed by lane — the dedupe that keeps the page from booking a SECOND free
 * re-service in the same lane, and the tie-in that hands the customer the
 * existing visit's /reschedule link instead ("already booked — move it").
 * Advisory only at page level — the COMMIT re-checks under a lane lock via
 * openCallbackExistsForLane below.
 */
async function openReserviceCallbacks(customerId, dbh = db) {
  if (!customerId) return {};
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', OPEN_CALLBACK_STATUSES)
    .where('s.scheduled_date', '>=', etDateString())
    .where((qb) => qb
      .where('s.is_callback', true)
      .orWhereIn('sv.service_key', Array.from(RE_SERVICE_SERVICE_KEYS)))
    .orderBy([
      { column: 's.scheduled_date', order: 'asc' },
      { column: 's.window_start', order: 'asc' },
      { column: 's.id', order: 'asc' },
    ])
    .select(
      's.id', 's.scheduled_date', 's.window_start', 's.window_end',
      's.service_type', 's.reschedule_token', 'sv.service_key'
    );
  const byLane = {};
  for (const row of rows) {
    // Non-re-service callbacks (a retreat the office flagged on a regular
    // catalog row) still block their lane — one open free visit per lane.
    const lane = laneForCallbackRow({ serviceKey: row.service_key, serviceType: row.service_type });
    // A rodent follow-up is not a pest/lawn re-service: it neither books nor blocks either lane here.
    if (lane === 'rodent' || lane === 'specialty') continue;
    if (byLane[lane]) continue; // soonest visit represents the lane
    byLane[lane] = {
      date: typeof row.scheduled_date === 'string'
        ? row.scheduled_date.slice(0, 10)
        : row.scheduled_date?.toISOString?.().slice(0, 10) || null,
      windowStart: row.window_start ? String(row.window_start).slice(0, 5) : null,
      serviceType: row.service_type || RESERVICE_LANES[lane].label,
      rescheduleUrl: row.reschedule_token ? `/reschedule/${row.reschedule_token}` : null,
    };
  }
  return byLane;
}

/**
 * Transaction-capable lane-dedupe re-check for the COMMIT path: true when the
 * customer already has an open callback in `lane`. Takes the db handle (a
 * trx) so createSelfBooking can run it INSIDE its booking transaction, under
 * the reservice-lane advisory lock — the page-level openReserviceCallbacks
 * check is racy on its own (two parallel commits with different slots both
 * pass it before either insert; codex P1 on #3194).
 */
// 'assessment' (Codex pre-push P1, 2026-09-24) is accepted here even though
// it is not a RESERVICE_LANES member — see laneForCallbackRow's comment —
// so inspection-public.js's createSelfBooking call (callbackVisit.serviceKey
// = ASSESSMENT_SERVICE_KEY, dedupeLane left at its true default) gets the
// SAME atomic per-customer dedupe reservice-public.js relies on: the row
// this reads is fetched inside createSelfBooking's own insert transaction,
// under the reservice-lane advisory lock keyed on this exact lane, so two
// concurrent commits for the same lead's customer can never both pass this
// check and both insert — one throws ALREADY_BOOKED before its insert ever
// runs.
//
// The assessment lane does NOT reuse the pest/lawn callback predicate below
// (Codex round-12 P1): that predicate requires is_callback/a re-service
// catalog key and a scheduled_date >= today, which an assessment row need
// not carry — a legacy 'Waves Assessment' row can have service_id NULL and
// is_callback false, and an assessment left open past its date (rescheduled
// or simply overdue) is still an open commitment. It instead mirrors
// inspection-public.js's own findOpenVisit(assessmentOnly): any non-terminal
// status, no date bound, and assessment identity by name OR catalog
// (isAssessmentBooking) — the exact predicate the phase-2 commit's own
// open-assessment checks already use, so this atomic re-check can never miss
// a row those checks would have caught.
async function openCallbackExistsForLane(dbh, customerId, lane) {
  if (!customerId || !(RESERVICE_LANES[lane] || lane === 'assessment' || lane === 'rodent' || lane === 'specialty')) return false;
  if (lane === 'assessment') {
    // The assessment identity IN SQL, never after a LIMIT (Codex #4737 r12
    // pre-push P1): any non-terminal row that is an assessment by name or
    // catalog — the same scope findOpenVisit(assessmentOnly) uses.
    const rows = await dbh('scheduled_services')
      .leftJoin('services', 'services.id', 'scheduled_services.service_id')
      .where('scheduled_services.customer_id', customerId)
      .whereNotIn('scheduled_services.status', TERMINAL_STATUSES)
      .modify((q) => scopeToAssessmentBookings(q))
      .select('scheduled_services.service_type', 'scheduled_services.service_id');
    for (const row of rows) {
      if (await isAssessmentBooking(row, dbh)) return true;
    }
    return false;
  }
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', OPEN_CALLBACK_STATUSES)
    .where('s.scheduled_date', '>=', etDateString())
    .where((qb) => qb
      .where('s.is_callback', true)
      .orWhereIn('sv.service_key', Array.from(RE_SERVICE_SERVICE_KEYS)))
    .select('s.service_type', 'sv.service_key')
    .limit(50);
  return rows.some((row) => laneForCallbackRow({ serviceKey: row.service_key, serviceType: row.service_type }) === lane);
}

module.exports = {
  RESERVICE_LANES,
  OPEN_CALLBACK_STATUSES,
  NON_COVERAGE_STATUSES,
  reserviceSelfServeEnabled,
  laneForCoverageRow,
  laneForCallbackRow,
  reserviceLanesForCustomer,
  loadReserviceEligibility,
  loadEligibleReserviceLanes,
  loadEligibleReserviceLanesStrict,
  reserviceLaneAvailability,
  loadReserviceLaneAvailability,
  RESERVICE_LANE_WORD_PATTERNS,
  RESERVICE_LAWN_SERVICE_WORDS,
  RESERVICE_PEST_NOUNS_SOURCE,
  reportedReserviceLane,
  reportedReserviceLanes,
  reportedReserviceExcludedSpecialty,
  isActivePestReport,
  namesOtherService,
  mentionsAffirmed,
  openReserviceCallbacks,
  openCallbackExistsForLane,
};
