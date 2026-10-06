/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: Dimension 0.21% 18-0-10 at the
 * COMMERCIAL label's rates (Codex round 1 on #6084). Migration 20261007120000 is
 * pushed and frozen. It wrote the NON-commercial maximum (2.73 lb per 1,000 sq ft);
 * Waves is a commercial applicator, and the current EPA master label for 10404-87
 * (amended 2025-01-17) says, under Sub-Label B Commercial:
 *   "DO NOT apply more than 5.46 lb of this product per 1,000 sq ft per application,
 *    and no more than 16.38 lb of this product per 1,000 sq ft per year (equivalent to
 *    1.5 lb of dithiopyr per acre)"; "do not make more than 3 applications per year ...
 *    spaced at least 2 to 4 months apart"; Table 1, Coastal South (FL), Program 1,
 *    pre-emergence on high-cut turf: 4.04 lb per 1,000 sq ft.
 *
 * What this moves, from what 20261007120000 wrote to the corrected values. Each value
 * changes only while it still holds the value 20261007120000 wrote, and is recorded
 * before and after in an audit row.
 *   - Staged October row (all grass types): 2.73 lb -> 4.04 lb per 1,000 sq ft, targetN
 *     '0.49 lb N/1000' -> '0.73 lb N/1000', targetK2O '0.27 ...' -> '0.4 lb K2O/1000'
 *     (4.04 lb x 18% = 0.73 lb N; x 10% = 0.40 lb K2O; 0.37 lb ai/acre).
 *   - Staged 9x April Dimension row: back to the shape 20261006150000 left, a rate
 *     derived from the 0.5 lb N target (rate_unit lb_n, no stated rate, targetN
 *     '0.5 lb N/1000' = 2.78 lb). 2.78 lb was within the commercial label.
 *   - Catalog row: max_label_rate_per_1000 -> 5.46 (the commercial per-application
 *     maximum; was 2.73 from 20261007120000, or the unverified 5.48), default rate back to
 *     2.78 (its earlier value, the 9x April rate).
 *   - Limit rows: the 60-day minimum interval becomes a hard block (Codex: the label
 *     interval is a restriction, not advice); a missing 3-a-year or interval row is
 *     written. The yearly dithiopyr cap rows keep 1.5 lb ai/acre (16.3977 lb of the
 *     granular, label 16.38) and their text now says the figure is label-verified.
 *   - Price: the catalog row is seeded with the SiteOne member price, $44.23 per 50 lb bag
 *     (best_price, best_vendor, cost_per_unit 0.8846 per lb, cost_unit lb, needs_pricing
 *     false), only where it has no price yet.
 * Catalog and limit rows are found by the product id the staged row links to (the
 * exact-name catalog row, else the alias row), the same resolution 20261007120000 used
 * for the staged rows, so an alias-resolved product is updated too.
 *
 * Idempotent: a second run finds nothing at the old values and changes nothing.
 * down() puts every recorded value back to what 20261007120000 wrote, field by field and
 * only while the field still holds what this migration wrote; deletes the limit rows it
 * inserted; deletes its audit rows. Roll back this one first, then 20261007120000.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const oct = require('./20261007120000_lawn_v13_october_dimension');
const april = require('./20261006150000_lawn_v13_april_9x_branch');

const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_october_dimension_commercial';
const OCTOBER_WINDOW = 'oct_v13_spreader_fall';
const APRIL_WINDOW = april.APRIL_WINDOW;
const NAME = oct.NEW_NAME;

const OCT_RATE = 4.04;
const FROM_RATE = oct.NEW_RATE; // 2.73, the non-commercial maximum 20261007120000 wrote
const OCT_GATES = { targetN: { from: '0.49 lb N/1000', to: '0.73 lb N/1000' }, targetK2O: { from: '0.27 lb K2O/1000', to: '0.4 lb K2O/1000' } };
const APRIL_GATES = { targetN: { from: '0.49 lb N/1000', to: '0.5 lb N/1000' } };
const CATALOG = {
  max_label_rate_per_1000: { from: [oct.NEW_RATE, 5.48], to: 5.46 },
  default_rate_per_1000: { from: [oct.NEW_RATE], to: 2.78 },
};
const PRICE = { best_price: 44.23, best_vendor: 'SiteOne', cost_per_unit: 0.8846, cost_unit: 'lb', needs_pricing: false };

const LIMIT_PREFIX = 'Dimension 0.21% label limit:';
const LIMIT_ROWS = [
  { limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: `${LIMIT_PREFIX} max 3 applications per year (EPA 10404-87 commercial label).` },
  { limit_type: 'min_interval_days', limit_value: 60, limit_unit: 'days', severity: 'hard_block', description: `${LIMIT_PREFIX} applications spaced at least 2 to 4 months apart (EPA 10404-87 commercial label); 60 days is the floor.` },
];
const CAP_PREFIX = 'Dithiopyr yearly cap, all products:';
const CAP_OLD_TEXT = '(owner label read 2026-10-01; confirm on the label)';
const CAP_NEW_TEXT = '(EPA 10404-87 commercial label: no more than 16.38 lb of product per 1,000 sq ft per year = 1.5 lb dithiopyr per acre)';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The id the staged rows link to: exact catalog name (active first), else an exact alias.
async function resolveDimensionId(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(NAME));
  if (hit) return hit.id;
  if (await knex.schema.hasTable('product_aliases')) {
    const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(NAME));
    if (alias) return alias.product_id;
  }
  return null;
}

// Moves a staged row from `from` to `to`, per field, only where it holds `from`.
// columns: { col: { from, to } }; gates: { key: { from, to } }. Returns the record or null.
async function moveRow(knex, row, columns, gateKeys) {
  const record = { rowId: row.id, columns: {}, gates: {} };
  const update = {};
  for (const [column, change] of Object.entries(columns)) {
    if (!same(row[column], change.from)) continue;
    record.columns[column] = { before: row[column] ?? null, after: change.to };
    update[column] = change.to;
  }
  const gates = asObject(row.gates);
  const next = { ...gates };
  for (const [key, change] of Object.entries(gateKeys)) {
    if (!isDeepStrictEqual(gates[key], change.from)) continue;
    record.gates[key] = { before: gates[key], after: change.to };
    next[key] = change.to;
  }
  if (Object.keys(record.gates).length) update.gates = JSON.stringify(next);
  if (!Object.keys(update).length) return null;
  await knex('lawn_protocol_products').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
  return record;
}

async function revertRow(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  if (!row) return;
  const update = {};
  for (const [column, change] of Object.entries(record.columns || {})) if (same(row[column], change.after)) update[column] = change.before;
  const gates = asObject(row.gates);
  let gatesChanged = false;
  for (const [key, change] of Object.entries(record.gates || {})) {
    if (!isDeepStrictEqual(gates[key], change.after)) continue;
    gates[key] = change.before;
    gatesChanged = true;
  }
  if (gatesChanged) update.gates = JSON.stringify(gates);
  if (Object.keys(update).length) await knex('lawn_protocol_products').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
}

async function moveStagedRows(knex) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windowsOf = async (key) => (await knex('lawn_protocol_windows').where({ window_key: key }).select('id', 'lawn_protocol_id'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  const byProtocol = new Map();
  const add = (protocolId, record) => {
    if (!record) return;
    if (!byProtocol.has(protocolId)) byProtocol.set(protocolId, []);
    byProtocol.get(protocolId).push(record);
  };
  const dimensionRows = async (window) => (await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id })
    .select('id', 'product_name', 'rate_per_1000', 'rate_unit', 'gates')).filter((row) => row.product_name === NAME);

  for (const window of await windowsOf(OCTOBER_WINDOW)) {
    for (const row of await dimensionRows(window)) {
      add(window.lawn_protocol_id, await moveRow(knex, row, { rate_per_1000: { from: FROM_RATE, to: OCT_RATE } }, OCT_GATES));
    }
  }
  for (const window of await windowsOf(APRIL_WINDOW)) {
    for (const row of await dimensionRows(window)) {
      // The row 20261007120000 restated: a stated 2.73 lb. Only that shape goes back to the derived rate.
      if (!same(row.rate_per_1000, FROM_RATE) || row.rate_unit !== 'lb') continue;
      add(window.lawn_protocol_id, await moveRow(knex, row, { rate_per_1000: { from: FROM_RATE, to: null }, rate_unit: { from: 'lb', to: 'lb_n' } }, APRIL_GATES));
    }
  }
  for (const [protocolId, rows] of byProtocol) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007130000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows }),
      metadata: JSON.stringify({ migration: '20261007130000_lawn_v13_october_dimension_commercial_rate', gate: 'GATE_LAWN_V13' }),
    });
  }
}

async function moveCatalogAndLimits(knex) {
  const id = await resolveDimensionId(knex);
  if (!id) return;
  const snapshot = { catalogId: id, catalog: {}, insertedLimitIds: [], limits: {}, caps: {} };
  const row = await knex('products_catalog').where({ id }).first();
  const update = {};
  for (const [column, change] of Object.entries(CATALOG)) {
    if (!change.from.some((value) => same(row[column], value))) continue;
    snapshot.catalog[column] = { before: row[column] ?? null, after: change.to };
    update[column] = change.to;
  }
  const unpriced = !(Number(row.best_price) > 0);
  if (unpriced) {
    for (const [column, value] of Object.entries(PRICE)) {
      snapshot.catalog[column] = { before: row[column] ?? null, after: value };
      update[column] = value;
    }
  }
  if (Object.keys(update).length) await knex('products_catalog').where({ id }).update({ ...update, updated_at: knex.fn.now() });

  const limits = await knex('product_limits').where({ product_id: id, match_type: 'product' }).select('id', 'limit_type', 'severity', 'description');
  for (const spec of LIMIT_ROWS) {
    const found = limits.find((limit) => limit.limit_type === spec.limit_type);
    if (!found) {
      const [inserted] = await knex('product_limits').insert({ product_id: id, match_type: 'product', ...spec }).returning('id');
      snapshot.insertedLimitIds.push(inserted && inserted.id !== undefined ? inserted.id : inserted);
    } else if (String(found.description || '').startsWith(LIMIT_PREFIX) && (found.severity !== spec.severity || found.description !== spec.description)) {
      snapshot.limits[found.id] = { before: { severity: found.severity, description: found.description }, after: { severity: spec.severity, description: spec.description } };
      await knex('product_limits').where({ id: found.id }).update({ severity: spec.severity, description: spec.description });
    }
  }

  const caps = await knex('product_limits').where({ match_type: 'active_ingredient', match_value: 'dithiopyr', limit_type: 'annual_max_rate' }).select('id', 'description');
  for (const cap of caps) {
    const text = String(cap.description || '');
    if (!text.startsWith(CAP_PREFIX) || !text.includes(CAP_OLD_TEXT)) continue;
    const after = text.replace(CAP_OLD_TEXT, CAP_NEW_TEXT);
    snapshot.caps[cap.id] = { before: text, after };
    await knex('product_limits').where({ id: cap.id }).update({ description: after });
  }

  if (Object.keys(snapshot.catalog).length || snapshot.insertedLimitIds.length || Object.keys(snapshot.limits).length || Object.keys(snapshot.caps).length) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261007130000',
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: ACTION,
      changed_fields: JSON.stringify(['catalog', 'limits']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(snapshot),
      metadata: JSON.stringify({ migration: '20261007130000_lawn_v13_october_dimension_commercial_rate' }),
    });
  }
}

async function revertCatalogAndLimits(knex, snapshot) {
  if (snapshot.catalogId !== undefined) {
    const row = await knex('products_catalog').where({ id: snapshot.catalogId }).first();
    if (row) {
      const undo = {};
      for (const [column, change] of Object.entries(snapshot.catalog || {})) if (same(row[column], change.after)) undo[column] = change.before;
      if (Object.keys(undo).length) await knex('products_catalog').where({ id: row.id }).update({ ...undo, updated_at: knex.fn.now() });
    }
  }
  for (const id of snapshot.insertedLimitIds || []) await knex('product_limits').where({ id }).del();
  for (const [id, change] of Object.entries(snapshot.limits || {})) {
    const row = await knex('product_limits').where({ id }).first('id', 'severity', 'description');
    if (!row) continue;
    const undo = {};
    if (row.severity === change.after.severity) undo.severity = change.before.severity;
    if (row.description === change.after.description) undo.description = change.before.description;
    if (Object.keys(undo).length) await knex('product_limits').where({ id }).update(undo);
  }
  for (const [id, change] of Object.entries(snapshot.caps || {})) {
    const row = await knex('product_limits').where({ id }).first('id', 'description');
    if (row && row.description === change.after) await knex('product_limits').where({ id }).update({ description: change.before });
  }
}

exports.up = async function up(knex) {
  for (const table of ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log', 'products_catalog', 'product_limits']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  await moveStagedRows(knex);
  await moveCatalogAndLimits(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    for (const record of after.rows || []) await revertRow(knex, record);
    if (after.catalogId !== undefined && await knex.schema.hasTable('product_limits')) await revertCatalogAndLimits(knex, after);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.OCT_RATE = OCT_RATE;
exports.OCT_GATES = OCT_GATES;
exports.APRIL_GATES = APRIL_GATES;
exports.LIMIT_ROWS = LIMIT_ROWS;
exports.PRICE = PRICE;
exports.CATALOG = CATALOG;
