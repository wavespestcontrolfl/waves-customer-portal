/**
 * Lawn protocol v13 count caps (Codex round 14 on #6104): make sure the DB-backed v13 protocol
 * exposes Blindside, and its cap, wherever it lists Celsius.
 *
 * The recipe's rule is "use Blindside after the Celsius cap": Blindside is the after-cap weed spot in
 * every window that lists Celsius. 20261005140000 added that spot row to the staged windows; a
 * protocol set staged without it (a window added later, a row removed) left the DB-backed protocol
 * unable to show it. This inserts the row wherever it is missing, per v13 protocol window that has a
 * Celsius row and no Blindside row (matched by product id or by name):
 *
 *   product      Blindside Herbicide, resolved ONCE by exact catalog name (active rows first), else an
 *                exact alias. Unresolvable: skipped with a log line (an optional spot product).
 *   role / mode  post_emergent_spot / spot, rate by label, never a default selection (default_in_plan false)
 *   gates        { trigger: 'celsius_annual_cap_reached', annualMaxApps: 2 }
 *   counter      { maxApplications: 2 }
 *
 * Insert-if-missing only: an existing Blindside row is never touched (20261007175000 already carried
 * the cap onto those). One audit row per protocol lists what was inserted. down() deletes only the
 * inserted rows that still hold exactly what was written and are not default selections.
 */
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const BLINDSIDE = 'Blindside Herbicide';
const CELSIUS = 'Celsius WG';
const ACTION = 'v13_blindside_protocol_row';
const CAP = 2;
const GATES = { trigger: 'celsius_annual_cap_reached', annualMaxApps: CAP };
const COUNTER = { maxApplications: CAP };

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function resolveBlindsideId(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(BLINDSIDE));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(BLINDSIDE));
  return alias ? alias.product_id : null;
}

const hasTables = async (knex) => {
  for (const table of ['lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocols', 'lawn_protocol_audit_log', 'products_catalog']) {
    if (!(await knex.schema.hasTable(table))) return false;
  }
  return true;
};

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', staged.V13_VERSION)
    .select('p.lawn_protocol_window_id as window_id', 'p.product_id', 'p.product_name', 'p.sort_order', 'l.id as protocol_id');
  const windows = new Map();
  for (const row of rows) {
    if (!windows.has(row.window_id)) windows.set(row.window_id, { protocolId: row.protocol_id, names: new Set(), ids: new Set(), maxSort: 0 });
    const w = windows.get(row.window_id);
    w.names.add(row.product_name);
    if (row.product_id) w.ids.add(String(row.product_id));
    w.maxSort = Math.max(w.maxSort, Number(row.sort_order) || 0);
  }
  const needs = [...windows.entries()].filter(([, w]) => w.names.has(CELSIUS) && !w.names.has(BLINDSIDE));
  if (!needs.length) return;
  const blindsideId = await resolveBlindsideId(knex);
  if (!blindsideId) {
    console.log(`[lawn-v13-blindside-row] no catalog row or alias for ${BLINDSIDE}; no protocol row inserted`);
    return;
  }
  const added = new Map();
  for (const [windowId, w] of needs) {
    if (w.ids.has(String(blindsideId))) continue; // the product is already there under another name
    const [made] = await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: windowId,
      product_id: blindsideId,
      product_name: BLINDSIDE,
      role: 'post_emergent_spot',
      application_mode: 'spot',
      rate_per_1000: null,
      rate_unit: 'label_rate',
      carrier_gal_per_1000: 1,
      default_in_plan: false,
      gates: JSON.stringify(GATES),
      annual_counter: JSON.stringify(COUNTER),
      mixing: JSON.stringify({}),
      report_copy: JSON.stringify({ role: 'post_emergent_spot' }),
      sort_order: w.maxSort + 1,
    }).returning('id');
    if (!added.has(w.protocolId)) added.set(w.protocolId, []);
    added.get(w.protocolId).push(made && (made.id || made));
  }
  for (const [protocolId, ids] of added) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007179000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ blindsideRows: ids, cap: CAP }),
      metadata: JSON.stringify({ migration: '20261007179000_lawn_v13_blindside_protocol_row', gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  for (const audit of await knex('lawn_protocol_audit_log').where({ action: ACTION })) {
    for (const id of asObject(audit.after_snapshot).blindsideRows || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first('gates', 'annual_counter', 'default_in_plan', 'product_name');
      if (!row || row.product_name !== BLINDSIDE || row.default_in_plan) continue;
      const gates = asObject(row.gates);
      const counter = asObject(row.annual_counter);
      if (gates.trigger !== GATES.trigger || gates.annualMaxApps !== CAP || counter.maxApplications !== CAP) continue;
      await knex('lawn_protocol_products').where({ id }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
  }
};
