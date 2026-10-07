/**
 * Lawn protocol v13: the February atrazine option (owner 2026-10-06; evidence: the Fable premise audit
 * of 2026-10-06, section B, and the EPA 10404-94 label). Earlier v13 migrations are pushed and frozen;
 * this one adds to what they staged.
 *
 * LESCO Atrazine 1.05% 18-0-10 (SiteOne 702202, $36.14 per 50 lb) is an OPTIONAL spreader product in the
 * St. Augustine track's February window, for a weedy lawn. The default February bag (24-0-11) is unchanged.
 * Four phases, each one insert-if-missing:
 *   1. the catalog row (never deleted by down(): it may carry inventory or pricing);
 *   2. its two hard limits: 2 applications a year, 60 days apart (label: 4 lb ai per acre per year);
 *   3. one non-default row in each staged St. Augustine February window, with the gates the plan reads:
 *      turfOnly (St. Augustine or centipede, a hard gate: no amount, completion refused), wholeLawn,
 *      replacesProduct (selecting it takes the 24-0-11 off the visit), waterInNow, avoidHighWaterTable
 *      and the two setbacks;
 *   4. (the watering rule rides on the catalog row, phase 1).
 *
 * Watering: the label says "must be watered in immediately after application" and states no amount and
 * no time. The rule is therefore NOT label-sourced: the 0.25 inch and the 15-minute window are the
 * program's, recorded with source 'owner' (owner approved the program 2026-10-06), and the label sentence
 * is kept in label_note. A visit that also carries a timed hold cannot meet a 15-minute window, so the
 * instruction builder makes no claim for it (fail closed).
 *
 * down(): removes this option's protocol rows, EXCEPT a row any completion actual references (deleting it
 * would null that actual's protocol_product_id for good: ON DELETE SET NULL), and its limit rows.
 */

const NAME = 'LESCO Atrazine 1.05% 18-0-10 56% PolyPlus OPTI45 2%Fe 0.5%Mn 0.5%Mg AS MOP';
const DEFAULT_BAG = 'LESCO 24-0-11 with PolyPlus OPTI';
const V13_VERSION = '2026.10-v13';
const FEB_WINDOW = 'feb_v13_spreader_green_up';
const LIMIT_PREFIX = 'v13 atrazine 2026-10-06:';

const WATERING = {
  mode: 'water_in',
  water_in_inches: 0.25,
  water_in_by_hours: 0.25,
  source: 'owner',
  label_note: 'Label (EPA 10404-94): "This product must be watered in immediately after application." The label states no amount and no time. Program choice, not label: 0.25 inch, started within 15 minutes of completion. Keep people and pets off until it is watered in and dry.',
  verified_at: '2026-10-06T00:00:00.000Z',
  verified_by: 'owner-approval-2026-10-06',
};

// Label values are from the 2008 notification label (EPA 10404-94); the 702202 bag label itself has not
// been read (SiteOne returns 403), so the water setback wording stays a check on the bag.
const PRODUCT = {
  name: NAME,
  category: 'herbicide',
  product_type: 'pesticide',
  active_ingredient: 'Atrazine',
  ai_pct: 1.05,
  hrac_group: '5',
  epa_reg_number: '10404-94',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  rate_unit: 'lb',
  default_rate_per_1000: 4.0,
  min_label_rate_per_1000: 3.27,
  max_label_rate_per_1000: 4.37,
  max_annual_per_1000: 8.74,
  maximum_annual_rate: '4 lb atrazine ai per acre per year (2 applications at 4.37 lb of product per 1,000 sq ft)',
  reapplication_interval_days: 60,
  analysis_n: 18,
  analysis_p: 0,
  analysis_k: 10,
  slow_release_n_pct: 56,
  labeled_turf_species: JSON.stringify(['st_augustine', 'centipede']),
  excluded_turf_species: JSON.stringify(['bermuda', 'zoysia', 'bahia', 'kentucky_bluegrass', 'fescue', 'ryegrass', 'bentgrass', 'dichondra']),
  aquatic_buffer_ft: 200,
  irrigation_required: true,
  siteone_sku: '702202',
  best_price: 36.14,
  best_vendor: 'SiteOne',
  cost_per_unit: 0.7228,
  cost_unit: 'lb',
  needs_pricing: false,
  label_source_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/010404-00094-20080222.pdf',
  label_source_note: 'Added for the Waves lawn protocol v13 February option (owner 2026-10-06). St. Augustine and centipede only; 3.27 to 4.37 lb per 1,000 sq ft; 2 applications a year, 2 months apart; must be watered in immediately; not within 200 ft of a lake or pond or 66 ft of where runoff enters a stream (2008 label; read the bag).',
  post_application_watering: JSON.stringify(WATERING),
  active: true,
  content_status: 'draft',
  customer_visibility: 'internal_only',
};

// [limit_type, value, unit, description]
const LIMITS = [
  ['annual_max_apps', 2, 'applications', `${LIMIT_PREFIX} at most 2 applications per year (label: 4 lb ai per acre per year).`],
  ['min_interval_days', 60, 'days', `${LIMIT_PREFIX} wait 2 months for a repeat application (label).`],
];

// The option's row in the February window: not a default, so a plan selects it only when the tech picks it.
const PROTOCOL_ROW = {
  role: 'weedy_lawn_option',
  application_mode: 'broadcast',
  rate_per_1000: 4.0,
  rate_unit: 'lb',
  carrier_gal_per_1000: null,
  default_in_plan: false,
  gates: JSON.stringify({
    trigger: 'weedy_lawn',
    turfOnly: ['st_augustine', 'centipede'],
    wholeLawn: true,
    replacesProduct: DEFAULT_BAG,
    waterInNow: true,
    avoidHighWaterTable: true,
    minDistanceFromWaterFt: 200,
    minDistanceFromStormInletFt: 66,
  }),
  annual_counter: JSON.stringify({}),
  mixing: JSON.stringify({}),
  report_copy: JSON.stringify({ role: 'weedy_lawn_option' }),
};

const TABLES = ['products_catalog', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_product_actuals'];
const hasTables = async (knex) => (await Promise.all(TABLES.map((table) => knex.schema.hasTable(table)))).every(Boolean);

async function ensureCatalogRow(knex) {
  const found = await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).first('id');
  if (found) return found.id;
  const [row] = await knex('products_catalog').insert({ ...PRODUCT, created_at: knex.fn.now(), updated_at: knex.fn.now() }).returning('id');
  return row.id || row;
}

async function ensureLimits(knex, productId) {
  const have = new Set(await knex('product_limits').where({ product_id: productId, match_type: 'product' }).pluck('limit_type'));
  const missing = LIMITS.filter(([type]) => !have.has(type));
  if (!missing.length) return;
  await knex('product_limits').insert(missing.map(([limit_type, limit_value, limit_unit, description]) => ({
    product_id: productId, match_type: 'product', limit_type, limit_value, limit_unit, severity: 'hard_block', description,
  })));
}

async function ensureProtocolRows(knex, productId) {
  const windows = await knex('lawn_protocol_windows as w')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION, 'l.grass_track': 'st_augustine', 'w.window_key': FEB_WINDOW })
    .pluck('w.id');
  const have = new Set(await knex('lawn_protocol_products').where({ product_name: NAME }).whereIn('lawn_protocol_window_id', windows).pluck('lawn_protocol_window_id'));
  for (const windowId of windows.filter((id) => !have.has(id))) {
    const { top } = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: windowId }).max('sort_order as top').first();
    await knex('lawn_protocol_products').insert({
      ...PROTOCOL_ROW, lawn_protocol_window_id: windowId, product_id: productId, product_name: NAME, sort_order: (Number(top) || 0) + 1,
    });
  }
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const productId = await ensureCatalogRow(knex);
  await ensureLimits(knex, productId);
  await ensureProtocolRows(knex, productId);
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  // A row a completion actual points at stays: deleting it would null that actual's link for good.
  await knex('lawn_protocol_products').where({ product_name: NAME })
    .whereNotIn('id', knex('lawn_protocol_product_actuals').whereNotNull('protocol_product_id').select('protocol_product_id'))
    .del();
  await knex('product_limits').where({ match_type: 'product' })
    .whereIn('product_id', knex('products_catalog').where({ name: NAME }).select('id'))
    .whereRaw('description LIKE ?', [`${LIMIT_PREFIX}%`])
    .del();
};

exports.NAME = NAME;
exports.DEFAULT_BAG = DEFAULT_BAG;
exports.PRODUCT = PRODUCT;
exports.WATERING = WATERING;
exports.LIMITS = LIMITS;
exports.PROTOCOL_ROW = PROTOCOL_ROW;
