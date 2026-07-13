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

function addStaffWorkDays(workDate, days) {
  const validDate = validateWorkDate(workDate);
  const anchor = parseETDateTime(`${validDate}T12:00`);
  return etDateString(addETDays(anchor, days));
}

function staffWeekRange(weekStart) {
  const start = validateWorkDate(weekStart);
  return { start, end: addStaffWorkDays(start, 6) };
}

function staffWeekStartForWorkDate(workDate) {
  const validDate = validateWorkDate(workDate);
  return etWeekStart(parseETDateTime(`${validDate}T12:00`));
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
