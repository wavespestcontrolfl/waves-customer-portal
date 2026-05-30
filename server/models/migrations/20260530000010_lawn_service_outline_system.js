const CONTENT_MODULES = [
  {
    key: 'lawn_program_overview',
    title: 'Lawn program overview',
    audience: 'estimate_packet',
    plain_text: 'Waves lawn care is a documented turf health program built around grass type, seasonal timing, lawn assessment, product accountability, and clear post-service reporting.',
  },
  {
    key: 'assessment_protocol',
    title: 'Assessment protocol',
    audience: 'estimate_packet',
    plain_text: 'Each visit starts with assessment. We check turf color, density, thinning, weed pressure, sedge or grassy weed breakthrough, insect pressure, disease indicators, irrigation coverage, heat or drought stress, mowing stress, thatch indicators, shade stress, and improvement or decline since the prior visit.',
  },
  {
    key: 'st_augustine_protocol_summary',
    title: 'St. Augustine protocol summary',
    audience: 'estimate_packet',
    plain_text: 'St. Augustine is managed as one core turf program, then adjusted based on site conditions such as shade, irrigation coverage, heat stress, disease pressure, and herbicide safety.',
  },
  {
    key: 'bermuda_protocol_summary',
    title: 'Bermuda protocol summary',
    audience: 'estimate_packet',
    plain_text: 'Bermuda can produce dense, durable turf, but it requires active management. We track growth response, insect pressure, disease risk, weed pressure, and winter dormancy expectations.',
  },
  {
    key: 'zoysia_protocol_summary',
    title: 'Zoysia protocol summary',
    audience: 'estimate_packet',
    plain_text: 'Zoysia is managed conservatively because too much fertility or growth stimulation can increase thatch and disease pressure.',
  },
  {
    key: 'bahia_protocol_summary',
    title: 'Bahia protocol summary',
    audience: 'estimate_packet',
    plain_text: 'Bahia care is about realistic improvement, weed reduction, mole cricket monitoring, and expectation management - not forcing Bahia to behave like premium irrigated St. Augustine.',
  },
  {
    key: 'mixed_turf_summary',
    title: 'Mixed turf summary',
    audience: 'estimate_packet',
    plain_text: 'Mixed turf requires more careful treatment decisions because a product or approach that fits one area may not fit another.',
  },
  {
    key: 'unknown_turf_summary',
    title: 'Unknown turf summary',
    audience: 'estimate_packet',
    plain_text: 'We will confirm turf type and site conditions during the first visit before finalizing treatment decisions.',
  },
  {
    key: 'season_jan_mar',
    title: 'January-March seasonal focus',
    audience: 'estimate_packet',
    plain_text: 'Early-year visits focus on prevention and baseline observations: pre-emergent planning, early weed pressure control, soil samples where appropriate, spring green-up preparation, disease scouting, irrigation observations, and baseline turf condition notes.',
  },
  {
    key: 'season_apr_may',
    title: 'April-May seasonal focus',
    audience: 'estimate_packet',
    plain_text: 'Late spring is often focused on final spring nutrition decisions, iron and color support, weed and sedge checks, insect-pressure preparation, and getting the lawn ready for summer heat and local fertilizer restrictions.',
  },
  {
    key: 'season_jun_sep',
    title: 'June-September seasonal focus',
    audience: 'estimate_packet',
    plain_text: 'Summer service often shifts away from pushing growth and toward stress management, pest scouting, micronutrient support, moisture observations, and careful product selection.',
  },
  {
    key: 'season_oct_dec',
    title: 'October-December seasonal focus',
    audience: 'estimate_packet',
    plain_text: 'Fall and winter visits focus on recovery, disease prevention where risk supports it, winter hardening, dormancy expectations, thatch comparison, annual reporting, and wellness touchpoints.',
  },
  {
    key: 'product_transparency',
    title: 'Product transparency',
    audience: 'estimate_packet',
    plain_text: 'Some visits focus on weed control, some on pest monitoring, some on micronutrient or stress support, and some on observation. Product choices depend on turf type, season, weather, label directions, local rules, and what the lawn is showing at the time of service.',
  },
  {
    key: 'safety_and_label_compliance',
    title: 'Safety and label compliance',
    audience: 'estimate_packet',
    plain_text: 'When a pesticide product is used, it is applied according to label directions. EPA registration numbers are provided where applicable. Fertilizers, biostimulants, soil amendments, and support products may not have EPA registration numbers because they are not pesticide products.',
  },
  {
    key: 'local_fertilizer_rules',
    title: 'Local fertilizer rules',
    audience: 'estimate_packet',
    plain_text: 'Based on your service area, local fertilizer rules may affect whether nitrogen or phosphorus can be applied during certain months. When fertilizer is restricted, the visit may focus on inspection, weed or pest monitoring, micronutrients, iron, soil support, moisture observations, and stress management instead.',
  },
  {
    key: 'post_service_reports',
    title: 'Post-service reports',
    audience: 'estimate_packet',
    plain_text: 'You should not have to guess what happened after a visit. The estimate outline explains what may be used; the post-service report shows what was actually done.',
  },
  {
    key: 'gps_tracking',
    title: 'GPS-tracked service history',
    audience: 'estimate_packet',
    plain_text: 'GPS-tracked service history documents arrival and completion, supports accountability, and helps review service questions.',
  },
  {
    key: 'service_reminders',
    title: 'Service reminders',
    audience: 'estimate_packet',
    plain_text: 'Service reminders keep you informed before and after visits, including upcoming service, completion notices, report-ready messages, and follow-up items.',
  },
  {
    key: 'customer_portal',
    title: 'Customer portal',
    audience: 'estimate_packet',
    plain_text: 'The customer portal keeps service reports, invoices, upcoming visits, photos, recommendations, service history, and communication in one place.',
  },
  {
    key: 'what_this_does_not_include',
    title: 'What this does not include',
    audience: 'estimate_packet',
    plain_text: 'Lawn care treatments support turf health, weed control, pest monitoring, and seasonal improvement, but some issues require separate work or customer action. Irrigation repairs, mowing, sod, seed, topdressing, cultural repairs, and heavy shade corrections are separate unless specifically quoted.',
  },
  {
    key: 'estimate_cta',
    title: 'Estimate CTA',
    audience: 'estimate_packet',
    plain_text: 'Review your estimate when you are ready. The outline explains the program; the estimate shows the pricing and next steps.',
  },
  {
    key: 'service_report_actual_products',
    title: 'Actual products in service reports',
    audience: 'service_report',
    plain_text: 'Service reports show products actually applied during that visit, including EPA registration numbers and active ingredients where applicable.',
  },
];

async function addColumnIfMissing(knex, table, column, build) {
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => build(t));
}

exports.up = async function up(knex) {
  await knex.schema.createTable('lawn_service_content_modules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('key', 120).notNullable();
    t.string('title', 180).notNullable();
    t.string('audience', 40).notNullable().defaultTo('estimate_packet');
    t.jsonb('body_json').notNullable().defaultTo('{}');
    t.text('plain_text').notNullable();
    t.string('status', 30).notNullable().defaultTo('approved');
    t.integer('version').notNullable().defaultTo(1);
    t.timestamp('valid_from', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('valid_to', { useTz: true });
    t.uuid('approved_by').nullable();
    t.timestamp('approved_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('source_notes');
    t.timestamps(true, true);
    t.unique(['key', 'version'], 'lawn_service_content_modules_key_version_unique');
    t.index(['key', 'status'], 'idx_lawn_service_content_modules_key_status');
  });

  await knex.schema.createTable('jurisdiction_fertilizer_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('jurisdiction_id', 120).notNullable();
    t.string('jurisdiction_name', 160).notNullable();
    t.string('state', 20).notNullable().defaultTo('FL');
    t.string('county', 80);
    t.string('municipality', 120);
    t.integer('restricted_start_month');
    t.integer('restricted_start_day');
    t.integer('restricted_end_month');
    t.integer('restricted_end_day');
    t.boolean('nitrogen_restricted').notNullable().defaultTo(false);
    t.boolean('phosphorus_restricted').notNullable().defaultTo(false);
    t.boolean('phosphorus_soil_test_required').notNullable().defaultTo(false);
    t.integer('minimum_slow_release_nitrogen_percent');
    t.text('storm_event_restriction');
    t.text('waterway_buffer_rule');
    t.text('new_turf_exception');
    t.text('professional_certification_note');
    t.text('public_summary').notNullable();
    t.text('admin_summary');
    t.text('source_url');
    t.timestamp('source_verified_at', { useTz: true });
    t.string('status', 30).notNullable().defaultTo('approved');
    t.string('version', 40).notNullable().defaultTo('2026-05-30');
    t.timestamps(true, true);
    t.unique(['jurisdiction_id', 'version'], 'jurisdiction_fertilizer_rules_id_version_unique');
    t.index(['county', 'municipality'], 'idx_jurisdiction_fertilizer_rules_area');
  });

  await knex.schema.createTable('service_outline_packets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
    t.uuid('estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
    t.string('service_line', 60).notNullable().defaultTo('lawn_care');
    t.string('status', 30).notNullable().defaultTo('draft');
    t.text('title').notNullable();
    t.string('turf_type', 80);
    t.string('turf_confidence', 30);
    t.boolean('mixed_turf_flag').notNullable().defaultTo(false);
    t.string('protocol_track', 80);
    t.string('service_tier', 40);
    t.integer('month');
    t.string('season_band', 40);
    t.string('jurisdiction_id', 120);
    t.string('fertilizer_rule_version', 40);
    t.string('content_library_version', 40);
    t.string('protocol_version', 80);
    t.string('product_registry_version', 80);
    t.string('template_version', 40).notNullable().defaultTo('mvp-1');
    t.string('ai_model_version', 80);
    t.string('generation_mode', 30).notNullable().defaultTo('rules_only');
    t.jsonb('estimate_snapshot_json').notNullable().defaultTo('{}');
    t.jsonb('input_snapshot_json').notNullable().defaultTo('{}');
    t.jsonb('summary_json').notNullable().defaultTo('{}');
    t.jsonb('content_json').notNullable().defaultTo('{}');
    t.text('content_html');
    t.string('validation_status', 30).notNullable().defaultTo('warning');
    t.jsonb('validation_errors_json').notNullable().defaultTo('[]');
    t.jsonb('admin_warnings_json').notNullable().defaultTo('[]');
    t.string('token_hash', 128).unique();
    t.string('token_last_four', 12);
    t.timestamp('token_created_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('revoked_at', { useTz: true });
    t.boolean('noindex').notNullable().defaultTo(true);
    t.uuid('created_by').nullable();
    t.uuid('approved_by').nullable();
    t.timestamp('approved_at', { useTz: true });
    t.timestamp('sent_at', { useTz: true });
    t.string('sent_method', 30);
    t.timestamp('first_viewed_at', { useTz: true });
    t.timestamp('last_viewed_at', { useTz: true });
    t.integer('view_count').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['estimate_id', 'created_at'], 'idx_service_outline_packets_estimate_created');
    t.index(['status', 'created_at'], 'idx_service_outline_packets_status_created');
    t.index('token_hash', 'idx_service_outline_packets_token_hash');
  });

  await knex.schema.createTable('service_outline_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('packet_id').notNullable().references('id').inTable('service_outline_packets').onDelete('CASCADE');
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
    t.uuid('estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
    t.string('event_type', 60).notNullable();
    t.jsonb('metadata_json').notNullable().defaultTo('{}');
    t.string('actor_type', 30).notNullable().defaultTo('system');
    t.uuid('actor_id').nullable();
    t.string('ip_hash', 128);
    t.string('user_agent_hash', 128);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['packet_id', 'created_at'], 'idx_service_outline_events_packet_created');
    t.index(['estimate_id', 'created_at'], 'idx_service_outline_events_estimate_created');
  });

  await knex.schema.createTable('service_outline_packet_products', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('packet_id').notNullable().references('id').inTable('service_outline_packets').onDelete('CASCADE');
    t.uuid('product_id').nullable().references('id').inTable('products_catalog').onDelete('SET NULL');
    t.string('product_fact_version', 80);
    t.string('display_mode', 30).notNullable().defaultTo('category_only');
    t.text('relevance_reason');
    t.string('eligibility_status', 30).notNullable().defaultTo('warning');
    t.text('blocked_reason');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['packet_id'], 'idx_service_outline_packet_products_packet');
  });

  await knex.schema.createTable('packet_admin_edits', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('packet_id').notNullable().references('id').inTable('service_outline_packets').onDelete('CASCADE');
    t.uuid('edited_by').nullable();
    t.string('field_key', 120).notNullable();
    t.text('old_value');
    t.text('new_value');
    t.string('edit_type', 40).notNullable().defaultTo('customer_note');
    t.boolean('requires_approval').notNullable().defaultTo(false);
    t.uuid('approved_by').nullable();
    t.timestamp('approved_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['packet_id', 'created_at'], 'idx_packet_admin_edits_packet_created');
  });

  if (await knex.schema.hasTable('products_catalog')) {
    await addColumnIfMissing(knex, 'products_catalog', 'product_type', (t) => t.string('product_type', 40));
    await addColumnIfMissing(knex, 'products_catalog', 'manufacturer', (t) => t.string('manufacturer', 160));
    await addColumnIfMissing(knex, 'products_catalog', 'fertilizer_analysis', (t) => t.jsonb('fertilizer_analysis'));
    await addColumnIfMissing(knex, 'products_catalog', 'label_source_url', (t) => t.text('label_source_url'));
    await addColumnIfMissing(knex, 'products_catalog', 'label_file_id', (t) => t.string('label_file_id', 160));
    await addColumnIfMissing(knex, 'products_catalog', 'label_verified_at', (t) => t.timestamp('label_verified_at', { useTz: true }));
    await addColumnIfMissing(knex, 'products_catalog', 'label_version', (t) => t.string('label_version', 80));
    await addColumnIfMissing(knex, 'products_catalog', 'rate_public_visibility', (t) => t.string('rate_public_visibility', 30).defaultTo('hidden'));
    await addColumnIfMissing(knex, 'products_catalog', 'service_report_summary', (t) => t.text('service_report_summary'));
    await addColumnIfMissing(knex, 'products_catalog', 'customer_precaution_summary', (t) => t.text('customer_precaution_summary'));
    await addColumnIfMissing(knex, 'products_catalog', 'reentry_summary', (t) => t.text('reentry_summary'));
    await addColumnIfMissing(knex, 'products_catalog', 'use_conditions', (t) => t.jsonb('use_conditions'));
    await addColumnIfMissing(knex, 'products_catalog', 'heat_restrictions', (t) => t.text('heat_restrictions'));
    await addColumnIfMissing(knex, 'products_catalog', 'irrigation_notes', (t) => t.text('irrigation_notes'));
    await addColumnIfMissing(knex, 'products_catalog', 'local_rule_sensitivity', (t) => t.boolean('local_rule_sensitivity').notNullable().defaultTo(false));
    await addColumnIfMissing(knex, 'products_catalog', 'approved_for_public_page', (t) => t.boolean('approved_for_public_page').notNullable().defaultTo(false));
    await addColumnIfMissing(knex, 'products_catalog', 'approved_for_estimate_packet', (t) => t.boolean('approved_for_estimate_packet').notNullable().defaultTo(false));
    await addColumnIfMissing(knex, 'products_catalog', 'approved_for_service_report', (t) => t.boolean('approved_for_service_report').notNullable().defaultTo(false));
    await addColumnIfMissing(knex, 'products_catalog', 'approved_by', (t) => t.uuid('approved_by').nullable());
    await addColumnIfMissing(knex, 'products_catalog', 'approved_at', (t) => t.timestamp('approved_at', { useTz: true }));
    await addColumnIfMissing(knex, 'products_catalog', 'review_due_at', (t) => t.timestamp('review_due_at', { useTz: true }));

    await knex('products_catalog')
      .whereIn('category', ['herbicide', 'insecticide', 'fungicide', 'pgr'])
      .whereNull('product_type')
      .update({ product_type: 'pesticide' });
    await knex('products_catalog')
      .whereIn('category', ['fertilizer'])
      .whereNull('product_type')
      .update({ product_type: 'fertilizer' });
    await knex('products_catalog')
      .where(function () {
        this.whereIn('customer_visibility', ['public', 'portal_only'])
          .whereIn('content_status', ['approved_for_public', 'approved_for_portal', 'approved'])
          .whereNotNull('label_verified_at')
          .where(function () {
            this.whereNotNull('public_summary').orWhereNotNull('portal_summary');
          })
          .where(function () {
            this.whereNotNull('customer_safety_summary')
              .orWhereNotNull('customer_precaution_summary')
              .orWhereNotNull('pet_kid_guidance_text');
          })
          .where(function () {
            this.whereNot('product_type', 'pesticide')
              .orWhere(function () {
                this.where('product_type', 'pesticide')
                  .whereNotNull('epa_reg_number')
                  .whereRaw("LOWER(TRIM(epa_reg_number)) NOT IN ('n/a', 'not epa-registered fertilizer', 'none')");
              });
          });
      })
      .update({
        approved_for_estimate_packet: true,
        approved_for_public_page: true,
        approved_for_service_report: true,
        approved_at: knex.fn.now(),
      });
  }

  await knex('lawn_service_content_modules')
    .insert(CONTENT_MODULES.map((module) => ({
      ...module,
      body_json: { source: 'seed', version: 1 },
      status: 'approved',
      version: 1,
      source_notes: 'Seeded for Waves lawn care outline MVP.',
    })))
    .onConflict(['key', 'version'])
    .ignore();

  await knex('jurisdiction_fertilizer_rules')
    .insert([
      {
        jurisdiction_id: 'sarasota_county_fl',
        jurisdiction_name: 'Sarasota County, FL',
        state: 'FL',
        county: 'Sarasota',
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        nitrogen_restricted: true,
        phosphorus_restricted: true,
        phosphorus_soil_test_required: true,
        minimum_slow_release_nitrogen_percent: 50,
        public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
        admin_summary: 'Use county-specific ordinance review before including nitrogen/phosphorus product claims in restricted season.',
        version: '2026-05-30',
        source_verified_at: knex.fn.now(),
      },
      {
        jurisdiction_id: 'manatee_county_fl',
        jurisdiction_name: 'Manatee County, FL',
        state: 'FL',
        county: 'Manatee',
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        nitrogen_restricted: true,
        phosphorus_restricted: true,
        phosphorus_soil_test_required: true,
        public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
        admin_summary: 'Use county-specific ordinance review before including nitrogen/phosphorus product claims in restricted season.',
        version: '2026-05-30',
        source_verified_at: knex.fn.now(),
      },
      {
        jurisdiction_id: 'charlotte_county_fl',
        jurisdiction_name: 'Charlotte County, FL',
        state: 'FL',
        county: 'Charlotte',
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        nitrogen_restricted: true,
        phosphorus_restricted: true,
        public_summary: 'Local fertilizer rules may affect nutrient applications during the rainy season.',
        admin_summary: 'Confirm municipality/county rule before showing product-specific nutrient recommendations.',
        version: '2026-05-30',
        source_verified_at: knex.fn.now(),
      },
    ])
    .onConflict(['jurisdiction_id', 'version'])
    .ignore();
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('packet_admin_edits');
  await knex.schema.dropTableIfExists('service_outline_packet_products');
  await knex.schema.dropTableIfExists('service_outline_events');
  await knex.schema.dropTableIfExists('service_outline_packets');
  await knex.schema.dropTableIfExists('jurisdiction_fertilizer_rules');
  await knex.schema.dropTableIfExists('lawn_service_content_modules');
};
