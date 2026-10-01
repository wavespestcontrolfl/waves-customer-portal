/**
 * appointment_rescheduled: register {window} on an office-edited template.
 *
 * 20260928070000 swapped the body and added 'window' to the variables list
 * only where the body was still the seeded one (exact-body CAS). A base row
 * whose wording the office had edited kept its old allowlist, and the admin
 * template and variant editors validate placeholders against that list — so
 * adopting {window} there would 400 "unknown placeholder". This adds
 * 'window' to the base row's variables whatever its body. The body itself
 * is never touched.
 */
const KEY = 'appointment_rescheduled';

function withWindow(variables) {
  let list = variables;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return variables; }
  }
  if (!Array.isArray(list) || list.includes('window')) return variables;
  return JSON.stringify([...list, 'window']);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  if (!(await knex.schema.hasColumn('sms_templates', 'variables'))) return;
  const rows = await knex('sms_templates').where({ template_key: KEY }).select('id', 'variables');
  for (const row of rows) {
    const next = withWindow(row.variables);
    if (next !== row.variables) {
      await knex('sms_templates').where({ id: row.id }).update({ variables: next, updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: a template may already use {window}.
};
exports._withWindow = withWindow;
