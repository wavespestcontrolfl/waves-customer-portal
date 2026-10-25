/**
 * Technician eligibility — the one place that answers "may this technician
 * take a field assignment?" and the one place that writes employment status.
 *
 * Every visit writer that sets scheduled_services.technician_id calls
 * assertAssignableTechnician at save time (not just when a picker is
 * rendered), and every slot source (find-time) filters through
 * applyAssignable. A prospective placeholder, an inactive account, or an
 * active office employee who is not field-dispatchable can therefore never
 * absorb a real customer visit, whatever path the assignment took.
 *
 * Access (sign-in) is decided separately in middleware/admin-auth.js from
 * employment_status alone; payment is an obligation on the ledger and is
 * never derived from either flag.
 */
const db = require('../models/db');
const { dateOnlyString } = require('../utils/datetime-et');
const featureGates = require('../config/feature-gates');

// Looked up on the module at call time, not destructured at load: this seam is
// loaded under many partial feature-gates mocks, and a missing reader must read
// as "gate off" (today's behavior) rather than throw.
const techWorkDaysLive = () => typeof featureGates.techWorkDaysLive === 'function' && featureGates.techWorkDaysLive();

const EMPLOYMENT_STATUSES = Object.freeze(['prospective', 'active', 'inactive']);
const NOT_ASSIGNABLE = 'TECH_NOT_ASSIGNABLE';

function isEmploymentStatus(value) {
  return EMPLOYMENT_STATUSES.includes(value);
}

/** True when the row may receive a field assignment. Pure. */
function isAssignable(tech) {
  return !!tech && tech.employment_status === 'active' && tech.field_dispatchable === true;
}

/** Narrow a technicians query (optionally aliased) to assignable rows. */
function applyAssignable(query, alias = 'technicians') {
  return query
    .where(`${alias}.employment_status`, 'active')
    .where(`${alias}.field_dispatchable`, true);
}

// ---- Work days (GATE_TECH_WORK_DAYS, owner 2026-10-25) -----------------------
// technicians.work_days is smallint[] of JS day-of-week ints (0 = Sunday ...
// 6 = Saturday), the same encoding as `schedule_weekly_days_off`. NULL (or
// anything unreadable) = works every day. Every reader below returns "not an
// off day" while the gate is off, so a gate-off caller is byte-identical.

const DAY_PLURALS = Object.freeze(['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']);

/**
 * Normalize a stored/submitted work-days value to a sorted, de-duplicated
 * array of ints 0..6, or null for "every day". Accepts an array, or the
 * Postgres text form '{1,2,3}'. Pure. A value with any element outside 0..6
 * is not a work-days value at all: null (fail open to "works every day").
 * An empty array is also null, since the column CHECK refuses it.
 */
function normalizeWorkDays(value) {
  let list = value;
  if (typeof list === 'string') {
    const m = /^\{(.*)\}$/.exec(list.trim());
    if (!m) return null;
    list = m[1] === '' ? [] : m[1].split(',');
  }
  if (!Array.isArray(list) || !list.length) return null;
  const days = new Set();
  for (const raw of list) {
    const n = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    days.add(n);
  }
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.length === 7 ? null : sorted;
}

/**
 * Day of week (0 = Sunday ... 6 = Saturday) of a YYYY-MM-DD calendar date, or
 * null when it is not one. UTC arithmetic on the parsed parts, so the answer
 * is the date's own weekday on any server timezone (never new Date('YYYY-MM-DD')
 * read as local time). Pure.
 */
function dayOfWeekOfDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr == null ? '' : dateOnlyString(dateStr)));
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (dt.getUTCFullYear() !== Number(m[1]) || dt.getUTCMonth() !== Number(m[2]) - 1 || dt.getUTCDate() !== Number(m[3])) return null;
  return dt.getUTCDay();
}

/**
 * True when GATE_TECH_WORK_DAYS is on, the technician has a work-days list,
 * and `dateStr` (a YYYY-MM-DD ET calendar date) falls on a weekday that list
 * does not contain. The ONE predicate every reader below uses. `tech` needs
 * only `work_days`. Pure apart from the gate read.
 */
function isOffDay(tech, dateStr) {
  if (!techWorkDaysLive() || !tech) return false;
  const days = normalizeWorkDays(tech.work_days);
  if (!days) return false;
  const dow = dayOfWeekOfDate(dateStr);
  if (dow === null) return false;
  return !days.includes(dow);
}

/**
 * The plain warning line an office path adds when it puts a technician on a
 * day they do not work ("Tech One does not work on Fridays."), or null when
 * the day is fine or the gate is off. Office paths warn, never block.
 */
function offDayWarning(tech, dateStr) {
  if (!isOffDay(tech, dateStr)) return null;
  const name = (tech && tech.name) || 'This technician';
  return `${name} does not work on ${DAY_PLURALS[dayOfWeekOfDate(dateStr)]}.`;
}

/**
 * Warning lines for one technician id across one or more dates: reads the row
 * once (gate on only) and returns offDayWarning for each distinct weekday that
 * is an off day (de-duplicated, in date order). [] when the gate is off, the
 * technician has no work-days list, or the read fails (an advisory line never
 * blocks a save).
 */
async function offDayWarningsFor(technicianId, dates, { conn = db } = {}) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  if (!techWorkDaysLive() || !technicianId || !list.length) return [];
  try {
    // On a transaction the read rides a savepoint, so a failed read can never
    // abort the caller's transaction.
    const read = (c) => c('technicians').where({ id: technicianId }).first('id', 'name', 'work_days');
    const tech = conn.isTransaction && typeof conn.transaction === 'function'
      ? await conn.transaction((sp) => read(sp))
      : await read(conn);
    const lines = new Set();
    for (const date of [...list].sort()) {
      const line = offDayWarning(tech, date);
      if (line) lines.add(line);
    }
    return [...lines];
  } catch {
    return [];
  }
}

/** offDayWarningsFor for one date: the line, or null. */
async function offDayWarningFor(technicianId, dateStr, { conn = db } = {}) {
  const [line] = await offDayWarningsFor(technicianId, [dateStr], { conn });
  return line || null;
}

function reasonFor(tech) {
  if (!tech) return 'unknown technician';
  if (tech.employment_status === 'prospective') return 'has not started yet (prospective)';
  if (tech.employment_status !== 'active') return 'is no longer active';
  if (!tech.field_dispatchable) return 'is not field-dispatchable';
  return null;
}

/**
 * Throws a 422 (code TECH_NOT_ASSIGNABLE) unless the technician may take a
 * field assignment. null / undefined = unassigned, which is always legal.
 * Returns the technician row so callers can reuse it (name, etc.).
 *
 * Call it on the WRITING transaction. When `conn` is a transaction the row
 * is read FOR SHARE, which conflicts with the FOR UPDATE every Team-tab
 * status writer takes (admin-timetracking.js), so an offboarding or a
 * field-eligibility removal cannot commit between this check and the
 * assignment's commit. On a plain connection it is a point-in-time check.
 *
 * `workDays` (opt-in, with `date`): also refuses a technician on a weekday they
 * do not work (technicians.work_days, GATE_TECH_WORK_DAYS on). Pass it ONLY at
 * AUTOMATIC commit points (self-serve booking, the phone agent, holds, follow-up
 * and auto-move writers). Office paths never pass it: they warn instead
 * (offDayWarning). Omitted, or with the gate off, the check and the extra
 * column read do not happen, so every caller is byte-identical.
 *
 * `date` (YYYY-MM-DD, optional): when given, also rejects a technician
 * marked out for that calendar date (an uncleared technician_absences row —
 * GATE_TECH_OUT_REDISTRIBUTE) so an assignment cannot land on an absent
 * tech's day, from tech-out's own redistribution or any other writer that
 * threads the destination date through. Omitting it keeps every caller
 * byte-identical to before this check existed.
 */
async function assertAssignableTechnician(technicianId, { conn = db, date, workDays = false } = {}) {
  if (technicianId === null || technicianId === undefined || technicianId === '') return null;
  const checkWorkDays = !!(workDays && date && techWorkDaysLive());
  let query = conn('technicians').where({ id: technicianId });
  if (conn.isTransaction) query = query.forShare();
  const columns = ['id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active'];
  if (checkWorkDays) columns.push('work_days');
  const tech = await query.first(...columns);
  let reason = reasonFor(tech);
  if (!reason && date) {
    const absence = await conn('technician_absences')
      .where({ technician_id: technicianId, absence_date: date })
      .whereNull('cleared_at')
      .first('id');
    if (absence) reason = `is marked out on ${date}`;
  }
  let offDay = false;
  if (!reason && checkWorkDays && isOffDay(tech, date)) {
    offDay = true;
    reason = `does not work on ${DAY_PLURALS[dayOfWeekOfDate(date)]} (${dateOnlyString(date)})`;
  }
  if (reason) {
    const err = new Error(`Technician ${tech ? tech.name : technicianId} ${reason} and cannot be assigned work`);
    // Both shapes: `status` for route handlers that read it, and the
    // isOperational + statusCode pair the shared error middleware
    // (middleware/errors.js) needs to surface a 422 instead of a 500.
    err.status = 422;
    err.statusCode = 422;
    err.isOperational = true;
    err.code = NOT_ASSIGNABLE;
    err.technicianId = technicianId;
    if (offDay) err.offDay = true;
    throw err;
  }
  return tech;
}

/**
 * The pair every status writer must set together. `active` is the legacy
 * compatibility column read by code that predates employment_status.
 */
function employmentPatch(status) {
  if (!isEmploymentStatus(status)) throw new Error(`Invalid employment status: ${status}`);
  return { employment_status: status, active: status === 'active' };
}


/**
 * Every (technician, date) pair an uncleared technician_absences row marks
 * out within [dateFrom, dateTo] (inclusive, YYYY-MM-DD), as a Set of
 * `${technicianId}:${date}` keys — GATE_TECH_OUT_REDISTRIBUTE's dated
 * commit-time check (`date` on assertAssignableTechnician above) has a
 * slot-discovery counterpart: every slot source loads this ONCE per request
 * and skips a (tech, date) candidate it names, so a customer is never
 * offered — and cannot hold — a slot on an absent tech's day that the
 * commit-time check would then refuse (codex #4678 pre-push auditor P1).
 *
 * `technicianIds`, when given, narrows the read to the caller's own
 * candidate tech list (every current caller already has one); omitted, it
 * loads every open absence in range. No marked-out tech in range (gate off,
 * or on with nothing marked) returns an empty Set, so every caller is
 * byte-identical to before this helper existed.
 *
 * Work days (GATE_TECH_WORK_DAYS on): every date in range that falls on a
 * weekday a technician with a work-days list does not work is added too, so
 * each caller above skips that tech-day exactly as it skips an absence, with
 * no change of its own. `includeOffDays: false` opts out (the open-visit nudge
 * must keep naming a visit a technician really holds on an off day). Gate off
 * or the option false = no extra read, byte-identical.
 */
async function absentTechDays(conn, { dateFrom, dateTo, technicianIds = null, includeOffDays = true } = {}) {
  let query = conn('technician_absences')
    .whereBetween('absence_date', [dateFrom, dateTo])
    .whereNull('cleared_at');
  if (Array.isArray(technicianIds) && technicianIds.length) {
    query = query.whereIn('technician_id', technicianIds);
  }
  const rows = await query.select('technician_id', 'absence_date');
  const days = new Set();
  for (const row of rows) {
    days.add(`${row.technician_id}:${dateOnlyString(row.absence_date)}`);
  }
  if (includeOffDays && techWorkDaysLive()) {
    for (const key of await offDayTechDays(conn, { dateFrom, dateTo, technicianIds })) days.add(key);
  }
  return days;
}

/**
 * Every (technician, date) pair in [dateFrom, dateTo] (inclusive, YYYY-MM-DD)
 * that falls on a weekday the technician does not work, as a Set of
 * `${technicianId}:${date}` keys. Empty while the gate is off or no technician
 * in scope has a work-days list. Dates are walked as plain calendar dates
 * (UTC arithmetic), so a DST change never shifts a weekday.
 */
async function offDayTechDays(conn, { dateFrom, dateTo, technicianIds = null } = {}) {
  const days = new Set();
  if (!techWorkDaysLive() || !dateFrom || !dateTo) return days;
  let query = conn('technicians').whereNotNull('work_days');
  if (Array.isArray(technicianIds) && technicianIds.length) {
    query = query.whereIn('id', technicianIds);
  }
  const rows = await query.select('id', 'work_days');
  const start = dayOfWeekOfDate(dateFrom) === null ? null : Date.parse(`${dateOnlyString(dateFrom)}T00:00:00Z`);
  const end = dayOfWeekOfDate(dateTo) === null ? null : Date.parse(`${dateOnlyString(dateTo)}T00:00:00Z`);
  if (start === null || end === null) return days;
  for (const row of rows) {
    const worked = normalizeWorkDays(row.work_days);
    if (!worked) continue;
    for (let t = start; t <= end; t += 86400000) {
      const d = new Date(t);
      if (!worked.includes(d.getUTCDay())) days.add(`${row.id}:${d.toISOString().slice(0, 10)}`);
    }
  }
  return days;
}

module.exports = {
  EMPLOYMENT_STATUSES,
  NOT_ASSIGNABLE,
  isEmploymentStatus,
  isAssignable,
  applyAssignable,
  assertAssignableTechnician,
  employmentPatch,
  absentTechDays,
  offDayTechDays,
  normalizeWorkDays,
  dayOfWeekOfDate,
  isOffDay,
  offDayWarning,
  offDayWarningFor,
  offDayWarningsFor,
};
