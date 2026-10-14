/**
 * Lead auto-reply asks: call or text? (owner 2026-10-14, "let's do B").
 *
 * The automatic call to Adam's cell on each web lead is turning off
 * (GATE_LEAD_ALERT_CALL, PR #6330); Adam still calls leads by hand. The
 * owner asked the first text to offer a text path too, and picked option B
 * from the Fable-advised list: the lead replies CALL or TEXT.
 *
 * Kept on purpose: "Reply STOP to opt out." (first text to a non-customer,
 * docs/sms-stop-line-policy.md), "Waves" once, no sign-off, GSM-7 only
 * (147 characters with a five-letter name: one segment). The opener
 * "Hello {first_name}, Waves here." is the owner's own wording on 10-14 and
 * overrides the 10-06 house opener for this template.
 *
 * "before" is the live production body read on 2026-10-14. Exact-body CAS
 * on sms_templates and sms_template_variants, same contract as
 * 20261006220000: a row an administrator has edited is left alone.
 */
const SWAPS = [
  [
    'lead_auto_reply_biz',
    "Hi {first_name}, it's Waves. We got your quote request and will call you shortly.\n\nReply STOP to opt out.",
    "Hello {first_name}, Waves here. We got your quote request. Reply CALL and we'll call you shortly, or TEXT to handle it right here.\n\nReply STOP to opt out.",
  ],
];

const MIGRATION = '20261014230000_lead_auto_reply_call_or_text';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  for (const table of tables) {
    const rows = await knex(table).whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
    for (const row of rows) {
      const { before, after } = swaps.get(row.template_key);
      if (row.body !== before) continue; // an admin edit already changed it — leave it alone
      // Exact-body CAS protects an administrator save racing this migration.
      const changed = await knex(table)
        .where({ id: row.id, body: before })
        .update({ body: after, updated_at: knex.fn.now() });
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.delivery_copy_updated',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: MIGRATION, template_key: row.template_key },
          critical: true, trx: knex,
        });
      }
    }
  }
};

exports.down = async function down(knex) {
  // Restores the old body only where this migration's exact text is still
  // live, so a later administrator edit is never overwritten.
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  for (const table of tables) {
    for (const [key, before, after] of SWAPS) {
      await knex(table).where({ template_key: key, body: after }).update({ body: before, updated_at: knex.fn.now() });
    }
  }
};

exports._SWAPS = SWAPS;
