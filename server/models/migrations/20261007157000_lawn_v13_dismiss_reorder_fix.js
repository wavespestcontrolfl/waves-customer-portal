/**
 * Lawn protocol v13, Dismiss reorder fix (Codex round 3 on #6098). 20261007150000
 * and 20261007155000 are pushed and frozen; this one corrects how 155000 rolls
 * back.
 *
 * 155000 switched automatic reorder off for the retired Dismiss 64 oz product and
 * its down() switched it back on wherever the row still read off. Dismiss is
 * retired ("use up the jug, do not reorder"), so a rollback must never re-enable
 * its reorder, and must never undo an edit made after the migration. This
 * migration takes the reorder switch out of 155000's audit rows
 * (action 'v13_field_rules_followup', after_snapshot.autoReorderEnabled false ->
 * null, kept as keptOff true), so 155000.down() restores nothing for it. Its other
 * rollback work (gates of referenced protocols, deleting its audit rows) is
 * unchanged. The cancelled restock requests were never reopened.
 *
 * It runs the neutralization in up() too (idempotent), so the protection holds
 * for any rollback path. It reads and writes lawn_protocol_audit_log only: no
 * products_catalog or product_restock_requests lock, so it cannot take part in a
 * lock-order cycle with the procurement dispatcher (claimRequest locks the pricing
 * advisory lock, then the ledger row, the request row, the product row).
 *
 * down() neutralizes the same rows (it runs before 155000.down()) and changes
 * nothing else.
 */

const FOLLOWUP_ACTION = 'v13_field_rules_followup';

const parse = (value, fallback) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : fallback;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

async function keepReorderOff(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: FOLLOWUP_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = parse(log.after_snapshot, {});
    if (after.autoReorderEnabled !== false) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id })
      .update({ after_snapshot: JSON.stringify({ ...after, autoReorderEnabled: null, keptOff: true }) });
  }
}

exports.up = keepReorderOff;
exports.down = keepReorderOff;
