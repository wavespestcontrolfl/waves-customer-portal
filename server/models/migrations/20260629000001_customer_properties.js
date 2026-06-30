/**
 * customer_properties — Phase 1 of a real multi-property model (one customer →
 * many service addresses, each with an occupancy type). Replaces the awkward
 * "each property = a duplicate customer row" pattern from
 * 20260504000008_customer_accounts_multi_property.js, which is now frozen for
 * NEW data (existing sibling rows are left untouched here).
 *
 * Phase 1 is purely ADDITIVE: `customers.address_*` stays the denormalized
 * mirror of the customer's PRIMARY property, so the ~310 sites that read it keep
 * working untouched. Scheduling / estimates / billing become property-aware in a
 * later phase. WaveGuard tier stays customer-level (owner decision 2026-06-29).
 */

const MIRROR_COLS = [
  'address_line2', 'latitude', 'longitude', 'property_type', 'lawn_type',
  'property_sqft', 'lot_sqft', 'bed_sqft', 'linear_ft_perimeter', 'palm_count', 'canopy_type',
];

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('customer_properties');
  if (!hasTable) {
    await knex.schema.createTable('customer_properties', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('label', 100);
      t.enu('occupancy_type', ['owner_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'])
        .notNullable().defaultTo('unknown');
      t.boolean('is_primary').notNullable().defaultTo(false);
      t.string('address_line1', 200);
      t.string('address_line2', 100);
      t.string('city', 50);
      t.string('state', 2).defaultTo('FL');
      t.string('zip', 10);
      t.decimal('latitude', 10, 7);
      t.decimal('longitude', 10, 7);
      // Property-grained attributes — mirrored from `customers` on backfill;
      // they become authoritative (vs. customer-level) in a later phase.
      t.string('property_type', 30);
      t.string('lawn_type', 50);
      t.integer('property_sqft');
      t.integer('lot_sqft');
      t.integer('bed_sqft');
      t.integer('linear_ft_perimeter');
      t.integer('palm_count');
      t.string('canopy_type', 30);
      // Canonical full-address dedup key (street+unit+city+ZIP), computed by the
      // service's addressKey() so the unique index below uses the EXACT same
      // normalization as the app — no JS/SQL drift on suffix/ZIP+4 variants.
      t.string('address_key', 400);
      t.string('source', 30); // 'backfill' | 'call_pipeline' | 'manual' | 'self_book'
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);

      t.index(['customer_id']);
      t.index(['latitude', 'longitude']);
      t.index(['occupancy_type']);
    });
    // Exactly one primary property per customer.
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS customer_properties_one_primary '
      + 'ON customer_properties (customer_id) WHERE is_primary'
    );
    // One active property per canonical full address per customer — the atomic
    // backstop for the read-then-insert dedup in recordCallProperty. Indexes the
    // app-computed address_key, so the DB uniqueness uses the SAME suffix-canonical,
    // ZIP+4-insensitive normalization as the service helper (no JS/SQL drift).
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS customer_properties_customer_address_uniq '
      + 'ON customer_properties (customer_id, address_key) WHERE active'
    );
  }

  // Backfill one PRIMARY property per existing customer from their own address.
  // Build the column list from columns that actually exist on `customers` (the
  // schema has drifted across migrations) so this can never crash on a missing
  // column. Default occupancy = owner_occupied (the residential majority); it's
  // correctable, and the call pipeline tags rentals going forward.
  const mirror = [];
  for (const col of MIRROR_COLS) {
    if (await knex.schema.hasColumn('customers', col)) mirror.push(col);
  }
  const hasProfileLabel = await knex.schema.hasColumn('customers', 'profile_label');
  const labelExpr = hasProfileLabel ? "COALESCE(NULLIF(c.profile_label, ''), 'Primary')" : "'Primary'";

  const destCols = ['customer_id', 'label', 'occupancy_type', 'is_primary',
    'address_line1', 'city', 'state', 'zip', 'source', 'active', ...mirror];
  const srcCols = ['c.id', labelExpr, "'owner_occupied'", 'true',
    'c.address_line1', 'c.city', 'c.state', 'c.zip', "'backfill'", 'true', ...mirror.map((m) => `c.${m}`)];

  await knex.raw(`
    INSERT INTO customer_properties (${destCols.join(', ')}, created_at, updated_at)
    SELECT ${srcCols.join(', ')}, now(), now()
    FROM customers c
    WHERE c.address_line1 IS NOT NULL AND c.address_line1 <> ''
      AND NOT EXISTS (SELECT 1 FROM customer_properties cp WHERE cp.customer_id = c.id)
  `);

  // Populate address_key for the backfilled rows with the SAME helper the runtime
  // uses, so a backfilled primary dedupes identically against later call/API adds.
  // (Computed in JS — not SQL — so there is exactly one normalization definition.)
  const { addressKey } = require('../../services/customer-properties');
  const rows = await knex('customer_properties').whereNull('address_key')
    .select('id', 'address_line1', 'address_line2', 'city', 'zip');
  for (const r of rows) {
    await knex('customer_properties').where({ id: r.id }).update({ address_key: addressKey(r) });
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_properties_customer_address_uniq');
  await knex.raw('DROP INDEX IF EXISTS customer_properties_one_primary');
  await knex.schema.dropTableIfExists('customer_properties');
};
