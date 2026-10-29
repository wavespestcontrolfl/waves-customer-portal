// Eleven in-stock lawn products approved for service reports (owner 2026-10-28, "APPROVE").
//
// Why: a product that is not approved for service reports freezes no report facts, so its watering rule never reaches
// the visit's watering text (report-data.js approvedReportProductFacts). A lawn visit that logs one gets no watering
// text and the office gets "Lawn watering text not sent ... has no watering rule". 20261027190000 stored a label-checked
// rule on each of these eleven (all on the trucks, none logged on a lawn visit yet); this approves them, with report
// copy.
//
// Report copy reuses the wording the approved products of the same kind already carry (read from production
// 2026-10-28): the liquid fertilizers (LESCO K-Flow), chelated micronutrients (LESCO Chelated AM + Micros), soil
// amendments (LESCO CarbonPro-L, Espoma Soil Acidifier, Cytogro), plant growth regulators (Primo Maxx, Anuew EZ),
// spray adjuvants (LESCO 90/10), granular insecticides (Arena 0.25G, Dylox 6.2 G), and the generic insecticide line.
// The new lines, each from its label, in the same style:
//   - 46-0-0 urea: the approved fertilizer line without "liquid" (the catalog row is granular, and urea is not a
//     controlled-release blend).
//   - Espoma alfalfa meal: the same line as "an organic fertilizer" (Espoma Organic bag).
//   - LESCO-Wet Plus: label "a soil wetting agent that improves soil moisture uniformity and wetting in soils that are
//     susceptible to hydrophobicity or Localized Dry Spot".
//   - LESCO Tracker Green: label "a non-hazardous indicator dye added to spray tank mixes to properly identify areas
//     covered ... The temporary color disappears with rain, dew, irrigation or sunlight."
//   - Bloom City Clean Kelp: label "Kelp and Seaplant Extract ... Marine algae (Kelp) is a natural source of what's
//     needed for strong and vigorous plants."
//   - ALOFT LC G precaution and re-entry: label "Keep children and pets out of treated areas until the dust from the
//     application has settled."
// Mode-of-action groups only on the two insecticides: ALOFT LC G clothianidin (4A) + bifenthrin (3A), written
// "Group 3A + 4A" as Temprid FX; Talstar XTRA Granular bifenthrin + zeta-cypermethrin, both "Group 3A". The approved
// plant growth regulators carry none, so T-Nex carries none. The three pesticides already carry the EPA number on
// their labels (Talstar XTRA Granular 101563-388, ALOFT LC G 59639-215, T-Nex 53883-353), which report facts require.
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only
// while it is false). A missing row or an already-set field is a logged no-op, never an overwrite, so any admin edit
// stands. One audit_log row per write, with before and after. Down is a documented no-op (waves-db SKILL: a
// data-correction migration never reverts on rollback); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261028190000_lawn_report_approvals_in_stock_11';
const LOG = '[lawn-report-approvals-20261028]';

// Approved wording, verbatim from the production catalog 2026-10-28.
const LIQUID_FERTILIZER_SUMMARY = 'A professional-grade liquid fertilizer feeding the documented turf or plants — supporting density, color, root development, and recovery.';
const CHELATED_SUMMARY = 'A chelated micronutrient application supporting leaf color and healthy new growth — chelation keeps the nutrients available for uptake.';
const SOIL_AMENDMENT_SUMMARY = 'A soil amendment that improves the soil around the roots — supporting nutrient availability, root development, and overall plant resilience rather than acting on pests.';
const PGR_SUMMARY = 'A plant growth regulator that slows vertical growth so the plant redirects energy into roots and density — reducing stress and trimming needs.';
const SYSTEMIC_INSECTICIDE_SUMMARY = 'A systemic insecticide taken up by the plant and moved through its tissue, so sap-feeding and soil pests take it in as they feed — including pests concealed where sprays cannot reach. Protection builds over days and keeps working for weeks.';
const INSECTICIDE_SUMMARY = 'An insecticide applied per its label to control the documented insect activity while minimizing impact on surrounding areas.';
const MIX_PRECAUTION = 'Used only as part of a spray mix — the precautions of the products it is mixed with apply.';
const LIQUID_PRECAUTION = 'Applied in liquid form to the treated areas. If any reaches walks or driveways, it rinses off with water. Watering-in follows the visit notes — treated areas are ready once dry, and your technician confirms timing.';
const GRANULE_PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf or beds; watering-in follows the visit notes. No re-entry wait once watered in and dry.';
const SPRAY_PRECAUTION = 'Per the product label: keep people and pets off treated areas until sprays have dried.';
const WATER_IN_REENTRY = 'Water in per the visit notes; no re-entry wait once dry.';
const DRY_REENTRY = 'Stay off treated areas until the application has dried.';
const WATERED_IN_REENTRY = 'Stay off treated areas until the product has been watered in and the turf is dry.';

// New lines (see the header).
const FERTILIZER_SUMMARY = 'A professional-grade fertilizer feeding the documented turf or plants — supporting density, color, root development, and recovery.';
const ORGANIC_FERTILIZER_SUMMARY = 'An organic fertilizer feeding the documented turf or plants — supporting density, color, root development, and recovery.';
const WETTING_AGENT_SUMMARY = 'A soil wetting agent that helps water soak evenly into dry or water-repellent soil, so the root zone stays evenly moist. It is an additive, not a pesticide.';
const DYE_SUMMARY = 'A temporary marker dye added to the spray so the technician can see the areas covered; the color fades with rain, dew, watering or sunlight. It is an additive, not a pesticide.';
const KELP_SUMMARY = 'A seaweed (kelp) extract: a natural plant supplement that supports strong, vigorous growth. It is not a pesticide.';
const DUST_PRECAUTION = 'Per the product label: keep children and pets out of treated areas until the dust from the application has settled.';
const DUST_REENTRY = 'Stay off treated areas until the dust from the application has settled.';

const copy = (summary, precaution, reentry, moa) => ({
  approved_for_service_report: { when: 'false', value: true },
  service_report_summary: { when: 'null', value: summary },
  customer_precaution_summary: { when: 'null', value: precaution },
  reentry_summary: { when: 'null', value: reentry },
  ...(moa ? { moa_group: { when: 'null', value: moa } } : {}),
});

// { name, fields: { column: { when, value } } }. 'null' = write while the column is NULL; 'false' = write while it is false.
const ITEMS = [
  { name: 'LESCO-Wet Plus Nonionic Wetting Agent', fields: copy(WETTING_AGENT_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'SUPERthrive Foliage-Pro 9-3-6', fields: copy(LIQUID_FERTILIZER_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'LESCO Tracker Green Spray Indicator Dye', fields: copy(DYE_SUMMARY, MIX_PRECAUTION, DRY_REENTRY) },
  { name: 'Chelated Liquid Iron (brand TBD)', fields: copy(CHELATED_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'Quali-Pro T-Nex Plant Growth Regulator', fields: copy(PGR_SUMMARY, SPRAY_PRECAUTION, DRY_REENTRY) },
  { name: '46-0-0 Urea Professional Fertilizer', fields: copy(FERTILIZER_SUMMARY, GRANULE_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'Bloom City Clean Kelp', fields: copy(KELP_SUMMARY, LIQUID_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'ALOFT LC G INSECTICIDE', fields: copy(SYSTEMIC_INSECTICIDE_SUMMARY, DUST_PRECAUTION, DUST_REENTRY, 'Group 3A + 4A') },
  { name: 'Talstar XTRA Granular Insecticide (Verge)', fields: copy(INSECTICIDE_SUMMARY, GRANULE_PRECAUTION, WATERED_IN_REENTRY, 'Group 3A') },
  { name: 'The Andersons Humic DG', fields: copy(SOIL_AMENDMENT_SUMMARY, GRANULE_PRECAUTION, WATER_IN_REENTRY) },
  { name: 'Espoma Organic Alfalfa Meal 2-0-2', fields: copy(ORGANIC_FERTILIZER_SUMMARY, GRANULE_PRECAUTION, WATER_IN_REENTRY) },
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
