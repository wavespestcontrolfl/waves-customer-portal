/**
 * Seed ts_material_rates.fallback_bed_sqft for the Tree & Shrub no-bed-signal
 * fallback (owner ruling 2026-10-05: a quote with no typed bed area and no lot
 * to infer one from prices a 1,200 sqft bed, not 2,000; it stays LOW
 * confidence and in the review lane).
 *
 * The value is DB-authoritative like the other T&S knobs: db-bridge
 * syncConstantsFromDB maps it onto TREE_SHRUB.fallbackBedSqFt (100-20000;
 * 1200 stays the in-code default when the key is absent). Quotes already
 * sent are unaffected: they replay the size stamped into their
 * pricingKnobs.fallbackBedSqFt, and a line with no stamp replays 2,000.
 *
 * Read-modify-write under the row lock like 20260926004100: admin edits to
 * the row's other keys survive, and a key already present is left alone.
 */
const MIGRATION_TAG = 'migration:20261006130000';
const SEEDED_SQFT = 1200;
const UP_REASON = 'Seed fallback_bed_sqft 1200: a T&S quote with no bed area prices a 1,200 sqft bed (owner ruling 2026-10-05; was 2,000)';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.7',
  version_to: 'v4.7',
  changed_by: 'claude-2026-10-06',
  category: 'cost',
  summary: 'T&S no-bed-signal fallback bed size 2,000 -> 1,200 sqft (still manual review).',
};

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // forUpdate: the admin pricing writer locks this row for its own
  // read-modify-write, so an edit committed between this SELECT and the
  // whole-JSON UPDATE below cannot be overwritten.
  const row = await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .forUpdate()
    .first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'ts_material_rates',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  // An existing value (an admin edit) is left alone; down() keys off the
  // audit row this branch then never writes.
  if (data.fallback_bed_sqft !== undefined) return;
  await saveRow(knex, data, { ...data, fallback_bed_sqft: SEEDED_SQFT }, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['tree_shrub']),
        before_value: JSON.stringify({ fallback_bed_sqft: null }),
        after_value: JSON.stringify({ fallback_bed_sqft: SEEDED_SQFT }),
        rationale: 'Owner ruling 2026-10-05: a T&S quote with no bed area at all prices 1,200 sqft instead of 2,000 and stays in the review lane. Quotes already sent replay the size they were priced with (2,000 when unstamped).',
      });
    }
  }
};

exports.down = async function down(knex) {
  // Only what this migration's up() wrote, keyed off its own audit row; no
  // audit table means no proof of ownership, so leave the data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'ts_material_rates', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;
  const loaded = await loadRow(knex);
  // A size the owner has since edited is an admin decision rollback must
  // not touch; only the untouched seeded value goes.
  if (loaded && Number(loaded.data.fallback_bed_sqft) === SEEDED_SQFT) {
    const newData = { ...loaded.data };
    delete newData.fallback_bed_sqft;
    await saveRow(knex, loaded.data, newData, `${MIGRATION_TAG} down: remove seeded fallback_bed_sqft`);
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};

module.exports.SEEDED_SQFT = SEEDED_SQFT;
module.exports.UP_REASON = UP_REASON;
