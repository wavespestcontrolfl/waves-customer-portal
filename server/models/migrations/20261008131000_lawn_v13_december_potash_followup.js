/**
 * Lawn protocol v13, December 10-0-22: two corrections to 20261008130000 (Codex round 1 on #6137). That migration
 * is pushed and frozen (a preview database ran it); this one is data only and leaves it untouched.
 *
 *   1. Catalog rate on a row that already existed. When the 10-0-22 was already in the catalog (by name or alias),
 *      20261008130000 only filled its empty analysis, slow-release and watering fields, so a sparse row kept no
 *      default_rate_per_1000 / rate_unit although every December protocol row links to it and the catalog-based
 *      readers (cost audit, job card, completion defaults) need the 4.5 lb basis. The row the staged December rows
 *      link to gets 4.5 lb, only where the field is empty and only when the pair stays coherent:
 *        - both empty: 4.5 and 'lb';
 *        - rate empty, unit already 'lb': the rate;
 *        - unit empty, rate already 4.5: 'lb';
 *        - anything else (a rate in another unit, a different rate): left as it is and logged.
 *      A blank unit (NULL, '' or whitespace only) counts as empty. Each write is guarded on the exact value read
 *      (so '' is matched as '', not as NULL), the audit row records that value as `before`, and down() puts back
 *      exactly that value (NULL stays NULL, a blank string comes back as the blank string).
 *      A row the first migration inserted already carries both; nothing is written for it.
 *   2. Rollback guard for the inserted row. 20261008130000's down() deletes the row it inserted when every field in the
 *      audit snapshot's `inserted` object still reads as written and nothing references it. That object holds only
 *      the CATALOG fields, not the four workflow values the same insert also set (active, needs_pricing,
 *      content_status, customer_visibility), so staff changing only those looked like "unchanged" and lost the row.
 *      down() compares every key present in `inserted`, so this migration adds the four inserted values to that
 *      audit snapshot (only keys it does not already hold). The frozen down then sees a changed row and keeps it.
 *      The snapshot is edited and not rolled back by this migration's down() on purpose: the rollback of BOTH
 *      migrations runs this down first, and putting the snapshot back would remove the guard before the frozen down
 *      reads it. The extra keys are harmless to the frozen up and are deleted with the audit row by the frozen down.
 *
 * Audited ('v13_december_potash_followup', one catalog row), idempotent (a second run writes nothing).
 *
 * down(): clears a rate this wrote only while the field still holds the written value and no v13 protocol is
 * referenced by a scheduled visit or a completion (then it changes nothing and keeps its audit row). It never
 * removes the audit-snapshot guard (see 2).
 */

const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const december = require('./20261008130000_lawn_v13_december_potash');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_december_potash_followup';
const ACTOR = 'migration 20261008131000';
const MIGRATION = '20261008131000_lawn_v13_december_potash_followup';
const NEW_NAME = december.NEW_NAME;
const RATE = december.DEC_RATE;
const UNIT = 'lb';

// What 20261008130000's insert wrote beside the CATALOG fields.
const INSERT_DEFAULTS = Object.freeze({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Empty means NULL, '' or whitespace only (a text field an admin cleared by hand).
const isBlank = (value) => value == null || String(value).trim() === '';
const sameRate = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b);

// The product ids the staged December rows of the v13 protocols link to the 10-0-22 by.
async function linkedProductIds(knex) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION, 'w.window_key': december.DECEMBER_WINDOW, 'p.product_name': NEW_NAME })
    .whereNotNull('p.product_id')
    .distinct('p.product_id');
  return rows.map((row) => row.product_id);
}

// The columns to write on a row, by the coherence rule in the header (empty list: nothing).
function rateFill(row) {
  const rateEmpty = row.default_rate_per_1000 == null;
  const unitEmpty = isBlank(row.rate_unit);
  if (rateEmpty && unitEmpty) return [{ column: 'default_rate_per_1000', after: RATE }, { column: 'rate_unit', after: UNIT }];
  if (rateEmpty && String(row.rate_unit).trim().toLowerCase() === UNIT) return [{ column: 'default_rate_per_1000', after: RATE }];
  if (unitEmpty && sameRate(row.default_rate_per_1000, RATE)) return [{ column: 'rate_unit', after: UNIT }];
  return [];
}

async function fillRates(knex) {
  const columns = await knex('products_catalog').columnInfo();
  if (!('default_rate_per_1000' in columns) || !('rate_unit' in columns)) return [];
  const written = [];
  for (const productId of await linkedProductIds(knex)) {
    const row = await knex('products_catalog').where({ id: productId }).first('id', 'name', 'default_rate_per_1000', 'rate_unit');
    if (!row) continue;
    const fill = rateFill(row);
    if (!fill.length) {
      if (!(sameRate(row.default_rate_per_1000, RATE) && String(row.rate_unit).trim() === UNIT)) {
        console.log(`[lawn-v13-december-potash-followup] ${row.name}: rate ${row.default_rate_per_1000} ${row.rate_unit} left as it is`);
      }
      continue;
    }
    const update = { updated_at: knex.fn.now() };
    for (const { column, after } of fill) update[column] = after;
    // Guarded on the exact value read (NULL, '' or whitespace), so a concurrent edit is never overwritten.
    const query = knex('products_catalog').where({ id: productId });
    for (const { column } of fill) {
      if (row[column] == null) query.whereNull(column); else query.where(column, row[column]);
    }
    if (await query.update(update)) for (const { column, after } of fill) written.push({ productId, column, before: row[column] ?? null, after });
  }
  return written;
}

// Adds the four inserted workflow values to the `inserted` object of 20261008130000's catalog audit rows (see 2).
async function guardInsertedRow(knex) {
  const extended = [];
  const logs = await knex('lawn_protocol_audit_log').where({ action: december.CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (!after.inserted || typeof after.inserted !== 'object') continue;
    const missing = Object.keys(INSERT_DEFAULTS).filter((key) => !(key in after.inserted));
    if (!missing.length) continue;
    const next = { ...after, inserted: { ...after.inserted, ...Object.fromEntries(missing.map((key) => [key, INSERT_DEFAULTS[key]])) } };
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(next) });
    extended.push({ logId: log.id, keys: missing });
  }
  return extended;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const filled = await fillRates(knex);
  const extended = await guardInsertedRow(knex);
  if (!filled.length && !extended.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['catalog', 'audit']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ filled, extended }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;
  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-december-potash-followup] a visit or completion references ${V13_VERSION}: catalog rate kept`);
    return;
  }
  for (const log of logs) {
    for (const { productId, column, before = null, after } of asObject(log.after_snapshot).filled || []) {
      const row = await knex('products_catalog').where({ id: productId }).first('id', column);
      // Back to what it was (NULL, or the blank string an admin left), only while it still holds the written value.
      if (row && (typeof after === 'number' ? sameRate(row[column], after) : row[column] === after)) {
        await knex('products_catalog').where({ id: productId }).update({ [column]: before, updated_at: knex.fn.now() });
      }
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.INSERT_DEFAULTS = INSERT_DEFAULTS;
exports.rateFill = rateFill;
