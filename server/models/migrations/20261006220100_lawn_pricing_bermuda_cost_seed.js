/**
 * Seeds lawn_pricing_v2.bermudaSuppression.cost on a pricing_config row that predates it
 * (GATE_LAWN_BERMUDA_REMOVAL, owner 2026-10-06). The cost of the bermuda removal step
 * ($2.82 + $1.61 + $0.07 per 1,000 sq ft, 10 + 2.5 minutes per 1,000 sq ft) is read from
 * this key at call time; without it the engine uses the same numbers as in-code defaults,
 * but an admin looking at the lawn pricing row would find no key to edit. The values below
 * are the code defaults (constants.js BERMUDA_SUPPRESSION_COST_DEFAULTS), copied here so a
 * later change to the code never changes what this migration writes.
 *
 * Read-modify-write under the row lock, deep-merged: every other key (tiers, brackets,
 * perApp knobs, admin edits) is preserved, and `bermudaSuppression.cost` is written ONLY
 * when absent: an admin's own cost block is left alone. No row, nothing to do. Writes the
 * standard pricing_config_audit and pricing_changelog entries. down() removes the cost key
 * only while it still equals the defaults (an edited block stays).
 */
const MIGRATION_TAG = 'migration:20261006220100';
const KEY = 'lawn_pricing_v2';
const DEFAULT_COST = { recognitionPer1000: 2.82, fusiladePer1000: 1.61, surfactantPer1000: 0.07, mixMinutes: 10, minutesPer1000: 2.5 };
const UP_REASON = 'Seed lawn_pricing_v2.bermudaSuppression.cost with the code defaults (bermuda removal step cost, owner 2026-10-06)';
const DOWN_REASON = 'Remove the seeded lawn_pricing_v2.bermudaSuppression.cost (still the defaults)';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.7',
  version_to: 'v4.7',
  changed_by: 'claude-2026-10-06',
  category: 'cost',
  summary: 'Lawn bermuda removal step cost seeded into lawn_pricing_v2 (code defaults, DB-tunable).',
};

const sameCost = (a, b) => !!a && typeof a === 'object' && Object.keys(DEFAULT_COST).every((key) => Number(a[key]) === b[key])
  && Object.keys(a).length === Object.keys(DEFAULT_COST).length;

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // forUpdate: the admin pricing writer locks this row for its own read-modify-write.
  const row = await knex('pricing_config').where({ config_key: KEY }).forUpdate().first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const data = await loadRow(knex);
  if (!data) return;
  const bermuda = data.bermudaSuppression && typeof data.bermudaSuppression === 'object' ? data.bermudaSuppression : null;
  if (bermuda && bermuda.cost !== undefined) return;
  await saveRow(knex, data, { ...data, bermudaSuppression: { ...(bermuda || {}), cost: { ...DEFAULT_COST } } }, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawn_pricing_v2: { bermudaSuppression: { cost: null } } }),
        after_value: JSON.stringify({ lawn_pricing_v2: { bermudaSuppression: { cost: DEFAULT_COST } } }),
        rationale: 'Owner 2026-10-06: the bermuda removal step costs $2.82 + $1.61 + $0.07 per 1,000 sq ft of material plus 10 + 2.5 minutes per 1,000 sq ft of labor per spray. The values are the code defaults; the row now carries them so an admin can edit them without a deploy.',
      });
    }
  }
};

exports.down = async function down(knex) {
  const data = await loadRow(knex);
  const cost = data?.bermudaSuppression?.cost;
  if (!sameCost(cost, DEFAULT_COST)) return;
  const { cost: _removed, ...rest } = data.bermudaSuppression;
  await saveRow(knex, data, { ...data, bermudaSuppression: rest }, DOWN_REASON);
};

exports.DEFAULT_COST = DEFAULT_COST;
