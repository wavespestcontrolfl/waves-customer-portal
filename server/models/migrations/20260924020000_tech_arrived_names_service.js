/**
 * The arrival text names the visit (owner directive 2026-09-24):
 *
 *   "Hello Jayson! Adam has arrived for your service."
 *   → "Hello Jayson! Adam has arrived for your Pest Control Re-Service."
 *
 * Adds the {service_type} placeholder (sendTechArrived now passes the
 * visit's service_type, falling back to "service") and registers it in the
 * template's allowed variables so admin edits keep validating.
 *
 * ADMIN-EDIT SAFETY: the body is only rewritten when it still matches the
 * 2026-08-01 house-voice sweep copy; a hand-edited body is left alone and
 * just gains the new allowed variable.
 */
const KEY = 'tech_arrived';
const OLD_BODY = 'Hello {first_name}! {tech_name} has arrived for your service.';
const NEW_BODY = 'Hello {first_name}! {tech_name} has arrived for your {service_type}.';

function parseVars(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const row = await knex('sms_templates').where({ template_key: KEY }).first();
  if (!row) return;
  const cols = await knex('sms_templates').columnInfo();
  const vars = parseVars(row.variables);
  const patch = {};
  if (!vars.includes('service_type')) patch.variables = JSON.stringify([...vars, 'service_type']);
  if (row.body === OLD_BODY) patch.body = NEW_BODY;
  if (!Object.keys(patch).length) return;
  if (cols.updated_at) patch.updated_at = new Date();
  await knex('sms_templates').where({ template_key: KEY }).update(patch);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const row = await knex('sms_templates').where({ template_key: KEY }).first();
  if (!row) return;
  const cols = await knex('sms_templates').columnInfo();
  const patch = {};
  // Only restore the body if it is still exactly the copy this migration wrote;
  // the placeholder must leave with it or the old sender would render an
  // unresolved {service_type} and drop the text.
  if (row.body === NEW_BODY) patch.body = OLD_BODY;
  const vars = parseVars(row.variables).filter((v) => v !== 'service_type');
  patch.variables = JSON.stringify(vars);
  if (cols.updated_at) patch.updated_at = new Date();
  await knex('sms_templates').where({ template_key: KEY }).update(patch);
};
