// Two corrections to the 20260930000001 seed, which has already run on the
// preview database and is therefore frozen (knex tracks by filename):
//
// 1. Celsius WG was seeded as a fixed 6-hour hold marked label-sourced. The
//    label only says "do not irrigate until the spray has dried" — a condition,
//    not a duration — and the repo prohibits inventing fixed drying times. The
//    rule becomes { mode: 'hold', hold_until: 'dry', hold_hours: null } so no
//    surface can print a drying duration. Only rows still carrying the seeded
//    6-hour label rule change; an owner edit is never touched.
// 2. Every row the seed wrote (verified_by = 'label-check-2026-09-29') gets an
//    audit_log entry recording that a migration introduced the rule, since the
//    seed changed an admin-editable compliance field with no before/after trail.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20260930000003_watering_rule_celsius_until_dry_audit';
const VERIFIED_BY = 'label-check-2026-09-29';
const CELSIUS_NOTE = 'Do not irrigate until the spray has dried.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  const seeded = await knex('products_catalog')
    .whereRaw("post_application_watering->>'verified_by' = ?", [VERIFIED_BY])
    .select('id', 'name', 'epa_reg_number', 'post_application_watering');

  for (const row of seeded) {
    const before = typeof row.post_application_watering === 'string'
      ? JSON.parse(row.post_application_watering)
      : row.post_application_watering;
    let after = before;
    // The seed matched Celsius by EPA number, else by name (Celsius%); the
    // seeded rule itself is the reliable marker: a label-sourced 6-hour hold
    // carrying the Celsius label note.
    const isCelsiusRow = String(row.epa_reg_number || '').trim() === '432-1507'
      || /^celsius/i.test(String(row.name || '').trim());
    const isSeededCelsius = isCelsiusRow
      && before && before.mode === 'hold' && before.hold_hours === 6 && before.source === 'label'
      && before.hold_until == null;
    if (isSeededCelsius) {
      after = { ...before, hold_until: 'dry', hold_hours: null, label_note: CELSIUS_NOTE };
      await knex('products_catalog').where({ id: row.id })
        .update({ post_application_watering: JSON.stringify(after), updated_at: knex.fn.now() });
    }
    // audit_log.actor_id is a uuid column: the migration identifies itself in
    // action + metadata, as the other data migrations do.
    if (!canAudit) continue;
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:${isSeededCelsius ? 'corrected' : 'seeded'}`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: {
        migration: MIGRATION,
        product: row.name,
        epa_reg_number: row.epa_reg_number || null,
        // The seed wrote over NULL (fill-only-empty), so the prior value is known.
        before: isSeededCelsius ? before : null,
        after,
        seeded_by: '20260930000001_products_catalog_post_application_watering',
      },
      critical: true,
      trx: knex,
    });
  }
};

// The audit rows are history; the Celsius condition is the correct reading of
// the label, so there is nothing safe to restore.
exports.down = async function down() {};
