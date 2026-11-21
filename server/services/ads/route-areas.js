/**
 * Ads follow the route, step 1: record only ($0) (owner-approved plan "Ads Follow the Route").
 *
 * With the 2-hour ad budget cron, this writes down, for each technician, the areas he works today and tomorrow (ET),
 * his room, and the ZIP list a route-following "fill ad" would use. A later step reads the records for a week and
 * then lets a rule act on them. This module changes no budget, campaign, visit or message, and makes NO Google Ads
 * call: it reads the schedule and writes two system_settings rows.
 *
 *   ads.route_areas.last     the full record of the latest run
 *   ads.route_areas.history  the last HISTORY_MAX compact entries, newest last, one per cron occurrence (`tick`). A
 *                            ZIP list is kept only where the areas do not give it (a day whose ZIPs come from the
 *                            technician's own territory); every other list follows from the areas.
 * Both rows are written in one transaction, so they always describe the same run.
 *
 * Room on a technician-day: he is staffed, he has a stop left under the gap rule's limit for that weekday, and his open
 * minutes hold one more job with its drive (close-gaps SLOT_MIN). Work with no technician yet is held against every
 * technician, in the stop count and in the minutes.
 *
 * Every input of the rule is in the record, so a run can be counted again from the rows: per technician-day the stops,
 * the stops left, the gap rule's limit, the shift minutes, the booked and drive minutes, the open minutes, and the
 * areas with their stop counts; per date the unassigned work held against every route; and `rule` (the run minute,
 * the slot length, the shift, the limits and the service-line card the run used).
 *
 * The staffed rule is the hourly route check's (day-replan/route-check.js staffed): the date is not a blackout date,
 * the technician is assignable and not absent, and a Sunday counts only when he has a booked stop that day (not an
 * unclaimed hold, not a windowless placeholder: route-check.js techsWithStops).
 * All dates are Eastern YYYY-MM-DD strings.
 */
const db = require('../../models/db');
const { etParts, etDateString, addETDays } = require('../../utils/datetime-et');

const LAST_KEY = 'ads.route_areas.last';
const HISTORY_KEY = 'ads.route_areas.history';
const HISTORY_MAX = 120;

// The fill ad's planned hours (7:00 to 19:00 ET). Recorded, not enforced.
const AD_HOURS_START = 7;
const AD_HOURS_END = 19;
// A job slot is a 60-minute job plus its drive (close-gaps SLOT_MIN); the drive part is slotMin - JOB_MIN.
const JOB_MIN = 60;
// The two lines the ads follow: the record's name -> the service-line card's category.
const LINES = Object.freeze({ pest: 'general', lawn: 'lawn' });

// Weekday of an ET calendar-date string (0 = Sunday). Noon UTC keeps the date's own weekday whatever the zone or DST.
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const uniqSorted = (list) => [...new Set(list)].sort();
const idOf = (value) => (value === null || value === undefined ? null : String(value));

/** The gap rule's per-technician stop limit for a date's weekday. */
function limitFor(date, limits) {
  const day = weekdayOf(date);
  if (day === 6) return limits.saturday_limit;
  if (day === 0) return limits.sunday_limit;
  return limits.weekday_limit;
}

/** Why a technician does not work a date (null = staffed): the route check's staffed rule, with the reason. */
function closedReason(input, techId, date, bookedCount) {
  if (input.blackout.has(date)) return 'closed';
  if (input.absent.has(`${techId}:${date}`)) return 'absent';
  if (weekdayOf(date) === 0 && bookedCount === 0) return 'sunday_no_stops';
  return null;
}

// The minutes a stop still needs: its not-completed services only (a visit with one service done keeps the rest).
const minutesLeftOf = (stop) => (stop.minutesLeft === undefined ? stop.minutes : stop.minutesLeft);

/** Minutes left in the shift: all of it for a later date, the part after now (and the start) for today. */
function shiftMinutes(input, date) {
  const { startMinutes, endMinutes } = input.shift;
  if (date !== input.dates[0]) return endMinutes - startMinutes;
  return Math.max(0, endMinutes - Math.max(startMinutes, input.nowMin));
}

/** Per date: the work with no technician. Not-done work is held against every route. */
function unassignedByDate(input) {
  return input.dates.map((date) => {
    const rows = input.stops.filter((s) => idOf(s.technicianId) === null && s.date === date);
    const left = rows.filter((s) => !s.done);
    return {
      date,
      stops: rows.length,
      minutes: sum(rows, (s) => s.minutes),
      stops_left: left.length,
      minutes_left: sum(left, minutesLeftOf),
    };
  });
}

/** The territory lookups: zip -> area, and area -> its sorted ZIPs. */
function territoryMaps(territory) {
  const areaOfZip = new Map();
  const zipsOfArea = new Map();
  for (const row of territory || []) {
    if (!row || !row.zip || !row.area) continue;
    areaOfZip.set(String(row.zip), row.area);
    if (!zipsOfArea.has(row.area)) zipsOfArea.set(row.area, []);
    zipsOfArea.get(row.area).push(String(row.zip));
  }
  for (const [area, zips] of zipsOfArea) zipsOfArea.set(area, uniqSorted(zips));
  return { areaOfZip, zipsOfArea };
}

/** A technician's stops on a date counted by area: { areas, unmapped }. Sorted by area key. */
function areasOfStops(stops, areaOfZip) {
  const byArea = new Map();
  let unmapped = 0;
  for (const stop of stops) {
    const area = stop.zip ? areaOfZip.get(String(stop.zip)) : null;
    if (!area) { unmapped += 1; continue; }
    const entry = byArea.get(area) || { area, stops: 0, stops_left: 0 };
    entry.stops += 1;
    if (!stop.done) entry.stops_left += 1;
    byArea.set(area, entry);
  }
  return { areas: [...byArea.values()].sort((a, b) => (a.area < b.area ? -1 : a.area > b.area ? 1 : 0)), unmapped };
}

/** The ZIPs of a technician-day by the list rule: { zips, zip_source, zip_reason }. */
function zipRule({ staffed, room, stopCount, areas, techId }, maps, territory) {
  const none = (reason) => ({ zips: [], zip_source: null, zip_reason: reason });
  if (!staffed) return none('not_staffed');
  if (!room) return none('full');
  if (stopCount === 0) {
    const own = uniqSorted((territory || []).filter((t) => idOf(t.technicianId) === techId && t.zip).map((t) => String(t.zip)));
    return own.length ? { zips: own, zip_source: 'territory', zip_reason: null } : none('empty_day_no_territory');
  }
  if (!areas.length) return none('no_mapped_stops');
  const zips = uniqSorted(areas.flatMap((a) => maps.zipsOfArea.get(a.area) || []));
  return { zips, zip_source: 'stops', zip_reason: null };
}

/** One technician on one date. */
function techDay(input, ctx, techId, date) {
  const mine = input.stops.filter((s) => idOf(s.technicianId) === techId && s.date === date);
  const left = mine.filter((s) => !s.done);
  const unassigned = ctx.unassigned.get(date);
  // A stop with no `booked` field counts as booked; the loader sets it false for a hold or a placeholder.
  const reason = closedReason(input, techId, date, mine.filter((s) => s.booked !== false).length);
  const staffed = reason === null;
  const limit = limitFor(date, input.limits);
  const shiftMin = shiftMinutes(input, date);
  const bookedMin = sum(left, minutesLeftOf) + unassigned.minutes_left;
  const driveMin = (input.slotMin - JOB_MIN) * (left.length + unassigned.stops_left);
  const openMin = Math.max(0, shiftMin - bookedMin - driveMin);
  // Unassigned work still to do takes a place on someone's route, so it counts against every technician's limit.
  const openStops = Math.max(0, limit - mine.length - unassigned.stops_left);
  // Room needs both: a stop left under the gap rule's limit for that weekday (the owner's setting, which the live
  // 7-day budget rule already follows) and the minutes for one more job with its drive. Both counts are stored, so
  // either test can be counted again alone.
  const room = staffed && openStops >= 1 && openMin >= input.slotMin;
  const { areas, unmapped } = areasOfStops(mine, ctx.maps.areaOfZip);
  const zipPart = zipRule({ staffed, room, stopCount: mine.length, areas, techId }, ctx.maps, input.territory);
  return {
    date,
    staffed,
    reason,
    stops: mine.length,
    stops_left: left.length,
    limit,
    open_stops: openStops,
    shift_min: shiftMin,
    booked_min: bookedMin,
    drive_min: driveMin,
    open_min: openMin,
    room,
    areas,
    unmapped_stops: unmapped,
    ...zipPart,
  };
}

/** Which technicians a line follows on a date: the card's home, else its gap technician, else nobody. */
function lineTechIds(entry, staffedIds, techIds) {
  const home = idOf(entry?.homeId);
  const gap = idOf(entry?.gapId);
  if (!entry || (home === null && gap === null)) return techIds.filter((id) => staffedIds.has(id));
  if (home !== null && staffedIds.has(home)) return [home];
  if (gap !== null && staffedIds.has(gap)) return [gap];
  return [];
}

/** One line's record: a day per date (technicians, open minutes, ZIPs) and the unions over both dates. */
function lineRecord(input, ctx, cardLine, technicians) {
  const techIds = technicians.map((t) => t.id);
  const days = input.dates.map((date) => {
    const dayOf = (t) => t.days.find((d) => d.date === date);
    const staffedIds = new Set(technicians.filter((t) => dayOf(t).staffed).map((t) => t.id));
    const ids = lineTechIds((input.lineCard || {})[cardLine], staffedIds, techIds);
    const chosen = technicians.filter((t) => ids.includes(t.id)).map(dayOf);
    return {
      date,
      technician_ids: ids,
      open_min: sum(chosen.filter((d) => d.room), (d) => d.open_min),
      zips: uniqSorted(chosen.flatMap((d) => d.zips)),
    };
  });
  const zips = uniqSorted(days.flatMap((d) => d.zips));
  return { card_line: cardLine, days, zips, areas: areasOfZips(zips, ctx.maps) };
}

function areasOfZips(zips, maps) {
  return uniqSorted(zips.map((z) => maps.areaOfZip.get(z)).filter(Boolean));
}

/**
 * Pure: the record of one run from its inputs (no db, no clock). See the module header and the plan page for the
 * rules. Every technician in techIds gets an entry for both dates, in techIds order; an id is compared as a string.
 */
function buildRouteAreas(input) {
  const techIds = (input.techIds || []).map(String);
  const ctx = {
    maps: territoryMaps(input.territory),
    unassigned: new Map(unassignedByDate(input).map((u) => [u.date, u])),
  };
  const technicians = techIds.map((id) => ({ id, days: input.dates.map((date) => techDay(input, ctx, id, date)) }));
  const lines = {};
  for (const [name, cardLine] of Object.entries(LINES)) lines[name] = lineRecord(input, ctx, cardLine, technicians);
  const zips = uniqSorted(Object.values(lines).flatMap((l) => l.zips));
  const hourEt = Math.floor(input.nowMin / 60);
  return {
    at: input.at,
    // The cron occurrence this run belongs to (ET date + hour): the history keeps one entry per tick.
    tick: `${input.dates[0]}T${String(hourEt).padStart(2, '0')}`,
    dates: input.dates,
    hour_et: hourEt,
    in_ad_hours: hourEt >= AD_HOURS_START && hourEt < AD_HOURS_END,
    rule: {
      now_min: input.nowMin,
      slot_min: input.slotMin,
      shift: { startMinutes: input.shift.startMinutes, endMinutes: input.shift.endMinutes },
      limits: input.limits,
      line_card: input.lineCard || {},
    },
    unassigned: [...ctx.unassigned.values()],
    technicians,
    lines,
    zips,
    areas: areasOfZips(zips, ctx.maps),
  };
}

// One physical stop: the gap rule's identity (budget-manager GAP_STOPS_SQL). A visit_id group is one stop; with no
// visit_id, the same customer + same window_start (NULL for a windowless placeholder) is one stop. A stop is one
// technician's, so the technician is part of the group. A live hold with no customer yet (slot-reservation) holds its
// own time, so each is its own stop here: without the row id its key would be NULL and every such hold of a
// technician-day would fold into one.
const STOP_KEY_SQL = `CASE
  WHEN ss.visit_id IS NOT NULL THEN 'v:' || ss.visit_id::text
  ELSE 'c:' || COALESCE(ss.customer_id::text, 'hold:' || ss.id::text) || ':' || COALESCE(ss.window_start::text, '')
END`;

// A booked stop, as the route check counts one for a Sunday (route-check.js bookedStop + dispatchKeeps): not an
// unclaimed hold (no customer yet, a live expiry), and a row dispatch keeps (a window start, a time window, or work
// done or under way). A hold and a placeholder still hold their time; they only do not staff a Sunday.
const BOOKED_STOP_SQL = `(ss.customer_id IS NOT NULL OR ss.reservation_expires_at IS NULL)
  AND (ss.window_start IS NOT NULL OR COALESCE(ss.time_window, '') <> '' OR ss.status IN ('completed', 'en_route', 'on_site'))`;

/** The physical stops of the two dates, one row each (same row filter as the gap rule's window read). */
async function readStops(conn, dates) {
  const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
  const { normalizeZip } = require('../territory');
  const marks = NOT_A_ROUTE_STOP_STATUSES.map(() => '?').join(', ');
  const result = await conn.raw(`
    SELECT ss.technician_id::text AS technician_id,
      ss.scheduled_date::text AS day,
      LEFT(COALESCE(MIN(NULLIF(TRIM(ss.service_address_zip), '')), MIN(NULLIF(TRIM(c.zip), ''))), 5) AS zip,
      SUM(COALESCE(ss.estimated_duration_minutes, sv.default_duration_minutes, ${JOB_MIN}))::int AS minutes,
      COALESCE(SUM(COALESCE(ss.estimated_duration_minutes, sv.default_duration_minutes, ${JOB_MIN}))
        FILTER (WHERE ss.status <> 'completed'), 0)::int AS minutes_left,
      bool_and(ss.status = 'completed') AS done,
      bool_or(${BOOKED_STOP_SQL}) AS booked
    FROM scheduled_services ss
    LEFT JOIN customers c ON c.id = ss.customer_id
    LEFT JOIN services sv ON sv.id = ss.service_id
    WHERE ss.scheduled_date BETWEEN ?::date AND ?::date
      AND ss.status NOT IN (${marks})
      AND (ss.reservation_expires_at IS NULL OR ss.reservation_expires_at > now())
    GROUP BY ss.technician_id, ss.scheduled_date, ${STOP_KEY_SQL}`,
  [dates[0], dates[dates.length - 1], ...NOT_A_ROUTE_STOP_STATUSES]);
  return (result.rows || []).map((r) => ({
    technicianId: r.technician_id || null,
    date: String(r.day).slice(0, 10),
    zip: normalizeZip(r.zip),
    minutes: parseInt(r.minutes, 10) || 0,
    minutesLeft: parseInt(r.minutes_left, 10) || 0,
    done: r.done === true,
    booked: r.booked === true,
  }));
}

/** The service-line card for the two lines: { general, lawn } -> { homeId, gapId } or null. A gap equal to the home counts once. */
async function readLineCard(conn) {
  const rows = await conn('service_line_techs')
    .whereIn('service_category', Object.values(LINES))
    .select('service_category', 'home_technician_id', 'gap_technician_id');
  const card = {};
  for (const line of Object.values(LINES)) {
    const row = rows.find((r) => r.service_category === line);
    const homeId = idOf(row?.home_technician_id);
    const gapId = idOf(row?.gap_technician_id);
    card[line] = row && (homeId || gapId) ? { homeId, gapId: gapId === homeId ? null : gapId } : null;
  }
  return card;
}

/** The staffed rule's reads: blackout dates, assignable technicians and absences (the route check's eligibility). */
async function readEligibility(conn, dates) {
  const { getBlackoutDates } = require('../scheduling/blackout-dates');
  const { applyAssignable, absentTechDays } = require('../technician-eligibility');
  const from = dates[0];
  const to = dates[dates.length - 1];
  const blackout = await getBlackoutDates(from, to, conn, { strict: true });
  const techs = await applyAssignable(conn('technicians')).select('technicians.id');
  const techIds = techs.map((t) => String(t.id)).sort();
  const absent = techIds.length ? await absentTechDays(conn, { dateFrom: from, dateTo: to, technicianIds: techIds }) : new Set();
  return { blackout, techIds, absent };
}

/** The reads of one run: the input of buildRouteAreas. Plain reads, no snapshot. */
async function loadRouteAreasInput(conn, now) {
  const { normalizeGapSettings } = require('./budget-manager');
  const { SHIFT } = require('../scheduling/policy');
  const { SLOT_MIN } = require('../day-replan/close-gaps');
  const dates = [etDateString(now), etDateString(addETDays(now, 1))];
  const parts = etParts(now);
  const elig = await readEligibility(conn, dates);
  const territory = (await conn('territory_zips').select('zip', 'area', 'technician_id'))
    .map((r) => ({ zip: r.zip, area: r.area, technicianId: idOf(r.technician_id) }));
  const targets = await conn('ad_targets').first();
  return {
    at: now.toISOString(),
    dates,
    nowMin: parts.hour * 60 + parts.minute,
    techIds: elig.techIds,
    absent: elig.absent,
    blackout: elig.blackout,
    stops: await readStops(conn, dates),
    territory,
    lineCard: await readLineCard(conn),
    limits: normalizeGapSettings(targets?.metadata),
    shift: { startMinutes: SHIFT.startMinutes, endMinutes: SHIFT.endMinutes },
    slotMin: SLOT_MIN,
  };
}

/** A line's compact history part: its area keys, its open minutes (both dates), and the technicians it followed each date. */
const compactLine = (line) => ({
  areas: line.areas,
  open_min: sum(line.days, (d) => d.open_min),
  days: line.days.map((d) => ({ date: d.date, technician_ids: d.technician_ids, open_min: d.open_min })),
});

/**
 * A history entry: the record without the ZIP lists that follow from the areas (territory_zips). A day whose ZIPs
 * come from the technician's own territory keeps its list: those can be part of an area, which the area key cannot say.
 */
function compactEntry(record) {
  return {
    at: record.at,
    tick: record.tick,
    hour_et: record.hour_et,
    lines: { pest: compactLine(record.lines.pest), lawn: compactLine(record.lines.lawn) },
    techs: record.technicians.map((t) => ({
      id: t.id,
      days: t.days.map((d) => ({
        date: d.date,
        staffed: d.staffed,
        room: d.room,
        stops: d.stops,
        stops_left: d.stops_left,
        open_stops: d.open_stops,
        open_min: d.open_min,
        areas: Object.fromEntries(d.areas.map((a) => [a.area, a.stops])),
        zip_source: d.zip_source,
        ...(d.zip_source === 'territory' ? { zips: d.zips } : {}),
      })),
    })),
  };
}

/** The stored history as an array; a corrupt or non-array value starts a new one (as recordGapRun does). */
function parseHistory(stored) {
  let history = [];
  try { history = JSON.parse(stored || '[]'); } catch { history = []; }
  return Array.isArray(history) ? history : [];
}

/**
 * Loads, builds and saves one record: system_settings 'ads.route_areas.last' and 'ads.route_areas.history' (last 120),
 * in one transaction.
 * Reads and writes only: no budget, campaign, visit or message changes and no Google Ads call. Returns the record.
 */
async function recordRouteAreas({ now = new Date(), conn = db } = {}) {
  const record = buildRouteAreas(await loadRouteAreasInput(conn, now));
  // One transaction: the latest record and the history always describe the same run. One entry per tick: a second
  // run of the same cron occurrence (two instances during a deploy) replaces the first instead of counting twice.
  await conn.transaction(async (trx) => {
    const prior = await trx('system_settings').where({ key: HISTORY_KEY }).first();
    const kept = parseHistory(prior?.value).filter((entry) => !entry || entry.tick !== record.tick);
    const history = [...kept, compactEntry(record)].slice(-HISTORY_MAX);
    const upsert = (key, value, description) => trx('system_settings')
      .insert({ key, value, category: 'ads', description })
      .onConflict('key')
      .merge({ value, updated_at: now });
    await upsert(LAST_KEY, JSON.stringify(record), 'Latest ads route-areas record (shadow)');
    await upsert(HISTORY_KEY, JSON.stringify(history), `Recent ads route-areas records (last ${HISTORY_MAX})`);
  });
  return record;
}

module.exports = {
  LAST_KEY,
  HISTORY_KEY,
  HISTORY_MAX,
  buildRouteAreas,
  loadRouteAreasInput,
  recordRouteAreas,
  _internals: { compactEntry, parseHistory, zipRule, lineTechIds, limitFor },
};
