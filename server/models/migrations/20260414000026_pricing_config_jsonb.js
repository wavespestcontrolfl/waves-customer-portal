// ============================================================
// Migration: Restructure pricing_config to JSONB schema
// The original migration (000011) created a flat decimal schema.
// The admin Pricing Logic page needs JSONB data + name + sort_order.
// This migration drops the old table and recreates with the correct schema.
// ============================================================
exports.up = async function(knex) {
  // Drop old decimal-schema table if it exists
  if (await knex.schema.hasTable('pricing_config')) {
    // Check if it has the old schema (config_value column)
    const cols = await knex.raw(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pricing_config' AND column_name = 'config_value'
    `);
    if (cols.rows.length > 0) {
      // Old schema — drop and recreate
      await knex.schema.dropTable('pricing_config');
    } else {
      // Already has new schema, just ensure seed data exists
      const count = await knex('pricing_config').count('* as c').first();
      if (count && parseInt(count.c) > 10) return; // Already seeded
    }
  }

  // Drop old audit table too (had decimal old_value/new_value)
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const cols = await knex.raw(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pricing_config_audit' AND column_name = 'old_value'
    `);
    if (cols.rows.length > 0 && cols.rows[0].data_type === 'numeric') {
      await knex.schema.dropTable('pricing_config_audit');
    }
  }

  // Create JSONB pricing_config table
  if (!(await knex.schema.hasTable('pricing_config'))) {
    await knex.schema.createTable('pricing_config', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('config_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.jsonb('data').notNullable();
      t.text('description');
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
    });
  }

  // Create audit table with text columns
  if (!(await knex.schema.hasTable('pricing_config_audit'))) {
    await knex.schema.createTable('pricing_config_audit', t => {
      t.increments('id').primary();
      t.string('config_key', 100).notNullable();
      t.text('old_value');
      t.text('new_value');
      t.string('changed_by', 100);
      t.timestamp('changed_at').defaultTo(knex.fn.now());
      t.text('reason');
    });
  }

  // Seed all pricing config data
  const configs = [
    // ── Global Constants ──
    { config_key: 'global_labor_rate', name: 'Loaded Labor Rate', category: 'global', sort_order: 1, data: JSON.stringify({ value: 35, unit: '$/hr', description: 'Wages + benefits + WC + vehicle + insurance' }) },
    { config_key: 'global_drive_time', name: 'Average Drive Time', category: 'global', sort_order: 2, data: JSON.stringify({ value: 20, unit: 'min', description: 'Average drive time per visit (Zone A)' }) },
    { config_key: 'global_admin_annual', name: 'Admin Cost Allocation', category: 'global', sort_order: 3, data: JSON.stringify({ value: 51, unit: '$/service/yr', description: 'Annual admin overhead per service line' }) },
    { config_key: 'global_margin_floor', name: 'Margin Floor', category: 'global', sort_order: 4, data: JSON.stringify({ value: 0.35, unit: 'ratio', description: 'Minimum acceptable contribution margin' }) },
    { config_key: 'global_margin_target_ts', name: 'T&S Margin Target', category: 'global', sort_order: 5, data: JSON.stringify({ value: 0.43, unit: 'ratio', description: 'Tree & Shrub margin target' }) },
    { config_key: 'global_conditional_ceiling', name: 'Conditional Material Ceiling', category: 'global', sort_order: 6, data: JSON.stringify({ value: 60, unit: '$/property/yr', description: 'Max conditional material spend before reprice flag' }) },
    { config_key: 'global_processing', name: 'Processing Cost Absorption', category: 'global', sort_order: 7, data: JSON.stringify({ value: 0.03, unit: 'ratio', description: '3% processing cost baked into all customer-facing prices' }) },

    // ── Zones ──
    { config_key: 'zone_multipliers', name: 'Service Zone Multipliers', category: 'zone', sort_order: 1, data: JSON.stringify({ A: { name: 'Manatee/Sarasota core', multiplier: 1.00 }, B: { name: 'Extended service area', multiplier: 1.05 }, C: { name: 'Charlotte outskirts', multiplier: 1.10 }, UNKNOWN: { name: 'Default', multiplier: 1.05 } }) },

    // ── Pest Control ──
    { config_key: 'pest_base', name: 'Pest Control Base Price', category: 'pest', sort_order: 1, data: JSON.stringify({ base: 117, floor: 89 }) },
    { config_key: 'pest_footprint', name: 'Pest Footprint Modifiers', category: 'pest', sort_order: 2, data: JSON.stringify({ breakpoints: [{ sqft: 800, adj: -20 }, { sqft: 1200, adj: -12 }, { sqft: 1500, adj: -6 }, { sqft: 2000, adj: 0 }, { sqft: 2500, adj: 6 }, { sqft: 3000, adj: 12 }, { sqft: 4000, adj: 20 }, { sqft: 5500, adj: 28 }] }) },
    { config_key: 'pest_features', name: 'Pest Feature Modifiers', category: 'pest', sort_order: 3, data: JSON.stringify({ pool_cage: 10, pool_no_cage: 5, shrubs_heavy: 10, shrubs_moderate: 5, shrubs_light: -5, trees_heavy: 10, trees_moderate: 5, trees_light: -5, landscape_complex: 5, near_water: 2.5, large_driveway: 2.5, indoor: 10 }) },
    { config_key: 'pest_property_type', name: 'Pest Property Type Adjustments', category: 'pest', sort_order: 4, data: JSON.stringify({ single_family: 0, townhome_end: -8, townhome_interior: -15, duplex: -10, condo_ground: -20, condo_upper: -25 }) },
    { config_key: 'pest_frequency', name: 'Pest Frequency Discounts', category: 'pest', sort_order: 5, data: JSON.stringify({ quarterly: 1.00, bimonthly: 0.92, monthly: 0.85, v2_bimonthly: 0.85, v2_monthly: 0.70 }) },
    { config_key: 'pest_roach', name: 'Pest Roach Add-On Modifiers', category: 'pest', sort_order: 6, data: JSON.stringify({ german: 0.25, regular: 0.10, none: 0 }) },
    { config_key: 'pest_membership', name: 'WaveGuard Membership Fee', category: 'pest', sort_order: 7, data: JSON.stringify({ fee: 99, waived_with_prepay: true }) },

    // ── Tree & Shrub ──
    { config_key: 'ts_material_rates', name: 'T&S Material Rates per SqFt', category: 'tree_shrub', sort_order: 1, data: JSON.stringify({ '6x_standard': 0.110, '9x_enhanced': 0.190, '12x_premium': 0.220 }) },
    { config_key: 'ts_monthly_floors', name: 'T&S Monthly Floor Prices', category: 'tree_shrub', sort_order: 2, data: JSON.stringify({ standard: 50, enhanced: 65, premium: 80 }) },
    { config_key: 'ts_access_time', name: 'T&S Access Time Adjustments', category: 'tree_shrub', sort_order: 3, data: JSON.stringify({ easy: 0, moderate: 8, difficult: 15, unit: 'min/visit' }) },
    { config_key: 'ts_frequencies', name: 'T&S Visit Frequencies', category: 'tree_shrub', sort_order: 4, data: JSON.stringify({ standard: 6, enhanced: 9, premium: 12, unit: 'visits/yr' }) },

    // ── Palm Injection ──
    { config_key: 'palm_pricing', name: 'Palm Injection Per-Palm Pricing', category: 'palm', sort_order: 1, data: JSON.stringify({ nutrition: 35, preventive_insecticide: 45, combo: 55, fungal: 40, lethal_bronzing_floor: 125, tree_age_floor: 65 }) },
    { config_key: 'palm_rules', name: 'Palm WaveGuard Rules', category: 'palm', sort_order: 2, data: JSON.stringify({ tier_qualifier: false, flat_credit_per_palm: 10, flat_credit_min_tier: 'gold', min_per_visit: 75, apps_per_year: 2 }) },

    // ── Mosquito ──
    { config_key: 'mosquito_base_prices', name: 'Mosquito Monthly by Lot Size & Tier', category: 'mosquito', sort_order: 1, data: JSON.stringify({ SMALL: { bronze: 80, silver: 90, gold: 100, platinum: 110 }, QUARTER: { bronze: 90, silver: 100, gold: 115, platinum: 125 }, THIRD: { bronze: 100, silver: 110, gold: 125, platinum: 135 }, HALF: { bronze: 110, silver: 125, gold: 145, platinum: 155 }, ACRE: { bronze: 140, silver: 155, gold: 180, platinum: 200 } }) },
    { config_key: 'mosquito_lot_sizes', name: 'Mosquito Lot Size Categories', category: 'mosquito', sort_order: 2, data: JSON.stringify({ SMALL: { max_sqft: 10889, label: '< 1/4 acre' }, QUARTER: { max_sqft: 14519, label: '1/4 acre' }, THIRD: { max_sqft: 21779, label: '1/3 acre' }, HALF: { max_sqft: 43559, label: '1/2 acre' }, ACRE: { label: '1+ acre' } }) },
    { config_key: 'mosquito_visits', name: 'Mosquito Visits per Tier', category: 'mosquito', sort_order: 3, data: JSON.stringify({ bronze: 12, silver: 12, gold: 15, platinum: 17 }) },
    { config_key: 'mosquito_pressure', name: 'Mosquito Pressure Factors', category: 'mosquito', sort_order: 4, data: JSON.stringify({ trees_heavy: 0.15, trees_moderate: 0.05, complexity_complex: 0.10, complexity_moderate: 0.05, pool: 0.05, near_water: 0.10, irrigation: 0.08, lot_acre: 0.15, lot_half: 0.05, cap: 2.00 }) },

    // ── Termite ──
    { config_key: 'termite_install', name: 'Termite Installation Costs', category: 'termite', sort_order: 1, data: JSON.stringify({ install_multiplier: 1.75, station_spacing_ft: 10, min_stations: 8, advance_station_cost: 14, trelona_station_cost: 24, labor_material_per_station: 5.25, misc_per_station: 0.75 }) },
    { config_key: 'termite_monitoring', name: 'Termite Monitoring Monthly', category: 'termite', sort_order: 2, data: JSON.stringify({ basic: 35, premier: 65 }) },
    { config_key: 'termite_perimeter', name: 'Termite Perimeter Multipliers', category: 'termite', sort_order: 3, data: JSON.stringify({ standard: 1.25, complex: 1.35 }) },

    // ── Rodent ──
    { config_key: 'rodent_monthly', name: 'Rodent Bait Monthly Tiers', category: 'rodent', sort_order: 1, data: JSON.stringify({ small: { monthly: 75, max_score: 1 }, medium: { monthly: 89, max_score: 2 }, large: { monthly: 109 } }) },
    { config_key: 'rodent_trapping', name: 'Rodent Trapping Base', category: 'rodent', sort_order: 2, data: JSON.stringify({ base: 350, floor: 350 }) },
    { config_key: 'rodent_score_factors', name: 'Rodent Score Factors', category: 'rodent', sort_order: 3, data: JSON.stringify({ footprint_2500plus: 2, footprint_1800plus: 1, lot_20000plus: 2, lot_12000plus: 1, near_water: 1, trees_heavy: 1 }) },
    { config_key: 'rodent_rules', name: 'Rodent WaveGuard Rules', category: 'rodent', sort_order: 4, data: JSON.stringify({ tier_qualifier: false, exclude_from_pct_discount: true, setup_credit: 50 }) },

    // ── One-Time Services ──
    { config_key: 'onetime_pest', name: 'One-Time Pest Pricing', category: 'one_time', sort_order: 1, data: JSON.stringify({ markup_multiplier: 1.30, floor: 150 }) },
    { config_key: 'onetime_lawn', name: 'One-Time Lawn Pricing', category: 'one_time', sort_order: 2, data: JSON.stringify({ markup_multiplier: 1.30, floor: 85, fungicide_floor: 95, treatment_multipliers: { fertilization: 1.00, weed: 1.12, pest: 1.30, fungicide: 1.38 } }) },
    { config_key: 'onetime_mosquito', name: 'One-Time Mosquito Pricing', category: 'one_time', sort_order: 3, data: JSON.stringify({ SMALL: 200, QUARTER: 250, THIRD: 275, HALF: 300, ACRE: 350 }) },
    { config_key: 'onetime_urgency', name: 'Urgency Multipliers', category: 'one_time', sort_order: 4, data: JSON.stringify({ routine: 1.0, soon: 1.25, soon_after_hours: 1.50, urgent: 1.50, urgent_after_hours: 2.0 }) },
    { config_key: 'onetime_recurring_discount', name: 'Recurring Customer Discount', category: 'one_time', sort_order: 5, data: JSON.stringify({ multiplier: 0.85 }) },
    { config_key: 'onetime_trenching', name: 'Trenching Rates', category: 'one_time', sort_order: 6, data: JSON.stringify({ per_lf_dirt: 10, per_lf_concrete: 14, floor: 600, renewal: 325 }) },
    { config_key: 'onetime_boracare', name: 'Bora-Care Constants', category: 'one_time', sort_order: 7, data: JSON.stringify({ gal_cost: 91.98, coverage_sqft: 275, equip_cost: 17.50 }) },
    { config_key: 'onetime_preslab', name: 'Pre-Slab Termidor', category: 'one_time', sort_order: 8, data: JSON.stringify({ bottle_cost: 174.72, coverage_sqft: 1250, equip_cost: 15 }) },
    { config_key: 'onetime_exclusion', name: 'Exclusion Point Pricing', category: 'one_time', sort_order: 9, data: JSON.stringify({ simple: 37.50, moderate: 75, advanced: 150, inspection_fee: 85 }) },
    { config_key: 'onetime_german_roach', name: 'German Roach Treatment', category: 'one_time', sort_order: 10, data: JSON.stringify({ base: 450, floor: 400, setup_charge: 100 }) },
    { config_key: 'onetime_bed_bug', name: 'Bed Bug Treatment', category: 'one_time', sort_order: 11, data: JSON.stringify({ chemical: { material_per_room: 50.42, floor_base: 400, floor_per_extra_room: 250 }, heat: { per_room_1: 1000, per_room_2: 850, per_room_3: 750 } }) },
    { config_key: 'onetime_flea', name: 'Flea Treatment', category: 'one_time', sort_order: 12, data: JSON.stringify({ initial_base: 225, initial_floor: 185, followup_base: 125, followup_floor: 95 }) },
    { config_key: 'onetime_wdo', name: 'WDO Inspection', category: 'one_time', sort_order: 13, data: JSON.stringify({ brackets: [{ max_sqft: 2500, price: 175 }, { max_sqft: 3500, price: 200 }, { max_sqft: 999999, price: 225 }] }) },

    // ── WaveGuard ──
    { config_key: 'waveguard_tiers', name: 'WaveGuard Bundle Discounts', category: 'waveguard', sort_order: 1, data: JSON.stringify({ bronze: { min_services: 1, discount: 0 }, silver: { min_services: 2, discount: 0.10 }, gold: { min_services: 3, discount: 0.15 }, platinum: { min_services: 4, discount: 0.20 } }) },
    { config_key: 'waveguard_caps', name: 'WaveGuard Discount Caps', category: 'waveguard', sort_order: 2, data: JSON.stringify({ composite_cap: 0.25, lawn_enhanced_cap: 0.15, lawn_premium_cap: 0.15, recurring_customer_discount: 0.15 }) },
    { config_key: 'waveguard_qualifying', name: 'WaveGuard Qualifying Services', category: 'waveguard', sort_order: 3, data: JSON.stringify({ services: ['lawn_care', 'pest_control', 'tree_shrub', 'mosquito', 'termite_bait'], note: 'Palm injection and rodent bait are NOT qualifiers' }) },
    { config_key: 'waveguard_ach', name: 'ACH Payment Discount', category: 'waveguard', sort_order: 4, data: JSON.stringify({ percentage: 0.03, exempt_from_composite_cap: true }) },
  ];

  for (const c of configs) {
    await knex('pricing_config').insert(c).onConflict('config_key').ignore();
  }
};

exports.down = async function(knex) {
  // Don't drop — the old migration's down handles that
};
