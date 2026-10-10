/**
 * Lawn protocol v13 matrix adds, Codex round 1 corrections (PR #6116). Migration 20261007180000 is
 * pushed and frozen; this one fixes its data. Every write is guarded: it changes a value only while
 * the value is still what 180000 (or the schema default) left, and records what it changed so down()
 * can put it back exactly.
 *
 *   1. Arena stays "Arena 50 WDG". 180000 renamed the catalog row to the Florida-only S.E. packaging
 *      name. Name-keyed readers (the rotation history joins service_products.product_name to
 *      products_catalog.name, the count caps, the expectations table, old reports) would stop seeing
 *      every earlier Arena application. The row (same id; the S.E. label is the same EPA 59639-152) is
 *      renamed back, the staged rows 180000 renamed follow, "Arena 50 WDG" stops being an alias of
 *      itself and the S.E. name becomes an alias. The recipe lines say
 *      "Arena 50 WDG ... (SiteOne: Arena S.E., Florida only)".
 *   2. Headway take-all rate. The April and October Headway staged rows 180000 inserted carry no rate
 *      (null / 'label_rate'): 3 fl oz per 1,000 sq ft, the Headway liquid label's take-all rate
 *      (EPA 100-1216). They stay spot rows (no quantity), the rate shows as the label reference.
 *   3. Advion Fire Ant Bait is verified: the EPA-accepted label (EPA Reg. No. 100-1481, accepted
 *      2018-12-19, indoxacarb 0.045%) lists home lawns, a broadcast rate of 1.5 lb per acre per
 *      application, at least 12 weeks between applications, 6 lb per acre a year, and "Rainfall or
 *      irrigation within 2 to 3 hours after application may reduce effectiveness". So the catalog row
 *      180000 inserted gets the EPA number (only where NULL), the label rate fields (only where NULL),
 *      the label source note (only while it is still the inserted text) and a label watering rule
 *      (only where empty): no irrigation for 3 hours.
 *   4. Rollback never deletes catalog rows. 180000.down() removes the catalog rows 180000 inserted
 *      when nothing references them; an admin may have edited them since. This migration rewrites
 *      180000's catalog audit rows so their `products` list is empty (the earlier lanes' neutralize
 *      pattern, 20261007157000): the rows move to `keptProducts`, nothing else changes. It runs in
 *      up() too (idempotent) and in down() (which runs before 180000.down()).
 *
 * down(): puts the Arena name, aliases and staged row names, the Headway rows and the Advion fields
 * back to what 180000 left, each only while it still holds the value this wrote.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');

const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_matrix_adds_fixes';
const ACTOR = 'migration 20261007181000';
const MIGRATION = '20261007181000_lawn_v13_matrix_adds_fixes';

const HEADWAY_RATE = 3;
const HEADWAY_UNIT = 'fl oz';
const HEADWAY_WINDOWS = [matrix.WINDOWS.APR, matrix.WINDOWS.OCT];

const ADVION_EPA = '100-1481';
// 1.5 lb per acre = 0.0344 lb per 1,000 sq ft; 6 lb per acre a year = 0.1377 lb per 1,000 sq ft.
const ADVION_LABEL_RATE = 0.0344;
const ADVION_ANNUAL_RATE = 0.1377;
const ADVION_NOTE = 'Advion Fire Ant Bait label (EPA Reg. No. 100-1481, accepted 2018-12-19): home lawns; broadcast 1.5 lb per acre (0.0344 lb per 1,000 sq ft) per application, at least 12 weeks between applications, 6 lb per acre a year; rainfall or irrigation within 2 to 3 hours may reduce effectiveness; do not apply to wet turf. Optional add-on, office prices it. SiteOne 53209 $451.07 per 25 lb, 53212 $58.88 per 2 lb (2026-10-07 member prices).';
const ADVION_RULE = {
  mode: 'hold', hold_hours: 3, source: 'label',
  label_note: 'Label: "Rainfall or irrigation within 2 to 3 hours after application may reduce effectiveness"; do not apply to wet turf. No irrigation for 3 hours.',
  verified_at: '2026-10-07T00:00:00.000Z', verified_by: 'label-check-2026-10-07',
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

const numberEquals = (a, b) => a != null && b != null && Number(a) === Number(b);

// 4. Rollback never deletes a catalog row: 180000's catalog audit rows lose their deletion list.
async function keepCatalogRows(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: matrix.CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (!Array.isArray(after.products) || !after.products.length) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id })
      .update({ after_snapshot: JSON.stringify({ ...after, products: [], keptProducts: after.products }) });
  }
}

// 1. Arena back to its own name.
async function restoreArena(knex, record) {
  const row = await knex('products_catalog').where({ name: matrix.ARENA_NEW }).first('id', 'name', 'epa_reg_number');
  if (!row || String(row.epa_reg_number || '').trim() !== matrix.ARENA_EPA) return;
  if ((await knex('products_catalog').where({ name: matrix.ARENA_OLD }).first('id'))) return;
  await knex('products_catalog').where({ id: row.id, name: matrix.ARENA_NEW }).update({ name: matrix.ARENA_OLD, updated_at: knex.fn.now() });
  record.arena = { id: row.id, before: matrix.ARENA_NEW, after: matrix.ARENA_OLD, aliasesRemoved: [], aliasAdded: null, rows: [] };

  if (await knex.schema.hasTable('product_aliases')) {
    const aliases = await knex('product_aliases').where({ product_id: row.id }).select('id', 'product_id', 'alias_name');
    for (const alias of aliases.filter((a) => normalize(a.alias_name) === normalize(matrix.ARENA_OLD))) {
      await knex('product_aliases').where({ id: alias.id }).del();
      record.arena.aliasesRemoved.push(alias);
    }
    const all = await knex('product_aliases').select('alias_name');
    if (!all.some((a) => normalize(a.alias_name) === normalize(matrix.ARENA_NEW))) {
      const [made] = await knex('product_aliases').insert({ product_id: row.id, alias_name: matrix.ARENA_NEW }).returning('id');
      record.arena.aliasAdded = { id: made && typeof made === 'object' ? made.id : made, product_id: row.id, alias_name: matrix.ARENA_NEW };
    }
  }

  const staged = await knex('lawn_protocol_products').where({ product_id: row.id, product_name: matrix.ARENA_NEW }).select('id');
  for (const stagedRow of staged) {
    await knex('lawn_protocol_products').where({ id: stagedRow.id }).update({ product_name: matrix.ARENA_OLD, updated_at: knex.fn.now() });
    record.arena.rows.push(stagedRow.id);
  }
}

// 2. Headway rows: the label rate on the rows that carry none.
async function rateHeadway(knex, record) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION, 'p.product_name': matrix.HEAD })
    .whereIn('w.window_key', HEADWAY_WINDOWS)
    .select('p.id', 'p.rate_per_1000', 'p.rate_unit');
  for (const row of rows) {
    if (row.rate_per_1000 != null || !(row.rate_unit == null || row.rate_unit === 'label_rate')) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ rate_per_1000: HEADWAY_RATE, rate_unit: HEADWAY_UNIT, updated_at: knex.fn.now() });
    record.headway.push({ id: row.id, beforeUnit: row.rate_unit });
  }
}

// 3. Advion: the verified label facts, only into empty fields.
async function verifyAdvion(knex, record, hasWatering) {
  const row = await knex('products_catalog').where({ name: matrix.ADVION }).first('id', 'epa_reg_number', 'max_label_rate_per_1000', 'max_annual_per_1000', 'label_source_note', 'post_application_watering');
  if (!row) return;
  const advion = matrix.CATALOG.find((p) => p.name === matrix.ADVION);
  const update = {};
  const change = { id: row.id, fields: {} };
  const set = (column, before, after) => { update[column] = after; change.fields[column] = { before: before ?? null, after }; };
  if (row.epa_reg_number == null) set('epa_reg_number', row.epa_reg_number, ADVION_EPA);
  if (row.max_label_rate_per_1000 == null) set('max_label_rate_per_1000', row.max_label_rate_per_1000, ADVION_LABEL_RATE);
  if (row.max_annual_per_1000 == null) set('max_annual_per_1000', row.max_annual_per_1000, ADVION_ANNUAL_RATE);
  if (row.label_source_note === advion.label_source_note) set('label_source_note', row.label_source_note, ADVION_NOTE);
  if (hasWatering && row.post_application_watering == null) {
    update.post_application_watering = JSON.stringify(ADVION_RULE);
    change.fields.post_application_watering = { before: null, after: ADVION_RULE };
  }
  if (!Object.keys(update).length) return;
  await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
  record.advion = change;
}

const REQUIRED = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  await keepCatalogRows(knex);
  const record = { arena: null, headway: [], advion: null };
  await restoreArena(knex, record);
  await rateHeadway(knex, record);
  await verifyAdvion(knex, record, await knex.schema.hasColumn('products_catalog', 'post_application_watering'));
  if (!record.arena && !record.headway.length && !record.advion) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['catalog', 'products']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify(record),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

async function revertArena(knex, arena) {
  const row = await knex('products_catalog').where({ id: arena.id }).first('id', 'name');
  if (!row || row.name !== arena.after) return;
  if (await knex('products_catalog').where({ name: arena.before }).first('id')) return;
  await knex('products_catalog').where({ id: arena.id, name: arena.after }).update({ name: arena.before, updated_at: knex.fn.now() });
  for (const id of arena.rows || []) {
    await knex('lawn_protocol_products').where({ id, product_name: arena.after }).update({ product_name: arena.before, updated_at: knex.fn.now() });
  }
  if (!(await knex.schema.hasTable('product_aliases'))) return;
  if (arena.aliasAdded) await knex('product_aliases').where({ id: arena.aliasAdded.id, alias_name: arena.aliasAdded.alias_name }).del();
  for (const alias of arena.aliasesRemoved || []) {
    const all = await knex('product_aliases').select('alias_name');
    if (all.some((a) => normalize(a.alias_name) === normalize(alias.alias_name))) continue;
    await knex('product_aliases').insert({ id: alias.id, product_id: alias.product_id, alias_name: alias.alias_name });
  }
}

async function revertAdvion(knex, advion) {
  const row = await knex('products_catalog').where({ id: advion.id }).first();
  if (!row) return;
  const update = {};
  for (const [column, change] of Object.entries(advion.fields)) {
    const current = row[column];
    const same = column === 'post_application_watering' ? isDeepStrictEqual(asObject(current), asObject(change.after))
      : (numberEquals(current, change.after) || current === change.after);
    if (same) update[column] = column === 'post_application_watering' ? null : change.before;
  }
  if (Object.keys(update).length) await knex('products_catalog').where({ id: advion.id }).update({ ...update, updated_at: knex.fn.now() });
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  await keepCatalogRows(knex);
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const record = asObject(log.after_snapshot);
    for (const made of record.headway || []) {
      await knex('lawn_protocol_products').where({ id: made.id, rate_per_1000: HEADWAY_RATE, rate_unit: HEADWAY_UNIT })
        .update({ rate_per_1000: null, rate_unit: made.beforeUnit ?? null, updated_at: knex.fn.now() });
    }
    if (record.advion) await revertAdvion(knex, record.advion);
    if (record.arena) await revertArena(knex, record.arena);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.HEADWAY_RATE = HEADWAY_RATE;
exports.HEADWAY_UNIT = HEADWAY_UNIT;
exports.ADVION_EPA = ADVION_EPA;
exports.ADVION_LABEL_RATE = ADVION_LABEL_RATE;
exports.ADVION_ANNUAL_RATE = ADVION_ANNUAL_RATE;
exports.ADVION_RULE = ADVION_RULE;
exports.WATERING = [{ name: matrix.ADVION, rule: ADVION_RULE }];
