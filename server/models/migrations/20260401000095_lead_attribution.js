exports.up = async function (knex) {
  // 1. lead_sources
  if (!(await knex.schema.hasTable('lead_sources'))) {
    await knex.schema.createTable('lead_sources', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 200).notNullable();
      t.string('source_type', 30).notNullable();
      t.string('channel', 50);
      t.string('twilio_phone_number', 20);
      t.string('twilio_phone_sid');
      t.string('domain');
      t.string('landing_page_url');
      t.string('gbp_location_id');
      t.string('cost_type', 20).defaultTo('free');
      t.decimal('monthly_cost', 10, 2).defaultTo(0);
      t.decimal('cost_per_lead', 10, 2).defaultTo(0);
      t.decimal('setup_cost', 10, 2).defaultTo(0);
      t.boolean('is_active').defaultTo(true);
      t.text('notes');
      t.timestamps(true, true);
      t.index('source_type');
      t.index('channel');
      t.index('twilio_phone_number');
      t.index('domain');
      t.index('is_active');
    });
  }

  // 2. leads
  if (!(await knex.schema.hasTable('leads'))) {
    await knex.schema.createTable('leads', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('lead_source_id');
      t.string('first_name');
      t.string('last_name');
      t.string('phone');
      t.string('email');
      t.string('address');
      t.string('city');
      t.string('zip');
      t.string('lead_type', 30);
      t.string('service_interest');
      t.string('urgency', 20).defaultTo('normal');
      t.boolean('is_residential').defaultTo(true);
      t.boolean('is_commercial').defaultTo(false);
      t.timestamp('first_contact_at').defaultTo(knex.fn.now());
      t.string('first_contact_channel');
      t.string('twilio_call_sid');
      t.string('twilio_message_sid');
      t.integer('call_duration_seconds');
      t.string('call_recording_url');
      t.text('transcript_summary');
      t.jsonb('extracted_data');
      t.boolean('is_qualified');
      t.string('disqualification_reason');
      t.string('status', 30).defaultTo('new');
      t.uuid('assigned_to');
      t.uuid('estimate_id');
      t.uuid('customer_id');
      t.timestamp('converted_at');
      t.decimal('monthly_value', 10, 2);
      t.decimal('initial_service_value', 10, 2);
      t.string('waveguard_tier');
      t.string('lost_reason');
      t.string('lost_to_competitor');
      t.text('lost_notes');
      t.timestamp('next_follow_up_at');
      t.integer('follow_up_count').defaultTo(0);
      t.timestamp('last_follow_up_at');
      t.integer('response_time_minutes');
      t.timestamps(true, true);
      t.index('lead_source_id');
      t.index('status');
      t.index('phone');
      t.index('email');
      t.index('customer_id');
      t.index('first_contact_at');
      t.index('assigned_to');
      t.index('is_qualified');
    });
  }

  // 3. lead_activities
  if (!(await knex.schema.hasTable('lead_activities'))) {
    await knex.schema.createTable('lead_activities', (t) => {
      t.increments('id');
      t.uuid('lead_id').notNullable();
      t.string('activity_type', 30);
      t.text('description');
      t.string('performed_by', 100);
      t.jsonb('metadata');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index('lead_id');
      t.index('created_at');
    });
  }

  // 4. lead_source_costs
  if (!(await knex.schema.hasTable('lead_source_costs'))) {
    await knex.schema.createTable('lead_source_costs', (t) => {
      t.increments('id');
      t.uuid('lead_source_id').notNullable();
      t.date('month').notNullable();
      t.decimal('cost_amount', 10, 2).notNullable();
      t.string('cost_category', 30);
      t.text('notes');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['lead_source_id', 'month', 'cost_category']);
    });
  }

  // 5. marketing_campaigns
  if (!(await knex.schema.hasTable('marketing_campaigns'))) {
    await knex.schema.createTable('marketing_campaigns', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 200).notNullable();
      t.string('channel', 50);
      t.uuid('lead_source_id');
      t.string('status', 20).defaultTo('active');
      t.date('start_date');
      t.date('end_date');
      t.decimal('budget', 10, 2);
      t.decimal('spend_to_date', 10, 2).defaultTo(0);
      t.integer('target_leads');
      t.integer('target_conversions');
      t.text('offer_details');
      t.string('utm_source');
      t.string('utm_medium');
      t.string('utm_campaign');
      t.text('notes');
      t.timestamps(true, true);
      t.index('status');
      t.index('channel');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('marketing_campaigns');
  await knex.schema.dropTableIfExists('lead_source_costs');
  await knex.schema.dropTableIfExists('lead_activities');
  await knex.schema.dropTableIfExists('leads');
  await knex.schema.dropTableIfExists('lead_sources');
};
