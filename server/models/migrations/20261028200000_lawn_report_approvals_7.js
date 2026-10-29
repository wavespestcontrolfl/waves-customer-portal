// The last seven lawn products not approved for service reports are approved (owner 2026-10-28, "ok do the seven
// products"), after 20261028190000 approved the eleven in stock.
//
// Why: a product that is not approved for service reports freezes no report facts, so its watering rule (stored by
// 20261027190000) never reaches the visit's watering text (report-data.js approvedReportProductFacts), and a lawn
// visit that logs one gets no watering text and an office alert. None of the seven is in stock today.
//
// Report copy is the wording the approved sister products carry, verbatim from the production catalog 2026-10-28:
//   - LESCO 8-0-12 Palm #511542 and 0-0-16 Palm #510513: as LESCO 8-2-12 and 8-0-10 Palm (their labels: "Slowly
//     Available" nitrogen or potash from polymer-coated sources, so the controlled-release line holds).
//   - LESCO 24-0-11 50% NOS 30% BIO: as LESCO 24-0-11 with PolyPlus OPTI, but with the fertilizer line of
//     20261028190000 (no "controlled release": its label has only 0.30% slowly available nitrogen).
//   - Azoxy 2SC Select, Insignia SC Intrinsic, LESCO Spectator T&O: the approved fungicide copy (28 of 31 approved
//     fungicides carry it). Their labels: "Do not allow entry into treatment area until area that was treated with
//     this product is dry." and "DO NOT enter or allow others to enter treated areas until sprays have dried." Their
//     mode-of-action groups and EPA numbers are already on the rows (89442-21, 7969-290, 100-1432-10404).
//   - Southern Ag Manganese Sulfate: the one new line, the approved micronutrient line without the chelation clause
//     (manganese sulfate is not a chelate), with the approved granule precaution and re-entry.
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only
// while it is false). A missing row or an already-set field is a logged no-op, never an overwrite, so any admin edit
// stands. One audit_log row per write, with before and after. Down is a documented no-op (waves-db SKILL: a
// data-correction migration never reverts on rollback); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261028200000_lawn_report_approvals_7';
const LOG = '[lawn-report-approvals-7-20261028]';

// Approved wording, verbatim from the production catalog 2026-10-28.
const BLEND_SUMMARY = 'A professional-grade fertilizer blend feeding the documented plants or turf — supporting density, color, root development, and recovery on a controlled release schedule.';
const FERTILIZER_SUMMARY = 'A professional-grade fertilizer feeding the documented turf or plants — supporting density, color, root development, and recovery.';
const FUNGICIDE_SUMMARY = 'A fungicide that protects turf and plants from fungal disease; it is absorbed into or coats the plant tissue to stop disease organisms from establishing and spreading.';
const GRANULE_PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf or beds; watering-in follows the visit notes. No re-entry wait once watered in and dry.';
const SPRAY_PRECAUTION = 'Per the product label: keep people and pets off treated areas until sprays have dried.';
const WATER_IN_REENTRY = 'Water in per the visit notes; no re-entry wait once dry.';
const WATERED_IN_REENTRY = 'Stay off treated areas until the product has been watered in and the turf is dry.';
const DRY_REENTRY = 'Stay off treated areas until the application has dried.';

// New line (see the header).
const MICRONUTRIENT_SUMMARY = 'A micronutrient application supporting leaf color and healthy new growth.';

const copy = (summary, precaution, reentry) => ({
  approved_for_service_report: { when: 'false', value: true },
  service_report_summary: { when: 'null', value: summary },
  customer_precaution_summary: { when: 'null', value: precaution },
  reentry_summary: { when: 'null', value: reentry },
});

// { name, fields: { column: { when, value } } }. 'null' = write while the column is NULL; 'false' = write while it is false.
const ITEMS = [
  { name: 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)', fields: copy(BLEND_SUMMARY, GRANULE_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (#510513)', fields: copy(BLEND_SUMMARY, GRANULE_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP', fields: copy(FERTILIZER_SUMMARY, GRANULE_PRECAUTION, WATERED_IN_REENTRY) },
  { name: 'Southern Ag Manganese Sulfate', fields: copy(MICRONUTRIENT_SUMMARY, GRANULE_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'Azoxy 2SC Select', fields: copy(FUNGICIDE_SUMMARY, SPRAY_PRECAUTION, DRY_REENTRY) },
  { name: 'Insignia SC Intrinsic', fields: copy(FUNGICIDE_SUMMARY, SPRAY_PRECAUTION, DRY_REENTRY) },
  { name: 'LESCO Spectator T&O', fields: copy(FUNGICIDE_SUMMARY, SPRAY_PRECAUTION, DRY_REENTRY) },
];

async function audit(knex, canAudit, row, column, before, after) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${column}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, column, before, after },
    critical: true,
    trx: knex,
  });
}

async function applyItem(knex, canAudit, item) {
  const columns = [];
  for (const column of Object.keys(item.fields)) {
    if (await knex.schema.hasColumn('products_catalog', column)) columns.push(column);
    else console.log(`${LOG} ${item.name}: products_catalog.${column} does not exist: field skipped`);
  }
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', ...columns);
  if (!rows.length) console.log(`${LOG} ${item.name}: no catalog row: nothing to do`);
  for (const row of rows) {
    for (const column of columns) {
      const { when, value } = item.fields[column];
      const stored = row[column];
      const open = when === 'null' ? stored == null : stored === false;
      if (!open) {
        console.log(`${LOG} ${item.name}: ${column} already set: left as it is`);
        continue;
      }
      const where = knex('products_catalog').where({ id: row.id });
      if (when === 'null') where.whereNull(column);
      else where.where(column, false);
      const updated = await where.update({ [column]: value, updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, when === 'null' ? null : false, value);
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) await applyItem(knex, canAudit, item);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.ITEMS = ITEMS;
