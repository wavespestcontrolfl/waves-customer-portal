/**
 * Backfill customer_accounts for customers created without the account layer.
 *
 * 20260504000008 gave every then-existing customer an account row and set
 * account_id = id, but several creation paths (public estimate accept,
 * self-book, public quote, lead/twilio webhooks, call pipeline, add-service
 * requests) still insert customers with account_id NULL and no
 * customer_accounts row. Since 20260716000000, portal login inserts into
 * customer_refresh_tokens, whose account_id is a NOT NULL FK onto
 * customer_accounts — so those customers' logins fail with an FK violation
 * (customer-facing "Internal server error") AFTER Twilio approves the code.
 *
 * Same self-adoption the 0504 backfill used: the customer becomes their own
 * account. middleware/auth.js now performs the identical adoption lazily at
 * login, so rows created account-less after this migration cannot re-break.
 */

exports.up = async function up(knex) {
  const hasAccounts = await knex.schema.hasTable('customer_accounts');
  const hasAccountId = await knex.schema.hasColumn('customers', 'account_id');
  if (!hasAccounts || !hasAccountId) return;

  await knex.raw(`
    INSERT INTO customer_accounts (id, first_name, last_name, email, phone, company_name, created_at, updated_at)
    SELECT id, COALESCE(NULLIF(first_name, ''), 'Customer'), last_name, email, phone, company_name, created_at, updated_at
    FROM customers
    WHERE account_id IS NULL
    ON CONFLICT (id) DO NOTHING
  `);

  await knex.raw(`
    UPDATE customers
    SET account_id = id,
        is_primary_profile = true,
        profile_label = COALESCE(NULLIF(profile_label, ''), 'Primary')
    WHERE account_id IS NULL
  `);
};

exports.down = async function down(knex) {
  // Data repair, deliberately not reversed: un-adopting these accounts would
  // re-break portal login for every affected customer, and rows adopted here
  // are indistinguishable from the 20260504000008 backfill's.
};
