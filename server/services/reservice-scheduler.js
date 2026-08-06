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

// The two self-bookable callback lanes. serviceKey resolves the catalog row
// (services.service_key) at commit time — id/name/duration are read live from
// the catalog so an admin rename or duration change flows through without a
// deploy. fallbackDuration only covers a missing/duration-less catalog row.
const RESERVICE_LANES = {
  pest: { serviceKey: 'pest_re_service', label: 'Pest Control Re-Service', fallbackDuration: 45 },
  lawn: { serviceKey: 'lawn_re_service', label: 'Lawn Care Re-Service', fallbackDuration: 60 },
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
function laneForCallbackRow({ serviceKey, serviceType } = {}) {
  if (serviceKey === RESERVICE_LANES.lawn.serviceKey) return 'lawn';
  if (serviceKey === RESERVICE_LANES.pest.serviceKey) return 'pest';
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
async function reserviceLanesForCustomer(customer, dbh = db, { lockCoverage = false, coverageScope = null } = {}) {
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
  }
  return ['pest', 'lawn'].filter((lane) => lanes.has(lane));
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
async function openReserviceCallbacks(customerId) {
  if (!customerId) return {};
  const rows = await db('scheduled_services as s')
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
async function openCallbackExistsForLane(dbh, customerId, lane) {
  if (!customerId || !RESERVICE_LANES[lane]) return false;
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
  openReserviceCallbacks,
  openCallbackExistsForLane,
};
