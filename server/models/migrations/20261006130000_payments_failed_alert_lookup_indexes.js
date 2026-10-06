// Indexes for the payment-failed alert lookups (payment-failed-allocation.js,
// payment-failed-alert-close.js): a failed attempt's ledger rows by
// stripe_payment_intent_id, and the ledger rows naming an invoice by
// metadata->>'invoice_id'. Both run inside payment transactions (the paid
// hook) and up to a page of times per repair sweep. payments held 403 rows on
// 2026-10-06, so a plain CREATE INDEX holds its lock for milliseconds.
exports.up = async (knex) => {
  await knex.raw('CREATE INDEX IF NOT EXISTS payments_stripe_payment_intent_id_idx ON payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL');
  await knex.raw("CREATE INDEX IF NOT EXISTS payments_metadata_invoice_id_idx ON payments ((metadata->>'invoice_id')) WHERE metadata->>'invoice_id' IS NOT NULL");
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS payments_metadata_invoice_id_idx');
  await knex.raw('DROP INDEX IF EXISTS payments_stripe_payment_intent_id_idx');
};
