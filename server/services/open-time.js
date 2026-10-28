/**
 * Open time (L11b, GATE_TECH_OPEN_TIME).
 *
 * Owner 2026-10-26, "BOTH", build B: "Each visit carries only its own minutes and miles. The unbooked part of
 * the paid day shows as one 'open time' cost for each tech and day. A visit's cost stays steady, so customer
 * margins compare fairly. Open time shows what an empty schedule costs."
 *
 * For one technician and one ET day:
 *   paid minutes   the day's time_entry_daily_summary row (total_shift_minutes - unpaid_meal_minutes), source
 *                  'clock'; else, on a day with at least one completed visit, the card's paid_hours_per_day
 *                  x 60, source 'card'. A clocked day with no visit counts, all of it open. A day with no
 *                  visit and no clock row does not exist for this report: the truck clock-in (not live yet)
 *                  will close that gap.
 *   booked minutes the sum over the day's completed visits of job_costs.charged_on_job_minutes +
 *                  charged_drive_minutes (the minutes each visit's cost was charged for, job-costing.js)
 *   open minutes   max(0, paid - booked); over minutes max(0, booked - paid)
 *   open cost      the card's labor cost per worked hour (cents) x open minutes / 60, rounded half up to a
 *                  whole cent ONCE per technician-day; totals add the rounded day figures.
 *
 * Labor only. The vehicle's fixed cost for unbooked minutes stays in the vehicle overhead line (the
 * adjusted-EBITDA bridge nets only the vehicle fixed cost the visits carry), so nothing counts twice.
 * Overtime premium is not modeled: open minutes are at the worked-hour rate.
 *
 * A day is left out, never guessed, when: the technician has no card in effect that day ('no_card'), the card
 * gives no rate ('no_rate'), or a completed visit that day has no charged minutes ('costed_before_card': it
 * was costed before the card, or never costed). Today and later days are never counted; a day in progress
 * is not a day's open time.
 */
const { etDateString } = require('../utils/datetime-et');
const { cardInEffect, loadVisitRates, dateString } = require('./tech-cost-rates');

const DAY_MS = 86400000;
const MISSING_RELATION_CODES = new Set(['42P01', '42703']);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

/** The ET days from..to inclusive that are before `today`, as YYYY-MM-DD. */
function countedDays(from, to, today) {
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day < today) days.push(day);
  }
  return days;
}

/**
 * One technician-day, pure. Returns { leftOut } or { day }.
 * @param {{rateCents:number|null, paidHoursPerDay:number, clock:object|null, visits:object[]}} input
 *   visits: [{ onJob, drive }] charged minutes (null = none charged)
 */
function openTimeForDay({ rateCents, paidHoursPerDay, clock, visits }) {
  if (!(rateCents > 0)) return { leftOut: 'no_rate' };
  if (visits.some((v) => v.onJob == null || v.drive == null)) return { leftOut: 'costed_before_card' };
  const clockMinutes = clock ? num(clock.total_shift_minutes) - num(clock.unpaid_meal_minutes) : 0;
  let paidMinutes;
  let paidSource;
  if (clock && num(clock.total_shift_minutes) > 0) {
    paidMinutes = Math.max(0, clockMinutes);
    paidSource = 'clock';
  } else if (visits.length > 0) {
    paidMinutes = round2(num(paidHoursPerDay) * 60);
    paidSource = 'card';
  } else {
    return { leftOut: null }; // no visit and no clock row: the day does not exist for this report
  }
  const onJobMinutes = round2(visits.reduce((s, v) => s + num(v.onJob), 0));
  const driveMinutes = round2(visits.reduce((s, v) => s + num(v.drive), 0));
  const bookedMinutes = round2(onJobMinutes + driveMinutes);
  const openMinutes = round2(Math.max(0, paidMinutes - bookedMinutes));
  const overMinutes = round2(Math.max(0, bookedMinutes - paidMinutes));
  return {
    day: {
      paidMinutes: round2(paidMinutes),
      paidSource,
      onJobMinutes,
      driveMinutes,
      bookedMinutes,
      openMinutes,
      overMinutes,
      // The one rounding: half up to a whole cent, per technician-day.
      openCostCents: Math.round((rateCents * openMinutes) / 60),
    },
  };
}

function emptyTotals() {
  return {
    days: 0, paidMinutes: 0, bookedMinutes: 0, onJobMinutes: 0, driveMinutes: 0, openMinutes: 0, overMinutes: 0, openCostCents: 0, bookedShare: null,
  };
}

function addDay(totals, d) {
  totals.days += 1;
  for (const key of ['paidMinutes', 'bookedMinutes', 'onJobMinutes', 'driveMinutes', 'openMinutes', 'overMinutes']) {
    totals[key] = round2(totals[key] + d[key]);
  }
  totals.openCostCents += d.openCostCents;
}

function finishTotals(totals) {
  totals.bookedShare = totals.paidMinutes > 0 ? Math.round((totals.bookedMinutes / totals.paidMinutes) * 10000) / 10000 : null;
  return totals;
}

async function readClockRows(conn, from, lastDay, technicianId) {
  try {
    const q = conn('time_entry_daily_summary').where('work_date', '>=', from).where('work_date', '<=', lastDay);
    if (technicianId) q.where({ technician_id: technicianId });
    return await q.select('technician_id', 'work_date', 'total_shift_minutes', 'unpaid_meal_minutes');
  } catch (err) {
    if (MISSING_RELATION_CODES.has(err && err.code)) return []; // no time tables yet: the card hours apply
    throw err;
  }
}

// technician -> day -> { visits: Map(scheduled service id -> {onJob, drive}), clock } for the counted days.
async function loadDayCells(conn, days, technicianId) {
  const counted = new Set(days);
  const first = days[0];
  const last = days[days.length - 1];
  const visitQuery = conn('scheduled_services as ss')
    .leftJoin('job_costs as jc', 'jc.scheduled_service_id', 'ss.id')
    .where('ss.status', 'completed')
    .whereNotNull('ss.technician_id')
    .where('ss.scheduled_date', '>=', first)
    .where('ss.scheduled_date', '<=', last);
  if (technicianId) visitQuery.where('ss.technician_id', technicianId);
  const visitRows = await visitQuery.select(
    'ss.id as id', 'ss.technician_id as technician_id', 'ss.scheduled_date as day',
    'jc.charged_on_job_minutes as on_job', 'jc.charged_drive_minutes as drive',
  );
  const clockRows = await readClockRows(conn, first, last, technicianId);

  const byTech = new Map();
  const cell = (tech, day) => {
    if (!byTech.has(tech)) byTech.set(tech, new Map());
    const m = byTech.get(tech);
    if (!m.has(day)) m.set(day, { visits: new Map(), clock: null });
    return m.get(day);
  };
  for (const r of visitRows) {
    const day = dateString(r.day);
    if (!counted.has(day)) continue;
    const entry = cell(r.technician_id, day);
    // One scheduled service counts once even if it somehow has two job_costs rows: keep a row that has minutes.
    const had = entry.visits.get(r.id);
    if (!had || (had.onJob == null && r.on_job != null)) {
      entry.visits.set(r.id, { onJob: r.on_job == null ? null : Number(r.on_job), drive: r.drive == null ? null : Number(r.drive) });
    }
  }
  for (const r of clockRows) {
    const day = dateString(r.work_date);
    if (counted.has(day)) cell(r.technician_id, day).clock = r;
  }
  return byTech;
}

// One technician-day: { leftOut: {reason, visits} } | { row } | {} (a day that does not exist for the report).
async function evaluateDay(conn, tech, day, { visits: visitMap, clock }) {
  const visits = [...visitMap.values()];
  const card = await cardInEffect(conn, 'technician_cost_cards', 'technician_id', tech, day);
  if (!card) return { leftOut: { technicianId: tech, day, reason: 'no_card', visits: visits.length } };
  const rates = await loadVisitRates(conn, tech, day);
  const result = openTimeForDay({
    rateCents: rates ? rates.laborPerWorkedHourCents : null,
    paidHoursPerDay: Number(card.paid_hours_per_day),
    clock,
    visits,
  });
  if (result.leftOut) return { leftOut: { technicianId: tech, day, reason: result.leftOut, visits: visits.length } };
  if (!result.day) return {};
  return { row: { technicianId: tech, day, ...result.day } };
}

/**
 * Open time for ET days from..to (inclusive, never `today` or later), per technician and day.
 * @returns {Promise<{from, to, days:object[], leftOut:object[], totals:object, technicians:object[]}>}
 */
async function computeOpenTime(conn, {
  from, to, technicianId = null, today = etDateString(),
} = {}) {
  const days = countedDays(from, to, today);
  const out = {
    from, to, days: [], leftOut: [], totals: emptyTotals(), technicians: [],
  };
  if (!days.length) {
    finishTotals(out.totals);
    return out;
  }
  const byTech = await loadDayCells(conn, days, technicianId);
  const techTotals = new Map();
  for (const [tech, daysMap] of [...byTech.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    for (const day of [...daysMap.keys()].sort()) {
      const { leftOut, row } = await evaluateDay(conn, tech, day, daysMap.get(day));
      if (leftOut) out.leftOut.push(leftOut);
      if (!row) continue;
      out.days.push(row);
      addDay(out.totals, row);
      if (!techTotals.has(tech)) techTotals.set(tech, emptyTotals());
      addDay(techTotals.get(tech), row);
    }
  }
  finishTotals(out.totals);
  out.technicians = [...techTotals.entries()].map(([tech, totals]) => ({ technicianId: tech, ...finishTotals(totals) }));
  return out;
}

module.exports = { computeOpenTime, openTimeForDay, countedDays };
