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
 * - Leaving. "When you leave, Waves pays your unused hours", except after a quit
 *   without 14 days' notice or a dismissal for misconduct. So it is the owner's
 *   decision each time: technicians.pto_payout_week_start names the pay week whose
 *   run pays out everything the bank holds after that week, the week's own earned
 *   hours included. The paid-out hours are part of the check's pto_minutes (the bank
 *   reads zero after it) and earn nothing. A finalized run keeps the payouts it
 *   decided on its row (payroll_runs.bank_payouts), a payout of an empty bank
 *   included: the setting can move to another week later, and that payout made no
 *   check. No run of the technician that comes before such a run in the bank's order
 *   (the pay date first) is finalized or voided under it (laterPayoutDecisionExists).
 *   A week BEFORE the payout week that is paid on a later pay date is a catch-up check
 *   (work or a holiday recorded after the payout was paid, when its payment may be
 *   sent and its run cannot be voided): it pays the wages only. The week earns nothing
 *   into the bank and pays nothing out; the check shows the hours it would have earned,
 *   for the office to pay by hand (owner 2026-11-23 *a*; settleWeek catchUp,
 *   paidOutInLaterWeek). And a run pays no bank out while a final
 *   run for a later pay week holds a bank check of the technician or paid their bank
 *   out (laterWeekBankCheckExists).
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
 *   payOut           true on the pay run that pays out the bank (the technician leaves)
 *   catchUp          null, or { hoursPerYear } for a week before a pay week whose final run already paid the bank
 *                    out, paid after that run (applyBank, paidOutInLaterWeek): the check pays the wages only. The week
 *                    earns nothing into the bank and the check pays nothing out; `notPaidOut` = what the week would
 *                    have earned, shown on the check so the office can pay it by hand (owner 2026-11-23 *a*). The bank
 *                    was empty after the payout, so no time off of this week is paid from it.
 * Returns { paid, earlyPaid, unpaid, unpaidBeforeHire, unpaidByRule, earned, payout, notPaidOut, after, paidDays }. `earlyPaid`
 * is the part of `paid` that was early illness. Of `unpaid`: `unpaidBeforeHire` is time off before the hire
 * date, `unpaidByRule` is what the day-90 rule refused (not an illness day, or past the 16 hours), and the
 * rest is hours the bank did not hold. `paidDays` is `paid` by date, [{ workDate, units }] in date order:
 * the bank can pay one day of a week and not the next, so pay earned by date reads it from here.
 * `payout` is what the bank holds after the week, paid out when `payOut` is set; it is not in `paid`.
 */
function settleWeek({ hoursPerYear, bankBefore, earlyPaidBefore, hireDate, usableFrom, entries, regular, holiday, payOut = false, catchUp = null }) {
  // A catch-up week comes before the payout: the hours a later stay put in the bank are not this week's to use.
  let available = catchUp ? 0 : Math.max(0, bankBefore);
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
  // A catch-up week earns nothing into the bank: its hours are shown, not paid out (owner 2026-11-23 *a*).
  const notPaidOut = catchUp ? earnedHundredthsOfHour * 60 : 0;
  const earned = catchUp ? 0 : Math.min(earnedHundredthsOfHour * 60, Math.max(0, CAP - held));
  // The payout takes the hours this week earned too, and earns nothing itself: it is not in `straight`.
  const payout = payOut ? Math.max(0, held + earned) : 0;
  return { paid, earlyPaid, unpaid: booked - paid, unpaidBeforeHire, unpaidByRule, earned, payout, notPaidOut, after: held + earned - payout, paidDays };
}

// Why time off was not paid, as one plain sentence, with the hours of each cause when there are several.
// All in hundredths of a minute: `byRule` and `beforeHire` are parts of `unpaid`, the rest the bank did not hold.
// `paidOut` = the check is a catch-up check (settleWeek catchUp): the bank is short because a payout emptied it.
function unpaidReason(unpaid, byRule, beforeHire = 0, paidOut = false) {
  const causes = [
    [beforeHire, 'the time off is before the hire date'],
    [byRule, `up to day ${USE_AFTER_DAYS} the time-off bank pays only illness days, up to ${EARLY_ILLNESS_HOURS} hours`],
    [unpaid - byRule - beforeHire, paidOut
      ? 'the time-off bank was paid out before this paycheck, with every hour it held'
      : 'the time-off bank does not hold them'],
  ].filter(([units]) => units > 0);
  const total = `${hoursText(unpaid)} hours of time off are not paid`;
  if (causes.length === 1) return `${total}, because ${causes[0][1]}.`;
  const listed = causes.map(([units, why]) => `${hoursText(units)} because ${why}`);
  return `${total}: ${listed.slice(0, -1).join(', ')}, and ${listed[listed.length - 1]}.`;
}

// ---- Reading

// The W-2 technicians among `ids` who have a bank: Map of id -> { hoursPerYear, hireDate, payoutWeek }.
// `payoutWeek` = the pay week whose run pays out the bank ('YYYY-MM-DD'), or null.
// With lock, their rows are locked FOR SHARE, so a change of the yearly hours, the hire date or the
// payout week waits for the finalize that read them.
// `alsoIds` are read with no yearly hours too: a catch-up check settles from the payout, whatever the setting is now.
async function bankTechnicians(conn, ids, { lock = false, alsoIds = [] } = {}) {
  const byTech = new Map();
  if (!ids.length) return byTech;
  const query = conn('technicians')
    .whereIn('id', ids)
    .where({ employment_type: 'w2' })
    .where((has) => (alsoIds.length ? has.whereNotNull('pto_hours_per_year').orWhereIn('id', alsoIds) : has.whereNotNull('pto_hours_per_year')))
    .orderBy('id')
    .select('id', 'pto_hours_per_year', conn.raw("to_char(hire_date, 'YYYY-MM-DD') as hire_date"),
      conn.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') as payout_week"));
  if (lock) query.forShare();
  for (const row of await query) {
    byTech.set(row.id, { hoursPerYear: row.pto_hours_per_year == null ? null : Number(row.pto_hours_per_year), hireDate: row.hire_date || null, payoutWeek: row.payout_week || null });
  }
  return byTech;
}

// The technicians whose bank the pay run for the week starting `weekStart` pays out. The run gives each one
// a row, so the payout is paid in a week with no hours and no time off too. It keeps that row only for a W-2
// technician, and only when the bank pays something (payroll-runs.js evaluate), so no other rule is read here.
const payoutTechnicianIds = (conn, weekStart) => conn('technicians').where({ pto_payout_week_start: weekStart }).pluck('id');

// A payout the owner set for this week that the run neither keeps nor shows a row for: the technician has no
// time-off bank now (they are no W-2 employee any more, or a writer that is not the yearly-hours save cleared the
// hours; that save refuses under an open payout, payroll-time-off.js setPtoAllowance). `shownIds` = the technicians
// the run keeps a payout for, or shows as waiting or blocked. The run names the others as blocked, so a payout
// never disappears without a word, whichever writer took the bank away. `payoutWeek` marks the row: the pay run
// screen puts "Do not pay out" on it, because the Time off panel has no line for an employee with no bank.
const NO_BANK_FOR_PAYOUT_REASON = 'A time-off bank payout is set for this week, but the employee has no time-off bank now. Give the bank back (a W-2 employee with yearly hours) and this pay run pays it out, or press "Do not pay out" (owner account)';
async function payoutsNoRunRead(conn, weekStart, shownIds) {
  const rows = await conn('technicians').where({ pto_payout_week_start: weekStart })
    .orderBy([{ column: 'name' }, { column: 'id' }]).select('id', 'name');
  return rows.filter((row) => !shownIds.has(row.id))
    .map((row) => ({ technicianId: row.id, name: row.name, reason: NO_BANK_FOR_PAYOUT_REASON, payoutWeek: weekStart }));
}

// A payout is the last thing a bank does before it starts again from zero, so the pay runs around it go in the
// order of the pay weeks. A run holds a row for each of the two ways that order can break; the owner then pays
// the weeks in order or changes the payout, and no final run has to be voided (a sent payment refuses a void).
// 1. The payout is set for a pay week BEFORE this run's, and that week has no final pay run: a paycheck here
//    would be final before the payout that comes first (the payout could then never be made final).
const payoutNotFinalReason = (week) => `A time-off bank payout is set for the week of ${week}, and that week has no final pay run. Finalize that pay run first, or press "Do not pay out" and pick this week or a later one (Time off, owner account)`;
// 2. The payout is set for THIS run's week, and an earlier week of the technician still needs its paycheck: the
//    payout would miss what that week earns, and that week could not be paid after it (payroll-runs.js payoutWaits).
const weekBeforePayoutReason = (week) => `A time-off bank payout is set for this week, but the week of ${week} holds work or time off that no final pay run has paid. Pay that week first, or press "Do not pay out" (Time off, owner account)`;

// The technicians in `techs` (bankTechnicians) whose payout is set for a pay week before `weekStart` that has no
// final pay run: Map of id -> that week. A week whose final run did not keep the payout (payroll-time-off.js
// payoutOf, `missed`) is not asked: no run of that week pays it any more, so nothing comes first.
async function payoutsNotFinal(conn, techs, weekStart) {
  const open = new Map();
  const earlier = [...techs].filter(([, tech]) => tech.payoutWeek && tech.payoutWeek < weekStart);
  if (!earlier.length) return open;
  const final = new Set((await conn('payroll_runs')
    .where({ status: 'finalized' })
    .whereIn('week_start', [...new Set(earlier.map(([, tech]) => tech.payoutWeek))])
    .select(conn.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"))).map((row) => row.week_start));
  for (const [id, tech] of earlier) if (!final.has(tech.payoutWeek)) open.set(id, tech.payoutWeek);
  return open;
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

// The technicians whose bank a run paid out, as its row keeps them, with or without a check: ids as the row
// spells them (payroll_runs.bank_payouts, written at finalize). Read from the row itself, also with the gate off:
// a kept payout counts in the other runs either way.
async function keptPayoutsOfRun(conn, runId) {
  const row = await conn('payroll_runs').where({ id: runId }).first('bank_payouts');
  return (row && Array.isArray(row.bank_payouts) ? row.bank_payouts : []).map((kept) => kept.technicianId);
}

// Sets the payout week back to `weekStart` for the technicians among `technicianIds` who have none set now, and
// returns their ids (payroll-runs.js voidRun, for the payouts the voided run had kept). One whose payout is still
// set for this week needs no change, and voidRun refuses while one is set for another week (payoutsSetElsewhere).
async function reopenPayouts(conn, weekStart, technicianIds) {
  if (!technicianIds.length) return [];
  const rows = await conn('technicians').whereIn('id', technicianIds).whereNull('pto_payout_week_start')
    .update({ pto_payout_week_start: weekStart, updated_at: conn.fn.now() }).returning('id');
  return rows.map((row) => (row && row.id ? row.id : row)).sort();
}

// A void puts a payout its run had paid back on that run's week (reopenPayouts). It cannot while the owner has set
// a payout of the same bank for ANOTHER week since (an employee who came back and leaves again): the run made again
// would pay the wages alone, and the hours the void gives back would go out with the other payout, at that week's
// rate. So voidRun refuses until the other payout is taken back. That one is not final: a later final run that
// kept a payout of the technician refuses the void before this is asked (laterPayoutDecisionExists).
// Returns [{ id, name, week }] in name order for the technicians among `technicianIds` (the payouts the run kept).
const payoutSetElsewhereReason = ({ name, week }) => `This pay run paid out the time-off bank of ${name}, and a payout of that bank is now set for the week of ${week}. Press "Do not pay out" for that week first (Time off, owner account), then void this pay run. Set that payout again after this week is paid again.`;
async function payoutsSetElsewhere(conn, weekStart, technicianIds) {
  if (!technicianIds.length) return [];
  return conn('technicians').whereIn('id', technicianIds).whereNotNull('pto_payout_week_start')
    .whereNot('pto_payout_week_start', weekStart)
    .orderBy([{ column: 'name' }, { column: 'id' }])
    .select('id', 'name', conn.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') AS week"));
}

// The earliest fact on file, for each technician among `ids`, that only a W-2 employee has and that is no paycheck:
// Map of id -> 'YYYY-MM-DD'. It is the pay week of a pay run that was final once (voided since or not) and kept a
// decision of theirs with no check (time off left unpaid, or a bank paid out), or the day of a time-off entry (the
// time-off form takes W-2 employees only). payroll-runs.js payoutAsksFrom reads it next to the paychecks: one
// before the week of the hire date is an earlier stay.
async function firstBankFactDays(conn, ids) {
  const first = new Map();
  if (!ids.length) return first;
  const note = (id, day) => { if (!first.has(id) || day < first.get(id)) first.set(id, day); };
  const kept = await conn('technicians as t').crossJoin('payroll_runs as r')
    .whereIn('t.id', ids)
    .whereNotNull('r.finalized_at')
    .where(function decided() {
      this.whereRaw("EXISTS (SELECT 1 FROM jsonb_array_elements(r.unpaid_time_off) AS kept WHERE (kept->>'technicianId')::uuid = t.id)")
        .orWhereRaw("EXISTS (SELECT 1 FROM jsonb_array_elements(r.bank_payouts) AS kept WHERE (kept->>'technicianId')::uuid = t.id)");
    })
    .groupBy('t.id')
    .select('t.id', conn.raw("to_char(MIN(r.week_start), 'YYYY-MM-DD') AS day"));
  for (const row of kept) note(row.id, row.day);
  const off = await conn('payroll_time_off').whereIn('technician_id', ids).groupBy('technician_id')
    .select('technician_id', conn.raw("to_char(MIN(work_date), 'YYYY-MM-DD') AS day"));
  for (const row of off) note(row.technician_id, row.day);
  return first;
}

// A final pay run of a LATER pay week already holds a bank check of this technician, or paid their bank out. The
// run of `weekStart` could then never pay the bank out (finalizeRun: laterWeekBankCheckExists refuses it on
// every pay date), and the payout would hold their next paychecks
// (payoutsNotFinal). So that week is not set for a payout (payroll-time-off.js setPtoPayoutWeek).
async function laterWeekBankUseExists(conn, weekStart, technicianId) {
  const check = await conn('payroll_checks')
    .where({ status: 'finalized', technician_id: technicianId })
    .whereNotNull('pto_earned_minutes')
    .where('week_start', '>', weekStart)
    .first('id');
  if (check) return true;
  const paidOut = await conn('payroll_runs as r')
    .where('r.status', 'finalized')
    .where('r.week_start', '>', weekStart)
    .whereRaw(
      "EXISTS (SELECT 1 FROM jsonb_array_elements(r.bank_payouts) AS kept WHERE (kept->>'technicianId')::uuid = ?::uuid)",
      [technicianId],
    )
    .first('r.id');
  return Boolean(paidOut);
}

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

// A finalized run for a LATER pay week holds a bank check of one of these technicians, or paid their bank out
// (also an empty one, with no check), whatever its pay date. Asked for the technicians a run pays out: a payout
// pays what the bank holds after its week, and it is the last thing a bank does before it starts again. On a pay
// date after that check's, the bank's order (the pay date first) would put the later week's hours in this
// payout. The owner picks that later week for the payout, or voids its run first.
async function laterWeekBankCheckExists(conn, run, technicianIds) {
  if (!technicianIds.length) return false;
  const check = await conn('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .whereNotNull('pto_earned_minutes')
    .whereNot({ run_id: run.id })
    .where('week_start', '>', run.week_start)
    .first('id');
  if (check) return true;
  const paidOut = await conn('payroll_runs as r')
    .where('r.status', 'finalized')
    .whereNot('r.id', run.id)
    .where('r.week_start', '>', run.week_start)
    .whereRaw(
      "EXISTS (SELECT 1 FROM jsonb_array_elements(r.bank_payouts) AS kept WHERE (kept->>'technicianId')::uuid = ANY(?::uuid[]))",
      [technicianIds],
    )
    .first('r.id');
  return Boolean(paidOut);
}

// The technicians among `ids` whose bank a finalized run for a LATER pay week paid out, on a pay date before
// `payDate`: Map of id -> { hoursPerYear } (settleWeek catchUp). A check of theirs for this earlier week comes after
// that payout in the bank's order, so it is a catch-up check. A payout on the same or a later pay date comes after
// this run in the bank's order: finalizeRun refuses this run under it (laterPayoutDecisionExists), and nothing is
// caught up. The yearly hours are the ones the first such payout kept at finalize (the setting can be cleared after
// the payout is final): the check shows what the week would have earned at them.
async function paidOutInLaterWeek(conn, ids, { weekStart, payDate }) {
  const byTech = new Map();
  if (!ids.length) return byTech;
  const { rows } = await conn.raw(
    `SELECT DISTINCT ON (t.id) t.id AS technician_id,
        COALESCE(NULLIF(kept->>'hoursPerYear', '')::numeric, t.pto_hours_per_year, 0) AS hours_per_year
      FROM technicians AS t
      JOIN payroll_runs AS r ON r.status = 'finalized' AND r.week_start > ? AND r.pay_date < ?
      CROSS JOIN LATERAL jsonb_array_elements(r.bank_payouts) AS kept
      WHERE t.id = ANY(?::uuid[]) AND (kept->>'technicianId')::uuid = t.id
      ORDER BY t.id, r.week_start`,
    [weekStart, payDate, ids],
  );
  for (const row of rows) byTech.set(row.technician_id, { hoursPerYear: Number(row.hours_per_year) });
  return byTech;
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

// A later finalized run paid out the bank of one of these technicians and kept that decision on its row
// (payroll_runs.bank_payouts, written at finalize), also when the bank was empty and it made no check for
// them, which the two guards above cannot see. Hours this run adds, or gives back when it is voided, would
// have changed what that run paid out, and the technician has left. The kept list is read, not the
// technician's payout week: that setting can move to another week after the run is final.
// "Later" is the bank's order: the pay date, then the pay week. A week BEFORE the payout week that is paid on a
// later pay date comes after the payout in that order and is not refused: its check is a catch-up check, which
// pays the wages only (paidOutInLaterWeek). That is the way to pay work recorded after a payout whose
// payment was sent, when the payout run cannot be voided any more. Asked for the technicians whose check holds a
// bank and the ones the run pays out, and every other technician with a check (finalizeRun). Time off a run
// leaves unpaid with no check changes nothing in the bank.
async function laterPayoutDecisionExists(conn, run, technicianIds) {
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
      "EXISTS (SELECT 1 FROM jsonb_array_elements(r.bank_payouts) AS kept WHERE (kept->>'technicianId')::uuid = ANY(?::uuid[]))",
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
 * Returns { rows, holds, unpaid, payouts }:
 *   holds   Map of technician id -> the reason the check cannot be worked out (no hire date; a payout set for
 *           an earlier week that is not final, payoutsNotFinal)
 *   unpaid  [{ technicianId, name, hours, reason }] for time off that was not paid
 *   payouts [{ technicianId, name, hours }] for each technician whose bank this run pays out, also
 *           with 0.00 hours (an empty bank): the run decides the payout either way
 */
async function applyBank(conn, rows, { start, end, payDate, lock = false }) {
  const holds = new Map();
  const unpaid = [];
  const payouts = [];
  const rowIds = [...new Set(rows.map((row) => row.technician_id))];
  const caughtUp = await paidOutInLaterWeek(conn, rowIds, { weekStart: start, payDate });
  const techs = await bankTechnicians(conn, rowIds, { lock, alsoIds: [...caughtUp.keys()] });
  if (!techs.size) return { rows, holds, unpaid, payouts };
  const ids = [...techs.keys()];
  const sums = await bankSums(conn, ids, { payDate, weekStart: start });
  const entries = await ptoEntries(conn, ids, start, end);
  const notFinal = await payoutsNotFinal(conn, techs, start);
  const settled = rows.map((row) => {
    const tech = techs.get(row.technician_id);
    if (!tech) return row;
    if (notFinal.has(row.technician_id)) {
      holds.set(row.technician_id, payoutNotFinalReason(notFinal.get(row.technician_id)));
      return row;
    }
    const days = entries.get(row.technician_id) || [];
    if (days.length && !tech.hireDate) {
      holds.set(row.technician_id, NO_HIRE_DATE_REASON);
      return row;
    }
    const before = sums.get(row.technician_id);
    const catchUp = caughtUp.get(row.technician_id) || null;
    const week = settleWeek({
      hoursPerYear: catchUp ? catchUp.hoursPerYear : tech.hoursPerYear,
      bankBefore: before.bank,
      earlyPaidBefore: before.earlyPaid,
      hireDate: tech.hireDate,
      usableFrom: usableFromOf(tech.hireDate),
      entries: days,
      regular: toUnits(row.regular_minutes),
      holiday: toUnits(row.holiday_minutes),
      payOut: tech.payoutWeek === start,
      catchUp,
    });
    if (week.unpaid > 0) {
      unpaid.push({
        technicianId: row.technician_id, name: row.name, hours: hoursText(week.unpaid),
        reason: unpaidReason(week.unpaid, week.unpaidByRule, week.unpaidBeforeHire, caughtUp.has(row.technician_id)),
      });
    }
    // hoursPerYear: a catch-up check after this payout shows what it would have earned at the yearly hours in force on leaving.
    if (tech.payoutWeek === start) payouts.push({ technicianId: row.technician_id, name: row.name, hours: hoursText(week.payout), hoursPerYear: tech.hoursPerYear });
    return {
      ...row,
      // The paid-out hours are paid at the same rate as time off, on the same line of the check.
      pto_minutes: minutesOf(week.paid + week.payout),
      pto_bank: {
        earnedMinutes: minutesOf(week.earned),
        payoutMinutes: minutesOf(week.payout),
        // A catch-up check: the hours the week would have earned, not paid out (the office pays them by hand).
        ...(week.notPaidOut > 0 ? { notPaidOutMinutes: minutesOf(week.notPaidOut) } : {}),
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
  return { rows: settled, holds, unpaid, payouts };
}

module.exports = {
  CAP_HOURS,
  USE_AFTER_DAYS,
  EARLY_ILLNESS_HOURS,
  NO_HIRE_DATE_REASON,
  NO_BANK_FOR_PAYOUT_REASON,
  payoutNotFinalReason,
  weekBeforePayoutReason,
  payoutsNotFinal,
  toUnits,
  hoursText,
  fullWeekHundredths,
  usableFromOf,
  settleWeek,
  unpaidReason,
  bankTechnicians,
  payoutTechnicianIds,
  payoutsNoRunRead,
  bankSums,
  ptoWaiting,
  bankTechniciansOfRun,
  keptPayoutsOfRun,
  reopenPayouts,
  payoutSetElsewhereReason,
  payoutsSetElsewhere,
  firstBankFactDays,
  paidOutInLaterWeek,
  laterWeekBankUseExists,
  laterBankCheckExists,
  laterWeekBankCheckExists,
  laterUnpaidDecisionExists,
  laterPayoutDecisionExists,
  unpaidDecisionWeeks,
  earlyIllnessWaiting,
  applyBank,
};
