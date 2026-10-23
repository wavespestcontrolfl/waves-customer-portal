// New Construction Termite Warranty: template row metadata (Codex #6515 r13).
// The seed reuses a row that already holds this key and only adds versions,
// so a pre-existing inactive, staff-audience or view-only row would keep
// that state. This sets the row to what the warranty needs: an active,
// customer-facing service agreement that requires a signature.
const { TEMPLATE } = require('./20261023120000_seed_new_construction_termite_warranty');

const FIELDS = ['status', 'audience', 'requires_signature', 'document_type', 'category'];
const REQUIRED = {
  status: 'active',
  audience: 'customer',
  requires_signature: true,
  document_type: TEMPLATE.document_type,
  category: TEMPLATE.category,
};

exports.up = async function up(knex) {
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first(FIELDS.concat('id'));
  if (!template) return;
  if (FIELDS.every((field) => template[field] === REQUIRED[field])) return;
  await knex('document_templates').where({ id: template.id }).update({ ...REQUIRED, updated_at: knex.fn.now() });
};

// The earlier values are not recorded, and the corrected row is the safe
// state, so rollback leaves it.
exports.down = async function down() {};

exports.REQUIRED = REQUIRED;
