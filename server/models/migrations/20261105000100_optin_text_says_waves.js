/**
 * Follow-up to 20261105000000_texts_say_waves (FROZEN: pushed, so its preview
 * DB already ran it), owner 2026-11-04 "change": the consent and carrier
 * texts say "Waves" too. This one swaps the opt-in request,
 * recipient_optin_request: "service texts from Waves Pest Control for
 * {property_address}" -> "service texts from Waves for {property_address}".
 * The rest of the body (placeholders, "Reply YES to confirm, STOP to opt out,
 * HELP for help. Msg frequency varies. Msg & data rates may apply.") stays.
 * The STOP / START / HELP replies are code (twilio-webhook.js,
 * messaging/opt-out-detector.js) and change in the same PR.
 *
 * BEFORE is the body every prior migration leaves (20260730000020's audit pass
 * wrote it; the later sweeps keep it): checked equal on a fresh db:migrate of
 * every migration and on prod, 2026-11-04 (seeded 2026-07-30, no admin edit,
 * no sms_template_variants row).
 *
 * Same contract as 20261105000000: exact-body CAS on the base row and any
 * matching variant (an admin edit is left alone), one audit_log event per
 * changed row, and down() reverts only tracked rows still carrying the new
 * body.
 */

const MIGRATION = '20261105000100_optin_text_says_waves';
const AUDIT_ACTION = 'sms_template.optin_text_says_waves_tracked';
const AUDIT_ROLLBACK_ACTION = 'sms_template.optin_text_says_waves_rolled_back';
const KEY = 'recipient_optin_request';
const TABLES = ['sms_templates', 'sms_template_variants'];
const BEFORE = 'Hello {recipient_first_name}! {account_first_name} added you to receive appointment and service texts from Waves Pest Control for {property_address}.\n\nReply YES to confirm, STOP to opt out, HELP for help. Msg frequency varies. Msg & data rates may apply.';
const AFTER = BEFORE.replace('Waves Pest Control', 'Waves');

function parseMeta(value) {
  if (value == null) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function audit(knex, action, { table, id, extra = {} }) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: table, resource_id: String(id),
    metadata: { migration: MIGRATION, template_key: KEY, ...extra },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const rows = await knex(table).where({ template_key: KEY }).select('id', 'body');
    for (const row of rows) {
      if (row.body !== BEFORE) continue; // an admin edit changed it: leave it alone
      const changed = await knex(table).where({ id: row.id, body: BEFORE }).update({ body: AFTER, updated_at: knex.fn.now() });
      if (changed && hasAudit) await audit(knex, AUDIT_ACTION, { table, id: row.id });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const records = await knex('audit_log').where({ action: AUDIT_ACTION }).select('id', 'resource_type', 'resource_id', 'metadata');
  for (const record of records) {
    const table = record.resource_type;
    if (parseMeta(record.metadata).migration !== MIGRATION || !TABLES.includes(table) || !record.resource_id) continue;
    if (!(await knex.schema.hasTable(table))) continue;
    const reverted = await knex(table).where({ id: record.resource_id, body: AFTER }).update({ body: BEFORE, updated_at: knex.fn.now() });
    if (reverted) await audit(knex, AUDIT_ROLLBACK_ACTION, { table, id: record.resource_id, extra: { from_audit_id: record.id } });
  }
};

exports._KEY = KEY;
exports._BEFORE = BEFORE;
exports._AFTER = AFTER;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ROLLBACK_ACTION = AUDIT_ROLLBACK_ACTION;
