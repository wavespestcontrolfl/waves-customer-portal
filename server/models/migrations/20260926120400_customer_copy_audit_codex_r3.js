/**
 * Customer copy audit — Codex round-3 correction (PR #4874).
 *
 * 20260926120000 is frozen (it ran on the PR preview database). Its
 * service_request_confirmation rewrite promised to "get back to you within
 * {response_time}". The contract in 20260808020000 is narrower: the EOD
 * unworked-comms digest enforces only the REVIEW window, and there is no
 * assignment or follow-up flow with a deadline. The time now attaches to the
 * review again and the follow-up stays unbounded.
 *
 * Exact-body CAS on the base row and each variant, as in 120000: an
 * administrator's wording is left alone.
 */
const SWAPS = [
  [
    'service_request_confirmation',
    "Hello {first_name}! Waves got your {category} request. We'll review it and get back to you within {response_time}.",
    "Hello {first_name}! Waves got your {category} request. We'll review it within {response_time} and follow up once we have.",
  ],
];

const MIGRATION = '20260926120400_customer_copy_audit_codex_r3';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const [key, before, after] of SWAPS) {
    for (const table of tables) {
      const rows = await knex(table).where({ template_key: key, body: before }).select('id');
      for (const { id } of rows) {
        const changed = await knex(table).where({ id, body: before }).update({ body: after, updated_at: knex.fn.now() });
        if (changed && hasAudit) {
          const { recordAuditEvent } = require('../../services/audit-log');
          await recordAuditEvent({
            actor_type: 'system', action: 'sms_template.delivery_copy_updated',
            resource_type: table, resource_id: String(id),
            metadata: { migration: MIGRATION, template_key: key },
            critical: true, trx: knex,
          });
        }
      }
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: reverting seeded copy would erase later admin edits.
};
exports._SWAPS = SWAPS;
