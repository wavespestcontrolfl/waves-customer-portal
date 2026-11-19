// Keep verified cancellation evidence past the webhook ledger's retention.
// Old attempts often have no PI binding, so match their immutable attempt,
// invoice, customer and payment method before authorizing a second checkout.
exports.up = async function up(knex) {
  await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
    table.string('authentication_canceled_intent_id');
  });
  await knex.raw(`
    WITH canceled AS (
      SELECT payload->'object' AS pi FROM stripe_webhook_events
      WHERE processed AND event_type = 'payment_intent.canceled'
        AND payload->'object'->>'status' = 'canceled'
        AND payload->'object'->'metadata'->>'source' = 'admin_card_on_file'
    ), intents AS (
      SELECT pi, coalesce(pi#>>'{payment_method,id}',
        CASE WHEN jsonb_typeof(pi->'payment_method') = 'string' THEN nullif(pi->>'payment_method', '') END,
        pi#>>'{last_payment_error,payment_method,id}') AS method_id
      FROM canceled
    ), matched AS (
      SELECT a.id, min(pi->>'id') AS pi_id, bool_or(method_id IS NOT NULL) AS method_matched
      FROM intents
      JOIN stripe_invoice_charge_attempts a ON a.id::text = pi->'metadata'->>'saved_card_attempt_id'
      JOIN invoices i ON i.id = a.invoice_id
      WHERE i.id::text = pi->'metadata'->>'waves_invoice_id'
        AND i.customer_id::text = pi->'metadata'->>'waves_customer_id'
        AND nullif(pi->>'id', '') IS NOT NULL
        AND (a.stripe_payment_intent_id IS NULL OR a.stripe_payment_intent_id = pi->>'id')
        AND (method_id IS NULL OR method_id = a.stripe_payment_method_id)
        AND (a.decline_code = 'authentication_required' OR a.status IN ('claimed', 'ambiguous'))
      GROUP BY a.id HAVING count(DISTINCT pi->>'id') = 1
    )
    UPDATE stripe_invoice_charge_attempts a SET authentication_canceled_intent_id = matched.pi_id,
      stripe_payment_intent_id = CASE WHEN matched.method_matched THEN matched.pi_id ELSE a.stripe_payment_intent_id END
    FROM matched WHERE a.id = matched.id
  `);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
    table.dropColumn('authentication_canceled_intent_id');
  });
};
