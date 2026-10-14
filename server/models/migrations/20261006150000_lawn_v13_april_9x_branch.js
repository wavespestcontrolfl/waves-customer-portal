/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: the 9x plan April step
 * (Codex round 6 on #5988, deferred by the owner's stopping rule).
 *
 * v13 April: a 9x plan (the "enhanced" lawn tier) uses LESCO Dimension 0.21%
 * 18-0-10 granular at 2.78 lb per 1,000 sq ft (0.5 lb N plus pre-emergent) in
 * place of the 24-0-11 at 2.1 lb. The staged April window (20261005120000) only
 * had the 24-0-11. The recipe file (lawn-protocol-v13.json, cadenceVariants) and
 * the plan now pick the step by the visit's plan; this migration gives the staged
 * window the matching product row.
 *
 * Per staged v13 protocol, in its April window:
 *   - inserts a LESCO Dimension 0.21% 18-0-10 row: the 24-0-11 row's own rate
 *     (nutrition, lb_n) and gates, default_in_plan, plus planVisitsPerYear 9;
 *   - marks the 24-0-11 row planVisitsPerYear 12 (also the step an unknown plan
 *     keeps; the engine warns then).
 * `planVisitsPerYear` is the condition the pre-visit brief shows the technician;
 * the plan itself selects from the recipe's cadenceVariants.
 *
 * The Dimension 0.21% catalog row is the one 20261005130000 inserted when absent
 * (prod already had it); if none resolves the migration throws, as 130000 does.
 * No other product is new.
 *
 * Idempotent. down(): deletes the Dimension row it inserted (kept when a
 * completion actual references it) and takes planVisitsPerYear back off the
 * 24-0-11 row only while it still holds 12. Audit row per protocol, action
 * 'v13_april_9x'.
 */

const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = '2026.10-v13';
const AUDIT_ACTION = 'v13_april_9x';
const APRIL_WINDOW = 'apr_v13_spreader_feeding';
const DIMENSION = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
const F24 = staged.NAMES.F24;
const GATE_KEY = 'planVisitsPerYear';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function resolveDimensionId(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(DIMENSION));
  if (hit) return hit.id;
  if (await knex.schema.hasTable('product_aliases')) {
    const alias = (await knex('product_aliases').select('product_id', 'alias_name'))
      .find((row) => normalize(row.alias_name) === normalize(DIMENSION));
    if (alias) return alias.product_id;
  }
  return null;
}

function aprilRows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION)
    .where('w.window_key', APRIL_WINDOW);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products')) || !(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;

  const rows = await aprilRows(knex).select('p.id', 'p.lawn_protocol_window_id', 'p.product_name', 'p.role', 'p.application_mode',
    'p.rate_per_1000', 'p.rate_unit', 'p.carrier_gal_per_1000', 'p.default_in_plan', 'p.gates', 'p.sort_order', 'l.id as protocol_id');
  const windows = new Map();
  for (const row of rows) {
    if (!windows.has(row.lawn_protocol_window_id)) windows.set(row.lawn_protocol_window_id, { protocolId: row.protocol_id, rows: [] });
    windows.get(row.lawn_protocol_window_id).rows.push(row);
  }

  let dimensionId = null;
  for (const [windowId, window] of windows) {
    const f24 = window.rows.find((row) => row.product_name === F24);
    if (!f24 || window.rows.some((row) => row.product_name === DIMENSION)) continue;
    dimensionId = dimensionId || await resolveDimensionId(knex);
    if (!dimensionId) throw new Error(`lawn v13: no products_catalog row or alias for ${DIMENSION}`);

    const f24Gates = asObject(f24.gates);
    const [inserted] = await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: windowId,
      product_id: dimensionId,
      product_name: DIMENSION,
      role: f24.role,
      application_mode: f24.application_mode,
      rate_per_1000: f24.rate_per_1000,
      rate_unit: f24.rate_unit,
      carrier_gal_per_1000: f24.carrier_gal_per_1000,
      default_in_plan: f24.default_in_plan,
      gates: JSON.stringify({ ...f24Gates, [GATE_KEY]: 9 }),
      annual_counter: JSON.stringify({}),
      mixing: JSON.stringify({}),
      report_copy: JSON.stringify({ role: f24.role }),
      sort_order: Math.max(...window.rows.map((row) => Number(row.sort_order) || 0)) + 1,
    }).returning('id');
    await knex('lawn_protocol_products').where({ id: f24.id }).update({ gates: JSON.stringify({ ...f24Gates, [GATE_KEY]: 12 }), updated_at: knex.fn.now() });
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: window.protocolId,
      actor_name: 'migration 20261006150000',
      entity_type: 'protocol',
      entity_id: window.protocolId,
      action: AUDIT_ACTION,
      changed_fields: JSON.stringify(['products', 'gates']),
      before_snapshot: JSON.stringify({ f24RowId: f24.id, f24Gates }),
      after_snapshot: JSON.stringify({ dimensionRowId: inserted && (inserted.id || inserted) }),
      metadata: JSON.stringify({ migration: '20261006150000_lawn_v13_april_9x_branch', gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: AUDIT_ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const { dimensionRowId } = asObject(log.after_snapshot);
    const { f24RowId } = asObject(log.before_snapshot);
    if (dimensionRowId && (await knex.schema.hasTable('lawn_protocol_product_actuals'))
      && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: dimensionRowId }).first('id')) continue;
    if (dimensionRowId) await knex('lawn_protocol_products').where({ id: dimensionRowId, product_name: DIMENSION }).del();
    const f24 = f24RowId ? await knex('lawn_protocol_products').where({ id: f24RowId }).first('id', 'gates') : null;
    if (f24) {
      const gates = asObject(f24.gates);
      if (gates[GATE_KEY] === 12) {
        delete gates[GATE_KEY];
        await knex('lawn_protocol_products').where({ id: f24RowId }).update({ gates: JSON.stringify(gates) });
      }
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.DIMENSION = DIMENSION;
exports.GATE_KEY = GATE_KEY;
exports.APRIL_WINDOW = APRIL_WINDOW;
