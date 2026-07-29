/**
 * Codex rounds 12–14 on #3039: canonical account identity.
 *
 * The shared Google contact publishes customer_accounts values, so identity
 * edits must land there no matter which writer made them (admin PUT,
 * Intelligence Bar update_customer, data-hygiene auto-apply, ...). A DB
 * trigger propagates identity-field changes from ANY customers writer UP to
 * the canonical account row — covering every current and future writer
 * without per-route plumbing.
 *
 * Deliberately NO reverse fan-out trigger (accounts → bump all linked
 * customers): that inverted lock order (own customer row first, then the
 * account, then OTHER customer rows) and could deadlock concurrent property
 * edits. Linked rows are requeued instead by the sync's stale predicate,
 * which compares the ACCOUNT watermark directly.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_accounts')) || !(await knex.schema.hasTable('customers'))) return;
  // Remove the earlier reverse fan-out if a prior deploy created it.
  await knex.raw('DROP TRIGGER IF EXISTS customer_accounts_identity_touch ON customer_accounts');
  await knex.raw('DROP FUNCTION IF EXISTS touch_linked_customers_on_account_identity()');
  // BACKFILL before the trigger goes live: identity edits made after the
  // account layer landed went to customers ONLY (the old admin path), so
  // account rows can hold obsolete identities that the sync would publish
  // as canonical. Reconcile each account from its most recently updated
  // LIVE customer; only rows that actually differ are touched.
  await knex.raw(`
    UPDATE customer_accounts ca SET
      first_name = c.first_name,
      last_name  = c.last_name,
      email      = c.email,
      phone      = c.phone,
      updated_at = now()
    FROM (
      SELECT DISTINCT ON (account_id) account_id, first_name, last_name, email, phone, updated_at
      FROM customers
      WHERE account_id IS NOT NULL AND deleted_at IS NULL
      ORDER BY account_id, updated_at DESC
    ) c
    WHERE ca.id = c.account_id
      -- Timestamp-gated: a canonical correction NEWER than every customer
      -- copy is preserved — customers.updated_at moves for unrelated
      -- reasons, so a stale property copy must never overwrite a fresher
      -- account row. (Residual: per-field edit history does not exist, so
      -- a customer row touched later for non-identity reasons still wins;
      -- that matches the pre-account-layer reality where edits only ever
      -- landed on customers.)
      AND c.updated_at > ca.updated_at
      AND (ca.first_name IS DISTINCT FROM c.first_name
        OR ca.last_name IS DISTINCT FROM c.last_name
        OR ca.email IS DISTINCT FROM c.email
        OR ca.phone IS DISTINCT FROM c.phone)
  `);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION propagate_customer_identity_to_account() RETURNS trigger AS $$
    BEGIN
      -- Per-column: only the fields the writer actually CHANGED propagate.
      -- Copying all four would let a stale sibling's phone edit silently
      -- revert a newer canonical name/email correction.
      UPDATE customer_accounts SET
        first_name = CASE WHEN NEW.first_name IS DISTINCT FROM OLD.first_name THEN NEW.first_name ELSE first_name END,
        last_name  = CASE WHEN NEW.last_name  IS DISTINCT FROM OLD.last_name  THEN NEW.last_name  ELSE last_name  END,
        email      = CASE WHEN NEW.email      IS DISTINCT FROM OLD.email      THEN NEW.email      ELSE email      END,
        phone      = CASE WHEN NEW.phone      IS DISTINCT FROM OLD.phone      THEN NEW.phone      ELSE phone      END,
        updated_at = now()
      WHERE id = NEW.account_id;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await knex.raw('DROP TRIGGER IF EXISTS customers_identity_propagate ON customers');
  await knex.raw(`
    CREATE TRIGGER customers_identity_propagate AFTER UPDATE ON customers
    FOR EACH ROW
    WHEN (NEW.account_id IS NOT NULL
      -- Live rows only: dedupe retirement scrambles the loser's phone/email
      -- in the same update that sets deleted_at — those sentinel values
      -- must never overwrite the shared canonical identity.
      AND NEW.deleted_at IS NULL
      AND (OLD.email IS DISTINCT FROM NEW.email OR OLD.phone IS DISTINCT FROM NEW.phone
        OR OLD.first_name IS DISTINCT FROM NEW.first_name OR OLD.last_name IS DISTINCT FROM NEW.last_name))
    EXECUTE FUNCTION propagate_customer_identity_to_account();
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('customers')) {
    await knex.raw('DROP TRIGGER IF EXISTS customers_identity_propagate ON customers');
  }
  await knex.raw('DROP FUNCTION IF EXISTS propagate_customer_identity_to_account()');
  if (await knex.schema.hasTable('customer_accounts')) {
    await knex.raw('DROP TRIGGER IF EXISTS customer_accounts_identity_touch ON customer_accounts');
  }
  await knex.raw('DROP FUNCTION IF EXISTS touch_linked_customers_on_account_identity()');
};
