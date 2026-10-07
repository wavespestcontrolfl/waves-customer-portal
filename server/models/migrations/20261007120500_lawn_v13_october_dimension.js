/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: the October spreader product
 * becomes LESCO Dimension 0.21% 18-0-10 (owner 2026-10-06, "swap"). One migration;
 * it replaces the six-migration chain of #6084, which never ran in production.
 *
 * Why. LESCO Stonewall 0.43% 15-0-15 is discontinued at SiteOne. The replacement is
 * LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer
 * (SiteOne 702032, EPA 10404-87), the bag the 9x April step already uses.
 *
 * The label (EPA 10404-87 master label, amended 2025-01-17, Commercial sub-label):
 *   - at most 5.46 lb of product per 1,000 sq ft per application;
 *   - at most 16.38 lb of product per 1,000 sq ft per year (1.5 lb dithiopyr per acre);
 *   - at most 3 applications per year, spaced at least 2 to 4 months apart;
 *   - Coastal South (FL), pre-emergence on high-cut turf: 4.04 lb per 1,000 sq ft.
 *
 * What this writes. Every other value stays exactly as main has it (the 9x April row
 * included).
 *   1. The staged October row of every v13 protocol (all four grass tracks): the row named
 *      for Stonewall 15-0-15 becomes Dimension 18-0-10 at 4.04 lb per 1,000 sq ft
 *      (0.73 lb N, 0.40 lb K2O, 0.37 lb dithiopyr per acre), with the product id, the N and
 *      K2O gate text, the annual counter and the window goal. The old catalog row stays.
 *   2. The Dimension product id is resolved ONCE (exact catalog name, else an exact alias)
 *      and used for every write below. No id = the migration throws and nothing is written.
 *   3. Catalog: max_label_rate_per_1000 becomes 5.46, only where it is NULL or the old
 *      unverified 5.48. Price fields are never touched; pricing stays with the vendor-pricing
 *      workflow.
 *   4. Limits, inserted for the resolved id only where no row of that limit_type exists:
 *      annual_max_apps 3 and min_interval_days 60, both hard_block. An existing row of the
 *      same type (an admin's, whatever its value or severity) is never changed.
 *   5. The yearly dithiopyr cap (annual_max_rate, match_type active_ingredient, match_value
 *      dithiopyr), one row per product in that product's own unit, inserted by explicit
 *      product id only where the product has none: the granular 16.38 lb, and Dimension 2EW
 *      2.2039 fl oz (1.5 lb ai per acre at 2 lb ai per gallon).
 *
 * The code half (application-limits.js scoping, previsit-brief.js and the plan engine's
 * derived April rate) ships in the same PR; these rows depend on it.
 *
 * Idempotent: a second run changes nothing. One 'v13_october_dimension' audit row per
 * protocol records each staged value before and after; one 'v13_october_dimension_catalog'
 * row records the catalog change and the id of every limit row inserted.
 *
 * down(), exact-equality guarded:
 *   - a staged row goes back only while it is still the Dimension row this wrote (name and
 *     product id), and each column and gate key only while it holds the written value; the
 *     window goal only while it reads the new text;
 *   - a protocol that a scheduled visit or a completion references is NOT touched (the same
 *     guard the staging migration uses): the rollback logs and leaves it, its audit row and
 *     the catalog and limit rows;
 *   - catalog and limit rows go back only when no protocol was left: the catalog max only
 *     while it still reads 5.46, each inserted limit row only while it still equals what was
 *     inserted.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const april = require('./20261006150000_lawn_v13_april_9x_branch');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_october_dimension';
const CATALOG_ACTION = 'v13_october_dimension_catalog';
const OCTOBER_WINDOW = 'oct_v13_spreader_fall';
const OLD_NAME = staged.NAMES.STW15;
const NEW_NAME = april.DIMENSION;
const NAME_2EW = staged.NAMES.DIM;

// Coastal South pre-emergence on high-cut turf (commercial sub-label, Table 1).
const OCT_RATE = 4.04;
const OLD_GOAL = 'Stonewall 15-0-15 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.';
const NEW_GOAL = 'Dimension 18-0-10 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.';
// 4.04 lb x 18% = 0.73 lb N; 4.04 lb x 10% = 0.40 lb K2O.
const NEW_GATES = { targetN: '0.73 lb N/1000', targetK2O: '0.4 lb K2O/1000', annualCounter: 'dithiopyr_lb_per_1000' };
const NEW_COUNTER = { counter: NEW_GATES.annualCounter };
const JSON_COLUMNS = new Set(['annual_counter']);

const MAX_LABEL = 5.46;
const MAX_LABEL_REPLACES = [5.48];

const LABEL = 'EPA 10404-87 commercial label';
const PRODUCT_LIMITS = [
  { limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: `Dimension 0.21% label limit: max 3 applications per year (${LABEL}).` },
  { limit_type: 'min_interval_days', limit_value: 60, limit_unit: 'days', severity: 'hard_block', description: `Dimension 0.21% label limit: applications spaced at least 2 to 4 months apart (${LABEL}); 60 days is the floor.` },
];

// 1.5 lb dithiopyr per acre per year, written in each product's own unit per 1,000 sq ft.
const CAP_MATCH = { match_type: 'active_ingredient', match_value: 'dithiopyr', limit_type: 'annual_max_rate', severity: 'hard_block' };
const CAP_GRANULAR = { limit_value: 16.38, limit_unit: 'lb/1000sf/year', description: `Dithiopyr yearly cap, all products: no more than 16.38 lb of product per 1,000 sq ft per year (${LABEL}) = 1.5 lb dithiopyr per acre per year.` };
// 1.5 lb ai / 43.56 = 0.034435 lb ai per 1,000 sq ft; 2EW holds 2 lb ai per gallon (2 / 128 per fl oz).
const CAP_2EW = { limit_value: Math.round((1.5 / 43.56 / (2 / 128)) * 10000) / 10000, limit_unit: 'fl oz/1000sf/year', description: 'Dithiopyr yearly cap, all products: 1.5 lb dithiopyr per acre per year (label).' };

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), JSON deeply.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

// Exact catalog name (active rows first), else an exact alias; null when neither exists.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

async function requireProductId(knex, name) {
  const id = await resolveProductId(knex, name);
  if (!id) throw new Error(`lawn v13: no products_catalog row or alias for ${name}`);
  return id;
}

// ── Staged rows ──────────────────────────────────────────────────────────────

// Writes `columns` and `gateKeys` onto a staged row and returns what it recorded:
// every value before and after, read BEFORE the write.
async function patchRow(knex, row, columns, gateKeys) {
  const gates = asObject(row.gates);
  const record = { rowId: row.id, guard: { product_name: columns.product_name, product_id: columns.product_id }, columns: {}, gates: {} };
  const update = { updated_at: knex.fn.now() };
  for (const [column, after] of Object.entries(columns)) {
    const current = JSON_COLUMNS.has(column) ? asObject(row[column]) : (row[column] ?? null);
    record.columns[column] = { before: current, after };
    update[column] = JSON_COLUMNS.has(column) ? JSON.stringify(after) : after;
  }
  const next = { ...gates };
  for (const [key, after] of Object.entries(gateKeys)) {
    record.gates[key] = { had: key in gates, before: gates[key] ?? null, after };
    next[key] = after;
  }
  update.gates = JSON.stringify(next);
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
  return record;
}

// Puts back each column and gate key of a record that still holds the written value, and
// only on a row that is still the Dimension row this wrote.
async function revertRow(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  const { product_name: name, product_id: productId } = record.guard;
  if (!row || row.product_name !== name || String(row.product_id) !== String(productId)) return;
  const update = { updated_at: knex.fn.now() };
  for (const [column, change] of Object.entries(record.columns || {})) {
    if (!same(row[column], change.after)) continue;
    update[column] = JSON_COLUMNS.has(column) ? JSON.stringify(change.before) : change.before;
  }
  const gates = asObject(row.gates);
  for (const [key, change] of Object.entries(record.gates || {})) {
    if (!isDeepStrictEqual(gates[key], change.after)) continue;
    if (change.had) gates[key] = change.before; else delete gates[key];
  }
  update.gates = JSON.stringify(gates);
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
}

async function swapStagedRows(knex, dimensionId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windows = (await knex('lawn_protocol_windows').where({ window_key: OCTOBER_WINDOW }).select('id', 'lawn_protocol_id', 'goal'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  const swapped = new Map(); // protocol id -> { rows, goalWindowId }
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id })
      .select('id', 'product_id', 'product_name', 'rate_per_1000', 'gates', 'annual_counter');
    const old = rows.find((row) => row.product_name === OLD_NAME);
    if (!old || rows.some((row) => row.product_name === NEW_NAME)) continue;
    const entry = { rows: [await patchRow(knex, old, { product_name: NEW_NAME, product_id: dimensionId, rate_per_1000: OCT_RATE, annual_counter: NEW_COUNTER }, NEW_GATES)], goalWindowId: null };
    if (window.goal === OLD_GOAL) {
      await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal: NEW_GOAL, updated_at: knex.fn.now() });
      entry.goalWindowId = window.id;
    }
    swapped.set(window.lawn_protocol_id, entry);
  }
  for (const [protocolId, entry] of swapped) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007120500',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products', 'goal']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows: entry.rows, goalWindowId: entry.goalWindowId, oldGoal: OLD_GOAL, newGoal: NEW_GOAL }),
      metadata: JSON.stringify({ migration: '20261007120500_lawn_v13_october_dimension', gate: 'GATE_LAWN_V13' }),
    });
  }
}

// ── Catalog, product limits and yearly caps ──────────────────────────────────

// max_label_rate_per_1000 -> 5.46, only from NULL or the old unverified 5.48. Returns the change or null.
async function writeCatalogMax(knex, productId) {
  const row = await knex('products_catalog').where({ id: productId }).first('id', 'max_label_rate_per_1000');
  const current = row ? row.max_label_rate_per_1000 : undefined;
  if (current === undefined || !(current == null || MAX_LABEL_REPLACES.some((old) => same(current, old)))) return null;
  await knex('products_catalog').where({ id: productId }).update({ max_label_rate_per_1000: MAX_LABEL, updated_at: knex.fn.now() });
  return { column: 'max_label_rate_per_1000', before: current ?? null, after: MAX_LABEL };
}

// Inserts each spec for `productId` that `exists` does not already cover; returns what it inserted.
async function insertMissing(knex, productId, specs, exists) {
  const inserted = [];
  for (const spec of specs) {
    if (await exists(spec)) continue;
    const row = { product_id: productId, ...spec };
    const [made] = await knex('product_limits').insert(row).returning('id');
    inserted.push({ id: made && typeof made === 'object' ? made.id : made, ...row });
  }
  return inserted;
}

const productLimitExists = (knex, productId) => async (spec) => Boolean(await knex('product_limits')
  .where({ product_id: productId, limit_type: spec.limit_type }).first('id'));

const capExists = (knex, productId) => async (spec) => Boolean(await knex('product_limits')
  .where({ product_id: productId, match_type: spec.match_type, match_value: spec.match_value, limit_type: spec.limit_type }).first('id'));

async function writeCatalogAndLimits(knex, dimensionId, id2ew) {
  const catalog = await writeCatalogMax(knex, dimensionId);
  const limits = await insertMissing(knex, dimensionId, PRODUCT_LIMITS.map((spec) => ({ match_type: 'product', ...spec })), productLimitExists(knex, dimensionId));
  const caps = [
    ...await insertMissing(knex, dimensionId, [{ ...CAP_MATCH, ...CAP_GRANULAR }], capExists(knex, dimensionId)),
    ...await insertMissing(knex, id2ew, [{ ...CAP_MATCH, ...CAP_2EW }], capExists(knex, id2ew)),
  ];
  if (!catalog && !limits.length && !caps.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261007120500',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog', 'limits']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId: dimensionId, catalog, limits, caps }),
    metadata: JSON.stringify({ migration: '20261007120500_lawn_v13_october_dimension' }),
  });
}

const REQUIRED_TABLES = [
  'products_catalog', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log',
];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const dimensionId = await requireProductId(knex, NEW_NAME);
  const id2ew = await requireProductId(knex, NAME_2EW);
  await swapStagedRows(knex, dimensionId);
  await writeCatalogAndLimits(knex, dimensionId, id2ew);
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

// Reverts one protocol's audit record; returns true when the protocol was left because it is referenced.
async function revertProtocol(knex, log) {
  const after = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-october-dimension] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  for (const record of after.rows || []) await revertRow(knex, record);
  if (after.goalWindowId) {
    const window = await knex('lawn_protocol_windows').where({ id: after.goalWindowId }).first('id', 'goal');
    if (window && window.goal === after.newGoal) await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal: after.oldGoal, updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

// Deletes an inserted limit row only while every field still equals what was inserted.
async function removeInsertedLimit(knex, written) {
  const row = await knex('product_limits').where({ id: written.id }).first();
  if (!row) return;
  const fields = ['product_id', 'match_type', 'match_value', 'limit_type', 'limit_value', 'limit_unit', 'severity', 'description'];
  if (fields.every((field) => same(row[field] ?? null, written[field] ?? null))) await knex('product_limits').where({ id: written.id }).del();
}

async function revertCatalogAndLimits(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { productId, catalog, limits = [], caps = [] } = asObject(log.after_snapshot);
    if (catalog) {
      const row = await knex('products_catalog').where({ id: productId }).first('id', catalog.column);
      if (row && same(row[catalog.column], catalog.after)) await knex('products_catalog').where({ id: productId }).update({ [catalog.column]: catalog.before, updated_at: knex.fn.now() });
    }
    for (const written of [...limits, ...caps]) await removeInsertedLimit(knex, written);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, ['lawn_protocol_audit_log', 'lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocols', 'products_catalog', 'product_limits']))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  let kept = 0;
  for (const log of logs) if (await revertProtocol(knex, log)) kept += 1;
  if (kept) {
    console.log('[lawn-v13-october-dimension] catalog and limit rows kept: a protocol still uses the Dimension row');
    return;
  }
  await revertCatalogAndLimits(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.NAME_2EW = NAME_2EW;
exports.OCT_RATE = OCT_RATE;
exports.NEW_GATES = NEW_GATES;
exports.OLD_GOAL = OLD_GOAL;
exports.NEW_GOAL = NEW_GOAL;
exports.MAX_LABEL = MAX_LABEL;
exports.PRODUCT_LIMITS = PRODUCT_LIMITS;
exports.CAP_GRANULAR = CAP_GRANULAR;
exports.CAP_2EW = CAP_2EW;
