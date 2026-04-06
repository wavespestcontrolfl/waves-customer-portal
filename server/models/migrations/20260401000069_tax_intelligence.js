/**
 * Migration 062 — Tax Intelligence System
 *
 * Tables:
 * - tax_rates: County-level FL sales tax rates with effective dates
 * - service_taxability: Which services are taxable under FL law
 * - tax_exemptions: Customer exemption certificates (DR-14)
 * - equipment_register: Assets with depreciation tracking
 * - expense_categories: IRS Schedule C expense categorization
 * - expenses: Individual deductible expense records
 * - tax_filing_calendar: Filing deadlines & status tracking
 * - tax_advisor_reports: Weekly AI tax advisor analysis
 * - tax_advisor_alerts: Actionable items from AI advisor
 */
exports.up = async function (knex) {

  // ── Tax Rates by County ────────────────────────────────────
  await knex.schema.createTable('tax_rates', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('county', 60).notNullable();
    t.string('state', 2).defaultTo('FL');
    t.decimal('state_rate', 6, 4).notNullable(); // e.g. 0.06 = 6%
    t.decimal('county_surtax', 6, 4).defaultTo(0); // e.g. 0.01 = 1%
    t.decimal('combined_rate', 6, 4).notNullable(); // state + county
    t.date('effective_date').notNullable();
    t.date('expiry_date'); // null = currently active
    t.string('service_zone', 60); // maps to Waves service zones
    t.text('notes');
    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
    t.index('county');
    t.index('service_zone');
  });

  // Seed current FL tax rates
  const zones = [
    { county: 'Manatee', county_surtax: 0.01, service_zone: 'Bradenton / Parrish' },
    { county: 'Sarasota', county_surtax: 0.01, service_zone: 'Sarasota / LWR' },
    { county: 'Charlotte', county_surtax: 0.01, service_zone: 'Port Charlotte' },
  ];
  for (const z of zones) {
    await knex('tax_rates').insert({
      county: z.county, state: 'FL', state_rate: 0.06,
      county_surtax: z.county_surtax,
      combined_rate: 0.06 + z.county_surtax,
      effective_date: '2025-01-01', service_zone: z.service_zone,
      notes: `FL state 6% + ${z.county} County ${(z.county_surtax * 100).toFixed(0)}% surtax`,
      active: true,
    });
  }

  // ── Service Taxability Matrix ──────────────────────────────
  await knex.schema.createTable('service_taxability', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('service_key', 80).notNullable(); // matches estimate engine
    t.string('service_label', 150).notNullable();
    t.boolean('is_taxable').defaultTo(true);
    t.string('tax_category', 60); // pest_control, lawn_maintenance, inspection, etc.
    t.string('fl_statute_ref', 100); // Florida statute reference
    t.text('notes');
    t.timestamps(true, true);
    t.unique('service_key');
  });

  // Seed taxability — FL taxes pest control & lawn care services
  const services = [
    { service_key: 'pest_recurring', service_label: 'Recurring Pest Control', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'pest_onetime', service_label: 'One-Time Pest Treatment', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'termite_bait', service_label: 'Termite Bait Stations', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'termite_trench', service_label: 'Termite Trenching', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'rodent_exclusion', service_label: 'Rodent Exclusion', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'rodent_bait', service_label: 'Rodent Bait Monitoring', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'mosquito_recurring', service_label: 'WaveGuard Mosquito Program', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'mosquito_onetime', service_label: 'One-Time Mosquito Treatment', is_taxable: true, tax_category: 'pest_control', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'lawn_recurring', service_label: 'Recurring Lawn Care', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1', notes: 'Lawn spraying/fertilization is a taxable service in FL' },
    { service_key: 'lawn_onetime', service_label: 'One-Time Lawn Treatment', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'tree_shrub', service_label: 'Tree & Shrub Care', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'palm_injection', service_label: 'Palm Injection', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'plugging', service_label: 'Lawn Plugging', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'dethatching', service_label: 'Dethatching', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'topdressing', service_label: 'Topdressing', is_taxable: true, tax_category: 'lawn_maintenance', fl_statute_ref: 'FL §212.05(1)(i)1' },
    { service_key: 'wdo_inspection', service_label: 'WDO Inspection (Real Estate)', is_taxable: false, tax_category: 'inspection', fl_statute_ref: 'FL §212.08(6)', notes: 'Standalone inspection reports are generally not taxable — but treatment that follows IS taxable' },
    { service_key: 'termite_inspection', service_label: 'Termite Inspection (Standalone)', is_taxable: false, tax_category: 'inspection', fl_statute_ref: 'FL §212.08(6)', notes: 'Inspection only — not bundled with treatment' },
  ];
  await knex('service_taxability').insert(services);

  // ── Tax Exemptions ─────────────────────────────────────────
  await knex.schema.createTable('tax_exemptions', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('customer_name', 200);
    t.string('exemption_type', 60); // resale, government, nonprofit, agricultural
    t.string('certificate_number', 100); // DR-14 number
    t.date('issue_date');
    t.date('expiry_date');
    t.string('certificate_file_path', 500); // uploaded cert image/PDF
    t.boolean('verified').defaultTo(false);
    t.boolean('active').defaultTo(true);
    t.text('notes');
    t.timestamps(true, true);
    t.index('customer_id');
  });

  // ── Equipment Register (Depreciation) ──────────────────────
  await knex.schema.createTable('equipment_register', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 200).notNullable();
    t.string('description', 500);
    t.string('asset_category', 60); // vehicle, equipment, tool, technology, improvement
    t.string('irs_class', 30); // 5-year, 7-year, etc.
    t.date('purchase_date').notNullable();
    t.date('placed_in_service_date');
    t.decimal('purchase_cost', 12, 2).notNullable();
    t.decimal('salvage_value', 10, 2).defaultTo(0);
    t.string('depreciation_method', 30).defaultTo('MACRS'); // MACRS, SL, section_179, bonus_100
    t.integer('useful_life_years');
    t.decimal('annual_depreciation', 10, 2);
    t.decimal('accumulated_depreciation', 12, 2).defaultTo(0);
    t.decimal('current_book_value', 12, 2);
    t.boolean('section_179_elected').defaultTo(false);
    t.decimal('section_179_amount', 10, 2);
    t.string('serial_number', 100);
    t.string('make_model', 200);
    t.string('location', 100); // which van, storage, etc.
    t.boolean('active').defaultTo(true);
    t.boolean('disposed').defaultTo(false);
    t.date('disposal_date');
    t.decimal('disposal_proceeds', 10, 2);
    t.text('notes');
    t.timestamps(true, true);
    t.index('asset_category');
  });

  // Seed known equipment
  const equipment = [
    { name: 'Ford Transit Van', asset_category: 'vehicle', irs_class: '5-year', purchase_cost: 35000, depreciation_method: 'MACRS', useful_life_years: 5, make_model: 'Ford Transit', notes: 'Primary service vehicle' },
    { name: 'Udor KAPPA-55/GR5 Spray Pump', asset_category: 'equipment', irs_class: '7-year', purchase_cost: 1800, depreciation_method: 'section_179', useful_life_years: 7, make_model: 'Udor KAPPA-55 + Honda GX160' },
    { name: 'Hannay Powered Reel System', asset_category: 'equipment', irs_class: '7-year', purchase_cost: 2200, depreciation_method: 'section_179', useful_life_years: 7, make_model: 'Hannay AN-227 motor, 35A draw' },
    { name: 'Classen TR-20H Dethatcher', asset_category: 'equipment', irs_class: '7-year', purchase_cost: 2800, depreciation_method: 'section_179', useful_life_years: 7, make_model: 'Classen TR-20H' },
    { name: 'EcoLawn ECO 250S Topdresser', asset_category: 'equipment', irs_class: '7-year', purchase_cost: 3500, depreciation_method: 'section_179', useful_life_years: 7, make_model: 'EcoLawn ECO 250S' },
    { name: 'Arborjet QUIK-jet AIR', asset_category: 'equipment', irs_class: '7-year', purchase_cost: 1200, depreciation_method: 'section_179', useful_life_years: 7, make_model: 'Arborjet QUIK-jet AIR' },
  ];
  for (const eq of equipment) {
    await knex('equipment_register').insert({
      ...eq, purchase_date: '2025-01-01', placed_in_service_date: '2025-01-01',
      section_179_elected: eq.depreciation_method === 'section_179',
      section_179_amount: eq.depreciation_method === 'section_179' ? eq.purchase_cost : null,
      current_book_value: eq.depreciation_method === 'section_179' ? 0 : eq.purchase_cost,
      accumulated_depreciation: eq.depreciation_method === 'section_179' ? eq.purchase_cost : 0,
    });
  }

  // ── Expense Categories (IRS Schedule C) ────────────────────
  await knex.schema.createTable('expense_categories', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 100).notNullable();
    t.string('irs_line', 20); // Schedule C line number
    t.string('irs_description', 200);
    t.boolean('is_deductible').defaultTo(true);
    t.text('notes');
    t.integer('sort_order').defaultTo(0);
    t.timestamps(true, true);
  });

  const expCats = [
    { name: 'Advertising & Marketing', irs_line: '8', irs_description: 'Advertising', sort_order: 1 },
    { name: 'Vehicle Expenses', irs_line: '9', irs_description: 'Car and truck expenses', sort_order: 2, notes: 'Standard mileage rate or actual expenses. Track via Bouncie.' },
    { name: 'Commissions & Fees', irs_line: '10', irs_description: 'Commissions and fees', sort_order: 3, notes: 'Square processing fees, referral commissions' },
    { name: 'Contract Labor', irs_line: '11', irs_description: 'Contract labor', sort_order: 4 },
    { name: 'Insurance', irs_line: '15', irs_description: 'Insurance (other than health)', sort_order: 5, notes: 'General liability, commercial auto, workers comp' },
    { name: 'Legal & Professional', irs_line: '17', irs_description: 'Legal and professional services', sort_order: 6, notes: 'Accountant, attorney, business consulting' },
    { name: 'Office Expenses', irs_line: '18', irs_description: 'Office expense', sort_order: 7 },
    { name: 'Supplies', irs_line: '22', irs_description: 'Supplies', sort_order: 8, notes: 'Chemical products, PPE, application supplies — ties to Procurement system' },
    { name: 'Taxes & Licenses', irs_line: '23', irs_description: 'Taxes and licenses', sort_order: 9, notes: 'FL business tax, pest control license renewal, vehicle registration' },
    { name: 'Utilities', irs_line: '25', irs_description: 'Utilities', sort_order: 10, notes: 'Phone, internet, software subscriptions' },
    { name: 'Software & Technology', irs_line: '27a', irs_description: 'Other expenses', sort_order: 11, notes: 'Square, Twilio, Railway, Claude API, domain registrations, hosting' },
    { name: 'Repairs & Maintenance', irs_line: '21', irs_description: 'Repairs and maintenance', sort_order: 12, notes: 'Equipment repairs, van maintenance' },
    { name: 'Training & Education', irs_line: '27a', irs_description: 'Other expenses', sort_order: 13, notes: 'CEU courses, GHP certification renewal' },
    { name: 'Meals & Entertainment', irs_line: '24b', irs_description: 'Travel, meals (50%)', sort_order: 14, notes: '50% deductible for business meals', is_deductible: true },
    { name: 'Home Office', irs_line: '30', irs_description: 'Business use of home', sort_order: 15, notes: 'Simplified method: $5/sqft up to 300 sqft = $1,500 max' },
    { name: 'Interest', irs_line: '16a', irs_description: 'Interest - mortgage/other', sort_order: 16, notes: 'Business loan interest, vehicle financing' },
    { name: 'Depreciation', irs_line: '13', irs_description: 'Depreciation and section 179', sort_order: 17, notes: 'Auto-calculated from Equipment Register' },
  ];
  await knex('expense_categories').insert(expCats);

  // ── Expenses ───────────────────────────────────────────────
  await knex.schema.createTable('expenses', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('category_id').references('id').inTable('expense_categories').onDelete('SET NULL');
    t.string('description', 300).notNullable();
    t.decimal('amount', 12, 2).notNullable();
    t.decimal('tax_deductible_amount', 12, 2); // may differ from amount (e.g., 50% meals)
    t.date('expense_date').notNullable();
    t.string('vendor_name', 200);
    t.string('payment_method', 30); // cash, card, check, ach
    t.string('receipt_path', 500);
    t.boolean('is_recurring').defaultTo(false);
    t.string('recurrence_period', 20); // monthly, quarterly, annual
    t.string('tax_year', 4);
    t.string('quarter', 2); // Q1, Q2, Q3, Q4
    t.text('notes');
    t.timestamps(true, true);
    t.index(['tax_year', 'quarter']);
    t.index('category_id');
    t.index('expense_date');
  });

  // ── Tax Filing Calendar ────────────────────────────────────
  await knex.schema.createTable('tax_filing_calendar', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('filing_type', 60).notNullable(); // dr15_sales_tax, 1040es_quarterly, annual_return, 1099_filing
    t.string('title', 200).notNullable();
    t.string('period_label', 60); // "Q1 2026", "Jan 2026", "Tax Year 2025"
    t.date('due_date').notNullable();
    t.date('extended_due_date');
    t.string('status', 20).defaultTo('upcoming'); // upcoming, prepared, filed, paid, late
    t.decimal('amount_due', 12, 2);
    t.decimal('amount_paid', 12, 2);
    t.date('filed_date');
    t.date('paid_date');
    t.string('confirmation_number', 100);
    t.text('notes');
    t.boolean('reminder_sent').defaultTo(false);
    t.timestamps(true, true);
    t.index('due_date');
    t.index('status');
  });

  // Seed 2026 filing calendar
  const filings = [];

  // FL DR-15 Sales Tax — monthly (due 1st-20th of following month)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let m = 0; m < 12; m++) {
    const dueMonth = m + 1 < 12 ? m + 2 : 1;
    const dueYear = m + 1 < 12 ? 2026 : 2027;
    filings.push({
      filing_type: 'dr15_sales_tax', title: `FL Sales Tax Return (DR-15) — ${months[m]} 2026`,
      period_label: `${months[m]} 2026`,
      due_date: `${dueYear}-${String(dueMonth).padStart(2, '0')}-20`,
      status: m < 3 ? 'filed' : 'upcoming',
    });
  }

  // Federal estimated tax (1040-ES) — quarterly
  const qDates = [
    { label: 'Q1 2026', due: '2026-04-15' },
    { label: 'Q2 2026', due: '2026-06-16' },
    { label: 'Q3 2026', due: '2026-09-15' },
    { label: 'Q4 2026', due: '2027-01-15' },
  ];
  for (const q of qDates) {
    filings.push({
      filing_type: '1040es_quarterly', title: `Federal Estimated Tax (1040-ES) — ${q.label}`,
      period_label: q.label, due_date: q.due,
      status: q.due < '2026-04-06' ? 'filed' : 'upcoming',
    });
  }

  // Annual return
  filings.push({
    filing_type: 'annual_return', title: 'Federal Tax Return (Schedule C) — Tax Year 2025',
    period_label: 'Tax Year 2025', due_date: '2026-04-15',
    extended_due_date: '2026-10-15', status: 'upcoming',
  });

  await knex('tax_filing_calendar').insert(filings);

  // ── AI Tax Advisor Reports ─────────────────────────────────
  await knex.schema.createTable('tax_advisor_reports', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.date('report_date').notNullable();
    t.string('period', 30); // "Week of Apr 7, 2026"
    t.string('grade', 5); // A/B/C/D/F
    t.text('executive_summary');
    t.jsonb('financial_snapshot'); // revenue, expenses, tax collected, estimated liability
    t.jsonb('regulation_changes'); // new FL/federal tax changes found
    t.jsonb('savings_opportunities'); // specific $ savings recommendations
    t.jsonb('deduction_gaps'); // deductions you might be missing
    t.jsonb('compliance_alerts'); // filing deadlines, rate changes, etc.
    t.jsonb('action_items'); // prioritized to-do list
    t.text('raw_ai_response');
    t.string('model_used', 60);
    t.boolean('sms_sent').defaultTo(false);
    t.timestamps(true, true);
    t.index('report_date');
  });

  // ── Tax Advisor Alerts (actionable items from reports) ─────
  await knex.schema.createTable('tax_advisor_alerts', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('report_id').references('id').inTable('tax_advisor_reports').onDelete('CASCADE');
    t.string('alert_type', 30); // savings, compliance, deduction, regulation, deadline
    t.string('priority', 10); // high, medium, low
    t.string('title', 300).notNullable();
    t.text('description');
    t.decimal('estimated_savings', 10, 2); // $ impact
    t.string('status', 20).defaultTo('new'); // new, reviewed, acted_on, dismissed
    t.date('action_by_date');
    t.text('action_taken');
    t.timestamps(true, true);
    t.index('status');
    t.index('priority');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('tax_advisor_alerts');
  await knex.schema.dropTableIfExists('tax_advisor_reports');
  await knex.schema.dropTableIfExists('tax_filing_calendar');
  await knex.schema.dropTableIfExists('expenses');
  await knex.schema.dropTableIfExists('expense_categories');
  await knex.schema.dropTableIfExists('equipment_register');
  await knex.schema.dropTableIfExists('tax_exemptions');
  await knex.schema.dropTableIfExists('service_taxability');
  await knex.schema.dropTableIfExists('tax_rates');
};
