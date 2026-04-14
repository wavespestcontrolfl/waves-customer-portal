exports.up = async function(knex) {
  // Pricing configuration (global constants)
  if (!(await knex.schema.hasTable('pricing_config'))) {
    await knex.schema.createTable('pricing_config', t => {
      t.increments('id').primary();
      t.string('config_key', 100).unique().notNullable();
      t.decimal('config_value', 12, 4).notNullable();
      t.string('unit', 50);
      t.string('category', 50); // group constants by section
      t.text('description');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.string('updated_by', 100);
    });

    // Seed global constants
    await knex('pricing_config').insert([
      { config_key: 'LABOR_RATE', config_value: 35.00, unit: '$/hr', category: 'global', description: 'Loaded labor rate (wages + benefits + WC + vehicle + insurance)' },
      { config_key: 'DRIVE_TIME', config_value: 20, unit: 'min', category: 'global', description: 'Average drive time per visit' },
      { config_key: 'ADMIN_ANNUAL', config_value: 51, unit: '$/service/yr', category: 'global', description: 'Annual admin cost allocation per service line' },
      { config_key: 'MARGIN_FLOOR', config_value: 0.35, unit: 'ratio', category: 'global', description: 'Minimum acceptable contribution margin' },
      { config_key: 'MARGIN_TARGET_TS', config_value: 0.43, unit: 'ratio', category: 'global', description: 'Tree & Shrub margin target (conservative)' },
      { config_key: 'CONDITIONAL_CEILING', config_value: 60, unit: '$/property/yr', category: 'global', description: 'Max conditional material spend before reprice flag' },
      { config_key: 'RECURRING_DISCOUNT', config_value: 0.85, unit: 'multiplier', category: 'global', description: 'Recurring customer discount on one-time services' },
      // Zone multipliers
      { config_key: 'ZONE_A', config_value: 1.00, unit: 'multiplier', category: 'zone', description: 'Manatee/Sarasota core' },
      { config_key: 'ZONE_B', config_value: 1.05, unit: 'multiplier', category: 'zone', description: 'Extended service area' },
      { config_key: 'ZONE_C', config_value: 1.10, unit: 'multiplier', category: 'zone', description: 'Charlotte outskirts' },
      { config_key: 'ZONE_UNKNOWN', config_value: 1.05, unit: 'multiplier', category: 'zone', description: 'Default for unknown zone' },
      // Urgency multipliers
      { config_key: 'URGENCY_SOON', config_value: 1.25, unit: 'multiplier', category: 'urgency', description: 'Soon - standard hours' },
      { config_key: 'URGENCY_SOON_AFTERHOURS', config_value: 1.50, unit: 'multiplier', category: 'urgency', description: 'Soon - after hours' },
      { config_key: 'URGENCY_URGENT', config_value: 1.50, unit: 'multiplier', category: 'urgency', description: 'Urgent - standard hours' },
      { config_key: 'URGENCY_URGENT_AFTERHOURS', config_value: 2.00, unit: 'multiplier', category: 'urgency', description: 'Urgent - after hours' },
      // Pest control
      { config_key: 'PEST_BASE_PRICE', config_value: 117, unit: '$', category: 'pest', description: 'Pest control base price' },
      { config_key: 'PEST_FLOOR', config_value: 89, unit: '$', category: 'pest', description: 'Pest control price floor' },
      { config_key: 'PEST_ROACH_GERMAN', config_value: 0.25, unit: 'multiplier', category: 'pest', description: 'German roach add-on (% of base)' },
      { config_key: 'PEST_ROACH_REGULAR', config_value: 0.10, unit: 'multiplier', category: 'pest', description: 'Regular roach add-on (% of base)' },
      { config_key: 'PEST_FREQ_QUARTERLY', config_value: 1.00, unit: 'discount', category: 'pest', description: '4x/yr frequency discount' },
      { config_key: 'PEST_FREQ_BIMONTHLY', config_value: 0.92, unit: 'discount', category: 'pest', description: '6x/yr frequency discount' },
      { config_key: 'PEST_FREQ_MONTHLY', config_value: 0.85, unit: 'discount', category: 'pest', description: '12x/yr frequency discount' },
      { config_key: 'PEST_INITIAL_FEE', config_value: 99, unit: '$', category: 'pest', description: 'WaveGuard Membership initial fee' },
      // Tree & Shrub — updated rates per pricing audit
      { config_key: 'TS_MATERIAL_RATE_6X', config_value: 0.110, unit: '$/sqft', category: 'tree_shrub', description: 'Standard (6x) material rate per bed sqft' },
      { config_key: 'TS_MATERIAL_RATE_9X', config_value: 0.190, unit: '$/sqft', category: 'tree_shrub', description: 'Enhanced (9x) material rate per bed sqft' },
      { config_key: 'TS_MATERIAL_RATE_12X', config_value: 0.220, unit: '$/sqft', category: 'tree_shrub', description: 'Premium (12x) material rate per bed sqft' },
      { config_key: 'TS_FLOOR_STANDARD', config_value: 50, unit: '$/mo', category: 'tree_shrub', description: 'Standard tier monthly floor' },
      { config_key: 'TS_FLOOR_ENHANCED', config_value: 65, unit: '$/mo', category: 'tree_shrub', description: 'Enhanced tier monthly floor' },
      { config_key: 'TS_FLOOR_PREMIUM', config_value: 80, unit: '$/mo', category: 'tree_shrub', description: 'Premium tier monthly floor' },
      // Palm injection tiers
      { config_key: 'PALM_PRICE_NUTRITION', config_value: 35, unit: '$/palm', category: 'palm', description: 'Palm-Jet nutrition injection' },
      { config_key: 'PALM_PRICE_INSECTICIDE', config_value: 45, unit: '$/palm', category: 'palm', description: 'Ima-Jet insecticide preventive' },
      { config_key: 'PALM_PRICE_COMBO', config_value: 55, unit: '$/palm', category: 'palm', description: 'Nutrition + insecticide combo' },
      { config_key: 'PALM_PRICE_FUNGAL', config_value: 40, unit: '$/palm', category: 'palm', description: 'Propizol or PHOSPHO-Jet' },
      { config_key: 'PALM_PRICE_LB_FLOOR', config_value: 125, unit: '$/palm', category: 'palm', description: 'Lethal Bronzing treatment floor' },
      { config_key: 'PALM_PRICE_TREEAGE_FLOOR', config_value: 65, unit: '$/palm', category: 'palm', description: 'Tree-Age specialty floor' },
      // Termite
      { config_key: 'TERMITE_PERIM_SIMPLE', config_value: 1.25, unit: 'multiplier', category: 'termite', description: 'Perimeter multiplier - simple landscape' },
      { config_key: 'TERMITE_PERIM_COMPLEX', config_value: 1.35, unit: 'multiplier', category: 'termite', description: 'Perimeter multiplier - moderate/complex' },
      { config_key: 'TERMITE_STATION_SPACING', config_value: 10, unit: 'ft', category: 'termite', description: 'Station spacing (linear feet)' },
      { config_key: 'TERMITE_INSTALL_MULT', config_value: 1.75, unit: 'multiplier', category: 'termite', description: 'Installation markup multiplier' },
      { config_key: 'TERMITE_BASIC_MONTHLY', config_value: 35, unit: '$/mo', category: 'termite', description: 'Basic monitoring monthly' },
      { config_key: 'TERMITE_PREMIER_MONTHLY', config_value: 65, unit: '$/mo', category: 'termite', description: 'Premier monitoring monthly' },
      // Rodent
      { config_key: 'RODENT_SMALL', config_value: 75, unit: '$/mo', category: 'rodent', description: 'Small (score ≤1) monthly' },
      { config_key: 'RODENT_MEDIUM', config_value: 89, unit: '$/mo', category: 'rodent', description: 'Medium (score 2) monthly' },
      { config_key: 'RODENT_LARGE', config_value: 109, unit: '$/mo', category: 'rodent', description: 'Large (score ≥3) monthly' },
      { config_key: 'RODENT_TRAPPING_BASE', config_value: 350, unit: '$', category: 'rodent', description: 'Rodent trapping base price' },
      // One-time
      { config_key: 'OT_PEST_MARKUP', config_value: 1.30, unit: 'multiplier', category: 'one_time', description: 'One-time pest markup over recurring' },
      { config_key: 'OT_PEST_FLOOR', config_value: 150, unit: '$', category: 'one_time', description: 'One-time pest floor' },
      { config_key: 'OT_LAWN_MARKUP', config_value: 1.30, unit: 'multiplier', category: 'one_time', description: 'One-time lawn markup over recurring' },
      { config_key: 'OT_LAWN_FLOOR', config_value: 85, unit: '$', category: 'one_time', description: 'One-time lawn floor' },
      { config_key: 'OT_LAWN_FUNGICIDE_FLOOR', config_value: 95, unit: '$', category: 'one_time', description: 'Standalone fungicide floor (no recurring)' },
      // Trenching
      { config_key: 'TRENCH_DIRT_RATE', config_value: 10, unit: '$/LF', category: 'trenching', description: 'Dirt linear foot rate' },
      { config_key: 'TRENCH_CONCRETE_RATE', config_value: 14, unit: '$/LF', category: 'trenching', description: 'Concrete linear foot rate' },
      { config_key: 'TRENCH_FLOOR', config_value: 600, unit: '$', category: 'trenching', description: 'Trenching minimum price' },
      { config_key: 'TRENCH_RENEWAL', config_value: 325, unit: '$/yr', category: 'trenching', description: 'Annual renewal price' },
      // Bora-Care
      { config_key: 'BC_GAL', config_value: 91.98, unit: '$/gal', category: 'bora_care', description: 'Bora-Care per gallon' },
      { config_key: 'BC_COV', config_value: 275, unit: 'sqft/gal', category: 'bora_care', description: 'Coverage per gallon' },
      { config_key: 'BC_EQUIP', config_value: 17.50, unit: '$', category: 'bora_care', description: 'Equipment fee' },
      // Pre-Slab
      { config_key: 'PS_BTL', config_value: 174.72, unit: '$/btl', category: 'pre_slab', description: 'Termidor per bottle' },
      { config_key: 'PS_COV', config_value: 1250, unit: 'sqft/btl', category: 'pre_slab', description: 'Coverage per bottle' },
      { config_key: 'PS_EQUIP', config_value: 15, unit: '$', category: 'pre_slab', description: 'Equipment fee' },
      // Foam drill
      { config_key: 'FM_CAN', config_value: 39.08, unit: '$/can', category: 'foam_drill', description: 'Per foam can' },
      { config_key: 'FM_BITS', config_value: 8, unit: '$', category: 'foam_drill', description: 'Equipment bits cost' },
      // Exclusion
      { config_key: 'EXCL_SIMPLE', config_value: 37.50, unit: '$/point', category: 'exclusion', description: 'Simple exclusion point' },
      { config_key: 'EXCL_MODERATE', config_value: 75, unit: '$/point', category: 'exclusion', description: 'Moderate exclusion point' },
      { config_key: 'EXCL_ADVANCED', config_value: 150, unit: '$/point', category: 'exclusion', description: 'Advanced exclusion point' },
      { config_key: 'EXCL_INSPECTION', config_value: 85, unit: '$', category: 'exclusion', description: 'Inspection fee (waivable)' },
      // WaveGuard
      { config_key: 'WG_BRONZE_DISCOUNT', config_value: 0, unit: '%', category: 'waveguard', description: 'Bronze tier discount' },
      { config_key: 'WG_SILVER_DISCOUNT', config_value: 0.10, unit: '%', category: 'waveguard', description: 'Silver tier discount' },
      { config_key: 'WG_GOLD_DISCOUNT', config_value: 0.15, unit: '%', category: 'waveguard', description: 'Gold tier discount' },
      { config_key: 'WG_PLATINUM_DISCOUNT', config_value: 0.20, unit: '%', category: 'waveguard', description: 'Platinum tier discount' },
      { config_key: 'WG_COMPOSITE_CAP', config_value: 0.25, unit: 'ratio', category: 'waveguard', description: 'Maximum effective discount from all sources combined' },
    ]);
  }

  // Pricing config audit log
  if (!(await knex.schema.hasTable('pricing_config_audit'))) {
    await knex.schema.createTable('pricing_config_audit', t => {
      t.increments('id').primary();
      t.string('config_key', 100).notNullable();
      t.decimal('old_value', 12, 4);
      t.decimal('new_value', 12, 4);
      t.string('changed_by', 100);
      t.timestamp('changed_at').defaultTo(knex.fn.now());
      t.text('reason');
    });
  }

  // Lawn care bracket pricing
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) {
    await knex.schema.createTable('lawn_pricing_brackets', t => {
      t.increments('id').primary();
      t.string('grass_track', 50).notNullable();
      t.integer('sqft_bracket').notNullable();
      t.string('tier', 20).notNullable();
      t.decimal('monthly_price', 8, 2).notNullable();
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['grass_track', 'sqft_bracket', 'tier']);
    });

    // Seed lawn brackets
    const brackets = [];
    const tracks = {
      st_augustine: [
        [0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],
        [5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],
        [10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]
      ],
      bermuda: [
        [0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,60,86],[6000,40,50,67,97],
        [7000,40,51,74,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],
        [15000,65,88,132,199],[20000,81,111,169,256]
      ],
      zoysia: [
        [0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,61,87],[6000,40,50,68,98],
        [7000,40,52,75,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],
        [15000,66,89,134,202],[20000,83,112,171,259]
      ],
      bahia: [
        [0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],
        [5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],
        [10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223]
      ],
    };
    const tiers = ['basic', 'standard', 'enhanced', 'premium'];
    for (const [track, rows] of Object.entries(tracks)) {
      for (const row of rows) {
        for (let i = 0; i < 4; i++) {
          brackets.push({ grass_track: track, sqft_bracket: row[0], tier: tiers[i], monthly_price: row[i + 1] });
        }
      }
    }
    // Insert in batches
    for (let i = 0; i < brackets.length; i += 50) {
      await knex('lawn_pricing_brackets').insert(brackets.slice(i, i + 50));
    }
  }

  // Service discount rules
  if (!(await knex.schema.hasTable('service_discount_rules'))) {
    await knex.schema.createTable('service_discount_rules', t => {
      t.increments('id').primary();
      t.string('service_key', 50).notNullable().unique();
      t.boolean('tier_qualifier').defaultTo(true);
      t.decimal('max_discount_pct', 4, 2);
      t.decimal('flat_credit', 8, 2);
      t.string('flat_credit_min_tier', 20);
      t.boolean('exclude_from_pct_discount').defaultTo(false);
      t.text('notes');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });

    await knex('service_discount_rules').insert([
      { service_key: 'lawn_care_basic', tier_qualifier: true, max_discount_pct: null, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Full discount applies' },
      { service_key: 'lawn_care_standard', tier_qualifier: true, max_discount_pct: null, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Full discount applies' },
      { service_key: 'lawn_care_enhanced', tier_qualifier: true, max_discount_pct: 0.15, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Capped at Gold (15%) for margin protection' },
      { service_key: 'lawn_care_premium', tier_qualifier: true, max_discount_pct: 0.15, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Capped at Gold (15%) for margin protection' },
      { service_key: 'pest_control', tier_qualifier: true, max_discount_pct: null, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Full discount applies' },
      { service_key: 'tree_shrub', tier_qualifier: true, max_discount_pct: null, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Full discount applies' },
      { service_key: 'palm_injection', tier_qualifier: false, max_discount_pct: null, exclude_from_pct_discount: true, flat_credit: 10.00, flat_credit_min_tier: 'gold', notes: 'Flat $10/palm/yr credit for Gold+. Not a tier qualifier.' },
      { service_key: 'mosquito', tier_qualifier: true, max_discount_pct: null, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Full discount applies' },
      { service_key: 'termite_bait', tier_qualifier: true, max_discount_pct: null, exclude_from_pct_discount: false, flat_credit: null, flat_credit_min_tier: null, notes: 'Full discount applies' },
      { service_key: 'rodent_bait', tier_qualifier: false, max_discount_pct: null, exclude_from_pct_discount: true, flat_credit: null, flat_credit_min_tier: null, notes: 'Excluded from % discounts. $50 setup credit handled separately.' },
    ]);
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('service_discount_rules');
  await knex.schema.dropTableIfExists('lawn_pricing_brackets');
  await knex.schema.dropTableIfExists('pricing_config_audit');
  await knex.schema.dropTableIfExists('pricing_config');
};
