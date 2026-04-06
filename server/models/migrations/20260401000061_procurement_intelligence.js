/**
 * Migration 061 — Procurement Intelligence
 *
 * 6 new tables + enhancements to existing vendor/product tables.
 * Adds price scraping jobs, approval queue, price history,
 * service COGS mappings, product aliases, and auto-approve rules.
 */
exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // ── Price scrape jobs: track each scrape attempt per vendor ──
  await knex.schema.createTable('price_scrape_jobs', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
    t.string('status', 20).defaultTo('pending'); // pending, running, completed, failed
    t.integer('products_found').defaultTo(0);
    t.integer('prices_updated').defaultTo(0);
    t.integer('prices_new').defaultTo(0);
    t.integer('errors').defaultTo(0);
    t.text('error_message');
    t.integer('duration_ms');
    t.timestamp('started_at');
    t.timestamp('completed_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('vendor_id');
    t.index('status');
    t.index('created_at');
  });

  // ── Price approvals: queue for human review of scraped price changes ──
  await knex.schema.createTable('price_approvals', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
    t.uuid('scrape_job_id').references('id').inTable('price_scrape_jobs').onDelete('SET NULL');
    t.decimal('old_price', 10, 2);
    t.decimal('new_price', 10, 2).notNullable();
    t.decimal('price_change_pct', 6, 2); // e.g. +12.50 or -5.00
    t.string('old_quantity', 50);
    t.string('new_quantity', 50);
    t.string('source_url', 500);
    t.string('status', 20).defaultTo('pending'); // pending, approved, rejected, auto_approved
    t.string('reviewed_by', 100);
    t.timestamp('reviewed_at');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('product_id');
    t.index('vendor_id');
    t.index('status');
    t.index('created_at');
  });

  // ── Price history: every price we've ever recorded ──
  await knex.schema.createTable('price_history', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
    t.decimal('price', 10, 2).notNullable();
    t.string('quantity', 50);
    t.string('source', 30); // scrape, manual, import, api
    t.timestamp('recorded_at').defaultTo(knex.fn.now());
    t.index(['product_id', 'vendor_id']);
    t.index('recorded_at');
  });

  // ── Service product usage: COGS mapping (which products each service uses) ──
  await knex.schema.createTable('service_product_usage', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('service_type', 50).notNullable(); // e.g. 'General Pest Control', 'Lawn Care 9x'
    t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.decimal('usage_amount', 10, 4); // how much per application
    t.string('usage_unit', 20); // oz, lb, gal, each
    t.decimal('usage_per_1000sf', 10, 4); // rate per 1000 sf (for area-based)
    t.boolean('is_primary').defaultTo(false); // main product vs adjuvant/additive
    t.text('notes');
    t.timestamps(true, true);
    t.index('service_type');
    t.index('product_id');
  });

  // ── Product aliases: map scraper product names to canonical catalog names ──
  await knex.schema.createTable('product_aliases', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
    t.string('alias_name', 300).notNullable();
    t.uuid('vendor_id').references('id').inTable('vendors').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['alias_name', 'vendor_id']);
    t.index('product_id');
  });

  // ── Auto-approve rules: automatically approve price changes within thresholds ──
  await knex.schema.createTable('price_auto_approve_rules', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('vendor_id').references('id').inTable('vendors').onDelete('CASCADE');
    t.uuid('product_id').references('id').inTable('products_catalog').onDelete('CASCADE');
    t.string('category', 100); // apply to all products in category
    t.decimal('max_increase_pct', 6, 2).defaultTo(5.00); // auto-approve if increase <= 5%
    t.decimal('max_decrease_pct', 6, 2).defaultTo(99.00); // auto-approve any decrease up to 99%
    t.boolean('enabled').defaultTo(true);
    t.timestamps(true, true);
  });

  // ── Enhance vendors table ──
  const vendorCols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'vendors'");
  const vendorColNames = vendorCols.rows.map(r => r.column_name);

  if (!vendorColNames.includes('last_scrape_at')) {
    await knex.schema.alterTable('vendors', t => {
      t.timestamp('last_scrape_at');
      t.string('last_scrape_status', 20);
      t.integer('scrape_product_count').defaultTo(0);
      t.string('scrape_schedule', 20).defaultTo('weekly'); // daily, weekly, monthly, manual
    });
  }

  // ── Enhance vendor_pricing table ──
  const vpCols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'vendor_pricing'");
  const vpColNames = vpCols.rows.map(r => r.column_name);

  if (!vpColNames.includes('shipping_cost')) {
    await knex.schema.alterTable('vendor_pricing', t => {
      t.decimal('shipping_cost', 8, 2);
      t.decimal('tax_rate', 5, 4); // e.g. 0.0700 for 7%
      t.decimal('landed_cost', 10, 2); // price + shipping + tax
      t.string('unit_normalized', 20); // oz, lb, gal — canonical unit
      t.decimal('price_per_oz', 10, 4); // normalized $/oz for comparison
    });
  }

  // ── Enhance products_catalog table ──
  const pcCols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'products_catalog'");
  const pcColNames = pcCols.rows.map(r => r.column_name);

  if (!pcColNames.includes('unit_size_oz')) {
    await knex.schema.alterTable('products_catalog', t => {
      t.decimal('unit_size_oz', 10, 2); // canonical size in oz
      t.string('unit_type', 20); // liquid, granular, bait, gel
      t.decimal('monthly_usage_estimate', 10, 2); // estimated monthly usage in oz
      t.decimal('monthly_cost_estimate', 10, 2); // estimated monthly cost
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('price_auto_approve_rules');
  await knex.schema.dropTableIfExists('product_aliases');
  await knex.schema.dropTableIfExists('service_product_usage');
  await knex.schema.dropTableIfExists('price_history');
  await knex.schema.dropTableIfExists('price_approvals');
  await knex.schema.dropTableIfExists('price_scrape_jobs');

  // Remove added columns (best-effort)
  try {
    await knex.schema.alterTable('vendors', t => {
      t.dropColumn('last_scrape_at');
      t.dropColumn('last_scrape_status');
      t.dropColumn('scrape_product_count');
      t.dropColumn('scrape_schedule');
    });
  } catch { /* ignore */ }

  try {
    await knex.schema.alterTable('vendor_pricing', t => {
      t.dropColumn('shipping_cost');
      t.dropColumn('tax_rate');
      t.dropColumn('landed_cost');
      t.dropColumn('unit_normalized');
      t.dropColumn('price_per_oz');
    });
  } catch { /* ignore */ }

  try {
    await knex.schema.alterTable('products_catalog', t => {
      t.dropColumn('unit_size_oz');
      t.dropColumn('unit_type');
      t.dropColumn('monthly_usage_estimate');
      t.dropColumn('monthly_cost_estimate');
    });
  } catch { /* ignore */ }
};
