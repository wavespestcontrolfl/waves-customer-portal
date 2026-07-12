// Catalog dedupe + lawn/T&S irrigation resource (owner ask 2026-07-12:
// "keep only one of the duplicate rows" + label data is a customer-report
// resource "especially for lawn and tree and shrub in regards to irrigation").
//
// Dedupe rules (verified against prod read-only before writing):
// - Losers are DEACTIVATED (active = false), never deleted — 24 tables hold
//   FKs into products_catalog and history must keep resolving.
// - Keeper choice: a row referenced by lawn_protocol_products /
//   protocol_template_products always wins (no live-config repointing);
//   otherwise the row with usage/label data wins.
// - The two service_product_usage rows that reference a loser are repointed
//   to the keeper (single-row config seeds, keeper had no row → no
//   uniqueness collision).
// - keeperUpdates carry over the loser's label facts explicitly (values
//   read from prod, not merged dynamically) and only land when the keeper
//   field is currently NULL / 'N/A' / false, so admin edits are preserved.
//
// Rotation fills: irrigation_required + approved_for_service_report for the
// products that are in the active rotation (used in service_products or
// referenced by protocols). irrigation values are the label-standard
// watering-in facts; ambiguous/method-dependent products are left NULL.
//
// down() restores duplicates/repoints and value-matched scalar fields, but
// intentionally leaves the two booleans standing (see the note in down()).

const CLUSTERS = [
  { keeper: 'Demand CS', losers: ['Demand CS Insecticide'] },
  {
    keeper: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer',
    losers: ['LESCO High Manganese Combo Chelated Micronutrients AM 1% Mg 5.75% S 3% Fe 4% Mn Micronutrient Liquid Soil Amendment'],
    // The 000050 approval landed on the soil-amendment duplicate; carry it to
    // the keeper so High Mn label facts keep flowing (no-op where the keeper
    // is already approved, as in prod).
    keeperUpdates: { display_name: 'LESCO High Mn Combo', approved_for_service_report: true },
  },
  {
    // Protocols reference the long row (10 lawn_protocol_products rows).
    keeper: 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer',
    losers: ['LESCO K-Flow 0-0-25'],
    keeperUpdates: {
      default_rate_per_1000: 3.0,
      rate_unit: 'fl_oz',
      irrigation_required: false,
      display_name: 'LESCO K-Flow 0-0-25',
      approved_for_service_report: true,
    },
  },
  {
    keeper: 'LESCO Green Flo 6-0-0 10% Ca',
    losers: ['LESCO Green Flo 6-0-0 10% Ca Turfgrass Liquid Fertilizer'],
    keeperUpdates: { approved_for_service_report: true },
  },
  {
    // Protocols reference the bare row (10 lawn_protocol_products rows).
    keeper: 'LESCO Chelated Iron Plus',
    losers: [
      'LESCO 12-0-0 Chelated Iron Plus',
      'LESCO Chelated Iron Plus 12-0-0 2% Mn 6% Fe 4% S All Purpose Liquid Fertilizer',
      'LESCO Chelated Iron Plus 12-0-0 6%Fe 2%Mn',
      'LESCO Chelated Iron Plus 12-0-0 6% Fe 2% Mn All Purpose Liquid Fertilizer',
    ],
    keeperUpdates: {
      default_rate_per_1000: 3.0,
      rate_unit: 'fl_oz',
      max_label_rate_per_1000: 6.0,
      irrigation_required: false,
      approved_for_service_report: true,
    },
  },
  {
    // Protocols reference the long row (12 lawn_protocol_products rows).
    keeper: 'Primo Maxx Plant Growth Regulator for Turf',
    losers: ['Primo Maxx'],
    keeperUpdates: {
      default_rate_per_1000: 0.35,
      rate_unit: 'fl_oz',
      max_label_rate_per_1000: 0.5,
      epa_reg_number: '100-937',
      irrigation_required: false,
      display_name: 'Primo Maxx',
      approved_for_service_report: true,
    },
  },
  {
    keeper: 'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment',
    losers: ['LESCO CarbonPro-L w/ MobilE'],
    keeperUpdates: { irrigation_required: true, approved_for_service_report: true },
  },
  {
    // Protocols reference this row (9 lawn_protocol_products rows).
    keeper: 'LESCO 24-0-11 with PolyPlus OPTI',
    losers: ['LESCO 24-0-11', 'LESCO 24-0-11 75% PolyPlus OPTI 3% Fe 1% Mn AS Turfgrass Granular Fertilizer'],
    keeperUpdates: {
      irrigation_required: true,
      display_name: 'LESCO 24-0-11',
      approved_for_service_report: true,
    },
  },
  {
    keeper: 'Trelona ATBS Bait Station',
    losers: ['Trelona ATBS Annual Bait Station'],
    repointUsage: true,
  },
  {
    keeper: 'Advion Cockroach Gel Bait',
    losers: ['Advion Cockroach Gel'],
    repointUsage: true,
  },
  { keeper: 'Heritage TL', losers: ['Heritage TL Fungicide'] },
  {
    keeper: 'Fusilade II Post Emergent Liquid Herbicide',
    losers: ['Fusilade II Fluazifop-P-Butyl 24.5% Post Emergent Liquid Herbicide'],
  },
  { keeper: 'Tenacity Herbicide', losers: ['Tenacity Post Emergent Liquid Herbicide'] },
  { keeper: 'Certainty Turf Herbicide', losers: ['Certainty Turf Post Emergent Dry Herbicide'] },
  {
    keeper: 'Drive XLR8 Post Emergent Liquid Herbicide',
    losers: ['Drive XLR8 Herbicide Crabgrass Killer'],
  },
  {
    keeper: 'Hydretain Liquid',
    losers: ['Hydretain Liquid Humectant'],
    keeperUpdates: { approved_for_service_report: true },
  },
  { keeper: 'LESCO Stonewall 0-0-7', losers: ['LESCO Stonewall 0.43% 0-0-7'] },
  {
    // Same EPA registration (2217-1031) on both rows — one product.
    keeper: 'SpeedZone Southern',
    losers: ['SpeedZone Southern EW'],
  },
];

// 20260712000050 filled the until-dry statement for the "Demand CS
// Insecticide" duplicate but not the canonical "Demand CS" row this
// migration keeps (it already carries the rei_hours = 0 sentinel; only the
// explicit summary sentence was missing). Codex review catch on #2651.
const UNTIL_DRY_SUMMARY = 'Do not allow people or pets to enter the treated area until sprays have dried.';
const UNTIL_DRY_FIX = ['Demand CS'];

// Label-standard watering-in facts for rotation products (NULL fields only).
const IRRIGATION_TRUE = [
  'Dylox 420 SL T&O Insecticide',
  'Arena 50 WDG',
  'Topchoice Granular Insecticide',
  'LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
];
const IRRIGATION_FALSE = [
  'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
  'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
];

// Lawn/T&S rotation rows approved to feed report grounding (pesticides in
// this list all carry a real EPA number in prod; fertilizers don't need one).
const APPROVE_FOR_REPORT = [
  'Dismiss NXT',
  'Prodiamine 65 WDG',
  'SpeedZone Southern',
  'Velista',
  'Headway G',
  'Atrazine 4L',
  'Acelepryn Xtra',
  'LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
  'LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer',
  'LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer',
];

async function byName(knex, name) {
  return knex('products_catalog').whereRaw('LOWER(name) = LOWER(?)', [name]).first('id');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const cluster of CLUSTERS) {
    const keeper = await byName(knex, cluster.keeper);
    if (!keeper) continue;

    if (cluster.keeperUpdates) {
      // Apply each field only when the keeper doesn't already carry a value,
      // so an admin edit made after this migration was written survives.
      // `false` is a real value for irrigation_required ("no watering-in
      // required") — only the approval boolean treats false as fillable.
      const row = await knex('products_catalog').where({ id: keeper.id }).first();
      const updates = {};
      for (const [field, value] of Object.entries(cluster.keeperUpdates)) {
        const current = row[field];
        const empty =
          current == null || current === '' || current === 'N/A' ||
          (field === 'approved_for_service_report' && current === false);
        if (empty) updates[field] = value;
      }
      if (Object.keys(updates).length) {
        await knex('products_catalog')
          .where({ id: keeper.id })
          .update({ ...updates, updated_at: new Date() });
      }
    }

    for (const loserName of cluster.losers) {
      const loser = await byName(knex, loserName);
      if (!loser) continue;
      if (cluster.repointUsage && (await knex.schema.hasTable('service_product_usage'))) {
        await knex('service_product_usage')
          .where({ product_id: loser.id })
          .update({ product_id: keeper.id });
      }
      await knex('products_catalog')
        .where({ id: loser.id, active: true })
        .update({ active: false, updated_at: new Date() });
    }
  }

  for (const name of UNTIL_DRY_FIX) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereNull('reentry_summary')
      .update({ reentry_summary: UNTIL_DRY_SUMMARY, updated_at: new Date() });
  }

  for (const name of IRRIGATION_TRUE) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereNull('irrigation_required')
      .update({ irrigation_required: true, updated_at: new Date() });
  }
  for (const name of IRRIGATION_FALSE) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereNull('irrigation_required')
      .update({ irrigation_required: false, updated_at: new Date() });
  }

  for (const name of APPROVE_FOR_REPORT) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where((q) => q.whereNull('approved_for_service_report').orWhere('approved_for_service_report', false))
      .update({ approved_for_service_report: true, updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  // approved_for_service_report and irrigation_required are intentionally NOT
  // reverted: a boolean can't be value-matched back to "what up() wrote"
  // (a pre-existing seed/admin true is indistinguishable from ours — e.g.
  // 20260530000022 approves CarbonPro-L on some databases), and stripping a
  // pre-existing approval on rollback would remove report grounding this
  // migration never granted. Rollback restores duplicates/repoints and the
  // exact scalar values written below; the booleans are left standing.

  for (const name of UNTIL_DRY_FIX) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .where('reentry_summary', UNTIL_DRY_SUMMARY)
      .update({ reentry_summary: null, updated_at: new Date() });
  }

  for (const cluster of CLUSTERS) {
    const keeper = await byName(knex, cluster.keeper);
    for (const loserName of cluster.losers) {
      const loser = await byName(knex, loserName);
      if (!loser) continue;
      await knex('products_catalog')
        .where({ id: loser.id, active: false })
        .update({ active: true, updated_at: new Date() });
      if (cluster.repointUsage && keeper && (await knex.schema.hasTable('service_product_usage'))) {
        await knex('service_product_usage')
          .where({ product_id: keeper.id })
          .update({ product_id: loser.id });
      }
    }
    if (keeper && cluster.keeperUpdates) {
      const row = await knex('products_catalog').where({ id: keeper.id }).first();
      const reverts = {};
      for (const [field, value] of Object.entries(cluster.keeperUpdates)) {
        // Booleans stay (see note at the top of down()).
        if (field === 'approved_for_service_report' || field === 'irrigation_required') continue;
        // eslint-disable-next-line eqeqeq
        if (row[field] == value) reverts[field] = null;
      }
      if (Object.keys(reverts).length) {
        await knex('products_catalog')
          .where({ id: keeper.id })
          .update({ ...reverts, updated_at: new Date() });
      }
    }
  }
};
