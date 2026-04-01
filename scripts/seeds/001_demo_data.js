const { v4: uuidv4 } = require('uuid');

exports.seed = async function (knex) {
  // Clear existing data (order matters for foreign keys)
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
  const techMarcus = uuidv4();
  const techCarlos = uuidv4();
  const techWaves = uuidv4();

  await knex('technicians').insert([
    { id: techWaves, name: 'Waves', phone: '+19415550100', email: 'waves@wavespestcontrol.com' },
    { id: techMarcus, name: 'Marcus W.', phone: '+19415550101', email: 'marcus@wavespestcontrol.com' },
    { id: techCarlos, name: 'Carlos R.', phone: '+19415550102', email: 'carlos@wavespestcontrol.com' },
  ]);

  // ---- Customer ----
  const customerId = uuidv4();

  await knex('customers').insert({
    id: customerId,
    first_name: 'Jennifer',
    last_name: 'Martinez',
    email: 'jennifer.m@email.com',
    phone: '+19415550147',
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
    square_customer_id: 'SQ_CUST_DEMO_001',
  });

  // ---- Service Records ----
  const svc1 = uuidv4(), svc2 = uuidv4(), svc3 = uuidv4(), svc4 = uuidv4(), svc5 = uuidv4();

  await knex('service_records').insert([
    {
      id: svc1, customer_id: customerId, technician_id: techMarcus,
      service_date: '2026-03-25', service_type: 'Lawn Care Visit #3', status: 'completed',
      technician_notes: 'Applied pre-emergent (Prodiamine) and spot-treated dollar weed with Celsius WG (application 2/3 for year). Lawn responding well — new stolons filling in bare patches near south fence. Irrigation running 15 min too long on zone 3, recommended customer reduce to 25 min.',
      thatch_measurement: 0.60,
    },
    {
      id: svc2, customer_id: customerId, technician_id: techMarcus,
      service_date: '2026-03-11', service_type: 'Quarterly Pest Control', status: 'completed',
      technician_notes: 'Interior and exterior treatment. Granular perimeter band applied. Checked all bait stations — no termite activity detected. Treated garage entry points and lanai baseboards. No pest activity noted inside. Cobweb sweep completed on all eaves.',
    },
    {
      id: svc3, customer_id: customerId, technician_id: techMarcus,
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
    { customer_id: customerId, technician_id: techMarcus, scheduled_date: '2026-04-08', window_start: '08:00', window_end: '10:00', service_type: 'Lawn Care Visit #4 + Quarterly Pest Control', status: 'pending' },
    { customer_id: customerId, technician_id: techCarlos, scheduled_date: '2026-04-15', window_start: '07:00', window_end: '08:30', service_type: 'WaveGuard Mosquito Treatment', status: 'pending' },
    { customer_id: customerId, technician_id: techMarcus, scheduled_date: '2026-05-06', window_start: null, window_end: null, service_type: 'Lawn Care Visit #5', status: 'pending' },
    { customer_id: customerId, technician_id: techCarlos, scheduled_date: '2026-05-15', window_start: null, window_end: null, service_type: 'WaveGuard Mosquito Treatment', status: 'pending' },
  ]);

  // ---- Payment Method ----
  const pmId = uuidv4();
  await knex('payment_methods').insert({
    id: pmId, customer_id: customerId,
    square_card_id: 'SQ_CARD_DEMO_001',
    card_brand: 'VISA', last_four: '4821',
    exp_month: '08', exp_year: '2028',
    is_default: true, autopay_enabled: true,
  });

  // ---- Payments ----
  await knex('payments').insert([
    { customer_id: customerId, payment_method_id: pmId, payment_date: '2026-04-01', amount: 189.00, status: 'upcoming', description: 'Gold WaveGuard Monthly' },
    { customer_id: customerId, payment_method_id: pmId, square_payment_id: 'SQ_PAY_004', payment_date: '2026-03-01', amount: 189.00, status: 'paid', description: 'Gold WaveGuard Monthly' },
    { customer_id: customerId, payment_method_id: pmId, square_payment_id: 'SQ_PAY_003', payment_date: '2026-02-01', amount: 189.00, status: 'paid', description: 'Gold WaveGuard Monthly' },
    { customer_id: customerId, payment_method_id: pmId, square_payment_id: 'SQ_PAY_002', payment_date: '2026-01-01', amount: 189.00, status: 'paid', description: 'Gold WaveGuard Monthly' },
    { customer_id: customerId, payment_method_id: pmId, square_payment_id: 'SQ_PAY_001', payment_date: '2025-12-15', amount: 250.00, status: 'paid', description: 'One-Time Mosquito Event' },
  ]);

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
