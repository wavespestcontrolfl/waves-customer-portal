/**
 * Repair historical off-session authentication challenges that succeeded and
 * settled locally before recordAuthenticationSettlement existed.
 *
 * A paid payment row alone is insufficient: the historical webhook could
 * commit that row before the invoice/payment transaction failed. Paid evidence
 * therefore also requires the invoice to be paid and bound to the same PI.
 * A later dispute or refund can legitimately reopen/unbind the invoice, so an
 * exact disputed/refunded ledger row remains independent settlement evidence.
 * Every repair requires two independent records: a retained, processed
 * payment_intent.succeeded event whose immutable attempt/invoice/customer/card
 * identity and captured-money parts match, and an exact Stripe payment ledger
 * row for that PI. This migration predates worker_payment_intent_id, so the
 * legacy general PI column cannot identify the attempt: a failure webhook may
 * have written it first.
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
    ), retained_successes AS (
      SELECT
        NULLIF(webhook.payload->'object'->>'id', '') AS pi_id,
        COALESCE(
          CASE
            WHEN jsonb_typeof(webhook.payload->'object'->'payment_method') = 'object'
              THEN NULLIF(webhook.payload#>>'{object,payment_method,id}', '')
          END,
          CASE
            WHEN jsonb_typeof(webhook.payload->'object'->'payment_method') = 'string'
              THEN NULLIF(webhook.payload->'object'->>'payment_method', '')
          END
        ) AS stripe_payment_method_id,
        webhook.payload->'object'->'metadata'->>'source' AS source,
        webhook.payload->'object'->'metadata'->>'saved_card_attempt_id' AS saved_card_attempt_id,
        webhook.payload->'object'->'metadata'->>'waves_invoice_id' AS waves_invoice_id,
        webhook.payload->'object'->'metadata'->>'waves_customer_id' AS waves_customer_id,
        CASE
          WHEN jsonb_typeof(webhook.payload->'object'->'amount') = 'number'
            AND webhook.payload->'object'->>'amount' ~ '^[0-9]+$'
            THEN (webhook.payload->'object'->>'amount')::numeric
        END AS intended_cents,
        CASE
          WHEN jsonb_typeof(webhook.payload->'object'->'amount_received') = 'number'
            AND webhook.payload->'object'->>'amount_received' ~ '^[0-9]+$'
            THEN (webhook.payload->'object'->>'amount_received')::numeric
        END AS captured_cents,
        CASE
          WHEN webhook.payload->'object'->'metadata'->>'base_amount' ~ '^[0-9]+([.][0-9]{1,2}){0,1}$'
            THEN ROUND((webhook.payload->'object'->'metadata'->>'base_amount')::numeric * 100)
        END AS base_cents,
        CASE
          WHEN webhook.payload->'object'->'metadata'->>'card_surcharge' ~ '^[0-9]+([.][0-9]{1,2}){0,1}$'
            THEN ROUND((webhook.payload->'object'->'metadata'->>'card_surcharge')::numeric * 100)
        END AS surcharge_cents
      FROM stripe_webhook_events webhook
      WHERE webhook.processed = true
        AND webhook.event_type = 'payment_intent.succeeded'
        AND webhook.payload->'object'->>'status' = 'succeeded'
    ), candidate_intents AS (
      -- Only retained attempt-specific success is independent identity proof.
      SELECT DISTINCT
        attempt.id AS attempt_id,
        attempt.invoice_id,
        attempt.customer_id,
        attempt.payment_method_id,
        attempt.stripe_payment_method_id,
        attempt.authentication_canceled_intent_id,
        attempt.amount AS attempt_amount,
        attempt.credit_applied_delta,
        attempt.credit_applied_total,
        success.intended_cents,
        success.captured_cents,
        success.base_cents,
        success.surcharge_cents,
        success.pi_id
      FROM eligible_attempts attempt
      JOIN retained_successes success
        ON success.pi_id IS NOT NULL
       AND success.source = 'admin_card_on_file'
       AND success.stripe_payment_method_id = attempt.stripe_payment_method_id
       AND success.saved_card_attempt_id = attempt.id::text
       AND success.waves_invoice_id = attempt.invoice_id::text
       AND success.waves_customer_id = attempt.customer_id::text
    ), unique_candidates AS (
      SELECT attempt_id, MIN(pi_id) AS pi_id
      FROM candidate_intents
      GROUP BY attempt_id
      HAVING COUNT(DISTINCT pi_id) = 1
    ), exact_settlements AS (
      SELECT DISTINCT candidate.attempt_id, candidate.pi_id
      FROM candidate_intents candidate
      JOIN unique_candidates one USING (attempt_id, pi_id)
      JOIN payments payment
        ON payment.stripe_payment_intent_id = candidate.pi_id
       AND payment.customer_id = candidate.customer_id
       AND payment.processor = 'stripe'
       -- The retained Stripe event supplies the actual capture and its quoted
       -- principal/surcharge split. Both independent local money records must
       -- agree to the cent before this historical hold can close.
       AND candidate.captured_cents > 0
       AND candidate.intended_cents = candidate.captured_cents
       AND candidate.base_cents >= 0
       AND candidate.surcharge_cents >= 0
       AND candidate.base_cents + candidate.surcharge_cents = candidate.captured_cents
       AND candidate.attempt_amount IS NOT NULL
       AND ROUND(candidate.attempt_amount * 100) = candidate.captured_cents
       AND payment.amount IS NOT NULL
       AND ROUND(payment.amount * 100) = candidate.captured_cents
       -- Older ledger writers did not always populate these columns. Their
       -- absence is not contradictory when the event, attempt, cash and paid
       -- invoice gross agree; a present value remains corroboration.
       AND (payment.base_amount_cents IS NULL OR payment.base_amount_cents = candidate.base_cents)
       AND (payment.surcharge_amount_cents IS NULL OR payment.surcharge_amount_cents = candidate.surcharge_cents)
       AND candidate.credit_applied_delta IS NOT NULL
       AND candidate.credit_applied_total IS NOT NULL
       AND candidate.credit_applied_delta >= 0
       AND candidate.credit_applied_total >= candidate.credit_applied_delta
       AND (
         payment.status IN ('disputed', 'refunded')
         OR (
           payment.status = 'paid'
           AND EXISTS (
             SELECT 1
             FROM invoices completed_invoice
             WHERE completed_invoice.id = candidate.invoice_id
               AND completed_invoice.customer_id = candidate.customer_id
               AND completed_invoice.status = 'paid'
               AND completed_invoice.stripe_payment_intent_id = candidate.pi_id
               AND ROUND(COALESCE(completed_invoice.credit_applied, 0) * 100)
                 = ROUND(candidate.credit_applied_total * 100)
               -- A paid flip folds earlier hand-recorded part payments into
               -- invoice.total and resets amount_paid. Match the same durable
               -- ledger predicate used by stripe-webhook's reopen paths.
               AND ROUND(completed_invoice.total * 100)
                 = candidate.captured_cents
                   + ROUND(candidate.credit_applied_total * 100)
                   + COALESCE((
                     SELECT SUM(ROUND(part.amount * 100))
                     FROM payments part
                     WHERE part.metadata->>'invoice_id' = candidate.invoice_id::text
                       AND part.metadata->>'partial_payment' = 'true'
                       AND part.status = 'paid'
                   ), 0)
           )
         )
       )
       AND payment.metadata->>'invoice_id' = candidate.invoice_id::text
       AND (
         payment.payment_method_id IS NULL
         OR candidate.payment_method_id IS NULL
         OR payment.payment_method_id = candidate.payment_method_id
       )
      WHERE candidate.authentication_canceled_intent_id IS DISTINCT FROM candidate.pi_id
        -- A retained success that reuses either this PI or this attempt while
        -- naming a different identity makes the historical evidence ambiguous.
        AND NOT EXISTS (
          SELECT 1
          FROM retained_successes conflicting_event
          WHERE (
            conflicting_event.pi_id = candidate.pi_id
            OR conflicting_event.saved_card_attempt_id = candidate.attempt_id::text
          )
            AND (
              conflicting_event.pi_id IS DISTINCT FROM candidate.pi_id
              OR conflicting_event.source IS DISTINCT FROM 'admin_card_on_file'
              OR conflicting_event.stripe_payment_method_id IS DISTINCT FROM candidate.stripe_payment_method_id
              OR conflicting_event.saved_card_attempt_id IS DISTINCT FROM candidate.attempt_id::text
              OR conflicting_event.waves_invoice_id IS DISTINCT FROM candidate.invoice_id::text
              OR conflicting_event.waves_customer_id IS DISTINCT FROM candidate.customer_id::text
              OR conflicting_event.intended_cents IS DISTINCT FROM candidate.intended_cents
              OR conflicting_event.captured_cents IS DISTINCT FROM candidate.captured_cents
              OR conflicting_event.base_cents IS DISTINCT FROM candidate.base_cents
              OR conflicting_event.surcharge_cents IS DISTINCT FROM candidate.surcharge_cents
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM payments conflicting
          WHERE conflicting.stripe_payment_intent_id = candidate.pi_id
            AND conflicting.id <> payment.id
        )
    )
    UPDATE stripe_invoice_charge_attempts attempt
    SET status = 'succeeded',
        stripe_payment_intent_id = exact_settlements.pi_id,
        decline_code = NULL,
        error_message = NULL,
        resolved_at = NOW(),
        updated_at = NOW()
    FROM exact_settlements
    WHERE attempt.id = exact_settlements.attempt_id
      AND attempt.status = 'failed'
      AND attempt.decline_code = 'authentication_required'
      AND attempt.resolved_at IS NOT NULL
      AND (attempt.stripe_payment_intent_id IS NULL OR attempt.stripe_payment_intent_id = exact_settlements.pi_id)
  `);
};

// Historical settlement cannot be distinguished from a live settlement after
// repair. Reopening its authentication hold on rollback could authorize a
// second collection, so this data correction is intentionally irreversible.
exports.down = async function down() {};
