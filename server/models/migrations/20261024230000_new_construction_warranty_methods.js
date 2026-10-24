// New Construction Termite Warranty, version 9: the treatment paragraph in
// section 3 and three CONDITIONS lines name the job's method (owner 10-24
// Q6 "do whatever you recommend"): a soil barrier, Bora-Care alone as the
// primary treatment, or a soil barrier with Bora-Care as its secondary
// treatment (Rule 5E-14.106(9), F.A.C.). The issue route fills them from
// fixed text in services/new-construction-warranty.js; for a soil job they
// print version 8's text word for word. Every other line is version 8. Like
// v8, it reuses the version whose body is exactly this text, else takes
// MAX(version_number) + 1 under the template row lock.
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');
const { BODY_V8, VARIABLES_V8 } = require('./20261024211000_new_construction_warranty_start_date');

const SOIL_PARAGRAPH = 'A preventive soil treatment for subterranean termites during construction. No termite infestation was known to be present. Product: {{treatment.product}} ({{treatment.active_ingredient}}) at {{treatment.concentration}}% · {{treatment.gallons}} gallons · {{treatment.sq_ft}} sq ft · {{treatment.linear_ft}} linear ft. Initial treatment date: {{treatment.initial_date}}. {{treatment.final_exterior_line}} Applicator: {{treatment.applicator}}, ID card {{treatment.applicator_id}}.';
const REPLACEMENTS = [
  [SOIL_PARAGRAPH, '{{treatment.description}}'],
  ['- The final exterior treatment must be completed before the building is occupied. If the builder does not allow it, we tell the owner in writing, and the untreated exterior is excluded until it is treated.', '- {{conditions.first}}'],
  ['- These can break the treated barrier: soil, mulch or landscaping added against the foundation; new slabs, patios or stoops; digging next to the foundation; plumbing or irrigation leaks; wood, siding or stucco touching soil; moisture against the foundation.', '- {{conditions.second}}'],
  ['- Call us before work that disturbs treated soil. We can re-treat the disturbed area for a fee.', '- {{conditions.third}}'],
];
const BODY_V9 = REPLACEMENTS.reduce((body, [from, to]) => {
  if (body.split(from).length !== 2) throw new Error(`method migration: version 8 text not found once: ${from.slice(0, 60)}`);
  return body.replace(from, to);
}, BODY_V8);
const MOVED = ['treatment.product', 'treatment.active_ingredient', 'treatment.concentration', 'treatment.gallons', 'treatment.sq_ft', 'treatment.linear_ft', 'treatment.initial_date', 'treatment.final_exterior_line', 'treatment.applicator', 'treatment.applicator_id'];
const VARIABLES_V9 = [
  ...VARIABLES_V8.filter((name) => !MOVED.includes(name)),
  'treatment.description', 'conditions.first', 'conditions.second', 'conditions.third',
];

async function lockedTemplate(knex) {
  return knex('document_templates').where({ template_key: TEMPLATE.template_key }).forUpdate().first();
}

exports.up = async function up(knex) {
  const template = await lockedTemplate(knex);
  if (!template) return;
  let version = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V9 }).first();
  if (!version) {
    const latest = await knex('document_template_versions').where({ template_id: template.id }).max('version_number as n').first();
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: (Number(latest?.n) || 0) + 1,
      title: TEMPLATE.title,
      body: BODY_V9,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(VARIABLES_V9),
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
  const mine = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V9 }).first();
  if (!mine) return;
  const previous = await knex('document_template_versions').where({ template_id: template.id, body: BODY_V8 }).first();
  // Only while this version is still active: a version published after it stays.
  const restored = await knex('document_templates').where({ id: template.id, active_version_id: mine.id })
    .update({ active_version_id: previous ? previous.id : null });
  if (!restored) return;
  const issued = await knex('customer_contracts').where({ document_template_version_id: mine.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: mine.id }).del();
};

exports.BODY_V9 = BODY_V9;
exports.VARIABLES_V9 = VARIABLES_V9;
