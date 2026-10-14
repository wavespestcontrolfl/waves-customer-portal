// Post-application watering rule for Blindside Herbicide (lawn protocol v13
// adds it as the fallback weed spot after the Celsius annual cap, #5942).
// Label read 2026-10-05 (EPA 279-3411, 2024-07-18): "Best weed control results
// will be obtained when no rainfall or irrigation occurs within 24 hours after
// application." Without a stored rule the row derived the same 24-hour hold as
// a guess; this records it as the label's own.
//
// Fill-only-empty by exact catalog name, one audit_log row per write, and a
// documented no-op down (waves-db SKILL: a seed whose up() preserves admin
// edits never reverts on rollback), as in 20261005235500.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006090000_watering_rule_blindside';
const NAME = 'Blindside Herbicide';
const RULE = {
  mode: 'hold',
  hold_hours: 24,
  source: 'label',
  label_note: 'Label: "Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application."',
  verified_at: '2026-10-05T00:00:00.000Z',
  verified_by: 'label-check-2026-10-05',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const rows = await knex('products_catalog').where({ name: NAME }).whereNull('post_application_watering').select('id', 'name');
  for (const row of rows) {
    const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
      .update({ post_application_watering: JSON.stringify(RULE), updated_at: knex.fn.now() });
    if (!updated || !canAudit) continue;
    // audit_log.actor_id is a uuid column: the migration identifies itself in
    // action + metadata, as the other data migrations do.
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:seeded`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.name, before: null, after: RULE },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op: see the header. The audit row keeps the before value.
exports.down = async function down() {};

exports.NAME = NAME;
exports.RULE = RULE;
