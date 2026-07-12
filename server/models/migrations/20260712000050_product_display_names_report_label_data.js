// Completion-card inventory polish, three data concerns in one pass:
//
// 1. display_name — new nullable column. The completion card and its search
//    results render display_name when present; `name` stays the canonical
//    identity (protocol references, LOWER(name) migration matching, and the
//    service_products compliance record keep the full name). Short names are
//    seeded for the catalog rows whose names run past ~60 characters.
//
// 2. Residential "until dry" re-entry data for the general-use liquid
//    concentrates Adam actually applies. Their labels carry the standard
//    "do not allow people or pets on treated surfaces until dry" statement,
//    which this codebase stores as rei_hours = 0 (the until-dry sentinel —
//    see formatReiForPrompt in report-copy-context.js) plus a
//    reentry_summary. Only NULL fields are filled. Taurus SC also gets its
//    EPA registration number (53883-279, Control Solutions Inc.), which the
//    report gate requires for pesticides.
//
// 3. approved_for_service_report = true for the products in Adam's actual
//    rotation whose rows now carry label data — this is what lets
//    loadProductSafety feed active-ingredient / re-entry / rainfast facts
//    into the customer-facing report grounding. Rows outside his rotation
//    stay unapproved.
//
// down() reverses only values this migration wrote.

const DISPLAY_NAMES = [
  ['LESCO 8-2-12 100% Poly Plus OPTI Kieserite 4% Mg 9.26% S 0.15% B 0.05% Cu 0.15% Fe 2% Mn 0.15% Zn Palm & Tropical Ornamental Granular Fertilizer', 'LESCO 8-2-12 Palm & Tropical'],
  ['LESCO 8-0-10 50% PolyPlus OPTI45 Spar-TECH 1% Fe 1% Mg 1% Mn 0.1% B KMAG Palm & Tropical Ornamental Granular Fertilizer', 'LESCO 8-0-10 Palm & Tropical (KMAG)'],
  ['LESCO High Manganese Combo Chelated Micronutrients AM 1% Mg 5.75% S 3% Fe 4% Mn Micronutrient Liquid Soil Amendment', 'LESCO High Mn Combo (soil amendment)'],
  ['LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer', 'LESCO High Mn Combo (fertilizer)'],
  ['LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag', 'LESCO 24-0-10 Turf Fertilizer'],
  ['LESCO 16-4-8 50% PolyPlus OPTI 0.05%Cu 1%Fe 0.4%Mn 0.15%Zn MOP Turfgrass Granular', 'LESCO 16-4-8 Turf Fertilizer'],
  ['LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer', 'LESCO 0-0-18 Bio KMAG'],
  ['LESCO Chelated Iron Plus 12-0-0 2% Mn 6% Fe 4% S All Purpose Liquid Fertilizer', 'LESCO Chelated Iron Plus 12-0-0 (4% S)'],
  ['LESCO 24-0-11 75% PolyPlus OPTI 3% Fe 1% Mn AS Turfgrass Granular Fertilizer', 'LESCO 24-0-11 Turf Fertilizer'],
  ['LESCO Chelated Iron Plus 12-0-0 6% Fe 2% Mn All Purpose Liquid Fertilizer', 'LESCO Chelated Iron Plus 12-0-0'],
  ['LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide', 'LESCO T-Storm Fungicide'],
  ['LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer', 'LESCO Elite 0-0-28'],
  ['Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide', 'Sedgehammer Plus'],
  ['Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide', 'Sedgehammer 75%'],
  ['Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide', 'Arena 0.25G Granular'],
  ['LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', 'LESCO Stonewall 4FL'],
  ['Fusilade II Fluazifop-P-Butyl 24.5% Post Emergent Liquid Herbicide', 'Fusilade II'],
  ['LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient', 'LESCO Chelated AM + Micros'],
  ['LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment', 'LESCO CarbonPro-L'],
];

const UNTIL_DRY_SUMMARY = 'Do not allow people or pets to enter the treated area until sprays have dried.';

// General-use residential liquids whose labels carry the standard until-dry
// re-entry statement.
const UNTIL_DRY_PRODUCTS = [
  'Bifen I/T', 'Bifen XTS', 'Talstar P', 'Taurus SC', 'Suspend SC',
  'Suspend Polyzone', 'Temprid FX', 'Cyzmic CS', 'Onslaught Fastcap',
  'Permethrin SFR', 'Gentrol IGR', 'Tekko Pro IGR', 'Alpine WSG',
  'Demand CS Insecticide',
];

// Adam's rotation: rows that, with the data above, pass the report gate
// (pesticides need EPA + label data; adjuvants/fertilizers just approval).
const APPROVE_FOR_REPORT = [
  'Bifen I/T', 'Bifen XTS', 'Talstar P', 'Taurus SC', 'Celsius WG',
  'Gentrol IGR', 'Tekko Pro IGR', 'Alpine WSG', 'Arena 50 WDG',
  'Advion Cockroach Gel Bait',
  'LESCO 90/10 Nonionic Surfactant', 'LESCO K-Flow 0-0-25',
  'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient',
  'LESCO Chelated Iron Plus',
  'LESCO High Manganese Combo Chelated Micronutrients AM 1% Mg 5.75% S 3% Fe 4% Mn Micronutrient Liquid Soil Amendment',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  if (!(await knex.schema.hasColumn('products_catalog', 'display_name'))) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.string('display_name', 80).nullable();
    });
  }

  for (const [name, displayName] of DISPLAY_NAMES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereNull('display_name')
      .update({ display_name: displayName, updated_at: new Date() });
  }

  for (const name of UNTIL_DRY_PRODUCTS) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereNull('reentry_summary')
      .update({ reentry_summary: UNTIL_DRY_SUMMARY, updated_at: new Date() });
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereNull('rei_hours')
      .update({ rei_hours: 0, updated_at: new Date() });
  }

  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', ['Taurus SC'])
    .where((q) => q.whereNull('epa_reg_number').orWhere('epa_reg_number', 'N/A'))
    .update({ epa_reg_number: '53883-279', updated_at: new Date() });

  for (const name of APPROVE_FOR_REPORT) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where((q) => q.whereNull('approved_for_service_report').orWhere('approved_for_service_report', false))
      .update({ approved_for_service_report: true, updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  // approved_for_service_report is intentionally NOT reverted: up() only
  // wrote rows that were false/null, but a boolean can't be value-matched
  // back to "what up() wrote" — unapproving here would also strip approvals
  // that predate this migration (seeds/admin edits) and silently remove
  // report grounding this migration never granted.

  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', ['Taurus SC'])
    .where('epa_reg_number', '53883-279')
    .update({ epa_reg_number: null, updated_at: new Date() });

  for (const name of UNTIL_DRY_PRODUCTS) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where('reentry_summary', UNTIL_DRY_SUMMARY)
      .update({ reentry_summary: null, updated_at: new Date() });
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where('rei_hours', 0)
      .update({ rei_hours: null, updated_at: new Date() });
  }

  for (const [name, displayName] of DISPLAY_NAMES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where('display_name', displayName)
      .update({ display_name: null, updated_at: new Date() });
  }

  if (await knex.schema.hasColumn('products_catalog', 'display_name')) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.dropColumn('display_name');
    });
  }
};
