/**
 * Lawn protocol v13, mole cricket bait and the Group 11 stacking fix: the STAGED protocol rows that match the recipe file
 * (owner 2026-10-23, "do whatever is going to make the grass look its best, based on the research we did"). The recipe
 * (server/config/lawn-protocol-v13.json) and the catalog row (20261023140000_lawn_v13_advion_insect_granule) already carry the
 * change; the technician sheet and the treatment guide read lawn_protocol_products, so those rows follow here (AGENTS.md:
 * a lawn protocol change reaches both sources of truth).
 *
 * For every staged v13 protocol (all four keys):
 *   1. INSERT the Advion Insect Granule spot row in the June and July windows (3 lb per 1,000 sq ft, trigger mole_cricket_nymphs,
 *      not in the plan by default). It links to the catalog row 20261023140000 inserted; with no such row (that migration did
 *      nothing) this migration does nothing.
 *   2. INSERT an Acelepryn Insecticide spot row in the June window (second mole cricket product, watered in; trigger
 *      mole_cricket_nymphs, no 24-hour caterpillar hold). A June window that already has an Acelepryn row is skipped.
 *   3. UPDATE the July Talak trigger from chinch_second_product_caterpillars_or_mole_cricket_nymphs back to
 *      chinch_second_product_or_caterpillars (the old value the treatment guide still reads as the second chinch rung), only
 *      while the gates still hold the value 20261007180000 wrote.
 *   4. DELETE the August Talak mole cricket row (trigger mole_cricket_nymphs, 1.0 fl oz), only while it is exactly as 20261007180000
 *      wrote it and no completion actual references it; a changed or used row is kept and logged.
 *   5. INSERT a Velista spot row in the December window (active large patch on a lawn that also has take-all mapped: Artavia ran
 *      in September and Headway in October, and the Headway label allows no more than 2 consecutive Group 11 applications). The
 *      December Artavia row stays for a lawn with large patch alone; the treatment guide skips it when a take-all area is on file.
 * Nothing else changes: October keeps its Artavia and Velista rows (the guide skips the Artavia large patch row when take-all is
 * mapped), and no catalog row is touched.
 *
 * Each protocol gets one audit row that records what was inserted, updated and deleted. down() is all or nothing: if ANY scheduled
 * visit or completion references ANY v13 protocol, or any recorded row is no longer as written, it does nothing and logs why;
 * otherwise it deletes what this inserted, puts the Talak trigger back and re-inserts the deleted August row as it was.
 */

const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const advion = require('./20261023140000_lawn_v13_advion_insect_granule');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_advion_staged_rows';
const ACTOR = 'migration 20261023141000';
const MIGRATION = '20261023141000_lawn_v13_mole_cricket_bait_staged_rows';
const N = staged.NAMES;
const W = { JUN: 'jun_v13_hose_blackout', JUL: 'jul_v13_inspect_spot', AUG: 'aug_v13_hose_blackout', DEC: 'dec_v13_spreader_feeding', OCT: 'oct_v13_spreader_fall' };

const MOLE_TRIGGER = 'mole_cricket_nymphs';
const TALAK_OLD_TRIGGER = 'chinch_second_product_caterpillars_or_mole_cricket_nymphs';
const TALAK_NEW_TRIGGER = 'chinch_second_product_or_caterpillars';
const DEC_VELISTA_TRIGGER = 'active_large_patch_take_all_mapped';

// What a new row carries, beside the window id and the product link.
const ADVION_ROW = { product_name: advion.NAME, role: 'insecticide_spot', application_mode: 'spot', rate_per_1000: advion.DEFAULT_RATE, rate_unit: 'lb', carrier_gal_per_1000: null, default_in_plan: false, gates: { trigger: MOLE_TRIGGER } };
const ACELEPRYN_ROW = { product_name: N.ACE, role: 'insecticide_spot', application_mode: 'spot', rate_per_1000: null, rate_unit: 'fl oz', carrier_gal_per_1000: 2, default_in_plan: false, gates: { trigger: MOLE_TRIGGER } };
const VELISTA_ROW = { product_name: N.VEL, role: 'fungicide_spot', application_mode: 'spot', rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2, default_in_plan: false, gates: { trigger: DEC_VELISTA_TRIGGER } };
// The August Talak row exactly as 20261007180000 / 20261007183000 left it: the full row is compared before it is deleted, so a rate,
// carrier volume, mode, link or gate staff changed keeps the row.
const AUG_TALAK_GATES = { trigger: MOLE_TRIGGER };
const AUG_TALAK_ROW = { role: 'insecticide_spot', application_mode: 'spot', rate_per_1000: 1, rate_unit: 'fl oz', carrier_gal_per_1000: 4, default_in_plan: false, gates: AUG_TALAK_GATES };

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}
const numberOrNull = (value) => (value == null ? null : Number(value));

// A row holds exactly the spec's values (numbers by value: pg decimals arrive as strings), the same window, and the same product link
// when one is given.
function rowMatches(row, spec, { windowId, productId } = {}) {
  return row.product_name === (spec.product_name ?? row.product_name) && row.role === spec.role && row.application_mode === spec.application_mode
    && numberOrNull(row.rate_per_1000) === spec.rate_per_1000 && row.rate_unit === spec.rate_unit
    && numberOrNull(row.carrier_gal_per_1000) === spec.carrier_gal_per_1000 && row.default_in_plan === spec.default_in_plan
    && isDeepStrictEqual(asObject(row.gates), spec.gates)
    && (windowId === undefined || String(row.lawn_protocol_window_id) === String(windowId))
    && (productId === undefined || String(row.product_id) === String(productId));
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];
async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// The catalog row 20261023140000 inserted (its audit row names it), else null.
async function ownAdvionId(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: advion.CATALOG_ACTION }).select('after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted && productId) return productId;
  }
  return null;
}

async function windowRows(knex, windowId) {
  return knex('lawn_protocol_products').where({ lawn_protocol_window_id: windowId }).orderBy('sort_order');
}

async function nextSort(knex, protocolId) {
  const [{ max }] = await knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id').where('w.lawn_protocol_id', protocolId).max('p.sort_order as max');
  return Number(max || 0) + 1;
}

async function insertRow(knex, protocolId, windowId, spec, productId) {
  const [row] = await knex('lawn_protocol_products').insert({
    lawn_protocol_window_id: windowId,
    product_id: productId || null,
    product_name: spec.product_name,
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
    sort_order: await nextSort(knex, protocolId),
  }).returning('*');
  return row;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const advionId = await ownAdvionId(knex);
  if (!advionId) {
    console.log('[lawn-v13-mole-cricket-staged] nothing done: 20261023140000 inserted no Advion Insect Granule catalog row');
    return;
  }
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  for (const protocol of protocols) {
    const windows = Object.fromEntries((await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).select('id', 'window_key')).map((w) => [w.window_key, w.id]));
    if (!windows[W.JUN] || !windows[W.JUL] || !windows[W.AUG] || !windows[W.DEC]) continue;
    const julRows = await windowRows(knex, windows[W.JUL]);
    const augRows = await windowRows(knex, windows[W.AUG]);
    const junRows = await windowRows(knex, windows[W.JUN]);
    const decRows = await windowRows(knex, windows[W.DEC]);
    const octRows = windows[W.OCT] ? await windowRows(knex, windows[W.OCT]) : [];
    const record = { inserted: [], updated: [], deleted: [] };

    const add = async (windowKey, rows, spec, productId) => {
      if (rows.some((row) => row.product_name === spec.product_name)) return;
      const row = await insertRow(knex, protocol.id, windows[windowKey], spec, productId);
      record.inserted.push({ rowId: row.id, windowKey, windowId: windows[windowKey], productId: productId || null, product_name: spec.product_name });
    };
    await add(W.JUN, junRows, ADVION_ROW, advionId);
    await add(W.JUN, junRows, ACELEPRYN_ROW, (julRows.find((r) => r.product_name === N.ACE) || augRows.find((r) => r.product_name === N.ACE))?.product_id);
    await add(W.JUL, julRows, ADVION_ROW, advionId);
    await add(W.DEC, decRows, VELISTA_ROW, (octRows.find((r) => r.product_name === N.VEL) || julRows.find((r) => r.product_name === N.VEL))?.product_id);

    const talak = julRows.find((row) => row.product_name === N.TAL && asObject(row.gates).trigger === TALAK_OLD_TRIGGER);
    if (talak) {
      const before = asObject(talak.gates);
      const after = { ...before, trigger: TALAK_NEW_TRIGGER };
      await knex('lawn_protocol_products').where({ id: talak.id }).update({ gates: JSON.stringify(after), updated_at: knex.fn.now() });
      record.updated.push({ rowId: talak.id, before: { gates: before }, after: { gates: after } });
    }

    // The August row links to the same Talak catalog product as July's row (both came from one staged name); another link is a staff edit.
    const talakProductId = (julRows.find((row) => row.product_name === N.TAL) || {}).product_id;
    const augTalak = augRows.find((row) => row.product_name === N.TAL && rowMatches(row, { ...AUG_TALAK_ROW, product_name: N.TAL }, { productId: talakProductId }));
    if (augTalak) {
      const used = await knex.schema.hasTable('lawn_protocol_product_actuals') && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: augTalak.id }).first('protocol_product_id');
      if (used) console.log(`[lawn-v13-mole-cricket-staged] August Talak row ${augTalak.id} kept: a completion references it`);
      else {
        await knex('lawn_protocol_products').where({ id: augTalak.id }).del();
        record.deleted.push({ row: augTalak });
      }
    }

    if (record.inserted.length || record.updated.length || record.deleted.length) {
      await knex('lawn_protocol_audit_log').insert({
        lawn_protocol_id: protocol.id,
        actor_name: ACTOR,
        entity_type: 'protocol',
        entity_id: protocol.id,
        action: ACTION,
        changed_fields: JSON.stringify(['products']),
        before_snapshot: JSON.stringify({}),
        after_snapshot: JSON.stringify(record),
        metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
      });
    }
  }
};

// A recorded inserted row is still what up() wrote: the same name, window, product link, rate, unit, carrier, mode, role and gates.
async function insertedAsWritten(knex, entry) {
  const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first();
  const spec = [ADVION_ROW, ACELEPRYN_ROW, VELISTA_ROW].find((candidate) => candidate.product_name === entry.product_name);
  return Boolean(row) && rowMatches(row, spec, { windowId: entry.windowId, productId: entry.productId });
}

// The reason a recorded change can no longer be taken back (an inserted row edited or used, the Talak trigger changed, a deleted row
// back), or null when every recorded row is still exactly as up() left it.
async function rollbackBlocker(knex, records) {
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');
  for (const record of records) {
    for (const entry of record.inserted || []) {
      const used = hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: entry.rowId }).first('protocol_product_id');
      if (used || !(await insertedAsWritten(knex, entry))) return `inserted row ${entry.rowId} is no longer exactly as written, or is in use`;
    }
    for (const entry of record.updated || []) {
      const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('gates');
      if (!row || !isDeepStrictEqual(asObject(row.gates), asObject(entry.after.gates))) return `the Talak row ${entry.rowId} is no longer exactly as written`;
    }
    for (const entry of record.deleted || []) {
      if (await knex('lawn_protocol_products').where({ id: entry.row.id }).first('id')) return `the deleted row ${entry.row.id} exists again`;
    }
  }
  return null;
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;
  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-mole-cricket-staged] rollback did nothing: a scheduled visit or completion references ${V13_VERSION}`);
    return;
  }
  const records = logs.map((log) => asObject(log.after_snapshot));
  const blocker = await rollbackBlocker(knex, records);
  if (blocker) {
    console.log(`[lawn-v13-mole-cricket-staged] rollback did nothing: ${blocker}`);
    return;
  }
  for (const record of records) {
    for (const entry of record.inserted || []) await knex('lawn_protocol_products').where({ id: entry.rowId }).del();
    for (const entry of record.updated || []) {
      await knex('lawn_protocol_products').where({ id: entry.rowId }).update({ gates: JSON.stringify(asObject(entry.before.gates)), updated_at: knex.fn.now() });
    }
    for (const { row } of record.deleted || []) {
      await knex('lawn_protocol_products').insert({
        ...row,
        gates: JSON.stringify(asObject(row.gates)),
        annual_counter: JSON.stringify(asObject(row.annual_counter)),
        mixing: JSON.stringify(asObject(row.mixing)),
        report_copy: JSON.stringify(asObject(row.report_copy)),
      });
    }
  }
  for (const log of logs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
};

exports.ACTION = ACTION;
exports.WINDOWS = W;
exports.ADVION_ROW = ADVION_ROW;
exports.ACELEPRYN_ROW = ACELEPRYN_ROW;
exports.VELISTA_ROW = VELISTA_ROW;
exports.TALAK_OLD_TRIGGER = TALAK_OLD_TRIGGER;
exports.TALAK_NEW_TRIGGER = TALAK_NEW_TRIGGER;
exports.AUG_TALAK_GATES = AUG_TALAK_GATES;
exports.AUG_TALAK_ROW = AUG_TALAK_ROW;
