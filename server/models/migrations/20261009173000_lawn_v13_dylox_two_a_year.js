/**
 * Lawn protocol v13: Dylox 6.2 G is at most 2 applications per lawn per calendar year, for any pest (owner 2026-10-09,
 * Codex round 1 on #6228). 20261009172000 is pushed with that PR and frozen, so the change lives here.
 *
 * Why. The Dylox 6.2 G label (EPA Reg. No. 432-1308) allows 3 applications a calendar year, and limits the total to 24.5 lb
 * active ingredient per acre a year for mole crickets and grubs but only 16.2 lb per acre a year for surface feeding insects
 * (chinch bugs, sod webworms). The app does not record which pest a pass was for. At the catalog rate of 3 lb per 1,000 sq ft
 * (8.1 lb active ingredient per acre) two passes reach the surface feeder amount, a third would be over it, and the 9.07 lb
 * yearly amount row (the grub and mole cricket figure) lets a third pass through. So the count is 2 for every pest, a Waves
 * rule stricter than the label's 3 for grubs and mole crickets, with no target-aware logic.
 *
 * What this writes. The product is the catalog row resolved by exact name, else exact alias. No row: nothing at all is written
 * (logged).
 *   1. The product's annual_max_apps limit (match_type product):
 *        - a row that still reads exactly what 20261009172000 wrote (value 3, unit applications, hard_block, its description)
 *          becomes value 2 with the Waves rule description;
 *        - no annual_max_apps row at all: one is inserted at 2 (hard block);
 *        - any other row (someone's own value or description) is left as it is.
 *      The 7 day interval row and the 9.07 lb yearly amount row are not touched.
 *   2. Staged protocols (every v13 protocol): gates.annualMaxApps becomes 2 on each non-retired Dylox 6.2 G row where it is
 *      exactly 3. Any other figure stays.
 *
 * Idempotent: a second run finds the row at 2 and no gate at 3 and writes nothing. One 'v13_dylox_two_a_year' audit row per
 * protocol that changed and one 'v13_dylox_two_a_year_catalog' row for the limit.
 *
 * down(), exact-equality guarded: a limit this updated goes back to 3 and the label description only while it still reads
 * exactly as this wrote it; a limit this inserted is deleted only while every field still reads as inserted; a gate goes back to
 * 3 only while it still reads 2 on that row. Anything edited since stays, and the audit rows are removed.
 *
 * How 20261009172000's down() behaves after this write. It runs AFTER this down() in any rollback (knex rolls back newest first),
 * and then finds everything as it wrote it, so it behaves exactly as before. If it is run while this write is still in place
 * (this down() skipped an edited row, or this migration's file was removed first), it skips instead of mis-restoring:
 *   - the limit: its inserted row is deleted, and its tightened row restored, only while every field it wrote still reads that way.
 *     The row now reads 2 and the new description, so it is left in place at 2 (a count limit that stays, never a wrong restore);
 *     its own audit row is deleted. The 7 day and 9.07 lb rows it wrote are still removed.
 *   - the gate: it removes gates.annualMaxApps only while the value is 3. A row at 2 keeps the key at 2.
 * Neither case deletes a value somebody else wrote or restores an older value over a newer one. Run this down() first to remove
 * the count row and the gate key completely.
 *
 * Older downs that read other products' rows (20261005160000, 20261007175000, 20261008130000, 20261009151000) read no Dylox 6.2 G
 * limit or gate, so none of them behaves differently.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const first = require('./20261009172000_lawn_v13_dylox_label_limits');

const V13_VERSION = staged.V13_VERSION;
const DYLOX = first.DYLOX;
const ACTION = 'v13_dylox_two_a_year';
const CATALOG_ACTION = 'v13_dylox_two_a_year_catalog';
const ACTOR = 'migration 20261009173000';
const MIGRATION = '20261009173000_lawn_v13_dylox_two_a_year';
const CAP = 2;
const WAS = 3;

// The row 20261009172000 wrote.
const WRITTEN_BY_FIRST = first.LIMITS.find((limit) => limit.limit_type === 'annual_max_apps');

const LIMIT = {
  match_type: 'product', limit_type: 'annual_max_apps', limit_value: CAP, limit_unit: 'applications', severity: 'hard_block',
  description: 'Dylox 6.2 G: at most 2 applications per lawn per calendar year (Waves rule). The label (EPA Reg. No. 432-1308) allows 3 a calendar year for mole crickets and grubs but only 16.2 lb active ingredient per acre a year for surface feeding insects, which two 3 lb applications reach.',
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), JSON deeply, text exactly.
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

// ── Limit ────────────────────────────────────────────────────────────────────

const isFirstWrite = (row) => same(row.limit_value, WRITTEN_BY_FIRST.limit_value) && row.limit_unit === WRITTEN_BY_FIRST.limit_unit
  && row.severity === WRITTEN_BY_FIRST.severity && row.description === WRITTEN_BY_FIRST.description;

async function writeLimit(knex, productId) {
  const written = { productId, limits: { inserted: [], updated: [] } };
  if (!(await knex.schema.hasTable('product_limits'))) return written;
  const rows = (await knex('product_limits').where({ product_id: productId, limit_type: LIMIT.limit_type }).orderBy('created_at'))
    .filter((row) => row.match_type == null || row.match_type === 'product');
  const row = rows.find(isFirstWrite);
  if (row) {
    const fields = { limit_value: CAP, description: LIMIT.description };
    const count = await knex('product_limits').where({ id: row.id, description: row.description }).whereRaw('limit_value = ?', [WAS]).update({ ...fields, updated_at: knex.fn.now() });
    if (count) written.limits.updated.push({ id: row.id, before: { limit_value: WAS, description: row.description }, after: fields });
    return written;
  }
  if (rows.length) return written;
  const [made] = await knex('product_limits').insert({ product_id: productId, ...LIMIT }).returning('id');
  written.limits.inserted.push({ id: made && typeof made === 'object' ? made.id : made, product_id: productId, ...LIMIT });
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
    if (gates.retired === true || gates.annualMaxApps !== WAS) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, annualMaxApps: CAP }), updated_at: knex.fn.now() });
    written.push({ rowId: row.id, window: row.window_key });
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
    console.log(`[lawn-v13-dylox-two-a-year] ${DYLOX} not found in the catalog: nothing written`);
    return;
  }

  const limits = await writeLimit(knex, productId);
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
    if (gates.annualMaxApps !== CAP) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, annualMaxApps: WAS }), updated_at: knex.fn.now() });
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
exports.LIMIT = LIMIT;
