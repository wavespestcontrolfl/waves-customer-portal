const { v4: uuidv4 } = require('uuid');

exports.seed = async function (knex) {
  // Clear existing data (order matters for foreign keys)
  await knex('service_tracking').del();
  await knex('promotion_dismissals').del();
  await knex('satisfaction_responses').del();
  await knex('service_requests').del();
  await knex('customer_badges').del();
  await knex('document_share_links').del();
  await knex('customer_documents').del();
  await knex('referrals').del();
  await knex('property_preferences').del();
  await knex('lawn_health_scores').del();
  await knex('verification_codes').del();
  await knex('notification_prefs').del();
  await knex('payments').del();
  await knex('payment_methods').del();
  await knex('scheduled_services').del();
  await knex('service_photos').del();
  await knex('service_products').del();
  await knex('service_records').del();
  await knex('customers').del();
  await knex('technicians').del();

  // ---- Technicians ----
  const techAdam = uuidv4();
  const techCarlos = uuidv4();
  const techWaves = uuidv4();

  await knex('technicians').insert([
    { id: techWaves, name: 'Waves', phone: '+19415550100', email: 'waves@wavespestcontrol.com' },
    { id: techAdam, name: 'Adam B.', phone: '+19415550101', email: 'adam@wavespestcontrol.com' },
    { id: techCarlos, name: 'Carlos R.', phone: '+19415550102', email: 'carlos@wavespestcontrol.com' },
  ]);

  // ---- Customer ----
  const customerId = uuidv4();

  await knex('customers').insert({
    id: customerId,
    first_name: 'Jennifer',
    last_name: 'Martinez',
    email: 'jennifer.m@email.com',
    phone: '+19415993489',
    address_line1: '4821 Sandpiper Dr',
    city: 'Lakewood Ranch',
    state: 'FL',
    zip: '34202',
    lawn_type: 'St. Augustine Full Sun',
    property_sqft: 6200,
    lot_sqft: 9800,
    bed_sqft: 1200,
    linear_ft_perimeter: 280,
    palm_count: 4,
    canopy_type: 'moderate',
    waveguard_tier: 'Gold',
    monthly_rate: 189.00,
    member_since: '2025-03-01',
    stripe_customer_id: 'cus_DEMO_001',
    referral_code: 'WAVES-J4KM',
  });

  // ---- Service Records ----
  const svc1 = uuidv4(), svc2 = uuidv4(), svc3 = uuidv4(), svc4 = uuidv4(), svc5 = uuidv4(), svc6 = uuidv4();

  await knex('service_records').insert([
    {
      id: svc6, customer_id: customerId, technician_id: techAdam,
      service_date: '2026-04-01', service_type: 'WaveGuard Mosquito Treatment', status: 'completed',
      technician_notes: 'Monthly perimeter mosquito treatment. Heavy rain last week created standing water in back planter — treated with larvicide. Full barrier application to fence line, palms, and lanai perimeter. Applied Cyzmic CS and Tekko Pro IGR. All areas covered.',
    },
    {
      id: svc1, customer_id: customerId, technician_id: techAdam,
      service_date: '2026-03-25', service_type: 'Lawn Care Visit #3', status: 'completed',
      technician_notes: 'Applied pre-emergent (Prodiamine) and spot-treated dollar weed with Celsius WG (application 2/3 for year). Lawn responding well — new stolons filling in bare patches near south fence. Irrigation running 15 min too long on zone 3, recommended customer reduce to 25 min.',
      thatch_measurement: 0.60,
    },
    {
      id: svc2, customer_id: customerId, technician_id: techAdam,
      service_date: '2026-03-11', service_type: 'Quarterly Pest Control', status: 'completed',
      technician_notes: 'Interior and exterior treatment. Granular perimeter band applied. Checked all bait stations — no termite activity detected. Treated garage entry points and lanai baseboards. No pest activity noted inside. Cobweb sweep completed on all eaves.',
    },
    {
      id: svc3, customer_id: customerId, technician_id: techAdam,
      service_date: '2026-02-24', service_type: 'Lawn Care Visit #2', status: 'completed',
      technician_notes: 'Soil temp 68°F — applied balanced fertilizer (16-4-8 with micros). Treated large patch fungus area near oak tree with Headway G. Thatch measurement 0.6" — monitoring, may need dethatching in fall. Overall turf density improving significantly since program start.',
      soil_temp: 68.0, thatch_measurement: 0.60, soil_ph: 6.8,
    },
    {
      id: svc4, customer_id: customerId, technician_id: techWaves,
      service_date: '2026-01-28', service_type: 'Lawn Care Visit #1 + Initial Assessment', status: 'completed',
      technician_notes: 'Initial property assessment completed. St. Augustine Full Sun track selected. Identified: moderate thatch buildup (0.7"), scattered dollar weed in front beds, early-stage large patch near NE oak canopy drip line. Soil pH 6.8 — good range. Set up 12-visit premium lawn program. First fertilizer app (winterizer blend) and broadleaf spot treatment applied.',
      thatch_measurement: 0.70, soil_ph: 6.8, soil_moisture: 'adequate',
    },
    {
      id: svc5, customer_id: customerId, technician_id: techCarlos,
      service_date: '2026-01-15', service_type: 'WaveGuard Mosquito Treatment', status: 'completed',
      technician_notes: 'Monthly perimeter mosquito treatment. Treated all standing water sources, foliage undersides along fence line, and lanai perimeter. Barrier application to shrub line and palms. Customer reports significant reduction since Gold program started.',
    },
  ]);

  // ---- Products Applied ----
  await knex('service_products').insert([
    { service_record_id: svc6, product_name: 'Cyzmic CS', product_category: 'insecticide', active_ingredient: 'Lambda-cyhalothrin', moa_group: 'Group 3A' },
    { service_record_id: svc6, product_name: 'Tekko Pro IGR', product_category: 'IGR', active_ingredient: 'Pyriproxyfen + Novaluron' },
    { service_record_id: svc1, product_name: 'Prodiamine 65 WDG', product_category: 'herbicide', active_ingredient: 'Prodiamine', moa_group: 'Group 3' },
    { service_record_id: svc1, product_name: 'Celsius WG', product_category: 'herbicide', active_ingredient: 'Thiencarbazone + Iodosulfuron + Dicamba', moa_group: 'Group 2' },
    { service_record_id: svc1, product_name: 'FeSO4 Foliar', product_category: 'fertilizer', active_ingredient: 'Ferrous sulfate' },
    { service_record_id: svc2, product_name: 'Demand CS', product_category: 'insecticide', active_ingredient: 'Lambda-cyhalothrin', moa_group: 'Group 3A' },
    { service_record_id: svc2, product_name: 'Advion WDG Granular', product_category: 'insecticide', active_ingredient: 'Indoxacarb', moa_group: 'Group 22A' },
    { service_record_id: svc2, product_name: 'Alpine WSG', product_category: 'insecticide', active_ingredient: 'Dinotefuran', moa_group: 'Group 4A' },
    { service_record_id: svc3, product_name: '16-4-8 + Micros', product_category: 'fertilizer' },
    { service_record_id: svc3, product_name: 'Headway G', product_category: 'fungicide', active_ingredient: 'Azoxystrobin + Propiconazole', moa_group: 'Group 11 + 3' },
    { service_record_id: svc4, product_name: '0-0-16 Winterizer', product_category: 'fertilizer' },
    { service_record_id: svc4, product_name: 'Celsius WG', product_category: 'herbicide', active_ingredient: 'Thiencarbazone + Iodosulfuron + Dicamba', moa_group: 'Group 2' },
    { service_record_id: svc4, product_name: 'Surfactant', product_category: 'adjuvant' },
    { service_record_id: svc5, product_name: 'Cyzmic CS', product_category: 'insecticide', active_ingredient: 'Lambda-cyhalothrin', moa_group: 'Group 3A' },
    { service_record_id: svc5, product_name: 'Tekko Pro IGR', product_category: 'IGR', active_ingredient: 'Pyriproxyfen + Novaluron' },
  ]);

  // ---- Upcoming Scheduled Services ----
  await knex('scheduled_services').insert([
    { customer_id: customerId, technician_id: techAdam, scheduled_date: '2026-04-08', window_start: '08:00', window_end: '10:00', service_type: 'Lawn Care Visit #4 + Quarterly Pest Control', status: 'pending' },
    { customer_id: customerId, technician_id: techCarlos, scheduled_date: '2026-04-15', window_start: '07:00', window_end: '08:30', service_type: 'WaveGuard Mosquito Treatment', status: 'pending' },
    { customer_id: customerId, technician_id: techAdam, scheduled_date: '2026-05-06', window_start: null, window_end: null, service_type: 'Lawn Care Visit #5', status: 'pending' },
    { customer_id: customerId, technician_id: techCarlos, scheduled_date: '2026-05-15', window_start: null, window_end: null, service_type: 'WaveGuard Mosquito Treatment', status: 'pending' },
  ]);

  // ---- Payment Method ----
  const pmId = uuidv4();
  await knex('payment_methods').insert({
    id: pmId, customer_id: customerId,
    stripe_payment_method_id: 'pm_DEMO_001',
    card_brand: 'VISA', last_four: '4821',
    exp_month: '08', exp_year: '2028',
    is_default: true, autopay_enabled: true,
  });

  // ---- Payments ----
  await knex('payments').insert([
    { customer_id: customerId, payment_method_id: pmId, payment_date: '2026-04-01', amount: 189.00, status: 'upcoming', description: 'WaveGuard Gold Monthly' },
    { customer_id: customerId, payment_method_id: pmId, stripe_payment_intent_id: 'pi_DEMO_004', payment_date: '2026-03-01', amount: 189.00, status: 'paid', description: 'WaveGuard Gold Monthly' },
    { customer_id: customerId, payment_method_id: pmId, stripe_payment_intent_id: 'pi_DEMO_003', payment_date: '2026-02-01', amount: 189.00, status: 'paid', description: 'WaveGuard Gold Monthly' },
    { customer_id: customerId, payment_method_id: pmId, stripe_payment_intent_id: 'pi_DEMO_002', payment_date: '2026-01-01', amount: 189.00, status: 'paid', description: 'WaveGuard Gold Monthly' },
    { customer_id: customerId, payment_method_id: pmId, stripe_payment_intent_id: 'pi_DEMO_001', payment_date: '2025-12-15', amount: 250.00, status: 'paid', description: 'One-Time Mosquito Event' },
  ]);

  // ---- Lawn Health Scores ----
  await knex('lawn_health_scores').insert([
    {
      customer_id: customerId, service_record_id: svc4,
      assessment_date: '2026-01-28',
      turf_density: 45, weed_suppression: 30, fungus_control: 40, thatch_score: 35,
      thatch_inches: 0.70, overall_score: 38,
      notes: 'Initial assessment — moderate thatch, scattered dollar weed, early large patch detected',
    },
    {
      customer_id: customerId, service_record_id: svc1,
      assessment_date: '2026-03-25',
      turf_density: 78, weed_suppression: 85, fungus_control: 90, thatch_score: 70,
      thatch_inches: 0.60, overall_score: 81,
      notes: 'Significant improvement across all metrics. Dollar weed nearly eliminated. Fungus resolved.',
    },
  ]);

  // ---- Pre-earned Badges ----
  await knex('customer_badges').insert([
    { customer_id: customerId, badge_type: 'welcome_aboard', notified: true, earned_at: '2025-03-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'first_visit', notified: true, earned_at: '2026-01-15T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'member_3mo', notified: true, earned_at: '2025-06-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'member_6mo', notified: true, earned_at: '2025-09-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'member_1yr', notified: true, earned_at: '2026-03-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'tier_gold', notified: true, earned_at: '2025-03-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'tier_silver', notified: true, earned_at: '2025-03-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'perfect_payer', notified: true, earned_at: '2026-03-01T12:00:00.000Z' },
    { customer_id: customerId, badge_type: 'referral_starter', notified: true, earned_at: '2026-02-15T12:00:00.000Z' },
  ]);

  // ---- Customer Documents ----
  await knex('customer_documents').insert([
    {
      customer_id: customerId,
      document_type: 'wdo_inspection',
      title: 'WDO Inspection Report — 4821 Sandpiper Dr',
      description: 'Wood Destroying Organism inspection for property clearance. No active termite activity found.',
      s3_key: 'documents/wdo/2026-01-martinez-sandpiper.pdf',
      file_name: 'WDO_Inspection_Jan2026_4821_Sandpiper.pdf',
      file_size_bytes: 245000,
      uploaded_by: 'admin',
      expiration_date: '2027-01-10',
    },
    {
      customer_id: customerId,
      document_type: 'service_agreement',
      title: 'WaveGuard Gold Service Agreement',
      description: 'Annual service agreement for Gold tier WaveGuard pest control, lawn care, and mosquito protection.',
      s3_key: 'documents/agreements/2025-03-martinez-gold-waveguard.pdf',
      file_name: 'WaveGuard_Gold_Agreement_Martinez.pdf',
      file_size_bytes: 189000,
      uploaded_by: 'admin',
    },
    {
      customer_id: customerId,
      document_type: 'insurance_cert',
      title: 'Waves Pest Control — Certificate of Insurance',
      description: 'General liability insurance certificate. Valid through December 2026.',
      s3_key: 'documents/insurance/waves-coi-2026.pdf',
      file_name: 'Waves_COI_2026.pdf',
      file_size_bytes: 156000,
      uploaded_by: 'admin',
      expiration_date: '2026-12-31',
    },
  ]);

  // ---- Referrals ----
  await knex('referrals').insert([
    {
      referrer_customer_id: customerId,
      referee_name: 'Mike Thompson',
      referee_phone: '+19415550201',
      referral_code: 'WAVES-J4KM',
      status: 'credited',
      credit_amount: 25.00,
      referrer_credited: true,
      referee_credited: true,
      converted_at: '2026-02-15T12:00:00.000Z',
    },
    {
      referrer_customer_id: customerId,
      referee_name: 'Sarah Chen',
      referee_phone: '+19415550202',
      referral_code: 'WAVES-J4KM',
      status: 'signed_up',
      credit_amount: 25.00,
      referrer_credited: false,
      referee_credited: true,
      converted_at: '2026-03-20T12:00:00.000Z',
    },
    {
      referrer_customer_id: customerId,
      referee_name: 'Dave Rodriguez',
      referee_phone: '+19415550203',
      referral_code: 'WAVES-J4KM',
      status: 'contacted',
      credit_amount: 25.00,
    },
  ]);

  // ---- Property Preferences ----
  await knex('property_preferences').insert({
    customer_id: customerId,
    neighborhood_gate_code: '#4821 then press 5',
    property_gate_code: 'Side gate combo: 1234',
    garage_code: '',
    lockbox_code: '',
    parking_notes: 'Park in driveway — HOA enforces no street parking',
    pet_count: 2,
    pet_details: 'Golden retriever named Max — friendly, usually in backyard. Chihuahua named Bella — barks but harmless, usually inside.',
    pets_secured_plan: 'Dogs will be inside during service. Please text 15 min before arrival so I can bring Max in from the yard.',
    preferred_day: 'tuesday',
    preferred_time: 'morning',
    contact_preference: 'text',
    irrigation_system: true,
    irrigation_controller_location: 'Left side of garage, gray box mounted on wall',
    irrigation_zones: 5,
    irrigation_schedule_notes: 'Runs Mon/Wed/Fri at 4am. Zone 3 seems to run 15 min too long — causes pooling near south fence.',
    hoa_name: 'Sandpiper Bay HOA',
    hoa_restrictions: 'No pesticide signs allowed in yard. Must notify HOA management 24hr before exterior spray. No street parking — vehicles will be towed.',
    access_notes: 'Please don\'t ring doorbell — baby sleeping during morning appointments.',
    special_instructions: 'Check under the oak tree canopy on NE corner for large patch fungus each visit. Also keep an eye on the palm near the lanai — had some whitefly issues last year.',
  });

  // ---- Notification Preferences ----
  await knex('notification_prefs').insert({
    customer_id: customerId,
    service_reminder_24h: true,
    tech_en_route: true,
    service_completed: true,
    billing_reminder: false,
    seasonal_tips: true,
    sms_enabled: true,
    email_enabled: true,
  });
};
