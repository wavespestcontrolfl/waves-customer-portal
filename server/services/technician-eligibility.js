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
 */
async function assertAssignableTechnician(technicianId, { conn = db } = {}) {
  if (technicianId === null || technicianId === undefined || technicianId === '') return null;
  let query = conn('technicians').where({ id: technicianId });
  if (conn.isTransaction) query = query.forShare();
  const tech = await query.first('id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active');
  const reason = reasonFor(tech);
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

module.exports = {
  EMPLOYMENT_STATUSES,
  NOT_ASSIGNABLE,
  isEmploymentStatus,
  isAssignable,
  applyAssignable,
  assertAssignableTechnician,
  employmentPatch,
};
