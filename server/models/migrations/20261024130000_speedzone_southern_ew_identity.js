// SpeedZone Southern: the catalog row is the EW (owner 2026-10-24, the jug on the truck: "its EW").
//
// The active row already carries the EW's EPA number (2217-1031) but kept the EC's formulation and
// actives ("EC", mecoprop-p). The EW label (PBI-Gordon, EPA 2217-1031): 2,4-D 2-ethylhexyl ester 9.02%,
// 2,4-DP-p 2-ethylhexyl ester 5.19%, dicamba 0.59%, carfentrazone-ethyl 0.47%; "Rainfast in as little as
// 3 hours"; not on Floratam or Bitterblue St. Augustine. Its watering rule (the owner's 24-hour hold with
// the label's 3 hours as label_minimum) already reads the EW and is not touched. MOA Group 14 + 4 stays.
//
// Written only while every field still holds the value read from production on 2026-10-24 (an admin edit
// leaves the row alone, logged). The inactive "SpeedZone Southern EW" duplicate row is not touched. One
// audit_log row. Down is a documented no-op (waves-db SKILL): the audit row keeps the before values.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261024130000_speedzone_southern_ew_identity';
const NAME = 'SpeedZone Southern';
const LOG = '[speedzone-southern-ew-identity]';

// column: [before, after]
const SET = {
  formulation: ['EC', 'EW'],
  active_ingredient: ['Carfentrazone + 2,4-D + Mecoprop-p + Dicamba', '2,4-D + 2,4-DP-p (dichlorprop-p) + Dicamba + Carfentrazone-ethyl'],
  label_source_note: [
    'EPA label 2217-987 (PBI Gordon). Floratam exclusion is on label; verify each St. Augustine cultivar before applying. SpeedZone Southern EW label (EPA 2217-1031) + SDS owner-provided 2026-07-03; inventory SKU SPEEDZONE-SOUTHERN-EW confirms the EW formulation. EPA Reg. No. corrected 2217-987 (unsupported) → 2217-1031 (SpeedZone Southern EW) per owner ruling 2026-07-03; inventory SKU SPEEDZONE-SOUTHERN-EW confirms EW.',
    'SpeedZone Southern EW, EPA 2217-1031 (PBI-Gordon): 2,4-D 2-EHE 9.02%, 2,4-DP-p 2-EHE 5.19%, dicamba 0.59%, carfentrazone-ethyl 0.47%. Not on Floratam or Bitterblue St. Augustine; verify each St. Augustine cultivar before applying. Owner confirmed the EW jug 2026-10-24; inventory SKU SPEEDZONE-SOUTHERN-EW. Label + SDS owner-provided 2026-07-03 (an earlier note cited 2217-987, which is unsupported).',
  ],
  label_verified_at: ['2026-04-30T00:00:00.000Z', '2026-10-24T00:00:00.000Z'],
  label_verified_by: ['PR-1.3-seed', 'label-check-2026-10-22'],
};

function holds(stored, before) {
  if (stored instanceof Date) return stored.getTime() === Date.parse(before);
  return stored === before;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const columns = new Set(Object.keys(await knex('products_catalog').columnInfo()));
  const fields = Object.keys(SET);
  if (!fields.every((column) => columns.has(column))) return; // an older schema: change nothing
  const rows = await knex('products_catalog').where({ name: NAME }).select('id', ...fields);
  for (const row of rows) {
    const changed = fields.filter((column) => !holds(row[column], SET[column][0]));
    if (changed.length) {
      console.log(`${LOG} ${changed.join(', ')} no longer the value read 2026-10-24 (edited?): row left as it is`);
      continue;
    }
    const where = knex('products_catalog').where({ id: row.id });
    for (const column of fields) where.where(column, SET[column][0]);
    const updated = await where.update({ ...Object.fromEntries(fields.map((column) => [column, SET[column][1]])), updated_at: knex.fn.now() });
    if (updated && (await knex.schema.hasTable('audit_log'))) {
      // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
      await recordAuditEvent({
        actor_type: 'system',
        action: `migration:${MIGRATION}:catalog`,
        resource_type: 'products_catalog',
        resource_id: String(row.id),
        metadata: {
          migration: MIGRATION,
          product: NAME,
          before: Object.fromEntries(fields.map((column) => [column, SET[column][0]])),
          after: Object.fromEntries(fields.map((column) => [column, SET[column][1]])),
        },
        critical: true,
        trx: knex,
      });
    }
  }
};

// Documented no-op: see the header. The audit row keeps every before value.
exports.down = async function down() {};

exports.SET = SET;
