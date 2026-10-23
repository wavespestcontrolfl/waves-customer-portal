// New Construction Termite Warranty, version 3 (Codex #6515 r6). The
// certificate's lot field already holds "Lot 12, Block C", so version 2's
// hard-coded "Lot " printed "Lot Lot 12, Block C". Version 3 labels the field
// instead. Versions 1 and 2 stay in the table (an issued warranty keeps its
// own snapshot).
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { BODY_V2 } = require('./20261023140000_new_construction_termite_warranty_v2');

const FROM = '{{project.address}} · Lot {{project.lot}} · Permit {{project.permit}}.';
const TO = '{{project.address}} · Lot and subdivision: {{project.lot}} · Permit {{project.permit}}.';

if (!BODY_V2.includes(FROM)) throw new Error('v3 migration: version 2 lot text not found');
const BODY_V3 = BODY_V2.replace(FROM, TO);

exports.up = async function up(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  let version = await knex('document_template_versions')
    .where({ template_id: template.id, version_number: 3 })
    .first();
  if (!version) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: 3,
      title: TEMPLATE.title,
      body: BODY_V3,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(TEMPLATE.variables),
      required_fields: JSON.stringify(['initials', 'signedName']),
      published_at: knex.fn.now(),
    }).returning('*');
  }
  await knex('document_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    updated_at: knex.fn.now(),
  });
};

exports.down = async function down(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  const v2 = await knex('document_template_versions').where({ template_id: template.id, version_number: 2 }).first();
  const v3 = await knex('document_template_versions').where({ template_id: template.id, version_number: 3 }).first();
  if (!v3) return;
  // Only while v3 is still active: a version published after it stays.
  await knex('document_templates').where({ id: template.id, active_version_id: v3.id }).update({ active_version_id: v2 ? v2.id : null });
  const issued = await knex('customer_contracts').where({ document_template_version_id: v3.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: v3.id }).del();
};

exports.BODY_V3 = BODY_V3;
