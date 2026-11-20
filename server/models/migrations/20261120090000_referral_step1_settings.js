/**
 * Referral program Step 1 (owner 2026-11-20, "do whatever you recommend" on
 * the Friends & Neighbors plan: A1 B1 C1). Two settings fixes on the single
 * referral_program_settings row (id 1):
 *
 * 1. invite_sms_template: the referral engine prefers this column over the
 *    sms_templates row whenever it is non-null (referral-engine.js
 *    renderReferralSms), so the 2026-11-04 "texts say Waves" ruling never
 *    reached it. Live text (prod read 2026-11-20) is exactly what
 *    20260801000001_sms_house_voice_sweep wrote; swap "Waves Pest Control"
 *    -> "Waves" and nothing else.
 * 2. bonus_silver/gold/platinum_cents: convertReferral adds these to the
 *    promoter ledger (pending + total_earned), but the real account credit is
 *    the flat referrer reward (creditReferralOnFirstService). The portal
 *    therefore shows "earned" money that is never paid. Set them to 0 so the
 *    ledger matches what members really get.
 *
 * ADMIN-EDIT SAFETY: each column changes only while it still holds the
 * expected value, as a compare-and-swap (an admin save in between wins).
 * Every changed column gets one audit_log event; down() reverts ONLY tracked
 * columns, and only while they still carry the new value.
 */

const SWEEP = require('./20260801000001_sms_house_voice_sweep');

const MIGRATION = '20261120090000_referral_step1_settings';
const AUDIT_ACTION = 'referral_settings.step1_tracked';
const AUDIT_ROLLBACK_ACTION = 'referral_settings.step1_rolled_back';
const TABLE = 'referral_program_settings';
const ROW_ID = 1;

const inviteSwept = SWEEP.LEGACY_REFERRAL_REWRITES.find(([column]) => column === 'invite_sms_template');
if (!inviteSwept || !inviteSwept[2].includes('Waves Pest Control')) {
  throw new Error(`${MIGRATION}: swept invite text not found`);
}

// [column, expected current value, new value]
const CHANGES = [
  ['invite_sms_template', inviteSwept[2], inviteSwept[2].replace('Waves Pest Control', 'Waves')],
  ['bonus_silver_cents', 5000, 0],
  ['bonus_gold_cents', 7500, 0],
  ['bonus_platinum_cents', 10000, 0],
];

function parseMeta(value) {
  if (value == null) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function audit(knex, action, { column, extra = {} }) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: TABLE, resource_id: String(ROW_ID),
    metadata: { migration: MIGRATION, column, ...extra },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  for (const [column, before, after] of CHANGES) {
    if (!(await knex.schema.hasColumn(TABLE, column))) continue;
    const changed = await knex(TABLE)
      .where({ id: ROW_ID, [column]: before })
      .update({ [column]: after, updated_at: knex.fn.now() });
    if (changed && hasAudit) await audit(knex, AUDIT_ACTION, { column });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable(TABLE))) return;
  const byColumn = new Map(CHANGES.map(([column, before, after]) => [column, { before, after }]));
  const records = await knex('audit_log').where({ action: AUDIT_ACTION }).select('id', 'resource_type', 'metadata');
  for (const record of records) {
    const meta = parseMeta(record.metadata);
    const pair = byColumn.get(meta.column);
    if (meta.migration !== MIGRATION || record.resource_type !== TABLE || !pair) continue;
    const reverted = await knex(TABLE)
      .where({ id: ROW_ID, [meta.column]: pair.after })
      .update({ [meta.column]: pair.before, updated_at: knex.fn.now() });
    if (reverted) await audit(knex, AUDIT_ROLLBACK_ACTION, { column: meta.column, extra: { from_audit_id: record.id } });
  }
};

exports._CHANGES = CHANGES;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ROLLBACK_ACTION = AUDIT_ROLLBACK_ACTION;
