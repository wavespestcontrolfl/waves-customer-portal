/**
 * South-zone day funnel (GATE_SOUTH_ZONE_DAY_FUNNEL) — cluster estimate
 * bookings for far-south service zones onto days the fleet is already down
 * there, instead of scattering one-off Venice-and-south trips across the week.
 *
 * Two-step policy, evaluated per request over THAT request's date window:
 *   1. clustered — the window already has live scheduled stops in the
 *      estimate's zone: only those days' slots are offered.
 *   2. seeded — the window has NO zone stop yet: exactly ONE day is offered
 *      (the cheapest-detour day when route data exists, else the soonest
 *      bookable day), so the first booking CREATES the cluster day that later
 *      customers in the zone funnel onto. reserveSlot stamps the zone slug on
 *      the hold row, which is what makes the seed visible to step 1.
 *
 * Deliberate boundaries:
 *   - Offer-time only. There is NO redemption re-check in reserveSlot: the
 *     signed slot offer (slot-offer-token) already binds surface + estimate +
 *     date, so a customer can only tap a day this funnel genuinely offered —
 *     and unlike an owner blackout, a cluster day shifting between offer and
 *     tap doesn't make the offered slot wrong, just no-longer-preferred.
 *   - Window-scoped by design. The default rolling 14-day picker hard-funnels;
 *     an explicit single-date request (calendar pin, AI "next Tuesday" search)
 *     evaluates only that day, so a day without zone stops seeds rather than
 *     returning nothing — a deliberate escape hatch: refusing an explicitly
 *     requested day loses the booking, which costs more than one loose trip.
 *   - WHICH cities form the zone stays DB-authoritative (service_zones.cities
 *     → resolveEstimateZone); this module only names the zone(s) to funnel,
 *     by slug. Zone-stop matching mirrors filterCollidingSlots exactly (zone
 *     slug OR customer city, both case-insensitive) so the two can't drift.
 *
 * Fail-open like blackout-dates: any lookup failure disables the funnel for
 * that request (full pool offered) — a scattered offer beats no offer.
 */

const logger = require('../logger');
const { zoneSlugOf } = require('../slot-zone');
const { isEnabled } = require('../../config/feature-gates');

// Funneled zone slugs (zoneSlugOf format — 'Venice / North Port' → 'venice').
// Override without a deploy via SOUTH_FUNNEL_ZONE_SLUGS (comma-separated);
// read at call time so a Railway variable edit takes effect on restart only,
// same as the gate itself.
const DEFAULT_FUNNEL_ZONE_SLUGS = 'venice';

function funnelZoneSlugs() {
  return new Set(
    String(process.env.SOUTH_FUNNEL_ZONE_SLUGS || DEFAULT_FUNNEL_ZONE_SLUGS)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isFunnelZone(estimateZone) {
  if (!isEnabled('southZoneDayFunnel')) return false;
  const slug = zoneSlugOf(estimateZone);
  return !!slug && funnelZoneSlugs().has(slug);
}

// True when a live scheduled_services row belongs to the estimate's zone —
// the SAME dual match filterCollidingSlots uses (zone slug or customer city):
// legacy rows carry historical slugs ('venice_north_port'), so the city leg
// is what catches them.
function rowMatchesZone(row, estimateZone, zoneSlug, zoneCities) {
  const rowZone = String(row?.zone || '').toLowerCase();
  const rowCity = String(row?.customer_city || '').toLowerCase();
  return (!!zoneSlug && rowZone === zoneSlug) || (!!rowCity && zoneCities.has(rowCity));
}

// Statuses whose rows are NOT a planned truck-in-zone that day. Stricter
// than filterCollidingSlots' cancelled-only exclusion on purpose: there,
// over-inclusion only hides a window; here a 'rescheduled' phantom or
// 'skipped' visit would invent a cluster day with no real stop and steer
// new bookings onto it. completed/no_show/en_route/on_site stay included —
// they only occur on today's date and mean the truck genuinely is (or was)
// in the zone.
const NON_STOP_STATUSES = ['cancelled', 'rescheduled', 'skipped'];

// Distinct YYYY-MM-DD dates in [dateFrom, dateTo] with at least one live
// scheduled service (assigned or unassigned — either means a truck is in the
// zone that day) matching the estimate's zone. Hold rows count only while
// unexpired, mirroring filterCollidingSlots.
async function zoneStopDates(dbc, estimateZone, dateFrom, dateTo) {
  const rows = await dbc('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .whereBetween('scheduled_services.scheduled_date', [dateFrom, dateTo])
    .whereNotIn('scheduled_services.status', NON_STOP_STATUSES)
    .andWhere((q) => {
      q.whereNull('scheduled_services.reservation_expires_at').orWhereRaw('scheduled_services.reservation_expires_at > NOW()');
    })
    .select(
      'scheduled_services.scheduled_date',
      'scheduled_services.zone',
      'customers.city as customer_city',
    );

  const zoneSlug = zoneSlugOf(estimateZone);
  const zoneCities = new Set(
    (estimateZone?.cities || []).map((c) => String(c || '').toLowerCase()).filter(Boolean),
  );
  const dates = new Set();
  for (const row of rows) {
    if (!rowMatchesZone(row, estimateZone, zoneSlug, zoneCities)) continue;
    const date = row.scheduled_date instanceof Date
      ? row.scheduled_date.toISOString().slice(0, 10)
      : String(row.scheduled_date).slice(0, 10);
    if (date) dates.add(date);
  }
  return dates;
}

// Set of zone-stop dates when the funnel applies to this estimate's zone,
// null when it doesn't (gate off, no/other zone, or lookup failure — the
// null contract is "leave the pool alone").
async function getZoneFunnelDays(dbc, { estimateZone, dateFrom, dateTo }) {
  if (!isFunnelZone(estimateZone)) return null;
  try {
    return await zoneStopDates(dbc, estimateZone, dateFrom, dateTo);
  } catch (err) {
    logger.warn(`[zone-day-funnel] zone-stop lookup failed (failing open): ${err.message}`);
    return null;
  }
}

// Pure pool filter. funnelDays null → untouched. Otherwise clustered mode
// keeps only zone-stop days; when none of those days survives in the pool
// (no zone stop in the window, or every zone day's windows are gone), seeded
// mode keeps exactly one day: the first preferredSeedDate present in the
// pool (callers pass find-time's score-ordered dates, so this is the
// cheapest-detour day) or the soonest date. Returns the surviving slots plus
// a metadata descriptor (null when the funnel didn't apply).
function applyZoneDayFunnel(bookable, funnelDays, { preferredSeedDates = [] } = {}) {
  const pool = Array.isArray(bookable) ? bookable : [];
  if (!funnelDays || !pool.length) return { slots: pool, funnel: null };

  const clustered = pool.filter((s) => s?.date && funnelDays.has(s.date));
  if (clustered.length) return { slots: clustered, funnel: { mode: 'clustered' } };

  const poolDates = new Set(pool.map((s) => s?.date).filter(Boolean));
  const seedDate = preferredSeedDates.find((d) => poolDates.has(d))
    || [...poolDates].sort()[0];
  if (!seedDate) return { slots: [], funnel: { mode: 'seeded', seedDate: null } };
  return {
    slots: pool.filter((s) => s?.date === seedDate),
    funnel: { mode: 'seeded', seedDate },
  };
}

module.exports = {
  getZoneFunnelDays,
  applyZoneDayFunnel,
  isFunnelZone,
  // Exposed for tests.
  _internals: { funnelZoneSlugs, rowMatchesZone, zoneStopDates },
};
