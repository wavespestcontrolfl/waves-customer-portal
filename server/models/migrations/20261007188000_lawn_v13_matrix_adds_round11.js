/**
 * Lawn protocol v13 matrix adds, Codex round 11 (PR #6116). Migrations 20261007180000 to 20261007187000 are
 * pushed and frozen; this one fixes their data. Guarded, audited, put back by down().
 *
 *   1. Unambiguous take-all evidence. 182000 gave the staged September Artavia row the compound trigger
 *      "mapped_take_all_fall_1_pythium_root_rot", because the recipe line also named Pythium. A row that serves
 *      two diseases cannot prove an application was for take-all (Fast Complete records no targets, so the
 *      approval engine reads the applied row), and the plan reads one row per product per window, so the two
 *      uses cannot be separate rows. September's Artavia is the take-all pass only now (June, July and August
 *      keep Pythium); the row goes back to "mapped_take_all_fall_1", only where it still holds the 182000 text.
 *   2. The whole matrix rollback is one unit. 187000 neutralized the other matrix migrations' rollbacks when a
 *      visit or a completion references a v13 protocol, but 180000 still reverted the tracks nothing references,
 *      leaving idle protocols out of step with the catalog and the referenced ones. This down() (it runs first)
 *      also neutralizes 180000's protocol and catalog entries, and this migration's own revert, so with ANY v13
 *      protocol referenced, rolling the matrix back changes no protocol, no config and no catalog row, for
 *      referenced and idle tracks alike. With nothing referenced, nothing is rewritten and the full rollback runs.
 */

const { anyV13ProtocolReferenced, neutralizeAuditRows, V13_VERSION } = require('../../services/lawn-v13-rollback-guard');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const round2 = require('./20261007182000_lawn_v13_matrix_adds_round2');
const round7 = require('./20261007187000_lawn_v13_matrix_adds_round7');

const ACTION = 'v13_matrix_adds_round11';
const ACTOR = 'migration 20261007188000';
const MIGRATION = '20261007188000_lawn_v13_matrix_adds_round11';
const SEP_WINDOW = matrix.WINDOWS.SEP;
const ARTAVIA = 'Artavia 2 SC (Azoxy)';
const OLD_TRIGGER = round2.TRIGGERS.find(([windowKey, product]) => windowKey === SEP_WINDOW && product === ARTAVIA)[3];
const NEW_TRIGGER = 'mapped_take_all_fall_1';

// 180000's own entries (its per-protocol revert deletes the rows it inserted from an idle track) and this
// migration's, on top of every other matrix entry 187000 already covers.
const EMPTY_BY_ACTION = {
  ...round7.EMPTY_BY_ACTION,
  [matrix.ACTION]: { inserted: [], updates: [], windows: [], renamed: [] },
  [matrix.CATALOG_ACTION]: { products: [], aliases: [], arena: null, watering: [] },
  [ACTION]: { rows: [] },
};

function parse(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

async function septemberArtaviaRows(knex, protocolId) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocolId, 'w.window_key': SEP_WINDOW, 'p.product_name': ARTAVIA })
    .select('p.id', 'p.gates');
}

const REQUIRED = ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const rows = [];
    for (const row of await septemberArtaviaRows(knex, protocol.id)) {
      const gates = parse(row.gates);
      if (gates.trigger !== OLD_TRIGGER) continue;
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, trigger: NEW_TRIGGER }), updated_at: knex.fn.now() });
      rows.push(row.id);
    }
    if (!rows.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['gates']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  if (await anyV13ProtocolReferenced(knex)) {
    const changed = await neutralizeAuditRows(knex, EMPTY_BY_ACTION);
    console.log(`[lawn-v13-matrix-adds-round11] a visit or completion references ${V13_VERSION}: ${changed} matrix rollback entries kept as they are, for every track; protocol, config and catalog facts stay`);
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    for (const id of parse(log.after_snapshot).rows || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first('gates');
      const gates = row ? parse(row.gates) : null;
      if (gates && gates.trigger === NEW_TRIGGER) {
        await knex('lawn_protocol_products').where({ id }).update({ gates: JSON.stringify({ ...gates, trigger: OLD_TRIGGER }), updated_at: knex.fn.now() });
      }
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.OLD_TRIGGER = OLD_TRIGGER;
exports.NEW_TRIGGER = NEW_TRIGGER;
exports.EMPTY_BY_ACTION = EMPTY_BY_ACTION;
