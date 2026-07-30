/**
 * Seed the admin-editable display block for the cockroach treatment line.
 *
 * Owner directive 2026-07-30: the recurring-customer roach add-on renders on
 * customer-facing estimates as "Cockroach Treatment" (no "Initial"), and the
 * name + number of treatment visits are admin-editable alongside the price
 * brackets. Pricing is DB-authoritative: db-bridge.syncConstantsFromDB loads
 * `pricing_config.pest_base.initial_roach` over the in-code constants, so the
 * constants.js display defaults in this PR are inert in any env carrying the
 * row unless the DB gains the `display` key too.
 *
 * Read-modify-write: only adds `initial_roach.display` when absent, preserving
 * admin edits to the price brackets and every other pest_base field.
 */
const MIGRATION_TAG = 'migration:20260730110000';
const UP_REASON = 'Seed initial_roach.display (customer-facing name + treatment count, owner directive 2026-07-30)';

const DISPLAY_DEFAULTS = {
  regular: { name: 'Cockroach Treatment', treatments: 1 },
  german: { name: 'German Cockroach Treatment', treatments: 1 },
  regular_standalone: { name: 'Cockroach Treatment', treatments: 1 },
};

async function loadPestBase(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'pest_base' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
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

exports.up = async function up(knex) {
  const loaded = await loadPestBase(knex);
  if (!loaded) return;
  const { data } = loaded;
  // A row without initial_roach falls through to the in-code bracket defaults
  // at sync time — adding display alone is safe either way, but skip rows that
  // already carry a display block (e.g. a prior admin edit): down() keys off
  // the audit row this branch skips writing.
  const ir = data.initial_roach;
  if (ir && typeof ir === 'object' && !Array.isArray(ir) && ir.display) return;
  const newData = {
    ...data,
    initial_roach: {
      ...(ir && typeof ir === 'object' && !Array.isArray(ir) ? ir : {}),
      display: DISPLAY_DEFAULTS,
    },
  };
  await savePestBase(knex, data, newData, UP_REASON);
};

exports.down = async function down(knex) {
  // Only strip the display block if this migration's up() created it — keyed
  // off the audit row — so admin-tuned names/treatment counts written after
  // an independent admin edit survive rollback. No audit table means no proof
  // of ownership; leave data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'pest_base', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  const loaded = await loadPestBase(knex);
  if (!loaded) return;
  const { data } = loaded;
  const ir = data.initial_roach;
  if (!ir || typeof ir !== 'object' || Array.isArray(ir) || !ir.display) return;
  const { display, ...rest } = ir;
  const newData = { ...data, initial_roach: rest };
  await savePestBase(
    knex, data, newData,
    'Rollback: remove initial_roach.display seeded by 20260730110000'
  );
};
