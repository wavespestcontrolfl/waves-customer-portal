/**
 * Audit trail for the bermuda removal staged rows (migration 20261006190100,
 * GATE_LAWN_BERMUDA_REMOVAL). The v13 protocols record every seed in
 * lawn_protocol_audit_log (action 'seed_v13'); 190100 added products to two of
 * those protocols without a row. This migration writes ONE entry per affected
 * protocol (St. Augustine and Zoysia v13), shaped like its v13 neighbours: actor
 * 'migration 20261006190100', the protocol as entity, and a snapshot of the rows
 * added (window, product, mode, rate, gates). 190100 is pushed and frozen, so the
 * entry lives here.
 *
 * Idempotent: a protocol that already has the entry is skipped; a protocol with no
 * bermuda rows (190100 found no product to link, or the protocol is absent) gets
 * none. down() deletes exactly the entries this migration wrote.
 */
const V13_VERSION = '2026.10-v13';
const PROTOCOL_KEYS = ['swfl_st_augustine_10_10', 'swfl_zoysia_10_10'];
const ACTION = 'seed_v13_bermuda_removal';
const ACTOR = 'migration 20261006190100';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocols'))) return;
  for (const key of PROTOCOL_KEYS) {
    const protocol = await knex('lawn_protocols').where({ protocol_key: key, version: V13_VERSION }).first('id');
    if (!protocol) continue;
    if (await knex('lawn_protocol_audit_log').where({ lawn_protocol_id: protocol.id, action: ACTION }).first('id')) continue;
    const rows = await knex('lawn_protocol_products as p')
      .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
      .where('w.lawn_protocol_id', protocol.id)
      .whereRaw("p.gates->>'bermudaRemoval' = 'true'")
      .select('w.window_key', 'p.product_name', 'p.product_id', 'p.application_mode', 'p.rate_per_1000', 'p.rate_unit', 'p.gates')
      .orderBy('w.window_key').orderBy('p.sort_order');
    if (!rows.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({
        protocol_key: key,
        version: V13_VERSION,
        added_products: rows.map((row) => ({
          window_key: row.window_key,
          product_name: row.product_name,
          product_id: row.product_id,
          application_mode: row.application_mode,
          rate_per_1000: row.rate_per_1000 == null ? null : Number(row.rate_per_1000),
          rate_unit: row.rate_unit,
          gates: row.gates,
        })),
      }),
      metadata: JSON.stringify({ migration: '20261006190100_lawn_bermuda_removal_rows', gate: 'GATE_LAWN_BERMUDA_REMOVAL', rows: rows.length }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  await knex('lawn_protocol_audit_log').where({ action: ACTION, actor_name: ACTOR }).del();
};
