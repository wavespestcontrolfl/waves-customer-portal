/**
 * Add missing services from Square catalog to service library
 *
 * Maps all Square booking items not yet covered in the initial seed.
 * Follows the same schema, conventions, and field patterns as 20260401000105_service_library.js
 *
 * New services added:
 *   PEST CONTROL
 *     - pest_general_semiannual   (2x/yr recurring)
 *     - pest_general_bimonthly    (6x/yr recurring)
 *     - tick_control              (one-time)
 *     - mud_dauber_removal        (one-time)
 *     - wildlife_trapping         (one-time)
 *
 *   RODENT
 *     - rodent_trapping           (standalone trapping, one-time)
 *     - rodent_exclusion_only     (standalone exclusion, one-time)
 *     - rodent_trapping_sanitation         (trap + sanitize, one-time)
 *     - rodent_trapping_exclusion_sanitation (full bundle, one-time)
 *     - rodent_general_one_time   (general rodent pest control, one-time)
 *
 *   TERMITE
 *     - termite_bond_10yr         (quarterly billing, 10-year term)
 *     - termite_bond_5yr          (quarterly billing, 5-year term)
 *     - termite_bond_1yr          (quarterly billing, 1-year term)
 *     - termite_monitoring        (4x/yr recurring)
 *     - termite_active_annual     (1x/yr recurring)
 *     - termite_active_bait_quarterly  (4x/yr recurring)
 *     - termite_installation_setup     (one-time)
 *     - termite_pretreatment      (one-time)
 *     - termite_trenching         (one-time)
 *     - termite_cartridge_replacement  (one-time, fixed price)
 *     - termite_slab_pretreat     (one-time)
 *
 *   TREE & SHRUB
 *     - tree_shrub_6week          (9x/yr recurring)
 *
 *   WAVEGUARD
 *     - waveguard_initial_setup   (one-time onboarding)
 *
 *   GENERAL
 *     - general_appointment       (generic booking placeholder)
 */
exports.up = async function (knex) {
  const services = [
    // ============================================================
    // PEST CONTROL — additional frequencies
    // ============================================================
    {
      service_key: 'pest_general_semiannual',
      name: 'General Pest Control (Semiannual)',
      short_name: 'Pest Semiannual',
      description: 'Twice-per-year interior/exterior perimeter treatment. Suitable for low-pressure properties or seasonal coverage.',
      category: 'pest_control',
      billing_type: 'recurring',
      frequency: 'semiannual',
      visits_per_year: 2,
      default_duration_minutes: 45,
      min_duration_minutes: 30,
      max_duration_minutes: 60,
      pricing_type: 'variable',
      base_price: 75.00,
      price_range_min: 65.00,
      price_range_max: 110.00,
      is_waveguard: false,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🐜',
      color: '#0ea5e9',
      sort_order: 4,
      default_products: JSON.stringify(['Demand CS', 'Advion Gel', 'Gentrol IGR']),
    },
    {
      service_key: 'pest_general_bimonthly',
      name: 'General Pest Control (Bi-Monthly)',
      short_name: 'Pest Bi-Monthly',
      description: 'Every-other-month perimeter and interior treatment. Good balance of coverage and cost for moderate pest pressure.',
      category: 'pest_control',
      billing_type: 'recurring',
      frequency: 'bimonthly',
      visits_per_year: 6,
      default_duration_minutes: 40,
      min_duration_minutes: 25,
      max_duration_minutes: 55,
      pricing_type: 'variable',
      base_price: 55.00,
      price_range_min: 49.00,
      price_range_max: 85.00,
      is_waveguard: false,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🐜',
      color: '#0ea5e9',
      sort_order: 5,
      default_products: JSON.stringify(['Demand CS', 'Advion Gel']),
    },

    // ============================================================
    // PEST CONTROL — specialty one-time services
    // ============================================================
    {
      service_key: 'tick_control',
      name: 'Tick Control Service',
      short_name: 'Tick Control',
      description: 'Targeted tick treatment for yard, fence line, and wooded edges. Includes granular broadcast and perimeter spray.',
      category: 'specialty',
      billing_type: 'one_time',
      default_duration_minutes: 45,
      min_duration_minutes: 30,
      max_duration_minutes: 60,
      pricing_type: 'variable',
      base_price: 85.00,
      price_range_min: 65.00,
      price_range_max: 150.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🕷️',
      color: '#78716c',
      sort_order: 73,
    },
    {
      service_key: 'mud_dauber_removal',
      name: 'Mud Dauber Nest Removal',
      short_name: 'Mud Dauber',
      description: 'Physical removal of mud dauber nests from eaves, soffits, walls, and structures. Includes residual treatment to deter rebuilding.',
      category: 'specialty',
      billing_type: 'one_time',
      default_duration_minutes: 30,
      min_duration_minutes: 15,
      max_duration_minutes: 60,
      pricing_type: 'variable',
      base_price: 95.00,
      price_range_min: 65.00,
      price_range_max: 200.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🏠',
      color: '#78716c',
      sort_order: 74,
    },
    {
      service_key: 'wildlife_trapping',
      name: 'Wildlife Trapping Service',
      short_name: 'Wildlife Trap',
      description: 'Humane live-trapping for raccoons, opossums, armadillos, and other nuisance wildlife. Includes trap setup, daily monitoring, and animal removal.',
      category: 'specialty',
      billing_type: 'one_time',
      default_duration_minutes: 60,
      min_duration_minutes: 30,
      max_duration_minutes: 120,
      pricing_type: 'variable',
      base_price: 175.00,
      price_range_min: 125.00,
      price_range_max: 400.00,
      requires_follow_up: true,
      follow_up_interval_days: 1,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🦝',
      color: '#78716c',
      sort_order: 75,
      internal_notes: 'Daily trap checks required by FL statute. Bill per-animal or flat-rate depending on scope.',
    },

    // ============================================================
    // RODENT — granular service variants
    // ============================================================
    {
      service_key: 'rodent_trapping',
      name: 'Rodent Trapping Service',
      short_name: 'Rodent Trap',
      description: 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup and follow-up trap checks.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 60,
      min_duration_minutes: 30,
      max_duration_minutes: 90,
      pricing_type: 'variable',
      base_price: 175.00,
      price_range_min: 125.00,
      price_range_max: 350.00,
      requires_follow_up: true,
      follow_up_interval_days: 3,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🐀',
      color: '#78716c',
      sort_order: 42,
    },
    {
      service_key: 'rodent_exclusion_only',
      name: 'Rodent Exclusion Service',
      short_name: 'Rodent Excl',
      description: 'Sealing of all identified rodent entry points — roof line, A/C chases, plumbing penetrations, gable vents. No trapping included.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 120,
      min_duration_minutes: 60,
      max_duration_minutes: 240,
      pricing_type: 'variable',
      base_price: 300.00,
      price_range_min: 200.00,
      price_range_max: 1000.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🔒',
      color: '#78716c',
      sort_order: 43,
      typical_materials_cost: 60.00,
    },
    {
      service_key: 'rodent_trapping_sanitation',
      name: 'Rodent Trapping & Sanitation Service',
      short_name: 'Trap + Sanitize',
      description: 'Trapping program plus attic/crawlspace sanitation — removal of droppings, contaminated insulation, and antimicrobial fogging.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 180,
      min_duration_minutes: 120,
      max_duration_minutes: 360,
      pricing_type: 'variable',
      base_price: 450.00,
      price_range_min: 300.00,
      price_range_max: 1500.00,
      requires_follow_up: true,
      follow_up_interval_days: 7,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🐀',
      color: '#78716c',
      sort_order: 44,
      typical_materials_cost: 120.00,
    },
    {
      service_key: 'rodent_trapping_exclusion_sanitation',
      name: 'Rodent Trapping, Exclusion & Sanitation Service',
      short_name: 'Full Rodent Bundle',
      description: 'Complete rodent remediation: trapping, full-home exclusion sealing, and attic/crawlspace sanitation with antimicrobial treatment.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 300,
      min_duration_minutes: 180,
      max_duration_minutes: 480,
      pricing_type: 'variable',
      base_price: 750.00,
      price_range_min: 500.00,
      price_range_max: 2500.00,
      requires_follow_up: true,
      follow_up_interval_days: 7,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🐀',
      color: '#78716c',
      sort_order: 45,
      typical_materials_cost: 200.00,
      internal_notes: 'Full bundle — trapping + exclusion + sanitation. Qualifies for $199/yr guarantee renewal when complete.',
    },
    {
      service_key: 'rodent_general_one_time',
      name: 'Rodent Pest Control',
      short_name: 'Rodent One-Time',
      description: 'General one-time rodent service — assessment, bait placement, and recommendations. Use when scope is undetermined at booking.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 60,
      min_duration_minutes: 30,
      max_duration_minutes: 120,
      pricing_type: 'variable',
      base_price: 150.00,
      price_range_min: 99.00,
      price_range_max: 300.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🐀',
      color: '#78716c',
      sort_order: 46,
      internal_notes: 'Catch-all for rodent bookings. Upsell to trapping + exclusion after initial assessment.',
    },

    // ============================================================
    // TERMITE — bonds (quarterly billing, term-based)
    // ============================================================
    {
      service_key: 'termite_bond_10yr',
      name: 'Termite Bond (10-Year Term)',
      short_name: 'Bond 10yr',
      description: 'Quarterly-billed termite warranty bond with 10-year term. Includes annual inspection and re-treatment coverage.',
      category: 'termite',
      billing_type: 'recurring',
      frequency: 'quarterly',
      visits_per_year: 4,
      default_duration_minutes: 30,
      min_duration_minutes: 20,
      max_duration_minutes: 60,
      pricing_type: 'fixed',
      base_price: 45.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '📜',
      color: '#dc2626',
      sort_order: 33,
      internal_notes: 'Billed $45/quarter. 10-year term. Lowest per-quarter rate.',
    },
    {
      service_key: 'termite_bond_5yr',
      name: 'Termite Bond (5-Year Term)',
      short_name: 'Bond 5yr',
      description: 'Quarterly-billed termite warranty bond with 5-year term. Includes annual inspection and re-treatment coverage.',
      category: 'termite',
      billing_type: 'recurring',
      frequency: 'quarterly',
      visits_per_year: 4,
      default_duration_minutes: 30,
      min_duration_minutes: 20,
      max_duration_minutes: 60,
      pricing_type: 'fixed',
      base_price: 54.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '📜',
      color: '#dc2626',
      sort_order: 34,
      internal_notes: 'Billed $54/quarter. 5-year term.',
    },
    {
      service_key: 'termite_bond_1yr',
      name: 'Termite Bond (1-Year Term)',
      short_name: 'Bond 1yr',
      description: 'Quarterly-billed termite warranty bond with 1-year term. Includes annual inspection and re-treatment coverage.',
      category: 'termite',
      billing_type: 'recurring',
      frequency: 'quarterly',
      visits_per_year: 4,
      default_duration_minutes: 30,
      min_duration_minutes: 20,
      max_duration_minutes: 60,
      pricing_type: 'fixed',
      base_price: 60.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '📜',
      color: '#dc2626',
      sort_order: 35,
      internal_notes: 'Billed $60/quarter. 1-year term. Highest per-quarter rate.',
    },

    // ============================================================
    // TERMITE — monitoring & active bait stations
    // ============================================================
    {
      service_key: 'termite_monitoring',
      name: 'Termite Monitoring Service',
      short_name: 'Termite Monitor',
      description: 'Quarterly inspection of in-ground monitoring stations for termite activity. No active bait — detection only.',
      category: 'termite',
      billing_type: 'recurring',
      frequency: 'quarterly',
      visits_per_year: 4,
      default_duration_minutes: 45,
      min_duration_minutes: 30,
      max_duration_minutes: 60,
      pricing_type: 'fixed',
      base_price: 99.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🔍',
      color: '#dc2626',
      sort_order: 36,
    },
    {
      service_key: 'termite_active_annual',
      name: 'Termite Active Annual Bait Station Service',
      short_name: 'Bait Annual',
      description: 'Annual servicing of active bait stations — inspect, replace spent cartridges, re-bait as needed.',
      category: 'termite',
      billing_type: 'recurring',
      frequency: 'annual',
      visits_per_year: 1,
      default_duration_minutes: 60,
      min_duration_minutes: 45,
      max_duration_minutes: 90,
      pricing_type: 'fixed',
      base_price: 199.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🪤',
      color: '#dc2626',
      sort_order: 37,
    },
    {
      service_key: 'termite_active_bait_quarterly',
      name: 'Termite Active Bait Station Service (Quarterly)',
      short_name: 'Bait Quarterly',
      description: 'Quarterly servicing of active in-ground bait stations. Includes inspection, cartridge checks, and activity monitoring.',
      category: 'termite',
      billing_type: 'recurring',
      frequency: 'quarterly',
      visits_per_year: 4,
      default_duration_minutes: 45,
      min_duration_minutes: 30,
      max_duration_minutes: 60,
      pricing_type: 'variable',
      base_price: 75.00,
      price_range_min: 55.00,
      price_range_max: 150.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🪤',
      color: '#dc2626',
      sort_order: 38,
    },

    // ============================================================
    // TERMITE — one-time treatments & setup
    // ============================================================
    {
      service_key: 'termite_installation_setup',
      name: 'Termite Installation Setup',
      short_name: 'Term Install',
      description: 'Initial installation of in-ground bait station system. Includes station placement, mapping, and initial baiting.',
      category: 'termite',
      billing_type: 'one_time',
      default_duration_minutes: 240,
      min_duration_minutes: 120,
      max_duration_minutes: 480,
      pricing_type: 'variable',
      base_price: 800.00,
      price_range_min: 500.00,
      price_range_max: 2500.00,
      pricing_model_key: 'linear_ft',
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 3,
      icon: '🪤',
      color: '#dc2626',
      sort_order: 39,
      typical_materials_cost: 300.00,
      internal_notes: 'One-time setup cost. Customer then moves to recurring monitoring or active bait service.',
    },
    {
      service_key: 'termite_pretreatment',
      name: 'Termite Pretreatment Service',
      short_name: 'Pre-Treat',
      description: 'Pre-construction termite treatment for new builds. Applied to soil before slab pour or framing, per FL Building Code requirements.',
      category: 'termite',
      billing_type: 'one_time',
      default_duration_minutes: 120,
      min_duration_minutes: 60,
      max_duration_minutes: 240,
      pricing_type: 'variable',
      base_price: 600.00,
      price_range_min: 350.00,
      price_range_max: 1500.00,
      pricing_model_key: 'sqft_structure',
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 3,
      icon: '🏗️',
      color: '#dc2626',
      sort_order: 39,
      default_products: JSON.stringify(['Termidor SC', 'Bora-Care']),
      internal_notes: 'Coordinate with builder for timing. Must be applied before slab pour.',
    },
    {
      service_key: 'termite_trenching',
      name: 'Termite Trenching Service',
      short_name: 'Trench',
      description: 'Perimeter trench treatment around existing foundation. Liquid termiticide applied to trench and backfilled.',
      category: 'termite',
      billing_type: 'one_time',
      default_duration_minutes: 180,
      min_duration_minutes: 120,
      max_duration_minutes: 360,
      pricing_type: 'variable',
      base_price: 900.00,
      price_range_min: 600.00,
      price_range_max: 2500.00,
      pricing_model_key: 'linear_ft',
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 3,
      icon: '🪵',
      color: '#dc2626',
      sort_order: 39,
      default_products: JSON.stringify(['Termidor SC', 'Taurus SC']),
      typical_materials_cost: 150.00,
    },
    {
      service_key: 'termite_cartridge_replacement',
      name: 'Termite Bait Station Cartridge Replacement',
      short_name: 'Cartridge Repl',
      description: 'Individual bait cartridge replacement for active bait stations. Billed per cartridge.',
      category: 'termite',
      billing_type: 'one_time',
      default_duration_minutes: 15,
      min_duration_minutes: 10,
      max_duration_minutes: 30,
      pricing_type: 'fixed',
      base_price: 20.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🔄',
      color: '#dc2626',
      sort_order: 39,
      internal_notes: 'Priced per cartridge at $20/ea. Often done during monitoring visits.',
    },
    {
      service_key: 'termite_slab_pretreat',
      name: 'Slab Pre-Treat Termite Service',
      short_name: 'Slab Pre-Treat',
      description: 'Pre-slab termiticide application using Termidor for new construction. Applied directly to prepared soil before concrete pour.',
      category: 'termite',
      billing_type: 'one_time',
      default_duration_minutes: 120,
      min_duration_minutes: 60,
      max_duration_minutes: 240,
      pricing_type: 'variable',
      base_price: 500.00,
      price_range_min: 300.00,
      price_range_max: 1200.00,
      pricing_model_key: 'sqft_structure',
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 3,
      icon: '🏗️',
      color: '#dc2626',
      sort_order: 39,
      default_products: JSON.stringify(['Termidor SC']),
      internal_notes: 'Separate from general pretreatment — this is specifically the slab-only application.',
    },
    {
      service_key: 'termite_spot_treatment',
      name: 'Termite Spot Treatment Service',
      short_name: 'Spot Treat',
      description: 'Localized termite treatment for isolated infestations — foam injection, drill & treat, or localized liquid application.',
      category: 'termite',
      billing_type: 'one_time',
      default_duration_minutes: 90,
      min_duration_minutes: 45,
      max_duration_minutes: 180,
      pricing_type: 'variable',
      base_price: 350.00,
      price_range_min: 200.00,
      price_range_max: 800.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🪵',
      color: '#dc2626',
      sort_order: 39,
      default_products: JSON.stringify(['Termidor Foam', 'Bora-Care']),
    },

    // ============================================================
    // TREE & SHRUB — 6-week cycle
    // ============================================================
    {
      service_key: 'tree_shrub_6week',
      name: 'Tree & Shrub Care (Every 6 Weeks)',
      short_name: 'T&S 6-Week',
      description: 'Enhanced tree and shrub care on a 6-week rotation — 9 visits/year for higher-maintenance landscapes requiring tighter spray intervals.',
      category: 'tree_shrub',
      billing_type: 'recurring',
      frequency: 'every_6_weeks',
      visits_per_year: 9,
      default_duration_minutes: 45,
      min_duration_minutes: 30,
      max_duration_minutes: 75,
      pricing_type: 'variable',
      base_price: 55.00,
      price_range_min: 45.00,
      price_range_max: 150.00,
      pricing_model_key: 'bed_sqft',
      is_waveguard: true,
      is_taxable: true,
      tax_service_key: 'lawn_care',
      requires_license: true,
      license_category: 'L&O',
      icon: '🌳',
      color: '#059669',
      sort_order: 52,
    },

    // ============================================================
    // WAVEGUARD — onboarding setup
    // ============================================================
    {
      service_key: 'waveguard_initial_setup',
      name: 'WaveGuard Initial Setup',
      short_name: 'WG Setup',
      description: 'One-time onboarding service for new WaveGuard members. Includes comprehensive property inspection, initial treatments, and system setup.',
      category: 'specialty',
      billing_type: 'one_time',
      default_duration_minutes: 120,
      min_duration_minutes: 60,
      max_duration_minutes: 180,
      pricing_type: 'variable',
      base_price: 199.00,
      price_range_min: 149.00,
      price_range_max: 399.00,
      is_waveguard: true,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🛡️',
      color: '#0ea5e9',
      sort_order: 1,
      internal_notes: 'Billed once at membership start. Covers initial cleanout + property assessment + baseline documentation.',
    },

    // ============================================================
    // GENERAL — catch-all booking appointment
    // ============================================================
    {
      service_key: 'general_appointment',
      name: 'Waves Pest Control Appointment',
      short_name: 'Appointment',
      description: 'General appointment placeholder for bookings that do not yet have a specific service type assigned.',
      category: 'specialty',
      billing_type: 'one_time',
      default_duration_minutes: 60,
      min_duration_minutes: 30,
      max_duration_minutes: 120,
      pricing_type: 'variable',
      is_taxable: true,
      tax_service_key: 'pest_control',
      customer_visible: true,
      booking_enabled: true,
      icon: '📅',
      color: '#64748b',
      sort_order: 200,
      internal_notes: 'Catch-all booking type. Assign proper service_key after initial assessment.',
    },
  ];

  // Only insert services that don't already exist (safe for re-runs)
  for (const svc of services) {
    const exists = await knex('services').where('service_key', svc.service_key).first();
    if (!exists) {
      await knex('services').insert(svc);
    }
  }

  // ============================================================
  // BACKFILL: match existing service_records / scheduled_services
  // that reference these new service types by name
  // ============================================================
  const svcRows = await knex('services').select('id', 'service_key');
  const svcMap = {};
  svcRows.forEach(r => { svcMap[r.service_key] = r.id; });

  const backfillMap = {
    // Pest frequencies
    'Semiannual Pest': svcMap.pest_general_semiannual,
    'Bi-Monthly Pest': svcMap.pest_general_bimonthly,
    // Specialty
    'Tick Control': svcMap.tick_control,
    'Tick Treatment': svcMap.tick_control,
    'Mud Dauber': svcMap.mud_dauber_removal,
    'Wildlife': svcMap.wildlife_trapping,
    // Rodent variants
    'Rodent Trapping & Sanitation': svcMap.rodent_trapping_sanitation,
    'Rodent Trapping, Exclusion & Sanitation': svcMap.rodent_trapping_exclusion_sanitation,
    'Rodent Trapping Service': svcMap.rodent_trapping,
    'Rodent Exclusion Service': svcMap.rodent_exclusion_only,
    'Rodent Pest Control': svcMap.rodent_general_one_time,
    // Termite bonds
    'Termite Bond (10': svcMap.termite_bond_10yr,
    'Termite Bond (5': svcMap.termite_bond_5yr,
    'Termite Bond (1': svcMap.termite_bond_1yr,
    // Termite services
    'Termite Monitoring': svcMap.termite_monitoring,
    'Termite Active Annual': svcMap.termite_active_annual,
    'Termite Active Bait': svcMap.termite_active_bait_quarterly,
    'Termite Installation': svcMap.termite_installation_setup,
    'Termite Pretreatment': svcMap.termite_pretreatment,
    'Termite Trenching': svcMap.termite_trenching,
    'Cartridge Replacement': svcMap.termite_cartridge_replacement,
    'Slab Pre-Treat': svcMap.termite_slab_pretreat,
    'Termite Spot': svcMap.termite_spot_treatment,
    // Tree & shrub
    'Every 6 Weeks Tree': svcMap.tree_shrub_6week,
    '6 Week Tree': svcMap.tree_shrub_6week,
    // WaveGuard setup
    'WaveGuard Initial': svcMap.waveguard_initial_setup,
    'WaveGuard Setup': svcMap.waveguard_initial_setup,
  };

  const srHasCol = await knex.schema.hasColumn('service_records', 'service_id');
  const ssHasCol = await knex.schema.hasColumn('scheduled_services', 'service_id');

  for (const [pattern, serviceId] of Object.entries(backfillMap)) {
    if (!serviceId) continue;

    if (srHasCol) {
      await knex('service_records')
        .whereNull('service_id')
        .where('service_type', 'ilike', `%${pattern}%`)
        .update({ service_id: serviceId });
    }

    if (ssHasCol) {
      await knex('scheduled_services')
        .whereNull('service_id')
        .where('service_type', 'ilike', `%${pattern}%`)
        .update({ service_id: serviceId });
    }
  }
};

exports.down = async function (knex) {
  const keysToRemove = [
    'pest_general_semiannual', 'pest_general_bimonthly',
    'tick_control', 'mud_dauber_removal', 'wildlife_trapping',
    'rodent_trapping', 'rodent_exclusion_only', 'rodent_trapping_sanitation',
    'rodent_trapping_exclusion_sanitation', 'rodent_general_one_time',
    'termite_bond_10yr', 'termite_bond_5yr', 'termite_bond_1yr',
    'termite_monitoring', 'termite_active_annual', 'termite_active_bait_quarterly',
    'termite_installation_setup', 'termite_pretreatment', 'termite_trenching',
    'termite_cartridge_replacement', 'termite_slab_pretreat', 'termite_spot_treatment',
    'tree_shrub_6week',
    'waveguard_initial_setup',
    'general_appointment',
  ];

  // Null out FKs pointing to these services before deleting
  const ids = await knex('services').whereIn('service_key', keysToRemove).pluck('id');

  if (ids.length > 0) {
    const srHas = await knex.schema.hasColumn('service_records', 'service_id');
    if (srHas) {
      await knex('service_records').whereIn('service_id', ids).update({ service_id: null });
    }
    const ssHas = await knex.schema.hasColumn('scheduled_services', 'service_id');
    if (ssHas) {
      await knex('scheduled_services').whereIn('service_id', ids).update({ service_id: null });
    }
  }

  await knex('services').whereIn('service_key', keysToRemove).del();
};
