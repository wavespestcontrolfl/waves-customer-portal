exports.up = async function (knex) {
  // Extend customers with CRM fields
  await knex.schema.alterTable('customers', (t) => {
    t.string('lead_source', 30);
    t.integer('lead_score').defaultTo(0);
    t.string('pipeline_stage', 30).defaultTo('active_customer');
    t.timestamp('pipeline_stage_changed_at');
    t.uuid('assigned_to').references('id').inTable('technicians');
    t.timestamp('last_contact_date');
    t.string('last_contact_type', 30);
    t.date('next_follow_up_date');
    t.text('follow_up_notes');
    t.decimal('lifetime_revenue', 10, 2).defaultTo(0);
    t.integer('total_services').defaultTo(0);
    t.date('customer_since');
    t.date('churned_at');
    t.string('churn_reason', 30);
    t.string('property_type', 30);
    t.string('company_name', 150);
    t.string('secondary_phone', 20);
    t.string('secondary_contact_name', 100);
    t.text('crm_notes');
  });

  // Customer tags
  await knex.schema.createTable('customer_tags', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('tag', 50).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['customer_id', 'tag']);
    t.index('customer_id');
    t.index('tag');
  });

  // Customer interactions (CRM timeline)
  await knex.schema.createTable('customer_interactions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('interaction_type', 30).notNullable();
    t.string('subject', 200);
    t.text('body');
    t.uuid('admin_user_id').references('id').inTable('technicians');
    t.jsonb('metadata');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('customer_id');
    t.index('interaction_type');
    t.index('created_at');
  });

  // Seed CRM data for existing customer
  const customer = await knex('customers').first();
  if (customer) {
    const adam = await knex('technicians').where('name', 'Adam B.').first();
    await knex('customers').where('id', customer.id).update({
      lead_source: 'referral', lead_score: 82, pipeline_stage: 'active_customer',
      pipeline_stage_changed_at: knex.fn.now(), assigned_to: adam?.id,
      last_contact_date: knex.fn.now(), last_contact_type: 'service',
      lifetime_revenue: 1512, total_services: 6, customer_since: customer.member_since,
      property_type: 'single_family',
    });

    await knex('customer_tags').insert([
      { customer_id: customer.id, tag: 'VIP' },
      { customer_id: customer.id, tag: 'referral_machine' },
      { customer_id: customer.id, tag: 'always_home' },
    ]);

    await knex('customer_interactions').insert([
      { customer_id: customer.id, interaction_type: 'note', subject: 'Initial assessment', body: 'Full property assessment completed. St. Augustine. Moderate thatch. Dollar weed in beds. Starting premium program.', admin_user_id: adam?.id, created_at: new Date('2026-01-28') },
      { customer_id: customer.id, interaction_type: 'service_completed', subject: 'Lawn Care Visit #1', body: 'Winterizer applied. Pre-emergent spot treatment.', admin_user_id: adam?.id, created_at: new Date('2026-01-28') },
      { customer_id: customer.id, interaction_type: 'sms_outbound', subject: 'Service reminder', body: 'Reminder for tomorrow\'s lawn care visit', created_at: new Date('2026-02-23') },
      { customer_id: customer.id, interaction_type: 'service_completed', subject: 'Lawn Care Visit #2', body: 'Fertilizer + fungicide. Thatch improving.', admin_user_id: adam?.id, created_at: new Date('2026-02-24') },
      { customer_id: customer.id, interaction_type: 'review', subject: '5-star Google review', body: 'Left a great review on Google Lakewood Ranch location.', created_at: new Date('2026-03-05') },
      { customer_id: customer.id, interaction_type: 'service_completed', subject: 'Quarterly Pest Control', body: 'Full interior + exterior. No issues.', admin_user_id: adam?.id, created_at: new Date('2026-03-11') },
      { customer_id: customer.id, interaction_type: 'referral', subject: 'Referred Mike Thompson', body: 'Jennifer referred her neighbor Mike. $25 credit applied.', created_at: new Date('2026-03-15') },
      { customer_id: customer.id, interaction_type: 'service_completed', subject: 'Lawn Care Visit #3', body: 'Pre-emergent + Celsius app 2/3. Lawn responding well.', admin_user_id: adam?.id, created_at: new Date('2026-03-25') },
      { customer_id: customer.id, interaction_type: 'note', subject: 'Irrigation recommendation', body: 'Zone 3 running 15 min too long. Recommended reducing to 25 min.', admin_user_id: adam?.id, created_at: new Date('2026-03-25') },
    ]);
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_interactions');
  await knex.schema.dropTableIfExists('customer_tags');
  await knex.schema.alterTable('customers', (t) => {
    ['lead_source','lead_score','pipeline_stage','pipeline_stage_changed_at','assigned_to',
     'last_contact_date','last_contact_type','next_follow_up_date','follow_up_notes',
     'lifetime_revenue','total_services','customer_since','churned_at','churn_reason',
     'property_type','company_name','secondary_phone','secondary_contact_name','crm_notes'
    ].forEach(col => t.dropColumn(col));
  });
};
