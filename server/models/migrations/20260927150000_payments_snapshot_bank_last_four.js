/**
 * A removed bank (ACH) method keeps its last four digits on its payments.
 *
 * 20260924000032 snapshots a payment_methods row into every linked payments
 * row when the method is deleted, but only its card digits (last_four): a
 * bank account's digits live in bank_last_four, so an ACH payment that
 * carried none of its own (the monthly autopay charge leaves the snapshot
 * empty) lost them with the method. Readers already treat
 * payments.card_last_four as the tender's last four for a bank payment too
 * (confirmInvoicePayment writes the bank digits there), so the snapshot
 * fills it from bank_last_four when the card digits are absent. Fill-only,
 * as before — a value the payment already carries is never overwritten
 * (Codex #4996 r12).
 */
const SNAPSHOT = (lastFour) => `
  CREATE OR REPLACE FUNCTION payments_snapshot_removed_method() RETURNS trigger AS $$
  BEGIN
    UPDATE payments
    SET card_brand = COALESCE(card_brand, OLD.card_brand),
        card_last_four = COALESCE(card_last_four, ${lastFour}),
        payment_method_type = COALESCE(payment_method_type, OLD.method_type),
        bank_name = COALESCE(bank_name, OLD.bank_name)
    WHERE payment_method_id = OLD.id;
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql
`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments')) || !(await knex.schema.hasColumn('payment_methods', 'bank_last_four'))) return;
  await knex.raw(SNAPSHOT('OLD.last_four, OLD.bank_last_four'));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  await knex.raw(SNAPSHOT('OLD.last_four'));
};
