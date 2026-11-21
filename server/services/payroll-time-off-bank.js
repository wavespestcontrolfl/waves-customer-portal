/**
 * Time-off bank (owner 2026-11-21, "lets do these now"; handbook draft, section
 * "Paid time off"). No gate of its own: every caller already runs behind
 * GATE_PAYROLL_TIME_OFF, and a W-2 technician has a bank only when
 * technicians.pto_hours_per_year is set (the hours a year of full weeks earns).
 * With no number set, nothing here changes that technician's pay.
 *
 * The bank is not a ledger. It is the sum over the technician's FINALIZED checks of
 * (pto_earned_minutes - pto_minutes): what each check earned, less the paid time
 * off it paid. A voided run leaves the sum by its status; no row is ever edited.
 * A check made before the technician had a bank (pto_earned_minutes NULL) counts
 * for nothing.
 *
 * The rules, each from the handbook draft:
 * - Earning. A full 40-hour week earns the yearly hours / 52, rounded to a
 *   hundredth of an hour as the handbook prints it (80 -> 1.54). A part week earns
 *   the same share of that as its paid straight-time hours are of 40: worked
 *   regular hours, time off the bank paid, and holiday hours. Overtime earns nothing.
 * - The cap. The bank never holds more than 120 hours: a week earns only up to
 *   the room left after that week's own use.
 * - Use. A pay run pays paid time off only from the bank, in date order. Hours
 *   past the bank are unpaid ("At zero, a sick day is unpaid").
 * - Day 90. The hire date is day 1, and the bank pays no day before it. A day up
 *   to day 90 (before the hire date + 90 days) is paid only when it is marked
 *   illness, and only up to 16 hours in all, from hours the bank holds. Each check stores the early illness minutes it paid
 *   (pto_early_illness_minutes), so only those count toward the 16 hours. With no
 *   hire date on file the pay run holds the check of a week that has paid time
 *   off, rather than guess.
 * - Order. A check reads the bank its earlier checks left, in any year (the bank
 *   has no year-end reset). So a run is not finalized or voided under a later
 *   finalized check that holds a bank (laterBankCheckExists), and not under a
 *   later finalized run that left time off of the technician unpaid: that run
 *   decided it from the bank as it stood, with or without a check, and kept the
 *   decision on its row (payroll_runs.unpaid_time_off, laterUnpaidDecisionExists).
 *
 * All arithmetic is in whole hundredths of a minute, the unit of the numeric(10,2)
 * minute columns, so nothing drifts.
 */
const { addStaffWorkDays } = require('../utils/staff-time-work-date');

const CAP_HOURS = 120;
const USE_AFTER_DAYS = 90;
const EARLY_ILLNESS_HOURS = 16;
const FULL_WEEK_HOURS = 40;
const WEEKS_PER_YEAR = 52;

// Hundredths of a minute.
const HOUR = 6000;
const CAP = CAP_HOURS * HOUR;
const EARLY_ILLNESS = EARLY_ILLNESS_HOURS * HOUR;
const FULL_WEEK = FULL_WEEK_HOURS * HOUR;

const NO_HIRE_DATE_REASON = 'Hire date is not on file (Time Tracking, Team). The time-off bank needs it to pay time off';

// numeric(10,2) minutes (text or number) <-> whole hundredths of a minute.
const toUnits = (minutes) => Math.round(Number(minutes || 0) * 100);
const minutesOf = (units) => units / 100;
const hoursText = (units) => (Math.round(units / 60) / 100).toFixed(2);

// What a full 40-hour week earns, in hundredths of an HOUR: the yearly hours / 52, rounded half up.
function fullWeekHundredths(hoursPerYear) {
  return Math.round(Math.round(Number(hoursPerYear) * 100) / WEEKS_PER_YEAR);
}

// The first date paid time off is paid without the illness rule: hire date + 90 days. null with no hire date.
const usableFromOf = (hireDate) => (hireDate ? addStaffWorkDays(hireDate, USE_AFTER_DAYS) : null);

/**
 * One technician's week, pure. Units are hundredths of a minute.
 *   bankBefore       the bank before this week (finalized checks that sort before this one)
 *   earlyPaidBefore  early illness minutes those checks paid; read only for days before `usableFrom`
 *   hireDate         day 1 of the job ('YYYY-MM-DD'); the bank pays no day before it
 *   usableFrom       hire date + 90 days ('YYYY-MM-DD')
 *   entries          this week's paid-time-off days: [{ workDate, units, illness }]
 *   regular, holiday the week's worked regular minutes and holiday minutes
 * Returns { paid, earlyPaid, unpaid, unpaidBeforeHire, unpaidByRule, earned, after, paidDays }. `earlyPaid`
 * is the part of `paid` that was early illness. Of `unpaid`: `unpaidBeforeHire` is time off before the hire
 * date, `unpaidByRule` is what the day-90 rule refused (not an illness day, or past the 16 hours), and the
 * rest is hours the bank did not hold. `paidDays` is `paid` by date, [{ workDate, units }] in date order:
 * the bank can pay one day of a week and not the next, so pay earned by date reads it from here.
 */
function settleWeek({ hoursPerYear, bankBefore, earlyPaidBefore, hireDate, usableFrom, entries, regular, holiday }) {
  let available = Math.max(0, bankBefore);
  let earlyLeft = Math.max(0, EARLY_ILLNESS - earlyPaidBefore);
  let paid = 0;
  let earlyPaid = 0;
  let booked = 0;
  let unpaidBeforeHire = 0;
  let unpaidByRule = 0;
  const paidDays = [];
  const inDateOrder = [...entries].sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0));
  for (const entry of inDateOrder) {
    booked += entry.units;
    if (entry.workDate < hireDate) {
      // Not a day of the job: no rule opens the bank for it, an illness mark included.
      unpaidBeforeHire += entry.units;
      continue;
    }
    // What the day-90 rule lets this day be paid; from the first open date, all of it.
    let allowed = entry.units;
    if (entry.workDate < usableFrom) allowed = entry.illness ? Math.min(entry.units, earlyLeft) : 0;
    const pays = Math.min(allowed, available);
    if (entry.workDate < usableFrom) {
      earlyLeft -= pays;
      earlyPaid += pays;
    }
    unpaidByRule += entry.units - allowed;
    available -= pays;
    paid += pays;
    if (pays > 0) paidDays.push({ workDate: entry.workDate, units: pays });
  }
  const straight = Math.min(FULL_WEEK, regular + paid + holiday);
  const earnedHundredthsOfHour = Math.round((fullWeekHundredths(hoursPerYear) * straight) / FULL_WEEK);
  const held = bankBefore - paid;
  const earned = Math.min(earnedHundredthsOfHour * 60, Math.max(0, CAP - held));
  return { paid, earlyPaid, unpaid: booked - paid, unpaidBeforeHire, unpaidByRule, earned, after: held + earned, paidDays };
}

// Why time off was not paid, as one plain sentence, with the hours of each cause when there are several.
// All in hundredths of a minute: `byRule` and `beforeHire` are parts of `unpaid`, the rest the bank did not hold.
function unpaidReason(unpaid, byRule, beforeHire = 0) {
  const causes = [
    [beforeHire, 'the time off is before the hire date'],
    [byRule, `up to day ${USE_AFTER_DAYS} the time-off bank pays only illness days, up to ${EARLY_ILLNESS_HOURS} hours`],
    [unpaid - byRule - beforeHire, 'the time-off bank does not hold them'],
  ].filter(([units]) => units > 0);
  const total = `${hoursText(unpaid)} hours of time off are not paid`;
  if (causes.length === 1) return `${total}, because ${causes[0][1]}.`;
  const listed = causes.map(([units, why]) => `${hoursText(units)} because ${why}`);
  return `${total}: ${listed.slice(0, -1).join(', ')}, and ${listed[listed.length - 1]}.`;
}

// ---- Reading

// The W-2 technicians among `ids` who have a bank: Map of id -> { hoursPerYear, hireDate }.
// With lock, their rows are locked FOR SHARE, so a change of the yearly hours or the hire date
// waits for the finalize that read them.
async function bankTechnicians(conn, ids, { lock = false } = {}) {
  const byTech = new Map();
  if (!ids.length) return byTech;
  const query = conn('technicians')
    .whereIn('id', ids)
    .where({ employment_type: 'w2' })
    .whereNotNull('pto_hours_per_year')
    .orderBy('id')
    .select('id', 'pto_hours_per_year', conn.raw("to_char(hire_date, 'YYYY-MM-DD') as hire_date"));
  if (lock) query.forShare();
  for (const row of await query) {
    byTech.set(row.id, { hoursPerYear: Number(row.pto_hours_per_year), hireDate: row.hire_date || null });
  }
  return byTech;
}

// The bank of each technician from finalized checks, in hundredths of a minute:
// Map of id -> { bank, earlyPaid }. `earlyPaid` = the early illness minutes those checks paid. `before` = { payDate, weekStart } limits the sum to checks that
// sort before that check (the order year-to-date uses, here across years); without it, every
// finalized check counts (the bank today).
async function bankSums(conn, ids, before = null) {
  const byTech = new Map(ids.map((id) => [id, { bank: 0, earlyPaid: 0 }]));
  if (!ids.length) return byTech;
  const query = conn('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', ids)
    .whereNotNull('pto_earned_minutes')
    .groupBy('technician_id')
    .select(
      'technician_id',
      conn.raw('SUM(pto_earned_minutes - pto_minutes) AS bank'),
      conn.raw('COALESCE(SUM(pto_early_illness_minutes), 0) AS early_paid'),
    );
  if (before) {
    query.where(function earlier() {
      this.where('pay_date', '<', before.payDate).orWhere(function sameDay() {
        this.where('pay_date', before.payDate).andWhere('week_start', '<', before.weekStart);
      });
    });
  }
  for (const row of await query) byTech.set(row.technician_id, { bank: toUnits(row.bank), earlyPaid: toUnits(row.early_paid) });
  return byTech;
}

// The paid-time-off days of the week for each technician: Map of id -> [{ workDate, units, illness }].
async function ptoEntries(conn, ids, start, end) {
  const byTech = new Map();
  if (!ids.length) return byTech;
  const rows = await conn('payroll_time_off')
    .whereIn('technician_id', ids)
    .where({ kind: 'pto' })
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .orderBy([{ column: 'technician_id' }, { column: 'work_date' }])
    .select('technician_id', 'minutes', 'illness', conn.raw("to_char(work_date, 'YYYY-MM-DD') as work_date"));
  for (const row of rows) {
    const list = byTech.get(row.technician_id) || [];
    list.push({ workDate: row.work_date, units: toUnits(row.minutes), illness: row.illness === true });
    byTech.set(row.technician_id, list);
  }
  return byTech;
}

// Paid time off recorded for a week that no finalized pay run has paid yet, in hundredths of a minute.
// The pay week starts on Monday, as date_trunc('week') does; the cast keeps the session time zone out of it.
// With `early` = { from, before }, only the illness days in that span of dates.
async function ptoWaiting(conn, technicianId, early = null) {
  const query = conn('payroll_time_off as o')
    .where({ 'o.technician_id': technicianId, 'o.kind': 'pto' })
    .whereNotExists(function paidWeek() {
      this.select(conn.raw('1')).from('payroll_runs as r')
        .where('r.status', 'finalized')
        .whereRaw("r.week_start = date_trunc('week', o.work_date::timestamp)::date");
    });
  if (early) query.where('o.illness', true).where('o.work_date', '>=', early.from).where('o.work_date', '<', early.before);
  const row = await query.first(conn.raw('COALESCE(SUM(o.minutes), 0) AS minutes'));
  return toUnits(row.minutes);
}

// The illness days waiting for a pay run in the days the early rule covers (hire date up to the first open
// date), against what is left of the EARLY_ILLNESS_HOURS: { left, waiting, short }, hundredths of a minute.
// `short` is what the rule will not pay. `earlyPaid` comes from bankSums.
async function earlyIllnessWaiting(conn, technicianId, { hireDate, usableFrom, earlyPaid }) {
  const waiting = await ptoWaiting(conn, technicianId, { from: hireDate, before: usableFrom });
  const left = Math.max(0, EARLY_ILLNESS - earlyPaid);
  return { left, waiting, short: Math.max(0, waiting - left) };
}

// The technicians whose check on this run holds a bank (any status of the check).
const bankTechniciansOfRun = (conn, runId) => conn('payroll_checks')
  .where({ run_id: runId })
  .whereNotNull('pto_earned_minutes')
  .pluck('technician_id');

// A later finalized check of one of these technicians already read the bank without this run.
// Year-to-date has the same guard inside one year (payroll-runs.js laterFinalCheckExists); the
// bank carries over, so this one has no year limit.
async function laterBankCheckExists(conn, run, technicianIds) {
  if (!technicianIds.length) return false;
  const found = await conn('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .whereNotNull('pto_earned_minutes')
    .whereNot({ run_id: run.id })
    .where(function later() {
      this.where('pay_date', '>', run.pay_date).orWhere(function sameDay() {
        this.where('pay_date', run.pay_date).andWhere('week_start', '>', run.week_start);
      });
    })
    .first('id');
  return Boolean(found);
}

// A later finalized run that left time off of one of these technicians unpaid decided that from the
// bank as it stood then, with or without a check, and kept the decision on its row
// (payroll_runs.unpaid_time_off, written at finalize). Hours this run adds, or gives back when it is
// voided, would have changed that answer, and that week is closed. Time off that run paid is on a
// check, which laterBankCheckExists finds; a run finalized with no bank kept no list.
async function laterUnpaidDecisionExists(conn, run, technicianIds) {
  if (!technicianIds.length) return false;
  const found = await conn('payroll_runs as r')
    .where('r.status', 'finalized')
    .whereNot('r.id', run.id)
    .where(function later() {
      this.where('r.pay_date', '>', run.pay_date).orWhere(function sameDay() {
        this.where('r.pay_date', run.pay_date).andWhere('r.week_start', '>', run.week_start);
      });
    })
    .whereRaw(
      "EXISTS (SELECT 1 FROM jsonb_array_elements(r.unpaid_time_off) AS kept WHERE (kept->>'technicianId')::uuid = ANY(?::uuid[]))",
      [technicianIds],
    )
    .first('r.id');
  return Boolean(found);
}

// The weeks among `weekStarts` (Monday dates) whose finalized pay run kept time off of the technician as
// not paid (payroll_runs.unpaid_time_off). That run decided the week for them, with or without a check, and
// no later run pays it. A voided run is not in the answer, so a void opens the week again.
async function unpaidDecisionWeeks(conn, technicianId, weekStarts) {
  if (!weekStarts.length) return [];
  const rows = await conn('payroll_runs as r')
    .where('r.status', 'finalized')
    .whereIn('r.week_start', weekStarts)
    .whereRaw(
      "EXISTS (SELECT 1 FROM jsonb_array_elements(r.unpaid_time_off) AS kept WHERE (kept->>'technicianId')::uuid = ?::uuid)",
      [technicianId],
    )
    .select(conn.raw("to_char(r.week_start, 'YYYY-MM-DD') AS week_start"));
  return rows.map((row) => row.week_start);
}

/**
 * The pay run's step (payroll-runs.js evaluate). `rows` are the week's check rows with
 * regular_minutes, pto_minutes and holiday_minutes: worked weeks, weeks of time off alone, and
 * pay-line-only rows. For a technician with a bank, pto_minutes becomes what the bank pays and the
 * row gains `pto_bank`; every other row is returned as it came.
 * Returns { rows, holds, unpaid }:
 *   holds   Map of technician id -> the reason the check cannot be worked out (no hire date)
 *   unpaid  [{ technicianId, name, hours, reason }] for time off that was not paid
 */
async function applyBank(conn, rows, { start, end, payDate, lock = false }) {
  const holds = new Map();
  const unpaid = [];
  const techs = await bankTechnicians(conn, rows.map((row) => row.technician_id), { lock });
  if (!techs.size) return { rows, holds, unpaid };
  const ids = [...techs.keys()];
  const sums = await bankSums(conn, ids, { payDate, weekStart: start });
  const entries = await ptoEntries(conn, ids, start, end);
  const settled = rows.map((row) => {
    const tech = techs.get(row.technician_id);
    if (!tech) return row;
    const days = entries.get(row.technician_id) || [];
    if (days.length && !tech.hireDate) {
      holds.set(row.technician_id, NO_HIRE_DATE_REASON);
      return row;
    }
    const before = sums.get(row.technician_id);
    const week = settleWeek({
      hoursPerYear: tech.hoursPerYear,
      bankBefore: before.bank,
      earlyPaidBefore: before.earlyPaid,
      hireDate: tech.hireDate,
      usableFrom: usableFromOf(tech.hireDate),
      entries: days,
      regular: toUnits(row.regular_minutes),
      holiday: toUnits(row.holiday_minutes),
    });
    if (week.unpaid > 0) {
      unpaid.push({
        technicianId: row.technician_id, name: row.name, hours: hoursText(week.unpaid),
        reason: unpaidReason(week.unpaid, week.unpaidByRule, week.unpaidBeforeHire),
      });
    }
    return {
      ...row,
      pto_minutes: minutesOf(week.paid),
      pto_bank: {
        earnedMinutes: minutesOf(week.earned),
        earlyIllnessMinutes: minutesOf(week.earlyPaid),
        unpaidMinutes: minutesOf(week.unpaid),
        unpaidRuleMinutes: minutesOf(week.unpaidByRule),
        unpaidBeforeHireMinutes: minutesOf(week.unpaidBeforeHire),
        beforeMinutes: minutesOf(before.bank),
        afterMinutes: minutesOf(week.after),
        // What the bank paid on each date. Pay earned by date (tech-rewards-scoreboard.js readGross) reads it.
        paidDays: week.paidDays.map((day) => ({ workDate: day.workDate, minutes: minutesOf(day.units) })),
      },
    };
  });
  return { rows: settled, holds, unpaid };
}

module.exports = {
  CAP_HOURS,
  USE_AFTER_DAYS,
  EARLY_ILLNESS_HOURS,
  NO_HIRE_DATE_REASON,
  toUnits,
  hoursText,
  fullWeekHundredths,
  usableFromOf,
  settleWeek,
  unpaidReason,
  bankTechnicians,
  bankSums,
  ptoWaiting,
  bankTechniciansOfRun,
  laterBankCheckExists,
  laterUnpaidDecisionExists,
  unpaidDecisionWeeks,
  earlyIllnessWaiting,
  applyBank,
};
