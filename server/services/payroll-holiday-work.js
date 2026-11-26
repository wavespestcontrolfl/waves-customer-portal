/**
 * Holiday work minutes (the extra half of "hours worked on the day a holiday is taken", payroll-calc.js).
 *
 * THE RULE (owner-approved design, 2026-11-23): the premium belongs to the SHIFT that earned it, and is paid in the pay week
 * that pays that shift's hours. The shift's work date is its clock-in Eastern date, as the weekly summary has it. For a pay
 * week, take the completed shifts whose work date is in the week, clip each to every holiday it overlaps, and sum. A holiday
 * is a payroll_time_off row of kind holiday on an Eastern calendar date; it may fall in the NEXT pay week (a Sunday 10 PM to
 * Monday 2 AM shift earns its 2 holiday hours on the Sunday's check, and the Monday holiday week pays nothing for it, so it
 * is never paid twice, and it is paid even when the technician works no other shift in the holiday week). The result keeps
 * the holiday's own date (calc_snapshot.holidayWorkDays), which is the date Tech Rewards dates the premium by.
 *
 * - A holiday day is [ET midnight of D, ET midnight of D + 1) as instants (datetime-et.js parseETDateTime: DST-safe, a day
 *   is 23 or 25 hours twice a year). Never a fixed offset.
 * - Shifts are chosen by their work date; a shift of any length counts for every holiday it overlaps (a corrected shift from
 *   Monday 11 PM to Wednesday 1 AM overlaps Tuesday and Wednesday). The holidays read run from the week's start to the day
 *   the last of the week's shifts ends (their actual clock-outs): no fixed look-ahead.
 * - Every figure is a whole number of hundredths of a minute and the split of a work date is ONE exact procedure
 *   (splitWorkDate): each shift's STORED paid hundredths (duration_minutes, what the pay pays) are shared across the holidays it
 *   overlaps and the rest of it by the clock milliseconds in each; the recorded meal (breaks of 30 minutes or more of THAT work
 *   date, clipped to its shifts) is placed in the parts by clock time, each part capped at its own paid hundredths and the
 *   total at the deduction; the rest of the deduction (the day summary's unpaid_meal_minutes: what the pay deducts, 0 since
 *   Waves takes no unpaid lunch (owner 2026-11-22), never more than the paid total) is shared by the hundredths each part has left. Every share is a
 *   largest-remainder allocation (allocate), so the parts add up to exactly the stored total less the deduction.
 * - Fallback, per work date: when the time entries cannot give clock times for that date (a shift with no clock-out, or no
 *   shift entries while the day's summary holds shift minutes), the date's summary row is read as a whole (shift minutes
 *   less unpaid meal, as the weekly pay sums them) and counts for that date only, when that date is itself a holiday. The
 *   other dates of the week keep their measured overlap.
 * All figures are whole hundredths of a minute inside; minutes out are numbers with two decimals.
 */
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate, staffWorkDateSql, STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');
const { UNPAID_MEAL_MIN_BREAK_MINUTES } = require('../constants/staff-time');
const { payrollUnits } = require('../utils/payroll-units');

const HUNDREDTHS_PER_MS = 1 / 600; // 1 ms = 1/60000 minute = 1/600 hundredth

const hundredths = (minutes) => Math.round(Number(minutes || 0) * 100);

// The instants of ET midnight at the start of `day` and of the next day.
function dayBounds(day) {
  return {
    start: parseETDateTime(`${day}T00:00`).getTime(),
    end: parseETDateTime(`${addStaffWorkDays(day, 1)}T00:00`).getTime(),
  };
}

// The stored paid hundredths of an entry, exactly as time tracking counts them (payroll-units.js payrollUnits over
// duration_minutes: a null duration is 0). No fallback to the clock interval: the pay pays the stored figure.
const fullHundredths = (entry) => Number(payrollUnits(entry.duration_minutes));

const msOf = (value) => new Date(value).getTime();
// The milliseconds of [from, to) that fall inside the day `bounds`.
const overlapMs = (from, to, bounds) => Math.max(0, Math.min(to, bounds.end) - Math.max(from, bounds.start));

// The completed breaks of 30 minutes or more (the pay's own test, on the whole break), each clipped to every shift it overlaps:
// [{ from, to, hundredths }] in ms. A break wholly inside its shift keeps its stored duration, as the pay counts it.
function recordedMealPieces(breaks, shifts, floor) {
  const pieces = [];
  for (const b of breaks) {
    if (!b.clock_out || fullHundredths(b) < floor) continue;
    for (const s of shifts) {
      const from = Math.max(msOf(b.clock_in), msOf(s.clock_in));
      const to = Math.min(msOf(b.clock_out), msOf(s.clock_out));
      if (to <= from) continue;
      const whole = from === msOf(b.clock_in) && to === msOf(b.clock_out);
      pieces.push({ id: b.id || null, from, to, hundredths: whole ? fullHundredths(b) : Math.round((to - from) * HUNDREDTHS_PER_MS) });
    }
  }
  return pieces;
}

// `total` (whole hundredths) shared in proportion to `weights` by largest remainder: whole numbers that add up to exactly
// `total`, the leftover hundredths going to the largest fractional parts, ties to the earliest part. All weights zero: all to the
// first part. Pure and deterministic.
function allocate(total, weights) {
  if (total <= 0) return weights.map(() => 0);
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0) return weights.map((_, n) => (n === 0 ? total : 0));
  const shares = weights.map((w) => ({ whole: Math.floor((total * w) / sum), rest: (total * w) % sum }));
  let left = total - shares.reduce((acc, share) => acc + share.whole, 0);
  const order = shares.map((share, n) => n).sort((a, b) => (shares[b].rest - shares[a].rest) || (a - b));
  for (const n of order) {
    if (left <= 0) break;
    if (weights[n] <= 0) continue;
    shares[n].whole += 1;
    left -= 1;
  }
  return shares.map((share) => share.whole);
}

/**
 * ONE exact split of a work date's paid minutes, in whole hundredths, across the holidays its shifts overlap and the rest of
 * the shifts (the last part, holiday null). Pure. Every figure is an integer and the parts add up exactly.
 *   shifts    the date's completed shifts { clock_in, clock_out, duration_minutes }
 *   breaks    the date's own breaks (completed; recorded meals are the ones of 30 minutes or more)
 *   held      the technician's holiday dates, sorted
 *   meal      the unpaid meal the day summary deducted (hundredths)
 * 1. Each shift's STORED paid hundredths (duration_minutes, what the pay pays) are shared across its parts by allocate(),
 *    weighted by the clock milliseconds in each: the parts of a shift add up to its stored duration, never a rounded side each.
 * 2. The recorded meal, clipped to the shifts, is placed in the parts by clock time (each piece shared across the parts by
 *    allocate() the same way); a part's placed meal is capped at its own paid hundredths, and the placed total at the deduction.
 * 3. What is left of the deduction is shared by allocate(), weighted by each part's hundredths left after step 2 (never more).
 * 4. A part's premium minutes = paid - placed - shared (never below 0).
 * The deduction is capped at the date's paid total (the pay never deducts more than the shift), so the parts
 * add up to the stored total less the deduction exactly.
 * Returns { parts: [{ holiday, paid, placed, shared, premium }], deduction, meals } (parts with nothing paid are left out;
 * `meals` are the recorded meals read, clipped to the shifts: { id, from, to, minutes }).
 */
function splitWorkDate({ shifts, breaks = [], held, meal = 0 }) {
  const keys = [...held.filter((day) => {
    const bounds = dayBounds(day);
    return shifts.some((s) => overlapMs(msOf(s.clock_in), msOf(s.clock_out), bounds) > 0);
  }), null];
  const bounds = keys.map((key) => (key ? dayBounds(key) : null));
  // The clock milliseconds of [from, to) in each part: each holiday, then the rest of it.
  const weightsOf = (from, to) => {
    const inside = bounds.map((b) => (b ? overlapMs(from, to, b) : 0));
    const rest = Math.max(0, (to - from) - inside.reduce((sum, w) => sum + w, 0));
    return inside.map((w, n) => (n === inside.length - 1 ? rest : w));
  };
  const paid = keys.map(() => 0);
  for (const s of shifts) {
    const weights = weightsOf(msOf(s.clock_in), msOf(s.clock_out));
    // a shift with no clock span at all is all "rest"
    const shares = allocate(fullHundredths(s), weights.some((w) => w > 0) ? weights : weights.map((_, n) => (n === weights.length - 1 ? 1 : 0)));
    shares.forEach((share, n) => { paid[n] += share; });
  }
  const paidTotal = paid.reduce((sum, v) => sum + v, 0);
  const deduction = Math.min(Math.max(0, meal), paidTotal);
  const floor = hundredths(UNPAID_MEAL_MIN_BREAK_MINUTES);
  const placedRaw = keys.map(() => 0);
  const meals = deduction > 0 ? recordedMealPieces(breaks, shifts, floor) : [];
  if (deduction > 0) {
    for (const piece of meals) {
      const weights = weightsOf(piece.from, piece.to);
      allocate(piece.hundredths, weights.some((w) => w > 0) ? weights : weights.map((_, n) => (n === weights.length - 1 ? 1 : 0)))
        .forEach((share, n) => { placedRaw[n] += share; });
    }
  }
  let placed = placedRaw.map((v, n) => Math.min(v, paid[n]));
  if (placed.reduce((sum, v) => sum + v, 0) > deduction) placed = allocate(deduction, placed);
  const left = paid.map((v, n) => v - placed[n]);
  const shared = allocate(deduction - placed.reduce((sum, v) => sum + v, 0), left);
  return {
    deduction,
    // the recorded meals the split read (clipped to the shifts), so a frozen check can show what it used
    meals: meals.map((piece) => ({ id: piece.id, from: new Date(piece.from).toISOString(), to: new Date(piece.to).toISOString(), minutes: piece.hundredths / 100 })),
    parts: keys.map((holiday, n) => ({ holiday, paid: paid[n], placed: placed[n], shared: shared[n], premium: Math.max(0, paid[n] - placed[n] - shared[n]) }))
      .filter((part) => part.paid > 0),
  };
}

/**
 * The paid minutes one technician earns on holidays from the shifts of ONE pay week, pure.
 *   dates      the work dates ('YYYY-MM-DD') of the week, Monday to Sunday
 *   shifts     shift entries { clock_in, clock_out, duration_minutes, work_date } whose work date is in the week, not voided
 *   breaks     break entries of the same shape, with their own work_date (only completed ones with a clock-out count)
 *   daily      Map of work date -> { total_shift_minutes, unpaid_meal_minutes } (the day's summary row)
 *   holidays   the holiday dates of the technician ('YYYY-MM-DD'), from the week's start to a week after its end
 * Returns { days: [{ workDate, minutes }] in holiday date order (minutes > 0), the date being the holiday's, meals: the recorded
 * meals read (splitWorkDate) }; holidayWorkForWeek returns the days alone.
 */
function holidayWorkDetailForWeek({ dates, shifts, breaks = [], daily, holidays }) {
  const meals = [];
  const held = [...new Set(holidays)].sort();
  const totals = new Map();
  const add = (day, units) => { if (units > 0) totals.set(day, (totals.get(day) || 0) + units); };
  for (const date of dates) {
    const group = shifts.filter((s) => s.work_date === date);
    const row = daily.get(date) || null;
    const summaryPaid = () => (row ? Math.max(0, hundredths(row.total_shift_minutes) - hundredths(row.unpaid_meal_minutes)) : 0);
    // No clock times to read for this date: a shift not closed, or no shift entries while its summary holds shift minutes.
    if (group.some((s) => !s.clock_out) || (!group.length && row && hundredths(row.total_shift_minutes) > 0)) {
      if (held.includes(date)) add(date, summaryPaid());
      continue;
    }
    if (!group.length) continue;
    const meal = row ? hundredths(row.unpaid_meal_minutes) : 0;
    // The recorded meals that count for this date's shifts: every break that OVERLAPS a shift (clipped to it, recordedMealPieces),
    // whatever pay week its own date is in. The placement is capped at this date's own deduction (the day summary's
    // unpaid_meal_minutes), which is what the pay took. NO LOCK on break edits, by design: the finalized check freezes its
    // premium and its holiday days in calc_snapshot (holidayWorkDays), and the meals this read used in calc_snapshot.holidayWorkMeals,
    // so a break edited AFTER the check is final changes nothing already paid and is not reconciled into it. Monday's meal
    // stays editable and Monday's week stays approvable (an earlier lock on break edits blocked both).
    const split = splitWorkDate({ shifts: group, breaks, held, meal });
    if (split.parts.some((part) => part.holiday)) for (const m of split.meals) meals.push({ workDate: date, ...m });
    for (const part of split.parts) if (part.holiday) add(part.holiday, part.premium);
  }
  const days = [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([workDate, units]) => ({ workDate, minutes: units / 100 }));
  // the meals read are kept as evidence whether or not they leave a premium (a meal can take all the holiday minutes of a shift)
  return { days, meals };
}

// The holiday minutes alone: [{ workDate, minutes }] (holidayWorkDetailForWeek).
const holidayWorkForWeek = (input) => holidayWorkDetailForWeek(input).days;

/**
 * The paid minutes worked on holidays by each technician from the shifts of the pay week [start, end] (Monday to Sunday):
 * Map of technician id -> { days: [{ workDate, minutes }] in holiday date order, meals: [the recorded meals read] }, only for a
 * technician with a date with minutes. W-2 technicians only.
 */
async function holidayWorkByDay(conn, start, end) {
  const out = new Map();
  // The week's shifts first: the holidays read run to the day the last of them ends (their clock-outs), never a fixed look-ahead.
  const shifts = await conn('time_entries as e')
    .join('technicians as t', 't.id', 'e.technician_id')
    .where('t.employment_type', 'w2')
    .where('e.entry_type', 'shift')
    .whereNot('e.status', 'voided')
    .where('e.clock_in', '>=', new Date(dayBounds(start).start))
    .where('e.clock_in', '<', new Date(dayBounds(end).end))
    .select('e.technician_id', 'e.clock_in', 'e.clock_out', 'e.duration_minutes',
      conn.raw(`to_char(${staffWorkDateSql('e.clock_in')}, 'YYYY-MM-DD') AS work_date`));
  const lastEnd = shifts.reduce((latest, row) => (row.clock_out && new Date(row.clock_out) > latest ? new Date(row.clock_out) : latest), new Date(0));
  // A shift that ends at midnight sharp ends the day before: its last minute is in the day of (clock-out - 1 ms).
  const reach = lastEnd.getTime() > 0 && etDateString(new Date(lastEnd.getTime() - 1)) > end ? etDateString(new Date(lastEnd.getTime() - 1)) : end;
  const holidays = await conn('payroll_time_off as o')
    .join('technicians as t', 't.id', 'o.technician_id')
    .where('o.kind', 'holiday')
    .where('o.work_date', '>=', start)
    .where('o.work_date', '<=', reach)
    .where('t.employment_type', 'w2')
    .select('o.technician_id', conn.raw("to_char(o.work_date, 'YYYY-MM-DD') AS work_date"));
  if (!holidays.length) return out;
  const ids = [...new Set(holidays.map((row) => row.technician_id))];
  // A break still running is not a meal (a completed break only).
  const breaks = await conn('time_entries')
    .whereIn('technician_id', ids)
    .where('entry_type', 'break')
    .whereNot({ status: 'voided' })
    .whereNot({ status: 'active' })
    .whereNotNull('clock_out')
    // By interval overlap with the range the week's shifts can cover: a meal that starts on the Sunday before the week
    // (11:30 PM) and runs into a Monday midnight shift overlaps it, so it is read too.
    .where('clock_out', '>', new Date(dayBounds(start).start))
    .where('clock_in', '<', new Date(dayBounds(reach).end))
    .select('id', 'technician_id', 'clock_in', 'clock_out', 'duration_minutes',
      conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
  const dailyRows = await conn('time_entry_daily_summary')
    .whereIn('technician_id', ids)
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .select('technician_id', 'total_shift_minutes', 'unpaid_meal_minutes', conn.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"));
  const dates = Array.from({ length: 7 }, (_, n) => addStaffWorkDays(start, n));
  for (const id of ids) {
    const detail = holidayWorkDetailForWeek({
      dates,
      shifts: shifts.filter((e) => e.technician_id === id),
      breaks: breaks.filter((e) => e.technician_id === id),
      daily: new Map(dailyRows.filter((r) => r.technician_id === id).map((r) => [r.work_date, r])),
      holidays: holidays.filter((h) => h.technician_id === id).map((h) => h.work_date),
    });
    if (detail.days.length || detail.meals.length) out.set(id, detail);
  }
  return out;
}

/**
 * Holiday days of a check capped at the minutes the week pays as worked: dates in order, the last ones cut first, so the
 * premium is never paid on hours the check does not pay. Returns { minutes, days } (days with minutes only).
 */
function capHolidayDays(days, paidMinutes) {
  let left = hundredths(paidMinutes);
  const kept = [];
  for (const d of days || []) {
    const take = Math.min(hundredths(d.minutes), left);
    if (take <= 0) continue;
    left -= take;
    kept.push({ workDate: d.workDate, minutes: take / 100 });
  }
  return { minutes: kept.reduce((sum, d) => sum + hundredths(d.minutes), 0) / 100, days: kept };
}

/**
 * The pay weeks (Mondays) of a technician's completed shifts that run INTO any of the Eastern dates `days` from another pay
 * week than the date's own, sorted. Such a shift is paid, with its holiday premium, in its own week's check (the rule at the
 * top), so a holiday added to or taken off that date changes a check of THAT week: the time-off writes refuse it once that
 * check is final (payroll-time-off.js), and a bonus that counts the holiday waits for it (tech-rewards-pay-lines.js).
 */
async function otherWeeksOfShiftsInto(conn, technicianId, days, { before = null } = {}) {
  if (!days.length) return [];
  const bounds = days.map((day) => ({ day, own: staffWeekStartForWorkDate(day), ...dayBounds(day) }));
  // ONE query for every holiday: the technician's completed shifts that overlap any of the dates (and, with `before`, that
  // started before that Eastern date: the shifts of the weeks a caller already asks about are left to it).
  const rows = await conn('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift' })
    .whereNot({ status: 'voided' })
    .whereNotNull('clock_out')
    .where(function overlapping() {
      for (const b of bounds) {
        this.orWhere(function one() { this.where('clock_in', '<', new Date(b.end)).andWhere('clock_out', '>', new Date(b.start)); });
      }
    })
    .modify((query) => { if (before) query.where('clock_in', '<', new Date(dayBounds(before).start)); })
    .select('clock_in', 'clock_out', conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
  const weeks = new Set();
  for (const row of rows) {
    const week = staffWeekStartForWorkDate(row.work_date);
    const from = msOf(row.clock_in);
    const to = msOf(row.clock_out);
    if (bounds.some((b) => from < b.end && to > b.start && b.own !== week)) weeks.add(week);
  }
  return [...weeks].sort();
}

module.exports = { allocate, splitWorkDate, holidayWorkDetailForWeek, holidayWorkForWeek, holidayWorkByDay, capHolidayDays, dayBounds, otherWeeksOfShiftsInto };
