/**
 * Copy update, owner approval 2026-11-12: the job-application receipt text
 * must stop promising a reply "within 2 business days". The new wording says
 * Adam, the owner, reads every application himself and will call or text the
 * applicant directly if it looks like a fit. The receipt email changed in
 * server/services/recruiting-comms.js (buildEmailContent); this migration
 * moves the two receipt texts (English + Spanish) to match.
 *
 * The "before" body is the one 20261105000000_texts_say_waves left live: the
 * body 20260920000001 seeded, with "Waves Pest Control" -> "Waves". Texts say
 * "Waves" (owner 2026-11-04). The English "Reply STOP to opt out." (the
 * carrier keyword) stays on both. The Spanish text has no accented vowels on
 * purpose (GSM-7 character set; "ñ" is in it).
 *
 * ADMIN-EDIT SAFETY and CHANGED-ROW TRACKING (same contract as
 * 20261105000000_texts_say_waves): the swap runs against the base
 * `sms_templates` row AND any `sms_template_variants` row of the same key,
 * only where the body still equals its "before" text exactly, as a
 * compare-and-swap on the body read (an admin save landing in between wins).
 * Every row it changes gets one audit_log event under this migration's
 * action. down() reverts ONLY those tracked rows, and only while they still
 * carry the new body (an admin edit made since stays).
 */

const SEEDED = require('./20260920000001_job_applications_interview_comms')._TEMPLATES;

const MIGRATION = '20261112210000_job_receipt_matches_form';
const AUDIT_ACTION = 'sms_template.job_receipt_copy_tracked';
const AUDIT_ROLLBACK_ACTION = 'sms_template.job_receipt_copy_rolled_back';
const TABLES = ['sms_templates', 'sms_template_variants'];

const AFTER = {
  job_application_received: 'Hi {first_name}, thanks for applying to Waves. Adam, the owner, reads every application himself and will call or text you directly if it looks like a fit. Reply STOP to opt out.',
  job_application_received_es: 'Hola {first_name}, gracias por postularte a Waves. Adam, el dueño, lee cada solicitud personalmente y te llamara o enviara un mensaje directamente si parece una buena opcion. Reply STOP to opt out.',
};
const KEYS = Object.keys(AFTER);

// [template_key, body as 20261105000000 left it, new body]
const SWAPS = KEYS.map((key) => {
  const seeded = SEEDED.find((t) => t.template_key === key);
  if (!seeded || !seeded.body.includes('Waves Pest Control')) throw new Error(`${MIGRATION}: seeded body for ${key} not found`);
  return [key, seeded.body.replace('Waves Pest Control', 'Waves'), AFTER[key]];
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
