// New Construction Termite Warranty: property-neutral wording (Codex #6515
// r12). A commercial or multi-unit pre-treat qualifies too, but three fixed
// clauses said "home" and "homebuyer". This version says building, property
// and buyer. Unlike the earlier warranty migrations it does not assume a
// version number: under a template row lock it reuses the version whose body
// is exactly this text, else it takes MAX(version_number) + 1, so a version
// an admin published in between is never mistaken for this one. Earlier
// versions stay (an issued warranty keeps its own snapshot).
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { BODY_V6, VARIABLES_V6 } = require('./20261023220000_new_construction_termite_warranty_v6');

const REPLACEMENTS = [
  ['before the home is occupied', 'before the building is occupied'],
  ['This warranty goes with the home. If the home is sold,', 'This warranty goes with the property. If the property is sold,'],
  ['the first homebuyer becomes "you"', 'the first buyer becomes "you"'],
];

const BODY_V7 = REPLACEMENTS.reduce((text, [from, to]) => {
  if (text.split(from).length !== 2) throw new Error(`v7 migration: version 6 text not found once: ${from}`);
  return text.replace(from, to);
}, BODY_V6);

async function lockedTemplate(knex) {
  return knex('document_templates').where({ template_key: TEMPLATE.template_key }).forUpdate().first();
}

exports.up = async function up(knex) {
  const template = await lockedTemplate(knex);
  if (!template) return;
  let version = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V7 }).first();
  if (!version) {
    const latest = await knex('document_template_versions').where({ template_id: template.id }).max('version_number as n').first();
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: (Number(latest?.n) || 0) + 1,
      title: TEMPLATE.title,
      body: BODY_V7,
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
  const template = await lockedTemplate(knex);
  if (!template) return;
  const mine = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V7 }).first();
  if (!mine) return;
  const previous = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V6 }).first();
  // Only while this version is still active: a version published after it stays.
  await knex('document_templates').where({ id: template.id, active_version_id: mine.id }).update({ active_version_id: previous ? previous.id : null });
  const issued = await knex('customer_contracts').where({ document_template_version_id: mine.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: mine.id }).del();
};

exports.BODY_V7 = BODY_V7;
