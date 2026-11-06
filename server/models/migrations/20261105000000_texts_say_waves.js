/**
 * Copy update, owner ruling 2026-11-04: "for all texts, instead of it's Waves
 * Pest Control., just use waves". The live SMS templates already name the
 * company "Waves" ("it's Waves", "your Waves invoice"); the four recruiting
 * texts seeded by 20260920000001_job_applications_interview_comms are the
 * only ones that still say "Waves Pest Control" (prod read 2026-11-04: 5 of
 * 170 templates; the fifth, recipient_optin_request, is the opt-in consent
 * request and keeps the full name, like the STOP / START / HELP replies).
 *
 * Each swap is "Waves Pest Control" -> "Waves" and nothing else: the
 * placeholders and the English "Reply STOP to opt out." (the carrier
 * keyword, kept in English on the Spanish text) stay as they are.
 *
 * ADMIN-EDIT SAFETY and CHANGED-ROW TRACKING (same contract as
 * 20260928050000 + 20260928060000, in one file): the swap runs against the
 * base `sms_templates` row AND any `sms_template_variants` row of the same
 * key (an active variant renders instead of the base body), only where the
 * body still equals its seeded text exactly, as a compare-and-swap on the
 * body read (an admin save landing in between wins). Every row it changes
 * gets one audit_log event under this migration's action. down() reverts
 * ONLY those tracked rows, and only while they still carry the new body (an
 * admin edit made since stays).
 */

const SEEDED = require('./20260920000001_job_applications_interview_comms')._TEMPLATES;

const MIGRATION = '20261105000000_texts_say_waves';
const AUDIT_ACTION = 'sms_template.texts_say_waves_tracked';
const AUDIT_ROLLBACK_ACTION = 'sms_template.texts_say_waves_rolled_back';
const KEYS = ['job_application_received', 'job_application_received_es', 'job_interview_invite', 'job_interview_invite_es'];
const TABLES = ['sms_templates', 'sms_template_variants'];

// [template_key, body as 20260920000001 seeded it, new body]
const SWAPS = KEYS.map((key) => {
  const seeded = SEEDED.find((t) => t.template_key === key);
  if (!seeded || !seeded.body.includes('Waves Pest Control')) throw new Error(`${MIGRATION}: seeded body for ${key} not found`);
  return [key, seeded.body, seeded.body.replace('Waves Pest Control', 'Waves')];
});

function parseMeta(value) {
  if (value == null) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function audit(knex, action, { table, id, templateKey, extra = {} }) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: table, resource_id: String(id),
    metadata: { migration: MIGRATION, template_key: templateKey, ...extra },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const rows = await knex(table).whereIn('template_key', KEYS).select('id', 'template_key', 'body');
    for (const row of rows) {
      const pair = swaps.get(row.template_key);
      if (!pair || row.body !== pair.before) continue; // an admin edit changed it: leave it alone
      const changed = await knex(table).where({ id: row.id, body: pair.before }).update({ body: pair.after, updated_at: knex.fn.now() });
      if (changed && hasAudit) await audit(knex, AUDIT_ACTION, { table, id: row.id, templateKey: row.template_key });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  const records = await knex('audit_log').where({ action: AUDIT_ACTION }).select('id', 'resource_type', 'resource_id', 'metadata');
  for (const record of records) {
    const meta = parseMeta(record.metadata);
    const pair = swaps.get(meta.template_key);
    const table = record.resource_type;
    if (meta.migration !== MIGRATION || !pair || !TABLES.includes(table) || !record.resource_id) continue;
    if (!(await knex.schema.hasTable(table))) continue;
    const reverted = await knex(table).where({ id: record.resource_id, body: pair.after }).update({ body: pair.before, updated_at: knex.fn.now() });
    if (reverted) await audit(knex, AUDIT_ROLLBACK_ACTION, { table, id: record.resource_id, templateKey: meta.template_key, extra: { from_audit_id: record.id } });
  }
};

exports._SWAPS = SWAPS;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ROLLBACK_ACTION = AUDIT_ROLLBACK_ACTION;
