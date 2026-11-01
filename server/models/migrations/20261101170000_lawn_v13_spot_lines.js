/**
 * Lawn protocol v13, three as-needed (spot) line additions (owner 2026-11-01, from a read of lawn problems against the program).
 * One migration, deliberately small, in the shape of 20261029170000 (#7019): it only INSERTS, and it rolls back all or nothing.
 * The recipe file (server/config/lawn-protocol-v13.json, all three tracks) carries the same lines; the technician sheet, the plan
 * and the treatment guide read lawn_protocol_products, so the staged rows follow here (AGENTS.md: a lawn protocol change reaches
 * both sources of truth).
 *
 *   1. Caterpillars in October and November. Acelepryn Insecticide (the first rung, gates.trigger 'caterpillars', which is what
 *      lights the treatment guide's caterpillar card) and Atticus Talak 7.9 F (the later rung, if Acelepryn does not hold at the
 *      7-day recheck) get a spot row in the October and November windows. Until now caterpillar rows stood in July, August and
 *      September only (Talak in July only).
 *   2. Dry spots from March to October. The Dispatch Sprayable Wetting Agent row (gates.trigger 'dry_spots', which lights the dry
 *      spot card) stood in May only. It gets a spot row in March, April, June, July, August, September and October.
 *   3. Summer weed spots, June to September: Celsius WG ALONE, as the February window has it (no Certainty row, no surfactant row,
 *      so the weed group the Weed spots tap reads from gates.tankMixWith does not form and Celsius is a plain add-on). One Celsius
 *      spot row in each of June, July, August and September. The row carries the Celsius count cap keys the other Celsius rows
 *      carry (gates.annualMaxApps 2, the annual counter), so the yearly cap of 2 applications (rolling 365 days, app-enforced as a
 *      warning) counts these applications with every other Celsius application. NO Blindside row in any summer window: Blindside
 *      is a November-through-March product ("April through October: no weed spray once the Celsius cap is reached").
 *
 * Every row is a spot row, default_in_plan false: none of them enters a plan by itself. Each row is the existing row of the same
 * product in its existing window (Celsius: February; Acelepryn: August; Talak: July; Dispatch: May), the catalog link included,
 * with two differences: the Talak row for caterpillars carries no rate (the July row carries the mole cricket nymph rate, 1.0 fl
 * oz, which is not a caterpillar rate) and its gates.trigger is 'caterpillars_second_product' (the July row's
 * 'chinch_second_product_or_caterpillars' is the second CHINCH rung, which the treatment guide reads in every window).
 *
 * Rounds (9x) visits take their as-needed rows from the window of the REAL calendar month (lawn-rounds roundSpotMonth, #7056), so a
 * window by month serves both plans.
 *
 * Where a row goes. Each row is APPENDED at the end of its window (the largest sort_order there plus one). No existing row moves.
 * Every v13 protocol gets the rows, except that Celsius is never written to a bahia protocol (Celsius is not labeled for
 * bahiagrass; bahia has no v13 program). A window that already holds a row of the product (retired or not), a protocol with no
 * linked template row for the product, or a protocol with no such window is skipped for that product.
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
const MIGRATION = '20261101170000_lawn_v13_spot_lines';
const ACTION = 'v13_spot_lines';
const ACTOR = 'migration 20261101170000';

const W = {
  MAR: 'mar_v13_pre_m_hose',
  APR: 'apr_v13_spreader_feeding',
  MAY: 'may_v13_tetrino_hose',
  JUN: 'jun_v13_hose_blackout',
  JUL: 'jul_v13_inspect_spot',
  AUG: 'aug_v13_hose_blackout',
  SEP: 'sep_v13_hose_blackout',
  OCT: 'oct_v13_spreader_fall',
  NOV: 'nov_v13_spreader_feeding',
  FEB: 'feb_v13_spreader_green_up',
};

// What each new row carries, beside its window, its catalog link and its place: the existing row of the same product, copied.
// `template` is the window whose row of the product it copies the link from.
const CATERPILLAR_TRIGGER = 'caterpillars';
const TALAK_CATERPILLAR_TRIGGER = 'caterpillars_second_product';
const DRY_SPOT_TRIGGER = 'dry_spots';
const SPOT = { application_mode: 'spot', default_in_plan: false };
const ROWS = Object.freeze({
  ACELEPRYN: Object.freeze({
    name: N.ACE, template: W.AUG,
    row: { ...SPOT, role: 'insecticide_spot', rate_per_1000: null, rate_unit: 'fl oz', carrier_gal_per_1000: 2 },
    gates: { trigger: CATERPILLAR_TRIGGER, rateRange: '0.046-0.092 fl oz/1000', delayWateringOrMowingHours: 24 },
    annual_counter: {},
  }),
  TALAK: Object.freeze({
    name: N.TAL, template: W.JUL,
    row: { ...SPOT, role: 'insecticide_spot', rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 4 },
    gates: { trigger: TALAK_CATERPILLAR_TRIGGER, delayWateringHours: 24 },
    annual_counter: {},
  }),
  DISPATCH: Object.freeze({
    name: N.DSP, template: W.MAY,
    row: { ...SPOT, role: 'wetting_agent_spot', rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 1 },
    gates: { trigger: DRY_SPOT_TRIGGER, noWaterIn: true },
    annual_counter: {},
  }),
  CELSIUS: Object.freeze({
    name: N.CEL, template: W.FEB, skipTracks: Object.freeze(['bahia']),
    row: { ...SPOT, role: 'post_emergent_spot', rate_per_1000: 0.085, rate_unit: 'oz', carrier_gal_per_1000: 1 },
    gates: { stressGate: true, annualCounter: 'celsius_oz_per_1000', annualMaxApps: 2 },
    annual_counter: { counter: 'celsius_oz_per_1000', maxApplications: 2 },
  }),
});

// Window by window, the products appended in this order.
const PLACEMENTS = Object.freeze([
  [W.MAR, [ROWS.DISPATCH]],
  [W.APR, [ROWS.DISPATCH]],
  [W.JUN, [ROWS.CELSIUS, ROWS.DISPATCH]],
  [W.JUL, [ROWS.CELSIUS, ROWS.DISPATCH]],
  [W.AUG, [ROWS.CELSIUS, ROWS.DISPATCH]],
  [W.SEP, [ROWS.CELSIUS, ROWS.DISPATCH]],
  [W.OCT, [ROWS.ACELEPRYN, ROWS.TALAK, ROWS.DISPATCH]],
  [W.NOV, [ROWS.ACELEPRYN, ROWS.TALAK]],
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
    console.log(`[lawn-v13-spot-lines] rollback did nothing: a scheduled visit or completion references ${V13_VERSION}`);
    return;
  }
  const records = logs.flatMap((log) => asObject(log.after_snapshot).rows || []);
  for (const record of records) {
    if (!(await rowAsWritten(knex, record))) {
      console.log(`[lawn-v13-spot-lines] rollback did nothing: row ${record.rowId} (${record.windowKey}) is no longer exactly as written`);
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
exports.CATERPILLAR_TRIGGER = CATERPILLAR_TRIGGER;
exports.TALAK_CATERPILLAR_TRIGGER = TALAK_CATERPILLAR_TRIGGER;
exports.DRY_SPOT_TRIGGER = DRY_SPOT_TRIGGER;
