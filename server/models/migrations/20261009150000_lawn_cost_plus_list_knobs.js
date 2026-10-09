/**
 * Lawn cost-plus list price — knobs on the production lawn_pricing_v2 row.
 *
 * Lawn pricing is DB-authoritative: db-bridge.syncConstantsFromDB deepMerges
 * `pricing_config.lawn_pricing_v2` over constants.LAWN_PRICING_V2, so the
 * in-code default added with GATE_LAWN_COST_PLUS_LIST (owner 2026-10-09) is
 * only editable through the admin Pricing Logic panel once the row carries the
 * key. Adds
 *   costPlusList: { listMargin, minimumPerVisit, spotMinutesPerVisit,
 *                   materialPer1000SqftPerYear: { 6, 9, 12 } }
 * Inert at deploy time: nothing reads it until GATE_LAWN_COST_PLUS_LIST is on.
 * Key-absent-only write preserves every existing key and any admin edit.
 */
const MIGRATION_TAG = 'migration:20261009150000';
const UP_REASON = 'Lawn cost-plus list price knobs (owner 2026-10-09; GATE_LAWN_COST_PLUS_LIST)';
const DEFAULT_KNOBS = {
  listMargin: 0.45,
  minimumPerVisit: 55,
  spotMinutesPerVisit: 10,
  materialPer1000SqftPerYear: { 6: 16.33, 9: 24.5, 12: 29.84 },
};
const CHANGELOG_IDENTITY = {
  // pricing_changelog.version_from/to are varchar(10).
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-10-09',
  category: 'rule',
  summary: 'Add cost-plus list price knobs to lawn_pricing_v2 (dark behind GATE_LAWN_COST_PLUS_LIST).',
};

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // forUpdate locks the row for the read-modify-write so a concurrent admin
  // pricing edit cannot commit between the read and the replace.
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
  // No row: a fresh env prices from the in-code default.
  if (!loaded) return;
  const { data } = loaded;
  // An existing costPlusList key (prior admin edit) is left alone; down()
  // keys off the audit row this branch skips writing.
  if (data.costPlusList && typeof data.costPlusList === 'object') return;
  const newData = { ...data, costPlusList: JSON.parse(JSON.stringify(DEFAULT_KNOBS)) };
  await saveRow(knex, data, newData, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ costPlusList: null }),
        after_value: JSON.stringify({ costPlusList: DEFAULT_KNOBS }),
        rationale: 'Not a repricing: seeds the knobs for the dark cost-plus list price (45% list margin, $55 per visit minimum, 10 spot-work minutes a visit, v13 product cost per 1,000 sq ft a year). Nothing reads them until GATE_LAWN_COST_PLUS_LIST is on; every existing quote path is unchanged.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only remove the key if this migration's up() created it (keyed off the
  // audit row), so a pre-existing admin-added object survives rollback.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'lawn_pricing_v2', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  const loaded = await loadRow(knex);
  if (loaded) {
    const { data } = loaded;
    // Remove ONLY the untouched seeded value; an admin who has since tuned
    // the knobs keeps the edited object. Compared semantically: jsonb
    // round-trips do not preserve key order.
    const cur = data.costPlusList;
    const untouched = cur && typeof cur === 'object' && !Array.isArray(cur)
      && ['listMargin', 'minimumPerVisit', 'spotMinutesPerVisit'].every((k) => Number(cur[k]) === DEFAULT_KNOBS[k])
      && Object.keys(cur).length === Object.keys(DEFAULT_KNOBS).length
      && cur.materialPer1000SqftPerYear && typeof cur.materialPer1000SqftPerYear === 'object'
      && Object.keys(cur.materialPer1000SqftPerYear).length === Object.keys(DEFAULT_KNOBS.materialPer1000SqftPerYear).length
      && Object.entries(DEFAULT_KNOBS.materialPer1000SqftPerYear)
        .every(([k, v]) => Number(cur.materialPer1000SqftPerYear[k]) === v);
    if (untouched) {
      const newData = { ...data };
      delete newData.costPlusList;
      await saveRow(knex, data, newData, 'Rollback: remove lawn cost-plus list price knobs');
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
