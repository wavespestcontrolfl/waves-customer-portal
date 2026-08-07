/**
 * Bermuda-in-St.-Augustine suppression add-on — per-application adder knobs.
 *
 * Lawn pricing is DB-authoritative: db-bridge.syncConstantsFromDB deepMerges
 * `pricing_config.lawn_pricing_v2` over constants.LAWN_PRICING_V2, so the
 * constants.js default added in this PR is inert in any env carrying the row
 * unless the row gains the key too. Adds
 *   bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2 }
 * (adder = base + per1000 * turfSqft/1000, baked into the lawn per-app price;
 * owner ruling 2026-08-07 "a number baked into the per application").
 * Pricing only activates when GATE_BERMUDA_SUPPRESSION is on AND the
 * operator checks the estimate-builder box, so this data change is inert at
 * deploy time. Key-absent-only write preserves any admin edit.
 */
const MIGRATION_TAG = 'migration:20260808000002';
const UP_REASON = 'Bermuda suppression per-application adder knobs (owner ruling 2026-08-07: number baked into per application)';
const DEFAULT_KNOBS = { perAppBase: 15, perAppPer1000Sqft: 2 };
const CHANGELOG_IDENTITY = {
  // pricing_changelog.version_from/to are varchar(10) — the full
  // LAWN_PRICING_V2_GRID_500 tag lives in before/after_value instead
  // (pre-push codex P1: the long tag would fail the insert and block
  // the whole migration chain).
  version_from: 'GRID_500',
  version_to: 'GRID_500',
  changed_by: 'claude-2026-08-08',
  category: 'rule',
  summary: 'Add bermudagrass-suppression per-application adder knobs to lawn_pricing_v2.',
};

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // Migrations run transactionally; forUpdate locks the row for the
  // read-modify-write so a concurrent admin pricing edit can't commit
  // between the read and the replace and be overwritten by this stale
  // snapshot (codex P0).
  const row = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).forUpdate().first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'lawn_pricing_v2',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadRow(knex);
  // No row → fresh env prices from the in-code constants default; nothing to
  // sync. (db-bridge only overrides constants when the row exists.)
  if (!loaded) return;
  const { data } = loaded;
  // An existing bermudaSuppression key (prior admin edit) is left alone;
  // down() keys off the audit row this branch skips writing.
  if (data.bermudaSuppression && typeof data.bermudaSuppression === 'object') return;
  const newData = { ...data, bermudaSuppression: { ...DEFAULT_KNOBS } };
  await saveRow(knex, data, newData, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ bermudaSuppression: null }),
        after_value: JSON.stringify({ bermudaSuppression: DEFAULT_KNOBS }),
        rationale: 'New optional add-on, not a repricing: bermudagrass suppression in St. Augustine (Recognition + Fusilade II FL 2(ee) tank mix, max 2 applications per growing season) is sold as a per-application adder baked into the lawn per-app price — $15 base + $2 per 1,000 sqft of treated turf (a 5,000 sqft lawn shows +$25 per application). Applies only when the operator checks the estimate-builder box behind GATE_BERMUDA_SUPPRESSION; every existing quote path is unchanged.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only remove the key if this migration's up() created it — keyed off the
  // audit row — so a pre-existing admin-added knob object survives rollback.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'lawn_pricing_v2', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  const loaded = await loadRow(knex);
  if (loaded) {
    const { data } = loaded;
    // Remove ONLY the untouched default this migration wrote — an admin who
    // has since tuned the knobs keeps the edited object (rollbacks never
    // erase later operator edits). Compared semantically, not as strings:
    // jsonb round-trips don't preserve key order.
    const cur = data.bermudaSuppression;
    const untouchedDefault = cur && typeof cur === 'object' && !Array.isArray(cur)
      && Object.keys(cur).length === Object.keys(DEFAULT_KNOBS).length
      && Object.entries(DEFAULT_KNOBS).every(([k, v]) => Number(cur[k]) === v);
    if (untouchedDefault) {
      const newData = { ...data };
      delete newData.bermudaSuppression;
      await saveRow(knex, data, newData, 'Rollback: remove bermuda suppression adder knobs');
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
