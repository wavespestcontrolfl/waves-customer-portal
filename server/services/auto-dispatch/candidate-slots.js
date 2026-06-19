/**
 * Candidate-slot generation for auto-dispatch.
 *
 * Reuses the existing travel-aware slot finder (services/scheduling/find-time.js
 * findAvailableSlots) over the eligible date window, then applies the HARD
 * constraints auto-dispatch adds on top:
 *   - drop any slot inside the customer's blackout window
 *   - drop any technician whose capability row for the service category is
 *     explicitly deactivated (capability is otherwise a soft scoring factor)
 *
 * Also computes the CURRENT placement's marginal drive cost (detour the visit
 * adds to its present day/route) so the scorer can measure improvement.
 */
const { findAvailableSlots } = require('../scheduling/find-time');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { resolveGeo, driveMin, HQ } = require('./geo');

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

/**
 * Marginal drive minutes the visit adds to its CURRENT day's route, plus how
 * many stops share that day. HQ book-ends the day. Mirrors find-time's gap math.
 */
async function computeCurrentPlacement(service, prefs, ctx) {
  const geo = resolveGeo(service);
  const dateStr = String(service.scheduled_date).split('T')[0];
  const techId = service.technician_id || null;
  const category = prefs.service_category;

  let neighbors = [];
  if (techId) {
    const rows = await ctx.db('scheduled_services')
      .where('scheduled_services.scheduled_date', dateStr)
      .where('scheduled_services.technician_id', techId)
      .whereNot('scheduled_services.id', service.id)
      .whereNotIn('scheduled_services.status', ['cancelled', 'completed', 'skipped'])
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

  const dateFrom = etDateString(addETDays(ctx.nowDate, ctx.lockWindowDays + 1));
  const dateTo = etDateString(addETDays(ctx.nowDate, ctx.lookaheadDays));
  const duration = service.estimated_duration_minutes || DEFAULT_DURATION;
  const category = prefs.service_category;

  const res = await findAvailableSlots({
    lat: geo.lat,
    lng: geo.lng,
    durationMinutes: duration,
    dateFrom,
    dateTo,
    topN: ctx.fetchCap || FETCH_CAP, // full feasible set; HARD filters run before trim
    excludeServiceIds: [service.id],
    slotStepMinutes: 60, // stops are always on the hour — never 10:15 / 1:30 starts
  });

  const slots = (res && res.slots) || [];
  const candidates = [];
  for (const slot of slots) {
    if (inBlackout(slot.date, prefs.blackout)) continue;                // HARD: blackout
    const techId = slot.technician && slot.technician.id;
    const cap = ctx.capabilityFor(techId, category);
    if (cap === 'deactivated') continue;                                // HARD: tech turned off for this category
    candidates.push({
      is_current: false,
      date: slot.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
      detour_minutes: slot.detour_minutes,
      total_drive_minutes: slot.total_drive_minutes,
      stops_that_day: slot.stops_that_day,
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
  return { current, candidates: scored };
}

module.exports = { findValidCandidateSlots, computeCurrentPlacement, inBlackout, _internals: { hhmmToMin } };
