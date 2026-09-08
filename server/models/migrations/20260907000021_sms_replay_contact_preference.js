/** Explicit SMS replay offers contact preferences through the existing review queue. */
const FIELDS = ['neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code',
  'parking_notes', 'access_notes', 'pet_details', 'special_instructions', 'irrigation_controller_location',
  'irrigation_schedule_notes', 'irrigation_issues'];
const CONSTRAINT = 'data_hygiene_proposals_resource_id_presence_check';

async function replaceConstraint(knex, fields) {
  await knex.raw(`ALTER TABLE data_hygiene_proposals DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE data_hygiene_proposals ADD CONSTRAINT ${CONSTRAINT}
    CHECK (resource_id IS NOT NULL OR (resource_type = 'property_preferences'
      AND field IN (${fields.map((field) => `'${field}'`).join(',')})))`);
}

exports.up = (knex) => replaceConstraint(knex, [...FIELDS, 'contact_preference']);
// A rollback intentionally refuses while NULL-target contact proposals exist;
// it must never delete a customer's recorded review work to shrink the CHECK.
exports.down = (knex) => replaceConstraint(knex, FIELDS);
