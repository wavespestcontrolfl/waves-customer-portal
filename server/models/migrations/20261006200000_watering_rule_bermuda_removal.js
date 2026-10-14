// Post-application watering rules for the two products of the lawn bermuda
// removal step (owner 2026-10-06, PR #6035, dark behind GATE_LAWN_BERMUDA_REMOVAL):
// Recognition and Fusilade II, always applied together as one spot tank mix on
// the April and June v13 visits. Without a stored rule each row would derive a
// water-in from its liquid/dry form, which is wrong: both are foliar herbicides
// that must stay on the leaf.
// Rule: no water-in, and no rain or irrigation for 3 hours after (owner plan
// 2026-10-06, from the Recognition application guidance: rain-free about 3 h;
// Fusilade II alone is rainfast in 1 h, so the mix follows the longer hold).
//
// Fill-only-empty by exact catalog name, one audit_log row per write, and a
// documented no-op down (waves-db SKILL), as in 20261006090000.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006200000_watering_rule_bermuda_removal';
const RULE = {
  mode: 'hold',
  hold_hours: 3,
  source: 'owner',
  label_note: 'Foliar herbicide tank mix (Recognition + Fusilade II): do not water in. Owner (bermuda removal plan 2026-10-06): no rain or irrigation for 3 hours after.',
  verified_at: '2026-10-06T00:00:00.000Z',
  verified_by: 'label-check-2026-10-06',
};
const ITEMS = [
  { name: 'Recognition Post Emergent Herbicide', rule: RULE },
  { name: 'Fusilade II Post Emergent Liquid Herbicide', rule: RULE },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) {
    const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (!updated || !canAudit) continue;
      // audit_log.actor_id is a uuid column: the migration identifies itself in
      // action + metadata, as the other data migrations do.
      await recordAuditEvent({
        actor_type: 'system',
        action: `migration:${MIGRATION}:seeded`,
        resource_type: 'products_catalog',
        resource_id: String(row.id),
        metadata: { migration: MIGRATION, product: row.name, before: null, after: item.rule },
        critical: true,
        trx: knex,
      });
    }
  }
};

// Documented no-op: see the header. The audit row keeps the before value.
exports.down = async function down() {};

exports.ITEMS = ITEMS;
exports.RULE = RULE;
