// Retire the pest catalog row "Advion WDG Granular" (owner 2026-10-24: "we don't really use this on pest visits").
// The row carries EPA 100-1483, the Advion Insect Granule bait; the lawn program keeps its own "Advion Insect Granule"
// row. Its two service_product_usage rows (0.5 oz per Quarterly Pest Control and per Ant Service visit) fed only the
// material cost on the Pricing Logic margin table, so they go too. The catalog row itself stays for history, the pest
// protocol hints and the one-tap template that name it: only `active` changes.
const NAME = 'Advion WDG Granular';
const USAGE = Object.freeze([
  { service_type: 'Quarterly Pest Control', usage_amount: 0.5, usage_unit: 'oz', usage_per_1000sf: null, is_primary: false, notes: 'Granular in beds + bait stations' },
  { service_type: 'Ant Service', usage_amount: 0.5, usage_unit: 'oz', usage_per_1000sf: null, is_primary: true, notes: 'Trail-focused bait/non-repellent protocol; avoid repellent spray on active trails.' },
]);

exports.up = async function up(knex) {
  const ids = (await knex('products_catalog').where({ name: NAME }).select('id')).map((row) => row.id);
  if (!ids.length) return;
  await knex('products_catalog').whereIn('id', ids).where({ active: true }).update({ active: false, updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('service_product_usage')) {
    await knex('service_product_usage').whereIn('product_id', ids).whereIn('service_type', USAGE.map((u) => u.service_type)).del();
  }
};

exports.down = async function down(knex) {
  const row = await knex('products_catalog').where({ name: NAME }).first('id');
  if (!row) return;
  await knex('products_catalog').where({ id: row.id }).update({ active: true, updated_at: knex.fn.now() });
  if (!(await knex.schema.hasTable('service_product_usage'))) return;
  for (const usage of USAGE) {
    const exists = await knex('service_product_usage').where({ product_id: row.id, service_type: usage.service_type }).first('id');
    if (!exists) await knex('service_product_usage').insert({ ...usage, product_id: row.id });
  }
};
