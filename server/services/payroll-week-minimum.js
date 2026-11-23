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
 * days on and after the hire date. The last week (the week whose pay run pays out the bank) counts the scheduled
 * days up to the last day with recorded work or time off: there is no leaving date on file.
 *
 * Not here: a week with no recorded work and no time off gets none from the minimum (also a check for a pay line
 * alone).
 */
const { STAFF_WORK_DATE_SQL, addStaffWorkDays } = require('../utils/staff-time-work-date');

const SCHEDULED_DAYS = 4;

// Minutes as whole hundredths, so the sums never meet a float.
const hundredths = (minutes) => Math.round(Number(minutes || 0) * 100);

/**
 * The minutes the minimum adds to one technician's week, pure. All inputs are minutes (numbers or decimal strings).
 *   minimumHours   the weekly minimum (the setting)
 *   weekStart      the Monday of the pay week ('YYYY-MM-DD')
 *   hireDate       day 1 of the job, or null (every scheduled day counts)
 *   lastDay        in the week the bank is paid out: the last day with recorded work or time off ('YYYY-MM-DD'),
 *                  or null when there is none (no day counts). Undefined in any other week.
 *   paidMinutes    worked (regular + overtime), paid time off (not a payout) and paid holiday minutes of the week
 *   unpaidMinutes  time-off minutes of the week that were not paid (not those before the hire date)
 */
function minimumTopUpMinutes({ minimumHours, weekStart, hireDate = null, lastDay, paidMinutes, unpaidMinutes = 0 }) {
  let days = 0;
  for (let n = 0; n < SCHEDULED_DAYS; n += 1) {
    const day = addStaffWorkDays(weekStart, n);
    if (hireDate && day < hireDate) continue;
    if (lastDay !== undefined && (lastDay === null || day > lastDay)) continue;
    days += 1;
  }
  const target = Math.round((hundredths(Number(minimumHours) * 60) * days) / SCHEDULED_DAYS);
  return Math.max(0, target - hundredths(unpaidMinutes) - hundredths(paidMinutes)) / 100;
}

// The last day of the week [start, end] with recorded work or time off, per technician among `ids`: Map of id ->
// 'YYYY-MM-DD' (absent = none).
async function lastActiveDays(conn, ids, start, end) {
  const byTech = new Map();
  if (!ids.length) return byTech;
  const keep = (rows) => {
    for (const row of rows) if (row.day && (!byTech.has(row.technician_id) || row.day > byTech.get(row.technician_id))) byTech.set(row.technician_id, row.day);
  };
  keep(await conn('time_entries')
    .whereIn('technician_id', ids)
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .where('status', '!=', 'voided')
    .groupBy('technician_id')
    .select('technician_id', conn.raw(`to_char(MAX(${STAFF_WORK_DATE_SQL}), 'YYYY-MM-DD') AS day`)));
  keep(await conn('payroll_time_off')
    .whereIn('technician_id', ids)
    .whereBetween('work_date', [start, end])
    .groupBy('technician_id')
    .select('technician_id', conn.raw("to_char(MAX(work_date), 'YYYY-MM-DD') AS day")));
  return byTech;
}

/**
 * Sets `minimum_week_minutes` on each row (a pay run row: regular_minutes, overtime_minutes, pto_minutes,
 * holiday_minutes and, for a technician with a bank, pto_bank) of a technician whose minimum is set, 0 when the week
 * already reaches it, when the week has recorded work or time off. Rows of every other technician come back unchanged.
 */
async function applyMinimum(conn, rows, { start, end }) {
  const ids = [...new Set(rows.map((row) => row.technician_id))];
  if (!ids.length) return rows;
  const techs = new Map((await conn('technicians')
    .whereIn('id', ids)
    .where({ employment_type: 'w2' })
    .whereNotNull('paid_week_minimum_hours')
    .select('id', 'paid_week_minimum_hours',
      conn.raw("to_char(hire_date, 'YYYY-MM-DD') AS hire_date"),
      conn.raw("to_char(pto_payout_week_start, 'YYYY-MM-DD') AS payout_week")))
    .map((row) => [row.id, row]));
  if (!techs.size) return rows;
  const leaving = [...techs.values()].filter((tech) => tech.payout_week === start).map((tech) => tech.id);
  const lastDays = await lastActiveDays(conn, leaving, start, end);
  return rows.map((row) => {
    const tech = techs.get(row.technician_id);
    if (!tech) return row;
    const bank = row.pto_bank || {};
    const paidOff = Number(row.pto_minutes || 0) - Number(bank.payoutMinutes || 0);
    const paidMinutes = Number(row.regular_minutes || 0) + Number(row.overtime_minutes || 0) + paidOff + Number(row.holiday_minutes || 0);
    const unpaidMinutes = Math.max(0, Number(bank.unpaidMinutes || 0) - Number(bank.unpaidBeforeHireMinutes || 0));
    // A check with no work and no time off in the week (a pay line alone, such as a bonus after leaving) is not a
    // week on the job: no minimum.
    if (paidMinutes + unpaidMinutes <= 0) return row;
    const minimum = minimumTopUpMinutes({
      minimumHours: tech.paid_week_minimum_hours,
      weekStart: start,
      hireDate: tech.hire_date,
      ...(tech.payout_week === start ? { lastDay: lastDays.get(row.technician_id) || null } : {}),
      paidMinutes,
      unpaidMinutes,
    });
    return { ...row, minimum_week_minutes: minimum };
  });
}

module.exports = { SCHEDULED_DAYS, minimumTopUpMinutes, lastActiveDays, applyMinimum };
