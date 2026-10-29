/**
 * Payroll family employee (owner ruling 2026-10-29, D5 part 2 of the first-technician
 * pay plan: "Build the payroll pieces now, switched off"). Dark behind
 * GATE_PAYROLL_FAMILY_EMPLOYEE (the route checks it; payroll-runs.js asks
 * payrollFamilyEmployeeLive() through familyExemptIds).
 *
 * The setting records that a W-2 technician is the owner's parent or spouse, which
 * entity employs them, and the date from which their pay is exempt from federal
 * unemployment tax (26 U.S.C. 3306(c)(5)) and Florida reemployment tax
 * (F.S. 443.1216(13)(d)), and nothing else: income tax withholding, Social
 * Security and Medicare are unchanged. The entity must be a sole proprietorship or a
 * single-member LLC with no S election (T.D. 9554); an S election or a partner ends
 * the exception, and the owner clears the setting then. A child is not supported
 * (the under-21 test needs a birth date).
 *
 * Audit events carry ids only.
 */
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { PayrollError } = require('./payroll-w4');
const { payrollFamilyEmployeeLive } = require('../config/feature-gates');
const { validCalendarDate } = require('../utils/datetime-et');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIONSHIPS = ['parent', 'spouse'];
const ENTITIES = ['sole_proprietorship', 'single_member_llc'];
const EARLIEST_START = '2020-01-01';

// GATE_PAYROLL_FAMILY_EMPLOYEE, read at call time. The typeof guard keeps a test mock of
// feature-gates that lacks the reader working (off).
const familyEmployeeOn = () => typeof payrollFamilyEmployeeLive === 'function' && payrollFamilyEmployeeLive();

// All three fields or none: a null relationship clears the setting.
const whenSet = (schema) => Joi.when('relationship', { is: Joi.valid(null), then: Joi.valid(null).optional(), otherwise: schema.required() });
const settingSchema = Joi.object({
  relationship: Joi.string().valid(...RELATIONSHIPS).allow(null).required()
    .messages({ 'any.only': 'Pick parent or spouse', 'any.required': 'Pick parent or spouse', 'string.base': 'Pick parent or spouse' }),
  entity: whenSet(Joi.string().valid(...ENTITIES))
    .messages({ 'any.only': 'Pick sole proprietorship or single-member LLC', 'any.required': 'Pick the employer entity', 'string.base': 'Pick the employer entity' }),
  exemptFrom: whenSet(Joi.string().trim().custom((value, helpers) => {
    if (!validCalendarDate(value)) return helpers.message('Start date must be a real date (YYYY-MM-DD)');
    return value < EARLIEST_START ? helpers.message(`Start date must be ${EARLIEST_START} or later`) : value;
  }))
    .messages({ 'any.required': 'Enter the start date', 'string.base': 'Start date must be a real date (YYYY-MM-DD)', 'string.empty': 'Enter the start date' }),
});

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

const actorOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;

// The three columns, dates as text so a server time zone can never move a day.
const familyColumns = (conn) => [
  'id', 'family_relationship', 'family_employer_entity',
  conn.raw("to_char(family_exempt_from, 'YYYY-MM-DD') as family_exempt_from"),
];

// { relationship, entity, exemptFrom } or null when the technician has no setting.
const serializeFamily = (row) => (row.family_relationship
  ? { relationship: row.family_relationship, entity: row.family_employer_entity, exemptFrom: row.family_exempt_from }
  : null);

async function setFamilyEmployment(technicianId, input, actor, conn = db) {
  if (!UUID_RE.test(String(technicianId || ''))) throw new PayrollError(404, 'Technician not found.');
  const v = validate(settingSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate().first('id', 'employment_type');
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (tech.employment_type !== 'w2') throw new PayrollError(409, 'The family employee setting is for W-2 employees.');
    await trx('technicians').where({ id: technicianId }).update({
      family_relationship: v.relationship,
      family_employer_entity: v.relationship ? v.entity : null,
      family_exempt_from: v.relationship ? v.exemptFrom : null,
      updated_at: trx.fn.now(),
    });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.family_employment_changed', resource_type: 'technicians', resource_id: technicianId,
      metadata: { technician_id: technicianId },
    });
    const row = await trx('technicians').where({ id: technicianId }).first(familyColumns(trx));
    return { id: row.id, familyEmployment: serializeFamily(row) };
  });
}

/**
 * The pay run's read: ids of the technicians whose pay on `payDate` is exempt (the
 * setting is complete and starts on or before the pay date; wages are FUTA wages when
 * paid). Gate off: an empty set, no query. With lock, the rows are read FOR SHARE so a
 * setting change waits for the transaction.
 */
async function familyExemptIds(conn, technicianIds, payDate, { lock = false } = {}) {
  if (!familyEmployeeOn() || !technicianIds.length) return new Set();
  const query = conn('technicians')
    .whereIn('id', technicianIds)
    .whereNotNull('family_relationship')
    .whereNotNull('family_employer_entity')
    .where('family_exempt_from', '<=', payDate);
  if (lock) query.forShare();
  return new Set((await query.select('id')).map((row) => row.id));
}

module.exports = { familyEmployeeOn, setFamilyEmployment, familyExemptIds };
