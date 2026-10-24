/**
 * Zelle payments from the Plaid bank feed (GATE_ZELLE_BANK_RECONCILE).
 *
 * No Capital One notice email ever reached contact@ and the owner dropped that
 * route (2026-09-27); the Plaid feed (services/plaid-sync.js) now stages the same
 * Zelle credits as bank_transactions rows. A payment notice can therefore come
 * from either source:
 *
 *   inbound_payment_notices.email_id             now NULLABLE — set on an
 *                                                email-sourced notice only
 *   inbound_payment_notices.plaid_transaction_id the Plaid transaction a bank-feed
 *                                                notice was read from. UNIQUE: one
 *                                                notice per transaction is the
 *                                                at-most-once claim. Keyed on Plaid's
 *                                                id, not the bank row's uuid, because
 *                                                plaid-sync replaces a corrected row
 *                                                with a fresh one under the same
 *                                                Plaid id; no FK for the same reason,
 *                                                and so a withdrawn transaction never
 *                                                deletes the audit row of money
 *                                                recorded from it.
 *   CHECK num_nonnulls(email_id, plaid_transaction_id) = 1 — every notice has
 *                                                exactly one source
 *   source (free text, unchanged)                'capitalone_zelle' (email) |
 *                                                'plaid_zelle' (bank feed)
 *
 *   bank_transactions.original_description       the bank's own wording for a Plaid
 *                                                row (Plaid's include_original_description).
 *                                                Capital One names the Zelle payer
 *                                                there ("Zelle money received from …");
 *                                                `description` keeps Plaid's cleaned
 *                                                name. NULL on CSV rows and on Plaid
 *                                                rows synced before this column.
 *
 * down() fails closed while a bank-feed notice exists: it has no email_id, so the
 * restored NOT NULL would reject it, and an applied one is the audit trail of
 * money already recorded.
 */
const NOTICES = 'inbound_payment_notices';
const ONE_SOURCE_CHECK = 'inbound_payment_notices_one_source_check';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(NOTICES)) {
    await knex.raw(`ALTER TABLE ${NOTICES} ALTER COLUMN email_id DROP NOT NULL`);
    if (!(await knex.schema.hasColumn(NOTICES, 'plaid_transaction_id'))) {
      await knex.schema.alterTable(NOTICES, (t) => {
        t.string('plaid_transaction_id', 100).unique();
      });
    }
    await knex.raw(`ALTER TABLE ${NOTICES} DROP CONSTRAINT IF EXISTS ${ONE_SOURCE_CHECK}`);
    await knex.raw(`ALTER TABLE ${NOTICES} ADD CONSTRAINT ${ONE_SOURCE_CHECK} CHECK (num_nonnulls(email_id, plaid_transaction_id) = 1)`);
  }
  if (await knex.schema.hasTable('bank_transactions') && !(await knex.schema.hasColumn('bank_transactions', 'original_description'))) {
    await knex.schema.alterTable('bank_transactions', (t) => {
      t.string('original_description', 500);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable(NOTICES)) {
    if (await knex.schema.hasColumn(NOTICES, 'plaid_transaction_id')) {
      const [{ count }] = await knex(NOTICES).whereNotNull('plaid_transaction_id').count('* as count');
      if (Number(count) > 0) {
        throw new Error(`cannot roll back: ${count} bank-feed Zelle notice(s) exist — they have no email row and may record real payments; resolve or remove them first, then rerun`);
      }
      await knex.raw(`ALTER TABLE ${NOTICES} DROP CONSTRAINT IF EXISTS ${ONE_SOURCE_CHECK}`);
      await knex.schema.alterTable(NOTICES, (t) => {
        t.dropColumn('plaid_transaction_id');
      });
    }
    await knex.raw(`ALTER TABLE ${NOTICES} ALTER COLUMN email_id SET NOT NULL`);
  }
  if (await knex.schema.hasTable('bank_transactions') && await knex.schema.hasColumn('bank_transactions', 'original_description')) {
    await knex.schema.alterTable('bank_transactions', (t) => {
      t.dropColumn('original_description');
    });
  }
};
