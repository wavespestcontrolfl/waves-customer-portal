/**
 * Codex round 2 on #3039: contact-field touch triggers. The Google Contacts
 * sync keys re-syncs off updated_at, but knex timestamps have no ON UPDATE
 * behavior and contact-field writers are scattered (booking autofill,
 * lead-intake enrichment, admin routes) — relying on each one to stamp
 * updated_at leaves contacts silently stale. These triggers bump updated_at
 * ONLY when a contact-relevant column actually changes, so the sync's own
 * bookkeeping writes (google_contact_id / google_contact_synced_at) never
 * re-queue the row.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION touch_updated_at_on_contact_fields() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  if (await knex.schema.hasTable('customers')) {
    await knex.raw('DROP TRIGGER IF EXISTS customers_contact_touch ON customers');
    await knex.raw(`
      CREATE TRIGGER customers_contact_touch BEFORE UPDATE ON customers
      FOR EACH ROW
      WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.phone IS DISTINCT FROM NEW.phone
        OR OLD.first_name IS DISTINCT FROM NEW.first_name OR OLD.last_name IS DISTINCT FROM NEW.last_name
        OR OLD.address_line1 IS DISTINCT FROM NEW.address_line1 OR OLD.address_line2 IS DISTINCT FROM NEW.address_line2
        OR OLD.city IS DISTINCT FROM NEW.city OR OLD.state IS DISTINCT FROM NEW.state OR OLD.zip IS DISTINCT FROM NEW.zip)
      EXECUTE FUNCTION touch_updated_at_on_contact_fields();
    `);
  }
  if (await knex.schema.hasTable('leads')) {
    await knex.raw('DROP TRIGGER IF EXISTS leads_contact_touch ON leads');
    await knex.raw(`
      CREATE TRIGGER leads_contact_touch BEFORE UPDATE ON leads
      FOR EACH ROW
      WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.phone IS DISTINCT FROM NEW.phone
        OR OLD.first_name IS DISTINCT FROM NEW.first_name OR OLD.last_name IS DISTINCT FROM NEW.last_name
        -- customer_id changes re-enter the lane so EVERY conversion path
        -- (public-quote conversion sets only customer_id) transfers the
        -- lead's contact to the customer row.
        OR OLD.customer_id IS DISTINCT FROM NEW.customer_id)
      EXECUTE FUNCTION touch_updated_at_on_contact_fields();
    `);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('customers')) {
    await knex.raw('DROP TRIGGER IF EXISTS customers_contact_touch ON customers');
  }
  if (await knex.schema.hasTable('leads')) {
    await knex.raw('DROP TRIGGER IF EXISTS leads_contact_touch ON leads');
  }
  await knex.raw('DROP FUNCTION IF EXISTS touch_updated_at_on_contact_fields()');
};
