// Round 3 of the herbicide 24-hour hold (Codex round 3 on PR #6243). The three
// earlier files (20261009120000, ...180000, ...181000) have all run on the
// Railway preview and stay byte-identical (waves-db SKILL §4); this file
// supersedes the follow-up's field-sheet step.
//
// The follow-up raised lawn_protocol_products gates.noRainOrIrrigationHours on
// the bermuda-removal rows only where the value was still the seeded 3, so an
// edited value between 4 and 23 kept printing a shorter hold on the Fast
// Complete sheet than the 24 hours the customer report now carries. The
// owner's ruling is a FLOOR on the field sheet too: every bermuda-removal row
// whose gate is below 24 goes to 24, the other gate keys stay as they are
// (jsonb_set on the one key), compare-and-set on the value read, one audit
// row each. A gate at or above 24, or a row without the gate, is untouched.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261009182000_watering_rule_herbicide_24h_hold_round3';
const FIELD_GATE = Object.freeze({ key: 'noRainOrIrrigationHours', floor: 24 });

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const rows = await knex('lawn_protocol_products')
    .whereRaw("gates->>'bermudaRemoval' = 'true'")
    .whereRaw('(gates->>?)::numeric < ?', [FIELD_GATE.key, FIELD_GATE.floor])
    .select('id', 'product_name', knex.raw('(gates->>?)::numeric AS hours', [FIELD_GATE.key]));
  for (const row of rows) {
    const before = Number(row.hours);
    const updated = await knex('lawn_protocol_products')
      .where({ id: row.id })
      .whereRaw('(gates->>?)::numeric = ?', [FIELD_GATE.key, before])
      .update({
        gates: knex.raw('jsonb_set(gates, ?, ?::jsonb)', [`{${FIELD_GATE.key}}`, JSON.stringify(FIELD_GATE.floor)]),
        updated_at: knex.fn.now(),
      });
    if (!updated || !canAudit) continue;
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:field_gate_floor`,
      resource_type: 'lawn_protocol_products',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.product_name, gate: FIELD_GATE.key, before, after: FIELD_GATE.floor },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op (waves-db SKILL: a data-correction migration never reverts
// on rollback). The audit rows keep every before value.
exports.down = async function down() {};

exports.FIELD_GATE = FIELD_GATE;
