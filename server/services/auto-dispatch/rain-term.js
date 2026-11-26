/**
 * Rain term for the 4:10 AM auto-dispatch night run (owner 2026-11-26,
 * GATE_AUTO_DISPATCH_RAIN_TERM, SHADOW ONLY in this release).
 *
 * The idea: an outdoor visit that sits on a forecast-wet day 3 to 6 days out
 * should drift to a drier day inside its own legal band, silently, before the
 * 72-hour reminder text. THIS RELEASE MOVES NOTHING. It records, on each
 * evaluated visit's audit row (constraints_checked.rain_term), what it would
 * do, so the owner can read real nights before any move is allowed.
 *
 * Mode: exactly 'shadow' records; anything else (unset, 'true', 'off') is off,
 * byte-identical: no forecast call, no extra read, no extra audit field.
 *
 * Once per run (start): the free NWS hourly forecast is read once per forecast
 * area (scheduling/forecast-zones.js ZONE_COORDS) with getNwsHourlyRainPatient: 10 s
 * wait and one retry per area, never the paid Open-Meteo backup. An area NWS
 * does not answer is unread, and visits there get no rain term.
 *
 * Day wetness (0..1) = the mean over the work hours (DAY_OPEN..DAY_CLOSE of
 * candidate-slots.js) of clamp((chance of rain - 30) / 50, 0, 1). The nearer
 * the day, the more the forecast is trusted (LEAD_TRUST).
 *
 * Per visit (note): the run's own per-visit hook, reached only by a visit the
 * run did not already skip (the reminder-off lock, the told lock, the
 * asked-time box and every other early exit never get here). A visit whose
 * date is 3 to 6 days out, in an area with a forecast, and with wetness x
 * trust at WET_SCORE or more, and that is outdoor work (rain-fit.js rainFitFor
 * 'avoid', by catalog identity), is searched for a drier legal date:
 *   - the band, neighbour fence and freeze are the run's own: the window the
 *     run resolved (guard.window, flex-tier.js flexTierMoveWindow) and
 *     flexWindowAdmits; a second window with a 73-hour landing floor comes
 *     from the SAME flexTierMoveWindow, by moving only its `today`.
 *   - the free slot is candidate-slots.js findValidCandidateSlots with the
 *     arrival search on and no road reader: the slot finder then asks the
 *     travel source for zero paid requests (find-time.js providerTravel false
 *     -> route-optimizer.js createSchedulingTravel maxRequests 0 -> preload
 *     returns before any fetch). Same technician only.
 * Two answers are kept: with the current 5-day landing floor
 * (route-tiers.js MIN_DESTINATION_DAYS_OUT) and with a 73-hour floor (an owner
 * decision pending). A visit that shares a stop with other live visits is not verified (the
 * grouped-move guard in apply.js writes, so no apply.js function is called here): its slot is
 * recorded as a `candidate` with would_move false. Nothing changes a placement, a score, a move, a text or
 * the change cap. Every function here never throws into the run.
 */
const logger = require('../logger');
const db = require('../../models/db');
const { toDateStr, shiftDateStr } = require('./dates');
const { daysBetween, MIN_DESTINATION_DAYS_OUT } = require('./route-tiers');
const flexTier = require('./flex-tier');
const moveRules = require('./move-rules');
const { DAY_OPEN, DAY_CLOSE } = require('./candidate-slots');
const { ZONE_COORDS, stopForecastZone } = require('../scheduling/forecast-zones');
const { getNwsHourlyRain, getNwsHourlyRainPatient } = require('../weather-forecast');
const { etDateString, parseETDateTime } = require('../../utils/datetime-et');

const MODE_SHADOW = 'shadow';
// Days out of the forecast window the rain term looks at, and how far each lead is trusted.
const FIRST_LEAD_DAYS = 3;
const LAST_LEAD_DAYS = 6;
const LEAD_TRUST = { 3: 1.0, 4: 0.7, 5: 0.4, 6: 0.25 };
// A visit counts as on a wet day when wetness x lead trust reaches this.
const WET_SCORE = 0.35;
// A drier date must beat the current day by this much (expected wetness, below).
const DRIER_MARGIN = 0.25;
// A date far out is read as this much wet in the part the forecast cannot vouch for.
const PRIOR_WETNESS = 0.3;
// Chance of rain: 30% or less is dry, 80% or more is fully wet.
const POP_DRY = 30;
const POP_SPAN = 50;
// The owner's pending landing floor: the visit may land 73 hours or more from now.
const FLOOR_HOURS_PENDING = 73;
// At most this many drier-date searches per run: each is a read-only slot search.
const MAX_SEARCHES_PER_RUN = 60;
// Occupancy probes asked per answer before the rest stay unverified.
const MAX_OCCUPANCY_CHECKS = 4;
// The search lifts the legacy first-80 cap (candidate-slots.js SCORE_CAP) to this; reaching it means the list may be cut.
const SEARCH_SCORE_CAP = 1000;
const HOUR_MIN = 60;
// A row that never reached the search (no forecast, dry day, indoor visit, no band) says so on both floors.
const STATUS_NOT_SEARCHED = 'not_searched';
// Closure days are read strictly once per run, this many days out from today (the widest band ends by day 13).
const CLOSURE_SPAN_DAYS = 16;

const REASONS = {
  OFF_BAND: 'out_of_forecast_range',
  NO_AREA: 'no_forecast_area',
  NO_FORECAST: 'no_forecast',
  DRY: 'dry_enough',
  INDOOR: 'not_outdoor',
  NO_BAND: 'no_flex_band',
  BUDGET: 'search_budget',
  ERROR: 'error',
  NONE: 'no_drier_date',
  CAPPED: 'uncertain_capped',
  GROUPED: 'grouped_unverified',
  OCCUPANCY: 'occupancy_unverified',
  FORECAST: 'uncertain_forecast',
  ROUTE: 'route_unverified',
  FOUND: 'drier_date_found',
  FOUND_73H: 'drier_date_only_with_73h_floor',
  FOUND_73H_UNSURE: 'drier_date_with_73h_floor_5day_uncertain',
};

// The call-time gate reader, tolerant of a suite that mocks feature-gates whole.
function modeOf() {
  const { autoDispatchRainTermMode } = require('../../config/feature-gates');
  return typeof autoDispatchRainTermMode === 'function' ? autoDispatchRainTermMode() : 'off';
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round2 = (n) => Math.round(n * 100) / 100;
const trustFor = (lead) => LEAD_TRUST[lead] || 0;

/**
 * One day's reading from an NWS hourly list: { wetness 0..1, complete }. wetness is null when
 * under half the work hours are in the list (an unread day is not a dry one); complete = every
 * work hour was read. NWS startTime carries the grid's own local hour, as ads/rain-mode.js reads it.
 */
function dayReading(hours, day) {
  if (!Array.isArray(hours)) return { wetness: null, complete: false };
  let sum = 0;
  let read = 0;
  let total = 0;
  for (let m = DAY_OPEN; m < DAY_CLOSE; m += HOUR_MIN) {
    total += 1;
    const key = `${day}T${String(Math.floor(m / HOUR_MIN)).padStart(2, '0')}`;
    const hour = hours.find((h) => String(h && h.startTime).slice(0, 13) === key);
    if (hour && Number.isFinite(hour.rainChance)) {
      sum += clamp01((hour.rainChance - POP_DRY) / POP_SPAN);
      read += 1;
    }
  }
  return { wetness: read * 2 >= total ? sum / read : null, complete: read === total };
}

const dayWetness = (hours, day) => dayReading(hours, day).wetness;

// What the forecast says about a date a candidate could land on: a dry reading
// far out is shrunk toward PRIOR_WETNESS (a weak forecast does not prove a dry day),
// and a wet reading is never read as drier than it says.
const expectedWetness = (wetness, lead) => Math.max(wetness, trustFor(lead) * wetness + (1 - trustFor(lead)) * PRIOR_WETNESS);

// The patient NWS read shared with the rain records (long wait, one retry, NWS only).
async function readArea(zone, read) {
  const hours = await getNwsHourlyRainPatient(ZONE_COORDS[zone].lat, ZONE_COORDS[zone].lng, { read });
  return Array.isArray(hours) && hours.length ? hours : null;
}

/**
 * The run's rain-term state, or null when the mode is not 'shadow' (the one
 * check every later call makes first). Reads the free NWS forecast once per
 * area. Never throws: a failed read leaves the area unread.
 */
async function start(run, deps = {}) {
  if (modeOf() !== MODE_SHADOW) return null;
  const read = deps.read || getNwsHourlyRain;
  const dates = [];
  for (let lead = FIRST_LEAD_DAYS; lead <= LAST_LEAD_DAYS; lead++) dates.push(shiftDateStr(run.today, lead));
  const state = {
    dates, forecast: new Map(), partial: new Set(), unread: [], searches: 0, startedAt: Date.now(),
    deps, counts: { in_range: 0, out_of_range: 0, errors: 0 },
  };
  await Promise.all(Object.keys(ZONE_COORDS).map(async (zone) => {
    try {
      const hours = await readArea(zone, read);
      if (!hours) { state.unread.push(zone); return; }
      const readings = dates.map((d) => [d, dayReading(hours, d)]);
      state.forecast.set(zone, new Map(readings.map(([d, r]) => [d, r.wetness])));
      // A day with some hours missing is read, but never vouched for as complete.
      readings.filter(([, r]) => !r.complete).forEach(([d]) => state.partial.add(`${zone}|${d}`));
    } catch {
      state.unread.push(zone);
    }
  }));
  state.unread.sort();
  return state;
}

// The forecast area of a loaded visit row: forecast-zones.js's own rule.
function areaOf(service) {
  return stopForecastZone({
    zone: service.zone,
    city: service.customer_city,
    zip: service.customer_zip,
    customer_city: service.customer_city,
    customer_zip: service.customer_zip,
    customer_address_line1: service.customer_address_line1,
    service_address_line1: service.service_address_line1,
    service_address_city: service.service_address_city,
    service_address_zip: service.service_address_zip,
  });
}

// Outdoor = rain-fit.js's own class for everything that moves with the visit: bookingRainPlan,
// the move screens' reader, gives the stored primary service, its add-ons and every live
// service that shares the stop. `strict`: an unread service list throws (the row says `error`),
// never a fallback to the primary name that could call a stop with a spray add-on indoor.
async function isOutdoor(service) {
  const { rainFitFor, bookingRainPlan } = require('../scheduling/rain-fit');
  const plan = await bookingRainPlan({
    bestRows: true, serviceType: service.service_type, serviceTypes: [], serviceKeys: [], serviceId: service.id, moveAlone: false, strict: true,
  }, db);
  return rainFitFor(plan.services) === 'avoid';
}

// The earliest start a 73-hour floor allows, and the ET date it falls on.
const floorInstant = (run) => run.nowDate.getTime() + FLOOR_HOURS_PENDING * 3600 * 1000;
const floorDate73 = (run) => etDateString(new Date(floorInstant(run)));

// A slot's ET start against the 73-hour floor: the boundary date stays, its early slots do not.
function startsAfterFloor(slot, run) {
  const at = parseETDateTime(`${toDateStr(slot.date)}T${String(slot.start_time || '').slice(0, 5)}`);
  return !!at && at.getTime() >= floorInstant(run);
}

// The run's own window (5-day landing floor) and the same window with the
// 73-hour floor: flexTierMoveWindow again, with only its `today` moved so its
// landing floor is the date 73 hours out (slots on it are checked by start time).
function bandsFor(service, guard, run) {
  const meta = guard && guard.meta;
  if (!guard || !guard.window || !meta || meta.mode !== 'flex') return null;
  const pending = flexTier.flexTierMoveWindow({
    origDate: service.scheduled_date,
    anchorDate: meta.anchor,
    today: shiftDateStr(floorDate73(run), -MIN_DESTINATION_DAYS_OUT),
    neighbors: meta.neighbors,
    radiusDays: meta.radius_days,
  });
  return { current: guard.window, pending73h: pending || guard.window, meta };
}

// The search ctx: the run's own, with the arrival search on and no road reader
// (the zero-paid-call settings), the wider window, and the technician kept at
// generation (keepTech) with the legacy cap lifted (scoreCap), so the first 80
// ranked survivors cannot hide the one dry slot of the visit's own technician.
function searchCtx(ctx, band, meta, service) {
  return {
    ...ctx,
    arrivalSearch: true,
    roadTravel: null,
    tierWindow: band,
    tierMeta: { ...meta, window: band },
    scoreCap: SEARCH_SCORE_CAP,
    ...(service.technician_id ? { keepTech: true } : {}),
  };
}

// Slots that beat the current day by DRIER_MARGIN inside `band` (and, with
// `afterFloor`, that start 73 hours or more from now), best first: Monday-Saturday before Sunday, then lowest
// expected wetness, nearest the current date, earliest start.
function drierOptions(candidates, {
  service, band, run, currentWet, wetByDate, afterFloor,
}) {
  const orig = toDateStr(service.scheduled_date);
  const out = [];
  for (const slot of candidates) {
    const date = toDateStr(slot.date);
    const lead = daysBetween(run.today, date);
    const wet = wetByDate.get(date);
    if (date === orig || wet == null || !trustFor(lead) || !flexTier.flexWindowAdmits(band, orig, date)) continue;
    if (afterFloor && !startsAfterFloor(slot, run)) continue;
    const expected = expectedWetness(wet, lead);
    if (currentWet - expected < DRIER_MARGIN) continue;
    out.push({
      slot, date, wet, lead_days: lead, expected, dist: Math.abs(daysBetween(orig, date)), sunday: moveRules.isSundayDate(date),
    });
  }
  // Sunday last (owner 2026-10-24, move-rules.js isSundayDate): a Sunday ranks only when no
  // Monday-Saturday slot clears the margin under this floor.
  return out.sort((a, b) => Number(a.sunday) - Number(b.sunday) || a.expected - b.expected || a.dist - b.dist
    || String(a.slot.start_time).localeCompare(String(b.slot.start_time)));
}

// Whether other live rows move with this visit (its shared stop). A shadow never runs the
// grouped-move guard (apply.js previewGroupMove): that guard writes, and it does not read
// sibling occupancy. A grouped visit's slot is recorded unverified instead. Read-only; an
// unreadable group reads as grouped (fail closed).
async function movesWithOthers(service) {
  if (!service.visit_id) return false;
  try {
    const { TERMINAL_ROW_STATUSES } = require('../visit-context/statuses');
    const other = await db('scheduled_services').where({ visit_id: service.visit_id }).whereNot('id', service.id)
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_ROW_STATUSES))
      .first('id');
    return !!other;
  } catch {
    return true;
  }
}

// Audit fields only are rounded; every comparison and sort above reads full-precision values.
const shownSlot = (opt) => (opt ? {
  date: opt.date, start_time: opt.slot.start_time, wetness: round2(opt.wet), lead_days: opt.lead_days, expected: round2(opt.expected),
} : null);

// Free slots in the wider window (same technician only when the visit has one), read-only.
async function freeSlots(service, prefs, ctx, bands) {
  const { findValidCandidateSlots } = require('./candidate-slots');
  const found = await findValidCandidateSlots(service, prefs, searchCtx(ctx, bands.pending73h, bands.meta, service));
  const tech = service.technician_id ? String(service.technician_id) : null;
  const all = (found && found.candidates) || [];
  return {
    slots: all.filter((c) => !tech || String(c.technician_id) === tech),
    capped: all.length >= SEARCH_SCORE_CAP,
    drops: (found && found.drops) || null,
    search: (found && found.search) || null,
  };
}

function rowFor(service, area, lead, wet, extra) {
  return {
    mode: MODE_SHADOW,
    area,
    lead_days: lead,
    current: { date: toDateStr(service.scheduled_date), wetness: wet == null ? null : round2(wet) },
    best_5day: null,
    best_73h: null,
    would_move: false,
    status_5day: STATUS_NOT_SEARCHED,
    status_73h: STATUS_NOT_SEARCHED,
    ...extra,
  };
}

// Whether the slot is free by the writer's own read-only occupancy probe (candidate-slots.js
// filterAndScoreSharedModelCandidates: rebooker probeMoveConflicts over the destination date,
// the visit's own unit excluded, the moving unit's windows, then the shared model's scoring
// reads). With GATE_AUTO_DISPATCH_SHARED_MODEL on the search already ran it on every
// candidate. Reads only: no write, no road lookup. true = free, false = taken, null = unreadable.
async function slotFree(slot, { service, ctx, memo }) {
  const { autoDispatchSharedModelLive } = require('../../config/feature-gates');
  if (typeof autoDispatchSharedModelLive === 'function' && autoDispatchSharedModelLive()) return true;
  const key = `${slot.date}|${slot.start_time}|${slot.technician_id}`;
  if (!memo.has(key)) {
    try {
      const { _internals } = require('./candidate-slots');
      const { resolveGeo } = require('./geo');
      const kept = await _internals.filterAndScoreSharedModelCandidates(service, resolveGeo(service), [slot], ctx, null);
      memo.set(key, kept.length > 0);
    } catch {
      memo.set(key, null);
    }
  }
  return memo.get(key);
}

// The first option whose slot is free. `unverified` = the probe could not be read (or too many
// slots were taken to keep asking): the slot stays a candidate and nothing would move.
async function firstFree(options, check) {
  let asked = 0;
  for (const opt of options) {
    if (asked >= MAX_OCCUPANCY_CHECKS) return { unverified: opt };
    asked += 1;
    const free = await slotFree(opt.slot, check);
    if (free === true) return { opt };
    if (free === null) return { unverified: opt };
  }
  return {};
}

// One floor's answer: found, unverified (the probe could not vet the slots it was given),
// uncertain_capped (the search list may have been cut), uncertain_forecast (a free slot sits
// on a day the forecast did not cover in full) or none (a verified "no slot").
function floorStatus(result, { capped, unread, route }) {
  if (result.opt) return 'found';
  if (result.unverified) return 'unverified';
  if (capped) return 'uncertain_capped';
  if (route) return 'unverified';
  return unread ? 'uncertain_forecast' : 'none';
}

// Whether the finder reported a date this floor admits as one whose route it could not verify
// (find-time's route_unverified rejection): that date is not a verified "no slot". The finder
// result carries per-date rejections only if a caller passes them on; today findValidCandidateSlots
// exposes none, so this reads whatever it does carry (a drops count, a per-date map) and a count of
// any size makes the floor unverified.
function routeGap({ drops, search }, { service, band }) {
  if (Number(drops && drops.route_unverified) > 0) return true;
  const orig = toDateStr(service.scheduled_date);
  const byDate = (search && search.rejections_by_date) || {};
  return Object.entries(byDate).some(([date, reasons]) => Number(reasons && reasons.route_unverified) > 0
    && date !== orig && flexTier.flexWindowAdmits(band, orig, date));
}

// Whether a free slot the band admits sits on a day within the forecast window that is
// unread or only partly read: the floor cannot be called empty. Days past the window are
// outside what this shadow judges by design, so they do not count.
function forecastGap(slots, {
  service, band, run, wetByDate, zone, state, afterFloor,
}) {
  const orig = toDateStr(service.scheduled_date);
  return slots.some((slot) => {
    const date = toDateStr(slot.date);
    const lead = daysBetween(run.today, date);
    if (date === orig || !trustFor(lead) || !flexTier.flexWindowAdmits(band, orig, date)) return false;
    if (afterFloor && !startsAfterFloor(slot, run)) return false;
    return wetByDate.get(date) == null || state.partial.has(`${zone}|${date}`);
  });
}

// The closure days (the owner's days off, holidays, one-off dates) read strictly once per
// run, as the rain record reads them: the capacity search's own closure read does not fail
// closed on a malformed holiday list. An unreadable list is the run's problem (every searched
// row says `error`), never a verified answer.
function closedDays(state, run) {
  if (!state.closures) {
    state.closures = Promise.resolve()
      .then(() => require('../scheduling/blackout-dates')
        .getBlackoutDates(state.dates[0], shiftDateStr(run.today, CLOSURE_SPAN_DAYS), db, { strict: true }))
      .catch(() => { throw Object.assign(new Error('closure days unreadable'), { code: 'CLOSURES_UNREAD' }); });
  }
  return state.closures;
}

function verdictReason({
  best5, best73, candidate, status5, status73, grouped,
}) {
  if (best5) return REASONS.FOUND;
  if (best73) return status5 === 'none' ? REASONS.FOUND_73H : REASONS.FOUND_73H_UNSURE;
  if (candidate) return grouped ? REASONS.GROUPED : REASONS.OCCUPANCY;
  const both = [status5, status73];
  if (both.includes('uncertain_capped')) return REASONS.CAPPED;
  if (both.includes('unverified')) return REASONS.ROUTE;
  return both.includes('uncertain_forecast') ? REASONS.FORECAST : REASONS.NONE;
}

// The one place a searched row is built, so no path can drop a floor's status.
function searchRow(base, {
  r5, r73, cov5, cov73, grouped,
}) {
  const best5 = grouped ? null : shownSlot(r5.opt);
  const best73 = grouped ? null : shownSlot(r73.opt);
  const status5 = floorStatus(r5, cov5);
  const status73 = floorStatus(r73, cov73);
  const pending = r5.unverified || r73.unverified;
  const candidate = !best5 && !best73 && pending ? { floor: r5.unverified ? '5day' : '73h', ...shownSlot(pending) } : null;
  return {
    ...base,
    best_5day: best5,
    best_73h: best73,
    would_move: !!best5,
    would_move_73h: !!best73,
    status_5day: status5,
    status_73h: status73,
    ...(candidate ? { candidate } : {}),
    reason: verdictReason({
      best5, best73, candidate, status5, status73, grouped,
    }),
  };
}

// The verdict for a visit already known wet and outdoor: searches once, answers twice.
// A visit that moves with others (`grouped`) cannot be verified here, so its best drier
// slot is a `candidate` only and nothing would move.
async function searchVerdict({
  service, prefs, ctx, guard, run,
}, state, base, area, grouped) {
  const bands = bandsFor(service, guard, run);
  if (!bands) return { ...base, reason: REASONS.NO_BAND };
  if (state.searches >= MAX_SEARCHES_PER_RUN) return { ...base, reason: REASONS.BUDGET };
  const closed = await closedDays(state, run);
  state.searches += 1;
  const found = await freeSlots(service, prefs, ctx, bands);
  const slots = found.slots.filter((slot) => !closed.has(toDateStr(slot.date)));
  const wetByDate = state.forecast.get(area);
  const common = {
    service, run, currentWet: wetByDate.get(base.current.date), wetByDate,
  };
  const gap = { ...common, zone: area, state };
  const cov = (band, afterFloor) => ({
    capped: found.capped, unread: forecastGap(slots, { ...gap, band, afterFloor }), route: routeGap(found, { service, band }),
  });
  const cov5 = cov(bands.current, false);
  const cov73 = cov(bands.pending73h, true);
  const opts5 = drierOptions(slots, { ...common, band: bands.current });
  const opts73 = drierOptions(slots, { ...common, band: bands.pending73h, afterFloor: true });
  if (grouped) {
    // Nothing is vetted: the best slot of each floor stays unverified.
    return searchRow(base, {
      r5: opts5.length ? { unverified: opts5[0] } : {}, r73: opts73.length ? { unverified: opts73[0] } : {}, cov5, cov73, grouped,
    });
  }
  const check = {
    service, ctx, run, memo: new Map(),
  };
  const r5 = await firstFree(opts5, check);
  let r73 = await firstFree(opts73, check);
  // Any slot valid under the 5-day floor is valid under 73 hours when it also starts 73 hours out.
  if (!r73.opt && r5.opt && startsAfterFloor(r5.opt.slot, run)) r73 = r5;
  return searchRow(base, {
    r5, r73, cov5, cov73, grouped,
  });
}

async function judge(args, state, lead) {
  const { service } = args;
  const date = toDateStr(service.scheduled_date);
  const area = areaOf(service);
  const wet = area && state.forecast.has(area) ? state.forecast.get(area).get(date) : null;
  const base = rowFor(service, area || null, lead, wet, {});
  if (!area) return { row: { ...base, reason: REASONS.NO_AREA } };
  if (wet == null) return { row: { ...base, reason: REASONS.NO_FORECAST } };
  base.current.score = round2(wet * trustFor(lead));
  if (state.partial.has(`${area}|${date}`)) base.current.partial_forecast = true;
  if (wet * trustFor(lead) < WET_SCORE) return { row: { ...base, reason: REASONS.DRY } };
  if (!(await isOutdoor(service))) return { row: { ...base, reason: REASONS.INDOOR } };
  return { row: await searchVerdict(args, state, base, area, await movesWithOthers(service)) };
}

/**
 * The per-visit hook: puts constraints_checked.rain_term on the evaluation's
 * audit. `evalResult.audit.constraints` is the only thing it touches. Never throws.
 */
async function note(state, args) {
  if (!state || !args.evalResult || !args.evalResult.audit) return;
  // Counted before any read that can fail: a visit in range is in range whatever follows.
  const lead = daysBetween(args.run.today, toDateStr(args.service.scheduled_date));
  if (lead == null || lead < FIRST_LEAD_DAYS || lead > LAST_LEAD_DAYS) { state.counts.out_of_range += 1; return; }
  state.counts.in_range += 1;
  let row;
  try {
    row = (await judge(args, state, lead)).row;
  } catch (err) {
    state.counts.errors += 1;
    row = {
      mode: MODE_SHADOW, lead_days: lead, would_move: false, status_5day: 'unverified', status_73h: 'unverified', reason: REASONS.ERROR, error: err.code || err.name || 'error',
    };
  }
  state.counts[row.reason] = (state.counts[row.reason] || 0) + 1;
  if (row.would_move_73h && !row.would_move) {
    // 73h-only counts only when the 5-day floor was a verified "no slot"; any doubt is 'uncertain'.
    const key = row.status_5day === 'none' ? 'would_move_73h_only' : 'uncertain';
    state.counts[key] = (state.counts[key] || 0) + 1;
  }
  args.evalResult.audit.constraints = { ...args.evalResult.audit.constraints, rain_term: row };
}

// A planned move's pass-1 rain term, carried to the re-evaluation pass 2 builds,
// so the row that records the move keeps it. Off or absent: nothing.
function carry(from, to) {
  const found = from && from.audit && from.audit.constraints && from.audit.constraints.rain_term;
  if (!found || !to || !to.audit) return;
  to.audit.constraints = { ...to.audit.constraints, rain_term: found };
}

// The block a rebuilt audit keeps ({} when none).
function kept(evaluation) {
  const found = evaluation && evaluation.audit && evaluation.audit.constraints && evaluation.audit.constraints.rain_term;
  return found ? { rain_term: found } : {};
}

/**
 * The run's summary, once at the end: one log line and one audit_log row
 * (auto_dispatch.rain_term_shadow). Never throws; null state = nothing.
 */
async function finish(state, run) {
  if (!state) return null;
  const summary = {
    mode: MODE_SHADOW,
    ...state.counts,
    searches: state.searches,
    areas_read: [...state.forecast.keys()].sort(),
    unread_areas: state.unread,
    days: state.dates,
    ms: Date.now() - state.startedAt,
  };
  try {
    logger.info(`[auto-dispatch] rain term shadow run ${run.runId}: ${JSON.stringify(summary)}`);
    const { recordAuditEvent } = require('../audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'auto_dispatch.rain_term_shadow', resource_type: 'auto_dispatch_run', resource_id: run.runId, metadata: summary,
    });
  } catch (err) {
    logger.warn(`[auto-dispatch] rain term summary not recorded: ${err.message}`);
  }
  return summary;
}

module.exports = {
  start, note, carry, kept, finish, dayWetness, expectedWetness, modeOf,
  _test: { drierOptions, dayReading }, MODE_SHADOW, LEAD_TRUST, WET_SCORE, DRIER_MARGIN, PRIOR_WETNESS, FLOOR_HOURS_PENDING, MAX_SEARCHES_PER_RUN, REASONS,
};
