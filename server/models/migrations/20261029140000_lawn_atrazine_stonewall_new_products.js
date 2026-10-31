// Watering rule, report approval and label fields for LESCO Stonewall 0.43% 0-0-8, and label fields only for LESCO
// Atrazine 0.92% 20-0-20: the two lawn products the garage count added on 2026-10-29 at 02:58 and 02:55 ET (owner
// 2026-10-28, "make sure every product has it"; 2026-10-29, "fill the gaps on these").
//
// Both rows came in with no watering rule and no report approval, so a lawn visit that logs one gets no watering text
// and an office alert. Their labels were read 2026-10-29, on EPA's newest stamped label and the bag label SiteOne
// shows for the item (same directions):
//   - LESCO Stonewall 0.43% 0-0-8 mini granule (EPA 10404-89, accepted 2020-07-29; SiteOne #701006): the registration
//     of the approved LESCO Stonewall 0-0-7, with the same prodiamine 0.43%, so the same rule (at least 0.5 inch within
//     14 days), rates, targets and groups. Report copy is approved wording, verbatim from the production catalog: the
//     pre-emergent summary of Stonewall 0-0-7, and the precaution and re-entry lines of LESCO Dimension 18-0-10 (a
//     granular pre-emergent watered in with 1/2 inch within 14 days). Groups "Group 3" plus HRAC "3", as Stonewall 0-0-7
//     (the rotation review reads both).
//   - LESCO Atrazine 0.92% 20-0-20 weed & feed (EPA 10404-96, accepted 2021-11-10; SiteOne #HPST00105): label fields
//     only. For residential turf the label says "This product must be watered in immediately after application." and
//     the applicator must water it in or give the resident that instruction in writing. The same-day water-in rule the
//     other "immediately" labels carry words a deadline of 11 PM tonight, which does not meet that instruction, so its
//     watering rule, report approval and service line wait for the owner. Until then a visit that logs it still gets the
//     office alert. Its group is "Group 5", as Atrazine 4L.
//
// Catalog fields follow 20261029060000: label link (EPA's stamped label), SDS link (SiteOne's full SDS for the product
// family), the label's lawn rate per 1,000 sq ft with its low and high limits, target pests, a label note and label
// verification. Pack size (unit_size_oz) and every price field are left alone: unit_size_oz is the pack its best_price
// was quoted for (services/price-sync.js), and neither row has a price yet.
//
// Every write is guarded per field: a value is written only while the column is still NULL (the approval flag only while
// it is false), so a value the garage count or an admin writes first stands. validateRule runs before a rule is
// written. One audit_log row per write, with before and after. Down is a documented no-op (waves-db SKILL); the audit
// rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261029140000_lawn_atrazine_stonewall_new_products';
const LOG = '[lawn-atrazine-stonewall-20261029]';
const VERIFIED_RULE = { verified_at: '2026-10-29T00:00:00.000Z', verified_by: 'label-check-2026-10-29' };
const VERIFIED_LABEL = { label_verified_at: '2026-10-29T00:00:00.000Z', label_verified_by: 'label-check-2026-10-29' };
const JSON_COLUMNS = new Set(['post_application_watering', 'target_pests', 'service_lines']);

// Approved wording, verbatim from the production catalog 2026-10-29.
const PRE_EMERGENT_SUMMARY = 'A pre-emergent herbicide that forms an invisible barrier at the soil surface, stopping weed seeds as they germinate. It works on weeds that have not yet emerged and does not harm established plants when applied per label.';
const PRE_EMERGENT_GRANULE_PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 14 days; rain and your regular watering both count. People and pets can use the lawn once it has been watered in and the turf is dry.';
const WATERED_IN_REENTRY = 'Stay off treated areas until the product has been watered in and the turf is dry.';

const ATRAZINE = 'LESCO Atrazine 0.92% 20-0-20 25% PolyPlus OPTI45 6% Fe Post-Emergent Herbicide Plus Fertilizer';
const STONEWALL = 'LESCO Stonewall 0.43% 0-0-8 AM 2.72% S 2% Cl SOP Pre-Emergent Mini Granular Herbicide Plus Fertilizer';

const ifNull = (value) => ({ when: 'null', value });

// { name, fields: { column: { when, value } } }. 'null' = write while the column is NULL; 'false' = write while it is false.
const ITEMS = [
  {
    name: ATRAZINE,
    fields: {
      moa_group: ifNull('Group 5'),
      label_url: ifNull('https://www3.epa.gov/pesticides/chem_search/ppls/010404-00096-20211110.pdf'),
      sds_url: ifNull('https://www.siteone.com/en/pdf/sdsPDF?resourceId=2471'),
      default_rate_per_1000: ifNull(3.74),
      min_label_rate_per_1000: ifNull(3.74),
      max_label_rate_per_1000: ifNull(5),
      rate_unit: ifNull('lb'),
      target_pests: ifNull(['Dollarweed', 'Florida pusley', 'Crabgrass (pre-emergent)', 'Spurge', 'Annual bluegrass (Poa annua)', 'Chickweed']),
      label_source_note: ifNull('Label read 2026-10-29 (LESCO Atrazine 0.92% Plus Fertilizer 20-0-20, 50 lb bag, SiteOne #HPST00105, bag label rev. 9/13/22; EPA Reg. No. 10404-96, EPA-accepted 2021-11-10, https://www3.epa.gov/pesticides/chem_search/ppls/010404-00096-20211110.pdf): "Apply 3.74 lb to 5.0 lb uniformly over 1,000 sq ft of turf area." Annual limit: "Do not apply more than 4 lb a.i. Atrazine (2 applications at 5.0 lb product) per acre per year." Turf: "Do not apply to lawns/turf containing grasses or mixtures of grasses other than St. Augustine or Centipede grasses".'),
      label_verified_at: ifNull(VERIFIED_LABEL.label_verified_at),
      label_verified_by: ifNull(VERIFIED_LABEL.label_verified_by),
    },
  },
  {
    name: STONEWALL,
    fields: {
      post_application_watering: ifNull({
        mode: 'water_in',
        water_in_inches: 0.5,
        water_in_by_hours: 336,
        source: 'label',
        label_note: 'Label (EPA 10404-89, accepted 2020-07-29): "Most effective weed control will be obtained when this product is activated by at least 0.5 inch of rainfall or irrigation prior to weed seed germination and within 14 days following application." (as LESCO Stonewall 0-0-7, the same registration)',
        ...VERIFIED_RULE,
      }),
      approved_for_service_report: { when: 'false', value: true },
      service_report_summary: ifNull(PRE_EMERGENT_SUMMARY),
      customer_precaution_summary: ifNull(PRE_EMERGENT_GRANULE_PRECAUTION),
      reentry_summary: ifNull(WATERED_IN_REENTRY),
      moa_group: ifNull('Group 3'),
      hrac_group: ifNull('3'),
      label_url: ifNull('https://www3.epa.gov/pesticides/chem_search/ppls/010404-00089-20200729.pdf'),
      sds_url: ifNull('https://www.siteone.com/en/pdf/sdsPDF?resourceId=2475'),
      default_rate_per_1000: ifNull(4.02),
      min_label_rate_per_1000: ifNull(4.02),
      max_label_rate_per_1000: ifNull(5.34),
      rate_unit: ifNull('lb'),
      target_pests: ifNull(['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)']),
      label_source_note: ifNull('Label read 2026-10-29 (LESCO Stonewall 0.43% Plus Fertilizer 0-0-8 mini granule, 50 lb bag, SiteOne #701006, bag label rev. 3/28/22; EPA Reg. No. 10404-89, EPA-accepted 2020-07-29, https://www3.epa.gov/pesticides/chem_search/ppls/010404-00089-20200729.pdf): St. Augustinegrass: "Use at an initial rate of 175 to 233 lb/acre per application followed by sequential applications at doses that would not exceed the maximum annual application rate of 349 lb/acre/year." The label\'s table gives 4.02 and 5.34 lb per 1,000 sq ft for 175 and 233 lb/acre, and 8.01 a year.'),
      label_verified_at: ifNull(VERIFIED_LABEL.label_verified_at),
      label_verified_by: ifNull(VERIFIED_LABEL.label_verified_by),
      service_lines: ifNull(['lawn']),
    },
  },
];

const dbValue = (column, value) => (JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);

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
      const open = when === 'null' ? row[column] == null : row[column] === false;
      if (!open) {
        console.log(`${LOG} ${item.name}: ${column} already set: left as it is`);
        continue;
      }
      if (column === 'post_application_watering' && !validateRule(value).valid) {
        console.log(`${LOG} ${item.name}: rule rejected by validateRule: not written`);
        continue;
      }
      const where = knex('products_catalog').where({ id: row.id });
      if (when === 'null') where.whereNull(column);
      else where.where(column, false);
      const updated = await where.update({ [column]: dbValue(column, value), updated_at: knex.fn.now() });
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
