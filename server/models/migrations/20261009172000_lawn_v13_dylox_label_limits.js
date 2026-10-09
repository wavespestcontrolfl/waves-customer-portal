/**
 * Lawn protocol v13: the label limits of Dylox 6.2 G Granular Insecticide (owner 2026-10-09, read from the label).
 *
 * Label (Dylox 6.2 Granular Insecticide, EPA Reg. No. 432-1308): "Limit the number of applications to turf to 3 per
 * calendar year with minimum retreatment intervals of 7 days." and "Limit the total of all applications to 24.5 lbs of
 * active ingredient per acre per year for controlling mole crickets and grubs and to 16.2 lbs ... per acre per year for
 * controlling surface feeding insects." The app had no limit for the product: no product_limits row, and the four staged v13
 * rows (one per grass track, October window, role insect_curative) carried no count.
 *
 * What this writes. Nothing is inserted into the catalog; the product is the row resolved by exact name, else exact alias.
 * No row: nothing at all is written (logged).
 *   1. Product limits, all hard blocks:
 *        annual_max_apps    3 applications  (per calendar year: a stored product_limits row is counted by the evaluator over
 *                                            the calendar year of the day judged; only a v13 cap ENTRY with yearWindow
 *                                            'rolling365' counts 365 days, and Dylox has no such entry, so the label's
 *                                            "per calendar year" is what the row means)
 *        min_interval_days  7 days
 *        annual_max_rate    9.07 lb of product per 1,000 sq ft a year, the grub and mole cricket cap: 24.5 lb active
 *                           ingredient per acre / 0.062 = 395.2 lb product per acre = 9.0715 lb per 1,000 sq ft, written
 *                           rounded down. Stored as an 'active_ingredient' row (match_value 'trichlorfon', unit
 *                           'lb/1000sf/year'): the one stored shape that application-limits sizes per 1,000 sq ft (the recorded
 *                           rate, else the quantity over the treated area, else the catalog rate; and the dose being
 *                           planned), the shape the prodiamine caps use. The surface feeder cap (16.2 lb ai per acre = 5.99 lb
 *                           per 1,000 sq ft) is NOT a row: the app does not record which pest a pass was for, so it is
 *                           recipe text only. Reader note: the shared ingredient key also reads a Dylox 420 SL pass of the year
 *                           as an earlier application it cannot size (it has no row), so a Dylox 6.2 G check on such a lawn
 *                           carries an info note, never a block.
 *      Each type is inserted when the product has none that already enforces it; a weaker row (more than 3 a year, fewer
 *      than 7 days, more than 9.07 lb, not a hard block) is tightened, its fields before are kept in the audit row. Dylox 420 SL T&O is a
 *      different catalog row and is not touched. A stored row applies with GATE_LAWN_V13 on or off, so
 *      config/lawn-v13-count-caps.js is NOT changed: a synthetic entry there would only duplicate these rows.
 *   2. Staged protocols (every protocol of version 2026.10-v13): each active (not retired) Dylox 6.2 G row gets
 *      gates.annualMaxApps 3 and gates.minIntervalDays 7 where the key is absent (the key names the 20260630000002
 *      seed and migration 20261007175000 use). A key a row already carries is left. annual_counter is not written.
 *
 * Idempotent: a second run finds the limits in place and the keys present and writes nothing. One 'v13_dylox_label_limits'
 * audit row per protocol that changed (the rows and the keys added) and one 'v13_dylox_label_limits_catalog' row for the
 * limits.
 *
 * down(), exact-equality guarded: a gate key is removed only while it still holds the value written; a limit this inserted
 * is deleted only while every field still reads as inserted; a limit this tightened goes back to its fields before only
 * while it still reads as written. Anything edited since stays as it is.
 *
 * Older down() functions. 20261005160000 (round 3) removes the gate keys it restored, key by key and by value
 * (annualMaxApps and minIntervalDays are not among them); 20261007175000 and 20261008130000 read Celsius, Arena and
 * Certainty rows; 20261005120000 deletes a whole protocol that nothing references, whatever its gates hold. None reads
 * a Dylox 6.2 G gate or limit, so none behaves differently after this write.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = staged.V13_VERSION;
const DYLOX = staged.NAMES.DYL;
const ACTION = 'v13_dylox_label_limits';
const CATALOG_ACTION = 'v13_dylox_label_limits_catalog';
const ACTOR = 'migration 20261009172000';
const MIGRATION = '20261009172000_lawn_v13_dylox_label_limits';
const LABEL = 'Dylox 6.2 G label, EPA Reg. No. 432-1308';
const QUOTE = '"Limit the number of applications to turf to 3 per calendar year with minimum retreatment intervals of 7 days."';

const AMOUNT_QUOTE = '"Limit the total of all applications to 24.5 lbs of active ingredient per acre per year for controlling mole crickets and grubs"';

const GATE_KEYS = { annualMaxApps: 3, minIntervalDays: 7 };

const LIMITS = [
  {
    match_type: 'product', limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block',
    description: `Dylox 6.2 G Granular Insecticide: at most 3 applications to turf per calendar year (${LABEL}: ${QUOTE})`,
  },
  {
    match_type: 'product', limit_type: 'min_interval_days', limit_value: 7, limit_unit: 'days', severity: 'hard_block',
    description: `Dylox 6.2 G Granular Insecticide: at least 7 days between applications to turf (${LABEL}: ${QUOTE})`,
  },
  {
    match_type: 'active_ingredient', match_value: 'trichlorfon', limit_type: 'annual_max_rate', limit_value: 9.07, limit_unit: 'lb/1000sf/year', severity: 'hard_block',
    description: `Dylox 6.2 G Granular Insecticide: no more than 9.07 lb of product per 1,000 sq ft a year for mole crickets and grubs (${LABEL}: ${AMOUNT_QUOTE}; 24.5 lb active ingredient per acre at 6.2% = 395 lb product per acre = 9.07 lb per 1,000 sq ft)`,
  },
];

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

// ── Limits ───────────────────────────────────────────────────────────────────

// A limit row of the same match: the product itself, or the same active ingredient key.
const sameMatch = (limit, row) => (limit.match_value
  ? row.match_type === limit.match_type && row.match_value === limit.match_value
  : row.match_type == null || row.match_type === 'product');

// A stored row already enforces the label when it is a hard block of the same match and no looser than the label:
// a count or an amount of at most the limit, an interval of at least the limit.
function enforces(limit, row) {
  const value = Number(row.limit_value);
  if (row.severity !== limit.severity || !sameMatch(limit, row)) return false;
  if (normalize(row.limit_unit) !== normalize(limit.limit_unit) || !Number.isFinite(value)) return false;
  return limit.limit_type === 'min_interval_days' ? value >= limit.limit_value : value <= limit.limit_value;
}

async function writeLimit(knex, productId, limit) {
  const rows = (await knex('product_limits').where({ product_id: productId, limit_type: limit.limit_type }).orderBy('created_at'))
    .filter((row) => !limit.match_value || sameMatch(limit, row));
  if (rows.some((row) => enforces(limit, row))) return null;
  if (!rows.length) {
    const [made] = await knex('product_limits').insert({ product_id: productId, ...limit }).returning('id');
    return { inserted: { id: made && typeof made === 'object' ? made.id : made, product_id: productId, ...limit } };
  }
  // Tighten the first row of this type; the other rows of the type stay as they are.
  const row = rows[0];
  const before = Object.fromEntries(Object.keys(limit).map((field) => [field, row[field] ?? null]));
  await knex('product_limits').where({ id: row.id }).update({ ...limit, updated_at: knex.fn.now() });
  return { updated: { id: row.id, before, after: limit } };
}

async function writeLimits(knex, productId) {
  const written = { productId, limits: { inserted: [], updated: [] } };
  if (!(await knex.schema.hasTable('product_limits'))) return written;
  for (const limit of LIMITS) {
    const result = await writeLimit(knex, productId, limit);
    if (result && result.inserted) written.limits.inserted.push(result.inserted);
    if (result && result.updated) written.limits.updated.push(result.updated);
  }
  return written;
}

// ── Staged rows ──────────────────────────────────────────────────────────────

async function writeProtocol(knex, protocol, productId) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where('w.lawn_protocol_id', protocol.id)
    .select('p.id', 'p.product_id', 'p.product_name', 'p.gates', 'w.window_key');
  const written = [];
  for (const row of rows) {
    if (!(row.product_name === DYLOX || String(row.product_id) === String(productId))) continue;
    const gates = asObject(row.gates);
    if (gates.retired === true) continue;
    const added = Object.keys(GATE_KEYS).filter((key) => gates[key] === undefined);
    if (!added.length) continue;
    const after = { ...gates, ...Object.fromEntries(added.map((key) => [key, GATE_KEYS[key]])) };
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(after), updated_at: knex.fn.now() });
    written.push({ rowId: row.id, window: row.window_key, added: Object.fromEntries(added.map((key) => [key, GATE_KEYS[key]])) });
  }
  return written;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const productId = await resolveProductId(knex, DYLOX);
  if (!productId) {
    console.log(`[lawn-v13-dylox-label-limits] ${DYLOX} not found in the catalog: nothing written`);
    return;
  }

  const limits = await writeLimits(knex, productId);
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  for (const protocol of protocols) {
    const rows = await writeProtocol(knex, protocol, productId);
    if (!rows.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }

  if (limits.limits.inserted.length || limits.limits.updated.length) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: ACTOR,
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['limits']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(limits),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }
};

// ── Down ─────────────────────────────────────────────────────────────────────

async function revertProtocol(knex, log) {
  const { rows = [] } = asObject(log.after_snapshot);
  for (const entry of rows) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'gates');
    if (!row) continue;
    const gates = asObject(row.gates);
    let changed = false;
    for (const [key, value] of Object.entries(entry.added || {})) {
      if (gates[key] === value) { delete gates[key]; changed = true; }
    }
    if (changed) await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
}

async function revertLimits(knex, limits) {
  if (!limits || !(await knex.schema.hasTable('product_limits'))) return;
  for (const { id, ...fields } of limits.inserted || []) {
    const row = await knex('product_limits').where({ id }).first();
    if (row && Object.entries(fields).every(([field, value]) => same(row[field], value))) await knex('product_limits').where({ id }).del();
  }
  for (const change of limits.updated || []) {
    const row = await knex('product_limits').where({ id: change.id }).first();
    if (row && Object.entries(change.after).every(([field, value]) => same(row[field], value))) {
      await knex('product_limits').where({ id: change.id }).update({ ...change.before, updated_at: knex.fn.now() });
    }
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) await revertProtocol(knex, log);
  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    await revertLimits(knex, asObject(log.after_snapshot).limits);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.DYLOX = DYLOX;
exports.LABEL = LABEL;
exports.LIMITS = LIMITS;
exports.GATE_KEYS = GATE_KEYS;
