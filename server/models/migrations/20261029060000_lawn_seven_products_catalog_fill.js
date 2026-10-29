// Catalog fields for the seven lawn products the garage count added on 2026-10-28 (owner 2026-10-29, "fill the gaps on
// these"). Their watering rules and report approval went live in 20261029030000, 20261029040000 and 20261029050000; the
// rows still lacked what the approved lawn products normally carry: label and SDS links, the label's lawn rate per
// 1,000 sq ft, target pests, a label note and service lines.
//
// Labels and SDS sheets were read 2026-10-29; each label_source_note quotes the label's lawn rate line, or says the label
// has none. A field stays empty where the label gives nothing: no lawn rate per area for Thuricide BT (no turf on the
// label), Blue Planet seaweed (per gallon of water only) or the herbicide surfactant (per 100 gallons of mix only), and no
// SDS link for Spar-TECH Micro Mix (SiteOne lists only a generic granular-fertilizer sheet) or Blue Planet (none found).
// Service lines are "lawn", except "tree_shrub" for Thuricide BT, whose label names shade trees and ornamentals and no
// turf; a tagged product without "lawn" still shows under "other" in the lawn picker (client/src/lib/fast-complete-products.js).
// The Andersons row keeps its 18 lb label link (the 40 lb label the note cites has the same directions).
//
// Pack size in ounces (unit_size_oz) and every price field are left alone: unit_size_oz is the pack its best_price was
// quoted for (services/price-sync.js), so it belongs to the price entry. The Andersons price on file is for an 18 lb
// bag (288 oz), and the garage holds 40 lb bags.
//
// Label corrections, each written only while the column holds exactly the old value:
// - Quali-Pro Imidacloprid 2F T&O: EPA's transfer history moves the registration from 66222-203 to 53883-514 (Control
//   Solutions), and the current label prints 53883-514 and imidacloprid 21.8% (the row said 21.4%, Merit 2F's figure).
//   20261029050000 wrote 66222-203 and the 2013 PPLS link; both move to the current number and label.
// - Spar-TECH Micro Mix: the active ingredient said "analysis pending label read"; the label guarantees 2.5% Mg,
//   0.05% Cu, 1% Fe, 1.3% Mn and 0.05% Zn.
// - Spar-TECH 13-0-0: the label confirms the SiteOne analysis, so "(per SiteOne listing)" comes off the text a service
//   report can show.
//
// Every fill is guarded per field: a value is written only while the column is still NULL, so an admin edit stands. One
// audit_log row per write, with before and after. Down is a documented no-op (waves-db SKILL); the audit rows keep every
// before value.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261029060000_lawn_seven_products_catalog_fill';
const LOG = '[lawn-seven-catalog-fill-20261029]';
const VERIFIED = { label_verified_at: '2026-10-29T00:00:00.000Z', label_verified_by: 'label-check-2026-10-29' };
const JSON_COLUMNS = new Set(['target_pests', 'service_lines']);

// { name, fill: { column: value } }: each column written only while it is NULL.
const ITEMS = [
  {
    name: 'The Andersons 17-0-3 Fertilizer with Grubout Plus',
    fill: {
      sds_url: 'https://assets.theandersons.com/m/1d44ff00cc7f4e70/original/17-0-3-Fertilizer-with-GrubOut-Plus-SDS-pdf.pdf',
      default_rate_per_1000: 3.3,
      min_label_rate_per_1000: 2.2,
      max_label_rate_per_1000: 4.6,
      rate_unit: 'lb',
      target_pests: ['White grubs', 'Chinch bugs', 'Mole crickets', 'Billbugs', 'Fire ants', 'Sod webworms'],
      label_source_note: 'Label read 2026-10-29 (The Andersons 17-0-3 Fertilizer with GrubOut Plus, 40 lb bag, EPA Reg. No. 228-610-9198, label 10007802 F24, rev. RV082517, (c) 2024, https://assets.theandersons.com/m/4e0e8a2325f6ebfa/original/10007802_17-0-3-GrubOut-Plus_40-lb-pdf.pdf): Lawn rates. Ants, armyworms, sod webworms, fleas, ticks: "Apply at the rate of 2.2 lb to 3.3 lb per 1,000 sq. ft." Billbugs, grubs, chinch bugs, mole crickets: "Apply 3.3 lb. per 1,000 sq. ft. of lawn." and "3.4 - 4.6 lb per 1,000 sq ft"; chinch bugs and mole crickets "4.6 lb per 1,000 sq ft".',
      service_lines: ['lawn'],
    },
  },
  {
    name: 'LESCO Spar-TECH Micro Mix',
    fill: {
      label_url: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/559490504053_label/559490504053-label.pdf',
      default_rate_per_1000: 0.5,
      min_label_rate_per_1000: 0.5,
      max_label_rate_per_1000: 2,
      rate_unit: 'fl_oz',
      target_pests: ['Micronutrient deficiency', 'Iron chlorosis (yellowing turf)', 'Deep green color'],
      label_source_note: 'Label read 2026-10-29 (LESCO Spar-TECH MICRO MIX, 30 gal, #511403-30, label dated 2024-03-12; the 2.5 gal jug #511403-2.5 has only a 2026-02-14 front panel with no directions, https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/559490504053_label/559490504053-label.pdf): "Fairways, Lawns, Athletic Fields, and other Turf Areas - apply 0.5 - 2 ounces/1,000 sq ft in sufficient water for thorough coverage (usually 1-5 gallons per 1,000 sq ft)." Ounces read as fluid ounces (SiteOne: 1 gal covers up to 256,000 sq. ft.).',
      service_lines: ['lawn'],
    },
  },
  {
    name: 'LESCO Spar-TECH 13-0-0',
    fill: {
      label_url: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/551939858192_label/551939858192-label.pdf',
      sds_url: 'https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/safetyDataSheet/rb-ue-msds-32091_771106_msds_143-7sds-532253/rb-ue-msds-32091-771106-msds-143-7sds-532253.pdf',
      default_rate_per_1000: 0.5,
      min_label_rate_per_1000: 0.5,
      max_label_rate_per_1000: 2,
      rate_unit: 'fl_oz',
      target_pests: ['Nitrogen green-up', 'Iron chlorosis (yellowing turf)', 'Manganese deficiency', 'Deep green color'],
      label_source_note: 'Label read 2026-10-29 (LESCO Spar-TECH 13-0-0 6% Fe 1% Mn, 2.5 gal, #511362-2.5, label dated 2024-03-12, https://www.siteone.com/medias/sys_master/PimProductImages/assets/ProductAssets/US/LESCO/labelAsset/551939858192_label/551939858192-label.pdf): "Golf, Residential Lawns, Athletic Fields, and other Turf Areas - apply 0.5 - 2 ounces/1,000 sq ft in sufficient water for thorough coverage (usually 1-5 gallons per 1,000 sq ft) Three to four applications per growing season are recommended to maintain vigorous turf." Ounces read as fluid ounces (SiteOne page: 0.5 fl oz. per 1,000 sq. ft.).',
      service_lines: ['lawn'],
    },
  },
  {
    name: 'Thuricide BT Caterpillar Control',
    fill: {
      label_url: 'https://southernag.com/wp-content/uploads/2020/06/THURICIDE-LABEL-.pdf',
      sds_url: 'https://southernag.com/wp-content/uploads/2020/06/Thuricide-BT-SDS-2.pdf',
      target_pests: ['Bagworms', 'Fall webworms', 'Tent caterpillars', 'Cabbage loopers', 'Imported cabbageworms', 'Tomato hornworms'],
      label_source_note: 'Label read 2026-10-29 (THURICIDE BT CATERPILLAR CONTROL, 16 fl oz bottle (garage count), Southern Agricultural Insecticides, Inc., EPA Reg. No. 70051-106-829, label file dated 2023-09-12, https://southernag.com/wp-content/uploads/2020/06/THURICIDE-LABEL-.pdf): No lawn rate per area on the label. Labeled sites are fruits, vegetables, shade trees and ornamentals; turf is not named.',
      service_lines: ['tree_shrub'],
    },
  },
  {
    name: 'Blue Planet Nutrients Liquid Seaweed .3-.2-1',
    fill: {
      label_url: 'https://d2j6dbq0eux0bg.cloudfront.net/images/610128/products/15764135/5785265699.jpg',
      label_source_note: 'Label read 2026-10-29 (Blue Planet Nutrients Liquid Seaweed, back panel of the 32 FL OZ quart from the maker\'s store photo, not EPA-registered, no date printed; the older front label prints .3-.2-1, https://d2j6dbq0eux0bg.cloudfront.net/images/610128/products/15764135/5785265699.jpg): No lawn rate per area on the label. Per gallon of water only: "Mix ½–2 tsp (2–10 ml) per gallon of water" (root feed) and "Mix ½ tsp (≈2 ml) per gallon of water." (foliar).',
      service_lines: ['lawn'],
    },
  },
  {
    name: 'Southern Ag Surfactant for Herbicides (Non-Ionic)',
    fill: {
      label_url: 'https://www.domyown.com/msds/Non-Ionic_Surfactant_for_Herbicides_Label_2021.pdf',
      sds_url: 'https://southernag.com/wp-content/uploads/2020/06/Surfactant-for-Herbicides_2020-update.pdf',
      label_source_note: 'Label read 2026-10-29 (SURFACTANT FOR HERBICIDES Wetting Agent / Spreader / Penetrant, 1 Gallon (3.785 liters), Southern Agricultural Insecticides, Inc., spray adjuvant with no EPA number, label code 6000SGPF1-0220, https://www.domyown.com/msds/Non-Ionic_Surfactant_for_Herbicides_Label_2021.pdf): No lawn rate per area on the label. Spray mix only: 1 to 2 pts per 100 gals of mix.',
      service_lines: ['lawn'],
    },
  },
  {
    name: 'Quali-Pro Imidacloprid 2F T&O',
    fill: {
      label_url: 'https://www.agrian.com/pdfs/Quali-Pro_IMIDACLOPRID_2F_Label.pdf',
      sds_url: 'https://www.agrian.com/pdfs/Quali-Pro_IMIDACLOPRID_2F_MSDS.pdf',
      default_rate_per_1000: 0.46,
      min_label_rate_per_1000: 0.46,
      max_label_rate_per_1000: 0.6,
      rate_unit: 'fl_oz',
      target_pests: ['White grubs', 'Mole crickets', 'Billbugs', 'Chinch bugs (suppression)', 'Black turfgrass ataenius', 'Cutworms (suppression)'],
      label_source_note: 'Label read 2026-10-29 (Quali-Pro Imidacloprid 2F Turf & Ornamental Insecticide, 1 GALLON, Control Solutions, EPA Reg. No. 53883-514 (old number 66222-203), label booklet EPA 120313/Rev A, https://www.agrian.com/pdfs/Quali-Pro_IMIDACLOPRID_2F_Label.pdf): Turf table. Grubs, billbugs: "1.25 to 1.6 pt/A" or "0.46 to 0.6 fl. oz." per 1000 sq. ft. Chinch bugs (suppression), mole crickets: "1.6 pt" per acre or "0.6 fl. oz." per 1000 sq. ft. Annual limit: "Do not apply more than 1.6 pt" (0.4 lb active ingredient) per acre.',
      service_lines: ['lawn'],
    },
  },
];

// { name, column, from, to }: written only while the column holds exactly `from`.
const IMIDACLOPRID = 'Quali-Pro Imidacloprid 2F T&O';
const CORRECTIONS = [
  { name: IMIDACLOPRID, column: 'epa_reg_number', from: '66222-203', to: '53883-514' },
  {
    name: IMIDACLOPRID,
    column: 'label_url',
    from: 'https://www3.epa.gov/pesticides/chem_search/ppls/066222-00203-20131203.pdf',
    to: 'https://www.agrian.com/pdfs/Quali-Pro_IMIDACLOPRID_2F_Label.pdf',
  },
  { name: IMIDACLOPRID, column: 'active_ingredient', from: 'Imidacloprid 21.4% (2 lb/gal)', to: 'Imidacloprid 21.8% (2 lb/gal)' },
  {
    name: 'LESCO Spar-TECH Micro Mix',
    column: 'active_ingredient',
    from: 'Micronutrient mix (analysis pending label read)',
    to: '2.5%Mg 0.05%Cu 1%Fe 1.3%Mn 0.05%Zn',
  },
  {
    name: 'LESCO Spar-TECH 13-0-0',
    column: 'active_ingredient',
    from: '13-0-0 with 6% Fe, 1% Mn (per SiteOne listing)',
    to: '13-0-0 6%Fe 1%Mn',
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

async function existing(knex, columns) {
  const have = [];
  for (const column of columns) {
    if (await knex.schema.hasColumn('products_catalog', column)) have.push(column);
    else console.log(`${LOG} products_catalog.${column} does not exist: field skipped`);
  }
  return have;
}

async function correct(knex, canAudit, { name, column, from, to }) {
  if (!(await existing(knex, [column])).length) return;
  const rows = await knex('products_catalog').where({ name }).select('id', 'name', column);
  for (const row of rows) {
    if (row[column] !== from) {
      console.log(`${LOG} ${name}: ${column} is not the old value: left as it is`);
      continue;
    }
    const updated = await knex('products_catalog').where({ id: row.id, [column]: from })
      .update({ [column]: to, updated_at: knex.fn.now() });
    if (updated) await audit(knex, canAudit, row, column, from, to);
  }
}

async function fill(knex, canAudit, item) {
  const values = { ...item.fill, ...VERIFIED };
  const columns = await existing(knex, Object.keys(values));
  const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', ...columns);
  if (!rows.length) console.log(`${LOG} ${item.name}: no catalog row: nothing to do`);
  for (const row of rows) {
    for (const column of columns) {
      if (row[column] != null) continue; // already set: left as it is
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull(column)
        .update({ [column]: dbValue(column, values[column]), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, column, null, values[column]);
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const change of CORRECTIONS) await correct(knex, canAudit, change);
  for (const item of ITEMS) await fill(knex, canAudit, item);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.ITEMS = ITEMS;
exports.CORRECTIONS = CORRECTIONS;
