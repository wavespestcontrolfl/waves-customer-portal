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
 */
async function assertAssignableTechnician(technicianId, { conn = db } = {}) {
  if (technicianId === null || technicianId === undefined || technicianId === '') return null;
  const tech = await conn('technicians')
    .where({ id: technicianId })
    .first('id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active');
  const reason = reasonFor(tech);
  if (reason) {
    const err = new Error(`Technician ${tech ? tech.name : technicianId} ${reason} and cannot be assigned work`);
    err.status = 422;
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
