/**
 * Plaid bank sync (GATE_PLAID_SYNC) — live bank/card feeds into the SAME
 * bank_transactions staging table the statement-CSV import fills.
 *
 * plaid_items    — one row per Plaid Link connection (one bank login). The
 *                  Plaid access token is stored pgcrypto-encrypted
 *                  (pgp_sym_encrypt, key PLAID_TOKEN_KEY → falls back to
 *                  DATA_HYGIENE_VAULT_KEY) and never leaves the server.
 *                  `sync_cursor` is Plaid's /transactions/sync cursor.
 * plaid_accounts — one row per account under a connection, mapped to the
 *                  staging vocabulary (account_label + account_type) with a
 *                  `sync_from` cutoff so a feed never re-imports days an
 *                  earlier CSV statement already covered.
 *
 * bank_transactions.plaid_transaction_id — Plaid's stable id for a POSTED
 * transaction; the row identity for source='plaid' rows (partial unique
 * index). CSV rows keep their content hash and leave this NULL.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('plaid_items'))) {
    await knex.schema.createTable('plaid_items', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('item_id', 100).notNullable().unique();
      t.string('institution_id', 50);
      t.string('institution_name', 200);
      t.text('access_token_enc');                    // NULL once disconnected
      t.text('sync_cursor');
      // setup: linked, accounts not yet confirmed — never synced
      // active: syncing · login_required: bank needs re-auth (update-mode Link)
      // error: last sync failed for another reason · removed: disconnected
      t.string('status', 20).notNullable().defaultTo('setup');
      t.timestamp('last_synced_at', { useTz: true });
      t.string('last_error', 500);
      t.timestamps(true, true);
    });
    await knex.raw(`
      ALTER TABLE plaid_items
      ADD CONSTRAINT plaid_items_status_check CHECK (status IN ('setup','active','login_required','error','removed'))
    `);
  }

  if (!(await knex.schema.hasTable('plaid_accounts'))) {
    await knex.schema.createTable('plaid_accounts', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('plaid_item_id').notNullable().references('id').inTable('plaid_items').onDelete('CASCADE');
      t.string('account_id', 100).notNullable().unique();
      t.string('name', 200);
      t.string('mask', 10);
      t.string('plaid_type', 30);                    // depository | credit | loan | investment | other
      t.string('plaid_subtype', 50);
      t.string('account_label', 100).notNullable();  // same meaning as bank_transactions.account_label
      t.string('account_type', 10).notNullable();    // 'bank' | 'card'
      t.date('sync_from').notNullable();             // transactions dated before this are skipped
      t.boolean('enabled').notNullable().defaultTo(false);
      t.timestamps(true, true);
      t.index('plaid_item_id');
    });
    await knex.raw(`
      ALTER TABLE plaid_accounts
      ADD CONSTRAINT plaid_accounts_account_type_check CHECK (account_type IN ('bank','card'))
    `);
  }

  if (!(await knex.schema.hasColumn('bank_transactions', 'plaid_transaction_id'))) {
    await knex.schema.alterTable('bank_transactions', t => {
      t.string('plaid_transaction_id', 100);
    });
  }
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_plaid_txn_uniq
      ON bank_transactions (plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS bank_transactions_plaid_txn_uniq');
  if (await knex.schema.hasColumn('bank_transactions', 'plaid_transaction_id')) {
    await knex.schema.alterTable('bank_transactions', t => {
      t.dropColumn('plaid_transaction_id');
    });
  }
  await knex.schema.dropTableIfExists('plaid_accounts');
  await knex.schema.dropTableIfExists('plaid_items');
};
