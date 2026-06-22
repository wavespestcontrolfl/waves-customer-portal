const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { costLineFromUsage } = require('../services/product-costing');
const { BED_BUG } = require('../services/pricing-engine/constants');

router.use(adminAuthenticate, requireTechOrAdmin);

const ESTIMATE_COST_FALLBACKS = {
  pest_control: {
    serviceTypes: ['Quarterly Pest Control', 'Pest Control'],
    laborMin: 20,
    materialPerVisit: 6.67,
    visitsPerYear: 4,
    areaField: 'homeSqFt',
  },
  lawn_care: {
    serviceTypes: ['Lawn Care'],
    laborMin: 30,
    materialPerVisit: 25,
    visitsPerYear: 9,
    areaField: 'lawnSqFt',
  },
  tree_shrub: {
    serviceTypes: ['Tree & Shrub'],
    laborMin: 25,
    materialPerVisit: 20,
    visitsPerYear: 9,
    areaField: 'bedArea',
  },
  mosquito: {
    serviceTypes: ['Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'],
    laborMin: 15,
    materialPerVisit: 8,
    visitsPerYear: 12,
    areaField: 'lotSqFt',
  },
  termite_bait: {
    serviceTypes: ['Termite Bait'],
    laborMin: 20,
    materialPerVisit: 10,
    visitsPerYear: 1,
    areaField: 'homeSqFt',
  },
  rodent_bait: {
    serviceTypes: ['Rodent Bait'],
    laborMin: 20,
    materialPerVisit: 10,
    visitsPerYear: 4,
    areaField: 'homeSqFt',
  },
};

async function getInventoryCostEstimate(serviceKey, dimensions) {
  const fallback = ESTIMATE_COST_FALLBACKS[serviceKey] || {
    serviceTypes: [],
    laborMin: 20,
    materialPerVisit: 10,
    visitsPerYear: 6,
    areaField: 'homeSqFt',
  };
  const result = {
    ...fallback,
    materialPerVisit: fallback.materialPerVisit,
    materialCostSource: 'fallback',
    materialCostWarnings: [],
    materialCostLines: [],
  };

  try {
    if (!(await db.schema.hasTable('service_product_usage'))) return result;
    if (!(await db.schema.hasTable('products_catalog'))) return result;

    const rows = await db('service_product_usage')
      .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
      .whereIn('service_product_usage.service_type', fallback.serviceTypes)
      .select(
        'service_product_usage.service_type',
        'service_product_usage.usage_amount',
        'service_product_usage.usage_unit',
        'service_product_usage.usage_per_1000sf',
        'service_product_usage.notes',
        'products_catalog.id as product_id',
        'products_catalog.name as product_name',
        'products_catalog.cost_per_unit',
        'products_catalog.cost_unit',
        'products_catalog.best_price',
        'products_catalog.unit_size_oz',
        'products_catalog.best_vendor',
      );

    if (!rows.length) return result;

    const areaSqFt = Number(dimensions[fallback.areaField] || 0);
    let materialPerVisit = 0;
    const sources = new Set();
    for (const row of rows) {
      const line = costLineFromUsage(row, areaSqFt);
      if (line.warning) result.materialCostWarnings.push(line.warning);
      if (line.source) sources.add(line.source);
      materialPerVisit += line.cost || 0;
      result.materialCostLines.push({
        productId: row.product_id,
        productName: row.product_name,
        serviceType: row.service_type,
        cost: Math.round((line.cost || 0) * 100) / 100,
        source: line.source || 'missing',
      });
    }

    if (materialPerVisit > 0) {
      result.materialPerVisit = Math.round(materialPerVisit * 100) / 100;
      result.materialCostSource = sources.has('cost_per_unit')
        ? 'inventory_cost_per_unit'
        : 'inventory_best_price_unit_size';
    }
  } catch (err) {
    result.materialCostWarnings.push(`Inventory COGS unavailable: ${err.message}`);
  }

  return result;
}

function parseConfigData(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function normalizePricingConfigRow(row) {
  const data = parseConfigData(row.data);
  return { ...row, data };
}

function normalizeIncomingConfigData(configKey, data) {
  return data;
}

async function ensureTable() {
  if (!(await db.schema.hasTable('pricing_config'))) {
    await db.schema.createTable('pricing_config', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('config_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.jsonb('data').notNullable();
      t.text('description');
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
    });
    const configs = [
      { config_key: 'pest_base', name: 'Pest Control Base Price', category: 'pest', sort_order: 1, data: JSON.stringify({ base: 117, floor: 89 }) },
      { config_key: 'pest_footprint', name: 'Pest Footprint Modifiers', category: 'pest', sort_order: 2, data: JSON.stringify({ breakpoints: [{sqft:800,adj:-15},{sqft:1200,adj:-10},{sqft:1500,adj:-5},{sqft:1750,adj:-5},{sqft:2000,adj:0},{sqft:2500,adj:3},{sqft:3000,adj:6},{sqft:4000,adj:10},{sqft:5500,adj:16}] }) },
      { config_key: 'pest_features', name: 'Pest Feature Modifiers', category: 'pest', sort_order: 3, data: JSON.stringify({ indoor:15,pool_cage:8,pool_cage_small:5,pool_cage_medium:8,pool_cage_large:12,pool_cage_oversized:18,pool_no_cage:0,shrubs_heavy:6,shrubs_moderate:0,shrubs_light:-5,trees_heavy:6,trees_moderate:0,trees_light:-5,landscape_simple:-5,landscape_moderate:0,landscape_complex:3,near_water:3,large_driveway:3 }) },
      { config_key: 'pest_property_type', name: 'Pest Property Type', category: 'pest', sort_order: 4, data: JSON.stringify({ single_family:0,townhome_end:-8,townhome_interior:-12,duplex:-10,condo_ground:-18,condo_upper:-22 }) },
      { config_key: 'pest_service_costs', name: 'Pest Service Cost Breakdown', category: 'pest', sort_order: 5, data: JSON.stringify({ chemicals:{ taurus_sc:{ bottle_price:95.00, bottle_oz:78, oz_per_service:4, cost_per_service:4.87 }, talak:{ bottle_price:41.57, bottle_oz:128, oz_per_service:4, cost_per_service:1.30 }, surfactant:{ cost:0.50 }}, labor:{ spray_minutes:10, sweep_minutes:10, total_on_site_minutes:20, rate_per_hour:35, on_site_labor_cost:11.67, drive_minutes:20, drive_labor_cost:11.67 }, direct_service_cost:17.84, fully_allocated_cost:30.01 }), description: 'Per-service cost breakdown including drive time' },
      { config_key: 'waveguard_tiers', name: 'WaveGuard Bundle Discounts', category: 'waveguard', sort_order: 10, data: JSON.stringify({ bronze:{min_services:1,discount:0},silver:{min_services:2,discount:0.10},gold:{min_services:3,discount:0.15},platinum:{min_services:4,discount:0.20} }) },
      { config_key: 'waveguard_membership', name: 'WaveGuard Membership Fee', category: 'waveguard', sort_order: 11, data: JSON.stringify({ fee:99, waived_with_prepay:true }) },
      { config_key: 'lawn_st_augustine', name: 'St. Augustine', category: 'lawn', sort_order: 20, data: JSON.stringify([[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]]) },

      // Global constants
      { config_key: 'global_labor_rate', name: 'Loaded Labor Rate', category: 'global', sort_order: 1, data: JSON.stringify({ value: 35, unit: '$/hr', description: 'Wages + benefits + WC + vehicle + insurance' }) },
      { config_key: 'global_drive_time', name: 'Average Drive Time', category: 'global', sort_order: 2, data: JSON.stringify({ value: 20, unit: 'min', description: 'Average drive time per visit' }) },
      { config_key: 'global_admin_annual', name: 'Admin Cost Allocation', category: 'global', sort_order: 3, data: JSON.stringify({ value: 51, unit: '$/service/yr', description: 'Annual admin overhead per service line' }) },
      { config_key: 'global_margin_floor', name: 'Margin Floor', category: 'global', sort_order: 4, data: JSON.stringify({ value: 0.35, unit: 'ratio', description: 'Minimum acceptable contribution margin' }) },
      { config_key: 'global_margin_target_ts', name: 'T&S Margin Target', category: 'global', sort_order: 5, data: JSON.stringify({ value: 0.45, unit: 'ratio', semantics: 'margin_admin_inclusive', description: 'Tree & Shrub target margin, admin-inclusive: price = (direct cost + admin) / (1 - target). The semantics field is required — db-bridge ignores rows without it (guards against stale pre-v4.6 ratio rows).' }) },
      { config_key: 'global_conditional_ceiling', name: 'Conditional Material Ceiling', category: 'global', sort_order: 6, data: JSON.stringify({ value: 60, unit: '$/property/yr', description: 'Max conditional material spend before reprice flag' }) },

      // Tree & Shrub
      { config_key: 'ts_material_rates', name: 'T&S Material Model (annual)', category: 'tree_shrub', sort_order: 1, data: JSON.stringify({ fixed: 15, per_tree: 4, per_sqft: 0.055, light_factor: 0.75, note: 'v4.6 protocol-derived annual material model: fixed foliar/micros load + 8-2-12 per tree/palm + Snapshot/13-0-13/spray per bed sqft. Light 4x runs light_factor of the spend. 6-visit Standard is the mandated default; Light 4x is a downsell. Enhanced 9x / Premium 12x retired.' }) },
      { config_key: 'ts_monthly_floors', name: 'T&S Monthly Floor Prices', category: 'tree_shrub', sort_order: 2, data: JSON.stringify({ light: 22, standard: 35, note: 'Backstops, not expected prices — the v4.6 formula prices nearly all real properties above these. Keep light <= 2/3 of standard so a floored Light never exceeds Standard per month.' }) },

      // Palm
      { config_key: 'palm_pricing', name: 'Palm Injection Protocol Pricing', category: 'palm', sort_order: 1, data: JSON.stringify({ nutrition: 35, insecticide_small: 45, insecticide_medium: 55, insecticide_large: 75, combo_small: 65, combo_medium: 75, combo_large: 95, fungal_floor: 50, lethal_bronzing_floor: 125, tree_age_floor: 65, min_per_visit: 75, nutrition_default_apps_per_year: 1, nutrition_allowed_apps_per_year: [1, 2], flat_credit_per_palm: 10, flat_credit_min_tier: 'gold', tier_qualifier: false, exclude_from_pct_discount: true }) },

      // Mosquito
      { config_key: 'mosquito_lot_sizes', name: 'Mosquito Treatable Area Categories', category: 'mosquito', sort_order: 1, data: JSON.stringify({ SMALL: { max_sqft: 7999 }, QUARTER: { max_sqft: 11999 }, THIRD: { max_sqft: 17999 }, HALF: { max_sqft: 34999 }, ACRE: { max_sqft: 999999 } }) },
      { config_key: 'mosquito_base_prices', name: 'Mosquito Program Per-Visit Pricing', category: 'mosquito', sort_order: 2, data: JSON.stringify({ SMALL: { seasonal9: 66, monthly12: 60 }, QUARTER: { seasonal9: 69, monthly12: 63 }, THIRD: { seasonal9: 72, monthly12: 66 }, HALF: { seasonal9: 78, monthly12: 70 }, ACRE: { seasonal9: 88, monthly12: 78 } }) },
      { config_key: 'mosquito_visits', name: 'Mosquito Program Visits', category: 'mosquito', sort_order: 3, data: JSON.stringify({ seasonal9: 9, monthly12: 12 }) },
      { config_key: 'mosquito_pressure', name: 'Mosquito Pressure Factors', category: 'mosquito', sort_order: 4, data: JSON.stringify({ trees_heavy: 0.15, trees_moderate: 0.05, complexity_complex: 0.10, complexity_moderate: 0.05, pool: 0.05, near_water: 0.10, irrigation: 0.08, lot_acre: 0.15, lot_half: 0.05, cap: 2.0 }) },

      // Termite
      { config_key: 'termite_install', name: 'Termite Install Multiplier', category: 'termite', sort_order: 1, data: JSON.stringify({ multiplier: 1.45, hexpro_bait: 8.69, advance_bait: 13.16, trelona_bait: 22.05, labor_per_station: 5.25, misc_per_station: 0.75 }) },
      { config_key: 'termite_monitoring', name: 'Termite Monitoring Monthly', category: 'termite', sort_order: 2, data: JSON.stringify({ basic: 35, premier: 65 }) },

      // Rodent — bait stations (recurring monthly)
      { config_key: 'rodent_monthly', name: 'Rodent Bait Monthly Tiers (quarterly visits, billed monthly)', category: 'rodent', sort_order: 1, data: JSON.stringify({ small: 49, medium: 59, large: 69, visits_per_year: 4 }) },
      { config_key: 'rodent_setup_fee', name: 'Rodent Bait Setup Fee', category: 'rodent', sort_order: 2, data: JSON.stringify({ value: 199, waived_with_recurring: true, note: 'Waived in standard recurring sign-up flow' }) },
      { config_key: 'rodent_post_exclusion', name: 'Rodent Bait Post-Exclusion Modifier', category: 'rodent', sort_order: 3, data: JSON.stringify({ multiplier: 0.72, floor_monthly: 39, note: 'Sealed structure = lighter scope' }) },
      { config_key: 'rodent_per_station_overage', name: 'Rodent Per-Station Overage', category: 'rodent', sort_order: 4, data: JSON.stringify({ value: 8, unit: '$/mo per extra station beyond tier default' }) },
      // Rodent — staged remediation (one-time)
      { config_key: 'rodent_inspection', name: 'Rodent Inspection Fee', category: 'rodent', sort_order: 5, data: JSON.stringify({ fee: 125, creditable_within_days: 14, waive_if_approved_total_over: 995 }) },
      { config_key: 'rodent_trapping', name: 'Rodent Trapping (active-window checks included)', category: 'rodent', sort_order: 6, data: JSON.stringify({ base: 395, floor: 350, ceiling_before_custom: 795, included_followups: 'unlimited', active_window_days: 14, additional_followup_rate: 0, emergency_multiplier: 1.20, emergency_minimum_surcharge: 75, home_size_adjustments: [{max_sqft:1200,adjustment:-25},{max_sqft:2500,adjustment:0},{max_sqft:4000,adjustment:50},{max_sqft:6000,adjustment:95},{max_sqft:'Infinity',adjustment:150,custom_recommended:true}], lot_adjustments: [{max_lot_sqft:10000,adjustment:0},{max_lot_sqft:20000,adjustment:35},{max_lot_sqft:43560,adjustment:75},{max_lot_sqft:'Infinity',adjustment:125,custom_recommended:true}], pressure_adjustments: { light:-25, normal:0, moderate:35, heavy:75, severe:150 } }) },
      { config_key: 'rodent_sanitation', name: 'Rodent Sanitation Tiers (bleach + wipe)', category: 'rodent', sort_order: 7, data: JSON.stringify({ light: { base: 395, floor: 395, included_sqft: 300, additional_per_sqft: 0.20, included_debris_cuft: 0, additional_debris_per_cuft: 12 }, standard: { base: 695, floor: 695, included_sqft: 750, additional_per_sqft: 0.30, included_debris_cuft: 10, additional_debris_per_cuft: 12 }, heavy: { base: 995, floor: 995, included_sqft: 750, additional_per_sqft: 0.55, included_debris_cuft: 25, additional_debris_per_cuft: 12, crawlspace_multiplier: 1.15, tight_access_multiplier: 1.25 } }) },
      { config_key: 'rodent_bundles', name: 'Rodent Bundle Discounts', category: 'rodent', sort_order: 8, data: JSON.stringify({ trap_exclusion: { discount: 0.07, floor: 895 }, trap_sanitation: { discount: 0.05, floor: 895 }, full_remediation: { discount: 0.10, floors: { light: 1195, standard: 1495, heavy: 1995 } } }) },
      { config_key: 'rodent_guarantee', name: 'Rodent Annual Guarantee Tiers', category: 'rodent', sort_order: 9, data: JSON.stringify({ standard: 199, complex: 249, estate: 299, eligibility_requires: ['trappingCompleted','exclusionCompleted','sanitationCompletedOrPhotoBaseline','noActivityAfterFinalTrapCheck'] }) },
      { config_key: 'rodent_waveguard', name: 'Rodent WaveGuard Rules', category: 'rodent', sort_order: 10, data: JSON.stringify({ tier_qualifier: false, exclude_from_pct_discount: true, setup_credit: 0, note: 'Rodent bait is fully excluded from WaveGuard credits, coupons, setup credits, discounts, and tier benefits.' }) },

      // One-time
      { config_key: 'onetime_urgency', name: 'Urgency Multipliers', category: 'one_time', sort_order: 1, data: JSON.stringify({ routine: 1.0, soon: 1.25, soon_after_hours: 1.50, urgent: 1.50, urgent_after_hours: 2.0 }) },
      { config_key: 'onetime_recurring_discount', name: 'Recurring Customer Discount', category: 'one_time', sort_order: 2, data: JSON.stringify({ discount: 0.15, note: '15% off one-time services for recurring customers' }) },
      { config_key: 'onetime_pest', name: 'One-Time Pest Pricing', category: 'one_time', sort_order: 3, data: JSON.stringify({ floor: 199, multiplier: 2.2 }) },
      { config_key: 'onetime_lawn', name: 'One-Time Lawn Treatment', category: 'one_time', sort_order: 4, data: JSON.stringify({ floor: 115, fungicide_floor: 115, recurringPerAppMultiplier: 1.50, treatment_multipliers: { fert: 1.00, fertilization: 1.00, weed: 1.12, pest: 1.30, fungicide: 1.38 } }) },
      { config_key: 'onetime_mosquito', name: 'One-Time Mosquito Treatment', category: 'one_time', sort_order: 5, data: JSON.stringify({ SMALL: 99, STANDARD: 129, LARGE: 159, XL: 199, ESTATE: 239, ACRE_CLASS: 269, OVER_ACRE: 269, overAcreIncrementSqFt: 10000, overAcreIncrementPrice: 40, stationAddOn: 75, dunkAddOn: 15 }) },
      { config_key: 'onetime_trenching', name: 'Trenching Rates', category: 'one_time', sort_order: 6, data: JSON.stringify({
        per_lf_dirt: 10,
        per_lf_concrete: 14,
        floor: 600,
        renewal: 325,
        default_product_key: 'taurus_sc',
        default_included_product_key: 'taurus_sc',
        default_application_rate: 'standard',
        default_trench_depth_ft: 1.0,
        finished_gallons_per_10_lf_per_ft_depth: 4,
        default_concrete_volume_pad_pct: 0.20,
        product_premium_multiplier: 1.45,
        products: {
          termidor_sc: { container_cost: 375.00, container_oz: 78, product_oz_per_finished_gallon_at_standard_rate: 0.8, product_oz_per_finished_gallon_at_high_rate: 1.6 },
          taurus_sc: { container_cost: 85.00, container_oz: 78, product_oz_per_finished_gallon_at_standard_rate: 0.8, product_oz_per_finished_gallon_at_high_rate: 1.6 },
          bifen_it: { container_cost: 55.00, container_oz: 96, product_oz_per_finished_gallon_at_standard_rate: 1.0, product_oz_per_finished_gallon_at_high_rate: 2.0 },
          talstar_p: { container_cost: 65.00, container_oz: 96, product_oz_per_finished_gallon_at_standard_rate: 1.0, product_oz_per_finished_gallon_at_high_rate: 2.0 },
        },
      }) },
      { config_key: 'onetime_boracare', name: 'Bora-Care Constants', category: 'one_time', sort_order: 7, data: JSON.stringify({ bc_gal: 91.98, bc_cov: 275, bc_equip: 17.50 }) },
      { config_key: 'onetime_preslab', name: 'Pre-Slab Termiticide Treatment', category: 'one_time', sort_order: 8, data: JSON.stringify({
        default_product_key: 'termidor_sc',
        ps_equip: 15,
        warranty_extended: 200,
        volume_discounts: { none: 1.00, '5plus': 0.90, '10plus': 0.85 },
        // Contextual price floors by job context + slab size — the floors the
        // pricing engine actually applies (lookupPreSlabMinimum). Stored as flat
        // top-level array keys (not a nested object) so the admin panel's inline
        // table editor persists edits. Terminal tier uses 'Infinity'.
        minimums_standalone: [
          { maxSqFt: 250, floor: 225 },
          { maxSqFt: 750, floor: 325 },
          { maxSqFt: 1250, floor: 425 },
          { maxSqFt: 'Infinity', floor: 600 },
        ],
        minimums_builderBatch: [
          { maxSqFt: 250, floor: 150 },
          { maxSqFt: 750, floor: 250 },
          { maxSqFt: 1250, floor: 350 },
          { maxSqFt: 'Infinity', floor: 500 },
        ],
        minimums_sameTripAddOn: [
          { maxSqFt: 250, floor: 125 },
          { maxSqFt: 750, floor: 225 },
          { maxSqFt: 1250, floor: 325 },
          { maxSqFt: 'Infinity', floor: 500 },
        ],
        products: {
          termidor_sc: { container_cost: 174.72, container_oz: 78, product_oz_per_10_sqft: 0.8, margin_divisor: 0.45 },
          taurus_sc: { container_cost: 95.00, container_oz: 78, product_oz_per_10_sqft: 0.8, margin_divisor: 0.45 },
          bifen_it: { container_cost: 41.53, container_oz: 128, product_oz_per_10_sqft: 1.0, margin_divisor: 0.45 },
          talstar_p: { container_cost: 38.99, container_oz: 128, product_oz_per_10_sqft: 1.0, margin_divisor: 0.45 },
        },
      }) },
      { config_key: 'onetime_exclusion', name: 'Exclusion Point Pricing + Access Multipliers', category: 'one_time', sort_order: 9, data: JSON.stringify({ simple: 50, moderate: 95, advanced: 195, specialty_minimum: 275, inspection: 125, inspection_waived_with_service_optin: true, minimums_by_home_sqft: [{max_sqft:1500,minimum:395},{max_sqft:2500,minimum:595},{max_sqft:4000,minimum:895},{max_sqft:'Infinity',minimum:1295,custom_recommended:true}], story_multipliers: { one: 1.00, two: 1.15, three: 1.30 }, roof_multipliers: { shingle: 1.00, flat: 1.00, metal: 1.15, tile: 1.25, steep_or_fragile: 1.35 }, construction_multipliers: { block: 1.00, stucco: 1.05, frame: 1.10, mixed: 1.10 } }) },
      { config_key: 'onetime_flea', name: 'Flea Treatment', category: 'one_time', sort_order: 10, data: JSON.stringify({ initial: { base: 225, floor: 185 }, followUp: { base: 125, floor: 95 }, exterior: { enabled: true, maxSqFt: 20000, tiers: [{ min: 1, max: 2500, initial: 75, followUp: 50 }, { min: 2501, max: 5000, initial: 95, followUp: 60 }, { min: 5001, max: 7500, initial: 120, followUp: 75 }, { min: 7501, max: 10000, initial: 145, followUp: 95 }, { min: 10001, max: 15000, initial: 195, followUp: 130 }, { min: 15001, max: 20000, initial: 240, followUp: 155 }] } }) },
      { config_key: 'onetime_bed_bug', name: 'Bed Bug Specialty Pricing', category: 'one_time', sort_order: 11, data: JSON.stringify(BED_BUG), description: 'Complete bed bug specialty pricing protocol: chemical/IPM, heat, hybrid, risk modifiers, and heat protocol fields.' },

      // WaveGuard discount caps & ACH
      { config_key: 'waveguard_discount_caps', name: 'Service Discount Caps', category: 'waveguard', sort_order: 12, data: JSON.stringify({ lawn_care_enhanced: 0.15, lawn_care_premium: 0.15, rodent_bait: 0, palm_injection: 0, bed_bug_chemical: 0, bed_bug_heat: 0, bora_care: 0, pre_slab_termiticide: 0, pre_slab_termidor: 0, composite_cap: 0.25 }) },
      { config_key: 'ach_discount', name: 'ACH Payment Discount (retired)', category: 'waveguard', sort_order: 13, data: JSON.stringify({ percentage: 0, exempt_from_composite_cap: true, payment_method: 'us_bank_account', note: 'Retired — card surcharge now applied at checkout' }) },
    ];
    for (const c of configs) { await db('pricing_config').insert(c).onConflict('config_key').ignore(); }
  }
}

// GET / — all pricing configs
router.get('/', async (req, res, next) => {
  try {
    await ensureTable();
    const { category } = req.query;
    let query = db('pricing_config').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const configs = await query;
    res.json({ configs: configs.map(normalizePricingConfigRow) });
  } catch (err) { next(err); }
});

// --- Specific routes MUST come before /:key wildcard ---

// GET /lawn-brackets — all lawn_pricing_brackets grouped by grass_track
router.get('/lawn-brackets', async (req, res, next) => {
  try {
    const rows = await db('lawn_pricing_brackets').orderBy('grass_track').orderBy('sqft_bracket');
    const tracks = {};
    for (const r of rows) {
      if (!tracks[r.grass_track]) tracks[r.grass_track] = [];
      tracks[r.grass_track].push(r);
    }
    res.json({ tracks });
  } catch (err) {
    // Table may not exist yet
    res.json({ tracks: {} });
  }
});

// PUT /lawn-brackets/:track — update brackets for a track
router.put('/lawn-brackets/:track', async (req, res, next) => {
  try {
    const { brackets } = req.body; // array of { sqft_bracket, tier, monthly_price }
    for (const b of brackets) {
      await db('lawn_pricing_brackets')
        .where({ grass_track: req.params.track, sqft_bracket: b.sqft_bracket, tier: b.tier })
        .update({ monthly_price: b.monthly_price, updated_at: new Date() });
    }
    try {
      const modular = require('../services/pricing-engine');
      if (modular.syncConstantsFromDB) await modular.syncConstantsFromDB();
    } catch { /* non-fatal */ }
    // Invalidate v1 db-bridge cache so admin edits flow to the lookup path
    // immediately. Prevents up-to-60s stale-quote windows on Virginia's hot path.
    try {
      const bridge = require('../services/pricing-engine/db-bridge');
      if (bridge.invalidatePricingConfigCache) bridge.invalidatePricingConfigCache();
    } catch { /* non-fatal */ }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /discount-rules — all service_discount_rules
router.get('/discount-rules', async (req, res, next) => {
  try {
    const rules = await db('service_discount_rules').orderBy('service_key');
    res.json({ rules });
  } catch (err) {
    res.json({ rules: [] });
  }
});

// PUT /discount-rules/:serviceKey — update a service discount rule
router.put('/discount-rules/:serviceKey', async (req, res, next) => {
  try {
    const updates = {};
    const allowed = ['tier_qualifier', 'max_discount_pct', 'flat_credit', 'flat_credit_min_tier', 'exclude_from_pct_discount', 'notes'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    updates.updated_at = new Date();
    await db('service_discount_rules').where({ service_key: req.params.serviceKey }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /audit-log — recent pricing config audit entries
router.get('/audit-log', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await db('pricing_config_audit').orderBy('changed_at', 'desc').limit(limit);
    res.json({ logs });
  } catch (err) {
    res.json({ logs: [] });
  }
});

// GET /changelog — pricing_changelog entries (v4.3 Session 1)
router.get('/changelog', async (req, res, next) => {
  try {
    const { category } = req.query;
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    let query = db('pricing_changelog').orderBy('changed_at', 'desc').limit(limit);
    if (category && category !== 'all') query = query.where({ category });
    const rows = await query;
    res.json({ entries: rows });
  } catch (err) {
    logger.error('[admin-pricing-config] changelog fetch failed', err);
    res.status(500).json({ error: 'Failed to load changelog', entries: [] });
  }
});

// GET /pest-calibration — compare shadow production minutes against completed job timers
router.get('/pest-calibration', async (req, res, next) => {
  try {
    const hasTable = await db.schema.hasTable('pest_production_calibration_records');
    if (!hasTable) {
      if (String(req.query.format || '').toLowerCase() === 'csv') {
        const { calibrationRowsToCsv } = require('../services/pest-production-calibration');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="pest-production-calibration-unavailable.csv"');
        return res.send(calibrationRowsToCsv([]));
      }
      return res.json({
        records: [],
        summary: { count: 0, avgDelta: 0, avgAbsDelta: 0, outlierCount: 0, byPoolCageSize: [], byLotBand: [], byConfidence: [], outliers: [] },
        sync: { synced: 0, skipped: 0, unavailable: true },
        sampleHealth: { jobsEvaluated: 0, materializedCount: 0, linkedEstimateCount: 0, fallbackMatchedCount: 0, missingEstimateLinkCount: 0, missingTimerCount: 0, missingDiagnosticsCount: 0, skippedCount: 0 },
      });
    }

    const {
      syncCalibrationRecords,
      listCalibrationRecords,
      summarizeCalibrationRecords,
      calibrationRowsToCsv,
    } = require('../services/pest-production-calibration');

    const requestedLimit = parseInt(req.query.limit, 10);
    const exportCsv = String(req.query.format || '').toLowerCase() === 'csv';
    const options = {
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null,
      limit: Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, exportCsv ? 10000 : 500)
        : (exportCsv ? 10000 : 100),
    };
    const sync = req.query.sync === 'false' ? { synced: 0, skipped: 0 } : await syncCalibrationRecords({ ...options, limit: 2000 });
    const records = await listCalibrationRecords({
      ...options,
      maxLimit: exportCsv ? 10000 : 500,
    });
    if (exportCsv) {
      const start = options.startDate || 'all';
      const end = options.endDate || 'all';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="pest-production-calibration-${start}-to-${end}.csv"`);
      return res.send(calibrationRowsToCsv(records));
    }
    const summaryRecords = await listCalibrationRecords({
      startDate: options.startDate,
      endDate: options.endDate,
      limit: 10000,
      maxLimit: 10000,
    });
    res.json({ records, summary: summarizeCalibrationRecords(summaryRecords), sync, sampleHealth: sync.sampleHealth || null });
  } catch (err) { next(err); }
});

// POST /margin-check — calculate margins for a sample property across all services
router.post('/margin-check', async (req, res) => {
  try {
    const { lotSqFt = 10000, homeSqFt = 2000, lawnSqFt = 5000, bedArea = 1500, waveguardTier = 'gold' } = req.body;
    const dimensions = { lotSqFt, homeSqFt, lawnSqFt, bedArea };

    // Try to use the pricing engine
    let pricingEngine;
    try { pricingEngine = require('../services/pricing-engine'); } catch { /* not available */ }

    if (!pricingEngine?.generateEstimate) {
      return res.json({ error: 'Pricing engine not available', services: [] });
    }

    const GLOBAL = pricingEngine.constants?.GLOBAL || { LABOR_RATE: 35, DRIVE_TIME: 20 };
    const laborRate = GLOBAL.LABOR_RATE || 35;
    const driveMin = GLOBAL.DRIVE_TIME || 20;
    const driveCost = laborRate * driveMin / 60;

    // Build service request to get all recurring services priced
    const estimate = pricingEngine.generateEstimate({
      homeSqFt, lotSqFt, lawnSqFt, bedArea,
      stories: 1,
      propertyType: 'single_family',
      features: {},
      zone: 'A',
      paymentMethod: 'card',
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
        treeShrub: { tier: 'enhanced' },
        mosquito: { tier: 'monthly' },
      },
    });

    const services = [];
    for (const item of estimate.lineItems) {
      if (!item.annual) continue;
      const ce = await getInventoryCostEstimate(item.service, dimensions);
      const laborPerVisit = laborRate * ce.laborMin / 60;
      const costPerVisit = laborPerVisit + ce.materialPerVisit + driveCost;
      const annualCost = costPerVisit * (item.visits || item.visitsPerYear || ce.visitsPerYear);
      const afterDiscount = item.annualAfterDiscount || item.annual;
      const margin = afterDiscount > 0 ? (afterDiscount - annualCost) / afterDiscount : 0;

      services.push({
        service: item.service,
        annual: item.annual,
        estimatedCost: Math.round(annualCost),
        costPerVisit: Math.round(costPerVisit * 100) / 100,
        materialPerVisit: ce.materialPerVisit,
        materialCostSource: ce.materialCostSource,
        materialCostWarnings: ce.materialCostWarnings,
        materialCostLines: ce.materialCostLines,
        afterDiscount: Math.round(afterDiscount),
        discount: item.discount?.effectiveDiscount || 0,
        margin: Math.round(margin * 1000) / 1000,
      });
    }

    res.json({ services, property: estimate.property, waveGuard: estimate.waveGuard });
  } catch (err) {
    res.json({ error: err.message, services: [] });
  }
});

// --- Wildcard routes below ---

// GET /:key — single config by key
router.get('/:key', async (req, res, next) => {
  try {
    const config = await db('pricing_config').where({ config_key: req.params.key }).first();
    if (!config) return res.status(404).json({ error: 'Config not found' });
    res.json(normalizePricingConfigRow(config));
  } catch (err) { next(err); }
});

// PUT /:key — update config data (with audit logging)
router.put('/:key', async (req, res, next) => {
  try {
    const { data, name, description, reason } = req.body;

    // Get old value for audit
    const oldConfig = await db('pricing_config').where({ config_key: req.params.key }).first();
    if (!oldConfig) return res.status(404).json({ error: 'Config not found' });

    const updates = { updated_at: new Date() };
    const normalizedData = data !== undefined ? normalizeIncomingConfigData(req.params.key, data) : undefined;
    if (normalizedData !== undefined) updates.data = JSON.stringify(normalizedData);
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    await db('pricing_config').where({ config_key: req.params.key }).update(updates);

    try {
      const modular = require('../services/pricing-engine');
      if (modular.syncConstantsFromDB) await modular.syncConstantsFromDB();
    } catch { /* non-fatal */ }
    // Invalidate v1 db-bridge cache so admin edits flow to the lookup path
    // immediately. Prevents up-to-60s stale-quote windows on Virginia's hot path.
    try {
      const bridge = require('../services/pricing-engine/db-bridge');
      if (bridge.invalidatePricingConfigCache) bridge.invalidatePricingConfigCache();
    } catch { /* non-fatal */ }

    // Audit log
    if (normalizedData !== undefined) {
      try {
        await db('pricing_config_audit').insert({
          config_key: req.params.key,
          old_value: JSON.stringify(oldConfig.data),
          new_value: JSON.stringify(normalizedData),
          changed_by: req.admin?.name || 'admin',
          reason: reason || null
        });
      } catch { /* audit table may not exist */ }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /estimate — run the pricing engine with live DB-synced constants
// This is the single entry point estimators should use. Body schema matches
// the modular engine's generateEstimate input.
router.post('/estimate', async (req, res, next) => {
  try {
    const pricingEngine = require('../services/pricing-engine');
    if (!pricingEngine?.generateEstimate) {
      return res.status(500).json({ error: 'Pricing engine not available' });
    }
    // Sync DB-edited constants into the engine before calculating
    try {
      if (pricingEngine.needsSync && pricingEngine.needsSync()) {
        await pricingEngine.syncConstantsFromDB();
      }
    } catch { /* non-fatal — fall back to in-memory constants */ }

    const estimate = pricingEngine.generateEstimate(req.body || {});
    res.json({ estimate });
  } catch (err) { next(err); }
});

// POST /quick-quote — compact version for lightweight surfaces (tech portal, AI agents)
router.post('/quick-quote', async (req, res, next) => {
  try {
    const pricingEngine = require('../services/pricing-engine');
    if (!pricingEngine?.quickQuote) {
      return res.status(500).json({ error: 'Pricing engine not available' });
    }
    try {
      if (pricingEngine.needsSync && pricingEngine.needsSync()) {
        await pricingEngine.syncConstantsFromDB();
      }
    } catch { /* non-fatal */ }
    res.json({ quote: pricingEngine.quickQuote(req.body || {}) });
  } catch (err) { next(err); }
});

module.exports = router;
