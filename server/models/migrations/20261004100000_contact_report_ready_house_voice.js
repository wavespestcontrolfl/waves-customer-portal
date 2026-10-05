/**
 * contact_report_ready in the house voice (owner 2026-10-04: "just use
 * Waves, and keep on brand"). Same shape as the account holder's
 * service_report_v1 text: "Hello {first_name}!", "Waves", the report link,
 * and the standard closing line. {first_name} is the CONTACT's first name.
 *
 * 1. Exact-body compare-and-swap on sms_templates and sms_template_variants
 *    (getTemplate picks an active variant over the base row): only the
 *    wording seeded by 20261003150000 is replaced; a body an administrator
 *    edited is left alone.
 * 2. Every contact_report_ready base row gains first_name in its variable
 *    allowlist, edited body or not: the template editor validates a body and
 *    its variants against that list, and the runtime supplies first_name
 *    either way.
 *
 * One audit_log event per changed row (waves-db rule for admin-editable
 * rows), with the before and after.
 *
 * down: documented no-op. Matching the new body does not prove this
 * migration wrote it, and narrowing the allowlist again would make a variant
 * that now uses {first_name} unsaveable. The audit events keep the before
 * and after.
 */
const MIGRATION = '20261004100000_contact_report_ready_house_voice';
const TEMPLATE_KEY = 'contact_report_ready';
const SEEDED_BODY = 'Waves Pest Control: The service report for {street_address} is ready: {report_url}';
// GSM-7 only; no STOP line on a transactional text (docs/sms-stop-line-policy.md).
const BODY = 'Hello {first_name}! The Waves service report for {street_address} is ready: {report_url}\n\nQuestions or requests? Reply here.';
const VARIABLES = ['first_name', 'street_address', 'report_url'];

function parseVariables(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const audit = async (table, id, metadata) => {
    if (!hasAudit) return;
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'sms_template.contact_report_house_voice',
      resource_type: table, resource_id: String(id),
      metadata: { migration: MIGRATION, template_key: TEMPLATE_KEY, ...metadata },
      critical: true, trx: knex,
    });
  };

  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    const rows = await knex(table).where({ template_key: TEMPLATE_KEY, body: SEEDED_BODY }).select('id');
    for (const row of rows) {
      const changed = await knex(table).where({ id: row.id, body: SEEDED_BODY }).update({ body: BODY, updated_at: knex.fn.now() });
      if (changed) await audit(table, row.id, { before: SEEDED_BODY, after: BODY });
    }
  }

  const baseRows = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).select('id', 'variables');
  for (const row of baseRows) {
    const before = parseVariables(row.variables);
    const after = [...new Set([...VARIABLES, ...before])];
    if (after.length === before.length) continue;
    await knex('sms_templates').where({ id: row.id }).update({ variables: JSON.stringify(after), updated_at: knex.fn.now() });
    await audit('sms_templates', row.id, { variables_before: before, variables_after: after });
  }
};

exports.down = async function down() {
  // No-op (see the header).
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.BODY = BODY;
exports.VARIABLES = VARIABLES;
exports.SEEDED_BODY = SEEDED_BODY;
