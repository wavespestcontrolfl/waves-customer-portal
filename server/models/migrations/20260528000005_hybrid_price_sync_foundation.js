const VENDOR_SYNC = [
  ['SiteOne', {
    sync_method: 'portal_connector',
    credential_status: 'needs_login',
    sync_frequency_minutes: 360,
    sync_method_notes: 'Preferred first connector. Account pricing and local branch availability should come from approved feed or portal-backed connector.',
  }],
  ['Target Specialty Products', {
    sync_method: 'workwave_marketplace',
    credential_status: 'needs_rep_setup',
    sync_frequency_minutes: 1440,
    sync_method_notes: 'Investigate Target/WorkWave/PestPac route before scraping.',
  }],
  ['Amazon', {
    sync_method: 'api',
    credential_status: 'needs_api_key',
    sync_frequency_minutes: 60,
    sync_method_notes: 'Use Amazon Business Product Search API for account/native procurement pricing; avoid normal Amazon scraping.',
  }],
  ['Reinders', {
    sync_method: 'approved_feed',
    credential_status: 'needs_rep_setup',
    sync_frequency_minutes: 1440,
    sync_method_notes: 'Business account supports custom pricing and real-time inventory; request feed or approved portal access.',
  }],
  ['Ewing Outdoor Supply', {
    sync_method: 'approved_feed',
    credential_status: 'needs_rep_setup',
    sync_frequency_minutes: 1440,
    sync_method_notes: 'Use account-pricing portal/feed where available.',
  }],
  ['BWI Companies', {
    sync_method: 'approved_feed',
    credential_status: 'needs_rep_setup',
    sync_frequency_minutes: 1440,
    sync_method_notes: 'Request CSV/SFTP/API/EDI feed. Avoid unapproved scraping.',
  }],
  ['Helena Agri-Enterprises', {
    sync_method: 'approved_feed',
    credential_status: 'needs_rep_setup',
    sync_frequency_minutes: 1440,
    sync_method_notes: 'Ask Helena Agri Hub/account rep for price and availability export or feed.',
  }],
  ['Veseris', {
    sync_method: 'approved_feed',
    credential_status: 'needs_rep_setup',
    sync_frequency_minutes: 1440,
    sync_method_notes: 'Ask for product/price feed or portal-approved access.',
  }],
  ['Sun Spot Supply', {
    sync_method: 'manual_csv',
    credential_status: 'manual',
    sync_frequency_minutes: 10080,
    sync_method_notes: 'Start with recurring price sheet import.',
  }],
];

const PUBLIC_SCRAPER_VENDORS = [
  'Chemical Warehouse',
  'DIY Pest Control',
  'DoMyOwn',
  'Forestry Distributing',
  'GCI Turf Academy',
  'Geoponics',
  'Golf Course Lawn Store',
  'Intermountain Turf',
  'Keystone Pest Solutions',
  'SeedBarn',
  'Seed World USA',
  'Solutions Pest & Lawn',
  'SprinklerJet',
];

async function addColumnIfMissing(knex, table, column, add) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('vendors')) {
    await addColumnIfMissing(knex, 'vendors', 'credential_status', (t) => t.string('credential_status', 40));
    await addColumnIfMissing(knex, 'vendors', 'sync_method', (t) => t.string('sync_method', 40));
    await addColumnIfMissing(knex, 'vendors', 'sync_method_notes', (t) => t.text('sync_method_notes'));
    await addColumnIfMissing(knex, 'vendors', 'sync_frequency_minutes', (t) => t.integer('sync_frequency_minutes'));
    await addColumnIfMissing(knex, 'vendors', 'manual_refresh_enabled', (t) => t.boolean('manual_refresh_enabled').defaultTo(true));

    for (const [name, fields] of VENDOR_SYNC) {
      await knex('vendors')
        .whereRaw('LOWER(name) = LOWER(?)', [name])
        .update({ ...fields, manual_refresh_enabled: true, updated_at: new Date() });
    }

    await knex('vendors')
      .whereIn('name', PUBLIC_SCRAPER_VENDORS)
      .update({
        sync_method: 'public_scraper',
        credential_status: 'not_required',
        sync_frequency_minutes: 1440,
        manual_refresh_enabled: true,
        sync_method_notes: 'Public-price monitoring only. Prefer mapped product URLs over search scraping.',
        updated_at: new Date(),
      });
  }

  if (!(await knex.schema.hasTable('distributor_product_map'))) {
    await knex.schema.createTable('distributor_product_map', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
      t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.string('distributor_sku', 100);
      t.string('manufacturer_sku', 100);
      t.string('upc', 40);
      t.string('source_url', 700);
      t.string('pack_size', 80);
      t.string('uom', 30);
      t.decimal('case_quantity', 10, 4);
      t.decimal('confidence_score', 5, 2).defaultTo(0.50);
      t.boolean('active').defaultTo(true);
      t.text('notes');
      t.timestamps(true, true);
      t.index(['product_id', 'vendor_id']);
      t.index('vendor_id');
      t.index('distributor_sku');
      t.index('manufacturer_sku');
      t.index('upc');
    });
  }

  if (await knex.schema.hasTable('vendor_pricing')) {
    await addColumnIfMissing(knex, 'vendor_pricing', 'source_type', (t) => t.string('source_type', 30));
    await addColumnIfMissing(knex, 'vendor_pricing', 'confidence_score', (t) => t.decimal('confidence_score', 5, 2));
    await addColumnIfMissing(knex, 'vendor_pricing', 'availability', (t) => t.string('availability', 80));
    await addColumnIfMissing(knex, 'vendor_pricing', 'branch_location', (t) => t.string('branch_location', 120));
    await addColumnIfMissing(knex, 'vendor_pricing', 'expires_at', (t) => t.timestamp('expires_at'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'normalized_unit_price', (t) => t.decimal('normalized_unit_price', 12, 4));

    await knex('vendor_pricing')
      .whereNull('source_type')
      .update({
        source_type: 'manual_seed',
        confidence_score: 0.70,
        updated_at: new Date(),
      });
  }

  if (!(await knex.schema.hasTable('price_snapshots'))) {
    await knex.schema.createTable('price_snapshots', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
      t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.uuid('vendor_pricing_id').references('id').inTable('vendor_pricing').onDelete('SET NULL');
      t.decimal('price', 10, 2).notNullable();
      t.string('quantity', 80);
      t.string('uom', 30);
      t.decimal('normalized_unit_price', 12, 4);
      t.string('normalized_unit', 30);
      t.string('availability', 80);
      t.string('branch_location', 120);
      t.decimal('min_order_qty', 10, 4);
      t.decimal('shipping_estimate', 10, 2);
      t.timestamp('fetched_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('expires_at');
      t.string('source_type', 30).notNullable().defaultTo('manual');
      t.decimal('confidence_score', 5, 2).defaultTo(0.50);
      t.string('source_url', 700);
      t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamps(true, true);
      t.index(['product_id', 'vendor_id']);
      t.index(['source_type', 'fetched_at']);
      t.index('expires_at');
    });
  }

  if (!(await knex.schema.hasTable('price_refresh_requests'))) {
    await knex.schema.createTable('price_refresh_requests', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
      t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.string('status', 24).notNullable().defaultTo('queued');
      t.string('source_type', 30);
      t.text('notes');
      t.string('requested_by', 120);
      t.timestamp('requested_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('started_at');
      t.timestamp('completed_at');
      t.text('last_error');
      t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamps(true, true);
      t.index(['status', 'requested_at']);
      t.index(['product_id', 'vendor_id']);
    });
  }

  if (await knex.schema.hasTable('price_snapshots') && await knex.schema.hasTable('vendor_pricing')) {
    const existingSnapshotIds = await knex('price_snapshots')
      .whereNotNull('vendor_pricing_id')
      .pluck('vendor_pricing_id');

    const rows = await knex('vendor_pricing')
      .whereNotNull('price')
      .modify((query) => {
        if (existingSnapshotIds.length) query.whereNotIn('id', existingSnapshotIds);
      })
      .select('*');

    for (const row of rows) {
      await knex('price_snapshots').insert({
        product_id: row.product_id,
        vendor_id: row.vendor_id,
        vendor_pricing_id: row.id,
        price: row.price,
        quantity: row.quantity,
        uom: row.unit,
        normalized_unit_price: row.normalized_unit_price || row.price_per_oz || null,
        normalized_unit: row.unit_normalized || null,
        availability: row.availability || null,
        branch_location: row.branch_location || null,
        shipping_estimate: row.shipping_cost || null,
        fetched_at: row.last_checked_at || row.updated_at || knex.fn.now(),
        expires_at: row.expires_at || null,
        source_type: row.source_type || 'manual_seed',
        confidence_score: row.confidence_score || 0.70,
        source_url: row.vendor_product_url || null,
        metadata: JSON.stringify({ backfilledFrom: 'vendor_pricing' }),
      });
    }
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('price_refresh_requests');
  await knex.schema.dropTableIfExists('price_snapshots');
  await knex.schema.dropTableIfExists('distributor_product_map');

  if (await knex.schema.hasTable('vendor_pricing')) {
    for (const column of ['normalized_unit_price', 'expires_at', 'branch_location', 'availability', 'confidence_score', 'source_type']) {
      if (await knex.schema.hasColumn('vendor_pricing', column)) {
        await knex.schema.alterTable('vendor_pricing', (t) => t.dropColumn(column));
      }
    }
  }

  if (await knex.schema.hasTable('vendors')) {
    for (const column of ['manual_refresh_enabled', 'sync_frequency_minutes', 'sync_method_notes', 'sync_method', 'credential_status']) {
      if (await knex.schema.hasColumn('vendors', column)) {
        await knex.schema.alterTable('vendors', (t) => t.dropColumn(column));
      }
    }
  }
};
