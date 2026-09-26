/** Durable primary-address review. No customer addresses or pins are backfilled. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_geocode_reviews'))) {
    await knex.schema.createTable('customer_geocode_reviews', t => {
      t.uuid('customer_id').primary().references('id').inTable('customers').onDelete('CASCADE');
      t.jsonb('address_snapshot').notNullable();
      t.enu('status', ['pending', 'needs_details', 'needs_pin', 'outside_area', 'provider_unavailable', 'geocoded', 'verified']).notNullable();
      t.string('reason', 80).notNullable();
      t.string('source', 40);
      t.text('evidence');
      t.uuid('reviewed_by');
      t.timestamp('reviewed_at', { useTz: true });
      t.decimal('latitude', 10, 7);
      t.decimal('longitude', 10, 7);
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index('status');
    });
  }
  // Protect coordinate-only writes and no-op address saves, even with the UI
  // disabled. Address changes reopen review via the snapshot; their existing
  // writers still own coordinate clearing/mirroring (a primary-property move
  // can supply the new property's pin, and a unit edit keeps the building).
  // Manual review actions release verification under the customer lock.
  await knex.raw(`CREATE OR REPLACE FUNCTION protect_customer_verified_pin() RETURNS trigger AS $$
    DECLARE review customer_geocode_reviews%ROWTYPE;
    BEGIN
      SELECT * INTO review FROM customer_geocode_reviews WHERE customer_id = OLD.id;
      IF review.status = 'verified'
        AND review.address_snapshot = jsonb_build_array(OLD.address_line1, OLD.address_line2, OLD.city, OLD.state, OLD.zip)
        AND OLD.latitude IS NOT DISTINCT FROM review.latitude
        AND OLD.longitude IS NOT DISTINCT FROM review.longitude
        AND ROW(NEW.address_line1, NEW.address_line2, NEW.city, NEW.state, NEW.zip)
          IS NOT DISTINCT FROM ROW(OLD.address_line1, OLD.address_line2, OLD.city, OLD.state, OLD.zip) THEN
        NEW.latitude := OLD.latitude; NEW.longitude := OLD.longitude;
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS customer_verified_pin_guard ON customers;
  CREATE TRIGGER customer_verified_pin_guard BEFORE UPDATE OF address_line1, address_line2, city, state, zip, latitude, longitude
    ON customers FOR EACH ROW EXECUTE FUNCTION protect_customer_verified_pin();`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_geocode_reviews'))) return;
  await knex.raw('DROP TRIGGER IF EXISTS customer_verified_pin_guard ON customers; DROP FUNCTION IF EXISTS protect_customer_verified_pin();');
  await knex.schema.dropTable('customer_geocode_reviews');
};
