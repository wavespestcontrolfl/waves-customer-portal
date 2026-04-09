/**
 * Service Library — single source of truth for all Waves services
 *
 * Tables: services, service_addons, service_packages, service_package_items
 * Alters: service_records, scheduled_services (adds service_id FK)
 */
exports.up = async function (knex) {
  const servicesExist = await knex.schema.hasTable('services');
  // ---- Services ----
  if (!servicesExist) {
  await knex.schema.createTable('services', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('service_key', 80).notNullable().unique();
    t.string('name', 200).notNullable();
    t.string('short_name', 50);
    t.text('description');
    t.text('internal_notes');
    t.string('category', 30).notNullable().defaultTo('other');
    // category CHECK: pest_control, lawn_care, mosquito, termite, rodent, tree_shrub, inspection, specialty, other
    t.string('subcategory', 50);
    t.string('billing_type', 20).defaultTo('recurring');
    t.boolean('is_waveguard').defaultTo(false);
    t.integer('default_duration_minutes').defaultTo(60);
    t.integer('min_duration_minutes');
    t.integer('max_duration_minutes');
    t.integer('scheduling_buffer_minutes').defaultTo(0);
    t.boolean('requires_follow_up').defaultTo(false);
    t.integer('follow_up_interval_days');
    t.string('frequency', 20);
    t.integer('visits_per_year');
    t.string('pricing_type', 20).defaultTo('variable');
    t.decimal('base_price', 10, 2);
    t.decimal('price_range_min', 10, 2);
    t.decimal('price_range_max', 10, 2);
    t.string('pricing_model_key', 50);
    t.boolean('is_taxable').defaultTo(true);
    t.string('tax_category', 50);
    t.string('tax_service_key', 80);
    t.boolean('requires_license').defaultTo(false);
    t.string('license_category', 20);
    t.jsonb('requires_certification');
    t.integer('min_tech_skill_level').defaultTo(1);
    t.jsonb('default_equipment');
    t.jsonb('default_products');
    t.decimal('typical_materials_cost', 10, 2);
    t.boolean('customer_visible').defaultTo(true);
    t.boolean('booking_enabled').defaultTo(true);
    t.integer('sort_order').defaultTo(100);
    t.string('icon', 10);
    t.string('color', 7);
    t.boolean('is_active').defaultTo(true);
    t.boolean('is_archived').defaultTo(false);
    t.string('square_service_id', 100);
    t.string('square_variation_id', 100);
    t.timestamps(true, true);
  });

  await knex.schema.table('services', (t) => {
    t.index('category');
    t.index('is_active');
    t.index('billing_type');
  });
  } // end if !servicesExist

  // ---- Service Add-ons ----
  if (!(await knex.schema.hasTable('service_addons'))) {
  await knex.schema.createTable('service_addons', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('parent_service_id').notNullable().references('id').inTable('services').onDelete('CASCADE');
    t.uuid('addon_service_id').notNullable().references('id').inTable('services').onDelete('CASCADE');
    t.boolean('is_default').defaultTo(false);
    t.decimal('addon_price', 10, 2);
    t.integer('sort_order').defaultTo(0);
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
  } // end if !service_addons

  // ---- Service Packages (WaveGuard tiers) ----
  if (!(await knex.schema.hasTable('service_packages'))) {
  await knex.schema.createTable('service_packages', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('package_key', 50).notNullable().unique();
    t.string('name', 200).notNullable();
    t.string('tier', 20);
    t.text('description');
    t.decimal('discount_pct', 5, 2).defaultTo(0);
    t.decimal('monthly_price_min', 10, 2);
    t.decimal('monthly_price_max', 10, 2);
    t.boolean('is_active').defaultTo(true);
    t.jsonb('features');
    t.integer('sort_order').defaultTo(0);
    t.timestamps(true, true);
  });
  } // end if !service_packages

  // ---- Package → Service Items ----
  if (!(await knex.schema.hasTable('service_package_items'))) {
  await knex.schema.createTable('service_package_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('package_id').notNullable().references('id').inTable('service_packages').onDelete('CASCADE');
    t.uuid('service_id').notNullable().references('id').inTable('services').onDelete('CASCADE');
    t.boolean('is_included').defaultTo(true);
    t.integer('included_visits');
    t.decimal('addon_discount_pct', 5, 2);
    t.integer('sort_order').defaultTo(0);
  });
  } // end if !service_package_items

  // ---- ALTER service_records ----
  const srHasCol = await knex.schema.hasColumn('service_records', 'service_id');
  if (!srHasCol) {
    await knex.schema.table('service_records', (t) => {
      t.uuid('service_id').references('id').inTable('services').onDelete('SET NULL');
    });
  }

  // ---- ALTER scheduled_services ----
  const ssHasCol = await knex.schema.hasColumn('scheduled_services', 'service_id');
  if (!ssHasCol) {
    await knex.schema.table('scheduled_services', (t) => {
      t.uuid('service_id').references('id').inTable('services').onDelete('SET NULL');
    });
  }

  // ========== SEED SERVICES ==========
  const services = [
    // --- Pest Control ---
    {
      service_key: 'pest_general_quarterly', name: 'General Pest Control (Quarterly)', short_name: 'Pest Quarterly',
      description: 'Interior/exterior perimeter treatment targeting roaches, ants, spiders, silverfish, and occasional invaders.',
      category: 'pest_control', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4,
      default_duration_minutes: 45, min_duration_minutes: 30, max_duration_minutes: 60,
      pricing_type: 'variable', base_price: 65.00, price_range_min: 55.00, price_range_max: 95.00,
      is_waveguard: true, is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🐜', color: '#0ea5e9', sort_order: 1,
      default_products: JSON.stringify(['Demand CS', 'Advion Gel', 'Gentrol IGR']),
    },
    {
      service_key: 'pest_general_monthly', name: 'General Pest Control (Monthly)', short_name: 'Pest Monthly',
      description: 'Monthly perimeter and interior pest treatment for heavy pressure or commercial accounts.',
      category: 'pest_control', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12,
      default_duration_minutes: 30, min_duration_minutes: 20, max_duration_minutes: 45,
      pricing_type: 'variable', base_price: 45.00, price_range_min: 40.00, price_range_max: 75.00,
      is_waveguard: true, is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🐜', color: '#0ea5e9', sort_order: 2,
      default_products: JSON.stringify(['Demand CS', 'Advion Gel']),
    },
    {
      service_key: 'pest_initial_cleanout', name: 'Initial Pest Cleanout', short_name: 'Pest Cleanout',
      description: 'Heavy-duty initial treatment for new customers with active infestations. Includes interior flush, crack & crevice, exterior barrier.',
      category: 'pest_control', billing_type: 'one_time',
      default_duration_minutes: 90, min_duration_minutes: 60, max_duration_minutes: 120,
      pricing_type: 'variable', base_price: 175.00, price_range_min: 125.00, price_range_max: 300.00,
      requires_follow_up: true, follow_up_interval_days: 14,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🏠', color: '#ef4444', sort_order: 3,
    },
    // --- Lawn Care ---
    {
      service_key: 'lawn_fertilization', name: 'Lawn Fertilization & Weed Control', short_name: 'Lawn Fert',
      description: 'Granular or liquid fertilization with pre/post-emergent weed control, tailored to turf type and season.',
      category: 'lawn_care', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6,
      default_duration_minutes: 45, min_duration_minutes: 30, max_duration_minutes: 75,
      pricing_type: 'variable', base_price: 55.00, price_range_min: 45.00, price_range_max: 120.00,
      pricing_model_key: 'sqft_lawn', is_waveguard: true,
      is_taxable: true, tax_service_key: 'lawn_care',
      requires_license: true, license_category: 'L&O',
      icon: '🌿', color: '#10b981', sort_order: 10,
      default_products: JSON.stringify(['0-0-7 Granular', 'Celsius WG', 'Dismiss']),
    },
    {
      service_key: 'lawn_fungicide', name: 'Lawn Fungicide Treatment', short_name: 'Fungicide',
      description: 'Curative or preventive fungicide application for brown patch, dollar spot, take-all root rot, etc.',
      category: 'lawn_care', billing_type: 'one_time', subcategory: 'disease',
      default_duration_minutes: 40, min_duration_minutes: 25, max_duration_minutes: 60,
      pricing_type: 'variable', base_price: 65.00, price_range_min: 55.00, price_range_max: 150.00,
      pricing_model_key: 'sqft_lawn',
      is_taxable: true, tax_service_key: 'lawn_care',
      requires_license: true, license_category: 'L&O',
      icon: '🍄', color: '#a855f7', sort_order: 11,
      default_products: JSON.stringify(['Clearys 3336F', 'Pillar G']),
    },
    {
      service_key: 'lawn_insect_control', name: 'Lawn Insect Control', short_name: 'Lawn Insects',
      description: 'Chinch bug, sod webworm, armyworm, or grub treatment. Includes follow-up check.',
      category: 'lawn_care', billing_type: 'one_time', subcategory: 'insect',
      default_duration_minutes: 45, min_duration_minutes: 30, max_duration_minutes: 60,
      pricing_type: 'variable', base_price: 60.00, price_range_min: 50.00, price_range_max: 130.00,
      pricing_model_key: 'sqft_lawn',
      requires_follow_up: true, follow_up_interval_days: 21,
      is_taxable: true, tax_service_key: 'lawn_care',
      requires_license: true, license_category: 'L&O',
      icon: '🦗', color: '#f59e0b', sort_order: 12,
    },
    {
      service_key: 'lawn_aeration', name: 'Core Aeration', short_name: 'Aeration',
      description: 'Mechanical core aeration to reduce compaction, improve root growth, and enhance nutrient uptake.',
      category: 'lawn_care', billing_type: 'one_time', subcategory: 'cultural',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'variable', base_price: 150.00, price_range_min: 100.00, price_range_max: 350.00,
      pricing_model_key: 'sqft_lawn', frequency: 'annual', visits_per_year: 1,
      is_taxable: false,
      icon: '🌱', color: '#10b981', sort_order: 13,
    },
    // --- Mosquito ---
    {
      service_key: 'mosquito_monthly', name: 'Mosquito Control (Monthly)', short_name: 'Mosquito',
      description: 'Backpack mist of barrier treatment to foliage, eaves, and breeding sites. Includes larvicide.',
      category: 'mosquito', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12,
      default_duration_minutes: 30, min_duration_minutes: 20, max_duration_minutes: 45,
      pricing_type: 'variable', base_price: 45.00, price_range_min: 39.00, price_range_max: 85.00,
      is_waveguard: true, is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🦟', color: '#6366f1', sort_order: 20,
      default_products: JSON.stringify(['Cyzmic CS', 'Altosid Pro-G']),
    },
    {
      service_key: 'mosquito_event', name: 'Mosquito Event Spray', short_name: 'Event Spray',
      description: 'One-time mosquito knockdown for outdoor events, weddings, parties.',
      category: 'mosquito', billing_type: 'one_time',
      default_duration_minutes: 30, min_duration_minutes: 20, max_duration_minutes: 45,
      pricing_type: 'fixed', base_price: 125.00,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🎉', color: '#6366f1', sort_order: 21,
      booking_enabled: true,
    },
    // --- Termite ---
    {
      service_key: 'termite_liquid', name: 'Termite Liquid Treatment', short_name: 'Termite Liquid',
      description: 'Full liquid barrier treatment around foundation using Termidor or Taurus SC. Includes drilling, trenching, and rod treatment.',
      category: 'termite', billing_type: 'one_time',
      default_duration_minutes: 240, min_duration_minutes: 180, max_duration_minutes: 480,
      pricing_type: 'variable', base_price: 1200.00, price_range_min: 800.00, price_range_max: 3500.00,
      pricing_model_key: 'linear_ft',
      requires_follow_up: true, follow_up_interval_days: 365,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 3,
      icon: '🪵', color: '#dc2626', sort_order: 30,
      default_products: JSON.stringify(['Termidor SC', 'Taurus SC']),
      typical_materials_cost: 180.00,
    },
    {
      service_key: 'termite_bait', name: 'Termite Bait Station System', short_name: 'Termite Bait',
      description: 'Installation and monitoring of in-ground bait stations (Trelona ATBS or Sentricon). Includes annual monitoring.',
      category: 'termite', billing_type: 'recurring', frequency: 'annual', visits_per_year: 4,
      default_duration_minutes: 180, min_duration_minutes: 120, max_duration_minutes: 300,
      pricing_type: 'variable', base_price: 1500.00, price_range_min: 1000.00, price_range_max: 4000.00,
      pricing_model_key: 'linear_ft',
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 3,
      icon: '🪤', color: '#dc2626', sort_order: 31,
      typical_materials_cost: 350.00,
    },
    {
      service_key: 'termite_renewal', name: 'Termite Warranty Renewal', short_name: 'WDO Renewal',
      description: 'Annual renewal inspection and re-treatment warranty for existing termite customers.',
      category: 'termite', billing_type: 'recurring', frequency: 'annual', visits_per_year: 1,
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'variable', base_price: 250.00, price_range_min: 175.00, price_range_max: 400.00,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '📋', color: '#dc2626', sort_order: 32,
    },
    // --- Rodent ---
    {
      service_key: 'rodent_exclusion', name: 'Rodent Exclusion & Trapping', short_name: 'Rodent',
      description: 'Full exclusion sealing of entry points, attic inspection, snap trap placement, and follow-up monitoring.',
      category: 'rodent', billing_type: 'one_time',
      default_duration_minutes: 120, min_duration_minutes: 60, max_duration_minutes: 240,
      pricing_type: 'variable', base_price: 350.00, price_range_min: 250.00, price_range_max: 1200.00,
      requires_follow_up: true, follow_up_interval_days: 7,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🐀', color: '#78716c', sort_order: 40,
      typical_materials_cost: 75.00,
    },
    {
      service_key: 'rodent_monitoring', name: 'Rodent Monitoring (Monthly)', short_name: 'Rodent Monitor',
      description: 'Monthly check and service of bait stations and traps. Includes re-baiting and report.',
      category: 'rodent', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12,
      default_duration_minutes: 20, min_duration_minutes: 15, max_duration_minutes: 30,
      pricing_type: 'fixed', base_price: 45.00,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🐀', color: '#78716c', sort_order: 41,
    },
    // --- Tree & Shrub ---
    {
      service_key: 'tree_shrub_program', name: 'Tree & Shrub Care Program', short_name: 'Tree & Shrub',
      description: 'Bi-monthly fertilization, insect control, and disease management for ornamental trees and shrubs.',
      category: 'tree_shrub', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6,
      default_duration_minutes: 45, min_duration_minutes: 30, max_duration_minutes: 75,
      pricing_type: 'variable', base_price: 55.00, price_range_min: 45.00, price_range_max: 150.00,
      pricing_model_key: 'bed_sqft', is_waveguard: true,
      is_taxable: true, tax_service_key: 'lawn_care',
      requires_license: true, license_category: 'L&O',
      icon: '🌳', color: '#059669', sort_order: 50,
    },
    {
      service_key: 'palm_treatment', name: 'Palm Tree Nutritional Treatment', short_name: 'Palm Fert',
      description: 'Deep root injection or soil drench with palm-specific micronutrients (Mn, Mg, K).',
      category: 'tree_shrub', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4,
      default_duration_minutes: 30, min_duration_minutes: 15, max_duration_minutes: 60,
      pricing_type: 'variable', base_price: 25.00, price_range_min: 15.00, price_range_max: 45.00,
      pricing_model_key: 'palm_count',
      is_taxable: true, tax_service_key: 'lawn_care',
      requires_license: true, license_category: 'L&O',
      icon: '🌴', color: '#059669', sort_order: 51,
      internal_notes: 'Price is per palm — multiply by palm_count.',
    },
    // --- Inspections ---
    {
      service_key: 'wdo_inspection', name: 'WDO Inspection (Termite Letter)', short_name: 'WDO Inspect',
      description: 'Florida Form 13645 wood-destroying organism inspection for real estate transactions.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'fixed', base_price: 125.00,
      is_taxable: false,
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🔍', color: '#0ea5e9', sort_order: 60,
      customer_visible: true, booking_enabled: true,
    },
    {
      service_key: 'lawn_inspection', name: 'Lawn Health Inspection', short_name: 'Lawn Inspect',
      description: 'Comprehensive lawn evaluation: soil pH, thatch depth, moisture reading, pest pressure, turf density score.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 45, min_duration_minutes: 30, max_duration_minutes: 60,
      pricing_type: 'fixed', base_price: 0.00,
      is_taxable: false,
      icon: '📊', color: '#10b981', sort_order: 61,
      internal_notes: 'Free for WaveGuard members. $75 for non-members.',
    },
    {
      service_key: 'new_customer_inspection', name: 'New Customer Property Inspection', short_name: 'New Cust Insp',
      description: 'Initial walk-through for new customers — assess property, identify issues, recommend services.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'fixed', base_price: 0.00,
      is_taxable: false,
      icon: '🏡', color: '#f59e0b', sort_order: 62,
      booking_enabled: true,
    },
    // --- Specialty ---
    {
      service_key: 'fire_ant', name: 'Fire Ant Treatment', short_name: 'Fire Ants',
      description: 'Broadcast bait plus mound drench for active fire ant colonies.',
      category: 'specialty', billing_type: 'one_time',
      default_duration_minutes: 30, min_duration_minutes: 20, max_duration_minutes: 45,
      pricing_type: 'variable', base_price: 75.00, price_range_min: 55.00, price_range_max: 150.00,
      pricing_model_key: 'sqft_lawn',
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🔥', color: '#ef4444', sort_order: 70,
      default_products: JSON.stringify(['Extinguish Plus', 'Advion Fire Ant']),
    },
    {
      service_key: 'flea_tick', name: 'Flea & Tick Yard Treatment', short_name: 'Flea/Tick',
      description: 'Full yard broadcast for flea and tick control. Interior treatment available as add-on.',
      category: 'specialty', billing_type: 'one_time',
      default_duration_minutes: 40, min_duration_minutes: 30, max_duration_minutes: 60,
      pricing_type: 'variable', base_price: 85.00, price_range_min: 65.00, price_range_max: 150.00,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      icon: '🐕', color: '#f59e0b', sort_order: 71,
    },
    {
      service_key: 'bee_wasp_removal', name: 'Bee / Wasp Nest Removal', short_name: 'Bee/Wasp',
      description: 'Safe removal or treatment of paper wasp, yellow jacket, or carpenter bee nests.',
      category: 'specialty', billing_type: 'one_time',
      default_duration_minutes: 45, min_duration_minutes: 20, max_duration_minutes: 90,
      pricing_type: 'variable', base_price: 125.00, price_range_min: 75.00, price_range_max: 350.00,
      is_taxable: true, tax_service_key: 'pest_control',
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🐝', color: '#f59e0b', sort_order: 72,
    },
    // --- WaveGuard Membership ---
    {
      service_key: 'waveguard_membership', name: 'WaveGuard Membership', short_name: 'WaveGuard',
      description: 'All-in-one bundled membership covering pest, lawn, mosquito, and tree & shrub services at a monthly rate.',
      category: 'specialty', billing_type: 'recurring', frequency: 'monthly',
      default_duration_minutes: 0,
      pricing_type: 'variable', price_range_min: 69.00, price_range_max: 229.00,
      is_waveguard: true,
      is_taxable: true, tax_service_key: 'pest_control',
      customer_visible: true, booking_enabled: false,
      icon: '🛡️', color: '#0ea5e9', sort_order: 0,
    },
  ];

  if (!servicesExist) {
    await knex('services').insert(services).catch(() => {});
  }

  // ========== SEED PACKAGES ==========
  const svcRows = await knex('services').select('id', 'service_key');
  const svcMap = {};
  svcRows.forEach(r => { svcMap[r.service_key] = r.id; });

  const packages = [
    {
      package_key: 'waveguard_bronze', name: 'WaveGuard Bronze', tier: 'Bronze',
      description: 'Essential pest protection. Quarterly general pest control included.',
      discount_pct: 0, monthly_price_min: 69.00, monthly_price_max: 99.00, sort_order: 1,
      features: JSON.stringify(['Quarterly pest control', 'Free re-services between visits', 'Online portal access', 'SMS appointment reminders']),
    },
    {
      package_key: 'waveguard_silver', name: 'WaveGuard Silver', tier: 'Silver',
      description: 'Pest + lawn care bundle. 10% discount on all add-on services.',
      discount_pct: 10, monthly_price_min: 99.00, monthly_price_max: 149.00, sort_order: 2,
      features: JSON.stringify(['Everything in Bronze', 'Bi-monthly lawn fertilization & weed control', '10% off add-on services', 'Priority scheduling', 'Lawn health dashboard']),
    },
    {
      package_key: 'waveguard_gold', name: 'WaveGuard Gold', tier: 'Gold',
      description: 'Pest + lawn + mosquito. 15% discount on add-ons. Includes tree & shrub care.',
      discount_pct: 15, monthly_price_min: 149.00, monthly_price_max: 189.00, sort_order: 3,
      features: JSON.stringify(['Everything in Silver', 'Monthly mosquito control', 'Tree & shrub care program', '15% off add-on services', 'Free lawn health inspections', 'Same-day emergency service']),
    },
    {
      package_key: 'waveguard_platinum', name: 'WaveGuard Platinum', tier: 'Platinum',
      description: 'Complete property protection. All services included. 20% off any extras.',
      discount_pct: 20, monthly_price_min: 189.00, monthly_price_max: 229.00, sort_order: 4,
      features: JSON.stringify(['Everything in Gold', 'Monthly pest control', 'Palm nutritional treatments', 'Annual fire ant treatment included', '20% off all add-on services', 'Dedicated account manager', 'Annual WDO inspection included']),
    },
  ];

  await knex('service_packages').insert(packages).catch(() => {});

  // Seed package items
  const pkgRows = await knex('service_packages').select('id', 'package_key');
  const pkgMap = {};
  pkgRows.forEach(r => { pkgMap[r.package_key] = r.id; });

  const packageItems = [
    // Bronze
    { package_id: pkgMap.waveguard_bronze, service_id: svcMap.pest_general_quarterly, is_included: true, included_visits: 4, sort_order: 1 },
    // Silver
    { package_id: pkgMap.waveguard_silver, service_id: svcMap.pest_general_quarterly, is_included: true, included_visits: 4, sort_order: 1 },
    { package_id: pkgMap.waveguard_silver, service_id: svcMap.lawn_fertilization, is_included: true, included_visits: 6, sort_order: 2 },
    // Gold
    { package_id: pkgMap.waveguard_gold, service_id: svcMap.pest_general_quarterly, is_included: true, included_visits: 4, sort_order: 1 },
    { package_id: pkgMap.waveguard_gold, service_id: svcMap.lawn_fertilization, is_included: true, included_visits: 6, sort_order: 2 },
    { package_id: pkgMap.waveguard_gold, service_id: svcMap.mosquito_monthly, is_included: true, included_visits: 12, sort_order: 3 },
    { package_id: pkgMap.waveguard_gold, service_id: svcMap.tree_shrub_program, is_included: true, included_visits: 6, sort_order: 4 },
    // Platinum
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.pest_general_monthly, is_included: true, included_visits: 12, sort_order: 1 },
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.lawn_fertilization, is_included: true, included_visits: 6, sort_order: 2 },
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.mosquito_monthly, is_included: true, included_visits: 12, sort_order: 3 },
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.tree_shrub_program, is_included: true, included_visits: 6, sort_order: 4 },
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.palm_treatment, is_included: true, included_visits: 4, sort_order: 5 },
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.fire_ant, is_included: true, included_visits: 1, sort_order: 6 },
    { package_id: pkgMap.waveguard_platinum, service_id: svcMap.wdo_inspection, is_included: true, included_visits: 1, sort_order: 7 },
  ];

  await knex('service_package_items').insert(packageItems);

  // ========== BACKFILL service_id on existing records ==========
  const matchMap = {
    'General Pest': svcMap.pest_general_quarterly,
    'Pest Control': svcMap.pest_general_quarterly,
    'Quarterly Pest': svcMap.pest_general_quarterly,
    'Monthly Pest': svcMap.pest_general_monthly,
    'Initial Cleanout': svcMap.pest_initial_cleanout,
    'Pest Cleanout': svcMap.pest_initial_cleanout,
    'Lawn Care': svcMap.lawn_fertilization,
    'Lawn Fertilization': svcMap.lawn_fertilization,
    'Fertilization': svcMap.lawn_fertilization,
    'Weed Control': svcMap.lawn_fertilization,
    'Fungicide': svcMap.lawn_fungicide,
    'Lawn Fungicide': svcMap.lawn_fungicide,
    'Lawn Insect': svcMap.lawn_insect_control,
    'Chinch Bug': svcMap.lawn_insect_control,
    'Aeration': svcMap.lawn_aeration,
    'Mosquito': svcMap.mosquito_monthly,
    'Mosquito Control': svcMap.mosquito_monthly,
    'Mosquito Treatment': svcMap.mosquito_monthly,
    'Event Spray': svcMap.mosquito_event,
    'Termite': svcMap.termite_liquid,
    'Termite Treatment': svcMap.termite_liquid,
    'Termite Liquid': svcMap.termite_liquid,
    'Termite Bait': svcMap.termite_bait,
    'WDO Renewal': svcMap.termite_renewal,
    'Termite Renewal': svcMap.termite_renewal,
    'Rodent': svcMap.rodent_exclusion,
    'Rodent Exclusion': svcMap.rodent_exclusion,
    'Rodent Monitoring': svcMap.rodent_monitoring,
    'Tree & Shrub': svcMap.tree_shrub_program,
    'Tree and Shrub': svcMap.tree_shrub_program,
    'Shrub Care': svcMap.tree_shrub_program,
    'Palm': svcMap.palm_treatment,
    'Palm Treatment': svcMap.palm_treatment,
    'WDO Inspection': svcMap.wdo_inspection,
    'Termite Inspection': svcMap.wdo_inspection,
    'Lawn Inspection': svcMap.lawn_inspection,
    'Lawn Health': svcMap.lawn_inspection,
    'Fire Ant': svcMap.fire_ant,
    'Flea': svcMap.flea_tick,
    'Flea & Tick': svcMap.flea_tick,
    'Tick': svcMap.flea_tick,
    'Bee': svcMap.bee_wasp_removal,
    'Wasp': svcMap.bee_wasp_removal,
    'WaveGuard': svcMap.waveguard_membership,
  };

  for (const [pattern, serviceId] of Object.entries(matchMap)) {
    if (!serviceId) continue;
    await knex('service_records')
      .whereNull('service_id')
      .where('service_type', 'ilike', `%${pattern}%`)
      .update({ service_id: serviceId });

    await knex('scheduled_services')
      .whereNull('service_id')
      .where('service_type', 'ilike', `%${pattern}%`)
      .update({ service_id: serviceId });
  }
};

exports.down = async function (knex) {
  // Remove FK columns first
  const srHas = await knex.schema.hasColumn('service_records', 'service_id');
  if (srHas) {
    await knex.schema.table('service_records', (t) => { t.dropColumn('service_id'); });
  }
  const ssHas = await knex.schema.hasColumn('scheduled_services', 'service_id');
  if (ssHas) {
    await knex.schema.table('scheduled_services', (t) => { t.dropColumn('service_id'); });
  }

  await knex.schema.dropTableIfExists('service_package_items');
  await knex.schema.dropTableIfExists('service_packages');
  await knex.schema.dropTableIfExists('service_addons');
  await knex.schema.dropTableIfExists('services');
};
