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
 * Per truck (GATE_MULTI_TECH_CONFIRM, read through occupancy.js
 * techScopedConfirmActive like every tech-scoped check; owner 2026-11-19
 * "build south"): getZoneFunnelDays also returns each zone day's technicians
 * (techDays), and onZoneDay decides whether a date is a zone day for one
 * technician: a stop of that technician, or an unassigned stop (any truck may
 * take it). The night run's far-south rule (auto-dispatch/south-day-kept.js)
 * reads it. The booking pages (the estimate page, the assessment link) follow
 * owner rule B (2026-11-19, "Only the truck that is already going south that
 * day"): dropOtherTruckDays removes each opening of a truck on another
 * truck's zone day, and it runs on the openings BEFORE a page chooses among
 * trucks (one technician per start, the one-per-hour collapse, the line
 * rule's home-first start, the seed day, the customer route check and its
 * floor). Each of those choices then runs exactly as with one truck, over
 * what the rule allows: clustered keeps the zone trucks' own days, seeded
 * opens one new day (no truck goes south on it yet; never empty when such a
 * day has an opening). The assessment link's commit rebuild drops the same
 * openings, because that commit books whichever truck its rebuild finds at
 * the picked date and start (the estimate page books the signed slot's own
 * technician); its booking transaction re-checks the truck under the date
 * lock (truckMayTakeDate), because two commits can rebuild the same new day
 * before either inserts. Off, every zone day is the fleet's, as with one
 * truck.
 *
 * Fail-open like blackout-dates: any lookup failure disables the funnel for
 * that request (full pool offered) — a scattered offer beats no offer.
 */

const logger = require('../logger');
const { zoneSlugOf, resolveEstimateZone } = require('../slot-zone');
const { isEnabled } = require('../../config/feature-gates');

// The per-truck switch: the scheduler's one technician-scope reader (occupancy.js techScopedConfirmActive,
// GATE_MULTI_TECH_CONFIRM), read at call time. A read that throws (a suite that mocks occupancy or feature-gates
// down to a few functions) reads as off, every zone day the fleet's, and never fails the zone lookup.
function perTruckLive() {
  try {
    return require('./occupancy').techScopedConfirmActive() === true;
  } catch {
    return false;
  }
}

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

// The 2026-08-24 consolidation moved zone OWNERSHIP of the deep-south
// cities into the Venice / North Port row, but the retained Port Charlotte
// row's center stays the right coordinate FALLBACK for them — Venice's
// center sits ~25mi north, and handing it to a coord-less deep-south
// booking distorts detour scoring. The fallbackZoneCenter consumers
// (booking.js, estimate-slot-availability.js) resolve city → zone via
// service_zones.cities, which can no longer reach the emptied Port
// Charlotte row, so they consult this alias BEFORE the cities scan.
// Englewood is deliberately absent: it never lived in the Port Charlotte
// row (pre-consolidation it resolved to no center at all) and sits
// mid-corridor between the two centers.
const DEEP_SOUTH_CENTER_ZONE_NAME = 'port charlotte';
const DEEP_SOUTH_CENTER_CITIES = new Set([
  'port charlotte', 'punta gorda', 'murdock',
  'rotonda west', 'placida', 'boca grande',
]);

// zone_name (lowercased) whose center should serve as the coordinate
// fallback for `city`, or null when the normal cities scan should decide.
function fallbackCenterZoneName(city) {
  const c = String(city || '').trim().toLowerCase();
  return DEEP_SOUTH_CENTER_CITIES.has(c) ? DEEP_SOUTH_CENTER_ZONE_NAME : null;
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
// admin-schedule's getZone() returns this for ANY city it doesn't
// recognize, so a 'lakewood_ranch' stamp is the one stamp that is NOT
// authoritative evidence against a city match — historical south-city
// appointments carry it (getZone's list predates the deep-south corridor).
// A genuine Lakewood Ranch row still stays excluded through the city leg.
const FALLTHROUGH_ZONE_STAMP = 'lakewood_ranch';

// Slug equivalence for stamped rows. Direct/prefix match first; beyond
// that, every slug in the funnel list names the SAME consolidated south
// pool (the migration merged the legacy Port Charlotte zone's cities into
// Venice / North Port, but rows stamped 'port charlotte' while that zone
// was live remain correct history) — so a row stamped with one funneled
// slug is cluster evidence for an estimate resolving another.
function slugMatchesZone(rowZone, zoneSlug) {
  if (!zoneSlug) return false;
  if (rowZone === zoneSlug || rowZone.startsWith(`${zoneSlug}_`)) return true;
  const slugs = funnelZoneSlugs();
  const inFunnel = (s) => slugs.has(s) || [...slugs].some((f) => s.startsWith(`${f}_`));
  return inFunnel(rowZone) && inFunnel(zoneSlug);
}

function rowMatchesZone(row, estimateZone, zoneSlug, zoneCities) {
  const rowZone = String(row?.zone || '').toLowerCase();
  if (rowZone && rowZone !== FALLTHROUGH_ZONE_STAMP) {
    return slugMatchesZone(rowZone, zoneSlug);
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

// The zone's stop days in [dateFrom, dateTo]. `dates`: the distinct
// YYYY-MM-DD dates with at least one live scheduled service (assigned or
// unassigned — either means a truck is in the zone that day) matching the
// estimate's zone. `techs`: each of those dates -> the technician ids of its
// stops (null = an unassigned stop). Hold rows count only while unexpired,
// mirroring filterCollidingSlots.
async function zoneStopDays(dbc, estimateZone, dateFrom, dateTo) {
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
      'scheduled_services.technician_id',
    );

  const zoneSlug = zoneSlugOf(estimateZone);
  const zoneCities = new Set(
    (estimateZone?.cities || []).map((c) => String(c || '').toLowerCase()).filter(Boolean),
  );
  const dates = new Set();
  const techs = new Map();
  for (const row of rows) {
    if (!rowMatchesZone(row, estimateZone, zoneSlug, zoneCities)) continue;
    const date = row.scheduled_date instanceof Date
      ? row.scheduled_date.toISOString().slice(0, 10)
      : String(row.scheduled_date).slice(0, 10);
    if (!date) continue;
    dates.add(date);
    if (!techs.has(date)) techs.set(date, new Set());
    techs.get(date).add(row.technician_id == null ? null : String(row.technician_id));
  }
  return { dates, techs };
}

// { days, techDays, failed }: `days` is the Set of zone-stop dates when the
// funnel applies to this estimate's zone, null when it doesn't (gate off,
// no/other zone, or lookup failure — null means "leave the pool alone").
// `techDays` is the per-truck view of the same days (date -> technician ids,
// null = an unassigned stop) when GATE_MULTI_TECH_CONFIRM is on, else null:
// every zone day is the fleet's. `failed` distinguishes a transient lookup
// failure from genuinely-inactive so the caller can keep fail-open
// REQUEST-scoped (e.g. not cache the unfunneled result and extend one bad
// lookup across the whole cache TTL).
async function getZoneFunnelDays(dbc, { estimateZone, dateFrom, dateTo }) {
  if (!isFunnelZone(estimateZone)) return { days: null, techDays: null, failed: false };
  try {
    const { dates, techs } = await zoneStopDays(dbc, estimateZone, dateFrom, dateTo);
    return { days: dates, techDays: perTruckLive() ? techs : null, failed: false };
  } catch (err) {
    logger.warn(`[zone-day-funnel] zone-stop lookup failed (failing open): ${err.message}`);
    return { days: null, techDays: null, failed: true };
  }
}

// Is `date` a zone day for technician `techId`? `days` = the zone-stop dates, `techDays` = their per-truck view
// (getZoneFunnelDays). Fleet-wide (techDays null) or no technician: any zone stop that day. Per truck: a stop of
// that technician, or an unassigned stop (any truck may take it).
function onZoneDay(date, techId, days, techDays) {
  if (!days.has(date)) return false;
  if (!techDays || techId == null) return true;
  const techs = techDays.get(date);
  return !!techs && (techs.has(null) || techs.has(String(techId)));
}

// Owner rule B per truck: the slots a booking page may offer before it chooses among trucks. A date with no zone
// stop stays open to every truck; a zone day only to its own trucks (onZoneDay: a stop of that technician, an
// unassigned stop, or a slot with no technician). `view` = getZoneFunnelDays' { days, techDays }; `techOf(slot)` reads
// a slot's technician id. Fleet-wide (techDays null) or no funnel (days null): the very same array.
function dropOtherTruckDays(slots, { days = null, techDays = null } = {}, techOf) {
  if (!days || !techDays || !Array.isArray(slots)) return slots;
  return slots.filter((slot) => !days.has(slot?.date) || onZoneDay(slot.date, techOf(slot), days, techDays));
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

// Owner rule B at commit, under the caller's date lock (the lead assessment link's booking transaction, through
// createSelfBooking's callbackVisit.slotGuard): may `technicianId` still take `date` for a booking at `address`? Two
// commits can rebuild the same new day before either inserts; the date lock serializes them, and this read on the
// locked transaction sees the first one's stop. true when the rule does not apply (gate off, fleet view, no address
// or technician, no funneled zone). Reads on `conn`; a query failure throws, so the caller's transaction fails
// closed like its other reads.
async function truckMayTakeDate(conn, { address, date, technicianId }) {
  if (!address || technicianId == null || !isEnabled('southZoneDayFunnel') || !perTruckLive()) return true;
  const estimateZone = await resolveEstimateZone(conn, { address });
  if (!isFunnelZone(estimateZone)) return true;
  const { dates, techs } = await zoneStopDays(conn, estimateZone, date, date);
  return !dates.has(date) || onZoneDay(date, technicianId, dates, techs);
}

// The funnel for an offer pool that is not built by the estimate page (the lead assessment link:
// routes/booking.js buildBookingAvailability, fed the lead's address text), read in two steps because that
// builder keeps one technician per date and start: offerFunnelView before its claims (per truck,
// dropOtherTruckDays runs on find-time's slots), funnelOfferPool after them. Same helpers, same rules: the zone
// resolves from the address text through resolveEstimateZone and the cluster days come from getZoneFunnelDays over
// THIS request's window. Returns { days, techDays }, or null when the funnel does not apply (gate off, no address,
// no funneled zone) or cannot be resolved (zone or lookup failure: logged, fail open, as the estimate page does).
// In the fleet view a one-day window funnels to itself (clustered or seeded, that day stays whole), so it reads
// nothing: the commit's single-day rebuild with the gate off runs exactly as before.
async function offerFunnelView({ address, dateFrom, dateTo, conn }) {
  if (!address || !isEnabled('southZoneDayFunnel')) return null;
  if (dateFrom === dateTo && !perTruckLive()) return null;
  let estimateZone = null;
  try {
    estimateZone = await resolveEstimateZone(conn, { address });
  } catch (err) {
    logger.warn(`[zone-day-funnel] offer zone resolution failed (failing open): ${err.message}`);
    return null;
  }
  const { days, techDays } = await getZoneFunnelDays(conn, { estimateZone, dateFrom, dateTo });
  return days ? { days, techDays } : null;
}

// applyZoneDayFunnel over an offer pool with offerFunnelView's `view`: the cluster days, or one seed day (the
// pool's score order, route day first). Returns `pool` itself (same array) when `view` is null or the pool empty.
async function funnelOfferPool(pool, view, { routeDaySlug = null, conn } = {}) {
  if (!view || !Array.isArray(pool) || !pool.length) return pool;
  let preferredSeedDates = [...new Set(pool.map((s) => s?.date).filter(Boolean))];
  if (routeDaySlug) {
    const { preferRouteDayDates, readZoneRouteDays } = require('./zone-route-days');
    preferredSeedDates = preferRouteDayDates(preferredSeedDates, {
      zoneSlug: routeDaySlug, config: await readZoneRouteDays(conn),
    });
  }
  return applyZoneDayFunnel(pool, view.days, { preferredSeedDates }).slots;
}

// The service_zones rows the funnel applies to right now (isFunnelZone: gate on AND slug in the funnel list). []
// with the gate off, without a query. Throws on query failure; callers decide how to degrade.
async function funnelZoneRows(dbc) {
  if (!isEnabled('southZoneDayFunnel')) return [];
  const zones = await dbc('service_zones').select('id', 'cities', 'zone_name');
  return zones.filter(isFunnelZone);
}

// Is this visit/stop row ({zone, service_city, customer_city}, the shape zoneStopDays matches) in one of the funneled
// zones (funnelZoneRows)? true / false, or null when the row carries no usable zone stamp and no city, so the funnel
// has nothing to decide on. Same matcher as the cluster days: rowMatchesZone.
function rowInFunnelZones(row, zones) {
  const stamp = String(row?.zone || '').toLowerCase();
  const city = String(row?.service_city || row?.customer_city || '').trim();
  if ((!stamp || stamp === FALLTHROUGH_ZONE_STAMP) && !city) return null;
  return zones.some((zone) => rowMatchesZone(row, zone, zoneSlugOf(zone),
    new Set((zone?.cities || []).map((c) => String(c || '').toLowerCase()).filter(Boolean))));
}

module.exports = {
  getZoneFunnelDays,
  applyZoneDayFunnel,
  dropOtherTruckDays,
  truckMayTakeDate,
  offerFunnelView,
  funnelOfferPool,
  funnelZoneRows,
  rowInFunnelZones,
  onZoneDay,
  perTruckLive,
  isFunnelZone,
  funnelZoneSlugs,
  fallbackCenterZoneName,
  // Exposed for tests.
  _internals: { funnelZoneSlugs, rowMatchesZone, zoneStopDays },
};
