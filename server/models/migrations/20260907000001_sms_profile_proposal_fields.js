/**
 * The SMS profile lane proposes free-form preference facts for human review
 * through the data-hygiene queue. Four of its fields were outside the
 * create-on-apply allowance (a proposal may carry a NULL resource_id only
 * for listed property_preferences fields), so a customer without a
 * property_preferences row could not receive one. Widen the CHECK to match.
 */
const ORIGINAL_FIELDS = ['neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
  'parking_notes', 'access_notes', 'pet_details'];
const EXTENDED_FIELDS = [...ORIGINAL_FIELDS, 'special_instructions', 'irrigation_controller_location',
  'irrigation_schedule_notes', 'irrigation_issues'];
const CONSTRAINT = 'data_hygiene_proposals_resource_id_presence_check';
const presenceCheck = (fields) => `CHECK (resource_id IS NOT NULL OR (resource_type = 'property_preferences' AND field IN (${fields.map((field) => `'${field}'`).join(',')})))`;

async function replaceConstraint(knex, fields) {
  if (!(await knex.schema.hasTable('data_hygiene_proposals'))) return;
  await knex.raw(`ALTER TABLE data_hygiene_proposals DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE data_hygiene_proposals ADD CONSTRAINT ${CONSTRAINT} ${presenceCheck(fields)}`);
}

exports.up = (knex) => replaceConstraint(knex, EXTENDED_FIELDS);
exports.down = (knex) => replaceConstraint(knex, ORIGINAL_FIELDS);
