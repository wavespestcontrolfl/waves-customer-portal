// Post-application watering rule for LESCO Dimension 0.21% 18-0-10 (dithiopyr
// plus fertilizer, granular), which lawn protocol v13 uses on the 9-visit plan's
// April spreader visit (cadenceVariants["9"]). Without a stored rule the row
// derives a 0.25-inch water-in from its granular form, a guess.
// Label (EPA master, read 2026-10-05): "A best practice for improved weed
// control is when treated lawn or ornamental turfgrass is watered or receives
// rainfall within a few days after application of this product." No amount, so
// the rule is the owner's v13 pre-emergent choice, as for Stonewall 4FL,
// Dimension 2EW and Stonewall 15-0-15 in 20261005235500: 0.5 inch within 24 h.
//
// Fill-only-empty by exact catalog name, one audit_log row per write, and a
// documented no-op down (waves-db SKILL), as in 20261005235500.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006120000_watering_rule_dimension_18_0_10';
const NAME = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
const RULE = {
  mode: 'water_in',
  water_in_inches: 0.5,
  water_in_by_hours: 24,
  source: 'owner',
  label_note: 'Label: watered or receives rainfall "within a few days after application" (no amount). Owner (protocol v13): water in 0.5 inch within 24 hours.',
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
