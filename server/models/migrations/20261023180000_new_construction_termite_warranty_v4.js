// New Construction Termite Warranty, version 4 (Codex #6515 r9). "Issued on"
// printed the day staff created the warranty, but the office may send it
// later from Document Requests, so the date could read earlier than the real
// issue. Version 4 drops that sentence; the signing record keeps the sent and
// signed times. The issuer line still dates Waves' own signature. Earlier versions stay in the table (an issued warranty keeps
// its own snapshot).
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { BODY_V3 } = require('./20261023160000_new_construction_termite_warranty_v3');

const FROM = 'This warranty runs from the initial treatment date, {{treatment.initial_date}}. Issued on {{warranty.issue_date}}.';
const TO = 'This warranty runs from the initial treatment date, {{treatment.initial_date}}.';

if (!BODY_V3.includes(FROM)) throw new Error('v4 migration: version 3 issue-date text not found');
const BODY_V4 = BODY_V3.replace(FROM, TO);

exports.up = async function up(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  let version = await knex('document_template_versions')
    .where({ template_id: template.id, version_number: 4 })
    .first();
  if (!version) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: 4,
      title: TEMPLATE.title,
      body: BODY_V4,
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
  const v3 = await knex('document_template_versions').where({ template_id: template.id, version_number: 3 }).first();
  const v4 = await knex('document_template_versions').where({ template_id: template.id, version_number: 4 }).first();
  if (!v4) return;
  // Only while v4 is still active: a version published after it stays.
  await knex('document_templates').where({ id: template.id, active_version_id: v4.id }).update({ active_version_id: v3 ? v3.id : null });
  const issued = await knex('customer_contracts').where({ document_template_version_id: v4.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: v4.id }).del();
};

exports.BODY_V4 = BODY_V4;
