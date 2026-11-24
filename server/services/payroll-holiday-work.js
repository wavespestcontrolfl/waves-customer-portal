/**
 * Holiday work minutes (the extra half of "hours worked on the day a holiday is taken", payroll-calc.js).
 *
 * A holiday is a payroll_time_off row of kind holiday on an Eastern calendar date D. The paid minutes worked ON it are
 * the minutes of the day's shifts that fall inside D, from the clock times of the time entries, less the unpaid meal
 * that falls inside D. The daily summary cannot say this: it gives a whole shift to the Eastern date of its clock-in,
 * so a 10 PM to 2 AM shift that starts the night before a holiday would earn nothing, and the same shift starting on
 * the holiday would earn four hours of premium. Both earn the two hours that fall on the holiday.
 *
 * - The day is [ET midnight of D, ET midnight of D + 1) as instants (datetime-et.js parseETDateTime: DST-safe, a day
 *   is 23 or 25 hours twice a year). Never a fixed offset.
 * - The shifts read are those whose clock-in is on D - 1 or D (a shift is closed after 14 hours at most).
 * - An entry wholly inside the day counts its stored duration_minutes (what the pay run pays); an entry that crosses a
 *   midnight counts the clipped clock span.
 * - The unpaid meal is the daily summary's unpaid_meal_minutes of the shift's work date (what the pay deducts, 0 with
 *   GATE_AUTO_LUNCH off). With recorded meal breaks (completed, 30 minutes or more) it is the part of those breaks that
 *   falls inside D; an automatic deduction has no clock time, so the share of the shift that falls inside D bears the
 *   same share of it.
 * - Fallback: when the time entries cannot give clock times for the day (a shift with no clock-out, or no shift
 *   entries at all while the daily summary of D holds shift minutes), the day's summary row is read as a whole
 *   (shift minutes less unpaid meal, as the weekly pay sums them).
 * All figures are whole hundredths of a minute inside; minutes out are numbers with two decimals.
 */
const { parseETDateTime } = require('../utils/datetime-et');
const { addStaffWorkDays, STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');
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

// Minutes (hundredths) of one entry inside [start, end): its stored duration when it lies wholly inside.
function insideHundredths(entry, bounds) {
  const from = new Date(entry.clock_in).getTime();
  const to = new Date(entry.clock_out).getTime();
  if (from >= bounds.start && to <= bounds.end) return entry.duration_minutes == null ? Math.round((to - from) * HUNDREDTHS_PER_MS) : hundredths(entry.duration_minutes);
  const clipped = Math.min(to, bounds.end) - Math.max(from, bounds.start);
  return clipped > 0 ? Math.round(clipped * HUNDREDTHS_PER_MS) : 0;
}
const fullHundredths = (entry) => (entry.duration_minutes == null
  ? Math.round((new Date(entry.clock_out).getTime() - new Date(entry.clock_in).getTime()) * HUNDREDTHS_PER_MS)
  : hundredths(entry.duration_minutes));

/**
 * The paid minutes worked on the holiday `day` by one technician, pure.
 *   shifts   shift entries { clock_in, clock_out, duration_minutes, work_date } of the technician, not voided
 *   breaks   break entries of the same shape (only completed ones with a clock-out count)
 *   daily    Map of work date -> { total_shift_minutes, unpaid_meal_minutes } (the day's summary row)
 * Returns minutes as a number (two decimals).
 */
function holidayWorkMinutes({ day, shifts, breaks = [], daily }) {
  const summary = (date) => daily.get(date) || null;
  const workDates = [addStaffWorkDays(day, -1), day];
  const own = shifts.filter((s) => workDates.includes(s.work_date));
  const summaryPaid = () => {
    const row = summary(day);
    return row ? Math.max(0, hundredths(row.total_shift_minutes) - hundredths(row.unpaid_meal_minutes)) / 100 : 0;
  };
  // No clock times to read: a shift not closed, or no shift entries while the day's summary holds shift minutes.
  if (own.some((s) => !s.clock_out)) return summaryPaid();
  if (!own.length) return summary(day) && hundredths(summary(day).total_shift_minutes) > 0 ? summaryPaid() : 0;
  const bounds = dayBounds(day);
  const floor = hundredths(UNPAID_MEAL_MIN_BREAK_MINUTES);
  let paid = 0;
  for (const date of workDates) {
    const group = own.filter((s) => s.work_date === date);
    const inside = group.reduce((sum, s) => sum + insideHundredths(s, bounds), 0);
    if (inside <= 0) continue;
    const total = group.reduce((sum, s) => sum + fullHundredths(s), 0);
    const row = summary(date);
    const meal = row ? hundredths(row.unpaid_meal_minutes) : 0;
    let mealInside = 0;
    if (meal > 0) {
      const recorded = breaks.filter((b) => b.work_date === date && b.clock_out && fullHundredths(b) >= floor);
      mealInside = recorded.length
        ? Math.min(meal, recorded.reduce((sum, b) => sum + insideHundredths(b, bounds), 0))
        : Math.round((meal * inside) / (total || inside));
    }
    paid += Math.max(0, inside - mealInside);
  }
  return paid / 100;
}

/**
 * The paid minutes worked on each holiday of a pay week [start, end] (Monday to Sunday): Map of technician id ->
 * [{ workDate, minutes }] in date order, only for a date with minutes. W-2 technicians only.
 */
async function holidayWorkByDay(conn, start, end) {
  const holidays = await conn('payroll_time_off as o')
    .join('technicians as t', 't.id', 'o.technician_id')
    .where('o.kind', 'holiday')
    .where('o.work_date', '>=', start)
    .where('o.work_date', '<=', end)
    .where('t.employment_type', 'w2')
    .orderBy([{ column: 'o.technician_id' }, { column: 'o.work_date' }])
    .select('o.technician_id', conn.raw("to_char(o.work_date, 'YYYY-MM-DD') AS work_date"));
  const out = new Map();
  if (!holidays.length) return out;
  const ids = [...new Set(holidays.map((row) => row.technician_id))];
  const before = addStaffWorkDays(start, -1);
  const entries = await conn('time_entries')
    .whereIn('technician_id', ids)
    .whereIn('entry_type', ['shift', 'break'])
    .whereNot({ status: 'voided' })
    .where('clock_in', '>=', new Date(dayBounds(before).start))
    .where('clock_in', '<', new Date(dayBounds(end).end))
    .select('technician_id', 'entry_type', 'status', 'clock_in', 'clock_out', 'duration_minutes',
      conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') AS work_date`));
  const dailyRows = await conn('time_entry_daily_summary')
    .whereIn('technician_id', ids)
    .where('work_date', '>=', before)
    .where('work_date', '<=', end)
    .select('technician_id', 'total_shift_minutes', 'unpaid_meal_minutes', conn.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"));
  for (const { technician_id: id, work_date: day } of holidays) {
    const mine = entries.filter((e) => e.technician_id === id);
    const minutes = holidayWorkMinutes({
      day,
      shifts: mine.filter((e) => e.entry_type === 'shift'),
      // A break still running is not a meal (time-tracking.js dayUnpaidMealUnits).
      breaks: mine.filter((e) => e.entry_type === 'break' && e.status !== 'active'),
      daily: new Map(dailyRows.filter((r) => r.technician_id === id).map((r) => [r.work_date, r])),
    });
    if (minutes > 0) out.set(id, [...(out.get(id) || []), { workDate: day, minutes }]);
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

module.exports = { holidayWorkMinutes, holidayWorkByDay, capHolidayDays, dayBounds };
