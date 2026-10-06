// Post-application watering rule for the two liquid micronutrient sprays
// (owner 2026-10-03, labels read that day):
//
//   LESCO Chelated Iron Plus 12-0-0 (#084043, 2.5 gal) and
//   LESCO High Manganese Combo (#084053, 2.5 gal) both say, under the turf
//   directions: "Avoid watering for 24 hours after application for optimal
//   results."
//
// The 20260930000001 seed left these rows empty because their labels had not
// been read. Fertilizers carry no EPA registration number, so rows are matched
// by name. Fill-only-empty: a row that already has a rule (an owner edit) is
// never overwritten. verified_at is pinned to the day the labels were read, not
// the run time, and each written row gets an audit_log entry because the field
// is admin-editable compliance data.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261003110000_watering_rule_iron_manganese_hold';
const VERIFIED_BY = 'label-check-2026-10-03';
const VERIFIED_AT = '2026-10-03T00:00:00.000Z';
const LABEL_NOTE = 'Avoid watering for 24 hours after application for optimal results.';
const NAME_PATTERNS = ['%Chelated Iron Plus%', '%High Manganese Combo%'];

const RULE = {
  mode: 'hold',
  hold_hours: 24,
  source: 'label',
  label_note: LABEL_NOTE,
  verified_at: VERIFIED_AT,
  verified_by: VERIFIED_BY,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  const rows = await knex('products_catalog')
    .whereNull('post_application_watering')
    .where((qb) => {
      for (const pattern of NAME_PATTERNS) qb.orWhere('name', 'ilike', pattern);
    })
    .select('id', 'name');

  for (const row of rows) {
    const updated = await knex('products_catalog')
      .where({ id: row.id })
      .whereNull('post_application_watering')
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

// Only a row whose rule is still EXACTLY what this migration wrote goes back to
// empty (whole-value jsonb equality). Any later admin edit, even one that keeps
// the note and the verified_by marker and changes only the hours, differs from
// RULE and is left alone. The audit rows are history.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  await knex('products_catalog')
    .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(RULE)])
    .update({ post_application_watering: null, updated_at: knex.fn.now() });
};

// For the test that proves the seeded rule is one resolveWateringRule accepts.
exports.RULE = RULE;
