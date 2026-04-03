exports.up = async function (knex) {
  // Vendors table
  await knex.schema.createTable('vendors', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('name', 100).notNullable().unique();
    t.string('type', 30); // primary, online, distributor, regional, manufacturer_direct, competitor_reference
    t.string('website', 300);
    t.text('notes');
    t.boolean('price_scraping_enabled').defaultTo(false);
    t.string('scraping_priority', 10); // high, medium, skip
    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
  });

  // Enhanced products catalog (replace the simple one if it exists)
  // The existing products_catalog from dispatch migration has basic products
  // This adds vendor pricing tracking
  await knex.schema.createTable('vendor_pricing', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
    t.decimal('price', 10, 2);
    t.string('quantity', 50);
    t.string('unit', 30);
    t.string('vendor_product_url', 500);
    t.string('vendor_sku', 50);
    t.boolean('is_best_price').defaultTo(false);
    t.timestamp('last_checked_at');
    t.decimal('previous_price', 10, 2);
    t.timestamps(true, true);

    t.unique(['product_id', 'vendor_id']);
    t.index('product_id');
    t.index('vendor_id');
  });

  // Add more fields to products_catalog
  await knex.schema.alterTable('products_catalog', (t) => {
    t.string('sku', 50);
    t.string('formulation', 50); // WDG, SC, EC, granular, liquid, gel, bait
    t.string('container_size', 50);
    t.decimal('best_price', 10, 2);
    t.string('best_vendor', 100);
    t.boolean('needs_pricing').defaultTo(true);
    t.decimal('cost_per_unit', 10, 4); // cost per oz, lb, gal for usage calculations
    t.string('cost_unit', 20);
  });

  // Seed vendors
  const vendorData = [
    { name: 'SiteOne', type: 'primary', website: 'https://www.siteone.com', notes: 'Branch #238 Lakewood Ranch, 5115 Lena Road. Pro account.', scraping_priority: 'medium' },
    { name: 'Amazon', type: 'online', website: 'https://www.amazon.com', notes: 'Amazon Business account.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Solutions Pest & Lawn', type: 'online', website: 'https://www.solutionsstores.com', notes: 'Good prices on herbicides, pest products.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'DoMyOwn', type: 'online', website: 'https://www.domyown.com', notes: 'Competitive on pest control products.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Forestry Distributing', type: 'online', website: 'https://www.forestrydistributing.com', notes: 'Fungicides, specialty products.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Chemical Warehouse', type: 'online', website: 'https://chemicalwarehouse.com', notes: 'Specialty insecticides.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Seed World USA', type: 'online', website: 'https://www.seedworldusa.com', notes: 'Herbicides, insecticides.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Intermountain Turf', type: 'online', website: 'https://www.intermountainturf.com', notes: 'Specialty turf products.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Keystone Pest Solutions', type: 'online', website: 'https://www.keystonepestsolutions.com', notes: 'Bifenthrin products.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Veseris', type: 'distributor', website: 'https://www.veseris.com', notes: 'Pro distributor, rodent/pest supplies.', scraping_priority: 'medium' },
    { name: 'Ewing Outdoor Supply', type: 'distributor', website: 'https://www.ewingirrigation.com', notes: 'Irrigation, turf, landscape supplies. FL locations.', scraping_priority: 'medium' },
    { name: 'GCI Turf Academy', type: 'online', website: 'https://gciturfacademy.com', notes: 'Lawn care products, good pricing on turf chemicals.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'DIY Pest Control', type: 'online', website: 'https://www.diypestcontrol.com', notes: 'Competitive pest products.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'SprinklerJet', type: 'online', website: 'https://www.sprinklerjet.com', notes: 'Irrigation + turf supplies.', scraping_priority: 'high' },
    { name: 'SeedBarn', type: 'online', website: 'https://www.seedbarn.com', notes: 'Seed, fertilizer, turf products.', scraping_priority: 'high' },
    { name: 'Reinders', type: 'distributor', website: 'https://www.reinders.com', notes: 'Turf & landscape distributor.', scraping_priority: 'medium' },
    { name: 'Sun Spot Supply', type: 'regional', website: '', notes: 'FL-based supply.', scraping_priority: 'skip' },
    { name: 'Golf Course Lawn Store', type: 'online', website: 'https://www.golfcourselawnstore.com', notes: 'Pro-grade turf products at retail prices.', scraping_priority: 'high', price_scraping_enabled: true },
    { name: 'Geoponics', type: 'manufacturer_direct', website: 'https://www.geoponics.com', notes: 'Naples FL. Endurant + Penterra manufacturer. Local pickup.', scraping_priority: 'medium' },
    { name: 'Target Specialty Products', type: 'distributor', website: 'https://www.target-specialty.com', notes: 'Regional turf & ornamental distributor.', scraping_priority: 'medium' },
    { name: 'BWI Companies', type: 'distributor', website: 'https://www.bfrg.com', notes: 'Turf & ornamental distributor.', scraping_priority: 'medium' },
    { name: 'Helena Agri-Enterprises', type: 'distributor', website: 'https://www.helenaagri.com', notes: 'Regional agricultural/turf distributor.', scraping_priority: 'medium' },
    { name: 'TruGreen', type: 'competitor_reference', website: '', notes: 'Competitor product reference only.', scraping_priority: 'skip', active: false },
  ];

  await knex('vendors').insert(vendorData);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('products_catalog', (t) => {
    t.dropColumn('sku');
    t.dropColumn('formulation');
    t.dropColumn('container_size');
    t.dropColumn('best_price');
    t.dropColumn('best_vendor');
    t.dropColumn('needs_pricing');
    t.dropColumn('cost_per_unit');
    t.dropColumn('cost_unit');
  });
  await knex.schema.dropTableIfExists('vendor_pricing');
  await knex.schema.dropTableIfExists('vendors');
};
