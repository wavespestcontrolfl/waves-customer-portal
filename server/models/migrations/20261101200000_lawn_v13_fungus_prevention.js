/**
 * Lawn protocol v13, two fungus prevention lines (owner 2026-11-01), for lawns with a mapped history of the disease.
 * One migration in the shape of 20261101170000 (#7365): it only INSERTS, and it rolls back all or nothing. The recipe file
 * (server/config/lawn-protocol-v13.json, all three tracks) carries the same lines; the technician sheet, the plan and the treatment
 * guide read lawn_protocol_products, so the staged rows follow here (AGENTS.md: a lawn protocol change reaches both sources of truth).
 *
 *   1. Gray leaf spot prevention in May. Gray leaf spot was treated only once it showed: Artavia 2 SC in June and August, Gravex
 *      second in July. May gets ONE Artavia spot row (gates.trigger 'mapped_gray_leaf_spot_prevention'): one pass on areas mapped for
 *      gray leaf spot last summer. It copies the June Artavia row (jun_v13_hose_blackout).
 *   2. Large patch spring pass in February. Large patch was prevented on mapped areas in October and November and treated while
 *      active in December and January; nothing ran from February on, although the disease runs to May. February gets ONE Velista
 *      spot row (gates.trigger 'mapped_large_patch_spring'). It copies the November Velista row (nov_v13_spreader_feeding). It is
 *      Velista (Group 7) on purpose: January's large patch line is Artavia (Group 11), and the program never repeats a chemical group
 *      back to back.
 *
 * Both rows are spot rows, default_in_plan false: neither enters a plan by itself. Neither trigger starts with 'mapped_take_all', so
 * the treatment guide's take-all handling (known trouble areas only) does not apply to them, and neither trigger names take-all, so
 * the approval engine never reads an application under them as take-all evidence.
 *
 * Rounds (9x) visits take their as-needed rows from the window of the REAL calendar month (lawn-rounds roundSpotMonth, #7056; a
 * St. Augustine round-2 visit dated in March reads February's rows), so a window by month serves both plans.
 *
 * Where a row goes. Each row is APPENDED at the end of its window (the largest sort_order there plus one). No existing row moves.
 * Every v13 protocol gets the rows. A window that already holds a row of the product (retired or not), a protocol with no linked
 * template row for the product, or a protocol with no such window is skipped for that product.
 *
 * Future visits only. Planning reads the live staged rows for an open visit. A closed visit keeps what it recorded.
 *
 * down() is all or nothing:
 *   - if ANY scheduled visit or completion references ANY v13 protocol, it does nothing and logs why;
 *   - if ANY row this inserted is no longer exactly as written, it does nothing and logs which;
 *   - otherwise it deletes every inserted row and its audit row.
 */

const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const V13_VERSION = staged.V13_VERSION;
const N = staged.NAMES;
// Short on purpose: audit_log.action is varchar(96) and `migration:${MIGRATION}:${column}` overflowed it once.
const MIGRATION = '20261101200000_lawn_v13_fungus_prevention';
const ACTION = 'v13_fungus_prevention';
const ACTOR = 'migration 20261101200000';

const W = {
  FEB: 'feb_v13_spreader_green_up',
  MAY: 'may_v13_tetrino_hose',
  JUN: 'jun_v13_hose_blackout',
  NOV: 'nov_v13_spreader_feeding',
};

// What each new row carries, beside its window, its catalog link and its place: the existing row of the same product, copied.
// `template` is the window whose row of the product it copies the catalog link from.
const GRAY_LEAF_SPOT_TRIGGER = 'mapped_gray_leaf_spot_prevention';
const LARGE_PATCH_SPRING_TRIGGER = 'mapped_large_patch_spring';
const SPOT = { application_mode: 'spot', default_in_plan: false };
const ROWS = Object.freeze({
  ARTAVIA: Object.freeze({
    name: N.ART, template: W.JUN,
    row: { ...SPOT, role: 'fungicide_spot', rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2 },
    gates: { trigger: GRAY_LEAF_SPOT_TRIGGER },
    annual_counter: {},
  }),
  VELISTA: Object.freeze({
    name: N.VEL, template: W.NOV,
    row: { ...SPOT, role: 'fungicide_spot', rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2 },
    gates: { trigger: LARGE_PATCH_SPRING_TRIGGER },
    annual_counter: {},
  }),
});

// Window by window, the products appended.
const PLACEMENTS = Object.freeze([
  [W.FEB, [ROWS.VELISTA]],
  [W.MAY, [ROWS.ARTAVIA]],
]);

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

const numberOrNull = (value) => (value == null ? null : Number(value));

// ── up ───────────────────────────────────────────────────────────────────────

// The catalog id of the product's row in the template window of one protocol (the link the new rows copy), or null: no such row, a
// retired one (a retired row is dismissed, never copied) or one with no catalog link.
async function templateProductId(knex, windows, spec) {
  const window = windows.find((candidate) => candidate.window_key === spec.template);
  if (!window) return null;
  const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select('product_id', 'product_name', 'gates');
  const row = rows.find((candidate) => candidate.product_name === spec.name && candidate.product_id != null && !asObject(candidate.gates).retired);
  return row ? row.product_id : null;
}

// The row as it is written: what the audit row records and what down() compares.
function rowSpec(spec, productId, sortOrder) {
  return { ...spec.row, product_name: spec.name, product_id: productId, gates: spec.gates, annual_counter: spec.annual_counter, sort_order: sortOrder };
}

async function insertRow(knex, window, spec) {
  const [made] = await knex('lawn_protocol_products').insert({
    lawn_protocol_window_id: window.id,
    product_id: spec.product_id,
    product_name: spec.product_name,
    role: spec.role,
    application_mode: spec.application_mode,
    rate_per_1000: spec.rate_per_1000,
    rate_unit: spec.rate_unit,
    carrier_gal_per_1000: spec.carrier_gal_per_1000,
    default_in_plan: spec.default_in_plan,
    gates: JSON.stringify(spec.gates),
    annual_counter: JSON.stringify(spec.annual_counter),
    mixing: JSON.stringify({}),
    report_copy: JSON.stringify({ role: spec.role }),
    sort_order: spec.sort_order,
  }).returning('id');
  return made && typeof made === 'object' ? made.id : made;
}

// One window of one protocol: the placement's products it does not hold yet, appended after its last row.
async function fillWindow(knex, window, products, productIds) {
  const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select('product_name', 'sort_order');
  let place = rows.reduce((max, row) => Math.max(max, Number(row.sort_order)), 0);
  const inserted = [];
  for (const spec of products) {
    const productId = productIds.get(spec.name);
    if (productId == null || rows.some((row) => row.product_name === spec.name)) continue;
    place += 1;
    const row = rowSpec(spec, productId, place);
    inserted.push({ rowId: await insertRow(knex, window, row), windowId: window.id, windowKey: window.window_key, row });
  }
  return inserted;
}

async function fillProtocol(knex, protocol) {
  const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).select('id', 'window_key');
  const productIds = new Map();
  for (const spec of Object.values(ROWS)) {
    if ((spec.skipTracks || []).includes(protocol.grass_track)) continue;
    const productId = await templateProductId(knex, windows, spec);
    if (productId != null) productIds.set(spec.name, productId);
  }
  const inserted = [];
  for (const [windowKey, products] of PLACEMENTS) {
    const window = windows.find((candidate) => candidate.window_key === windowKey);
    if (window) inserted.push(...await fillWindow(knex, window, products, productIds));
  }
  return inserted;
}

const REQUIRED_TABLES = ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'grass_track');
  for (const protocol of protocols) {
    const inserted = await fillProtocol(knex, protocol);
    if (!inserted.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({ inserted: [] }),
      after_snapshot: JSON.stringify({ rows: inserted }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
};

// ── down ─────────────────────────────────────────────────────────────────────

// A recorded row is still exactly what up() wrote: same window, link, rate, mode, flags, gates, counter and place.
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
    && isDeepStrictEqual(asObject(row.annual_counter), spec.annual_counter) && isDeepStrictEqual(asObject(row.mixing), {})
    && isDeepStrictEqual(asObject(row.report_copy), { role: spec.role });
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;

  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-fungus-prevention] rollback did nothing: a scheduled visit or completion references ${V13_VERSION}`);
    return;
  }
  const records = logs.flatMap((log) => asObject(log.after_snapshot).rows || []);
  for (const record of records) {
    if (!(await rowAsWritten(knex, record))) {
      console.log(`[lawn-v13-fungus-prevention] rollback did nothing: row ${record.rowId} (${record.windowKey}) is no longer exactly as written`);
      return;
    }
  }
  for (const record of records) await knex('lawn_protocol_products').where({ id: record.rowId }).del();
  for (const log of logs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.WINDOWS = W;
exports.ROWS = ROWS;
exports.PLACEMENTS = PLACEMENTS;
exports.GRAY_LEAF_SPOT_TRIGGER = GRAY_LEAF_SPOT_TRIGGER;
exports.LARGE_PATCH_SPRING_TRIGGER = LARGE_PATCH_SPRING_TRIGGER;
