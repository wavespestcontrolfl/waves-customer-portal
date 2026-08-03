/**
 * Bake light-tree-density pricing into the pest base: $117 -> $112/visit.
 *
 * Migration 20260716140000 retired the tree-density modifiers from
 * pest-control pricing, which silently repriced the (majority) light-tree
 * homes +$5/visit — they lost the trees_light -$5 credit instead of the
 * modifier going away neutrally. Owner ruling 2026-08-03: tree density is
 * not a pest-pricing input, and ALL pest quotes price as light tree
 * density. That means the -$5 belongs in the base for everyone.
 *
 * Pest base pricing is DB-authoritative: db-bridge.syncConstantsFromDB
 * loads `pricing_config.pest_base` over the in-code constants, so the
 * constants.js change in this PR is inert in any env carrying the row
 * unless the DB is updated too. Read-modify-write preserves admin edits to
 * the row's other keys (floor, initial_roach, enforce_floor_post_discount).
 */
const OLD_BASE = 117;
const NEW_BASE = 112;
const MIGRATION_TAG = 'migration:20260803150000';
const UP_REASON =
  'Pest base 117 -> 112: all pest priced as light tree density (owner ruling 2026-08-03).';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.3',
  version_to: 'v4.3',
  changed_by: 'claude-2026-08-03',
  category: 'rule',
  summary: 'Bake the light-tree-density -$5 into the pest base (117 -> 112).',
};

async function loadPestBase(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // Locking read (knex runs migrations in a transaction): an admin saving
  // this row through the pricing panel mid-deploy must serialize with the
  // whole-object write below, or their edit would be overwritten by this
  // read's stale snapshot (pattern from 20260802910000_no_show_fee_75).
  const row = await knex('pricing_config').where({ config_key: 'pest_base' }).forUpdate().first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

async function savePestBase(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'pest_base' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'pest_base',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const data = await loadPestBase(knex);
  if (!data) return;
  // Only move the known 117 baseline; a base already tuned away from 117
  // (admin edit) is left alone — down() keys off the audit row this branch
  // skips writing.
  if (Number(data.base) !== OLD_BASE) return;
  await savePestBase(knex, data, { ...data, base: NEW_BASE }, UP_REASON);

  // Record the intentional pricing change (regression baselines recaptured
  // in the same PR).
  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['pest_control']),
        before_value: JSON.stringify({ pest_base: OLD_BASE }),
        after_value: JSON.stringify({ pest_base: NEW_BASE }),
        rationale:
          'Owner ruling 2026-08-03: tree density is not a pest-pricing input and every pest quote prices as light tree density. Retiring trees_light (migration 20260716140000) had effectively raised light-tree homes +$5/visit; folding the -$5 into the base (117 -> 112) restores their pre-retirement price and gives moderate/heavy-tree homes the same light-tree rate. Quarterly baseline example: 2,030 sqft near-water/light-shrub/simple home moves $110 -> $105/visit ($440 -> $420 annual). One-time pest scales with the quarterly base (x2.2), so it moves ~-$11 at baseline.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only restore 117 if this migration's up() made the change — keyed off
  // the audit row — so an admin-tuned base survives rollback.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'pest_base', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  const data = await loadPestBase(knex);
  if (data && Number(data.base) === NEW_BASE) {
    await savePestBase(
      knex, data, { ...data, base: OLD_BASE },
      'Rollback: restore pest base 117 (undo light-tree-density fold).'
    );
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
