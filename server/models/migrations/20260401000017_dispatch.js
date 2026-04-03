exports.up = async function (knex) {
  // Service status log
  await knex.schema.createTable('service_status_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.string('status', 30).notNullable();
    t.uuid('changed_by').references('id').inTable('technicians');
    t.decimal('lat', 10, 6);
    t.decimal('lng', 10, 6);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('scheduled_service_id');
  });

  // Enhance scheduled_services
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('actual_start_time');
    t.timestamp('actual_end_time');
    t.integer('drive_time_minutes');
    t.integer('service_time_minutes');
    t.integer('route_order');
  });

  // Products catalog
  await knex.schema.createTable('products_catalog', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 150).notNullable();
    t.string('category', 30);
    t.string('active_ingredient', 150);
    t.string('moa_group', 30);
    t.string('default_rate', 50);
    t.string('default_unit', 30);
    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
  });

  // Seed products
  const products = [
    { name: 'Demand CS', category: 'insecticide', active_ingredient: 'Lambda-cyhalothrin', moa_group: 'Group 3A', default_rate: '0.8', default_unit: 'oz/1000sf' },
    { name: 'Advion WDG Granular', category: 'insecticide', active_ingredient: 'Indoxacarb', moa_group: 'Group 22A' },
    { name: 'Alpine WSG', category: 'insecticide', active_ingredient: 'Dinotefuran', moa_group: 'Group 4A', default_rate: '0.5', default_unit: 'oz/gal' },
    { name: 'Bifen I/T', category: 'insecticide', active_ingredient: 'Bifenthrin', moa_group: 'Group 3A' },
    { name: 'Cyzmic CS', category: 'insecticide', active_ingredient: 'Lambda-cyhalothrin', moa_group: 'Group 3A' },
    { name: 'Suspend Polyzone', category: 'insecticide', active_ingredient: 'Deltamethrin', moa_group: 'Group 3A' },
    { name: 'Gentrol IGR', category: 'IGR', active_ingredient: 'Hydroprene' },
    { name: 'Tekko Pro IGR', category: 'IGR', active_ingredient: 'Pyriproxyfen + Novaluron' },
    { name: 'Vendetta Plus', category: 'bait', active_ingredient: 'Abamectin + Pyriproxyfen' },
    { name: 'Advion Cockroach Gel', category: 'bait', active_ingredient: 'Indoxacarb' },
    { name: 'Celsius WG', category: 'herbicide', active_ingredient: 'Thiencarbazone + Iodosulfuron + Dicamba', moa_group: 'Group 2' },
    { name: 'Prodiamine 65 WDG', category: 'herbicide', active_ingredient: 'Prodiamine', moa_group: 'Group 3' },
    { name: 'Dismiss NXT', category: 'herbicide', active_ingredient: 'Sulfentrazone', moa_group: 'Group 14' },
    { name: 'Headway G', category: 'fungicide', active_ingredient: 'Azoxystrobin + Propiconazole', moa_group: 'Group 11 + 3' },
    { name: 'Pillar G Intrinsic', category: 'fungicide', active_ingredient: 'Pyraclostrobin + Triticonazole', moa_group: 'Group 11 + 3' },
    { name: 'Heritage G', category: 'fungicide', active_ingredient: 'Azoxystrobin', moa_group: 'Group 11' },
    { name: '16-4-8 + Micros', category: 'fertilizer' },
    { name: '0-0-16 Winterizer', category: 'fertilizer' },
    { name: '24-0-11 50% MESA', category: 'fertilizer' },
    { name: 'FeSO4 Foliar', category: 'fertilizer', active_ingredient: 'Ferrous sulfate' },
    { name: 'Chelated Iron 6%', category: 'fertilizer' },
    { name: 'Non-ionic Surfactant', category: 'adjuvant' },
    { name: 'Bora-Care', category: 'termiticide', active_ingredient: 'Disodium Octaborate Tetrahydrate' },
    { name: 'Termidor SC', category: 'termiticide', active_ingredient: 'Fipronil', moa_group: 'Group 2B' },
    { name: 'Trelona ATBS', category: 'termite bait', active_ingredient: 'Novaluron' },
    { name: 'Contrac Blox', category: 'rodenticide', active_ingredient: 'Bromadiolone' },
    { name: 'Talpirid', category: 'mole bait', active_ingredient: 'Bromethalin' },
  ];

  await knex('products_catalog').insert(products);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('products_catalog');
  await knex.schema.dropTableIfExists('service_status_log');
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('actual_start_time');
    t.dropColumn('actual_end_time');
    t.dropColumn('drive_time_minutes');
    t.dropColumn('service_time_minutes');
    t.dropColumn('route_order');
  });
};
