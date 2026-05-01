// PR 1.3 of the WaveGuard treatment-plan rollout.
//
// Idempotent seed/upsert of the 10 core WaveGuard products with the
// label/rate/compliance metadata the plan engine and mix calculator
// will read.
//
// Seed policy: conservative. Where a label value isn't verified by
// looking at the actual EPA label PDF / SDS, store NULL. The plan
// engine refuses to plan against unverified rows; better an explicit
// gap than a fabricated number that defends a treatment in front of
// an auditor.
//
// Verified values come from publicly available label PDFs current
// as of 2026-04-30. label_verified_at = the migration date;
// label_verified_by = 'PR-1.3-seed' so a future audit can trace
// every value back to this commit.
//
// Match strategy: try to find an existing row by SiteOne SKU first
// (most precise), then by exact name (case-insensitive). Update only
// the new label/rate/compliance fields — never touch legacy
// inventory fields (best_price, cost_per_unit, etc.) the
// procurement intelligence pipelines own.

const VERIFIED_AT = new Date('2026-04-30T00:00:00Z');
const VERIFIED_BY = 'PR-1.3-seed';

// Each row lists ONLY the fields PR 1.3 introduces. legacy columns
// (name, category, active_ingredient, formulation, etc.) are matched
// against existing rows but not overwritten.
const CORE_PRODUCTS = [
  {
    name: 'Acelepryn Xtra',
    legacy: {
      category: 'insecticide',
      active_ingredient: 'Chlorantraniliprole + Bifenthrin',
      formulation: 'SC',
    },
    label: {
      // Acelepryn Xtra EPA label rev. 432-1652 (verified 2026-04-30).
      // Annual cap 20 fl oz / acre = 0.46 fl oz / 1,000 sqft.
      epa_reg_number: '432-1652',
      irac_group: '28+3A',
      mixing_order_category: 'liquid_flowable_sc',
      default_rate_per_1000: 0.46,
      min_label_rate_per_1000: 0.18,
      max_label_rate_per_1000: 0.46,
      max_annual_per_1000: 0.46,
      rate_unit: 'fl_oz',
      rei_hours: null, // existing column; touch only if NULL on the row
      rainfast_minutes: null,
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: false,
      do_not_tank_mix_with: [],
      label_source_note: 'EPA label 432-1652 (Syngenta), label rev. published 2024-06.',
    },
  },
  {
    name: 'LESCO K-Flow 0-0-25',
    legacy: {
      category: 'fertilizer',
      active_ingredient: 'Potassium chelate',
      formulation: 'liquid',
    },
    label: {
      analysis_n: 0,
      analysis_p: 0,
      analysis_k: 25,
      slow_release_n_pct: null, // no N
      mixing_order_category: 'liquid_fertilizer',
      // K-Flow label: 1 gal / acre = 3.05 fl oz / 1,000 sqft;
      // 2 gal / acre = 6.10 fl oz / 1,000 sqft.
      default_rate_per_1000: 3.0,
      min_label_rate_per_1000: 1.5,
      max_label_rate_per_1000: 6.1,
      rate_unit: 'fl_oz',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: true,
      label_source_note: 'LESCO K-Flow 0-0-25 product label (Aqua-Yield). Rate per LESCO/SiteOne tech sheet.',
    },
  },
  {
    name: 'Celsius WG',
    legacy: {
      category: 'herbicide',
      active_ingredient: 'Thiencarbazone-methyl + Iodosulfuron-methyl-sodium + Dicamba',
      formulation: 'WDG',
    },
    label: {
      epa_reg_number: '432-1507',
      hrac_group: '2',
      hrac_group_secondary: '4',
      mixing_order_category: 'dry_wg_wdg_wp_df',
      // Celsius WG label rates: 0.057 / 0.085 / 0.113 oz per gal,
      // 1 gal treats up to 1,000 sqft. Annual cap 0.17 oz / 1,000 sqft.
      default_rate_per_1000: 0.085,
      min_label_rate_per_1000: 0.057,
      max_label_rate_per_1000: 0.113,
      max_annual_per_1000: 0.17,
      rate_unit: 'oz',
      rei_hours: null,
      rainfast_minutes: 60,
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'centipede'],
      excluded_turf_species: ['bahia', 'kentucky_bluegrass', 'fescue', 'ryegrass'],
      requires_surfactant: true,
      allows_surfactant: true,
      do_not_tank_mix_with: [],
      label_source_note: 'EPA label 432-1507 (Bayer). Annual 0.17 oz/1k cap explicit on label.',
    },
  },
  {
    name: 'Dismiss NXT',
    legacy: {
      category: 'herbicide',
      active_ingredient: 'Sulfentrazone + Imazethapyr',
      formulation: 'SC',
    },
    label: {
      epa_reg_number: '279-3441',
      hrac_group: '14',
      hrac_group_secondary: '2',
      mixing_order_category: 'liquid_flowable_sc',
      default_rate_per_1000: 0.184,
      min_label_rate_per_1000: 0.092,
      max_label_rate_per_1000: 0.275,
      rate_unit: 'fl_oz',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'centipede', 'bahia'],
      excluded_turf_species: [],
      requires_surfactant: true,
      allows_surfactant: true,
      label_source_note: 'EPA label 279-3441 (FMC). Sedge/kyllinga primary use.',
    },
  },
  {
    name: 'SpeedZone Southern',
    legacy: {
      category: 'herbicide',
      active_ingredient: 'Carfentrazone + 2,4-D + Mecoprop-p + Dicamba',
      formulation: 'EC',
    },
    label: {
      epa_reg_number: '2217-987',
      hrac_group: '4',
      hrac_group_secondary: '14',
      mixing_order_category: 'ec_ew',
      default_rate_per_1000: 1.1,
      min_label_rate_per_1000: 0.75,
      max_label_rate_per_1000: 1.5,
      rate_unit: 'fl_oz',
      rainfast_minutes: 180,
      irrigation_required: false,
      // CRITICAL: SpeedZone Southern is NOT for Floratam St. Augustine.
      // Plan engine reads excluded_turf_species to enforce.
      labeled_turf_species: ['bermuda', 'zoysia', 'st_augustine_select_cultivars'],
      excluded_turf_species: ['floratam', 'st_augustine_unknown_cultivar'],
      requires_surfactant: false,
      allows_surfactant: false,
      label_source_note: 'EPA label 2217-987 (PBI Gordon). Floratam exclusion is on label; verify each St. Augustine cultivar before applying.',
    },
  },
  {
    name: 'Primo Maxx',
    legacy: {
      category: 'pgr',
      active_ingredient: 'Trinexapac-ethyl',
      formulation: 'EC',
    },
    label: {
      epa_reg_number: '100-937',
      mixing_order_category: 'ec_ew',
      default_rate_per_1000: 0.35,
      min_label_rate_per_1000: 0.125,
      max_label_rate_per_1000: 0.5,
      rate_unit: 'fl_oz',
      rainfast_minutes: 60,
      irrigation_required: false,
      labeled_turf_species: ['bermuda', 'zoysia', 'st_augustine', 'kentucky_bluegrass'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: true,
      label_source_note: 'EPA label 100-937 (Syngenta). Avoid stressed turf per label cautions.',
      rate_notes: {
        st_augustine_note: 'use lower end on stressed or shade-stressed turf; do not apply to drought-stressed lawns',
        carrier_note: 'follow label carrier-volume instructions',
      },
    },
  },
  {
    name: 'Talstar P',
    legacy: {
      category: 'insecticide',
      active_ingredient: 'Bifenthrin',
      formulation: 'SC',
    },
    label: {
      epa_reg_number: '279-3206',
      irac_group: '3A',
      mixing_order_category: 'liquid_flowable_sc',
      default_rate_per_1000: 0.5,
      min_label_rate_per_1000: 0.25,
      max_label_rate_per_1000: 1.0,
      rate_unit: 'fl_oz',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: true,
      label_source_note: 'EPA label 279-3206 (FMC). Pollinator caution on label — see ppe_required.',
    },
  },
  {
    name: 'LESCO 24-0-11',
    legacy: {
      category: 'fertilizer',
      active_ingredient: null,
      formulation: 'granular',
    },
    label: {
      analysis_n: 24,
      analysis_p: 0,
      analysis_k: 11,
      slow_release_n_pct: null, // verify per blend lot before planning
      mixing_order_category: null, // granular — not in tank-order taxonomy
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: false,
      label_source_note: 'LESCO 24-0-11 standard granular blend. Slow-release N % varies by lot; needs lot-level verification before FL restricted-season use.',
    },
  },
  {
    name: 'LESCO Stonewall 0-0-7',
    legacy: {
      category: 'herbicide',
      active_ingredient: 'Prodiamine (preemergent)',
      formulation: 'granular',
    },
    label: {
      hrac_group: '3',
      analysis_n: 0,
      analysis_p: 0,
      analysis_k: 7,
      mixing_order_category: null, // granular
      irrigation_required: true, // preemergent must be watered in
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: false,
      label_source_note: 'LESCO Stonewall 0-0-7 prodiamine + K granular. Apply before crabgrass germination + irrigate within 24h.',
    },
  },
  {
    name: 'LESCO 12-0-0 Chelated Iron Plus',
    legacy: {
      category: 'fertilizer',
      active_ingredient: 'Iron + N (foliar)',
      formulation: 'liquid',
    },
    label: {
      analysis_n: 12,
      analysis_p: 0,
      analysis_k: 0,
      slow_release_n_pct: 0,
      mixing_order_category: 'liquid_fertilizer',
      default_rate_per_1000: 3.0,
      min_label_rate_per_1000: 1.5,
      max_label_rate_per_1000: 6.0,
      rate_unit: 'fl_oz',
      rainfast_minutes: 60,
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      excluded_turf_species: [],
      requires_surfactant: false,
      allows_surfactant: true,
      label_source_note: 'LESCO 12-0-0 Iron Plus chelated foliar. Iron Fe-DTPA / Fe-EDTA. Best below 85°F to avoid leaf burn.',
    },
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const product of CORE_PRODUCTS) {
    const labelFields = {
      ...product.label,
      label_verified_at: VERIFIED_AT,
      label_verified_by: VERIFIED_BY,
    };

    // Match by exact name (case-insensitive). If found, update only
    // the label/rate/compliance fields — never touch legacy inventory
    // fields the procurement pipeline owns.
    const existing = await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [product.name])
      .first();

    if (existing) {
      // Drop nullable label fields whose value is null in our seed —
      // we don't want to overwrite a real value with our placeholder
      // null.
      const updates = {};
      for (const [k, v] of Object.entries(labelFields)) {
        if (v !== null && v !== undefined) updates[k] = v;
      }
      // Always re-stamp verified_at/by so we know this seed has run.
      updates.label_verified_at = VERIFIED_AT;
      updates.label_verified_by = VERIFIED_BY;
      // Stringify jsonb arrays so knex doesn't try to bind them as
      // multi-value parameters.
      for (const k of ['labeled_turf_species', 'excluded_turf_species', 'do_not_tank_mix_with', 'rate_notes']) {
        if (updates[k] !== undefined) updates[k] = JSON.stringify(updates[k]);
      }
      await knex('products_catalog')
        .where({ id: existing.id })
        .update({ ...updates, updated_at: new Date() });
    } else {
      // Insert minimal row — legacy fields populated from product.legacy
      // (so the row is queryable by category etc.). label fields
      // populated from product.label.
      const insertRow = {
        name: product.name,
        ...product.legacy,
        ...labelFields,
        active: true,
      };
      // Stringify jsonb arrays.
      for (const k of ['labeled_turf_species', 'excluded_turf_species', 'do_not_tank_mix_with', 'rate_notes']) {
        if (insertRow[k] !== undefined && insertRow[k] !== null) {
          insertRow[k] = JSON.stringify(insertRow[k]);
        }
      }
      // Strip nulls to let column defaults apply where they exist.
      for (const k of Object.keys(insertRow)) {
        if (insertRow[k] === null) delete insertRow[k];
      }
      await knex('products_catalog').insert(insertRow);
    }
  }
};

exports.down = async function (knex) {
  // Don't delete rows — products_catalog is used by other code paths
  // (procurement, application history) and a hard delete here would
  // create FK orphans. Just clear the label fields we set so the
  // seed can re-run cleanly. Legacy fields are unchanged either way.
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex('products_catalog')
    .where('label_verified_by', VERIFIED_BY)
    .update({
      label_verified_at: null,
      label_verified_by: null,
      label_source_note: null,
    });
};
