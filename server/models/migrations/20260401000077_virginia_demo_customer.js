const { v4: uuidv4 } = require('uuid');

exports.up = async function (knex) {
  const phone = '+17206334021';

  // Check if she already exists
  const existing = await knex('customers').where({ phone }).first();
  if (existing) return;

  const customerId = uuidv4();

  await knex('customers').insert({
    id: customerId,
    first_name: 'Virginia',
    last_name: 'Benetti',
    email: 'virginia@wavespestcontrol.com',
    phone,
    address_line1: '14208 Sundial Pl',
    city: 'Lakewood Ranch',
    state: 'FL',
    zip: '34202',
    lawn_type: 'St. Augustine',
    property_sqft: 2400,
    lot_sqft: 8500,
    bed_sqft: 600,
    palm_count: 4,
    canopy_type: 'moderate',
    waveguard_tier: 'Gold',
    monthly_rate: 89.00,
    member_since: '2025-06-15',
    active: true,
    pipeline_stage: 'active_customer',
    lead_source: 'referral',
    lead_score: 90,
    lifetime_revenue: 1068.00,
    total_services: 12,
    referral_code: 'VIRGINIA25',
  });

  // Property preferences
  const hasPrefs = await knex.schema.hasTable('property_preferences');
  if (hasPrefs) {
    await knex('property_preferences').insert({
      customer_id: customerId,
      pet_count: 1,
      pet_details: '1 dog — Golden Retriever, indoor/outdoor',
      pets_secured_plan: 'Dog will be inside during service',
      preferred_day: 'tuesday',
      preferred_time: 'morning',
      access_notes: 'Gate code: 1234#. Back gate unlocked.',
    });
  }

  // Notification preferences
  const hasNotif = await knex.schema.hasTable('notification_prefs');
  if (hasNotif) {
    await knex('notification_prefs').insert({
      customer_id: customerId,
      service_reminder_24h: true,
      tech_en_route: true,
      service_completed: true,
      billing_reminder: true,
      seasonal_tips: true,
      sms_enabled: true,
      email_enabled: true,
    });
  }

  // Service records — 12 months of history
  const hasRecords = await knex.schema.hasTable('service_records');
  if (hasRecords) {
    const services = [
      { date: '2025-07-08', type: 'General Pest Control', notes: 'Initial service. Treated interior baseboards, exterior perimeter, granular in beds. Minor ant activity in kitchen — bait stations placed.' },
      { date: '2025-08-05', type: 'General Pest Control', notes: 'Exterior perimeter spray, granular beds, web sweep eaves. No interior issues reported.' },
      { date: '2025-09-02', type: 'Lawn Care + Pest Control', notes: 'Quarterly lawn treatment — fertilizer + pre-emergent. Exterior pest perimeter. Chinch bug activity in front yard treated.' },
      { date: '2025-10-07', type: 'General Pest Control', notes: 'Fall service. Treated exterior, focus on entry points. Applied rodent bait stations in garage.' },
      { date: '2025-11-04', type: 'General Pest Control', notes: 'Monthly exterior service. Removed 3 wasp nests under eaves. All clear.' },
      { date: '2025-12-02', type: 'Lawn Care + Pest Control', notes: 'Winter lawn treatment — potassium + iron. Exterior pest service. Lawn looking healthy, minimal weed pressure.' },
      { date: '2026-01-06', type: 'General Pest Control', notes: 'January service. Exterior perimeter, interior baseboard treatment. Minor spider activity in garage corners.' },
      { date: '2026-02-03', type: 'General Pest Control', notes: 'Exterior spray, granular in flower beds. Customer reports no pest issues. Lawn green and healthy.' },
      { date: '2026-03-03', type: 'Lawn Care + Pest Control', notes: 'Spring lawn treatment — fertilizer + weed control. Exterior pest perimeter + de-web. Beautiful turf density improvement.' },
      { date: '2026-03-17', type: 'Mosquito Treatment', notes: 'Bi-weekly mosquito misting — backyard, pool cage perimeter, landscape beds.' },
      { date: '2026-04-01', type: 'General Pest Control', notes: 'April service. Full exterior treatment. Fire ant mound treated in back yard. Interior — no activity.' },
      { date: '2026-04-01', type: 'Mosquito Treatment', notes: 'Bi-weekly mosquito service. Treated standing water areas, applied barrier spray around pool cage.' },
    ];

    for (const svc of services) {
      await knex('service_records').insert({
        id: uuidv4(),
        customer_id: customerId,
        service_date: svc.date,
        service_type: svc.type,
        status: 'completed',
        technician_notes: svc.notes,
      });
    }
  }

  // Payment history
  const hasPayments = await knex.schema.hasTable('payments');
  if (hasPayments) {
    const months = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];
    for (const mo of months) {
      await knex('payments').insert({
        customer_id: customerId,
        payment_date: `${mo}-01`,
        amount: 89.00,
        status: 'paid',
        description: 'Gold WaveGuard Monthly',
      });
    }
    // One-time mosquito add-on
    await knex('payments').insert({
      customer_id: customerId,
      payment_date: '2026-03-17',
      amount: 49.00,
      status: 'paid',
      description: 'Mosquito Treatment Add-On',
    });
  }

  // Upcoming scheduled service
  const hasScheduled = await knex.schema.hasTable('scheduled_services');
  if (hasScheduled) {
    await knex('scheduled_services').insert({
      customer_id: customerId,
      scheduled_date: '2026-04-15',
      window_start: '09:00',
      window_end: '11:00',
      service_type: 'General Pest Control + Lawn Care',
      status: 'confirmed',
      notes: 'Quarterly lawn treatment + monthly pest',
    });
    await knex('scheduled_services').insert({
      customer_id: customerId,
      scheduled_date: '2026-04-15',
      window_start: '09:00',
      window_end: '11:00',
      service_type: 'Mosquito Treatment',
      status: 'confirmed',
      notes: 'Bi-weekly mosquito misting',
    });
  }
};

exports.down = async function (knex) {
  const customer = await knex('customers').where({ phone: '+17206334021' }).first();
  if (!customer) return;
  await knex('scheduled_services').where({ customer_id: customer.id }).del();
  await knex('payments').where({ customer_id: customer.id }).del();
  await knex('service_records').where({ customer_id: customer.id }).del();
  await knex('notification_prefs').where({ customer_id: customer.id }).del();
  await knex('property_preferences').where({ customer_id: customer.id }).del();
  await knex('customers').where({ id: customer.id }).del();
};
