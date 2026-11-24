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
const { dateOnlyString, etDateString, etParts, validCalendarDate } = require('../utils/datetime-et');
const { STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');
const { savepointRead } = require('../utils/savepoint-read');
const featureGates = require('../config/feature-gates');
const logger = require('./logger');

// Looked up on the module at call time, not destructured at load: this seam is
// loaded under many partial feature-gates mocks, and a missing reader must read
// as "gate off" (today's behavior) rather than throw.
const techWorkDaysLive = () => typeof featureGates.techWorkDaysLive === 'function' && featureGates.techWorkDaysLive();
const techJobTypeChecksLive = () => typeof featureGates.techJobTypeChecksLive === 'function' && featureGates.techJobTypeChecksLive();
const techShiftHoursLive = () => typeof featureGates.techShiftHoursLive === 'function' && featureGates.techShiftHoursLive();

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

/** Minutes after midnight as '8:00 AM' (office copy). Pure. */
function clock12(minutes) {
  const hour = Math.floor(minutes / 60) % 24;
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * The plain warning line an office path adds when it puts a visit outside its
 * technician's shift that day ("Tech One's shift is 8:00 AM to 6:00 PM. This
 * visit is outside those hours."), or null when the shift holds the visit or
 * there is no shift (GATE_TECH_SHIFT_HOURS off, or no set hours). `shift` is
 * shiftOf's answer for the technician and date, `hours` the visit's own block.
 * The line names the shift, not the visit's hours: two office checks of one
 * save then give one line. Office paths warn, never block. Pure.
 */
function shiftWarning(tech, shift, hours) {
  if (!shift || !isBlock(hours) || !shiftNotHolding(shift, hours)) return null;
  const name = (tech && tech.name) || 'This technician';
  return `${name}'s shift is ${clock12(shift.startMin)} to ${clock12(shift.endMin)}. This visit is outside those hours.`;
}

/**
 * Warning lines for one technician id across one or more dates, for an office
 * path that puts the technician on those dates: the day-off line
 * (offDayWarning, GATE_TECH_WORK_DAYS) for each distinct weekday that is an
 * off day, and, on a day that is not one, the shift line (shiftWarning,
 * GATE_TECH_SHIFT_HOURS) when `block`, the visit's own row as the save leaves
 * it ({ window_start, window_end, estimated_duration_minutes }), is outside
 * the technician's shift that day. De-duplicated, in date order.
 * The block is read to the minute (rowBlockMinutes), not as the movers judge
 * one (shiftBlockMinutes): a line states a fact, so a time this cannot read
 * gives no line.
 * An office path calls this with no gate check of its own. [] and no read:
 * both gates off, no technician, no date, or only the shift gate on and no
 * block to ask about. Each read has its own savepoint on a transaction, so a
 * failed read can never abort the caller's transaction; a failed read gives no
 * line of its kind and keeps the other kind's (an advisory line never blocks
 * a save).
 */
async function dayWarningsFor(technicianId, dates, { conn = db, block = null } = {}) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean);
  const hours = techShiftHoursLive() && block ? require('./scheduling/window-rules').rowBlockMinutes(block) : null;
  if (!(techWorkDaysLive() || isBlock(hours)) || !technicianId || !list.length) return [];
  const guarded = async (read, failed) => {
    try {
      return await (conn.isTransaction && typeof conn.transaction === 'function' ? conn.transaction((sp) => read(sp)) : read(conn));
    } catch {
      return failed;
    }
  };
  const tech = await guarded((c) => c('technicians').where({ id: technicianId }).first('id', 'name', 'work_days'), null);
  const noShift = () => null;
  const shiftOf = isBlock(hours) ? await guarded((c) => loadTechShifts(c, { technicianIds: [technicianId] }), noShift) : noShift;
  const lines = new Set();
  for (const date of [...list].sort()) {
    const line = offDayWarning(tech, date) || shiftWarning(tech, shiftOf(technicianId, date), hours);
    if (line) lines.add(line);
  }
  return [...lines];
}

/** dayWarningsFor for one date: its line (the day-off line or the shift line), or null. */
async function dayWarningFor(technicianId, dateStr, { conn = db, block = null } = {}) {
  const [line] = await dayWarningsFor(technicianId, [dateStr], { conn, block });
  return line || null;
}

/**
 * Warning lines an office path adds when it puts a technician on work whose job
 * type the technician is set to Off for in the Team tab ("Tech One is set to Off
 * for Lawn, tree & shrub work."), one line per distinct category (GATE_TECH_JOB_TYPE_CHECKS).
 * `services` is the visit's rows: { service_type, service_id?, service_key? };
 * the category comes from the service library first, then the name
 * (technician-capabilities.categoriesForServices). Same shape as dayWarningsFor:
 * [] when the gate is off, nothing is chosen, or the read fails (an advisory line
 * never blocks a save). Needs-review and qualified never warn (owner 2026-09-05:
 * every hire may treat every service); only Off does. Office paths warn, never block.
 */
async function capabilityOffWarningsFor(technicianId, services, { conn = db } = {}) {
  const rows = (Array.isArray(services) ? services : [services]).filter((row) => row && (row.service_type || row.service_id || row.service_key));
  if (!techJobTypeChecksLive() || !technicianId || !rows.length) return [];
  try {
    const { categoriesForServices, CATEGORY_LABELS } = require('./technician-capabilities');
    const read = async (c) => {
      const categories = [...new Set(await categoriesForServices(c, rows))].filter(Boolean);
      if (!categories.length) return { off: [], tech: null };
      const off = await c('technician_capabilities')
        .where({ technician_id: technicianId, active: false }).whereIn('service_category', categories)
        .pluck('service_category');
      if (!off.length) return { off: [], tech: null };
      return { off, tech: await c('technicians').where({ id: technicianId }).first('name') };
    };
    const { off, tech } = conn.isTransaction && typeof conn.transaction === 'function'
      ? await conn.transaction((sp) => read(sp))
      : await read(conn);
    const name = (tech && tech.name) || 'This technician';
    return [...new Set(off)].map((category) => `${name} is set to Off for ${CATEGORY_LABELS[category] || category} work.`);
  } catch {
    return [];
  }
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
 *
 * `hours` (opt-in, with `date`): the job's own block on that date,
 * { startMin, endMin } in minutes after midnight Eastern. Also refuses a
 * technician whose shift that day does not hold the job (shiftExcluding
 * below; GATE_TECH_SHIFT_HOURS on, owner 2026-11-19, D4: "confirmations allow
 * only jobs that end by that tech's shift end"). Pass it ONLY at AUTOMATIC
 * commit points, as `workDays`: office paths warn instead. Omitted, or with
 * the gate off, nothing more is read. The error then carries
 * `outsideShift: true` (`offDay: true` for the work-days refusal).
 */
async function assertAssignableTechnician(technicianId, { conn = db, date, workDays = false, hours } = {}) {
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
  let flag = null;
  if (!reason && checkWorkDays && isOffDay(tech, date)) {
    flag = 'offDay';
    reason = `does not work on ${DAY_PLURALS[dayOfWeekOfDate(date)]} (${dateOnlyString(date)})`;
  }
  // Last, and only for a technician every other rule accepts: the job's own hours against the shift.
  const shift = reason ? null : await shiftExcluding(conn, technicianId, date, hours);
  if (shift) {
    flag = 'outsideShift';
    reason = `is on shift ${clockOf(shift.startMin)} to ${clockOf(shift.endMin)} on ${dateOnlyString(date)}, not for a job from ${clockOf(hours.startMin)} to ${clockOf(hours.endMin)},`;
  }
  if (reason) throw notAssignableError(tech, technicianId, reason, flag);
  return tech;
}

/**
 * The refusal assertAssignableTechnician throws. `flag` names the dated rule
 * that refused ('offDay' or 'outsideShift'), for a caller that tells them apart.
 */
function notAssignableError(tech, technicianId, reason, flag) {
  const err = new Error(`Technician ${tech ? tech.name : technicianId} ${reason} and cannot be assigned work`);
  // Both shapes: `status` for route handlers that read it, and the
  // isOperational + statusCode pair the shared error middleware
  // (middleware/errors.js) needs to surface a 422 instead of a 500.
  err.status = 422;
  err.statusCode = 422;
  err.isOperational = true;
  err.code = NOT_ASSIGNABLE;
  err.technicianId = technicianId;
  if (flag) err[flag] = true;
  return err;
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

/**
 * Minutes after midnight of a stored or submitted wall-clock time ('HH:MM' or
 * the Postgres 'HH:MM:SS' form; seconds are dropped), or null when it is not
 * one. Pure.
 */
function shiftMinutes(value) {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(value == null ? '' : value).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * A technician row's stored shift as { startMin, endMin }, or null when the row
 * has no set hours (or unreadable ones). `tech` needs shift_start and shift_end.
 * Pure.
 */
function storedShift(tech) {
  const startMin = shiftMinutes(tech && tech.shift_start);
  const endMin = shiftMinutes(tech && tech.shift_end);
  if (startMin === null || endMin === null || endMin <= startMin) return null;
  return { startMin, endMin };
}

/**
 * Today's shift from a clock-in instant: the set length of day, in elapsed
 * time, from that instant, as Eastern minutes after midnight. Elapsed time,
 * not clock arithmetic: on a daylight-saving Sunday a clock-in before 2 AM
 * ends an hour later on the clock (March) or an hour earlier (November) than
 * start + length. Never past midnight. Never before the clock-in: a day
 * shorter than an hour that ends inside November's repeated hour would read
 * as earlier on the clock. Pure.
 */
function clockInShift(at, shift) {
  const from = etParts(at);
  const to = etParts(new Date(at.getTime() + (shift.endMin - shift.startMin) * 60000));
  const startMin = from.hour * 60 + from.minute;
  // The set length is under 24 hours: another day of the month is the next day.
  const endMin = to.day === from.day ? to.hour * 60 + to.minute : 24 * 60;
  return { startMin, endMin: Math.max(startMin, endMin), source: 'clock_in' };
}

/**
 * Each technician's shift for a date (GATE_TECH_SHIFT_HOURS; owner 2026-11-19,
 * page item D4: "each tech's 10-hour day on every booking path"; "Shifts come
 * from clock-in today and the roster ahead").
 *
 * Reads the set hours (technicians.shift_start / shift_end, the Team tab
 * "Shift hours") once, and today's clock-ins, and returns a pure lookup
 * shiftOf(technicianId, date) -> { startMin, endMin, source } | null, in
 * minutes after midnight Eastern:
 *   - a date after today, or today before a clock-in: the set hours
 *     (source 'roster');
 *   - today, once the technician has clocked in (the first shift clock-in that
 *     is not voided, on today's Staff work date, and not after `now`: an entry
 *     typed in ahead of time has not happened yet): the same length of day from
 *     that clock-in, in elapsed time (source 'clock_in', clockInShift). An
 *     earlier clock-in ends the day earlier, a later one ends it later; never
 *     past midnight.
 *   - null: the gate is off (no read at all), the technician has no set hours,
 *     or `date` is not a date. The caller keeps its own day bounds.
 * Work days, absences and closures stay with their own readers
 * (absentTechDays, blackout dates); this answers only the hours of a day.
 * A failed clock-in read keeps the set hours for today (logged; on a
 * transaction it is a queued savepoint read, utils/savepoint-read.js, so the
 * caller's transaction stays usable: do not call this from inside another
 * savepointRead on the same transaction, it would wait on its own caller); a
 * failed read of the hours themselves throws, as absentTechDays does.
 * `technicianIds` narrows the reads. An empty list asks about no technician:
 * nothing is read (a search whose technician filter matched nobody).
 */
async function loadTechShifts(conn, { technicianIds = null, now = new Date() } = {}) {
  const none = () => null;
  if (!techShiftHoursLive() || (Array.isArray(technicianIds) && !technicianIds.length)) return none;
  let query = conn('technicians').whereNotNull('shift_start').whereNotNull('shift_end');
  if (Array.isArray(technicianIds)) query = query.whereIn('id', technicianIds);
  // A uuid spelled in capitals is the same technician: Postgres takes it and reads it back in
  // lower case, so both maps are keyed and asked in lower case.
  const key = (id) => String(id).toLowerCase();
  const shifts = new Map();
  for (const row of await query.select('id', 'shift_start', 'shift_end')) {
    const shift = storedShift(row);
    if (shift) shifts.set(key(row.id), shift);
  }
  if (!shifts.size) return none;
  const today = etDateString(now);
  const clockIns = new Map();
  try {
    // On a transaction this is a queued savepoint read (utils/savepoint-read.js):
    // a failed read can never abort the caller's transaction, and it never
    // overlaps another recoverable read on that transaction.
    const read = (c) => c('time_entries')
      .where({ entry_type: 'shift' })
      .whereNot({ status: 'voided' })
      .whereIn('technician_id', [...shifts.keys()])
      .whereRaw(`${STAFF_WORK_DATE_SQL} = ?::date`, [today])
      .where('clock_in', '<=', now)
      .groupBy('technician_id')
      .select('technician_id')
      .min({ clock_in: 'clock_in' });
    const rows = await savepointRead(conn, read);
    for (const row of rows) {
      const at = row.clock_in instanceof Date ? row.clock_in : new Date(row.clock_in);
      const shift = shifts.get(key(row.technician_id));
      if (!shift || Number.isNaN(at.getTime())) continue;
      clockIns.set(key(row.technician_id), clockInShift(at, shift));
    }
  } catch (err) {
    logger.warn(`[technician-eligibility] today's clock-ins unread (${err.message}); the set hours stand for today`);
    clockIns.clear();
  }
  return (technicianId, date) => {
    const shift = shifts.get(key(technicianId));
    // A Date (a pg DATE read back) or an exact 'YYYY-MM-DD'; anything else, an
    // invalid Date or a string with a tail included, is no date.
    const day = date instanceof Date
      ? (Number.isNaN(date.getTime()) ? null : dateOnlyString(date))
      : validCalendarDate(date);
    if (!shift || !day) return null;
    const clockedIn = day === today ? clockIns.get(key(technicianId)) : undefined;
    return clockedIn ? { ...clockedIn } : { ...shift, source: 'roster' };
  };
}

/**
 * One technician's day under the shift rule (GATE_TECH_SHIFT_HOURS; owner
 * 2026-11-19, page item D4: "offers and confirmations allow only jobs that
 * end by that tech's shift end"): a job starts at or after the shift start
 * and ends by the shift end. `shift` is shiftOf's answer for the technician
 * and date; `openMin` and `closeMin` are the caller's own day, in minutes
 * after midnight Eastern. The shift only narrows that day, and no shift
 * (null: the gate off, or no set hours) returns it as it is. A job from
 * `start` to `end` fits when start >= openMin and end <= closeMin. Pure.
 */
function shiftBounds(shift, openMin, closeMin) {
  if (!shift) return { openMin, closeMin };
  return { openMin: Math.max(openMin, shift.startMin), closeMin: Math.min(closeMin, shift.endMin) };
}

/** Minutes after midnight as 'HH:MM'. Pure. */
function clockOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The shift a job does not fit, at a commit (GATE_TECH_SHIFT_HOURS; the same
 * rule the offers use, shiftBounds). `hours` is the job's own block on `date`,
 * { startMin, endMin } in minutes after midnight Eastern: the block the
 * commit writes (its start, and its start plus its length).
 * Returns the technician's shift for that date (loadTechShifts: the set
 * hours, or today's clock-in) when the job starts before it or ends after it.
 * Returns null when the job fits, the gate is off (no read), the technician
 * has no set hours, or there is no technician, no date or no block (numbers,
 * with the end after the start): such a job is left to the caller's other
 * checks, as before. A failed read of the hours throws, as it does for the
 * offers.
 *
 * The read is a point in time, and it takes no lock of its own. Nothing
 * re-checks a booked visit when the hours change later (a Team save, a
 * clock-in, a time-entry correction). So a change that lands after this
 * read leaves the same state as one that lands after the caller's commit.
 */
async function shiftExcluding(conn, technicianId, date, hours) {
  if (!technicianId || !date || !isBlock(hours)) return null;
  return shiftNotHolding((await loadTechShifts(conn, { technicianIds: [technicianId] }))(technicianId, date), hours);
}

/** A block to judge: numbers, with the end after the start. Pure. */
function isBlock(hours) {
  return Number.isFinite(hours?.startMin) && Number.isFinite(hours?.endMin) && hours.endMin > hours.startMin;
}

/** `shift` when the block starts before it or ends after it; null when it fits, or there is no shift. Pure. */
function shiftNotHolding(shift, { startMin, endMin }) {
  const day = shiftBounds(shift, startMin, endMin);
  return day.openMin > startMin || day.closeMin < endMin ? shift : null;
}

/**
 * The shift a visit loses by a change of day alone (GATE_TECH_SHIFT_HOURS). The
 * visit keeps its hours and its technician, so the move does not place it: a
 * later visit of a plan a series move shifts, a follow-up that moves with its
 * parent. `row` is the visit as the move leaves it (window_start, window_end,
 * estimated_duration_minutes).
 * Returns the new day's shift when the old day's shift held the visit and the
 * new day's does not; null otherwise.
 *   - A visit the shift did not hold where it was is the office's placement,
 *     and stays the office's: null. That needs evidence, the visit's own
 *     minutes (rowBlockMinutes) outside the old day's shift.
 *   - The new day must hold the block the movers judge (shiftBlockMinutes): a
 *     stored time they cannot read exactly is one no shift holds.
 *   - Set hours are the same every day and only today's follow a clock-in
 *     (loadTechShifts). So a visit can lose its shift only when it leaves
 *     today (Eastern) or lands on it. Between two other days nothing is read
 *     and the answer is null, also for a stored time with seconds.
 *   - One read of the hours judges both days, so a save of the hours between
 *     two reads cannot make them differ.
 * null too when the gate is off (no read), without a technician, a day or a
 * window, and for a technician with no set hours. shiftExcluding's notes on
 * the read (a point in time, no lock, a failed read throws) hold here.
 */
async function shiftLostByDayChange(conn, technicianId, row, fromDate, toDate) {
  const { rowBlockMinutes, shiftBlockMinutes } = require('./scheduling/window-rules');
  const held = rowBlockMinutes(row);
  const landing = shiftBlockMinutes(row);
  const now = new Date();
  if (!technicianId || !fromDate || !toDate || !isBlock(landing)) return null;
  if (![fromDate, toDate].map(dateOnlyString).includes(etDateString(now))) return null;
  const shiftOf = await loadTechShifts(conn, { technicianIds: [technicianId], now });
  if (isBlock(held) && shiftNotHolding(shiftOf(technicianId, fromDate), held)) return null;
  return shiftNotHolding(shiftOf(technicianId, toDate), landing);
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
  loadTechShifts,
  shiftBounds,
  shiftExcluding,
  shiftLostByDayChange,
  shiftMinutes,
  storedShift,
  normalizeWorkDays,
  dayOfWeekOfDate,
  isOffDay,
  offDayWarning,
  shiftWarning,
  dayWarningFor,
  dayWarningsFor,
  capabilityOffWarningsFor,
};
