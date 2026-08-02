/**
 * No-show / late-cancel fee: $49 → $75 (owner ruling 2026-08-01, PR #3153
 * follow-through — flat $75 for BOTH the estimate card-hold rail and the
 * /secure appointment-card rail; both read the shared `estimate_card_hold`
 * pricing_config key).
 *
 * Pricing is DB-authoritative: db-bridge.syncConstantsFromDB loads
 * `pricing_config.estimate_card_hold` over constants.CARD_HOLD, so the
 * constants.js change in this PR is inert in prod unless the row moves too.
 * Read-modify-write preserves any admin edits to other keys (the cancel
 * window stays untouched); inserts the row when absent so the value is
 * durable and admin-editable. Fees already frozen on existing holds/requests
 * are NOT touched — consented terms never move (the rails enforce ≤ the
 * disclosed amount).
 */
const NEW_FEE = 75;
const OLD_FEE = 49;
const MIGRATION_TAG = 'migration:20260802910000';
const UP_REASON = 'No-show/late-cancel fee $49 -> $75 (owner ruling 2026-08-01; PR #3153 follow-through)';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.2',
  version_to: 'v4.2',
  changed_by: 'claude-2026-08-02',
  category: 'cost',
  summary: 'Flat no-show/late-cancel fee raised $49 -> $75 (card-hold + appointment-card rails).',
};

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: 'estimate_card_hold' }).first();
  const oldData = row ? (typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {})) : null;
  // An admin already at (or past) $75 is left alone; down() keys off the
  // audit row this branch skips writing.
  if (oldData && Number(oldData.noShowFeeAmount) >= NEW_FEE) return;
  const newData = row
    ? { ...oldData, noShowFeeAmount: NEW_FEE }
    : { noShowFeeAmount: NEW_FEE, cancelWindowHours: 24 };
  if (row) {
    await knex('pricing_config')
      .where({ config_key: 'estimate_card_hold' })
      .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  } else {
    await knex('pricing_config').insert({
      config_key: 'estimate_card_hold',
      data: JSON.stringify(newData),
    });
  }
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'estimate_card_hold',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['pest_control', 'lawn_care', 'one_time']),
        before_value: JSON.stringify({ estimate_card_hold: oldData }),
        after_value: JSON.stringify({ estimate_card_hold: newData }),
        rationale: 'Owner ruling 2026-08-01: flat $75 for both no-show and late-cancel, deposit idea dropped. Shared estimate_card_hold key moves the card-hold rail and the /secure appointment-card fee rail together. Already-consented holds/requests keep their frozen $49 — disclosure stamps are monotonic-down and never raised.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only revert if this migration's up() made the change — keyed off the
  // audit row — so an admin's own later edit survives rollback.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'estimate_card_hold', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;
  const row = await knex('pricing_config').where({ config_key: 'estimate_card_hold' }).first();
  if (!row) return;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  if (Number(data.noShowFeeAmount) !== NEW_FEE) return; // admin moved it since — leave alone
  const reverted = { ...data, noShowFeeAmount: OLD_FEE };
  await knex('pricing_config')
    .where({ config_key: 'estimate_card_hold' })
    .update({ data: JSON.stringify(reverted), updated_at: knex.fn.now() });
  await knex('pricing_config_audit').insert({
    config_key: 'estimate_card_hold',
    old_value: JSON.stringify(data),
    new_value: JSON.stringify(reverted),
    changed_by: MIGRATION_TAG,
    reason: 'Rollback: no-show/late-cancel fee $75 -> $49',
  });
};
