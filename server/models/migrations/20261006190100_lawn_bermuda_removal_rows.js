/**
 * Lawn bermuda removal step, staged rows and limits (GATE_LAWN_BERMUDA_REMOVAL,
 * owner 2026-10-06, plan page Xg4QcStBFB5qJ4jdyM4CRH).
 *
 * 1. Staged v13 rows. For the St. Augustine and Zoysia v13 protocols, the April
 *    ('apr_v13_spreader_feeding') and June ('jun_v13_hose_blackout') windows get
 *    three backpack SPOT rows: Recognition (0.03 oz per 1,000 sq ft), Fusilade II
 *    (0.55 fl oz per 1,000 sq ft) and the nonionic surfactant (0.25% of the spray
 *    volume). Every row carries gates.bermudaRemoval = true. The protocol reader
 *    leaves those rows out of every lawn unless the visit's account is a bermuda
 *    removal lawn (lawn-protocol-operating-layer.js getProtocolWindowContext), so
 *    the rows are inert for everyone else, and for everyone while the gate is off.
 *    Spot rows compute no amount (v13RowCalculates); default_in_plan is false.
 *    Gate keys carry the field rules: actively growing bermuda only, no rain or
 *    irrigation for 3 hours after, no mowing 2 days before or after, skip the
 *    Celsius weed spot in the bermuda area that day, and (June rows) a morning
 *    spray with the temperature under 85 F. No watering rule is written here: the
 *    watering lane owns those.
 * 2. product_limits for Recognition and Fusilade II (by catalog id, read by
 *    application-limits.checkLimits): at most 2 applications per calendar year
 *    (hard block), at least 42 days apart (hard block). Recognition also gets its
 *    label annual maximum, 6.26 oz per acre = 0.1437 oz per 1,000 sq ft, as a
 *    warning: two sprays at 0.03 oz stay far under it, and application_rate on
 *    history rows is the technician's entry, so a hard block could trip on a unit
 *    slip.
 * A product missing from the catalog skips its limits and leaves its row unlinked
 * (product_id null: the plan then withholds the whole step). Idempotent. down()
 * deletes the rows and limits this migration wrote (rows a completion actual
 * references are kept, a documented no-op for those).
 */
const V13_VERSION = '2026.10-v13';
const PROTOCOL_KEYS = ['swfl_st_augustine_10_10', 'swfl_zoysia_10_10'];
const WINDOWS = { apr_v13_spreader_feeding: false, jun_v13_hose_blackout: true }; // value: morning-under-85 rule
const LIMIT_TAG = 'bermuda removal (owner 2026-10-06)';

const N = {
  REC: 'Recognition Post Emergent Herbicide',
  FUS: 'Fusilade II Post Emergent Liquid Herbicide',
  NIS: 'LESCO 90/10 Nonionic Surfactant',
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function fieldRules(june) {
  return {
    bermudaRemoval: true,
    activelyGrowingOnly: true,
    noRainOrIrrigationHours: 3,
    noMowDaysBeforeAfter: 2,
    skipCelsiusInBermudaArea: true,
    ...(june ? { morningUnderF: 85 } : {}),
  };
}

// [name, role, rate, unit, extra gates]
function rowSpecs() {
  return [
    [N.REC, 'post_emergent_spot', 0.03, 'oz', { tankMixWith: N.FUS }],
    [N.FUS, 'post_emergent_spot', 0.55, 'fl oz', { requiresProduct: 'Recognition', tankMixWith: N.REC }],
    [N.NIS, 'adjuvant_spot', null, 'label_rate', { concentration: '0.25% of the spray volume', tankMixWith: `${N.REC} and ${N.FUS}` }],
  ];
}

const LIMITS = [
  { name: N.REC, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: `Recognition: max 2 bermuda removal sprays per calendar year per property ${LIMIT_TAG}. A third waits for next year.` },
  { name: N.REC, limit_type: 'min_interval_days', limit_value: 42, limit_unit: 'days', severity: 'hard_block', description: `Recognition: at least 42 days between bermuda removal sprays ${LIMIT_TAG}.` },
  { name: N.REC, limit_type: 'annual_max_rate', limit_value: 0.1437, limit_unit: 'oz/1000sf/year', severity: 'warning', description: `Recognition label annual maximum 6.26 oz per acre (0.1437 oz per 1,000 sq ft) ${LIMIT_TAG}.` },
  { name: N.FUS, limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: `Fusilade II: max 2 bermuda removal sprays per calendar year per property ${LIMIT_TAG}. A third waits for next year.` },
  { name: N.FUS, limit_type: 'min_interval_days', limit_value: 42, limit_unit: 'days', severity: 'hard_block', description: `Fusilade II: at least 42 days between bermuda removal sprays ${LIMIT_TAG}.` },
];

async function productIdByName(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const byName = new Map();
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) {
    const key = normalize(row.name);
    if (!byName.has(key)) byName.set(key, row.id);
  }
  return (name) => byName.get(normalize(name)) || null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const idOf = await productIdByName(knex);

  for (const key of PROTOCOL_KEYS) {
    const protocol = await knex('lawn_protocols').where({ protocol_key: key, version: V13_VERSION }).first('id');
    if (!protocol) continue;
    for (const [windowKey, june] of Object.entries(WINDOWS)) {
      const window = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id, window_key: windowKey }).first('id');
      if (!window) continue;
      const maxSort = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).max('sort_order as m').first();
      let sort = Number(maxSort?.m || 0);
      for (const [name, role, rate, unit, extra] of rowSpecs()) {
        const exists = await knex('lawn_protocol_products')
          .where({ lawn_protocol_window_id: window.id, product_name: name })
          .whereRaw("gates->>'bermudaRemoval' = 'true'").first('id');
        if (exists) continue;
        sort += 1;
        await knex('lawn_protocol_products').insert({
          lawn_protocol_window_id: window.id,
          product_id: idOf(name),
          product_name: name,
          role,
          application_mode: 'spot',
          rate_per_1000: rate,
          rate_unit: unit,
          carrier_gal_per_1000: 1,
          default_in_plan: false,
          gates: JSON.stringify({ ...fieldRules(june), ...extra }),
          annual_counter: JSON.stringify({}),
          mixing: JSON.stringify({}),
          report_copy: JSON.stringify({ role }),
          sort_order: sort,
        });
      }
    }
  }

  if (await knex.schema.hasTable('product_limits')) {
    for (const limit of LIMITS) {
      const productId = idOf(limit.name);
      if (!productId) continue;
      const { name, ...fields } = limit;
      const exists = await knex('product_limits').where({ product_id: productId, match_type: 'product', limit_type: fields.limit_type }).first('id');
      if (exists) continue;
      await knex('product_limits').insert({ product_id: productId, match_type: 'product', ...fields });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('product_limits') && await knex.schema.hasTable('products_catalog')) {
    const idOf = await productIdByName(knex);
    for (const limit of LIMITS) {
      const productId = idOf(limit.name);
      if (!productId) continue;
      await knex('product_limits')
        .where({ product_id: productId, match_type: 'product', limit_type: limit.limit_type })
        .where('description', 'like', `%${LIMIT_TAG}%`).del();
    }
  }
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION).whereIn('l.protocol_key', PROTOCOL_KEYS)
    .whereIn('w.window_key', Object.keys(WINDOWS))
    .whereRaw("p.gates->>'bermudaRemoval' = 'true'")
    .select('p.id');
  const ids = rows.map((row) => row.id);
  if (!ids.length) return;
  let keep = [];
  if (await knex.schema.hasTable('lawn_protocol_product_actuals')) {
    keep = (await knex('lawn_protocol_product_actuals').whereIn('protocol_product_id', ids).select('protocol_product_id')).map((r) => r.protocol_product_id);
  }
  const drop = ids.filter((id) => !keep.includes(id));
  if (drop.length) await knex('lawn_protocol_products').whereIn('id', drop).del();
};
