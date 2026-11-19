/**
 * Repair historical off-session authentication challenges that succeeded and
 * settled locally before recordAuthenticationSettlement existed.
 *
 * A later dispute or refund can reopen/unbind the invoice, so the current
 * invoice status and PI pointer are not settlement evidence. Every repair
 * requires an exact, non-conflicting Stripe payment ledger row for the same
 * PI, customer and invoice. Paid, disputed and refunded rows all prove that
 * the charge settled locally. The attempt's durable PI binding is sufficient
 * identity after webhook retention expires; only an unbound attempt requires
 * a processed retained payment_intent.succeeded event whose immutable
 * attempt/invoice/customer metadata and saved method match it.
 *
 * Multiple candidate PIs or any conflicting local linkage fail closed. The
 * update mirrors recordAuthenticationSettlement and is idempotent.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    WITH eligible_attempts AS (
      SELECT a.*, i.customer_id
      FROM stripe_invoice_charge_attempts a
      JOIN invoices i ON i.id = a.invoice_id
      WHERE a.status = 'failed'
        AND a.decline_code = 'authentication_required'
        AND a.resolved_at IS NOT NULL
    ), candidate_intents AS (
      -- A durable attempt -> PI binding plus the independently linked local
      -- ledger is sufficient even after the 90-day webhook purge.
      SELECT
        attempt.id AS attempt_id,
        attempt.invoice_id,
        attempt.customer_id,
        attempt.payment_method_id,
        attempt.authentication_canceled_intent_id,
        attempt.stripe_payment_intent_id AS pi_id
      FROM eligible_attempts attempt
      WHERE attempt.stripe_payment_intent_id IS NOT NULL

      UNION ALL

      -- An old row without a PI binding needs the retained signed-event ledger
      -- to bind one, including the immutable saved Stripe method.
      SELECT DISTINCT
        attempt.id AS attempt_id,
        attempt.invoice_id,
        attempt.customer_id,
        attempt.payment_method_id,
        attempt.authentication_canceled_intent_id,
        NULLIF(webhook.payload->'object'->>'id', '') AS pi_id
      FROM eligible_attempts attempt
      JOIN stripe_webhook_events webhook
        ON webhook.processed = true
       AND webhook.event_type = 'payment_intent.succeeded'
       AND webhook.payload->'object'->>'status' = 'succeeded'
       AND webhook.payload->'object'->'metadata'->>'source' = 'admin_card_on_file'
       AND NULLIF(webhook.payload->'object'->>'id', '') IS NOT NULL
       AND COALESCE(
         CASE
           WHEN jsonb_typeof(webhook.payload->'object'->'payment_method') = 'object'
             THEN NULLIF(webhook.payload#>>'{object,payment_method,id}', '')
         END,
         CASE
           WHEN jsonb_typeof(webhook.payload->'object'->'payment_method') = 'string'
             THEN NULLIF(webhook.payload->'object'->>'payment_method', '')
         END
       ) = attempt.stripe_payment_method_id
       AND webhook.payload->'object'->'metadata'->>'saved_card_attempt_id' = attempt.id::text
       AND webhook.payload->'object'->'metadata'->>'waves_invoice_id' = attempt.invoice_id::text
       AND webhook.payload->'object'->'metadata'->>'waves_customer_id' = attempt.customer_id::text
      WHERE attempt.stripe_payment_intent_id IS NULL
    ), exact_settlements AS (
      SELECT DISTINCT candidate.attempt_id, candidate.pi_id
      FROM candidate_intents candidate
      JOIN payments payment
        ON payment.stripe_payment_intent_id = candidate.pi_id
       AND payment.customer_id = candidate.customer_id
       AND payment.processor = 'stripe'
       AND payment.status IN ('paid', 'disputed', 'refunded')
       AND payment.metadata->>'invoice_id' = candidate.invoice_id::text
       AND (
         payment.payment_method_id IS NULL
         OR candidate.payment_method_id IS NULL
         OR payment.payment_method_id = candidate.payment_method_id
       )
      WHERE candidate.authentication_canceled_intent_id IS DISTINCT FROM candidate.pi_id
        AND NOT EXISTS (
          SELECT 1
          FROM payments conflicting
          WHERE conflicting.stripe_payment_intent_id = candidate.pi_id
            AND conflicting.id <> payment.id
            AND (
              conflicting.customer_id IS DISTINCT FROM candidate.customer_id
              OR conflicting.metadata->>'invoice_id' IS DISTINCT FROM candidate.invoice_id::text
            )
        )
    ), unambiguous AS (
      SELECT attempt_id, MIN(pi_id) AS pi_id
      FROM exact_settlements
      GROUP BY attempt_id
      HAVING COUNT(DISTINCT pi_id) = 1
    )
    UPDATE stripe_invoice_charge_attempts attempt
    SET status = 'succeeded',
        stripe_payment_intent_id = unambiguous.pi_id,
        decline_code = NULL,
        error_message = NULL,
        resolved_at = NOW(),
        updated_at = NOW()
    FROM unambiguous
    WHERE attempt.id = unambiguous.attempt_id
      AND attempt.status = 'failed'
      AND attempt.decline_code = 'authentication_required'
      AND attempt.resolved_at IS NOT NULL
      AND (attempt.stripe_payment_intent_id IS NULL OR attempt.stripe_payment_intent_id = unambiguous.pi_id)
  `);
};

// Historical settlement cannot be distinguished from a live settlement after
// repair. Reopening its authentication hold on rollback could authorize a
// second collection, so this data correction is intentionally irreversible.
exports.down = async function down() {};
