exports.up = async function (knex) {
  // Job-level financials on service_records
  await knex.schema.alterTable('service_records', (t) => {
    t.decimal('revenue', 10, 2);
    t.decimal('material_cost', 10, 2);
    t.decimal('labor_hours', 6, 2);
    t.decimal('labor_cost', 10, 2);
    t.decimal('drive_cost', 8, 2);
    t.decimal('total_job_cost', 10, 2);
    t.decimal('gross_profit', 10, 2);
    t.decimal('gross_margin_pct', 5, 2);
    t.decimal('revenue_per_man_hour', 8, 2);
    t.decimal('cost_per_1000sf', 8, 4);
    t.decimal('revenue_per_1000sf', 8, 4);
    t.integer('area_serviced_sqft');
    t.string('frequency_tag', 20);
  });

  // Company financial assumptions
  await knex.schema.createTable('company_financials', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.date('effective_date').notNullable();
    t.decimal('loaded_labor_rate', 8, 2).defaultTo(35);
    t.decimal('drive_cost_per_stop', 8, 2).defaultTo(6);
    t.decimal('drive_cost_per_mile', 8, 2).defaultTo(0.67);
    t.decimal('admin_cost_per_customer_year', 8, 2).defaultTo(51);
    t.decimal('vehicle_cost_per_month', 8, 2).defaultTo(850);
    t.decimal('insurance_cost_per_month', 8, 2).defaultTo(400);
    t.decimal('software_cost_per_month', 8, 2).defaultTo(350);
    t.decimal('target_gross_margin_pct', 5, 2).defaultTo(55);
    t.decimal('target_rpmh', 8, 2).defaultTo(120);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Seed financial assumptions
  await knex('company_financials').insert({
    effective_date: '2026-01-01',
    loaded_labor_rate: 35, drive_cost_per_stop: 6, drive_cost_per_mile: 0.67,
    admin_cost_per_customer_year: 51, vehicle_cost_per_month: 850,
    insurance_cost_per_month: 400, software_cost_per_month: 350,
    target_gross_margin_pct: 55, target_rpmh: 120,
  });

  // Seed financial data on existing service records
  const services = await knex('service_records').select('id', 'service_type', 'service_date');
  for (const svc of services) {
    const type = (svc.service_type || '').toLowerCase();
    let revenue, matCost, laborMin, margin;

    if (type.includes('lawn')) {
      revenue = 65 + Math.random() * 30; matCost = 12 + Math.random() * 13; laborMin = 30 + Math.random() * 15;
    } else if (type.includes('pest')) {
      revenue = 100 + Math.random() * 40; matCost = 8 + Math.random() * 7; laborMin = 25 + Math.random() * 10;
    } else if (type.includes('mosquito')) {
      revenue = 80 + Math.random() * 30; matCost = 6 + Math.random() * 6; laborMin = 20 + Math.random() * 10;
    } else {
      revenue = 100 + Math.random() * 50; matCost = 10 + Math.random() * 10; laborMin = 25 + Math.random() * 15;
    }

    const laborHrs = Math.round(laborMin) / 60;
    const laborCost = laborHrs * 35;
    const driveCost = 6;
    const totalCost = matCost + laborCost + driveCost;
    const grossProfit = revenue - totalCost;
    const marginPct = (grossProfit / revenue) * 100;
    const rpmh = laborHrs > 0 ? revenue / laborHrs : 0;

    await knex('service_records').where({ id: svc.id }).update({
      revenue: Math.round(revenue * 100) / 100,
      material_cost: Math.round(matCost * 100) / 100,
      labor_hours: Math.round(laborHrs * 100) / 100,
      labor_cost: Math.round(laborCost * 100) / 100,
      drive_cost: driveCost,
      total_job_cost: Math.round(totalCost * 100) / 100,
      gross_profit: Math.round(grossProfit * 100) / 100,
      gross_margin_pct: Math.round(marginPct * 10) / 10,
      revenue_per_man_hour: Math.round(rpmh * 100) / 100,
      frequency_tag: type.includes('quarterly') ? 'quarterly' : type.includes('monthly') || type.includes('mosquito') ? 'monthly' : 'quarterly',
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('company_financials');
  await knex.schema.alterTable('service_records', (t) => {
    ['revenue','material_cost','labor_hours','labor_cost','drive_cost','total_job_cost',
     'gross_profit','gross_margin_pct','revenue_per_man_hour','cost_per_1000sf',
     'revenue_per_1000sf','area_serviced_sqft','frequency_tag'].forEach(c => t.dropColumn(c));
  });
};
