const {
  TZ,
  addETDays,
  etDateString,
  etWeekStart,
  parseETDateTime,
} = require('./datetime-et');

const STAFF_TIME_ZONE = TZ;
const SQL_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * PostgreSQL expression that assigns a time entry to its Staff payroll date.
 * Keep this byte-for-byte equivalent to the rollout audit's work-date logic.
 */
function staffWorkDateSql(column = 'clock_in') {
  if (!SQL_COLUMN.test(column)) throw new Error(`Invalid Staff time column: ${column}`);
  return `(${column}::timestamptz AT TIME ZONE '${STAFF_TIME_ZONE}')::date`;
}

const STAFF_WORK_DATE_SQL = staffWorkDateSql();

function staffWorkDate(clockIn) {
  const instant = clockIn instanceof Date ? clockIn : new Date(clockIn);
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid Staff clock-in timestamp');
  return etDateString(instant);
}

function validateWorkDate(workDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate || '')) {
    throw new Error('Staff work date must be YYYY-MM-DD');
  }
  const [year, month, day] = workDate.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) {
    throw new Error('Staff work date must be a valid calendar date');
  }
  return workDate;
}

// addStaffWorkDays and staffWeekStartForWorkDate are pure functions of a calendar date (and a whole number of days), and
// each call costs several time zone conversions: about 1 ms. Payroll asks for the same few dates again and again while it
// holds the payroll lock (a pay line that covers a year asks for every week of it, for every technician: measured
// 2026-11-21, 2 s of CPU per pay run recompute for 10 technicians). So the answers are kept. The date is validated on
// every call, before anything is read or kept. At the cap the answers start again from none: they cost little to rebuild.
// Plain Maps in this module, read and filled in place: no callback and no row of any table is involved.
const KEPT_ANSWERS_MAX = 5000;
let addedDays = new Map();
let weekStarts = new Map();

function addStaffWorkDays(workDate, days) {
  const validDate = validateWorkDate(workDate);
  // only a whole number of days has one answer worth keeping; anything else is worked out as before
  if (!Number.isInteger(days)) return etDateString(addETDays(parseETDateTime(`${validDate}T12:00`), days));
  const key = `${validDate}|${days}`;
  let answer = addedDays.get(key);
  if (answer === undefined) {
    answer = etDateString(addETDays(parseETDateTime(`${validDate}T12:00`), days));
    if (addedDays.size >= KEPT_ANSWERS_MAX) addedDays = new Map();
    addedDays.set(key, answer);
  }
  return answer;
}

function staffWeekRange(weekStart) {
  const start = validateWorkDate(weekStart);
  return { start, end: addStaffWorkDays(start, 6) };
}

function staffWeekStartForWorkDate(workDate) {
  const validDate = validateWorkDate(workDate);
  let answer = weekStarts.get(validDate);
  if (answer === undefined) {
    answer = etWeekStart(parseETDateTime(`${validDate}T12:00`));
    if (weekStarts.size >= KEPT_ANSWERS_MAX) weekStarts = new Map();
    weekStarts.set(validDate, answer);
  }
  return answer;
}

// A time_entry_daily_summary row that holds worked time (payroll: a day with recorded work).
const STAFF_DAILY_WORK_SQL = `(
      COALESCE(total_shift_minutes, 0) <> 0
      OR COALESCE(total_job_minutes, 0) <> 0
      OR COALESCE(total_drive_minutes, 0) <> 0
      OR COALESCE(total_break_minutes, 0) <> 0
      OR COALESCE(total_admin_minutes, 0) <> 0
      OR COALESCE(job_count, 0) <> 0
    )`;

module.exports = {
  STAFF_TIME_ZONE,
  STAFF_WORK_DATE_SQL,
  STAFF_DAILY_WORK_SQL,
  staffWorkDateSql,
  staffWorkDate,
  addStaffWorkDays,
  staffWeekRange,
  staffWeekStartForWorkDate,
  validateWorkDate,
};
