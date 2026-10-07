/**
 * Lawn protocol v13, atrazine option follow-up. Migration 20261007160000 inserts the catalog row only when
 * no row has that exact name; a row that already existed (added by hand in prod) keeps whatever it had, so
 * the plan could size the bag from a blank rate, EPA number, analysis, watering rule or turf list.
 *
 * This one fills, on the row with that exact name, ONLY the authoritative label fields that are missing
 * (null, empty, or an 'N/A' EPA number) from the values 20261007160000 carries, and the pricing fields only
 * when the price is absent. A field that already holds a value is never touched, and no operational field
 * (inventory, active, visibility, notes) is in the list.
 *
 * Reversible by record: one lawn_protocol_audit_log row (action 'v13_atrazine_catalog_fill') keeps what each
 * filled field held before and what was written. down() puts the old value back only while the field still
 * holds what was written here, then deletes that audit row.
 */
const { isDeepStrictEqual } = require('node:util');
const { NAME, PRODUCT } = require('./20261007160000_lawn_v13_atrazine_feb_option');

const ACTION = 'v13_atrazine_catalog_fill';
const LABEL_KEYS = [
  'active_ingredient', 'ai_pct', 'hrac_group', 'epa_reg_number', 'formulation', 'container_size', 'unit_size_oz', 'rate_unit',
  'default_rate_per_1000', 'min_label_rate_per_1000', 'max_label_rate_per_1000', 'max_annual_per_1000', 'maximum_annual_rate',
  'reapplication_interval_days', 'analysis_n', 'analysis_p', 'analysis_k', 'slow_release_n_pct',
  'labeled_turf_species', 'excluded_turf_species', 'aquatic_buffer_ft', 'irrigation_required', 'post_application_watering',
];
const PRICING_KEYS = ['siteone_sku', 'best_price', 'best_vendor', 'cost_per_unit', 'cost_unit'];

const parse = (value) => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return value; } };
const isMissing = (key, value) => value == null || value === '' || (Array.isArray(value) && value.length === 0)
  || (key === 'epa_reg_number' && /^n\/a$/i.test(String(value).trim()));
// pg returns numeric columns as strings and jsonb as parsed values; the written value is a number or JSON text.
const same = (a, b) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && a !== '' && b !== '' && typeof parse(a) !== 'object'
  ? Number(a) === Number(b) : isDeepStrictEqual(parse(a), parse(b)));
const toDb = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const row = await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).first();
  if (!row) return;
  const fills = Object.fromEntries([...LABEL_KEYS, ...PRICING_KEYS].filter((key) => isMissing(key, row[key])).map((key) => [key, PRODUCT[key]]));
  if (!Object.keys(fills).length) return;
  if ('best_price' in fills) fills.needs_pricing = false;
  const before = Object.fromEntries(Object.keys(fills).map((key) => [key, row[key] ?? null]));
  await knex('products_catalog').where({ id: row.id }).update({
    ...Object.fromEntries(Object.entries(fills).map(([key, value]) => [key, toDb(value)])), updated_at: knex.fn.now(),
  });
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261007161000',
    entity_type: 'catalog',
    entity_id: row.id,
    action: ACTION,
    changed_fields: JSON.stringify(Object.keys(fills)),
    before_snapshot: JSON.stringify(before),
    after_snapshot: JSON.stringify(fills),
    metadata: JSON.stringify({ migration: '20261007161000_lawn_v13_atrazine_catalog_fill', product: NAME }),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'entity_id', 'before_snapshot', 'after_snapshot')) {
    const row = await knex('products_catalog').where({ id: log.entity_id }).first();
    const undo = Object.fromEntries(Object.entries(parse(log.after_snapshot) || {})
      .filter(([key, written]) => row && same(row[key], written))
      .map(([key]) => [key, toDb(parse(log.before_snapshot)[key])]));
    if (Object.keys(undo).length) await knex('products_catalog').where({ id: log.entity_id }).update({ ...undo, updated_at: knex.fn.now() });
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.LABEL_KEYS = LABEL_KEYS;
exports.PRICING_KEYS = PRICING_KEYS;
