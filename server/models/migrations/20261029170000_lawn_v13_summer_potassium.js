/**
 * Lawn protocol v13, summer liquid potassium on the August and September hose visits (owner 2026-10-29: "add it" to summer
 * potassium; the product, in his words: "LESCO 0-0-20 acetate"). One migration, deliberately small, in the shape of
 * 20261022195000 (#6494): it only INSERTS, and it rolls back all or nothing.
 *
 * Why. The live v13 protocol has no liquid potassium. The KTS (potassium thiosulfate) liquids SiteOne sells are not for
 * summer: the KTS maker says not to apply it to foliage above 30 C (86 F), and the K-Flow label says to use caution on
 * hot days. LESCO Nutra-TECH 0-0-20 K-Acetate (SiteOne 511644, 2.5 gal) is potassium acetate, a low salt index
 * potassium, and its label sets no heat or temperature limit. Both the 12x and the 9x plan run the August and September hose
 * visits (the 9x "rounds" build maps its round 6 to the August step and round 7 to the September step), so one staged row
 * in each window serves both.
 *
 * What this does not touch. No nitrogen and no phosphorus: the product is 0-0-20 (potash only), so the June to September ban reads it as
 * it reads Nutra-TECH (gates.requiresZeroNP). No existing row changes except one thing: a row after the Nutra-TECH row in
 * the same window moves down by one place in sort_order when the new row needs that place (recorded, and put back by
 * down()).
 *
 * up(), all in the migration's one transaction:
 *   1. If ANY catalog row matches the product by exact name or exact alias, in any state, up() THROWS and writes nothing.
 *      It never reads, fills, links or changes an existing row. The one exception is the row this migration inserted
 *      itself (its catalog audit row names the id): a re-run after a rollback that was a no-op finds its own row and
 *      carries on without inserting a second.
 *   2. Otherwise it INSERTS the full row: analysis 0-0-20, liquid, 2.5 gal jug, the default and label rates, the liquid
 *      fertilizer watering rule the owner gave K-Flow and Nutra-TECH (no watering change), approved for the service report
 *      with the approved liquid-fertilizer wording, draft, internal only, needs_pricing. NO PRICE AND NO VENDOR IS WRITTEN:
 *      the price is set in Inventory later. An unpriced product plans, mixes and reports normally; its material cost
 *      reads null and the cost summary counts it as unpriced.
 *   3. Every v13 protocol (all grass tracks the staged migration seeded) gets one staged row in the August and one in the
 *      September hose window, placed directly after the Nutra-TECH row: role potassium, broadcast, the same carrier and
 *      the whole-lawn pass (default_in_plan), gates requiresZeroNP, northPortProductWindow, and in September
 *      holdForTropicalWatch, as the Nutra-TECH row there. A window that already has the product, or has no Nutra-TECH row
 *      to follow, is skipped. One audit row per protocol records what was inserted and moved; one catalog audit row names
 *      the inserted product (the marker down() reads).
 *
 * North Port. The Nutra-TECH rows of June, August and September carry gates.northPortProductWindow (migration
 * 20261007150000). The plan reads that key on a row and holds the product back in North Port (not selected, no amount); a
 * completion that records it there is flagged. The new rows carry the same key, so the same code holds them back the same
 * way. The product has no N or P, so the nitrogen ban cannot see it; that key is the whole rule.
 *
 * Future visits only. Planning reads the live staged rows for an open visit. A closed visit keeps what it recorded.
 *
 * down() is all or nothing:
 *   - if ANY scheduled visit or completion references ANY v13 protocol, it does nothing and logs why;
 *   - if ANY row this inserted is no longer exactly as written, it does nothing and logs which;
 *   - otherwise it deletes every inserted row, puts back every moved sort_order that still reads what this wrote, and
 *     deletes the catalog row only if that row is still exactly as inserted (the four workflow values too), unpriced and
 *     referenced by nothing (any foreign key, any table). A changed, priced or used catalog row is kept, and so is its
 *     catalog audit row, so a later up() still knows the row is its own.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
// Short on purpose: audit_log.action is varchar(96) and `migration:${MIGRATION}:${column}` overflowed it once.
const MIGRATION = '20261029170000_lawn_v13_summer_potassium';
const ACTION = 'v13_summer_potassium';
const CATALOG_ACTION = 'v13_summer_potassium_catalog';
const ACTOR = 'migration 20261029170000';

// ── The product: every product-specific value lives in this ONE block ───────────────────────────────────────────────────
// Switching the product changes this block, the two recipe lines per track in lawn-protocol-v13.json (the exact text is LINE
// below), the visit note sentence (VISIT_SKIP) and the name-keyed maps (lawn-expectations.js, the admin inventory readiness
// list, SchedulePage.jsx, pricing.csv). The tests read this block.
//
// Source: the LESCO label, item 511644-2.5 (SiteOne, 2.5 gal at 10.3 lb per gal). Lawn care rate: 3 to 9 oz per 1,000 sq ft
// every 7 to 10 days in 1 to 3 gal of carrier water. The program uses 5 fl oz (about 0.08 lb K2O per 1,000 sq ft).
const PRODUCT = Object.freeze({
  name: 'LESCO Nutra-TECH 0-0-20 K-Acetate Turfgrass Liquid Fertilizer',
  displayName: 'LESCO Nutra-TECH 0-0-20 K-Acetate',
  descriptionKey: 'k-acetate', // the SchedulePage description map key: it must match only this product
  manufacturer: 'LESCO / SiteOne',
  activeIngredient: 'Potassium acetate',
  siteoneSku: '511644',
  containerSize: '2.5 gal',
  unitSizeOz: 320,
  analysisK: 20,
  rate: 5, // fl oz per 1,000 sq ft
  rateUnit: 'fl oz', // as written on the staged rows and the recipe line
  minLabel: 3,
  maxLabel: 9,
  labelUrl: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/nutra-tech-0-0-20-2.5-gal/nutra-tech-0-0-20-2.5-gal.pdf',
  sdsUrl: null,
  signalWord: 'Caution',
  ppeText: 'Safety glasses with side shields (or goggles) and water-repellent, chemical-resistant gloves.',
  labelSourceNote: 'LESCO label, item 511644-2.5: Soluble Potash (K2O) 20.00%, derived from potassium acetate; no N or P; 10.3 lb/gal; lawn care 3 to 9 oz per 1,000 sq ft every 7 to 10 days in 1 to 3 gal water; no heat or temperature limit.',
  wateringLabelNote: 'Label (LESCO Nutra-TECH 0-0-20 K-Acetate, 511644-2.5): no watering line after application. Owner: a liquid fertilizer needs no watering change (as LESCO K-Flow and LESCO Nutra-TECH).',
  compatibilityNote: 'Potassium acetate. Jar-test with LESCO Nutra-TECH T&O Micronutrient Package before the first full tank.',
  // Both products start with "Nutra-TECH", so the August and September visit notes name them apart.
  visitSkip: 'North Port: skip the Nutra-TECH micronutrients and the Nutra-TECH potassium on this visit until the city confirms.',
  verifiedBy: 'label-check-2026-10-29',
  verifiedAt: '2026-10-29T00:00:00.000Z',
});
const NAME = PRODUCT.name;
const RATE = PRODUCT.rate;
const MIN_LABEL = PRODUCT.minLabel;
const MAX_LABEL = PRODUCT.maxLabel;
// The recipe line the August and September visits carry, after the Nutra-TECH line.
const LINE = `${NAME} \u2014 ${RATE} ${PRODUCT.rateUnit} per 1,000 sq ft, hose`;

const NUTRA = staged.NAMES.NT;
const ROLE = 'potassium';
const AUG_WINDOW = 'aug_v13_hose_blackout';
const SEP_WINDOW = 'sep_v13_hose_blackout';
// One entry per window: the gates the new row carries, as the Nutra-TECH row of that window (requiresZeroNP; September also
// holds for a tropical watch) plus the North Port product-window key (see "North Port" above).
const WINDOWS = [
  { key: AUG_WINDOW, gates: { requiresZeroNP: true, northPortProductWindow: true } },
  { key: SEP_WINDOW, gates: { requiresZeroNP: true, holdForTropicalWatch: true, northPortProductWindow: true } },
];
// What a new staged row carries beside its window, product link, gates and place.
const ROW = { role: ROLE, application_mode: 'broadcast', rate_per_1000: RATE, rate_unit: PRODUCT.rateUnit, carrier_gal_per_1000: 1, default_in_plan: true };

// The label has no watering line; the owner's liquid fertilizer rule, stored on LESCO K-Flow and Nutra-TECH, applies: no watering change.
const WATERING_RULE = {
  mode: 'none', source: 'owner',
  label_note: PRODUCT.wateringLabelNote,
  verified_at: PRODUCT.verifiedAt, verified_by: PRODUCT.verifiedBy,
};

// Approved liquid-fertilizer wording, verbatim from 20261029030000 (K-Flow and the sister liquids).
const SUMMARY = 'A professional-grade liquid fertilizer feeding the documented turf or plants — supporting density, color, root development, and recovery.';
const PRECAUTION = 'Applied in liquid form to the treated areas. If any reaches walks or driveways, it rinses off with water. Watering-in follows the visit notes — treated areas are ready once dry, and your technician confirms timing.';
const REENTRY = 'Water in per the visit notes; no re-entry wait once dry.';

// The inserted row. Price fields are never written: needs_pricing stays true until a price is set in Inventory.
const CATALOG = {
  name: NAME,
  display_name: PRODUCT.displayName,
  category: 'fertilizer',
  product_type: 'fertilizer',
  manufacturer: PRODUCT.manufacturer,
  active_ingredient: PRODUCT.activeIngredient,
  formulation: 'liquid',
  container_size: PRODUCT.containerSize,
  unit_size_oz: PRODUCT.unitSizeOz,
  siteone_sku: PRODUCT.siteoneSku,
  signal_word: PRODUCT.signalWord,
  ppe_text: PRODUCT.ppeText,
  epa_reg_number: 'N/A',
  analysis_n: 0,
  analysis_p: 0,
  analysis_k: PRODUCT.analysisK,
  default_rate_per_1000: RATE,
  min_label_rate_per_1000: MIN_LABEL,
  max_label_rate_per_1000: MAX_LABEL,
  rate_unit: 'fl_oz',
  inventory_unit: 'fl_oz',
  mixing_order_category: 'liquid_fertilizer',
  label_url: PRODUCT.labelUrl,
  ...(PRODUCT.sdsUrl ? { sds_url: PRODUCT.sdsUrl } : {}),
  label_source_note: PRODUCT.labelSourceNote,
  compatibility_notes: PRODUCT.compatibilityNote,
  public_summary: SUMMARY,
  service_report_summary: SUMMARY,
  customer_precaution_summary: PRECAUTION,
  reentry_summary: REENTRY,
  approved_for_service_report: true,
  post_application_watering: WATERING_RULE,
};
// What the insert also sets, beside the CATALOG fields; part of the "unchanged" test in down().
const INSERT_DEFAULTS = Object.freeze({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
const JSON_COLUMNS = new Set(['post_application_watering']);
// Never written here; a value in any of them means someone priced the row after this inserted it.
const PRICE_FIELDS = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

const numberOrNull = (value) => (value == null ? null : Number(value));

// Two column values are the same: numbers by value (pg decimals arrive as strings), dates by time, JSON deeply.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

// ── up ───────────────────────────────────────────────────────────────────────

// Ids of every catalog row that spells the name exactly (normalized) or has an exact alias for it, in any state.
async function matchingIds(knex, name) {
  const wanted = normalize(name);
  const ids = new Set((await knex('products_catalog').select('id', 'name')).filter((row) => normalize(row.name) === wanted).map((row) => String(row.id)));
  if (await knex.schema.hasTable('product_aliases')) {
    for (const row of await knex('product_aliases').select('product_id', 'alias_name')) if (normalize(row.alias_name) === wanted) ids.add(String(row.product_id));
  }
  return [...ids];
}

// The id of the catalog row an earlier run of THIS migration inserted, else null.
async function ownInsertedId(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted && productId) return String(productId);
  }
  return null;
}

async function insertCatalog(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const known = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key in columns));
  const fields = known(CATALOG);
  const workflow = known(INSERT_DEFAULTS);
  const insert = { ...fields, ...workflow, created_at: knex.fn.now(), updated_at: knex.fn.now() };
  for (const column of JSON_COLUMNS) if (column in insert) insert[column] = JSON.stringify(insert[column]);
  const [made] = await knex('products_catalog').insert(insert).returning('id');
  const productId = made && typeof made === 'object' ? made.id : made;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId, inserted: { ...fields, ...workflow } }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
  return productId;
}

// The row as it is written: what the audit row records and what down() compares.
function rowSpec(windowSpec, productId, sortOrder) {
  return { ...ROW, product_name: NAME, product_id: productId, gates: windowSpec.gates, sort_order: sortOrder };
}

// Inserts the product's row into the August and September window of every v13 protocol, directly after the Nutra-TECH row.
async function insertStagedRows(knex, productId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  for (const protocol of protocols) {
    const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).select('id', 'window_key');
    const inserted = [];
    const shifted = [];
    for (const windowSpec of WINDOWS) {
      const window = windows.find((candidate) => candidate.window_key === windowSpec.key);
      if (!window) continue;
      const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select('id', 'product_id', 'product_name', 'sort_order');
      if (rows.some((row) => row.product_name === NAME || (row.product_id != null && String(row.product_id) === String(productId)))) continue;
      const nutra = rows.find((row) => row.product_name === NUTRA);
      if (!nutra) continue;
      const place = Number(nutra.sort_order) + 1;
      // Rows from the Nutra-TECH row on down keep their order; those at or past the new place move down one.
      for (const row of rows.filter((candidate) => candidate.id !== nutra.id && Number(candidate.sort_order) >= place)) {
        const to = Number(row.sort_order) + 1;
        await knex('lawn_protocol_products').where({ id: row.id }).update({ sort_order: to, updated_at: knex.fn.now() });
        shifted.push({ rowId: row.id, from: Number(row.sort_order), to });
      }
      const spec = rowSpec(windowSpec, productId, place);
      const [made] = await knex('lawn_protocol_products').insert({
        lawn_protocol_window_id: window.id,
        product_id: productId,
        product_name: NAME,
        role: spec.role,
        application_mode: spec.application_mode,
        rate_per_1000: spec.rate_per_1000,
        rate_unit: spec.rate_unit,
        carrier_gal_per_1000: spec.carrier_gal_per_1000,
        default_in_plan: spec.default_in_plan,
        gates: JSON.stringify(spec.gates),
        annual_counter: JSON.stringify({}),
        mixing: JSON.stringify({}),
        report_copy: JSON.stringify({ role: spec.role }),
        sort_order: spec.sort_order,
      }).returning('id');
      inserted.push({ rowId: made && typeof made === 'object' ? made.id : made, windowId: window.id, windowKey: windowSpec.key, row: spec });
    }
    if (!inserted.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({ inserted: [], shifted: shifted.map(({ rowId, from }) => ({ rowId, sort_order: from })) }),
      after_snapshot: JSON.stringify({ rows: inserted, shifted }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (!(await knex('lawn_protocols').where({ version: V13_VERSION }).first('id'))) return;

  const matches = await matchingIds(knex, NAME);
  let productId;
  if (matches.length === 1 && matches[0] === await ownInsertedId(knex)) {
    // Our own row from an earlier run whose rollback did nothing (down() is all or nothing): carry on, insert nothing.
    productId = matches[0];
  } else if (matches.length) {
    throw new Error(`lawn v13 summer potassium: a catalog row named "${NAME}" already exists; this migration only inserts. Remove or rename it (catalog id ${matches.join(', ')}) and run this migration again. Nothing was written.`);
  } else {
    productId = await insertCatalog(knex);
  }
  await insertStagedRows(knex, productId);
};

// ── down ─────────────────────────────────────────────────────────────────────

// Any table that holds a foreign key to the product: a row there means the product is in use.
async function productReferenced(knex, productId) {
  const { rows } = await knex.raw(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'products_catalog'::regclass
  `);
  for (const { tbl, col } of rows) {
    if (await knex(tbl).where({ [col]: productId }).first(col)) return true;
  }
  return false;
}

// A recorded row is still exactly what up() wrote: same window, link, rate, mode, flags, gates and place.
async function rowAsWritten(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  const spec = record.row;
  return Boolean(row)
    && String(row.lawn_protocol_window_id) === String(record.windowId)
    && row.product_name === spec.product_name && String(row.product_id) === String(spec.product_id)
    && row.role === spec.role && row.application_mode === spec.application_mode
    && numberOrNull(row.rate_per_1000) === spec.rate_per_1000 && row.rate_unit === spec.rate_unit
    && numberOrNull(row.carrier_gal_per_1000) === spec.carrier_gal_per_1000 && row.default_in_plan === spec.default_in_plan
    && Number(row.sort_order) === spec.sort_order
    && isDeepStrictEqual(asObject(row.gates), spec.gates)
    && isDeepStrictEqual(asObject(row.annual_counter), {}) && isDeepStrictEqual(asObject(row.mixing), {})
    && isDeepStrictEqual(asObject(row.report_copy), { role: spec.role });
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const protocolLogs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  if (!protocolLogs.length && !catalogLogs.length) return;

  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-summer-potassium] rollback did nothing: a scheduled visit or completion references ${V13_VERSION}`);
    return;
  }
  const records = protocolLogs.flatMap((log) => asObject(log.after_snapshot).rows || []);
  for (const record of records) {
    if (!(await rowAsWritten(knex, record))) {
      console.log(`[lawn-v13-summer-potassium] rollback did nothing: row ${record.rowId} (${record.windowKey}) is no longer exactly as written`);
      return;
    }
  }

  for (const record of records) await knex('lawn_protocol_products').where({ id: record.rowId }).del();
  // A row that moved down one place goes back, but only while it still reads the place this gave it.
  for (const log of protocolLogs) {
    for (const move of asObject(log.after_snapshot).shifted || []) {
      const row = await knex('lawn_protocol_products').where({ id: move.rowId }).first('id', 'sort_order');
      if (row && Number(row.sort_order) === move.to) await knex('lawn_protocol_products').where({ id: move.rowId }).update({ sort_order: move.from, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }

  for (const log of catalogLogs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    const row = inserted && productId ? await knex('products_catalog').where({ id: productId }).first() : null;
    if (row) {
      // Unchanged: every written field as written (the workflow values too), and no price set on the row since.
      const unchanged = Object.entries(inserted).every(([column, value]) => same(row[column], value))
        && PRICE_FIELDS.every((column) => row[column] == null);
      if (!unchanged || (await productReferenced(knex, productId))) {
        // The row stays, and so does its catalog audit row: it is how a later up() knows the row is its own and
        // carries on, instead of throwing "already exists" on a product it inserted itself.
        console.log('[lawn-v13-summer-potassium] catalog row kept (changed, priced or in use); its audit row stays with it');
        continue;
      }
      await knex('products_catalog').where({ id: productId }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.PRODUCT = PRODUCT;
exports.LINE = LINE;
exports.VISIT_SKIP = PRODUCT.visitSkip;
exports.NAME = NAME;
exports.RATE = RATE;
exports.MIN_LABEL = MIN_LABEL;
exports.MAX_LABEL = MAX_LABEL;
exports.NUTRA = NUTRA;
exports.ROLE = ROLE;
exports.AUG_WINDOW = AUG_WINDOW;
exports.SEP_WINDOW = SEP_WINDOW;
exports.WINDOWS = WINDOWS;
exports.ROW = ROW;
exports.CATALOG = CATALOG;
exports.INSERT_DEFAULTS = INSERT_DEFAULTS;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: NAME, rule: WATERING_RULE }];
exports.SUMMARY = SUMMARY;
exports.PRECAUTION = PRECAUTION;
exports.REENTRY = REENTRY;
