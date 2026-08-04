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

/**
 * Which re-service lanes this customer may self-book, from LIVE plan state:
 * upcoming (today-or-later, non-terminal) recurring coverage rows classify
 * into pest/lawn; an active WaveGuard membership row (tier / legacy
 * monthly_rate — isMembershipCustomerRow) grants the pest lane even when the
 * series is between seeded extensions. Callback rows themselves never count
 * as coverage (a free re-service must not entitle the next one on its own —
 * same exclusion serviceRowCountsTowardWaveGuard applies for tier math).
 *
 * Returns ['pest'], ['lawn'], ['pest','lawn'], or [] (not eligible).
 */
async function reserviceLanesForCustomer(customer) {
  if (!customer?.id) return [];
  const lanes = new Set();
  if (isMembershipCustomerRow(customer)) lanes.add('pest');
  try {
    const rows = await db('scheduled_services as s')
      .leftJoin('services as sv', 's.service_id', 'sv.id')
      .where('s.customer_id', customer.id)
      .where('s.is_recurring', true)
      .whereNotIn('s.status', TERMINAL_STATUSES)
      .where('s.scheduled_date', '>=', etDateString())
      .select('s.service_type', 's.is_callback', 'sv.service_key', 'sv.category')
      .limit(200);
    for (const row of rows) {
      if (row.is_callback === true) continue;
      if (isReService({ serviceKey: row.service_key, serviceType: row.service_type })) continue;
      const lane = laneForCoverageRow({ category: row.category, serviceType: row.service_type });
      if (lane) lanes.add(lane);
    }
  } catch (err) {
    // Fail toward the membership-row answer only — a query hiccup must not
    // 500 the portal payload; the public route still re-checks at commit.
    logger.warn(`[reservice-scheduler] lane lookup failed for customer ${customer.id}: ${err.message}`);
  }
  return ['pest', 'lawn'].filter((lane) => lanes.has(lane));
}

/**
 * Open (pending/confirmed, today-or-later) callback visits for the customer,
 * keyed by lane — the dedupe that keeps the page from booking a SECOND free
 * re-service in the same lane, and the tie-in that hands the customer the
 * existing visit's /reschedule link instead ("already booked — move it").
 */
async function openReserviceCallbacks(customerId) {
  if (!customerId) return {};
  const rows = await db('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', ['pending', 'confirmed'])
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

module.exports = {
  RESERVICE_LANES,
  reserviceSelfServeEnabled,
  laneForCoverageRow,
  laneForCallbackRow,
  reserviceLanesForCustomer,
  openReserviceCallbacks,
};
