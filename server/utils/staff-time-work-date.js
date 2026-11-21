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
// 2026-11-21, 2 s of CPU per pay run recompute for 10 technicians). So the last answers are kept. The date is validated on
// every call, before anything is read or kept, and the oldest answer is dropped at the cap.
const KEPT_ANSWERS_MAX = 5000;
const ADDED_DAYS = new Map();
const WEEK_STARTS = new Map();

function kept(answers, key, compute) {
  const answer = answers.get(key);
  if (answer !== undefined) return answer;
  const fresh = compute();
  if (answers.size >= KEPT_ANSWERS_MAX) answers.delete(answers.keys().next().value);
  answers.set(key, fresh);
  return fresh;
}

function addStaffWorkDays(workDate, days) {
  const validDate = validateWorkDate(workDate);
  const compute = () => etDateString(addETDays(parseETDateTime(`${validDate}T12:00`), days));
  // only a whole number of days has one answer worth keeping; anything else is worked out as before
  return Number.isInteger(days) ? kept(ADDED_DAYS, `${validDate}|${days}`, compute) : compute();
}

function staffWeekRange(weekStart) {
  const start = validateWorkDate(weekStart);
  return { start, end: addStaffWorkDays(start, 6) };
}

function staffWeekStartForWorkDate(workDate) {
  const validDate = validateWorkDate(workDate);
  return kept(WEEK_STARTS, validDate, () => etWeekStart(parseETDateTime(`${validDate}T12:00`)));
}

module.exports = {
  STAFF_TIME_ZONE,
  STAFF_WORK_DATE_SQL,
  staffWorkDateSql,
  staffWorkDate,
  addStaffWorkDays,
  staffWeekRange,
  staffWeekStartForWorkDate,
  validateWorkDate,
};
