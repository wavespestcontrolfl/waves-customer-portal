// New Construction Termite Warranty, version 6 (Codex #6515 r11). Versions
// 1-5 print the default FDACS license in the body; the PDF footer and the
// business constants use WAVES_FDACS_LICENSE when it is set. Version 6
// prints the configured license through {{issuer.license}}. Earlier versions
// stay in the table (an issued warranty keeps its own snapshot).
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { BODY_V5 } = require('./20261023200000_new_construction_termite_warranty_v5');

const FROM = 'FDACS License JB351547';
const TO = 'FDACS License {{issuer.license}}';

if (BODY_V5.split(FROM).length !== 2) throw new Error('v6 migration: version 5 license text not found once');
const BODY_V6 = BODY_V5.replace(FROM, TO);
const VARIABLES_V6 = [...TEMPLATE.variables, 'issuer.license'];

exports.up = async function up(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  let version = await knex('document_template_versions')
    .where({ template_id: template.id, version_number: 6 })
    .first();
  if (!version) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: 6,
      title: TEMPLATE.title,
      body: BODY_V6,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(VARIABLES_V6),
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
  const v5 = await knex('document_template_versions').where({ template_id: template.id, version_number: 5 }).first();
  const v6 = await knex('document_template_versions').where({ template_id: template.id, version_number: 6 }).first();
  if (!v6) return;
  // Only while v6 is still active: a version published after it stays.
  await knex('document_templates').where({ id: template.id, active_version_id: v6.id }).update({ active_version_id: v5 ? v5.id : null });
  const issued = await knex('customer_contracts').where({ document_template_version_id: v6.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: v6.id }).del();
};

exports.BODY_V6 = BODY_V6;
exports.VARIABLES_V6 = VARIABLES_V6;
