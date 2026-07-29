/**
 * Codex round 12 on #3039: canonical account identity changes must requeue
 * every linked property row's contact. The sync publishes names/email/phone
 * from customer_accounts, but eligibility keys off customers.updated_at —
 * a direct account update (data-hygiene auto-apply, dedupe merges) would
 * otherwise never reach Google. Bumping the linked customers' updated_at
 * only touches bookkeeping columns, so the customers contact-touch trigger
 * does not double-fire.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;
  await knex.raw(`
    CREATE OR REPLACE FUNCTION touch_linked_customers_on_account_identity() RETURNS trigger AS $$
    BEGIN
      UPDATE customers SET updated_at = now()
      WHERE account_id = NEW.id AND deleted_at IS NULL;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await knex.raw('DROP TRIGGER IF EXISTS customer_accounts_identity_touch ON customer_accounts');
  await knex.raw(`
    CREATE TRIGGER customer_accounts_identity_touch AFTER UPDATE ON customer_accounts
    FOR EACH ROW
    WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.phone IS DISTINCT FROM NEW.phone
      OR OLD.first_name IS DISTINCT FROM NEW.first_name OR OLD.last_name IS DISTINCT FROM NEW.last_name)
    EXECUTE FUNCTION touch_linked_customers_on_account_identity();
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('customer_accounts')) {
    await knex.raw('DROP TRIGGER IF EXISTS customer_accounts_identity_touch ON customer_accounts');
  }
  await knex.raw('DROP FUNCTION IF EXISTS touch_linked_customers_on_account_identity()');
};
