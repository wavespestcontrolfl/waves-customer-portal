/**
 * South-zone day funnel (GATE_SOUTH_ZONE_DAY_FUNNEL) — cluster estimate
 * bookings for far-south service zones onto days the fleet is already down
 * there, instead of scattering one-off Venice-and-south trips across the week.
 *
 * Two-step policy, evaluated per request over THAT request's date window:
 *   1. clustered — the window already has live scheduled stops in the
 *      estimate's zone: only those days' slots are offered.
 *   2. seeded — no cluster-day slot is bookable in the window (no zone stop
 *      yet, or every zone-stop day's windows are taken/filtered): exactly
 *      ONE day is offered (the cheapest-detour day when route data exists,
 *      else the soonest bookable day), so the booking CREATES or EXTENDS the
 *      cluster days later customers funnel onto. Seeding on a FULL cluster
 *      day is deliberate — returning nothing there loses the booking, and a
 *      full zone day means it's time to open the next one. reserveSlot
 *      stamps the zone slug on the hold row, which is what makes a seed
 *      visible to step 1.
 *
 * Deliberate boundaries:
 *   - Offer-time only. There is NO redemption re-check in reserveSlot: the
 *     signed slot offer (slot-offer-token) already binds surface + estimate +
 *     date, so a customer can only tap a day this funnel genuinely offered —
 *     and unlike an owner blackout, a cluster day shifting between offer and
 *     tap doesn't make the offered slot wrong, just no-longer-preferred.
 *     ACCEPTED RACE (deliberate): two customers holding pre-cluster seed
 *     offers for different days can both redeem, creating two "cluster"
 *     days for that stretch. A redemption-side funnel check can't close it
 *     safely — the redeem side cannot know the offer's window (a pinned
 *     single-date request legitimately seeds a non-cluster day), so any
 *     horizon-wide re-check reintroduces the offer→reserve→409 dead-end
 *     loop (see filterCollidingSlots history). The race's worst case is
 *     exactly the pre-funnel status quo (one extra scattered trip), bounded
 *     by the offer-token TTL, and self-heals: funneled results are never
 *     cached, so the first redeemed seed clusters every subsequent offer.
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
// same as the gate itself. 'port charlotte' is included by default because a
// seeded Port Charlotte service_zones row exists (20260401000048) — even
// after its cities are consolidated into the Venice row, keeping the slug
// here means an estimate that still resolves to it funnels instead of
// silently falling outside the rollout.
const DEFAULT_FUNNEL_ZONE_SLUGS = 'venice,port charlotte';

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

// True when a live scheduled_services row belongs to the estimate's zone.
// Deliberately STRICTER than filterCollidingSlots' unconditional
// slug-OR-city match (over-inclusion there only hides a window; here it
// invents a cluster day): a non-empty zone stamp is authoritative — a
// multi-property customer whose primary city is Venice must not reclassify
// a stop stamped for another zone as a Venice stop. Legacy backfill slugs
// are underscore compounds of the modern slug ('venice_north_port' for
// 'venice'), matched by prefix. For unstamped rows, the visit-level
// service city outranks the linked customer's primary city (multi-property
// call bookings stamp the DESTINATION in service_address_city and leave
// zone null — call-recording-processor's insert); customer city is the
// fallback only when no service city was stamped.
function rowMatchesZone(row, estimateZone, zoneSlug, zoneCities) {
  const rowZone = String(row?.zone || '').toLowerCase();
  if (rowZone) {
    return !!zoneSlug && (rowZone === zoneSlug || rowZone.startsWith(`${zoneSlug}_`));
  }
  const rowCity = String(row?.service_city || row?.customer_city || '').trim().toLowerCase();
  return !!rowCity && zoneCities.has(rowCity);
}

// Statuses whose rows are NOT a planned truck-in-zone that day — the
// repo's established route-stop classifier (stops-ahead.js): cancelled,
// skipped, no_show, rescheduled. Stricter than filterCollidingSlots'
// cancelled-only exclusion on purpose: there, over-inclusion only hides a
// window; here a phantom row would invent a cluster day with no real stop
// and steer new bookings onto it. completed/en_route/on_site stay
// included — they only occur on today's date and mean the truck genuinely
// is (or was) in the zone.
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

// Distinct YYYY-MM-DD dates in [dateFrom, dateTo] with at least one live
// scheduled service (assigned or unassigned — either means a truck is in the
// zone that day) matching the estimate's zone. Hold rows count only while
// unexpired, mirroring filterCollidingSlots.
async function zoneStopDates(dbc, estimateZone, dateFrom, dateTo) {
  const rows = await dbc('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .whereBetween('scheduled_services.scheduled_date', [dateFrom, dateTo])
    .whereNotIn('scheduled_services.status', NOT_A_ROUTE_STOP_STATUSES)
    .andWhere((q) => {
      q.whereNull('scheduled_services.reservation_expires_at').orWhereRaw('scheduled_services.reservation_expires_at > NOW()');
    })
    .select(
      'scheduled_services.scheduled_date',
      'scheduled_services.zone',
      'scheduled_services.service_address_city as service_city',
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

// { days, failed }: `days` is the Set of zone-stop dates when the funnel
// applies to this estimate's zone, null when it doesn't (gate off, no/other
// zone, or lookup failure — null means "leave the pool alone"). `failed`
// distinguishes a transient lookup failure from genuinely-inactive so the
// caller can keep fail-open REQUEST-scoped (e.g. not cache the unfunneled
// result and extend one bad lookup across the whole cache TTL).
async function getZoneFunnelDays(dbc, { estimateZone, dateFrom, dateTo }) {
  if (!isFunnelZone(estimateZone)) return { days: null, failed: false };
  try {
    return { days: await zoneStopDates(dbc, estimateZone, dateFrom, dateTo), failed: false };
  } catch (err) {
    logger.warn(`[zone-day-funnel] zone-stop lookup failed (failing open): ${err.message}`);
    return { days: null, failed: true };
  }
}

// Pure pool filter. funnelDays null → untouched. Otherwise clustered mode
// keeps only zone-stop days; when none of those days survives in the pool
// (no zone stop in the window, or every zone day's windows are taken or
// filtered — seeding on a full cluster day is deliberate, see header),
// seeded mode keeps exactly one day: the first preferredSeedDate present in
// the pool (callers pass find-time's score-ordered dates, so this is the
// cheapest-detour day) or the soonest date. Returns the surviving slots plus
// a metadata descriptor — null when the funnel didn't apply, INCLUDING the
// empty-input case, so cache decisions must key off funnelDays, not this.
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
