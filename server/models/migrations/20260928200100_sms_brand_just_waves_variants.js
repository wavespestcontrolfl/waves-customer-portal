/**
 * Say "Waves" once per text — SMS template VARIANTS (owner rulings 2026-09-28).
 *
 * 20260928200000_sms_brand_just_waves rewrote only the base sms_templates
 * rows, but getTemplate renders a selected sms_template_variants row INSTEAD
 * of the base row, so a variant still holding one of those "before" bodies
 * would keep sending the old unbranded / "Waves Pest Control" / "Adam" copy.
 * Same 26 swaps, same exact-body CAS: a variant an administrator has edited
 * is left alone, and down() only restores a body this migration set.
 */
const { _SWAPS: SWAPS } = require('./20260928200000_sms_brand_just_waves');

const MIGRATION = '20260928200100_sms_brand_just_waves_variants';
const TABLE = 'sms_template_variants';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  const rows = await knex(TABLE).whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
  for (const row of rows) {
    const { before, after } = swaps.get(row.template_key);
    if (row.body !== before) continue; // an admin edit already changed it — leave it alone
    // Compare-and-swap on the body we read: an admin save landing between
    // the read and this update wins instead of being overwritten.
    const changed = await knex(TABLE)
      .where({ id: row.id, body: before })
      .update({ body: after, updated_at: knex.fn.now() });
    if (changed && hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: 'sms_template.delivery_copy_updated',
        resource_type: TABLE, resource_id: String(row.id),
        metadata: { migration: MIGRATION, template_key: row.template_key },
        critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  const rows = await knex(TABLE).whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
  for (const row of rows) {
    const { before, after } = swaps.get(row.template_key);
    if (row.body !== after) continue; // not this migration's own value — never touch a later admin edit
    await knex(TABLE)
      .where({ id: row.id, body: after })
      .update({ body: before, updated_at: knex.fn.now() });
  }
};
