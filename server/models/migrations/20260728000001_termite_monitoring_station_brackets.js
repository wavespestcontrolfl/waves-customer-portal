/**
 * Termite station-check pricing: flat tiers → 5-station brackets
 * (owner 2026-07-28).
 *
 * Pricing is DB-authoritative: db-bridge loads pricing_config.termite_monitoring
 * over the constants, so the constants.js change in this PR is inert in prod
 * without this rewrite. The row moves from the retired flat shape
 * ({ basic: 35, premier: 65 } — Premier was never defined or sold) to:
 *
 *   { pricing_model: 'station_brackets',
 *     base_monthly: 19, step_monthly: 5, bracket_stations: 5 }
 *
 *   monthly = base + step × max(0, ceil(stations / bracket) − 2)
 *   ≤10 stations → $19 · 11-15 → $24 · 16-20 → $29 · 21-25 → $34 · …
 *
 * Anchor: a ~23-station home lands $34/mo gross — the market-standard
 * ~$29/mo a WaveGuard Gold member sees (competitive intel 2026-07-28).
 * Billed per application (monthly × 12 ÷ 4) as always. Trelona is now the
 * default/only-menu system at its label 15-ft spacing, so typical station
 * counts drop ~⅓ alongside this change; Advance stays priceable for
 * replaying old estimates.
 *
 * down() restores the audited pre-migration value only if the row still
 * carries this migration's shape untouched — an admin-tuned bracket
 * survives a rollback/re-apply cycle.
 */
const MIGRATION_TAG = 'migration:20260728000001';
const UP_REASON = 'Station-check pricing bracketed by station count (owner 2026-07-28; $19 base + $5 per 5 stations, Premier retired)';
const NEW_DATA = {
  pricing_model: 'station_brackets',
  base_monthly: 19,
  step_monthly: 5,
  bracket_stations: 5,
};
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-07-28',
  category: 'rule',
  summary: 'Termite station-check monthly bracketed by station count; Premier tier retired.',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: 'termite_monitoring' }).first();
  if (!row) {
    await knex('pricing_config').insert({
      config_key: 'termite_monitoring',
      name: 'Termite Station-Check Brackets',
      category: 'termite',
      sort_order: 2,
      data: JSON.stringify(NEW_DATA),
    });
    // Record ownership of the INSERT too (codex P2): a null old_value is
    // how down() knows this migration created the row and may delete it —
    // without the audit row, rollback stranded a bracket row the old
    // bridge ignores.
    if (await knex.schema.hasTable('pricing_config_audit')) {
      await knex('pricing_config_audit').insert({
        config_key: 'termite_monitoring',
        old_value: null,
        new_value: JSON.stringify(NEW_DATA),
        changed_by: MIGRATION_TAG,
        reason: UP_REASON,
      });
    }
    return;
  }
  const oldData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  if (oldData.pricing_model === 'station_brackets') return; // already migrated / admin-authored
  await knex('pricing_config')
    .where({ config_key: 'termite_monitoring' })
    .update({
      name: 'Termite Station-Check Brackets',
      data: JSON.stringify(NEW_DATA),
      updated_at: knex.fn.now(),
    });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'termite_monitoring',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(NEW_DATA),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['termite_bait', 'termite_monitoring']),
        before_value: JSON.stringify({ termite_monitoring: oldData }),
        after_value: JSON.stringify({ termite_monitoring: NEW_DATA }),
        rationale: 'Owner decision anchored to competitive rental-model intel: a ~23-station (≈224 LF at legacy 10-ft spacing) home was market-priced ~$29/mo AFTER WaveGuard Gold — i.e. $34/mo gross — while the flat tier charged $35/mo regardless of size. Brackets: ≤10 stations $19/mo, +$5 per further 5 stations, billed per application (×3). Premier ($65) retired — never defined, never sold. Ships alongside Trelona-only menu at label 15-ft spacing.',
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const audit = await knex('pricing_config_audit')
    .where({ config_key: 'termite_monitoring', changed_by: MIGRATION_TAG })
    .orderBy('id', 'desc')
    .first();
  if (!audit) return; // up() skipped (pre-migrated/admin-authored row) — nothing to undo
  const row = await knex('pricing_config').where({ config_key: 'termite_monitoring' }).first();
  if (!row) return;
  const current = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  // Undo ONLY if the row still holds exactly what up() wrote — an
  // admin-tuned bracket is not ours to roll back. Key-by-key comparison:
  // jsonb round-trips reorder keys, so a JSON.stringify equality check
  // false-negatives and silently skips the restore.
  const untouched = Object.keys(NEW_DATA).length === Object.keys(current).length
    && Object.entries(NEW_DATA).every(([k, v]) => String(current[k]) === String(v));
  if (!untouched) return;
  if (audit.old_value == null) {
    // up() CREATED the row (fresh env) — rollback removes it entirely so
    // the old code's admin UI doesn't show bracket settings the old bridge
    // ignores.
    await knex('pricing_config').where({ config_key: 'termite_monitoring' }).del();
    return;
  }
  await knex('pricing_config')
    .where({ config_key: 'termite_monitoring' })
    .update({
      name: 'Termite Monitoring Monthly',
      data: audit.old_value,
      updated_at: knex.fn.now(),
    });
};
