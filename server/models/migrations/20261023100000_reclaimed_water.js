/**
 * Reclaimed water (GATE_LAWN_RECLAIMED_HALF_N, owner 2026-10-05 and 2026-10-23).
 *
 * A lawn watered with reclaimed (purple pipe) water already gets nitrogen from the water, so the app halves the
 * nitrogen of every N visit (services/lawn-reclaimed-water.js). This migration adds only the data. Nothing reads it
 * while the gate is off, and no existing row changes (every new column stays NULL).
 *
 * 1. customer_properties (the property row, one per service address):
 *      reclaimed_water            boolean, NULL = nobody knows
 *      reclaimed_water_source     'county_meter' | 'office' | 'customer'. The county job only writes a row whose source
 *                                 is NULL or 'county_meter'; an office or customer value always wins.
 *      reclaimed_water_checked_at when the source last settled the value
 * 2. reclaimed_water_meters: the county's public layer of reclaimed water meters (Manatee County, 40k points), kept
 *    locally so a property is matched here and no customer coordinate is ever sent to the county service.
 *
 * Idempotent in both directions. down() drops what up() added; a value the office typed is lost with the column (the
 * office sets it again, and the county job refills the automatic ones).
 */
const SOURCES = ['county_meter', 'office', 'customer'];
const CHECK = 'customer_properties_reclaimed_water_source_check';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_properties')) {
    const has = async (col) => knex.schema.hasColumn('customer_properties', col);
    const needWater = !(await has('reclaimed_water'));
    const needSource = !(await has('reclaimed_water_source'));
    const needChecked = !(await has('reclaimed_water_checked_at'));
    if (needWater || needSource || needChecked) {
      await knex.schema.alterTable('customer_properties', (t) => {
        if (needWater) t.boolean('reclaimed_water').nullable();
        if (needSource) t.string('reclaimed_water_source', 20).nullable();
        if (needChecked) t.timestamp('reclaimed_water_checked_at', { useTz: true }).nullable();
      });
    }
    await knex.raw(`ALTER TABLE customer_properties DROP CONSTRAINT IF EXISTS ${CHECK}`);
    await knex.raw(`ALTER TABLE customer_properties ADD CONSTRAINT ${CHECK} CHECK (reclaimed_water_source IS NULL OR reclaimed_water_source IN (${SOURCES.map((s) => `'${s}'`).join(', ')}))`);
  }

  if (!(await knex.schema.hasTable('reclaimed_water_meters'))) {
    await knex.schema.createTable('reclaimed_water_meters', (t) => {
      t.integer('objectid').primary(); // the county layer's OBJECTID
      t.double('lat').notNullable();
      t.double('lng').notNullable();
      t.string('source', 40).notNullable().defaultTo('manatee_county');
      t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['lat', 'lng']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('reclaimed_water_meters');
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  await knex.raw(`ALTER TABLE customer_properties DROP CONSTRAINT IF EXISTS ${CHECK}`);
  const present = [];
  for (const col of ['reclaimed_water', 'reclaimed_water_source', 'reclaimed_water_checked_at']) {
    if (await knex.schema.hasColumn('customer_properties', col)) present.push(col);
  }
  if (present.length) await knex.schema.alterTable('customer_properties', (t) => { t.dropColumns(...present); });
};
