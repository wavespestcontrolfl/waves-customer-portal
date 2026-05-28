const CONNECTION_TYPES = [
  'api',
  'approved_feed',
  'portal_connector',
  'manual_csv',
  'manual_seed',
  'public_scraper',
  'workwave_marketplace',
];

const APPROVAL_STATUSES = ['not_requested', 'requested', 'approved', 'rejected', 'disabled'];
const CREDENTIAL_STATUSES = ['not_required', 'missing', 'configured', 'expired', 'failed'];
const MAPPING_STATUSES = ['needs_mapping', 'mapped_unverified', 'verified', 'rejected', 'inactive'];
const PRICE_TYPES = ['account', 'contract', 'public', 'promo', 'quote', 'manual', 'manual_seed'];
const PRICE_APPROVAL_STATUSES = ['pending', 'approved', 'auto_approved', 'needs_review', 'rejected'];
const AVAILABILITY_STATUSES = ['in_stock', 'limited', 'out_of_stock', 'backorder', 'unknown'];
const BEST_PRICE_STATUSES = ['current', 'stale', 'needs_mapping', 'needs_approval', 'no_valid_price'];

async function addColumnIfMissing(knex, table, column, add) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function addConstraintIfMissing(knex, name, sql) {
  const found = await knex('pg_constraint').where({ conname: name }).first();
  if (!found) await knex.raw(sql);
}

async function createDefaultConnections(knex) {
  const vendors = await knex('vendors').select('*');
  for (const vendor of vendors) {
    const name = String(vendor.name || '').toLowerCase();
    const methods = new Set(['manual_seed']);
    const syncMethod = vendor.sync_method === 'approved_integration'
      ? 'workwave_marketplace'
      : vendor.sync_method;

    if (syncMethod) methods.add(syncMethod);
    else if (name.includes('siteone')) methods.add('portal_connector');
    else if (name.includes('amazon')) methods.add('api');
    else if (name.includes('target')) methods.add('workwave_marketplace');
    else if (['reinders', 'ewing', 'bwi', 'helena', 'veseris'].some((needle) => name.includes(needle))) methods.add('approved_feed');
    else if (vendor.price_scraping_enabled) methods.add('public_scraper');

    for (const method of methods) {
      if (!CONNECTION_TYPES.includes(method)) continue;
      const existing = await knex('vendor_connections')
        .where({ vendor_id: vendor.id, connection_type: method })
        .whereRaw("COALESCE(display_name, 'default') = 'default'")
        .first();
      if (existing) continue;

      const needsCredential = ['api', 'approved_feed', 'portal_connector', 'workwave_marketplace'].includes(method);
      await knex('vendor_connections').insert({
        vendor_id: vendor.id,
        connection_type: method,
        approval_status: method === 'manual_seed' ? 'approved' : 'not_requested',
        credential_status: needsCredential ? 'missing' : 'not_required',
        supports_account_pricing: ['api', 'approved_feed', 'portal_connector', 'manual_csv', 'manual_seed', 'workwave_marketplace'].includes(method),
        supports_public_pricing: method === 'public_scraper',
        supports_inventory: ['api', 'approved_feed', 'portal_connector', 'workwave_marketplace'].includes(method),
        supports_branch_availability: ['approved_feed', 'portal_connector', 'workwave_marketplace'].includes(method),
        supports_bulk_pricing: ['api', 'approved_feed', 'manual_csv', 'manual_seed', 'workwave_marketplace'].includes(method),
        rate_limit_seconds: method === 'public_scraper' ? 30 : null,
        config_json: JSON.stringify({
          seededFromVendor: true,
          previousSyncMethod: vendor.sync_method || null,
        }),
      });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('vendors'))) return;

  if (!(await knex.schema.hasTable('vendor_connections'))) {
    await knex.schema.createTable('vendor_connections', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.string('connection_type', 40).notNullable();
      t.text('display_name');
      t.string('approval_status', 30).notNullable().defaultTo('not_requested');
      t.string('credential_status', 30).notNullable().defaultTo('not_required');
      t.text('credentials_ref');
      t.jsonb('config_json').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.boolean('supports_account_pricing').notNullable().defaultTo(false);
      t.boolean('supports_public_pricing').notNullable().defaultTo(false);
      t.boolean('supports_inventory').notNullable().defaultTo(false);
      t.boolean('supports_branch_availability').notNullable().defaultTo(false);
      t.boolean('supports_bulk_pricing').notNullable().defaultTo(false);
      t.integer('rate_limit_seconds');
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('last_success_at', { useTz: true });
      t.timestamp('last_failure_at', { useTz: true });
      t.text('failure_reason');
      t.timestamps(true, true);
      t.index('vendor_id');
      t.index(['connection_type', 'is_active']);
    });
  }

  await addConstraintIfMissing(knex, 'vendor_connections_type_check', `
    ALTER TABLE vendor_connections
    ADD CONSTRAINT vendor_connections_type_check
    CHECK (connection_type IN (${CONNECTION_TYPES.map((s) => `'${s}'`).join(', ')}))
  `);
  await addConstraintIfMissing(knex, 'vendor_connections_approval_status_check', `
    ALTER TABLE vendor_connections
    ADD CONSTRAINT vendor_connections_approval_status_check
    CHECK (approval_status IN (${APPROVAL_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);
  await addConstraintIfMissing(knex, 'vendor_connections_credential_status_check', `
    ALTER TABLE vendor_connections
    ADD CONSTRAINT vendor_connections_credential_status_check
    CHECK (credential_status IN (${CREDENTIAL_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_connections_unique
    ON vendor_connections(vendor_id, connection_type, COALESCE(display_name, 'default'))
  `);

  await createDefaultConnections(knex);

  if (await knex.schema.hasTable('distributor_product_map')) {
    await addColumnIfMissing(knex, 'distributor_product_map', 'vendor_connection_id', (t) => t.uuid('vendor_connection_id').references('id').inTable('vendor_connections').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'distributor_product_map', 'mapping_status', (t) => t.string('mapping_status', 30).notNullable().defaultTo('needs_mapping'));
    await addColumnIfMissing(knex, 'distributor_product_map', 'mapping_confidence', (t) => t.decimal('mapping_confidence', 4, 3).notNullable().defaultTo(0));
    await addColumnIfMissing(knex, 'distributor_product_map', 'product_url', (t) => t.text('product_url'));
    await addColumnIfMissing(knex, 'distributor_product_map', 'vendor_product_name', (t) => t.text('vendor_product_name'));
    await addColumnIfMissing(knex, 'distributor_product_map', 'asin', (t) => t.string('asin', 40));
    await addColumnIfMissing(knex, 'distributor_product_map', 'epa_registration_number', (t) => t.string('epa_registration_number', 80));
    await addColumnIfMissing(knex, 'distributor_product_map', 'package_size_value', (t) => t.decimal('package_size_value', 12, 4));
    await addColumnIfMissing(knex, 'distributor_product_map', 'package_size_unit', (t) => t.string('package_size_unit', 30));
    await addColumnIfMissing(knex, 'distributor_product_map', 'purchase_uom', (t) => t.string('purchase_uom', 30));
    await addColumnIfMissing(knex, 'distributor_product_map', 'content_quantity', (t) => t.decimal('content_quantity', 12, 4));
    await addColumnIfMissing(knex, 'distributor_product_map', 'content_uom', (t) => t.string('content_uom', 30));
    await addColumnIfMissing(knex, 'distributor_product_map', 'pack_count', (t) => t.decimal('pack_count', 12, 4).defaultTo(1));
    await addColumnIfMissing(knex, 'distributor_product_map', 'branch_id', (t) => t.string('branch_id', 80));
    await addColumnIfMissing(knex, 'distributor_product_map', 'branch_name', (t) => t.string('branch_name', 160));
    await addColumnIfMissing(knex, 'distributor_product_map', 'verified_by', (t) => t.string('verified_by', 120));
    await addColumnIfMissing(knex, 'distributor_product_map', 'verified_at', (t) => t.timestamp('verified_at', { useTz: true }));
    await addColumnIfMissing(knex, 'distributor_product_map', 'last_checked_at', (t) => t.timestamp('last_checked_at', { useTz: true }));

    await knex('distributor_product_map')
      .whereNull('product_url')
      .whereNotNull('source_url')
      .update({ product_url: knex.ref('source_url') })
      .catch(() => {});

    await knex.raw(`
      UPDATE distributor_product_map dpm
      SET vendor_connection_id = vc.id
      FROM vendor_connections vc
      WHERE dpm.vendor_connection_id IS NULL
        AND vc.vendor_id = dpm.vendor_id
        AND vc.connection_type = 'manual_seed'
    `);

    await knex('distributor_product_map')
      .where(function incompleteMap() {
        this.whereNull('mapping_status').orWhere({ mapping_status: 'needs_mapping' });
      })
      .update({
        mapping_status: 'mapped_unverified',
        mapping_confidence: 0.50,
      });

    await addConstraintIfMissing(knex, 'distributor_product_map_status_check', `
      ALTER TABLE distributor_product_map
      ADD CONSTRAINT distributor_product_map_status_check
      CHECK (mapping_status IN (${MAPPING_STATUSES.map((s) => `'${s}'`).join(', ')}))
    `);
    await addConstraintIfMissing(knex, 'distributor_product_map_confidence_check', `
      ALTER TABLE distributor_product_map
      ADD CONSTRAINT distributor_product_map_confidence_check
      CHECK (mapping_confidence >= 0 AND mapping_confidence <= 1)
    `);
    await addConstraintIfMissing(knex, 'distributor_product_map_verified_required_check', `
      ALTER TABLE distributor_product_map
      ADD CONSTRAINT distributor_product_map_verified_required_check
      CHECK (
        mapping_status <> 'verified'
        OR (
          vendor_connection_id IS NOT NULL
          AND package_size_value IS NOT NULL
          AND package_size_unit IS NOT NULL
          AND purchase_uom IS NOT NULL
          AND verified_at IS NOT NULL
          AND (
            distributor_sku IS NOT NULL
            OR product_url IS NOT NULL
            OR manufacturer_sku IS NOT NULL
            OR upc IS NOT NULL
            OR asin IS NOT NULL
          )
        )
      )
    `);
  }

  if (await knex.schema.hasTable('vendor_pricing')) {
    await addColumnIfMissing(knex, 'vendor_pricing', 'vendor_connection_id', (t) => t.uuid('vendor_connection_id').references('id').inTable('vendor_connections').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'distributor_product_map_id', (t) => t.uuid('distributor_product_map_id').references('id').inTable('distributor_product_map').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'latest_snapshot_id', (t) => t.uuid('latest_snapshot_id'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'price_type', (t) => t.string('price_type', 30).notNullable().defaultTo('manual'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'approval_status', (t) => t.string('approval_status', 30).notNullable().defaultTo('pending'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'price_amount', (t) => t.decimal('price_amount', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'currency', (t) => t.string('currency', 3).notNullable().defaultTo('USD'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'landed_unit_price', (t) => t.decimal('landed_unit_price', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'availability_status', (t) => t.string('availability_status', 30).defaultTo('unknown'));
    await addColumnIfMissing(knex, 'vendor_pricing', 'available_quantity', (t) => t.decimal('available_quantity', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'branch_id', (t) => t.string('branch_id', 80));
    await addColumnIfMissing(knex, 'vendor_pricing', 'branch_name', (t) => t.string('branch_name', 160));
    await addColumnIfMissing(knex, 'vendor_pricing', 'min_order_quantity', (t) => t.decimal('min_order_quantity', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'shipping_estimate', (t) => t.decimal('shipping_estimate', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'hazmat_fee_estimate', (t) => t.decimal('hazmat_fee_estimate', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'rebate_estimate', (t) => t.decimal('rebate_estimate', 12, 4));
    await addColumnIfMissing(knex, 'vendor_pricing', 'mapping_confidence', (t) => t.decimal('mapping_confidence', 4, 3));
    await addColumnIfMissing(knex, 'vendor_pricing', 'source_confidence', (t) => t.decimal('source_confidence', 4, 3));
    await addColumnIfMissing(knex, 'vendor_pricing', 'price_confidence', (t) => t.decimal('price_confidence', 4, 3));
    await addColumnIfMissing(knex, 'vendor_pricing', 'is_active', (t) => t.boolean('is_active').notNullable().defaultTo(true));

    await knex.raw(`
      UPDATE vendor_pricing vp
      SET vendor_connection_id = vc.id
      FROM vendor_connections vc
      WHERE vp.vendor_connection_id IS NULL
        AND vc.vendor_id = vp.vendor_id
        AND vc.connection_type = COALESCE(NULLIF(vp.source_type, ''), 'manual_seed')
    `).catch(() => {});
    await knex.raw(`
      UPDATE vendor_pricing vp
      SET vendor_connection_id = vc.id
      FROM vendor_connections vc
      WHERE vp.vendor_connection_id IS NULL
        AND vc.vendor_id = vp.vendor_id
        AND vc.connection_type = 'manual_seed'
    `);
    await knex('vendor_pricing')
      .whereNull('price_amount')
      .update({ price_amount: knex.ref('price') });
    await knex('vendor_pricing')
      .whereNull('price_type')
      .update({ price_type: 'manual_seed' });
    await knex('vendor_pricing')
      .whereNull('approval_status')
      .update({ approval_status: 'approved' });
    await knex('vendor_pricing')
      .whereIn('approval_status', ['pending', 'needs_review'])
      .whereNotNull('price')
      .update({ approval_status: 'approved' });
    await knex('vendor_pricing')
      .whereNull('source_type')
      .update({ source_type: 'manual_seed' });
    await knex('vendor_pricing')
      .whereNull('source_confidence')
      .update({ source_confidence: 0.75 });
    await knex('vendor_pricing')
      .whereNull('mapping_confidence')
      .update({ mapping_confidence: 0.50 });
    await knex('vendor_pricing')
      .whereNull('price_confidence')
      .update({ price_confidence: 0.50 });
    await knex('vendor_pricing')
      .whereNull('availability_status')
      .update({ availability_status: 'unknown' });

    await addConstraintIfMissing(knex, 'vendor_pricing_price_type_check', `
      ALTER TABLE vendor_pricing
      ADD CONSTRAINT vendor_pricing_price_type_check
      CHECK (price_type IN (${PRICE_TYPES.map((s) => `'${s}'`).join(', ')}))
    `);
    await addConstraintIfMissing(knex, 'vendor_pricing_approval_status_check', `
      ALTER TABLE vendor_pricing
      ADD CONSTRAINT vendor_pricing_approval_status_check
      CHECK (approval_status IN (${PRICE_APPROVAL_STATUSES.map((s) => `'${s}'`).join(', ')}))
    `);
    await addConstraintIfMissing(knex, 'vendor_pricing_availability_status_check', `
      ALTER TABLE vendor_pricing
      ADD CONSTRAINT vendor_pricing_availability_status_check
      CHECK (availability_status IN (${AVAILABILITY_STATUSES.map((s) => `'${s}'`).join(', ')}))
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_vendor_pricing_product_active
      ON vendor_pricing(product_id, is_active, approval_status, expires_at)
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_vendor_pricing_map
      ON vendor_pricing(distributor_product_map_id)
    `);
  }

  if (await knex.schema.hasTable('price_snapshots')) {
    await addColumnIfMissing(knex, 'price_snapshots', 'vendor_connection_id', (t) => t.uuid('vendor_connection_id').references('id').inTable('vendor_connections').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'price_snapshots', 'distributor_product_map_id', (t) => t.uuid('distributor_product_map_id').references('id').inTable('distributor_product_map').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'price_snapshots', 'price_amount', (t) => t.decimal('price_amount', 12, 4));
    await addColumnIfMissing(knex, 'price_snapshots', 'currency', (t) => t.string('currency', 3).notNullable().defaultTo('USD'));
    await addColumnIfMissing(knex, 'price_snapshots', 'raw_price_text', (t) => t.text('raw_price_text'));
    await addColumnIfMissing(knex, 'price_snapshots', 'raw_payload_json', (t) => t.jsonb('raw_payload_json').notNullable().defaultTo(knex.raw("'{}'::jsonb")));
    await addColumnIfMissing(knex, 'price_snapshots', 'landed_unit_price', (t) => t.decimal('landed_unit_price', 12, 4));
    await addColumnIfMissing(knex, 'price_snapshots', 'availability_status', (t) => t.string('availability_status', 30).defaultTo('unknown'));
    await addColumnIfMissing(knex, 'price_snapshots', 'available_quantity', (t) => t.decimal('available_quantity', 12, 4));
    await addColumnIfMissing(knex, 'price_snapshots', 'branch_id', (t) => t.string('branch_id', 80));
    await addColumnIfMissing(knex, 'price_snapshots', 'branch_name', (t) => t.string('branch_name', 160));
    await addColumnIfMissing(knex, 'price_snapshots', 'price_type', (t) => t.string('price_type', 30).notNullable().defaultTo('manual'));
    await addColumnIfMissing(knex, 'price_snapshots', 'mapping_confidence', (t) => t.decimal('mapping_confidence', 4, 3));
    await addColumnIfMissing(knex, 'price_snapshots', 'source_confidence', (t) => t.decimal('source_confidence', 4, 3));
    await addColumnIfMissing(knex, 'price_snapshots', 'price_confidence', (t) => t.decimal('price_confidence', 4, 3));
    await addColumnIfMissing(knex, 'price_snapshots', 'previous_price_amount', (t) => t.decimal('previous_price_amount', 12, 4));
    await addColumnIfMissing(knex, 'price_snapshots', 'change_amount', (t) => t.decimal('change_amount', 12, 4));
    await addColumnIfMissing(knex, 'price_snapshots', 'change_percent', (t) => t.decimal('change_percent', 12, 4));
    await addColumnIfMissing(knex, 'price_snapshots', 'requires_approval', (t) => t.boolean('requires_approval').notNullable().defaultTo(false));
    await addColumnIfMissing(knex, 'price_snapshots', 'approval_reason', (t) => t.text('approval_reason'));
    await addColumnIfMissing(knex, 'price_snapshots', 'parser_version', (t) => t.text('parser_version'));
    await addColumnIfMissing(knex, 'price_snapshots', 'captured_at', (t) => t.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now()));

    await knex('price_snapshots').whereNull('price_amount').update({ price_amount: knex.ref('price') }).catch(() => {});
    await knex('price_snapshots').whereNull('price_type').update({ price_type: 'manual_seed' }).catch(() => {});
    await knex('price_snapshots').whereNull('source_confidence').update({ source_confidence: 0.75 }).catch(() => {});
    await knex('price_snapshots').whereNull('mapping_confidence').update({ mapping_confidence: 0.50 }).catch(() => {});
    await knex('price_snapshots').whereNull('price_confidence').update({ price_confidence: 0.50 }).catch(() => {});
    await knex('price_snapshots').whereNull('availability_status').update({ availability_status: 'unknown' }).catch(() => {});
    await knex('price_snapshots').whereNull('captured_at').update({ captured_at: knex.fn.now() }).catch(() => {});

    await knex.raw(`
      UPDATE price_snapshots ps
      SET vendor_connection_id = vp.vendor_connection_id
      FROM vendor_pricing vp
      WHERE ps.vendor_connection_id IS NULL
        AND ps.vendor_pricing_id = vp.id
    `).catch(() => {});
  }

  if (await knex.schema.hasTable('vendor_pricing') && await knex.schema.hasTable('price_snapshots')) {
    const rows = await knex('vendor_pricing as vp')
      .leftJoin('price_snapshots as ps', 'ps.vendor_pricing_id', 'vp.id')
      .whereNull('ps.id')
      .whereNotNull('vp.price')
      .select('vp.*');

    for (const row of rows) {
      const [snapshot] = await knex('price_snapshots').insert({
        vendor_pricing_id: row.id,
        product_id: row.product_id,
        vendor_id: row.vendor_id,
        vendor_connection_id: row.vendor_connection_id || null,
        distributor_product_map_id: row.distributor_product_map_id || null,
        price: row.price,
        price_amount: row.price_amount || row.price,
        currency: row.currency || 'USD',
        quantity: row.quantity,
        uom: row.unit,
        normalized_unit_price: row.normalized_unit_price || row.price_per_oz || null,
        normalized_unit: row.unit_normalized || null,
        landed_unit_price: row.landed_unit_price || null,
        availability_status: row.availability_status || 'unknown',
        available_quantity: row.available_quantity || null,
        branch_id: row.branch_id || null,
        branch_name: row.branch_name || row.branch_location || null,
        source_type: row.source_type || 'manual_seed',
        price_type: row.price_type || 'manual_seed',
        mapping_confidence: row.mapping_confidence || 0.50,
        source_confidence: row.source_confidence || 0.75,
        price_confidence: row.price_confidence || 0.50,
        requires_approval: false,
        captured_at: row.last_checked_at || knex.fn.now(),
        source_url: row.vendor_product_url || null,
        metadata: JSON.stringify({ backfilledFrom: 'vendor_pricing_control_layer' }),
      }).returning('*');
      await knex('vendor_pricing').where({ id: row.id }).update({ latest_snapshot_id: snapshot.id || snapshot });
    }

    await knex.raw(`
      UPDATE vendor_pricing vp
      SET latest_snapshot_id = latest.id
      FROM (
        SELECT DISTINCT ON (vendor_pricing_id) id, vendor_pricing_id
        FROM price_snapshots
        WHERE vendor_pricing_id IS NOT NULL
        ORDER BY vendor_pricing_id, captured_at DESC, created_at DESC
      ) latest
      WHERE vp.latest_snapshot_id IS NULL
        AND latest.vendor_pricing_id = vp.id
    `);

    await addConstraintIfMissing(knex, 'vendor_pricing_latest_snapshot_fk', `
      ALTER TABLE vendor_pricing
      ADD CONSTRAINT vendor_pricing_latest_snapshot_fk
      FOREIGN KEY (latest_snapshot_id) REFERENCES price_snapshots(id)
    `);
  }

  if (!(await knex.schema.hasTable('price_approval_events'))) {
    await knex.schema.createTable('price_approval_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('vendor_pricing_id').references('id').inTable('vendor_pricing').onDelete('SET NULL');
      t.uuid('snapshot_id').notNullable().references('id').inTable('price_snapshots').onDelete('CASCADE');
      t.uuid('product_id').notNullable().references('id').inTable('products_catalog').onDelete('CASCADE');
      t.uuid('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.decimal('old_price_amount', 12, 4);
      t.decimal('new_price_amount', 12, 4);
      t.decimal('change_amount', 12, 4);
      t.decimal('change_percent', 12, 4);
      t.string('approval_status', 30).notNullable().defaultTo('pending');
      t.text('approval_reason');
      t.string('approved_by', 120);
      t.timestamp('approved_at', { useTz: true });
      t.string('rejected_by', 120);
      t.timestamp('rejected_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['approval_status', 'created_at']);
      t.index(['product_id', 'vendor_id']);
    });
  }
  await addConstraintIfMissing(knex, 'price_approval_events_status_check', `
    ALTER TABLE price_approval_events
    ADD CONSTRAINT price_approval_events_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected', 'auto_approved'))
  `);

  if (await knex.schema.hasTable('products_catalog')) {
    await addColumnIfMissing(knex, 'products_catalog', 'best_vendor_pricing_id', (t) => t.uuid('best_vendor_pricing_id').references('id').inTable('vendor_pricing').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'products_catalog', 'best_price_amount_cached', (t) => t.decimal('best_price_amount_cached', 12, 4));
    await addColumnIfMissing(knex, 'products_catalog', 'best_price_vendor_id_cached', (t) => t.uuid('best_price_vendor_id_cached').references('id').inTable('vendors').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'products_catalog', 'best_price_updated_at', (t) => t.timestamp('best_price_updated_at', { useTz: true }));
    await addColumnIfMissing(knex, 'products_catalog', 'best_price_status', (t) => t.string('best_price_status', 30).notNullable().defaultTo('needs_mapping'));

    await addConstraintIfMissing(knex, 'products_catalog_best_price_status_check', `
      ALTER TABLE products_catalog
      ADD CONSTRAINT products_catalog_best_price_status_check
      CHECK (best_price_status IN (${BEST_PRICE_STATUSES.map((s) => `'${s}'`).join(', ')}))
    `);

    await knex.raw(`
      WITH best_rows AS (
        SELECT DISTINCT ON (vp.product_id)
          vp.product_id,
          vp.id AS vendor_pricing_id,
          vp.vendor_id,
          COALESCE(vp.price_amount, vp.price) AS price_amount,
          vp.last_checked_at
        FROM vendor_pricing vp
        WHERE vp.is_active = true
          AND vp.approval_status IN ('approved', 'auto_approved')
          AND COALESCE(vp.price_amount, vp.price) IS NOT NULL
        ORDER BY vp.product_id, COALESCE(vp.normalized_unit_price, vp.price_per_oz, vp.price_amount, vp.price) ASC NULLS LAST
      )
      UPDATE products_catalog pc
      SET best_vendor_pricing_id = br.vendor_pricing_id,
          best_price_amount_cached = br.price_amount,
          best_price_vendor_id_cached = br.vendor_id,
          best_price_updated_at = COALESCE(br.last_checked_at, NOW()),
          best_price_status = 'stale'
      FROM best_rows br
      WHERE pc.id = br.product_id
        AND pc.best_vendor_pricing_id IS NULL
    `);

    await knex('products_catalog')
      .where(function activeOnly() {
        this.where({ active: true }).orWhereNull('active');
      })
      .whereNull('best_vendor_pricing_id')
      .update({ best_price_status: 'needs_mapping' });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('products_catalog')) {
    await knex.raw('ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS products_catalog_best_price_status_check');
    for (const column of ['best_price_status', 'best_price_updated_at', 'best_price_vendor_id_cached', 'best_price_amount_cached', 'best_vendor_pricing_id']) {
      if (await knex.schema.hasColumn('products_catalog', column)) {
        await knex.schema.alterTable('products_catalog', (t) => t.dropColumn(column));
      }
    }
  }

  await knex.schema.dropTableIfExists('price_approval_events');

  if (await knex.schema.hasTable('vendor_pricing')) {
    await knex.raw('ALTER TABLE vendor_pricing DROP CONSTRAINT IF EXISTS vendor_pricing_latest_snapshot_fk');
    await knex.raw('ALTER TABLE vendor_pricing DROP CONSTRAINT IF EXISTS vendor_pricing_availability_status_check');
    await knex.raw('ALTER TABLE vendor_pricing DROP CONSTRAINT IF EXISTS vendor_pricing_approval_status_check');
    await knex.raw('ALTER TABLE vendor_pricing DROP CONSTRAINT IF EXISTS vendor_pricing_price_type_check');
    for (const column of [
      'is_active', 'price_confidence', 'source_confidence', 'mapping_confidence',
      'rebate_estimate', 'hazmat_fee_estimate', 'shipping_estimate', 'min_order_quantity',
      'branch_name', 'branch_id', 'available_quantity', 'availability_status',
      'landed_unit_price', 'currency', 'price_amount', 'approval_status',
      'price_type', 'latest_snapshot_id', 'distributor_product_map_id', 'vendor_connection_id',
    ]) {
      if (await knex.schema.hasColumn('vendor_pricing', column)) {
        await knex.schema.alterTable('vendor_pricing', (t) => t.dropColumn(column));
      }
    }
  }

  if (await knex.schema.hasTable('price_snapshots')) {
    for (const column of [
      'captured_at', 'parser_version', 'approval_reason', 'requires_approval',
      'change_percent', 'change_amount', 'previous_price_amount', 'price_confidence',
      'source_confidence', 'mapping_confidence', 'price_type', 'branch_name',
      'branch_id', 'available_quantity', 'availability_status', 'landed_unit_price',
      'raw_payload_json', 'raw_price_text', 'currency', 'price_amount',
      'distributor_product_map_id', 'vendor_connection_id',
    ]) {
      if (await knex.schema.hasColumn('price_snapshots', column)) {
        await knex.schema.alterTable('price_snapshots', (t) => t.dropColumn(column));
      }
    }
  }

  if (await knex.schema.hasTable('distributor_product_map')) {
    await knex.raw('ALTER TABLE distributor_product_map DROP CONSTRAINT IF EXISTS distributor_product_map_verified_required_check');
    await knex.raw('ALTER TABLE distributor_product_map DROP CONSTRAINT IF EXISTS distributor_product_map_confidence_check');
    await knex.raw('ALTER TABLE distributor_product_map DROP CONSTRAINT IF EXISTS distributor_product_map_status_check');
    for (const column of [
      'last_checked_at', 'verified_at', 'verified_by', 'branch_name', 'branch_id',
      'pack_count', 'content_uom', 'content_quantity', 'purchase_uom',
      'package_size_unit', 'package_size_value', 'epa_registration_number',
      'asin', 'vendor_product_name', 'product_url', 'mapping_confidence',
      'mapping_status', 'vendor_connection_id',
    ]) {
      if (await knex.schema.hasColumn('distributor_product_map', column)) {
        await knex.schema.alterTable('distributor_product_map', (t) => t.dropColumn(column));
      }
    }
  }

  await knex.schema.dropTableIfExists('vendor_connections');
};
