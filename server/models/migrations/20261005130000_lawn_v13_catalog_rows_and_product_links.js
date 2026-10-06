/**
 * Lawn protocol v13, PR 1 follow-up (Codex round 1 on #5942). Migration
 * 20261005120000 is pushed and frozen; this one fixes its data.
 *
 * 1. Catalog rows. The products v13 names were added to prod products_catalog
 *    by data writes, never by migrations, so a repo-built database lacks most
 *    of them and the staged lawn_protocol_products rows kept product_id NULL
 *    (the gated plan then omits or mis-resolves them). EVERY product the recipe
 *    names is inserted ONLY when no catalog row has that exact name and no
 *    product alias spells it. A prod row that already exists is never touched.
 *    Price is unknown, so needs_pricing. An EPA number the owner did not give
 *    is left NULL, never guessed.
 * 2. Links. Every staged 2026.10-v13 lawn_protocol_products row with a NULL
 *    product_id is linked by exact name, then alias. If any v13 product row is
 *    still unresolved afterwards the migration throws (and rolls back): a
 *    protocol row that names a product the catalog cannot resolve must not ship.
 * 3. Gate keys. Product gate keys that nothing reads at runtime are removed
 *    from the v13 rows (the instruction stays in the visit note and the line
 *    text), so the data does not promise enforcement it does not have. Kept:
 *    keys older seeds already use, and sunnyTurfOnly, which the plan engine
 *    now reads.
 *
 * Reversible by record: one lawn_protocol_audit_log row per staged protocol
 * (action 'v13_link_fix') stores the gates each changed row had and the
 * product ids backfilled. down() restores those gates, nulls a backfilled id
 * only while it still holds the value this migration wrote, and deletes its
 * audit rows. Catalog rows are left in place (they exist in prod and may carry
 * inventory or pricing history), and so is any link not recorded here.
 */

const V13_VERSION = '2026.10-v13';
const AUDIT_ACTION = 'v13_link_fix';

// Every product the v13 recipe names. Prod has them (added by data writes); a
// repo-built database has few. epa_reg_number is set only where the owner gave
// one: an unknown number is never guessed (it stays NULL). Rates are the
// program's stated rate; a product with none states no default.
const L = 'liquid';
const PRODUCTS = [
  { name: 'LESCO Nutra-TECH T&O Micronutrient Package', category: 'fertilizer', formulation: L, container_size: '2.5 gal', unit_size_oz: 320, epa_reg_number: 'N/A', default_rate_per_1000: 12, min_label_rate_per_1000: 6, max_label_rate_per_1000: 16, rate_unit: 'fl oz' },
  { name: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer', category: 'fertilizer', active_ingredient: 'Prodiamine', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800, epa_reg_number: '10404-89', default_rate_per_1000: 4.02, rate_unit: 'lb', analysis_n: 15, analysis_p: 0, analysis_k: 15 },
  { name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', category: 'fertilizer', active_ingredient: 'Dithiopyr', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800, epa_reg_number: '10404-87', default_rate_per_1000: 2.78, max_label_rate_per_1000: 5.48, rate_unit: 'lb', analysis_n: 18, analysis_p: 0, analysis_k: 10 },
  { name: 'Dylox 6.2 G Granular Insecticide', category: 'insecticide', active_ingredient: 'Trichlorfon', formulation: 'granular', container_size: '30 lb', unit_size_oz: 480, epa_reg_number: '432-1308', default_rate_per_1000: 3, rate_unit: 'lb' },
  { name: 'Acelepryn Insecticide', category: 'insecticide', formulation: L, container_size: '64 oz', unit_size_oz: 64, default_rate_per_1000: 0.05, rate_unit: 'fl oz' },
  { name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', active_ingredient: 'Azoxystrobin', formulation: L, container_size: '1 gal', unit_size_oz: 128, epa_reg_number: '91234-74', default_rate_per_1000: 0.77, rate_unit: 'fl oz' },
  { name: 'Atticus Talak 7.9 F', category: 'insecticide', formulation: L, container_size: '96 fl oz', unit_size_oz: 96, default_rate_per_1000: 0.5, rate_unit: 'fl oz' },
  { name: 'Certainty Turf Herbicide', category: 'herbicide', formulation: 'dry', container_size: '1.25 oz', unit_size_oz: 1.25, epa_reg_number: '59639-226', default_rate_per_1000: 0.028, rate_unit: 'oz' },
  { name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', category: 'herbicide', active_ingredient: 'Dithiopyr', formulation: L, container_size: '64 fl oz', unit_size_oz: 64, default_rate_per_1000: 0.5, rate_unit: 'fl oz' },
  { name: 'Dismiss 64 oz', category: 'herbicide', formulation: L, container_size: '64 oz', unit_size_oz: 64, default_rate_per_1000: 0.18, rate_unit: 'fl oz' },
  { name: 'Gravex 20 EW', category: 'fungicide', formulation: L, container_size: '16 fl oz', unit_size_oz: 16, epa_reg_number: '91234-283', default_rate_per_1000: 1.2, rate_unit: 'fl oz' },
  { name: 'LESCO 24-0-11 with PolyPlus OPTI', category: 'fertilizer', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800, epa_reg_number: 'N/A', default_rate_per_1000: 4.2, rate_unit: 'lb', analysis_n: 24, analysis_p: 0, analysis_k: 11 },
  { name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant', formulation: L, container_size: '2.5 gal', unit_size_oz: 320, epa_reg_number: 'N/A', default_rate_per_1000: 0.25, rate_unit: 'fl oz' },
  { name: 'Celsius WG', category: 'herbicide', formulation: 'dry', container_size: '10 oz', unit_size_oz: 10, epa_reg_number: '432-1507', default_rate_per_1000: 0.085, rate_unit: 'oz' },
  { name: 'Tetrino Insecticide', category: 'insecticide', active_ingredient: 'Tetraniliprole', formulation: L, container_size: '1 gal', unit_size_oz: 128, default_rate_per_1000: 0.367, rate_unit: 'fl oz' },
  { name: 'Velista', category: 'fungicide', active_ingredient: 'Penthiopyrad', formulation: 'dry', container_size: '22 oz', unit_size_oz: 22, default_rate_per_1000: 0.5, rate_unit: 'oz' },
  { name: 'Blindside Herbicide', category: 'herbicide', formulation: 'dry', container_size: '0.5 lb', unit_size_oz: 8 },
  { name: 'Arena 50 WDG', category: 'insecticide', formulation: 'dry', container_size: '2.5 lb', unit_size_oz: 40, default_rate_per_1000: 0.29, rate_unit: 'oz' },
  { name: 'Dispatch Sprayable Wetting Agent', category: 'adjuvant', formulation: L, container_size: '2.5 gal', unit_size_oz: 320 },
  { name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', category: 'herbicide', active_ingredient: 'Prodiamine', formulation: L, container_size: '2.5 gal', unit_size_oz: 320, default_rate_per_1000: 0.5, rate_unit: 'fl oz' },
];

// Product gate keys kept on v13 rows: the keys earlier seeds already use plus
// sunnyTurfOnly (read by waveguard-plan-engine effectiveAreaFactor).
const KEPT_GATE_KEYS = new Set(['annualCounter', 'stressGate', 'targetN', 'blackoutSensitive', 'requiresZeroNP', 'trigger', 'postAppIrrigation', 'sunnyTurfOnly']);

// jsonb columns come back parsed from pg; accept a JSON string too.
function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function loadResolver(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const aliases = (await knex.schema.hasTable('product_aliases'))
    ? await knex('product_aliases').select('product_id', 'alias_name') : [];
  const byName = new Map();
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) {
    if (!byName.has(normalize(row.name))) byName.set(normalize(row.name), row.id);
  }
  const byAlias = new Map();
  for (const row of aliases) if (!byAlias.has(normalize(row.alias_name))) byAlias.set(normalize(row.alias_name), row.product_id);
  return (name) => byName.get(normalize(name)) || byAlias.get(normalize(name)) || null;
}

function v13Rows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;

  let resolve = await loadResolver(knex);
  for (const product of PRODUCTS) {
    if (resolve(product.name)) continue;
    await knex('products_catalog').insert({
      ...product,
      active: true,
      needs_pricing: true,
      content_status: 'draft',
      customer_visibility: 'internal_only',
      label_source_note: 'Added for the Waves lawn protocol v13 (owner 2026-10-05); price pending.',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
  }
  resolve = await loadResolver(knex);

  const rows = await v13Rows(knex).select('p.id', 'p.product_id', 'p.product_name', 'p.gates', 'l.id as protocol_id');
  const audit = new Map(); // protocol_id -> { gates: {rowId: before}, linked: {rowId: productId} }
  const entry = (id) => { if (!audit.has(id)) audit.set(id, { gates: {}, linked: {} }); return audit.get(id); };
  const unresolved = new Set();

  for (const row of rows) {
    if (!row.product_id) {
      const productId = resolve(row.product_name);
      if (productId) {
        await knex('lawn_protocol_products').where({ id: row.id }).update({ product_id: productId, updated_at: knex.fn.now() });
        entry(row.protocol_id).linked[row.id] = productId;
      } else unresolved.add(row.product_name);
    }
    const gates = asObject(row.gates);
    const kept = Object.fromEntries(Object.entries(gates).filter(([key]) => KEPT_GATE_KEYS.has(key)));
    if (Object.keys(kept).length !== Object.keys(gates).length) {
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(kept), updated_at: knex.fn.now() });
      entry(row.protocol_id).gates[row.id] = gates;
    }
  }
  if (unresolved.size) {
    throw new Error(`lawn v13: no products_catalog row or alias for: ${[...unresolved].sort().join('; ')}`);
  }

  for (const [protocolId, changes] of audit) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261005130000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: AUDIT_ACTION,
      changed_fields: JSON.stringify(['product_id', 'gates']),
      before_snapshot: JSON.stringify({ gates: changes.gates }),
      after_snapshot: JSON.stringify({ linked: changes.linked }),
      metadata: JSON.stringify({ migration: '20261005130000_lawn_v13_catalog_rows_and_product_links', gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: AUDIT_ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    for (const [rowId, gates] of Object.entries(asObject(log.before_snapshot).gates || {})) {
      await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates) });
    }
    for (const [rowId, productId] of Object.entries(asObject(log.after_snapshot).linked || {})) {
      await knex('lawn_protocol_products').where({ id: rowId, product_id: productId }).update({ product_id: null });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.PRODUCTS = PRODUCTS;
exports.KEPT_GATE_KEYS = KEPT_GATE_KEYS;
