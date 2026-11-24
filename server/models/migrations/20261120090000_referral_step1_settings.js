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
 * Every up() run writes ONE audit_log row naming the columns it changed, even
 * when it changed none. down() reverts only runs it has not rolled back yet
 * (each rollback writes a row naming its run), so an up/down/up/down cycle
 * never reaches back to an earlier run's columns, and only while a column
 * still carries the new value. audit_log.resource_id is a UUID and this row's
 * id is an integer, so the id goes in metadata.settings_id.
 */

const { randomUUID } = require('crypto');
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

async function audit(knex, action, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action, resource_type: TABLE,
    metadata: { migration: MIGRATION, settings_id: ROW_ID, ...metadata },
    critical: true, trx: knex,
  });
}

// This migration's run rows for one action: [{ run_id, columns }].
async function runRows(knex, action) {
  const rows = await knex('audit_log').where({ action, resource_type: TABLE }).select('metadata');
  return rows.map((row) => parseMeta(row.metadata)).filter((meta) => meta.migration === MIGRATION && meta.run_id);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const columns = [];
  for (const [column, before, after] of CHANGES) {
    if (!(await knex.schema.hasColumn(TABLE, column))) continue;
    const changed = await knex(TABLE)
      .where({ id: ROW_ID, [column]: before })
      .update({ [column]: after, updated_at: knex.fn.now() });
    if (changed) columns.push(column);
  }
  if (await knex.schema.hasTable('audit_log')) await audit(knex, AUDIT_ACTION, { run_id: randomUUID(), columns });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable(TABLE))) return;
  const byColumn = new Map(CHANGES.map(([column, before, after]) => [column, { before, after }]));
  const rolledBack = new Set((await runRows(knex, AUDIT_ROLLBACK_ACTION)).map((meta) => meta.run_id));
  for (const run of await runRows(knex, AUDIT_ACTION)) {
    if (rolledBack.has(run.run_id)) continue;
    const reverted = [];
    for (const column of Array.isArray(run.columns) ? run.columns : []) {
      const pair = byColumn.get(column);
      if (!pair) continue;
      const changed = await knex(TABLE)
        .where({ id: ROW_ID, [column]: pair.after })
        .update({ [column]: pair.before, updated_at: knex.fn.now() });
      if (changed) reverted.push(column);
    }
    await audit(knex, AUDIT_ROLLBACK_ACTION, { run_id: run.run_id, columns: reverted });
  }
};

exports._CHANGES = CHANGES;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ROLLBACK_ACTION = AUDIT_ROLLBACK_ACTION;
