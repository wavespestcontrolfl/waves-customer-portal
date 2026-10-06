/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: the October spreader product
 * becomes LESCO Dimension 0.21% 18-0-10 (owner 2026-10-06, "swap"), and every
 * Dimension 0.21% step drops to the label's per-application maximum. Migrations
 * 20261005120000 and the ones after it are pushed and frozen; this one changes
 * their data.
 *
 * Why. LESCO Stonewall 0.43% 15-0-15 (4.02 lb per 1,000 sq ft) is discontinued at
 * SiteOne. The replacement is LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45
 * MOP Pre-Emergent Plus Fertilizer (SiteOne 702032, EPA 10404-87), the bag the 9x
 * April step already uses.
 *
 * The rate. The one label read for this product (EPA 10404-87) says "DO NOT apply
 * more than 2.73 lb of this product per 1,000 sq ft per application" and "do not
 * make more than 3 applications per year spaced at least 2 to 4 months apart"; the
 * South/West 3-4 month control rate is 2.73 lb (0.25 lb ai per acre). So both the
 * October step and the 9x April step are 2.73 lb per 1,000 sq ft:
 *   0.49 lb N, 0.27 lb K2O, dithiopyr 0.0057 lb ai per 1,000 sq ft = 0.25 lb ai/acre.
 * The catalog's earlier max_label_rate_per_1000 of 5.48 lb (20261005130000) was a
 * web summary, never the label; a later bag label may allow more, and the owner
 * will read the bag.
 *
 * Part 1, the staged October row. In each staged v13 protocol's October window
 * (oct_v13_spreader_fall) the row named for Stonewall 15-0-15 becomes the Dimension
 * 18-0-10 row: product_name, product_id (the catalog row 20261005130000 inserted),
 * rate_per_1000 2.73, the targetN and targetK2O gate text, and the annual counter
 * name (dithiopyr, no longer prodiamine). The window goal text that names
 * "Stonewall 15-0-15" names Dimension 18-0-10. Nothing else on the row moves. The
 * old catalog row is left in place: catalog data is never deleted, and a
 * customer's history may reference it.
 *
 * Part 2, the 9x April Dimension row (inserted by 20261006150000 as a copy of the
 * 24-0-11 row: rate_unit lb_n, so the engine derived 2.778 lb from the 0.5 lb N
 * target). It now states its own rate, 2.73 lb, with targetN '0.49 lb N/1000'; the
 * engine uses a stated rate before a nutrient target. Rows that are not in that
 * shape (no such row, or an edited rate) are left alone.
 *
 * Part 3, the catalog row (products_catalog, exact name): max_label_rate_per_1000
 * 5.48 -> 2.73 and default_rate_per_1000 2.78 -> 2.73, each only while it still
 * holds the old value. The row's label limits (product_limits, match_type
 * 'product'): annual_max_apps 3 (hard block) and min_interval_days 60 (warning),
 * the same shapes the Celsius rows use. The engine has no per-application rate
 * limit type; the per-application maximum is the catalog max and the protocol rate.
 *
 * Part 4, one yearly dithiopyr cap across formulations, written the way
 * 20261006140000 did it for prodiamine: one annual_max_rate row per dithiopyr
 * product (match_type 'active_ingredient', match_value 'dithiopyr'), each in THAT
 * product's own rate unit per 1,000 sq ft, so application-limits adds Dimension 2EW
 * (March and June hose), Dimension 18-0-10 (April on the 9x plan, October) and any
 * other dithiopyr product up as shares of one cap with no conversion.
 *   cap per 1,000 sq ft           = 1.5 lb ai / 43.56         = 0.034435 lb ai
 *   Dimension 2EW (2 lb ai/gal)   = 0.034435 / (2 / 128)      = 2.2039 fl oz
 *   Dimension 0.21% granular      = 0.034435 / 0.0021         = 16.3977 lb
 * The v13 year, from the recipe: 12x = March 2EW 0.5 + June 2EW 0.5 fl oz (45.4%)
 * + October 2.73 lb (16.6%) = 62.0%; 9x adds April 2.73 lb (16.6%) = 78.7%. (March 2EW is in every plan.)
 * NEEDS LABEL CONFIRMATION: the repo has no stated yearly dithiopyr cap. 1.5 lb ai
 * per acre per year is the owner's 2026-10-01 label read (2.2 fl oz of 2EW per
 * 1,000 sq ft a year = 1.50 lb ai/acre). Change CAP_LB_AI_PER_ACRE in a new migration
 * if the label says otherwise.
 * Which rows: every products_catalog row whose active_ingredient starts with
 * "dithiopyr". The strength comes from the row: an "EW" figure in a liquid's name
 * (lb ai per gallon, "2EW" = 2), else the first percent in active_ingredient, else in
 * the name. A row with neither is skipped with a warning (application-limits then
 * names its history rows as unsized instead of counting them as nothing). A product
 * that already has its row is skipped.
 *
 * The prodiamine cap is untouched. It now counts only January Stonewall 4FL in the
 * v13 plan (0.5 fl oz = 45% of 1.1019 fl oz); the Stonewall granular cap rows stay
 * for any history already ledgered.
 *
 * Idempotent: a second run changes nothing. One 'v13_october_dimension' audit row
 * per protocol (and one catalog audit row) records every value before and after.
 *
 * down() (rollback order: this one first): each column, gate key and catalog value
 * goes back only while it still holds the value written here; a staged row someone
 * renamed since is left alone whole; the window goal goes back only while it still
 * reads the new text. The audit rows are deleted. Only the limit rows this migration
 * wrote are deleted (matched by their description).
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const april = require('./20261006150000_lawn_v13_april_9x_branch');

const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_october_dimension';
const CATALOG_ACTION = 'v13_october_dimension_catalog';
const OCTOBER_WINDOW = 'oct_v13_spreader_fall';
const APRIL_WINDOW = april.APRIL_WINDOW;
const OLD_NAME = staged.NAMES.STW15;
const NEW_NAME = april.DIMENSION;
// The label's per-application maximum for the 0.21% granular (EPA 10404-87).
const NEW_RATE = 2.73;
const OLD_GOAL = 'Stonewall 15-0-15 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.';
const NEW_GOAL = 'Dimension 18-0-10 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.';
// 2.73 lb x 18% = 0.49 lb N; 2.73 lb x 10% = 0.27 lb K2O.
const NEW_GATES = { targetN: '0.49 lb N/1000', targetK2O: '0.27 lb K2O/1000', annualCounter: 'dithiopyr_lb_per_1000' };
const NEW_COUNTER = { counter: NEW_GATES.annualCounter };
const APRIL_OLD_RATE_UNIT = 'lb_n';
const APRIL_GATES = { targetN: '0.49 lb N/1000' };

const CATALOG_OLD = { max_label_rate_per_1000: 5.48, default_rate_per_1000: 2.78 };
const CATALOG_NEW = { max_label_rate_per_1000: NEW_RATE, default_rate_per_1000: NEW_RATE };

const LIMIT_PREFIX = 'Dimension 0.21% label limit:';
const LIMIT_ROWS = [
  { limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: `${LIMIT_PREFIX} max 3 applications per year (EPA 10404-87).` },
  { limit_type: 'min_interval_days', limit_value: 60, limit_unit: 'days', severity: 'warning', description: `${LIMIT_PREFIX} applications spaced at least 2 to 4 months apart (EPA 10404-87); 60 days is the floor.` },
];

const MATCH_VALUE = 'dithiopyr';
const DESCRIPTION_PREFIX = 'Dithiopyr yearly cap, all products:';
const CAP_LB_AI_PER_ACRE = 1.5; // owner label read 2026-10-01; needs label confirmation (see header)
const SQFT_PER_ACRE = 43560;
const CAP_LB_AI_PER_1000 = CAP_LB_AI_PER_ACRE / (SQFT_PER_ACRE / 1000);

const round4 = (value) => Math.round(value * 10000) / 10000;
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const JSON_COLUMNS = new Set(['annual_counter']);

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

// The product's rate unit and how many lb ai one of that unit holds, or null.
function aiPerRateUnit(row) {
  const unit = String(row.rate_unit || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
  if (unit === 'fl oz') {
    const lbPerGal = /\b(\d+(?:\.\d+)?)\s*EW\b/i.exec(row.name || '');
    return lbPerGal ? { unit: 'fl oz', aiPerUnit: Number(lbPerGal[1]) / 128 } : null;
  }
  if (unit !== 'lb' && unit !== 'oz') return null;
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(row.active_ingredient || '') || /(\d+(?:\.\d+)?)\s*%/.exec(row.name || '');
  if (!percent || !(Number(percent[1]) > 0)) return null;
  const share = Number(percent[1]) / 100;
  return { unit, aiPerUnit: unit === 'lb' ? share : share / 16 };
}

async function resolveDimensionId(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(NEW_NAME));
  if (hit) return hit.id;
  if (await knex.schema.hasTable('product_aliases')) {
    const alias = (await knex('product_aliases').select('product_id', 'alias_name'))
      .find((row) => normalize(row.alias_name) === normalize(NEW_NAME));
    if (alias) return alias.product_id;
  }
  return null;
}

// Writes `columns` and `gateKeys` onto a staged row and returns what it recorded:
// every column and gate key with its value before and after, read BEFORE the write.
async function patchRow(knex, row, columns, gateKeys) {
  const gates = asObject(row.gates);
  const record = { rowId: row.id, guard: { column: 'product_name', value: columns.product_name || row.product_name }, columns: {}, gates: {} };
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

// Puts back each column and gate key of a record that still holds the written value.
async function revertRow(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  if (!row || row[record.guard.column] !== record.guard.value) return;
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

async function swapStagedRows(knex) {
  for (const table of ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windowsOf = async (key) => (await knex('lawn_protocol_windows').where({ window_key: key }).select('id', 'lawn_protocol_id', 'goal'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  const products = (window) => knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id })
    .select('id', 'product_id', 'product_name', 'rate_per_1000', 'rate_unit', 'gates', 'annual_counter');

  const records = new Map(); // protocol id -> { rows: [], goalWindowId }
  const recordFor = (protocolId) => {
    if (!records.has(protocolId)) records.set(protocolId, { rows: [], goalWindowId: null });
    return records.get(protocolId);
  };

  let dimensionId = null;
  for (const window of await windowsOf(OCTOBER_WINDOW)) {
    const rows = await products(window);
    const old = rows.find((row) => row.product_name === OLD_NAME);
    if (!old || rows.some((row) => row.product_name === NEW_NAME)) continue;
    dimensionId = dimensionId || await resolveDimensionId(knex);
    if (!dimensionId) throw new Error(`lawn v13: no products_catalog row or alias for ${NEW_NAME}`);
    const entry = recordFor(window.lawn_protocol_id);
    entry.rows.push(await patchRow(knex, old, {
      product_name: NEW_NAME, product_id: dimensionId, rate_per_1000: NEW_RATE, annual_counter: NEW_COUNTER,
    }, NEW_GATES));
    if (window.goal === OLD_GOAL) {
      await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal: NEW_GOAL, updated_at: knex.fn.now() });
      entry.goalWindowId = window.id;
    }
  }

  // The 9x April row: 2.78 lb (derived from the 0.5 lb N target) becomes the stated 2.73 lb.
  for (const window of await windowsOf(APRIL_WINDOW)) {
    const dimension = (await products(window)).find((row) => row.product_name === NEW_NAME);
    if (!dimension || Number(dimension.rate_per_1000) > 0 || String(dimension.rate_unit || '') !== APRIL_OLD_RATE_UNIT) continue;
    recordFor(window.lawn_protocol_id).rows.push(await patchRow(knex, dimension, { rate_per_1000: NEW_RATE, rate_unit: 'lb' }, APRIL_GATES));
  }

  for (const [protocolId, entry] of records) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007120000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products', 'goal']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows: entry.rows, goalWindowId: entry.goalWindowId, oldGoal: OLD_GOAL, newGoal: NEW_GOAL }),
      metadata: JSON.stringify({ migration: '20261007120000_lawn_v13_october_dimension', gate: 'GATE_LAWN_V13' }),
    });
  }
}

async function revertStagedRows(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    for (const record of after.rows || []) await revertRow(knex, record);
    if (after.goalWindowId) {
      const window = await knex('lawn_protocol_windows').where({ id: after.goalWindowId }).first('id', 'goal');
      if (window && window.goal === after.newGoal) await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal: after.oldGoal, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

async function writeCatalogAndLimits(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const catalog = await knex('products_catalog').where({ name: NEW_NAME }).select('id', 'name', 'max_label_rate_per_1000', 'default_rate_per_1000');
  const changes = {};
  for (const row of catalog) {
    const patch = {};
    for (const column of Object.keys(CATALOG_OLD)) {
      if (same(row[column], CATALOG_OLD[column])) patch[column] = { before: row[column], after: CATALOG_NEW[column] };
    }
    if (!Object.keys(patch).length) continue;
    changes[row.id] = patch;
    await knex('products_catalog').where({ id: row.id }).update({
      ...Object.fromEntries(Object.entries(patch).map(([column, change]) => [column, change.after])), updated_at: knex.fn.now(),
    });
  }
  if (Object.keys(changes).length && await knex.schema.hasTable('lawn_protocol_audit_log')) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261007120000',
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(Object.keys(CATALOG_OLD)),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ changes }),
      metadata: JSON.stringify({ migration: '20261007120000_lawn_v13_october_dimension' }),
    });
  }

  if (!(await knex.schema.hasTable('product_limits'))) return;
  for (const row of catalog) {
    const have = new Set((await knex('product_limits').where({ product_id: row.id }).select('limit_type')).map((limit) => limit.limit_type));
    for (const limit of LIMIT_ROWS) {
      if (have.has(limit.limit_type)) continue;
      await knex('product_limits').insert({ product_id: row.id, match_type: 'product', ...limit });
    }
  }
}

// Each catalog column goes back only while it still holds the value this migration wrote.
async function revertCatalogRow(knex, catalogId, patch) {
  const row = await knex('products_catalog').where({ id: catalogId }).first();
  if (!row) return;
  const undo = {};
  for (const [column, change] of Object.entries(patch)) if (same(row[column], change.after)) undo[column] = change.before;
  if (Object.keys(undo).length) await knex('products_catalog').where({ id: catalogId }).update({ ...undo, updated_at: knex.fn.now() });
}

async function revertCatalogAndLimits(knex) {
  if (await knex.schema.hasTable('lawn_protocol_audit_log') && await knex.schema.hasTable('products_catalog')) {
    const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
    for (const log of logs) {
      for (const [catalogId, patch] of Object.entries(asObject(log.after_snapshot).changes || {})) await revertCatalogRow(knex, catalogId, patch);
      await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
    }
  }
  if (await knex.schema.hasTable('product_limits')) {
    const rows = await knex('product_limits').where({ match_type: 'product' }).select('id', 'description');
    for (const row of rows) {
      if (String(row.description || '').startsWith(LIMIT_PREFIX)) await knex('product_limits').where({ id: row.id }).del();
    }
  }
}

async function writeDithiopyrCaps(knex) {
  if (!(await knex.schema.hasTable('product_limits')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const catalog = await knex('products_catalog').select('id', 'name', 'active_ingredient', 'rate_unit');
  const products = catalog.filter((row) => String(row.active_ingredient || '').toLowerCase().startsWith(MATCH_VALUE));
  const have = new Set((await knex('product_limits')
    .where({ match_type: 'active_ingredient', match_value: MATCH_VALUE, limit_type: 'annual_max_rate' })
    .select('product_id')).map((row) => String(row.product_id)));

  for (const product of products) {
    if (have.has(String(product.id))) continue;
    const ai = aiPerRateUnit(product);
    if (!ai) {
      console.warn(`[lawn-v13-dithiopyr-cap] no strength for "${product.name}" (rate_unit ${product.rate_unit}); no cap row written`);
      continue;
    }
    const cap = round4(CAP_LB_AI_PER_1000 / ai.aiPerUnit);
    await knex('product_limits').insert({
      product_id: product.id,
      match_type: 'active_ingredient',
      match_value: MATCH_VALUE,
      limit_type: 'annual_max_rate',
      limit_value: cap,
      limit_unit: `${ai.unit}/1000sf/year`,
      severity: 'hard_block',
      description: `${DESCRIPTION_PREFIX} ${CAP_LB_AI_PER_ACRE} lb ai/acre/year (owner label read 2026-10-01; confirm on the label), written as ${cap} ${ai.unit} of ${product.name} per 1,000 sq ft. Every dithiopyr product shares this one cap.`,
    });
  }
}

async function removeDithiopyrCaps(knex) {
  if (!(await knex.schema.hasTable('product_limits'))) return;
  const rows = await knex('product_limits')
    .where({ match_type: 'active_ingredient', match_value: MATCH_VALUE, limit_type: 'annual_max_rate' })
    .select('id', 'description');
  for (const row of rows) {
    if (String(row.description || '').startsWith(DESCRIPTION_PREFIX)) await knex('product_limits').where({ id: row.id }).del();
  }
}

exports.up = async function up(knex) {
  await swapStagedRows(knex);
  await writeCatalogAndLimits(knex);
  await writeDithiopyrCaps(knex);
};

exports.down = async function down(knex) {
  await revertStagedRows(knex);
  await revertCatalogAndLimits(knex);
  await removeDithiopyrCaps(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.NEW_RATE = NEW_RATE;
exports.NEW_GATES = NEW_GATES;
exports.APRIL_GATES = APRIL_GATES;
exports.OLD_GOAL = OLD_GOAL;
exports.NEW_GOAL = NEW_GOAL;
exports.LIMIT_ROWS = LIMIT_ROWS;
exports.CATALOG_OLD = CATALOG_OLD;
exports.aiPerRateUnit = aiPerRateUnit;
exports.CAP_LB_AI_PER_1000 = CAP_LB_AI_PER_1000;
