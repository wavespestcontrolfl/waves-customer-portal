/**
 * Versioned lawn protocol operating layer.
 *
 * This is intentionally separate from protocol_templates. Those templates
 * support deterministic one-tap completions. Lawn protocols are seasonal and
 * conditional: legal gates, cultivar gates, calibration, inventory, and
 * assessment context all change the final field plan.
 */

exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (!(await knex.schema.hasTable('lawn_protocols'))) {
    await knex.schema.createTable('lawn_protocols', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('protocol_key', 100).notNullable();
      t.string('version', 40).notNullable();
      t.string('name', 180).notNullable();
      t.string('region', 80).notNullable().defaultTo('swfl');
      t.string('grass_track', 80).notNullable().defaultTo('st_augustine');
      t.string('status', 20).notNullable().defaultTo('draft');
      t.date('effective_from');
      t.date('effective_to');
      t.text('operating_sentence');
      t.jsonb('default_carriers').notNullable().defaultTo('{}');
      t.jsonb('production_rules').notNullable().defaultTo('{}');
      t.jsonb('required_profile_fields').notNullable().defaultTo('[]');
      t.jsonb('source_refs').notNullable().defaultTo('[]');
      t.timestamps(true, true);

      t.unique(['protocol_key', 'version']);
      t.index(['status', 'grass_track']);
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS lawn_protocols_one_active_key_idx
    ON lawn_protocols (protocol_key)
    WHERE status = 'active'
  `);

  if (!(await knex.schema.hasTable('lawn_protocol_windows'))) {
    await knex.schema.createTable('lawn_protocol_windows', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('lawn_protocol_id').notNullable()
        .references('id').inTable('lawn_protocols').onDelete('CASCADE');
      t.integer('month').notNullable();
      t.string('window_key', 80).notNullable();
      t.string('title', 160).notNullable();
      t.string('visit_type', 80).notNullable();
      t.text('goal');
      t.decimal('default_carrier_gal_per_1000', 6, 3);
      t.string('production_mode', 80).notNullable().defaultTo('main_reel_plus_spot_backpack');
      t.jsonb('main_tank').notNullable().defaultTo('{}');
      t.jsonb('spot_work').notNullable().defaultTo('[]');
      t.jsonb('required_tasks').notNullable().defaultTo('[]');
      t.jsonb('conditional_triggers').notNullable().defaultTo('[]');
      t.jsonb('customer_note_templates').notNullable().defaultTo('[]');
      t.jsonb('service_report_context').notNullable().defaultTo('{}');
      t.jsonb('assessment_bridge').notNullable().defaultTo('{}');
      t.jsonb('inventory_bridge').notNullable().defaultTo('{}');
      t.jsonb('wiki_refs').notNullable().defaultTo('[]');
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamps(true, true);

      t.unique(['lawn_protocol_id', 'window_key']);
      t.index(['lawn_protocol_id', 'month']);
    });
  }

  if (!(await knex.schema.hasTable('lawn_protocol_products'))) {
    await knex.schema.createTable('lawn_protocol_products', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('lawn_protocol_window_id').notNullable()
        .references('id').inTable('lawn_protocol_windows').onDelete('CASCADE');
      t.uuid('product_id').nullable().references('id').inTable('products_catalog').onDelete('SET NULL');
      t.string('product_name', 180).notNullable();
      t.string('role', 60).notNullable();
      t.string('application_mode', 60).notNullable().defaultTo('broadcast');
      t.decimal('rate_per_1000', 10, 4);
      t.string('rate_unit', 30);
      t.decimal('carrier_gal_per_1000', 6, 3);
      t.boolean('default_in_plan').notNullable().defaultTo(true);
      t.jsonb('gates').notNullable().defaultTo('{}');
      t.jsonb('annual_counter').notNullable().defaultTo('{}');
      t.jsonb('mixing').notNullable().defaultTo('{}');
      t.jsonb('report_copy').notNullable().defaultTo('{}');
      t.integer('sort_order').notNullable().defaultTo(0);
      t.timestamps(true, true);

      t.index(['lawn_protocol_window_id', 'role']);
      t.index('product_id');
    });
  }

  if (!(await knex.schema.hasTable('lawn_protocol_gates'))) {
    await knex.schema.createTable('lawn_protocol_gates', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('lawn_protocol_id').notNullable()
        .references('id').inTable('lawn_protocols').onDelete('CASCADE');
      t.string('gate_key', 100).notNullable();
      t.string('gate_type', 60).notNullable();
      t.string('severity', 20).notNullable().defaultTo('block');
      t.string('title', 180).notNullable();
      t.text('rule_text').notNullable();
      t.jsonb('logic').notNullable().defaultTo('{}');
      t.jsonb('wiki_refs').notNullable().defaultTo('[]');
      t.timestamps(true, true);

      t.unique(['lawn_protocol_id', 'gate_key']);
      t.index(['lawn_protocol_id', 'gate_type']);
    });
  }

  const turfCols = await knex('customer_turf_profiles').columnInfo().catch(() => ({}));
  if (Object.keys(turfCols).length) {
    await knex.schema.alterTable('customer_turf_profiles', (t) => {
      if (!turfCols.ordinance_zone) t.string('ordinance_zone', 40);
      if (!turfCols.irrigation_status) t.string('irrigation_status', 40);
      if (!turfCols.soil_k_ppm) t.decimal('soil_k_ppm', 8, 2);
      if (!turfCols.thatch_measurement_in) t.decimal('thatch_measurement_in', 5, 2);
      if (!turfCols.nematode_assay_flag) t.boolean('nematode_assay_flag').notNullable().defaultTo(false);
      if (!turfCols.large_patch_history) t.boolean('large_patch_history').notNullable().defaultTo(false);
      if (!turfCols.last_thatch_checked_at) t.date('last_thatch_checked_at');
      if (!turfCols.last_chinch_checked_at) t.date('last_chinch_checked_at');
    });
  }

  await seedProtocol(knex);

  await knex('equipment_systems')
    .where(function () {
      this.where({ name: 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun' })
        .orWhere({ name: '110-Gallon Spray Tank #2' });
    })
    .update({
      notes: 'Tank #2 electric 12V HP lawn-gun rig. Udor KAPPA-18/12V-HP pump/motor assembly; North Port / blackout / sensitive turf route — 0-N / 0-P mixes, micros, K when soil-test gated, wetting agents. Avoid N/P fertilizer during restricted windows.',
      updated_at: new Date(),
    })
    .catch(() => {});
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('lawn_protocol_products');
  await knex.schema.dropTableIfExists('lawn_protocol_windows');
  await knex.schema.dropTableIfExists('lawn_protocol_gates');
  await knex.raw('DROP INDEX IF EXISTS lawn_protocols_one_active_key_idx');
  await knex.schema.dropTableIfExists('lawn_protocols');

  const turfCols = await knex('customer_turf_profiles').columnInfo().catch(() => ({}));
  if (Object.keys(turfCols).length) {
    await knex.schema.alterTable('customer_turf_profiles', (t) => {
      for (const col of [
        'last_chinch_checked_at',
        'last_thatch_checked_at',
        'large_patch_history',
        'nematode_assay_flag',
        'thatch_measurement_in',
        'soil_k_ppm',
        'irrigation_status',
        'ordinance_zone',
      ]) {
        if (turfCols[col]) t.dropColumn(col);
      }
    });
  }
};

async function seedProtocol(knex) {
  const existing = await knex('lawn_protocols')
    .where({ protocol_key: 'swfl_st_augustine_10_10', version: '2026.05' })
    .first();
  if (existing) return;

  const [protocol] = await knex('lawn_protocols').insert({
    protocol_key: 'swfl_st_augustine_10_10',
    version: '2026.05',
    name: '10/10 SWFL St. Augustine Lawn Protocol',
    region: 'swfl',
    grass_track: 'st_augustine',
    status: 'active',
    effective_from: '2026-01-01',
    operating_sentence: 'Every stop must be legal by city, safe for the St. Augustine cultivar, justified by season/scouting, completed in one production mode, and documented with product, rate, carrier volume, target pest/nutrient, and customer-facing note.',
    default_carriers: JSON.stringify({
      routine: 1,
      insecticide: 2,
      fungicide: 2,
      hydretain: 2,
      heavy_soil_targeted: 3,
    }),
    production_rules: JSON.stringify({
      default: 'liquid_first_one_main_pass',
      noSameVisitSpreaderAndHondaRig: true,
      granularRestorationSeparateVisit: true,
      tankRoles: {
        tank1: 'standard N-allowed route',
        tank2: 'North Port / blackout / sensitive 0-N / 0-P route',
        backpack: 'spot work only',
      },
    }),
    required_profile_fields: JSON.stringify([
      'grass_type',
      'cultivar',
      'ordinance_zone',
      'lawn_sqft',
      'irrigation_status',
      'soil_test_date',
      'soil_k_ppm',
    ]),
    source_refs: JSON.stringify(['Sarasota ordinance', 'North Port ordinance', 'Manatee ordinance', 'EPA labels', 'UF/IFAS']),
  }).returning('*');

  const windows = [
    windowRow(1, 'jan_pre_m_split_1', 'January Pre-M Split 1 + Diagnostics', 'liquid_production_plus_spots', 1, 'Stop crabgrass/summer annuals before germination; identify problem lawns; avoid winter N push.', ['pre_emergent_water_in_note', 'new_account_soil_sample', 'chronic_decline_nematode_flag']),
    windowRow(2, 'feb_controlled_greenup', 'February Controlled Green-Up + Irrigation Audit', 'liquid_nutrition', 1, 'Controlled color without overdriving St. Augustine.', ['irrigation_audit', 'probe_3_inches', 'fungicide_only_if_active_or_history']),
    windowRow(3, 'mar_pre_m_split_2', 'March Pre-M Split 2 + Final North Port N', 'liquid_production', 1, 'Finish spring pre-M, final North Port N before April 1, baseline chinch/thatch.', ['chinch_baseline', 'thatch_measurement', 'north_port_final_spring_n']),
    windowRow(4, 'apr_insect_preventive', 'April Chinch/Webworm Preventive + Stress Hardening', 'liquid_production', 2, 'Prevent chinch/webworm blowups before summer; avoid illegal North Port N/P.', ['speedzone_cultivar_gate', 'premium_pgr_gate', 'north_port_zero_np']),
    windowRow(5, 'may_final_n_or_zero_np', 'May Final Sarasota/Manatee N + North Port 0-N Route', 'two_tank_liquid_routing', 1, 'Final legal N before June blackout for Sarasota/Venice/Manatee; no N/P in North Port.', ['route_by_ordinance_zone', 'hydretain_premium_route']),
    windowRow(6, 'jun_blackout_stress', 'June Blackout Stress Program + Chinch Float Test #1', 'blackout_liquid_production', 1, 'Color, stress tolerance, pest scouting; no N/P.', ['chinch_float_test', 'irrigation_audit', 'blackout_zero_np']),
    windowRow(7, 'jul_blackout_survival', 'July Blackout Survival, Not Growth', 'blackout_liquid_production_plus_spots', 1, 'Protect turf through heat, keep N/P out, avoid herbicide injury.', ['remove_6_0_0', 'heat_stress_herbicide_gate', 'chinch_webworm_recheck']),
    windowRow(8, 'aug_scout_month', 'August Scout Month, Low Product', 'scout_first', null, 'Catch failures before they become cancellations.', ['required_10_minute_inspection', 'photos_for_problem_areas', 'premium_only_liquid']),
    windowRow(9, 'sep_blackout_closeout', 'September Blackout Closeout + Fall Disease Mapping', 'blackout_liquid_or_scout', 1, 'Keep turf alive, avoid late-summer injury, prepare October recovery.', ['large_patch_mapping', 'speedzone_not_automatic', 'sedge_spot_only']),
    windowRow(10, 'oct_recovery_fall_pre_m', 'October Recovery + Large Patch Prevention + Fall Pre-M', 'liquid_production_plus_disease_route', 1, 'Recovery without triggering large patch; start winter weed prevention.', ['fall_pre_m_timing', 'large_patch_prevention_candidates', 'thatch_measurement']),
    windowRow(11, 'nov_winter_weeds_k_mg_mn', 'November Winter Weed Control + K/Mg/Mn', 'liquid_production', 1, 'Winter weed prevention/correction without forcing growth.', ['atrazine_weather_gate', 'fall_pre_m_if_missed', 'liquid_k_mn_logic']),
    windowRow(12, 'dec_winter_wellness', 'December Winter Wellness + Annual Report', 'scout_touchpoint', null, 'Retention, documentation, winter color without growth push.', ['annual_customer_report', 'winter_irrigation_check', 'atrazine_backup_if_nov_too_warm']),
  ];

  const insertedWindows = {};
  for (const row of windows) {
    const [inserted] = await knex('lawn_protocol_windows').insert({
      lawn_protocol_id: protocol.id,
      ...row,
    }).returning('*');
    insertedWindows[row.window_key] = inserted;
  }

  const productRows = [
    product('jan_pre_m_split_1', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    product('jan_pre_m_split_1', 'Celsius WG', 'post_emergent_spot', 0.057, 'oz', 1, false, { annualCounter: 'celsius_oz_per_1000', stressGate: true }),
    product('feb_controlled_greenup', 'Liquid SRN', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.35-0.50 lb N/1000', blackoutSensitive: true }),
    product('mar_pre_m_split_2', 'Prodiamine 65 WDG', 'pre_emergent', 0.30, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    product('mar_pre_m_split_2', 'Liquid SRN', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.50-0.75 lb N/1000', northPortFinalBefore: '04-01' }),
    product('apr_insect_preventive', 'Acelepryn Xtra', 'insect_preventive', 0.46, 'fl oz', 2, true, {}),
    product('apr_insect_preventive', '0-0-25 K', 'potassium', null, 'lb_k2o', 2, false, { soilKGatePpmBelow: 80 }),
    product('may_final_n_or_zero_np', 'Liquid SRN', 'nutrition', null, 'lb_n', 1, true, { blockInOrdinanceZones: ['north_port'] }),
    product('jun_blackout_stress', 'Fe/Mn Micros', 'micronutrients', null, 'label_rate', 1, true, { requiresZeroNP: true }),
    product('jun_blackout_stress', 'Talstar P', 'insect_curative', 1.0, 'fl oz', 2, false, { trigger: 'confirmed_chinch_pressure' }),
    product('jul_blackout_survival', 'Dispatch Sprayable', 'wetting_agent', 0.37, 'fl oz', 1, false, { requiresZeroNP: true }),
    product('jul_blackout_survival', 'Arena 50 WDG', 'insect_rescue', 0.29, 'oz', 2, false, { trigger: 'talstar_failure_or_webworm_pressure' }),
    product('oct_recovery_fall_pre_m', 'Liquid SRN', 'nutrition', null, 'lb_n', 1, true, { targetN: '0.50 lb N/1000', diseasePressureGate: true }),
    product('oct_recovery_fall_pre_m', 'Prodiamine 65 WDG', 'fall_pre_emergent', 0.20, 'oz', 1, true, { annualCounter: 'prodiamine_oz_per_1000' }),
    product('oct_recovery_fall_pre_m', 'Velista', 'fungicide', 0.50, 'oz', 2, false, { frac: '7', trigger: 'large_patch_history' }),
    product('nov_winter_weeds_k_mg_mn', 'Atrazine 4L', 'post_emergent', 0.75, 'fl oz', 1, false, { annualCounter: 'atrazine_apps', maxTempF: 85 }),
    product('nov_winter_weeds_k_mg_mn', 'Prodiamine 65 WDG', 'fall_pre_emergent', 0.20, 'oz', 1, false, { trigger: 'fall_pre_m_missed' }),
    product('dec_winter_wellness', 'Atrazine 4L', 'post_emergent_backup', 0.75, 'fl oz', 1, false, { annualCounter: 'atrazine_apps', maxTempF: 85 }),
  ];

  const catalog = await knex('products_catalog').select('id', 'name').catch(() => []);
  for (const row of productRows) {
    const matched = catalog.find((p) => normalize(p.name).includes(normalize(row.product_name)) || normalize(row.product_name).includes(normalize(p.name)));
    const { window_key: _windowKey, ...insertRow } = row;
    await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: insertedWindows[row.window_key].id,
      product_id: matched?.id || null,
      ...insertRow,
      gates: JSON.stringify(row.gates || {}),
      annual_counter: JSON.stringify(row.annual_counter || {}),
      mixing: JSON.stringify(row.mixing || {}),
      report_copy: JSON.stringify(row.report_copy || {}),
    });
  }

  const gates = [
    gate('sarasota_blackout', 'ordinance', 'block', 'Sarasota/Venice fertilizer blackout', 'No turf fertilizer containing N or P June 1-Sept. 30; outside blackout, require applicable slow-release N rules.', { ordinanceZone: 'sarasota', start: '06-01', end: '09-30', blocksN: true, blocksP: true }),
    gate('north_port_blackout', 'ordinance', 'block', 'North Port fertilizer blackout', 'No N or P fertilizer on turf April 1-Sept. 30. March is the final spring N app.', { ordinanceZone: 'north_port', start: '04-01', end: '09-30', blocksN: true, blocksP: true }),
    gate('manatee_blackout', 'ordinance', 'block', 'Manatee/Parrish fertilizer blackout', 'No N June 1-Sept. 30; P requires soil-test deficiency support year-round.', { ordinanceZone: 'manatee', start: '06-01', end: '09-30', blocksN: true, pRequiresSoilTest: true }),
    gate('speedzone_cultivar_gate', 'cultivar', 'block', 'SpeedZone cultivar gate', 'Do not apply SpeedZone to Floratam, Bitterblue, or unknown/high-risk St. Augustine.', { blockedCultivars: ['floratam', 'bitterblue', 'unknown'], product: 'SpeedZone' }),
    gate('celsius_annual_rate', 'annual_counter', 'block', 'Celsius annual rate tracking', 'Track total Celsius WG per 365 days; block when annual maximum would be exceeded.', { counter: 'celsius_oz_per_1000', annualMax: 0.17 }),
    gate('valid_calibration_required', 'equipment', 'block', 'Valid calibration required', 'Main-rig and backpack plans require active, unexpired calibration for carrier and tank math.', { requiresActiveCalibration: true }),
  ];
  for (const row of gates) {
    await knex('lawn_protocol_gates').insert({
      lawn_protocol_id: protocol.id,
      ...row,
      logic: JSON.stringify(row.logic || {}),
      wiki_refs: JSON.stringify(row.wiki_refs || []),
    });
  }
}

function windowRow(month, windowKey, title, visitType, carrier, goal, tasks) {
  return {
    month,
    window_key: windowKey,
    title,
    visit_type: visitType,
    goal,
    default_carrier_gal_per_1000: carrier,
    production_mode: carrier ? 'main_reel_plus_spot_backpack' : 'scout_or_premium_route',
    main_tank: JSON.stringify({ carrierGalPer1000: carrier, tankSizeGal: 110 }),
    spot_work: JSON.stringify([{ equipment: 'FlowZone', mode: 'spot_only' }]),
    required_tasks: JSON.stringify(tasks),
    conditional_triggers: JSON.stringify([]),
    customer_note_templates: JSON.stringify([`${title}: service completed according to the seasonal St. Augustine protocol and local ordinance gates.`]),
    service_report_context: JSON.stringify({ title, goal, complianceSummary: true, includeProducts: true, includeScouting: true }),
    assessment_bridge: JSON.stringify({ writeExpectedWindow: true, writeWatchItems: true, requiredTasks: tasks }),
    inventory_bridge: JSON.stringify({ forecastProducts: true, deductActualsOnCompletion: true }),
    wiki_refs: JSON.stringify(tasks.map((task) => `protocols/lawn/${task}`)),
    sort_order: month,
  };
}

function product(windowKey, productName, role, rate, unit, carrier, defaultInPlan, gates = {}) {
  return {
    window_key: windowKey,
    product_name: productName,
    role,
    application_mode: role.includes('spot') ? 'spot' : 'broadcast',
    rate_per_1000: rate,
    rate_unit: unit,
    carrier_gal_per_1000: carrier,
    default_in_plan: defaultInPlan,
    gates,
    annual_counter: gates.annualCounter ? { counter: gates.annualCounter } : {},
    mixing: {},
    report_copy: { role },
  };
}

function gate(gateKey, gateType, severity, title, ruleText, logic, wikiRefs = []) {
  return {
    gate_key: gateKey,
    gate_type: gateType,
    severity,
    title,
    rule_text: ruleText,
    logic,
    wiki_refs: wikiRefs,
  };
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
