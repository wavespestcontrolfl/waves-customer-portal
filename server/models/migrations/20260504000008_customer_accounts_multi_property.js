/**
 * Introduce a contact/account layer so one person can own multiple serviced
 * properties. Existing customer rows become their own primary property under
 * an account; new duplicate-phone/customer creates can attach to that account.
 */

exports.up = async function (knex) {
  const hasAccounts = await knex.schema.hasTable('customer_accounts');
  if (!hasAccounts) {
    await knex.schema.createTable('customer_accounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.string('first_name', 50).notNullable();
      t.string('last_name', 50);
      t.string('email', 150);
      t.string('phone', 20);
      t.string('company_name', 150);
      t.timestamps(true, true);

      t.index(['phone']);
      t.index(['email']);
    });
  }

  const hasAccountId = await knex.schema.hasColumn('customers', 'account_id');
  if (!hasAccountId) {
    await knex.schema.alterTable('customers', (t) => {
      t.uuid('account_id').references('id').inTable('customer_accounts').onDelete('SET NULL');
      t.string('profile_label', 100);
      t.boolean('is_primary_profile').defaultTo(false);
    });
  }

  await knex.raw(`
    INSERT INTO customer_accounts (id, first_name, last_name, email, phone, company_name, created_at, updated_at)
    SELECT id, first_name, last_name, email, phone, company_name, created_at, updated_at
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

  await knex.raw(`ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_phone_unique`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customers_phone_index ON customers (phone)`);
  await knex.raw(`ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_email_unique`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customers_email_index ON customers (email)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customers_account_id_index ON customers (account_id)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS customers_account_id_index`);
  await knex.raw(`DROP INDEX IF EXISTS customers_phone_index`);
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('is_primary_profile');
    t.dropColumn('profile_label');
    t.dropColumn('account_id');
  });
  await knex.schema.dropTableIfExists('customer_accounts');
  await knex.raw(`ALTER TABLE customers ADD CONSTRAINT customers_phone_unique UNIQUE (phone)`);
};
