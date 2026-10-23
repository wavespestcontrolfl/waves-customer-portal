// New Construction Termite Warranty, version 2 (Codex #6515 r1). Two
// sentences of version 1 could print something untrue:
// - "We issue it within 30 days of that date" on a warranty issued late; the
//   contract now states the actual issue date (the 30-day duty stays on Waves).
// - "Renewal is due each year on <full date>" goes stale after the first
//   renewal; the contract now names the first due date and its anniversary.
// Version 1 stays in the table (an issued warranty keeps its own snapshot).
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');

const REPLACEMENTS = [
  [
    'This warranty runs from the initial treatment date, {{treatment.initial_date}}. We issue it within 30 days of that date.',
    'This warranty runs from the initial treatment date, {{treatment.initial_date}}. Issued on {{warranty.issue_date}}.',
  ],
  [
    'Renewal is due each year on {{warranty.renewal_due}}.',
    'The first renewal is due on {{warranty.renewal_due}}; later renewals are due on the same date each year.',
  ],
];

function bodyV2(body) {
  return REPLACEMENTS.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`v2 migration: version 1 text not found: ${from.slice(0, 60)}`);
    return text.replace(from, to);
  }, body);
}

const BODY_V2 = bodyV2(TEMPLATE.body);

exports.up = async function up(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  let version = await knex('document_template_versions')
    .where({ template_id: template.id, version_number: 2 })
    .first();
  if (!version) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: 2,
      title: TEMPLATE.title,
      body: BODY_V2,
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
  const v1 = await knex('document_template_versions').where({ template_id: template.id, version_number: 1 }).first();
  const v2 = await knex('document_template_versions').where({ template_id: template.id, version_number: 2 }).first();
  if (!v2) return;
  await knex('document_templates').where({ id: template.id }).update({ active_version_id: v1 ? v1.id : null });
  const issued = await knex('customer_contracts').where({ document_template_id: template.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: v2.id }).del();
};

exports.BODY_V2 = BODY_V2;
