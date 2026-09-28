/**
 * Supersedes 20260928050000_call_text_wording_any_hour, which is FROZEN —
 * it already ran on a PR preview database (knex tracks by filename; an
 * in-place edit to it would be a silent no-op there, see #3998 and the
 * pre-push applied-migration guard). This migration adds the two things
 * that PR's Codex round asked for without touching the frozen file:
 *
 *   (a) 050000 only swapped the base `sms_templates` row. A weighted
 *       ACTIVE `sms_template_variants` row (getTemplate/selectVariant,
 *       routes/admin-sms-templates.js) renders INSTEAD of the base body, so
 *       a stale variant would keep sending the old wording to whatever
 *       share of traffic it wins. This migration runs the identical
 *       exact-body CAS swap against `sms_template_variants` for the same
 *       two template keys.
 *   (b) Every row this lane's wording actually changed gets its own
 *       audit_log event, INCLUDING the two base `sms_templates` rows
 *       050000 already swapped (in every real deploy 050000 and this
 *       migration run in the same release, so by the time this migration's
 *       up() reads them their body already equals the NEW text) — that way
 *       admin history shows the deployed wording change for the base rows
 *       too, not just the variants this migration itself writes.
 *
 * CHANGED-ROW TRACKING (same contract as 20260906000010 / 20260725000002/-4
 * — not the no-op-down() template-copy migrations): every row named in (a)
 * or (b) above gets one audit_log event under THIS migration's own action.
 * `down()` reads back ONLY those events and reverts ONLY those exact rows
 * — a base `sms_templates` row included — each still gated on the row
 * still carrying the NEW body (an admin edit made since is left alone).
 * Body equality alone never selects a row to revert; the audit trail is
 * what says "this migration is tracking this row".
 *
 * ROLLBACK ORDER: knex rolls back the LATEST migration first, so this
 * migration's down() runs BEFORE 20260928050000's own down(). Because this
 * migration's tracked set includes the two base `sms_templates` rows and
 * reverts them back to the OLD body, by the time 050000's own
 * body-equality down() runs afterward it finds the body already reverted
 * (no longer equal to the NEW text it looks for) and correctly no-ops —
 * the two down()s never fight over the same row.
 */

const { _SWAPS: SWAPS } = require('./20260928050000_call_text_wording_any_hour');

const AUDIT_ACTION = 'sms_template.call_text_wording_variants_audit_tracked';
const AUDIT_ROLLBACK_ACTION = 'sms_template.call_text_wording_variants_audit_rolled_back';
const MIGRATION = '20260928060000_call_text_wording_variants_audit';
const VARIANT_TABLE = 'sms_template_variants';

function parseMeta(value) {
  if (value == null) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function recordTracked(knex, { table, id, templateKey, note }) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: AUDIT_ACTION,
    resource_type: table, resource_id: String(id),
    metadata: { migration: MIGRATION, template_key: templateKey, ...(note ? { note } : {}) },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));

  // (b) Base rows 20260928050000 already swapped in this same deploy — audit
  // only, no body write (050000 owns that write).
  if (hasAudit) {
    const baseRows = await knex('sms_templates').whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
    for (const row of baseRows) {
      const pair = swaps.get(row.template_key);
      if (!pair || row.body !== pair.after) continue; // 050000 hasn't run, or an admin edit changed it since
      await recordTracked(knex, {
        table: 'sms_templates', id: row.id, templateKey: row.template_key,
        note: 'records the 20260928050000 wording swap for admin history',
      });
    }
  }

  // (a) The matching variant, same exact-body CAS as 050000's base swap.
  if (!(await knex.schema.hasTable(VARIANT_TABLE))) return;
  const variantRows = await knex(VARIANT_TABLE).whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
  for (const row of variantRows) {
    const pair = swaps.get(row.template_key);
    if (!pair || row.body !== pair.before) continue; // missing, or an admin edit already changed it — leave it alone
    // Compare-and-swap on the body we read: an admin save landing between
    // the read and this update wins instead of being overwritten.
    const changed = await knex(VARIANT_TABLE)
      .where({ id: row.id, body: pair.before })
      .update({ body: pair.after, updated_at: knex.fn.now() });
    if (changed && hasAudit) {
      await recordTracked(knex, { table: VARIANT_TABLE, id: row.id, templateKey: row.template_key });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  const records = await knex('audit_log').where({ action: AUDIT_ACTION }).select('id', 'resource_type', 'resource_id', 'metadata');

  for (const record of records) {
    const meta = parseMeta(record.metadata);
    if (meta.migration !== MIGRATION) continue;
    const pair = swaps.get(meta.template_key);
    const table = record.resource_type;
    if (!pair || !table || !record.resource_id) continue;
    if (!(await knex.schema.hasTable(table))) continue;
    // Revert ONLY this exact tracked row, and only while it still carries
    // the NEW body — a later admin edit is left in place. This covers a
    // base sms_templates row 050000 (not this migration) originally wrote,
    // which is the point: see the ROLLBACK ORDER note above.
    const reverted = await knex(table)
      .where({ id: record.resource_id, body: pair.after })
      .update({ body: pair.before, updated_at: knex.fn.now() });
    if (reverted) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: AUDIT_ROLLBACK_ACTION,
        resource_type: table, resource_id: record.resource_id,
        metadata: { migration: MIGRATION, template_key: meta.template_key, from_audit_id: record.id },
        critical: true, trx: knex,
      });
    }
  }
};

exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ROLLBACK_ACTION = AUDIT_ROLLBACK_ACTION;
