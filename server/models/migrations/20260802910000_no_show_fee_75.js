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
  // Locking read (knex runs migrations in a transaction): an admin saving
  // this row through the pricing panel mid-deploy must serialize with the
  // whole-object write below, or their edit would be overwritten by this
  // read's stale snapshot.
  const row = await knex('pricing_config').where({ config_key: 'estimate_card_hold' }).forUpdate().first();
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
    // name/category are NOT NULL; shape mirrors the estimate_deposit seed
    // (20260612000003) so the Pricing Logic panel can re-tune it.
    await knex('pricing_config').insert({
      config_key: 'estimate_card_hold',
      name: 'One-Time Card Hold — No-Show Fee',
      category: 'global',
      data: JSON.stringify(newData),
      description: 'Flat no-show/late-cancel fee and free-cancel window for the one-time card-on-file rails (estimate card hold + /secure appointment card). Terms shown to a customer are frozen on their row at disclosure — changing this only affects future disclosures.',
      sort_order: 96,
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
  // audit row — and restore the EXACT recorded old_value: an
  // admin-configured $60 goes back to $60, and a row up() created
  // (old_value null) is deleted, never rewritten to a guessed $49.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'estimate_card_hold', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .orderBy('changed_at', 'desc')
    .first('id', 'old_value');
  if (!ownUp) return;
  const row = await knex('pricing_config').where({ config_key: 'estimate_card_hold' }).forUpdate().first();
  if (!row) return;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  if (Number(data.noShowFeeAmount) !== NEW_FEE) return; // admin moved it since — leave alone
  const priorData = ownUp.old_value ? JSON.parse(ownUp.old_value) : null;
  // What this rollback ACTUALLY leaves behind — recorded verbatim in the
  // audit row (null strictly means "row deleted", never "snapshot restored").
  let finalValue = null;
  if (priorData == null) {
    // up() created this row. Delete it ONLY while it still exactly matches
    // what up() wrote — an admin edit since (window change, added keys)
    // must survive rollback (P0 data-loss rule), so then we revert only
    // the fee to the pre-migration constant.
    const untouchedCreate = Object.keys(data).length === 2
      && Number(data.noShowFeeAmount) === NEW_FEE
      && Number(data.cancelWindowHours) === 24;
    if (untouchedCreate) {
      await knex('pricing_config').where({ config_key: 'estimate_card_hold' }).del();
      finalValue = null;
    } else {
      finalValue = { ...data, noShowFeeAmount: OLD_FEE };
      await knex('pricing_config')
        .where({ config_key: 'estimate_card_hold' })
        .update({ data: JSON.stringify(finalValue), updated_at: knex.fn.now() });
    }
  } else {
    // Restore ONLY the fee from the recorded snapshot — every other key
    // keeps its CURRENT value so admin edits made after deployment are
    // never overwritten by the old snapshot.
    const priorFee = Number(priorData.noShowFeeAmount);
    finalValue = { ...data, noShowFeeAmount: Number.isFinite(priorFee) && priorFee > 0 ? priorFee : OLD_FEE };
    await knex('pricing_config')
      .where({ config_key: 'estimate_card_hold' })
      .update({ data: JSON.stringify(finalValue), updated_at: knex.fn.now() });
  }
  await knex('pricing_config_audit').insert({
    config_key: 'estimate_card_hold',
    old_value: JSON.stringify(data),
    new_value: finalValue == null ? null : JSON.stringify(finalValue),
    changed_by: MIGRATION_TAG,
    reason: 'Rollback: no-show/late-cancel fee $75 reverted (fee-only restore; row deleted only when still exactly as created)',
  });
  // The changelog row must not keep reporting a reverted change as current
  // (and a later re-up must record its own fresh entry, not reuse this one).
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
