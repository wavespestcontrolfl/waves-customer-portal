/**
 * Minimum paid week (offer letter draft, "Hours and schedule": "40 paid hours in each full workweek. Paid time off
 * and paid holidays count toward the 40. This is a minimum: Waves pays every hour you work." and "Your first and
 * last week pay the days you are scheduled."; owner 2026-11-21 "lets do these now").
 *
 * A W-2 technician whose minimum is set (technicians.paid_week_minimum_hours, a setting; NULL = none, today's pay;
 * each change applies from the pay week it is saved in, payroll_week_minimum_changes) is paid at least that many hours in a week that has a paycheck. The hours worked, the paid time off (not the
 * hours a payout paid out) and the paid holidays count toward it. Rule owner 2026-11-23 *a*: in a week with unpaid
 * time, the minimum is the weekly minimum less the unpaid hours (time off the bank could not pay). The hours the
 * minimum adds are a line of their own, "Minimum week pay", at the straight rate: they are not hours worked, so
 * they never make overtime, and the bank earns nothing on them.
 *
 * The scheduled days are Monday to Thursday (the letter: four 10-hour days). The first week counts the scheduled
 * days on and after the hire date. The last week is the week of the employee's last day, which the owner types when
 * they leave (technicians.paid_week_minimum_last_day; owner 2026-11-23 *a*): it counts the scheduled days up to that
 * day, and a later week pays no minimum; time off the bank did not pay lowers the minimum only up to that day. The
 * setter refuses a change of the last day once a final check covers its week (payroll-time-off.js setWeekMinimum),
 * so nothing is guessed and a paid week never changes. A week before the hire date on file is in an earlier stay (a
 * rehire moved the hire date): a week with work in it is held with a reason (its first day is not on file), and a
 * last day on file before the hire date ends that stay. No readable hire date: the week is held with a reason.
 *
 * Not here: a week with no recorded work and no time off gets none from the minimum (also a check for a pay line
 * alone).
 */
const { STAFF_WORK_DATE_SQL, STAFF_DAILY_WORK_SQL, addStaffWorkDays } = require('../utils/staff-time-work-date');

const SCHEDULED_DAYS = 4;
// Read lazily: tech-rewards-pay-lines.js reads the pay run module at call time too.
const hireDateSql = () => require('./tech-rewards-pay-lines').HIRE_DATE_SQL;

// Minutes as whole hundredths, so the sums never meet a float.
const hundredths = (minutes) => Math.round(Number(minutes || 0) * 100);

/**
 * The minutes the minimum guarantees in one technician's week (`target`, the minimum less unpaid time off) and the
 * minutes it adds to the hours on file (`added`), pure. All inputs are minutes (numbers or decimal strings).
 *   minimumHours   the weekly minimum (the setting)
 *   weekStart      the Monday of the pay week ('YYYY-MM-DD')
 *   hireDate       day 1 of the job, or null (every scheduled day from the start counts)
 *   lastDay        the employee's last day, or null (every scheduled day to the end counts)
 *   paidMinutes    worked (regular + overtime), paid time off (not a payout) and paid holiday minutes of the week
 *   unpaidMinutes  time-off minutes of the week that were not paid (not those before the hire date)
 */
function minimumWeekMinutes({ minimumHours, weekStart, hireDate = null, lastDay = null, paidMinutes, unpaidMinutes = 0 }) {
  let days = 0;
  for (let n = 0; n < SCHEDULED_DAYS; n += 1) {
    const day = addStaffWorkDays(weekStart, n);
    if (hireDate && day < hireDate) continue;
    if (lastDay && day > lastDay) continue;
    days += 1;
  }
  const target = Math.max(0, Math.round((hundredths(Number(minimumHours) * 60) * days) / SCHEDULED_DAYS) - hundredths(unpaidMinutes));
  return { target: target / 100, added: Math.max(0, target - hundredths(paidMinutes)) / 100 };
}

// The first day of the week [start, end] with recorded WORK (a time entry, or a daily summary with worked time), per
// technician among `ids`: Map of id -> 'YYYY-MM-DD' (absent = none). Time off is not work: a day of time off before
// the hire date is the bank's to refuse, not an earlier stay.
async function firstWorkDays(conn, ids, start, end) {
  const byTech = new Map();
  if (!ids.length) return byTech;
  const keep = (rows) => {
    for (const row of rows) if (row.day && (!byTech.has(row.technician_id) || row.day < byTech.get(row.technician_id))) byTech.set(row.technician_id, row.day);
  };
  keep(await conn('time_entries')
    .whereIn('technician_id', ids)
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .where('status', '!=', 'voided')
    .groupBy('technician_id')
    .select('technician_id', conn.raw(`to_char(MIN(${STAFF_WORK_DATE_SQL}), 'YYYY-MM-DD') AS day`)));
  keep(await conn('time_entry_daily_summary')
    .whereIn('technician_id', ids)
    .whereBetween('work_date', [start, end])
    .whereRaw(STAFF_DAILY_WORK_SQL)
    .groupBy('technician_id')
    .select('technician_id', conn.raw("to_char(MIN(work_date), 'YYYY-MM-DD') AS day")));
  return byTech;
}

// The time off of the week the bank did NOT pay on the days [from, to], from the week's own figures: booked minutes
// (payroll_time_off, kind pto) less the minutes the bank paid that day (pto_bank.paidDays). Per technician among
// `rows` (each { technician_id, pto_bank, from, to }): Map of id -> minutes.
async function unpaidOnDays(conn, rows, start, end) {
  const out = new Map();
  if (!rows.length) return out;
  const booked = await conn('payroll_time_off')
    .whereIn('technician_id', rows.map((row) => row.technician_id))
    .whereBetween('work_date', [start, end])
    .where({ kind: 'pto' })
    .select('technician_id', 'minutes', conn.raw("to_char(work_date, 'YYYY-MM-DD') AS day"));
  for (const row of rows) {
    const paid = new Map(((row.pto_bank && row.pto_bank.paidDays) || []).map((d) => [d.workDate, hundredths(d.minutes)]));
    let unpaid = 0;
    for (const day of booked) {
      if (day.technician_id !== row.technician_id || day.day < row.from || day.day > row.to) continue;
      unpaid += Math.max(0, hundredths(day.minutes) - (paid.get(day.day) || 0));
      paid.delete(day.day);
    }
    out.set(row.technician_id, unpaid / 100);
  }
  return out;
}

const NO_HIRE_DATE = 'This employee has a minimum paid week and no readable hire date on file, so the days of the first week '
  + 'cannot be counted. Enter the hire date (Staff).';

const EARLIER_STAY = 'This week holds work before the hire date on file (an earlier stay, before a rehire moved the '
  + 'hire date), so the days the minimum paid week covers cannot be counted. Pay the week by hand.';

// The stay a pay week [start, end] belongs to, as the days the minimum counts: { hireDate, lastDay }. A week that
// reaches the hire date on file is in the current stay: from the hire date, to a last day on or after it. A week
// before it is in an earlier stay (a rehire moved the hire date past it): its first day is not on file, and a last
// day on file before the hire date is that stay's.
function stayOf(tech, end) {
  if (end >= tech.hire_date) {
    return { hireDate: tech.hire_date, lastDay: tech.last_day && tech.last_day >= tech.hire_date ? tech.last_day : null };
  }
  return { hireDate: null, lastDay: tech.last_day && tech.last_day < tech.hire_date ? tech.last_day : null };
}

/**
 * Sets `minimum_week_minutes` and `minimum_week_target_minutes` on each row (a pay run row: regular_minutes,
 * overtime_minutes, pto_minutes, holiday_minutes and, for a technician with a bank, pto_bank) of a technician with a
 * minimum in this pay week, when the week has recorded work or time off and is not after their last day. Rows of
 * every other technician come back unchanged. Returns { rows, holds }: holds = Map of technician id -> reason (no
 * readable hire date, or a week of an earlier stay). With `lock` (finalize), the technician rows are read FOR SHARE: a change of the setting or
 * the hire date waits for the finalize, or the finalize waits for it and reads the new values.
 */
async function applyMinimum(conn, rows, { start, end, lock = false }) {
  const holds = new Map();
  const ids = [...new Set(rows.map((row) => row.technician_id))];
  if (!ids.length) return { rows, holds };
  // The minimum of this pay week: the newest change on or before it (payroll_week_minimum_changes), never the setting
  // as it stands now, so a late, voided or reopened week keeps its own minimum. No change on or before it = none.
  const weekHours = new Map((await conn('payroll_week_minimum_changes')
    .whereIn('technician_id', ids)
    .where('from_week', '<=', start)
    .distinctOn('technician_id')
    .select('technician_id', 'hours')
    .orderBy([{ column: 'technician_id' }, { column: 'from_week', order: 'desc' }]))
    .filter((row) => row.hours != null)
    .map((row) => [row.technician_id, row.hours]));
  if (!weekHours.size) return { rows, holds };
  const techQuery = conn('technicians')
    .whereIn('id', [...weekHours.keys()])
    .where({ employment_type: 'w2' })
    .select('id',
      // A hire date the calendar code cannot read is none (held below), as Tech Rewards reads it.
      conn.raw(`${hireDateSql()} AS hire_date`),
      conn.raw("to_char(paid_week_minimum_last_day, 'YYYY-MM-DD') AS last_day"));
  if (lock) techQuery.forShare();
  const techs = new Map((await techQuery).map((row) => [row.id, { ...row, minimumHours: weekHours.get(row.id) }]));
  if (!techs.size) return { rows, holds };
  for (const tech of techs.values()) tech.stay = tech.hire_date ? stayOf(tech, end) : null;
  // In the week of the last day, only time off up to that day lowers the minimum (time off booked after it is not
  // on a scheduled day of the job). The bank's own per-day figures say which days it did not pay.
  // A technician with no bank was paid every booked hour: nothing is unpaid, so only a bank's rows are read.
  const inLastWeek = (tech) => Boolean(tech && tech.stay && tech.stay.lastDay && tech.stay.lastDay >= start && tech.stay.lastDay <= end);
  const lastWeekRows = rows.filter((row) => row.pto_bank && inLastWeek(techs.get(row.technician_id))).map((row) => {
    const { stay } = techs.get(row.technician_id);
    return { ...row, from: stay.hireDate && stay.hireDate > start ? stay.hireDate : start, to: stay.lastDay };
  });
  const unpaidToLastDay = await unpaidOnDays(conn, lastWeekRows, start, end);
  const firstWork = await firstWorkDays(conn, [...techs.keys()], start, end);
  const out = rows.map((row) => {
    const tech = techs.get(row.technician_id);
    if (!tech) return row;
    const bank = row.pto_bank || {};
    const paidOff = Number(row.pto_minutes || 0) - Number(bank.payoutMinutes || 0);
    const paidMinutes = Number(row.regular_minutes || 0) + Number(row.overtime_minutes || 0) + paidOff + Number(row.holiday_minutes || 0);
    let unpaidMinutes = Math.max(0, Number(bank.unpaidMinutes || 0) - Number(bank.unpaidBeforeHireMinutes || 0));
    if (inLastWeek(tech)) unpaidMinutes = unpaidToLastDay.get(row.technician_id) || 0;
    // A check with no work and no time off in the week (a pay line alone, such as a bonus after leaving) is not a
    // week on the job: no minimum.
    if (paidMinutes + unpaidMinutes <= 0) return row;
    // The hire date first: it says which stay the week and a last day on file belong to.
    if (!tech.stay) {
      holds.set(row.technician_id, NO_HIRE_DATE);
      return row;
    }
    // A week after the last day of its stay: no minimum.
    if (tech.stay.lastDay && start > tech.stay.lastDay) return row;
    // Work before the hire date on file is an earlier stay: its first day is not on file, so its days cannot be counted.
    const first = firstWork.get(row.technician_id);
    const workedMinutes = Number(row.regular_minutes || 0) + Number(row.overtime_minutes || 0);
    if (first ? first < tech.hire_date : workedMinutes > 0 && end < tech.hire_date) {
      holds.set(row.technician_id, EARLIER_STAY);
      return row;
    }
    const minimum = minimumWeekMinutes({
      minimumHours: tech.minimumHours, weekStart: start, ...tech.stay, paidMinutes, unpaidMinutes,
    });
    return { ...row, minimum_week_minutes: minimum.added, minimum_week_target_minutes: minimum.target };
  });
  return { rows: out, holds };
}

module.exports = { SCHEDULED_DAYS, NO_HIRE_DATE, EARLIER_STAY, minimumWeekMinutes, firstWorkDays, stayOf, unpaidOnDays, applyMinimum };
