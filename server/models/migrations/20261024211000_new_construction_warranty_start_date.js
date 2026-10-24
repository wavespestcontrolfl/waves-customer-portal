// New Construction Termite Warranty: the warranty names the date it runs
// from. A builder lot under the master agreement runs from its final
// treatment date; a job the owner signed for before treatment runs from the
// initial treatment date (Rule 5E-14.105(3)(a) allows either; owner 10-24 Q3
// "do whatever you recommend"). Every other line is version 7. Like v7, it
// reuses the version whose body is exactly this text, else takes
// MAX(version_number) + 1 under the template row lock.
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { VARIABLES_V6 } = require('./20261023220000_new_construction_termite_warranty_v6');
const { BODY_V7 } = require('./20261023240000_new_construction_termite_warranty_v7');

const FROM = 'This warranty runs from the initial treatment date, {{treatment.initial_date}}.';
const TO = 'This warranty runs from the {{warranty.start_basis}} treatment date, {{warranty.start_date}}.';
if (BODY_V7.split(FROM).length !== 2) throw new Error('start-date migration: version 7 text not found once');
const BODY_V8 = BODY_V7.replace(FROM, TO);
const VARIABLES_V8 = [...VARIABLES_V6, 'warranty.start_basis', 'warranty.start_date'];

async function lockedTemplate(knex) {
  return knex('document_templates').where({ template_key: TEMPLATE.template_key }).forUpdate().first();
}

exports.up = async function up(knex) {
  const template = await lockedTemplate(knex);
  if (!template) return;
  let version = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V8 }).first();
  if (!version) {
    const latest = await knex('document_template_versions').where({ template_id: template.id }).max('version_number as n').first();
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: (Number(latest?.n) || 0) + 1,
      title: TEMPLATE.title,
      body: BODY_V8,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(VARIABLES_V8),
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
  const template = await lockedTemplate(knex);
  if (!template) return;
  const mine = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V8 }).first();
  if (!mine) return;
  const previous = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V7 }).first();
  // Only while this version is still active: a version published after it stays.
  const restored = await knex('document_templates').where({ id: template.id, active_version_id: mine.id })
    .update({ active_version_id: previous ? previous.id : null });
  if (!restored) return;
  const issued = await knex('customer_contracts').where({ document_template_version_id: mine.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: mine.id }).del();
};

exports.BODY_V8 = BODY_V8;
exports.VARIABLES_V8 = VARIABLES_V8;
