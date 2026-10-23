// New Construction Termite Warranty, version 5 (Codex #6515 r10). Section 4
// makes renewal after year 5, or after a prepaid term, our option, but
// section 6 said paying the fee always continues coverage. Version 5 makes
// section 6 follow section 4. Earlier versions stay in the table (an issued
// warranty keeps its own snapshot).
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { BODY_V4 } = require('./20261023180000_new_construction_termite_warranty_v4');

const FROM = 'Pay the fee by the due date and coverage continues for one more year.';
const TO = 'When you have the right to renew (section 4), paying the fee by the due date continues coverage for one more year. When renewal is at our option, the renewal notice says whether we offer it; if we do, paying by the due date continues coverage for one more year.';

if (!BODY_V4.includes(FROM)) throw new Error('v5 migration: version 4 renewal text not found');
const BODY_V5 = BODY_V4.replace(FROM, TO);

exports.up = async function up(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  let version = await knex('document_template_versions')
    .where({ template_id: template.id, version_number: 5 })
    .first();
  if (!version) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: 5,
      title: TEMPLATE.title,
      body: BODY_V5,
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
  const v4 = await knex('document_template_versions').where({ template_id: template.id, version_number: 4 }).first();
  const v5 = await knex('document_template_versions').where({ template_id: template.id, version_number: 5 }).first();
  if (!v5) return;
  // Only while v5 is still active: a version published after it stays.
  await knex('document_templates').where({ id: template.id, active_version_id: v5.id }).update({ active_version_id: v4 ? v4.id : null });
  const issued = await knex('customer_contracts').where({ document_template_version_id: v5.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: v5.id }).del();
};

exports.BODY_V5 = BODY_V5;
