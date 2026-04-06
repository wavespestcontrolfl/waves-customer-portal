/**
 * Migration 073 — Equipment Tracking, Tank Mix Calculator, Job Costing
 *
 * Tracks spray rigs, pumps, reels, and spreaders with maintenance logs.
 * Tank mix recipes calculate cost-per-1000-sqft from inventory prices.
 * Job costing rolls up product, labor, drive, and equipment costs per service.
 */
const { v4: uuidv4 } = require('uuid');

exports.up = async function (knex) {

  // ── Equipment ────────────────────────────────────────────────
  await knex.schema.createTable('equipment', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 150).notNullable();
    t.string('category', 50);                          // sprayer, pump, reel, spreader, dethatcher, backpack, vehicle, other
    t.string('make', 100);
    t.string('model', 100);
    t.string('serial_number', 100);
    t.date('purchase_date');
    t.decimal('purchase_price', 10, 2);
    t.decimal('current_hours', 8, 1).defaultTo(0);
    t.decimal('next_service_hours', 8, 1);
    t.string('next_service_type', 100);
    t.date('last_service_date');
    t.uuid('assigned_to').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.string('status', 20).defaultTo('active');        // active, maintenance, retired, pending
    t.string('depreciation_method', 20).defaultTo('section_179');
    t.decimal('depreciation_annual', 10, 2);
    t.decimal('book_value', 10, 2);
    t.jsonb('specs');                                   // tank_capacity_gal, hose_length_ft, engine_model, etc.
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('category');
    t.index('status');
    t.index('assigned_to');
  });

  // ── Equipment Maintenance Log ────────────────────────────────
  await knex.schema.createTable('equipment_maintenance_log', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
    t.string('service_type', 100);                     // oil_change, nozzle_replace, calibration, pump_rebuild, filter_replace, hose_replace, general
    t.decimal('hours_at_service', 8, 1);
    t.decimal('cost', 8, 2);
    t.text('parts_used');
    t.string('performed_by', 100);
    t.text('notes');
    t.date('service_date').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('equipment_id');
    t.index('service_type');
  });

  // ── Tank Mixes ───────────────────────────────────────────────
  await knex.schema.createTable('tank_mixes', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 150).notNullable();
    t.string('service_type', 50);                      // lawn_care, pest_control, mosquito, tree_shrub
    t.decimal('tank_size_gal', 6, 1).defaultTo(110);
    t.jsonb('products').defaultTo('[]');                // [{ product_id, product_name, rate_per_1000sf, rate_unit, oz_per_tank }]
    t.decimal('water_gal', 6, 1);
    t.integer('coverage_sqft');
    t.decimal('cost_per_tank', 8, 2);
    t.decimal('cost_per_1000sf', 8, 4);
    t.text('notes');
    t.boolean('active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index('service_type');
  });

  // ── Job Costs ────────────────────────────────────────────────
  await knex.schema.createTable('job_costs', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('service_record_id').nullable();
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.date('service_date').notNullable();
    t.string('service_type', 100);
    t.decimal('products_cost', 8, 2).defaultTo(0);
    t.decimal('labor_cost', 8, 2).defaultTo(0);
    t.decimal('drive_cost', 8, 2).defaultTo(0);
    t.decimal('equipment_cost', 8, 2).defaultTo(0);
    t.decimal('total_cost', 8, 2).defaultTo(0);
    t.decimal('revenue', 8, 2).defaultTo(0);
    t.decimal('gross_profit', 8, 2).defaultTo(0);
    t.decimal('margin_pct', 5, 2).defaultTo(0);
    t.uuid('tank_mix_id').nullable().references('id').inTable('tank_mixes').onDelete('SET NULL');
    t.integer('sqft_treated');
    t.jsonb('products_used').defaultTo('[]');           // [{ product_id, name, amount, unit, cost }]
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('customer_id');
    t.index('service_date');
    t.index('service_type');
  });

  // ── Seed equipment ───────────────────────────────────────────
  const EQUIPMENT_SEED = [
    { name: '110-Gallon Spray Tank #1', category: 'sprayer', specs: { tank_capacity_gal: 110 } },
    { name: '110-Gallon Spray Tank #2', category: 'sprayer', specs: { tank_capacity_gal: 110 } },
    { name: 'Udor KAPPA-18/12-HP Volt Diaphragm Pump', category: 'pump', make: 'Udor', model: 'KAPPA-18/12-HP' },
    { name: 'Udor KAPPA-55/GR5 & Honda GX160 Engine Assembly', category: 'pump', make: 'Udor', model: 'KAPPA-55/GR5', specs: { engine: 'Honda GX160' } },
    { name: 'FlowZone Typhoon Backpack Sprayer', category: 'backpack', make: 'FlowZone', model: 'Typhoon' },
    { name: 'Hannay Reel #1 + 300ft Line', category: 'reel', make: 'Hannay', specs: { hose_length_ft: 300 } },
    { name: 'Hannay Reel #2 + 300ft Line', category: 'reel', make: 'Hannay', specs: { hose_length_ft: 300 } },
    { name: 'LESCO Lawn Spray Gun', category: 'sprayer', make: 'LESCO', model: 'Lawn Spray Gun' },
    { name: 'LESCO MAG1 Original Spray Gun', category: 'sprayer', make: 'LESCO', model: 'MAG1' },
    { name: 'EcoLawn 250 TopDresser/Spreader', category: 'spreader', make: 'EcoLawn', model: '250', specs: { capacity_cuft: 11.5, engine: 'Honda 5.5HP' }, purchase_price: 6800, status: 'pending' },
    { name: 'Classen TR-20H Dethatcher', category: 'dethatcher', make: 'Classen', model: 'TR-20H', purchase_price: 3500, status: 'pending' },
  ];

  for (const eq of EQUIPMENT_SEED) {
    await knex('equipment').insert({
      id: uuidv4(),
      name: eq.name,
      category: eq.category || null,
      make: eq.make || null,
      model: eq.model || null,
      purchase_price: eq.purchase_price || null,
      status: eq.status || 'active',
      specs: eq.specs ? JSON.stringify(eq.specs) : null,
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('job_costs');
  await knex.schema.dropTableIfExists('tank_mixes');
  await knex.schema.dropTableIfExists('equipment_maintenance_log');
  await knex.schema.dropTableIfExists('equipment');
};
