/**
 * Lawn protocol v13, April feeding on the 12x plan becomes one long-release nitrogen bag (owner 2026-10-22,
 * "lets go ahead and do this"). One migration.
 *
 * Why. The April feeding (LESCO 24-0-11 with PolyPlus OPTI, 2.1 lb per 1,000 sq ft, 0.5 lb N) ran out before summer.
 * The state nitrogen ban runs June 1 to September 30. The new bag is LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass
 * Granular Fertilizer (SiteOne 511333, 50 lb bag, available by request): all of its nitrogen is polymer coated and
 * releases over about 3 to 4 months, so one pass in April carries the lawn into July. Rate: 2.27 lb of product per
 * 1,000 sq ft = 1.0 lb N (2.27 x 0.44 = 0.9988; the plan derives the rate from the 1.0 lb N target, 1.0 / 0.44).
 * The 12x year gains 0.5 lb N: 3.18 to 3.68 lb N per 1,000 sq ft, under the 4 lb a year in every ordinance row.
 *
 * What this does not touch. The 9x plan April row (LESCO Dimension 0.21% 18-0-10, 2.78 lb, 0.5 lb N) keeps its
 * product, rate and gates. The February and November 24-0-11 rows stay. North Port keeps its hold: the staged April
 * row carries gates.northPortBlocked and the new product carries nitrogen, so the ordinance block (N from April 1 in
 * North Port) reads it exactly as it read the 24-0-11; the April visit there is Nutra-TECH only.
 *
 * What this writes.
 *   1. Catalog. The product is looked up by exact name AND by exact alias. Nothing matches: one row is inserted
 *      (draft, internal only, needs_pricing). NO PRICE IS WRITTEN: the bag is "available by request" and has no
 *      quote yet; the price is set in Inventory later. An unpriced product plans, mixes and reports normally; its
 *      material cost reads null and the cost summary counts the line as unpriced. The inserted row carries the 0.25
 *      inch within 24 hours granular fertilizer watering rule (owner precedent of the 24-0-11 and 10-0-22; the label
 *      was not read for it) and is approved for the service report with a plain customer summary.
 *      A row that already matches is NEVER filled or changed. It must already be right for the plan and the
 *      nitrogen-ban checks: active, analysis_n 44, no phosphorus or potassium, slow_release_n_pct 100. Anything
 *      else (an inactive row, which the plan engine does not load, or a stale analysis, which would hide the
 *      nitrogen from the North Port block) makes up() THROW before it writes anything, naming the row and the
 *      field; staff fix the row and the migration is run again. Its approval, watering rule, rate and copy stay
 *      staff's. More than one matching row also throws (nothing is linked by guess).
 *   2. The staged April row of every v13 protocol: the 12x row named for the 24-0-11 becomes the 44-0-0 (name,
 *      product id) with gates.targetN '1.0 lb N/1000'. The row stays a lb_n row: the plan derives the rate from the
 *      visit's N target and the product's analysis. Its other gates (blackoutSensitive, northPortBlocked,
 *      planVisitsPerYear 12) and the window are not touched. A protocol whose April window has no 24-0-11 row, or
 *      already has the 44-0-0, is skipped.
 *
 * Future visits only. Planning reads the live staged rows for an open April visit. A closed visit keeps what it
 * recorded: its service_products rows carry the product and amount applied, and the report facts frozen at completion
 * (approved_report_product_facts); nothing here rewrites either. No v13 April visit has closed yet.
 *
 * Idempotent: a second run changes nothing. One 'v13_april_polymer_n' audit row per protocol records each staged value
 * before and after; one 'v13_april_polymer_n_catalog' row records the catalog row this INSERTED (the marker down()
 * reads). Linking an existing row writes no catalog audit row: nothing in the catalog changes.
 *
 * down(), exact-equality guarded, and safe once a visit references the protocol:
 *   - a protocol that a scheduled visit or a completion references is NOT touched: the rollback logs and leaves its
 *     rows and audit row;
 *   - an unreferenced protocol's April row goes back to the 24-0-11 only while it is still the 44-0-0 row this wrote
 *     (name and product id), and each gate key only while it holds the written value;
 *   - the catalog row is deleted only if THIS migration inserted it (its catalog audit row), no v13 protocol is
 *     referenced at all, no protocol row still links it, it is unchanged (every written field, the four workflow
 *     values too), unpriced, and nothing references it (any foreign key, any table). A pre-existing row is never
 *     touched, by up() or by down().
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_april_polymer_n';
const CATALOG_ACTION = 'v13_april_polymer_n_catalog';
const ACTOR = 'migration 20261022194000';
const MIGRATION = '20261022194000_lawn_v13_april_polymer_n_v2';
const APRIL_WINDOW = 'apr_v13_spreader_feeding';
const OLD_NAME = staged.NAMES.F24;
const NEW_NAME = 'LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass Granular Fertilizer';

// 2.27 lb x 44% = 0.9988 lb N, shown as 1.0 lb N (the plan derives 1.0 / 0.44 = 2.2727 lb).
const APRIL_RATE = 2.27;
const OLD_TARGET_N = '0.5 lb N/1000';
const NEW_GATES = { targetN: '1.0 lb N/1000' };

const VERIFIED_AT = '2026-10-22T00:00:00.000Z';
const VERIFIED_BY = 'owner-rule-2026-10-22';
// Same shape and values as the 24-0-11 and 10-0-22 rules: 0.25 inch within 24 hours.
const WATERING_RULE = {
  mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner',
  label_note: 'Owner: 0.25 inch within 24 hours, the granular fertilizer rule the LESCO 24-0-11 and 10-0-22 carry. The label was not read for this rule.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const SUMMARY = 'A slow-release nitrogen fertilizer. Its coating releases the feeding slowly over about 3 to 4 months, so the lawn keeps feeding into summer.';
const PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf. Watering-in follows the visit notes. No re-entry wait once watered in and dry.';

// The inserted row. Price fields are never written: needs_pricing stays true until a price is set in Inventory.
const CATALOG = {
  name: NEW_NAME,
  display_name: 'LESCO 44-0-0 Turf Fertilizer',
  category: 'fertilizer',
  product_type: 'fertilizer',
  manufacturer: 'LESCO / SiteOne',
  active_ingredient: 'Polymer-coated nitrogen fertilizer',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  siteone_sku: '511333',
  epa_reg_number: 'N/A',
  analysis_n: 44,
  analysis_p: 0,
  analysis_k: 0,
  slow_release_n_pct: 100,
  default_rate_per_1000: APRIL_RATE,
  rate_unit: 'lb',
  label_source_note: 'LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass Granular Fertilizer, SiteOne 511333, 50 lb bag, available by request. 100% polymer-coated nitrogen, released over about 3 to 4 months. April on the 12x plan: 2.27 lb per 1,000 sq ft = 1.0 lb N (owner 2026-10-22). The product label was not read for this row. No price written: set it in Inventory when SiteOne quotes it.',
  public_summary: SUMMARY,
  service_report_summary: SUMMARY,
  customer_precaution_summary: PRECAUTION,
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

// Every catalog row that spells the name exactly (normalized) or has an exact alias for it.
async function matchingRows(knex, name) {
  const wanted = normalize(name);
  const rows = (await knex('products_catalog').select('id', 'name', 'active', 'analysis_n', 'analysis_p', 'analysis_k', 'slow_release_n_pct'))
    .filter((row) => normalize(row.name) === wanted);
  const ids = new Set(rows.map((row) => String(row.id)));
  if (await knex.schema.hasTable('product_aliases')) {
    const aliases = (await knex('product_aliases').select('product_id', 'alias_name')).filter((row) => normalize(row.alias_name) === wanted);
    const extra = aliases.map((row) => row.product_id).filter((id) => !ids.has(String(id)));
    if (extra.length) rows.push(...await knex('products_catalog').whereIn('id', extra).select('id', 'name', 'active', 'analysis_n', 'analysis_p', 'analysis_k', 'slow_release_n_pct'));
  }
  return rows;
}

// What is wrong with an existing row for the 12x April step, as a list of plain sentences (empty: it is right).
function rowProblems(row) {
  const num = (value) => (value == null || String(value).trim() === '' ? null : Number(value));
  const problems = [];
  if (row.active !== true) problems.push('it is not active (the plan engine does not load an inactive product)');
  if (num(row.analysis_n) !== CATALOG.analysis_n) problems.push(`analysis_n is ${row.analysis_n ?? 'empty'}, not ${CATALOG.analysis_n} (the nitrogen-ban checks read it)`);
  if (Number(row.analysis_p || 0) !== 0) problems.push(`analysis_p is ${row.analysis_p}, not 0`);
  if (Number(row.analysis_k || 0) !== 0) problems.push(`analysis_k is ${row.analysis_k}, not 0`);
  if (num(row.slow_release_n_pct) !== CATALOG.slow_release_n_pct) problems.push(`slow_release_n_pct is ${row.slow_release_n_pct ?? 'empty'}, not ${CATALOG.slow_release_n_pct}`);
  return problems;
}

// Inserts the row when no name or alias spells it. A matching row is linked as it is when it is right, else this
// throws before anything is written. Never fills or changes an existing row. Returns what it did.
async function writeCatalog(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const known = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key in columns));
  const matches = await matchingRows(knex, NEW_NAME);

  if (matches.length > 1) {
    throw new Error(`lawn v13 April 44-0-0: ${matches.length} catalog rows match "${NEW_NAME}" by name or alias (ids ${matches.map((row) => row.id).join(', ')}); keep one, then run this migration again`);
  }
  if (matches.length === 1) {
    const [row] = matches;
    const problems = rowProblems(row);
    if (problems.length) {
      throw new Error(`lawn v13 April 44-0-0: the catalog row "${row.name}" (id ${row.id}) cannot be linked: ${problems.join('; ')}. Fix the row in Inventory, then run this migration again. Nothing was written.`);
    }
    return { productId: row.id, inserted: null };
  }

  const fields = known(CATALOG);
  const workflow = known(INSERT_DEFAULTS);
  const insert = { ...fields, ...workflow, created_at: knex.fn.now(), updated_at: knex.fn.now() };
  for (const column of JSON_COLUMNS) if (column in insert) insert[column] = JSON.stringify(insert[column]);
  const [made] = await knex('products_catalog').insert(insert).returning('id');
  return { productId: made && typeof made === 'object' ? made.id : made, inserted: { ...fields, ...workflow } };
}

// ── Staged rows ──────────────────────────────────────────────────────────────

// Writes the new name, product id and gate keys onto a staged row; returns what it recorded, read BEFORE the write.
async function patchRow(knex, row, productId) {
  const gates = asObject(row.gates);
  const record = {
    rowId: row.id,
    guard: { product_name: NEW_NAME, product_id: productId },
    columns: { product_name: { before: row.product_name, after: NEW_NAME }, product_id: { before: row.product_id ?? null, after: productId } },
    gates: {},
  };
  const next = { ...gates };
  for (const [key, after] of Object.entries(NEW_GATES)) {
    record.gates[key] = { had: key in gates, before: gates[key] ?? null, after };
    next[key] = after;
  }
  await knex('lawn_protocol_products').where({ id: row.id }).update({
    product_name: NEW_NAME, product_id: productId, gates: JSON.stringify(next), updated_at: knex.fn.now(),
  });
  return record;
}

// Puts back each column and gate key of a record that still holds the written value, and only on a
// row that is still the 44-0-0 row this wrote.
async function revertRow(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  const { product_name: name, product_id: productId } = record.guard;
  if (!row || row.product_name !== name || String(row.product_id) !== String(productId)) return;
  const update = { updated_at: knex.fn.now() };
  for (const [column, change] of Object.entries(record.columns || {})) {
    if (same(row[column], change.after)) update[column] = change.before;
  }
  const gates = asObject(row.gates);
  for (const [key, change] of Object.entries(record.gates || {})) {
    if (!isDeepStrictEqual(gates[key], change.after)) continue;
    if (change.had) gates[key] = change.before; else delete gates[key];
  }
  update.gates = JSON.stringify(gates);
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
}

async function swapStagedRows(knex, productId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windows = (await knex('lawn_protocol_windows').where({ window_key: APRIL_WINDOW }).select('id', 'lawn_protocol_id'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id })
      .select('id', 'product_id', 'product_name', 'gates');
    const old = rows.find((row) => row.product_name === OLD_NAME);
    if (!old || rows.some((row) => row.product_name === NEW_NAME)) continue;
    const record = await patchRow(knex, old, productId);
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: window.lawn_protocol_id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: window.lawn_protocol_id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows: [record], oldTargetN: OLD_TARGET_N }),
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

  const written = await writeCatalog(knex);
  await swapStagedRows(knex, written.productId);
  // Only an INSERT is recorded (the marker down() reads). Linking an existing row changes nothing in the catalog.
  if (!written.inserted) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId: written.productId, inserted: written.inserted }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── Down ─────────────────────────────────────────────────────────────────────

// A protocol a scheduled visit or a completion points at: the staging migration's own guard.
async function protocolReferenced(knex, protocol) {
  if (await knex.schema.hasTable('scheduled_services')) {
    const visit = await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id');
    if (visit) return true;
  }
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  const completion = await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id');
  return Boolean(completion);
}

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

// Reverts one protocol's audit record; returns true when the protocol was left because it is referenced.
async function revertProtocol(knex, log) {
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-april-polymer-n] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  for (const record of asObject(log.after_snapshot).rows || []) await revertRow(knex, record);
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

// Deletes the row this inserted (its catalog audit row is the marker), only if it is still exactly as inserted,
// unpriced and unused. A pre-existing row has no such audit row and is never touched.
async function revertCatalog(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted) {
      const row = await knex('products_catalog').where({ id: productId }).first();
      // Unchanged: every written field as written (the workflow values too), and no price set on the row since.
      const unchanged = row && Object.entries(inserted).every(([column, value]) => same(row[column], value))
        && PRICE_FIELDS.every((column) => row[column] == null);
      const linked = await knex('lawn_protocol_products').where({ product_id: productId }).first('id');
      if (unchanged && !linked && !(await productReferenced(knex, productId))) await knex('products_catalog').where({ id: productId }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  for (const log of logs) await revertProtocol(knex, log);
  // The catalog row is shared by every protocol: keep it while ANY v13 protocol is referenced (also one this never swapped).
  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-april-polymer-n] catalog row kept: a visit or completion references ${V13_VERSION}`);
    return;
  }
  await revertCatalog(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.APRIL_WINDOW = APRIL_WINDOW;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.APRIL_RATE = APRIL_RATE;
exports.OLD_TARGET_N = OLD_TARGET_N;
exports.NEW_GATES = NEW_GATES;
exports.CATALOG = CATALOG;
exports.INSERT_DEFAULTS = INSERT_DEFAULTS;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: NEW_NAME, rule: WATERING_RULE }];
exports.SUMMARY = SUMMARY;
exports.PRECAUTION = PRECAUTION;
