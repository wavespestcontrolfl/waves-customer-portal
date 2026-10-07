/**
 * Lawn protocol v13 count caps (Codex round 9 on #6104): mirror the yearly count cap into the DB
 * protocol source.
 *
 * lawn-protocol-v13.json states the caps (Celsius, Certainty and Blindside: up to 2 applications per
 * lawn per year each; Arena the same, app-enforced) but the staged lawn_protocol_products rows the
 * operating layer serves (/api/admin/protocols/lawn/window, the plan and the field screens) carried
 * no count metadata. This adds it to every staged v13 row of those four products:
 *
 *   gates.annualMaxApps = 2                       the cap, as the operating layer reads gates
 *   annual_counter.maxApplications = 2            the same figure beside the counter name
 *
 * The cap itself stays behind GATE_LAWN_V13 (server/config/lawn-v13-count-caps.js): these rows are
 * the staged v13 protocol, which no reader serves with the gate off. The same product_id links are
 * what that config resolves the cap's product identity from, so a catalog rename does not drop it.
 *
 * Insert-only and guarded: a key is added only where absent (an edited value is never replaced), one
 * audit row per protocol lists each row and what was added, and down() removes a key only where it
 * was added by this migration and still equals what it wrote.
 */
const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { V13_COUNT_CAPS } = require('../../config/lawn-v13-count-caps');

const ACTION = 'v13_count_caps_protocol_rows';
const CAP = 2;
const NAMES = V13_COUNT_CAPS.map((entry) => entry.name);

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const hasTables = async (knex) => {
  for (const table of ['lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocols', 'lawn_protocol_audit_log']) {
    if (!(await knex.schema.hasTable(table))) return false;
  }
  return true;
};

const stagedRows = (knex) => knex('lawn_protocol_products as p')
  .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
  .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
  .where('l.version', staged.V13_VERSION)
  .whereIn('p.product_name', NAMES)
  .select('p.id', 'p.gates', 'p.annual_counter', 'l.id as protocol_id');

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const byProtocol = new Map();
  for (const row of await stagedRows(knex)) {
    const gates = asObject(row.gates);
    const counter = asObject(row.annual_counter);
    const added = { id: row.id, gate: false, counter: false };
    const update = {};
    if (gates.annualMaxApps === undefined) { update.gates = JSON.stringify({ ...gates, annualMaxApps: CAP }); added.gate = true; }
    if (counter.maxApplications === undefined) { update.annual_counter = JSON.stringify({ ...counter, maxApplications: CAP }); added.counter = true; }
    if (!added.gate && !added.counter) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
    if (!byProtocol.has(row.protocol_id)) byProtocol.set(row.protocol_id, []);
    byProtocol.get(row.protocol_id).push(added);
  }
  for (const [protocolId, rows] of byProtocol) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007175000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ cap: CAP, rows }),
      metadata: JSON.stringify({ migration: '20261007175000_lawn_v13_count_caps_protocol_rows', gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  for (const audit of await knex('lawn_protocol_audit_log').where({ action: ACTION })) {
    const { rows = [] } = asObject(audit.after_snapshot);
    for (const added of rows) {
      const row = await knex('lawn_protocol_products').where({ id: added.id }).first('gates', 'annual_counter');
      if (!row) continue;
      const update = {};
      const gates = asObject(row.gates);
      const counter = asObject(row.annual_counter);
      if (added.gate && gates.annualMaxApps === CAP) { delete gates.annualMaxApps; update.gates = JSON.stringify(gates); }
      if (added.counter && counter.maxApplications === CAP) { delete counter.maxApplications; update.annual_counter = JSON.stringify(counter); }
      if (Object.keys(update).length) await knex('lawn_protocol_products').where({ id: added.id }).update({ ...update, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
  }
};
