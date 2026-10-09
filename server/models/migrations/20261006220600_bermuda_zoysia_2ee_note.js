/**
 * Zoysia bermuda removal: the 2(ee) on-hand note (owner 2026-10-06, Zoysia stays, staff switch only).
 * On Zoysia the mix is a Syngenta FIFRA 2(ee) recommendation (2023-03-28), not the printed label,
 * so the tech must see a required note to keep the 2(ee) on hand. The note is the gate key
 * `zoysia2eeOnHand` on the Zoysia protocol's staged bermuda removal rows (April and June, all three
 * lines); waveguard-plan-engine.js maps the key to the required note text. St. Augustine rows are
 * never touched. The recipe JSON is unchanged.
 *
 * Appends the key only where absent. Audit is append-only: one ':seeded' event per row changed.
 * down() removes the key only from rows a ':seeded' event names (and only while it is still there),
 * appends a ':reverted' event per original event id, and skips an original already reverted.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006220600_bermuda_zoysia_2ee_note';
const SEEDED = `migration:${MIGRATION}:seeded`;
const REVERTED = `migration:${MIGRATION}:reverted`;
const V13_VERSION = '2026.10-v13';
const ZOYSIA_KEY = 'swfl_zoysia_10_10';
const GATE_KEY = 'zoysia2eeOnHand';

const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products')) || !(await knex.schema.hasTable('lawn_protocols'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION, 'l.protocol_key': ZOYSIA_KEY })
    .whereRaw("p.gates->>'bermudaRemoval' = 'true'")
    .whereRaw('NOT jsonb_exists(p.gates, ?)', [GATE_KEY])
    .select('p.id', 'p.product_name');
  for (const row of rows) {
    await knex('lawn_protocol_products').where({ id: row.id }).whereRaw('NOT jsonb_exists(gates, ?)', [GATE_KEY])
      .update({ gates: knex.raw('gates || ?::jsonb', [JSON.stringify({ [GATE_KEY]: true })]), updated_at: knex.fn.now() });
    if (canAudit) {
      await recordAuditEvent({
        actor_type: 'system', action: SEEDED, resource_type: 'lawn_protocol_products', resource_id: String(row.id),
        metadata: { migration: MIGRATION, product: row.product_name, key: GATE_KEY }, critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products')) || !(await knex.schema.hasTable('audit_log'))) return;
  const seeded = await knex('audit_log').where({ action: SEEDED }).select('id', 'resource_id', 'metadata');
  const done = new Set((await knex('audit_log').where({ action: REVERTED }).select('metadata')).map((row) => String(meta(row).originalAuditId)));
  for (const row of seeded) {
    if (done.has(String(row.id))) continue;
    const removed = (await knex('lawn_protocol_products').where({ id: row.resource_id }).whereRaw('jsonb_exists(gates, ?)', [GATE_KEY])
      .update({ gates: knex.raw('gates - ?::text', [GATE_KEY]), updated_at: knex.fn.now() })) > 0;
    await recordAuditEvent({
      actor_type: 'system', action: REVERTED, resource_type: 'lawn_protocol_products', resource_id: String(row.resource_id),
      metadata: { migration: MIGRATION, originalAuditId: row.id, key: GATE_KEY, removed }, critical: true, trx: knex,
    });
  }
};
