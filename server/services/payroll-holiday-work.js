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
 * - An entry wholly inside a holiday counts its stored duration_minutes (what the pay run pays); an entry that crosses a
 *   midnight counts the clipped clock span.
 * - The unpaid meal is the shift's work date's unpaid_meal_minutes (what the pay deducts; 0 with GATE_AUTO_LUNCH off).
 *   Recorded meal breaks (completed, 30 minutes or more) count only in the deduction of THEIR OWN work date (the date of their
 *   clock-in, as the daily summary groups them), clipped to that date's shifts: that part of the deduction is placed by clock
 *   time, and only the rest of it (an automatic one, which has no clock time, or the part of a break outside the shift) is shared by the share of the shift inside the
 *   holiday.
 * - Fallback, per work date: when the time entries cannot give clock times for that date (a shift with no clock-out, or no
 *   shift entries while the day's summary holds shift minutes), the date's summary row is read as a whole (shift minutes
 *   less unpaid meal, as the weekly pay sums them) and counts for that date only, when that date is itself a holiday. The
 *   other dates of the week keep their measured overlap.
 * All figures are whole hundredths of a minute inside; minutes out are numbers with two decimals.
 */
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate, staffWorkDateSql, STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');
const { UNPAID_MEAL_MIN_BREAK_MINUTES } = require('../constants/staff-time');

const HUNDREDTHS_PER_MS = 1 / 600; // 1 ms = 1/60000 minute = 1/600 hundredth

const hundredths = (minutes) => Math.round(Number(minutes || 0) * 100);

// The instants of ET midnight at the start of `day` and of the next day.
function dayBounds(day) {
  return {
    start: parseETDateTime(`${day}T00:00`).getTime(),
    end: parseETDateTime(`${addStaffWorkDays(day, 1)}T00:00`).getTime(),
  };
}

const fullHundredths = (entry) => (entry.duration_minutes == null
  ? Math.round((new Date(entry.clock_out).getTime() - new Date(entry.clock_in).getTime()) * HUNDREDTHS_PER_MS)
  : hundredths(entry.duration_minutes));

// Minutes (hundredths) of one entry inside [start, end): its stored duration when it lies wholly inside.
function insideHundredths(entry, bounds) {
  const from = new Date(entry.clock_in).getTime();
  const to = new Date(entry.clock_out).getTime();
  if (from >= bounds.start && to <= bounds.end) return fullHundredths(entry);
  const clipped = Math.min(to, bounds.end) - Math.max(from, bounds.start);
  return clipped > 0 ? Math.round(clipped * HUNDREDTHS_PER_MS) : 0;
}

// The parts of a work date's recorded meals that lie inside its shifts: the completed breaks of 30 minutes or more
// (the pay's own test, on the whole break), each clipped to every shift it overlaps. [{ length, insideHolidays(bounds) }].
function recordedMealPieces(breaks, shifts, floor) {
  const pieces = [];
  for (const b of breaks) {
    if (!b.clock_out || fullHundredths(b) < floor) continue;
    for (const s of shifts) {
      const from = Math.max(new Date(b.clock_in).getTime(), new Date(s.clock_in).getTime());
      const to = Math.min(new Date(b.clock_out).getTime(), new Date(s.clock_out).getTime());
      if (to <= from) continue;
      // a break wholly inside the shift keeps its stored duration, as the pay counts it
      const whole = from === new Date(b.clock_in).getTime() && to === new Date(b.clock_out).getTime();
      const piece = { clock_in: new Date(from), clock_out: new Date(to), duration_minutes: whole ? b.duration_minutes : null };
      pieces.push({ length: fullHundredths(piece), insideHolidays: (bounds) => insideHundredths(piece, bounds) });
    }
  }
  return pieces;
}

/**
 * The paid minutes one technician earns on holidays from the shifts of ONE pay week, pure.
 *   dates      the work dates ('YYYY-MM-DD') of the week, Monday to Sunday
 *   shifts     shift entries { clock_in, clock_out, duration_minutes, work_date } whose work date is in the week, not voided
 *   breaks     break entries of the same shape, with their own work_date (only completed ones with a clock-out count)
 *   daily      Map of work date -> { total_shift_minutes, unpaid_meal_minutes } (the day's summary row)
 *   holidays   the holiday dates of the technician ('YYYY-MM-DD'), from the week's start to a week after its end
 * Returns [{ workDate, minutes }] in holiday date order (minutes > 0), the date being the holiday's.
 */
function holidayWorkForWeek({ dates, shifts, breaks = [], daily, holidays }) {
  const held = [...new Set(holidays)].sort();
  const totals = new Map();
  const add = (day, units) => { if (units > 0) totals.set(day, (totals.get(day) || 0) + units); };
  const floor = hundredths(UNPAID_MEAL_MIN_BREAK_MINUTES);
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
    const total = group.reduce((sum, s) => sum + fullHundredths(s), 0);
    const meal = row ? hundredths(row.unpaid_meal_minutes) : 0;
    // The recorded meals of THIS work date's deduction, clipped to its shifts. A break counts in the deduction of the work date
    // of its own clock-in (time-tracking.js computeDailySummaryInTransaction groups breaks by that date, and
    // dayUnpaidMealUnits reads only that group), so only breaks of this date are read here, and only the part inside this
    // date's shifts. A break of ANOTHER work date (a 1 AM meal in a shift that started the evening before) is in that other
    // date's deduction, never in this one: so a break edited in another pay week can never change this shift's premium or a
    // check that is already final, and no lock on break edits is needed. The deduction left without a recorded part inside the
    // shifts is shared by the share of the shift inside the holiday.
    const pieces = meal > 0 ? recordedMealPieces(breaks.filter((b) => b.work_date === date), group, floor) : [];
    const recordedTotal = pieces.reduce((sum, p) => sum + p.length, 0);
    const placed = Math.min(meal, recordedTotal);
    for (const holiday of held) {
      const bounds = dayBounds(holiday);
      const inside = group.reduce((sum, s) => sum + insideHundredths(s, bounds), 0);
      if (inside <= 0) continue;
      let mealInside = 0;
      if (meal > 0) {
        const recordedInside = pieces.reduce((sum, p) => sum + p.insideHolidays(bounds), 0);
        mealInside = (recordedTotal > 0 ? Math.round((recordedInside * placed) / recordedTotal) : 0)
          + Math.round(((meal - placed) * inside) / (total || inside));
      }
      add(holiday, Math.max(0, inside - mealInside));
    }
  }
  return [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([workDate, units]) => ({ workDate, minutes: units / 100 }));
}

/**
 * The paid minutes worked on holidays by each technician from the shifts of the pay week [start, end] (Monday to Sunday):
 * Map of technician id -> [{ workDate, minutes }] in holiday date order, only for a date with minutes. W-2 technicians only.
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
  // A break still running is not a meal (time-tracking.js dayUnpaidMealUnits).
  const breaks = await conn('time_entries')
    .whereIn('technician_id', ids)
    .where('entry_type', 'break')
    .whereNot({ status: 'voided' })
    .whereNot({ status: 'active' })
    .whereNotNull('clock_out')
    .where('clock_in', '>=', new Date(dayBounds(start).start))
    .where('clock_in', '<', new Date(dayBounds(end).end))
    .select('technician_id', 'clock_in', 'clock_out', 'duration_minutes',
      conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
  const dailyRows = await conn('time_entry_daily_summary')
    .whereIn('technician_id', ids)
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .select('technician_id', 'total_shift_minutes', 'unpaid_meal_minutes', conn.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"));
  const dates = Array.from({ length: 7 }, (_, n) => addStaffWorkDays(start, n));
  for (const id of ids) {
    const days = holidayWorkForWeek({
      dates,
      shifts: shifts.filter((e) => e.technician_id === id),
      breaks: breaks.filter((e) => e.technician_id === id),
      daily: new Map(dailyRows.filter((r) => r.technician_id === id).map((r) => [r.work_date, r])),
      holidays: holidays.filter((h) => h.technician_id === id).map((h) => h.work_date),
    });
    if (days.length) out.set(id, days);
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
async function otherWeeksOfShiftsInto(conn, technicianId, days) {
  const weeks = new Set();
  for (const day of days) {
    const bounds = dayBounds(day);
    const own = staffWeekStartForWorkDate(day);
    const rows = await conn('time_entries')
      .where({ technician_id: technicianId, entry_type: 'shift' })
      .whereNot({ status: 'voided' })
      .whereNotNull('clock_out')
      .where('clock_in', '<', new Date(bounds.end))
      .where('clock_out', '>', new Date(bounds.start))
      .select(conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
    for (const row of rows) {
      const week = staffWeekStartForWorkDate(row.work_date);
      if (week !== own) weeks.add(week);
    }
  }
  return [...weeks].sort();
}

module.exports = { holidayWorkForWeek, holidayWorkByDay, capHolidayDays, dayBounds, otherWeeksOfShiftsInto };
