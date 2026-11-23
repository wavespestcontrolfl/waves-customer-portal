/**
 * Minimum paid week (offer letter draft, "Hours and schedule": "40 paid hours in each full workweek. Paid time off
 * and paid holidays count toward the 40. This is a minimum: Waves pays every hour you work." and "Your first and
 * last week pay the days you are scheduled."; owner 2026-11-21 "lets do these now").
 *
 * A W-2 technician whose minimum is set (technicians.paid_week_minimum_hours, a setting; NULL = none, today's pay)
 * is paid at least that many hours in a week that has a paycheck. The hours worked, the paid time off (not the
 * hours a payout paid out) and the paid holidays count toward it. Rule owner 2026-11-23 *a*: in a week with unpaid
 * time, the minimum is the weekly minimum less the unpaid hours (time off the bank could not pay). The hours the
 * minimum adds are a line of their own, "Minimum week pay", at the straight rate: they are not hours worked, so
 * they never make overtime, and the bank earns nothing on them.
 *
 * The scheduled days are Monday to Thursday (the letter: four 10-hour days). The first week counts the scheduled
 * days on and after the hire date. The last week counts the scheduled days up to the last day with recorded work
 * (a time entry or a daily summary with worked time) or time off: there is no leaving date on file. A week is the
 * last week when its pay run pays out the bank, or when the employee is no longer active and nothing is recorded
 * after it, with or without a bank. A last week with paid hours and no dated day on file is held with a reason:
 * the days cannot be counted.
 *
 * Not here: a week with no recorded work and no time off gets none from the minimum (also a check for a pay line
 * alone).
 */
const { STAFF_WORK_DATE_SQL, STAFF_DAILY_WORK_SQL, addStaffWorkDays } = require('../utils/staff-time-work-date');

const SCHEDULED_DAYS = 4;

// Minutes as whole hundredths, so the sums never meet a float.
const hundredths = (minutes) => Math.round(Number(minutes || 0) * 100);

/**
 * The minutes the minimum guarantees in one technician's week (`target`, the minimum less unpaid time off) and the
 * minutes it adds to the hours on file (`added`), pure. All inputs are minutes (numbers or decimal strings).
 *   minimumHours   the weekly minimum (the setting)
 *   weekStart      the Monday of the pay week ('YYYY-MM-DD')
 *   hireDate       day 1 of the job, or null (every scheduled day counts)
 *   lastDay        in the week the bank is paid out: the last day with recorded work or time off ('YYYY-MM-DD'),
 *                  or null when there is none (no day counts). Undefined in any other week.
 *   paidMinutes    worked (regular + overtime), paid time off (not a payout) and paid holiday minutes of the week
 *   unpaidMinutes  time-off minutes of the week that were not paid (not those before the hire date)
 */
function minimumWeekMinutes({ minimumHours, weekStart, hireDate = null, lastDay, paidMinutes, unpaidMinutes = 0 }) {
  let days = 0;
  for (let n = 0; n < SCHEDULED_DAYS; n += 1) {
    const day = addStaffWorkDays(weekStart, n);
    if (hireDate && day < hireDate) continue;
    if (lastDay !== undefined && (lastDay === null || day > lastDay)) continue;
    days += 1;
  }
  const target = Math.max(0, Math.round((hundredths(Number(minimumHours) * 60) * days) / SCHEDULED_DAYS) - hundredths(unpaidMinutes));
  return { target: target / 100, added: Math.max(0, target - hundredths(paidMinutes)) / 100 };
}

// Per technician among `ids`: the first and the last day of the week [start, end] with recorded work or time off
// ('YYYY-MM-DD' or null), and whether anything is recorded after the week (also a later weekly timesheet with worked minutes, which
// payroll pays without dated days). Map of id -> { firstDay, lastDay, after }.
async function recordedDays(conn, ids, start, end) {
  const byTech = new Map(ids.map((id) => [id, { firstDay: null, lastDay: null, after: false }]));
  if (!ids.length) return byTech;
  const keep = (rows) => {
    for (const row of rows) {
      const seen = byTech.get(row.technician_id);
      if (!seen) continue;
      if (row.in_week && (!seen.lastDay || row.in_week > seen.lastDay)) seen.lastDay = row.in_week;
      if (row.first_in_week && (!seen.firstDay || row.first_in_week < seen.firstDay)) seen.firstDay = row.first_in_week;
      if (row.after) seen.after = true;
    }
  };
  const summarize = (dateSql) => [
    conn.raw(`to_char(MAX(${dateSql}) FILTER (WHERE ${dateSql} <= ?::date), 'YYYY-MM-DD') AS in_week`, [end]),
    conn.raw(`to_char(MIN(${dateSql}) FILTER (WHERE ${dateSql} <= ?::date), 'YYYY-MM-DD') AS first_in_week`, [end]),
    conn.raw(`BOOL_OR(${dateSql} > ?::date) AS after`, [end]),
  ];
  keep(await conn('time_entries')
    .whereIn('technician_id', ids)
    .whereRaw(`${STAFF_WORK_DATE_SQL} >= ?::date`, [start])
    .where('status', '!=', 'voided')
    .groupBy('technician_id')
    .select('technician_id', ...summarize(STAFF_WORK_DATE_SQL)));
  keep(await conn('time_entry_daily_summary')
    .whereIn('technician_id', ids)
    .where('work_date', '>=', start)
    .whereRaw(STAFF_DAILY_WORK_SQL)
    .groupBy('technician_id')
    .select('technician_id', ...summarize('work_date')));
  keep(await conn('time_weekly_summary')
    .whereIn('technician_id', ids)
    .where('week_start', '>', end)
    .whereRaw('COALESCE(regular_minutes, 0) + COALESCE(overtime_minutes, 0) > 0')
    .groupBy('technician_id')
    .select('technician_id', conn.raw('NULL AS in_week'), conn.raw('NULL AS first_in_week'), conn.raw('true AS after')));
  keep(await conn('payroll_time_off')
    .whereIn('technician_id', ids)
    .where('work_date', '>=', start)
    .groupBy('technician_id')
    .select('technician_id', ...summarize('work_date')));
  return byTech;
}

const NO_LAST_DAY = 'This is the last week of an employee with a minimum paid week, and no day of it has a time entry, a '
  + 'daily summary or time off on file, so the days the minimum covers cannot be counted. Add the shifts, or clear '
  + 'the minimum for this employee (Payroll settings lists an employee who has left while a minimum is set).';

const EARLIER_STAY = 'This week holds work before the hire date on file (an earlier stay, before a rehire moved the '
  + 'hire date), so the days the minimum paid week covers cannot be counted. Pay the week by hand, or clear the '
  + 'minimum for this employee while this pay run is made (Payroll settings).';

/**
 * Sets `minimum_week_minutes` on each row (a pay run row: regular_minutes, overtime_minutes, pto_minutes,
 * holiday_minutes and, for a technician with a bank, pto_bank) of a technician whose minimum is set, 0 when the week
 * already reaches it, when the week has recorded work or time off. Rows of every other technician come back unchanged.
 * Returns { rows, holds }: holds = Map of technician id -> reason (a last week with no dated day, a week of an
 * earlier stay). With `lock` (finalize), the technician rows are read FOR SHARE: a change of the setting, the hire
 * date or the employment status waits for the finalize, or the finalize waits for it and reads the new values.
 */
async function applyMinimum(conn, rows, { start, end, lock = false }) {
  const holds = new Map();
  const ids = [...new Set(rows.map((row) => row.technician_id))];
  if (!ids.length) return { rows, holds };
  const techQuery = conn('technicians')
    .whereIn('id', ids)
    .where({ employment_type: 'w2' })
    .whereNotNull('paid_week_minimum_hours')
    .select('id', 'paid_week_minimum_hours', 'employment_status',
      conn.raw("to_char(hire_date, 'YYYY-MM-DD') AS hire_date"),
      conn.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') AS payout_week"));
  if (lock) techQuery.forShare();
  const techs = new Map((await techQuery).map((row) => [row.id, row]));
  if (!techs.size) return { rows, holds };
  const days = await recordedDays(conn, [...techs.keys()], start, end);
  const out = rows.map((row) => {
    const tech = techs.get(row.technician_id);
    if (!tech) return row;
    const bank = row.pto_bank || {};
    const paidOff = Number(row.pto_minutes || 0) - Number(bank.payoutMinutes || 0);
    const paidMinutes = Number(row.regular_minutes || 0) + Number(row.overtime_minutes || 0) + paidOff + Number(row.holiday_minutes || 0);
    const unpaidMinutes = Math.max(0, Number(bank.unpaidMinutes || 0) - Number(bank.unpaidBeforeHireMinutes || 0));
    // A check with no work and no time off in the week (a pay line alone, such as a bonus after leaving) is not a
    // week on the job: no minimum.
    if (paidMinutes + unpaidMinutes <= 0) return row;
    const recorded = days.get(row.technician_id);
    // Work before the hire date on file is an earlier stay: its schedule is not known here.
    if (tech.hire_date && (recorded.firstDay ? recorded.firstDay < tech.hire_date : end < tech.hire_date)) {
      holds.set(row.technician_id, EARLIER_STAY);
      return row;
    }
    const lastWeek = tech.payout_week === start || (tech.employment_status === 'inactive' && !recorded.after);
    if (lastWeek && !recorded.lastDay) {
      holds.set(row.technician_id, NO_LAST_DAY);
      return row;
    }
    const minimum = minimumWeekMinutes({
      minimumHours: tech.paid_week_minimum_hours,
      weekStart: start,
      hireDate: tech.hire_date,
      ...(lastWeek ? { lastDay: recorded.lastDay } : {}),
      paidMinutes,
      unpaidMinutes,
    });
    return { ...row, minimum_week_minutes: minimum.added, minimum_week_target_minutes: minimum.target };
  });
  return { rows: out, holds };
}

module.exports = { SCHEDULED_DAYS, NO_LAST_DAY, EARLIER_STAY, minimumWeekMinutes, recordedDays, applyMinimum };
