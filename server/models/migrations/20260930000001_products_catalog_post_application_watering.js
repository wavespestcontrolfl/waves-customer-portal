// Per-product post-application watering rule (lawn report rebuild, W1 PR 1).
//
// Adds products_catalog.post_application_watering (jsonb, nullable):
//   { mode: 'hold' | 'water_in' | 'none', hold_hours, water_in_inches,
//     water_in_by_hours, source: 'label' | 'owner' | 'default', label_note,
//     verified_at, verified_by }
// A CHECK pins mode to the closed set so a typo in a seed or an admin edit
// fails loudly. There is no mow_hold_days key: mowing gets its own column.
//
// Nothing customer-visible reads the column yet. resolveWateringRule
// (server/services/service-report/lawn-watering-rule.js) uses a valid stored
// rule first and otherwise derives one from formulation/category.
//
// Seed: the products whose labels were read (appendix/label-check.md,
// 2026-09-29), plus Drive XLR8 and LESCO Three-Way whose irrigation_notes
// already say 24 hours. Fill-only-empty: a row that already has a rule (an
// owner edit) is never overwritten. Matched by EPA reg number where the
// catalog carries it, else by name; a product with no matching row is skipped
// silently.

const VERIFIED_BY = 'label-check-2026-09-29';

const DRIVE_NOTE = 'For best results, do not water or irrigate for 24 hours after application.';
const THREE_WAY_NOTE = 'Delay irrigation for 24 hours after application; do not apply if rain is expected within 4 hours.';

// note: string, or a function of the matched row (Drive / Three-Way reuse the
// row's existing irrigation_notes text).
const SEEDS = [
  { label: 'Drive XLR8', epa: ['7969-272'], names: ['Drive XLR8%'],
    rule: { mode: 'hold', hold_hours: 24 }, note: (row) => row.irrigation_notes || DRIVE_NOTE },
  { label: 'LESCO Three-Way', epa: ['10404-43'], names: ['%Three-Way%'],
    rule: { mode: 'hold', hold_hours: 24 }, note: (row) => row.irrigation_notes || THREE_WAY_NOTE },
  { label: 'Celsius WG', epa: ['432-1507'], names: ['Celsius%'],
    rule: { mode: 'hold', hold_hours: 6 }, note: 'Do not irrigate until the spray has dried.' },
  { label: 'SedgeHammer Plus', epa: ['81880-24'], names: ['Sedge%Hammer%'],
    rule: { mode: 'hold', hold_hours: 48 },
    note: 'Rainfast within 4 hours; avoid irrigation within 48 hours after application (label read 2026-09-29)' },
  { label: 'Arena 50 WDG', epa: ['59639-152'], names: ['Arena 50%'],
    rule: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 },
    note: 'Apply in sufficient water; avoid mowing until after irrigation or rainfall' },
  { label: 'Talak 7.9 F', epa: ['91234-145'], names: ['%Talak%'],
    rule: { mode: 'hold', hold_hours: 24 },
    note: 'Postpone watering (irrigation) or mowing for 24 hours after application' },
  { label: 'Artavia 2 SC', epa: ['91234-74'], names: ['%Artavia%'],
    rule: { mode: 'hold', hold_hours: 48 },
    note: 'No rain or watering within 48 hours after application' },
];

const CONSTRAINT = 'products_catalog_post_application_watering_mode_check';

async function findRows(knex, seed) {
  const byEpa = await knex('products_catalog')
    .whereIn(knex.raw('TRIM(epa_reg_number)'), seed.epa)
    .select('id', 'irrigation_notes', 'post_application_watering');
  if (byEpa.length) return byEpa;
  return knex('products_catalog')
    .where((qb) => {
      for (const pattern of seed.names) qb.orWhere('name', 'ilike', pattern);
    })
    .select('id', 'irrigation_notes', 'post_application_watering');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.jsonb('post_application_watering');
    });
  }

  // COALESCE: a JSON object with no "mode" key yields NULL, and a CHECK that
  // evaluates to NULL passes. The jsonb_typeof guard rejects non-objects.
  const existing = await knex.raw(
    "SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'products_catalog'::regclass",
    [CONSTRAINT],
  );
  if (!existing.rows.length) {
    await knex.raw(`
      ALTER TABLE products_catalog
      ADD CONSTRAINT ${CONSTRAINT}
      CHECK (
        post_application_watering IS NULL
        OR (
          jsonb_typeof(post_application_watering) = 'object'
          AND COALESCE(post_application_watering->>'mode', '') IN ('hold', 'water_in', 'none')
        )
      )
    `);
  }

  const verifiedAt = new Date().toISOString();
  for (const seed of SEEDS) {
    const rows = await findRows(knex, seed);
    for (const row of rows) {
      if (row.post_application_watering != null) continue; // never overwrite
      const rule = {
        ...seed.rule,
        source: 'label',
        label_note: typeof seed.note === 'function' ? seed.note(row) : seed.note,
        verified_at: verifiedAt,
        verified_by: VERIFIED_BY,
      };
      await knex('products_catalog')
        .where({ id: row.id })
        .whereNull('post_application_watering')
        .update({
          post_application_watering: JSON.stringify(rule),
          updated_at: knex.fn.now(),
        });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex.raw(`ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  if (await knex.schema.hasColumn('products_catalog', 'post_application_watering')) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.dropColumn('post_application_watering');
    });
  }
};
