/**
 * Candidate-slot generation for auto-dispatch.
 *
 * Reuses the existing travel-aware slot finder (services/scheduling/find-time.js
 * findAvailableSlots) over the eligible date window, then applies the HARD
 * constraints auto-dispatch adds on top:
 *   - drop any slot inside the customer's blackout window
 *   - drop any slot NOT on the customer's EXPLICIT preferred day (portal pref)
 *   - drop any slot OUTSIDE the customer's EXPLICIT preferred time window (portal)
 *   - drop any technician whose capability row for the service category is
 *     explicitly deactivated (capability is otherwise a soft scoring factor)
 *
 * Owner directive 2026-06-21: route efficiency is the optimization driver, but a
 * customer's portal scheduling preference OVERRIDES it. So an explicit preferred
 * day/time is a HARD filter here — route can only pick the most efficient slot
 * AMONG slots that honor the preference, never move the visit off it. The
 * service-type DEFAULT time window (pest→AM, lawn→mid-AM) is NOT a customer
 * preference and is left to soft scoring (scoring.js), so route stays free to
 * optimize around it when the customer set no time.
 *
 * Also computes the CURRENT placement's marginal drive cost (detour the visit
 * adds to its present day/route) so the scorer can measure improvement.
 */
const { findAvailableSlots } = require('../scheduling/find-time');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { resolveGeo, driveMin, HQ } = require('./geo');
const { toDateStr, shiftDateStr } = require('./dates');

const DAY_OPEN = 8 * 60;
const DAY_CLOSE = 17 * 60;
const DEFAULT_DURATION = 60;
// Pull the full feasible set so the HARD filters (blackout / capability) run
// BEFORE any top-N trim — otherwise a long early blackout could fill the first N
// find-time results and wrongly yield NO_VALID_SLOT. Then cap how many survivors
// we actually score to bound cost.
const FETCH_CAP = 1000;
const SCORE_CAP = 80;

function hhmmToMin(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

function inBlackout(dateStr, blackout) {
  return !!(blackout && dateStr >= blackout.start && dateStr <= blackout.end);
}

// Weekday 0=Sun..6=Sat of a YYYY-MM-DD calendar date, tz-independent (noon UTC).
// Mirrors scoring.js weekdayOf so the HARD day filter and the soft day score
// agree on which weekday a candidate falls on.
function weekdayOf(dateStr) {
  const d = new Date(`${String(dateStr).split('T')[0]}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

// find-time suppresses Sundays by default but NOT Saturdays; honor skip_weekends.
function isSaturday(dateStr) {
  return weekdayOf(dateStr) === 6;
}

// HARD: the customer set an explicit preferred day in the portal and this slot
// is not on it. preferred_day_indexes is empty when the customer has no day
// preference (→ no filter; route is free to pick any day).
function violatesPreferredDay(dateStr, prefs) {
  const dayIdx = prefs.preferred_day_indexes;
  if (!dayIdx || dayIdx.length === 0) return false;
  const dow = weekdayOf(dateStr);
  return dow == null || !dayIdx.includes(dow);
}

// HARD: the customer set an explicit preferred time in the portal and this
// slot's start falls outside it. Uses preferred_time_window (the EXPLICIT pref),
// NOT effective/default — the service-type default window is soft scoring only.
// Boundary semantics mirror scoring.js: [startMin, endMin).
function violatesPreferredTime(startTime, prefs) {
  const win = prefs.preferred_time_window;
  if (!win) return false;
  const startMin = hhmmToMin(startTime);
  if (startMin == null) return false; // unparseable start → don't hard-drop
  return startMin < win.startMin || startMin >= win.endMin;
}

/**
 * Marginal drive minutes the visit adds to its CURRENT day's route, plus how
 * many stops share that day. HQ book-ends the day. Mirrors find-time's gap math.
 */
async function computeCurrentPlacement(service, prefs, ctx) {
  const geo = resolveGeo(service);
  const dateStr = toDateStr(service.scheduled_date);
  const techId = service.technician_id || null;
  const category = prefs.service_category;

  let neighbors = [];
  if (techId) {
    const rows = await ctx.db('scheduled_services')
      .where('scheduled_services.scheduled_date', dateStr)
      .where('scheduled_services.technician_id', techId)
      .whereNot('scheduled_services.id', service.id)
      // 'rescheduled' phantom rows keep a stale date until staff action them —
      // not a real stop the tech will work, so exclude from detour/density too.
      .whereNotIn('scheduled_services.status', ['cancelled', 'completed', 'skipped', 'rescheduled'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(
        'scheduled_services.id',
        'scheduled_services.window_start',
        'scheduled_services.window_end',
        'scheduled_services.estimated_duration_minutes',
        'scheduled_services.lat as svc_lat',
        'scheduled_services.lng as svc_lng',
        'customers.latitude as customer_latitude',
        'customers.longitude as customer_longitude',
      );
    neighbors = rows
      .map((r) => {
        const startMin = hhmmToMin(r.window_start) ?? DAY_OPEN;
        return {
          geo: resolveGeo(r),
          startMin,
          endMin: hhmmToMin(r.window_end) ?? (startMin + (r.estimated_duration_minutes || DEFAULT_DURATION)),
        };
      })
      .filter((n) => n.geo)
      .sort((a, b) => a.startMin - b.startMin);
  }

  const myStart = hhmmToMin(service.window_start) ?? DAY_OPEN;
  const anchors = [
    { geo: HQ, startMin: DAY_OPEN, endMin: DAY_OPEN },
    ...neighbors,
    { geo: HQ, startMin: DAY_CLOSE, endMin: DAY_CLOSE },
  ];
  let prev = anchors[0];
  let next = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].startMin <= myStart) prev = anchors[i];
  }
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (anchors[i].startMin >= myStart) next = anchors[i];
  }

  let detour = 0;
  if (geo) {
    detour = Math.max(0, driveMin(prev.geo, geo) + driveMin(geo, next.geo) - driveMin(prev.geo, next.geo));
  }

  return {
    is_current: true,
    detour_minutes: detour,
    total_drive_minutes: geo ? driveMin(prev.geo, geo) + driveMin(geo, next.geo) : 0,
    stops_that_day: neighbors.length + 1,
    technician_id: techId,
    date: dateStr,
    start_time: service.window_start ? String(service.window_start).slice(0, 5) : null,
    capability_level: ctx.capabilityFor(techId, category),
  };
}

async function findValidCandidateSlots(service, prefs, ctx) {
  const geo = resolveGeo(service);
  if (!geo) return { current: null, candidates: [], note: 'no_geo' };

  // Search within ± tolerance days of the visit's CURRENT date (clamped to the
  // lock floor and lookahead horizon) so optimization tightens the route without
  // collapsing the recurring cadence by pulling the visit far from its date.
  const lockFloor = etDateString(addETDays(ctx.nowDate, ctx.lockWindowDays + 1));
  const horizonCap = etDateString(addETDays(ctx.nowDate, ctx.lookaheadDays));
  const origDate = toDateStr(service.scheduled_date);
  const tol = ctx.dateToleranceDays || 7;
  let dateFrom = shiftDateStr(origDate, -tol);
  if (!dateFrom || dateFrom < lockFloor) dateFrom = lockFloor;
  let dateTo = shiftDateStr(origDate, tol);
  if (!dateTo || dateTo > horizonCap) dateTo = horizonCap;
  if (dateFrom > dateTo) {
    // Window collapsed (visit sits at the very edge of the horizon) — nothing to do.
    const current = await computeCurrentPlacement(service, prefs, ctx);
    return { current, candidates: [], drops: null, feasible: 0 };
  }
  const duration = service.estimated_duration_minutes || DEFAULT_DURATION;
  const category = prefs.service_category;

  // Dates already occupied by another occurrence of THIS recurring series. The
  // rebooker only checks tech-time overlap, so without this two visits from the
  // same series could land on the same day (different time/tech). HARD filter.
  // ALL non-cancelled rows of the series — including booster-month rows. The
  // scheduler dedupes base recurring dates against boosters to avoid a
  // base+booster same-day double-booking, and the rebooker only checks
  // technician-time overlap, so boosters must block candidate dates too.
  const parentId = service.recurring_parent_id || service.id;
  const siblingRows = await ctx.db('scheduled_services')
    .where(function () { this.where('id', parentId).orWhere('recurring_parent_id', parentId); })
    .whereNot('id', service.id)
    // 'rescheduled' siblings are phantom customer requests on a stale date, so
    // they must NOT block an actually-open day (mirrors the seeder's dedup).
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .whereBetween('scheduled_date', [dateFrom, dateTo])
    .select('scheduled_date');
  const siblingDates = new Set(siblingRows.map((r) => toDateStr(r.scheduled_date)));

  const findTimeArgs = {
    lat: geo.lat,
    lng: geo.lng,
    durationMinutes: duration,
    dateFrom,
    dateTo,
    excludeServiceIds: [service.id],
    slotStepMinutes: 60, // stops are always on the hour — never 10:15 / 1:30 starts
    // HARD time preference must enter slot GENERATION, not just post-filtering:
    // find-time emits only each gap's earliest-feasible start, so an empty day
    // with an afternoon preference would yield a single 08:00 candidate that the
    // post-filter drops — never generating the valid 13:00 start. Floor the gap's
    // earliest start at the window start so a preferred-time candidate is emitted.
    // The window UPPER bound + the preferred-DAY constraint stay post-filters
    // (each date is enumerated separately, so day filtering can't collapse a gap).
    ...(prefs.preferred_time_window
      ? { earliestStartMin: prefs.preferred_time_window.startMin }
      : {}),
    // NOTE: occupancy keeps find-time's default ['cancelled'] so it stays
    // consistent with SmartRebooker's overlap check (which treats 'rescheduled'
    // as a conflict). Excluding it here would propose slots apply then rejects.
  };
  // find-time route-RANKS (lowest detour first) then truncates to topN. Our HARD
  // filters (blackout, sibling, weekend, explicit preferred day/time, deactivated
  // tech) run AFTER, so if the route-best topN are all filtered out while a valid
  // slot sits just past the cap, we'd wrongly report no candidate — i.e. route
  // ranking would silently gate what the hard preference filter can see. Bound the
  // first pass at FETCH_CAP, but if it truncated (total_feasible > returned),
  // re-fetch the FULL feasible set so the hard filters see every slot. The window
  // is only ±tolerance days, so the full set is small; the re-fetch is rare (never
  // at current crew size) and only pays off in a dense window.
  let res = await findAvailableSlots({ ...findTimeArgs, topN: ctx.fetchCap || FETCH_CAP });
  let slots = (res && res.slots) || [];
  if (res && typeof res.total_feasible === 'number' && res.total_feasible > slots.length) {
    res = await findAvailableSlots({ ...findTimeArgs, topN: res.total_feasible });
    slots = (res && res.slots) || [];
  }

  // Drop tally — why feasible slots were rejected. Surfaced to the audit so an
  // empty candidate set reads as "honored the customer's preference, nothing
  // better available" rather than an opaque NO_VALID_SLOT.
  const drops = { blackout: 0, sibling: 0, weekend: 0, preferred_day: 0, preferred_time: 0, deactivated: 0 };
  const candidates = [];
  for (const slot of slots) {
    if (inBlackout(slot.date, prefs.blackout)) { drops.blackout++; continue; }       // HARD: blackout
    if (siblingDates.has(slot.date)) { drops.sibling++; continue; }                  // HARD: same-series occurrence that day
    if (service.skip_weekends === true && isSaturday(slot.date)) { drops.weekend++; continue; } // HARD: skip_weekends series
    // HARD: explicit portal preferences override route efficiency. Route may
    // only optimize among slots on the customer's preferred day + time window.
    if (violatesPreferredDay(slot.date, prefs)) { drops.preferred_day++; continue; }
    if (violatesPreferredTime(slot.start_time, prefs)) { drops.preferred_time++; continue; }
    const techId = slot.technician && slot.technician.id;
    const cap = ctx.capabilityFor(techId, category);
    if (cap === 'deactivated') { drops.deactivated++; continue; }                    // HARD: tech turned off for this category
    candidates.push({
      is_current: false,
      date: slot.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
      detour_minutes: slot.detour_minutes,
      total_drive_minutes: slot.total_drive_minutes,
      // find-time reports stops BEFORE insertion; +1 for the moved visit so it
      // matches the current placement's count (which includes the visit itself).
      stops_that_day: (slot.stops_that_day || 0) + 1,
      technician_id: techId || null,
      technician_name: (slot.technician && slot.technician.name) || null,
      capability_level: cap,
      find_time_score: slot.score,
    });
  }

  // find-time returns slots sorted best-first (lowest detour); after the HARD
  // filters, score only the top survivors to bound cost.
  const scored = candidates.slice(0, ctx.scoreCap || SCORE_CAP);
  const current = await computeCurrentPlacement(service, prefs, ctx);
  return { current, candidates: scored, drops, feasible: slots.length };
}

module.exports = {
  findValidCandidateSlots,
  computeCurrentPlacement,
  inBlackout,
  violatesPreferredDay,
  violatesPreferredTime,
  _internals: { hhmmToMin, weekdayOf },
};
