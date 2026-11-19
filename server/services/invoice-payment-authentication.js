const { validate: isUuid } = require('uuid');

// An off-session authentication decline closes the local claim, but its
// PaymentIntent can still settle. Both checkout and Billing use this predicate.
function whereAwaitingAuthentication(query, table) {
  return query.where({
    [`${table}.status`]: 'failed',
    [`${table}.decline_code`]: 'authentication_required',
  }).whereNotNull(`${table}.resolved_at`).where(function withoutMatchingCancellation() {
    this.whereNull(`${table}.authentication_canceled_intent_id`)
      .orWhereNull(`${table}.stripe_payment_intent_id`)
      .orWhereColumn(`${table}.authentication_canceled_intent_id`, '<>', `${table}.stripe_payment_intent_id`);
  });
}

// Stripe records the owner at submission. Follow a different owner only when
// every active merge names this invoice and has exactly one successor.
function whereProvenInvoiceOwner(query, { invoiceAlias, invoiceId, metadataCustomerId }) {
  query.where(function currentOrMergedOwner() {
    this.where(`${invoiceAlias}.customer_id`, metadataCustomerId).orWhereRaw(`(
      WITH RECURSIVE transfers AS NOT MATERIALIZED (
        SELECT loser_customer_id, winner_customer_id FROM customer_merge_journal
         WHERE undone_at IS NULL
           AND repointed_ids ->> 'version' = '1'
           AND (repointed_ids -> 'tables' -> 'invoices.customer_id') @> jsonb_build_array(?::text)
      ), ownership_chain(customer_id, path) AS (
        SELECT ?::uuid, ARRAY[?::uuid]
        UNION ALL
        SELECT next.winner_customer_id, chain.path || next.winner_customer_id
          FROM ownership_chain chain
          JOIN LATERAL (
            SELECT winner_customer_id, count(*) OVER () AS successors
              FROM transfers WHERE loser_customer_id = chain.customer_id
          ) next ON next.successors = 1
         WHERE NOT next.winner_customer_id = ANY(chain.path)
      )
      SELECT EXISTS (
        SELECT 1 FROM ownership_chain chain WHERE chain.customer_id = ??
           AND NOT EXISTS (SELECT 1 FROM transfers WHERE loser_customer_id = chain.customer_id)
      )
    )`, [invoiceId, metadataCustomerId, metadataCustomerId, `${invoiceAlias}.customer_id`]);
  });
}

// Both the signed webhook and the operator's server-side Stripe retrieval
// must identify the same saved-card attempt, invoice, owner and tender.
function matchingSavedCardIntent(intent, database, { lockInvoice = false, settled = false } = {}) {
  const meta = intent.metadata || {};
  if (!intent.id || meta.source !== 'admin_card_on_file') return;
  if (![meta.waves_invoice_id, meta.waves_customer_id, meta.saved_card_attempt_id].every(isUuid)) return;
  const methodId = (typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id)
    || (intent.status === 'canceled' && intent.last_payment_error?.payment_method?.id) || null;
  const invoice = database('invoices').select('id')
    .where({ id: meta.waves_invoice_id, customer_id: meta.waves_customer_id });
  if (settled) invoice.where({ status: 'paid', stripe_payment_intent_id: intent.id });
  if (lockInvoice) invoice.forShare();
  const query = database('stripe_invoice_charge_attempts')
    .where({ id: meta.saved_card_attempt_id, invoice_id: meta.waves_invoice_id })
    .whereIn('invoice_id', invoice)
    .where(function compatibleIntent() {
      this.whereNull('stripe_payment_intent_id').orWhere('stripe_payment_intent_id', intent.id);
    });
  if (methodId) query.where({ stripe_payment_method_id: methodId });
  return { query, methodId };
}

function matchingCancellation(intent, database, lockInvoice = false) {
  const meta = intent.metadata || {};
  if (intent.status !== 'canceled' || !intent.id || meta.source !== 'admin_card_on_file') return;
  if (![meta.waves_invoice_id, meta.waves_customer_id, meta.saved_card_attempt_id].every(isUuid)) return;
  const methodId = (typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id)
    || intent.last_payment_error?.payment_method?.id || null;
  const invoiceAlias = 'cancellation_invoice';
  const invoice = database(`invoices as ${invoiceAlias}`).select(`${invoiceAlias}.id`)
    .where(`${invoiceAlias}.id`, meta.waves_invoice_id);
  whereProvenInvoiceOwner(invoice, {
    invoiceAlias,
    invoiceId: meta.waves_invoice_id,
    metadataCustomerId: meta.waves_customer_id,
  });
  if (lockInvoice) invoice.forShare();
  const query = database('stripe_invoice_charge_attempts')
    .where({ id: meta.saved_card_attempt_id, invoice_id: meta.waves_invoice_id })
    .whereIn('invoice_id', invoice)
    .where(function relevantAttempt() {
      this.whereIn('status', ['claimed', 'ambiguous']).orWhere({ status: 'failed', decline_code: 'authentication_required' });
    })
    .where(function compatibleIntent() {
      this.whereNull('stripe_payment_intent_id').orWhere('stripe_payment_intent_id', intent.id);
    });
  if (methodId) query.where({ stripe_payment_method_id: methodId });
  const evidence = {
    authentication_canceled_intent_id: intent.id,
    ...(methodId ? { stripe_payment_intent_id: intent.id } : {}),
  };
  return { query, evidence };
}

async function findSettlingAuthenticationAttempt(intent, invoice, database, { lock = false } = {}) {
  if (intent.status !== 'succeeded' || !invoice || intent.metadata?.waves_invoice_id !== invoice.id
    || intent.metadata?.waves_customer_id !== invoice.customer_id) return null;
  const match = matchingSavedCardIntent(intent, database);
  if (!match) return null;
  const { query, methodId } = match;
  if (!methodId) query.where({ stripe_payment_intent_id: intent.id });
  if (lock) query.forUpdate();
  return whereAwaitingAuthentication(query, 'stripe_invoice_charge_attempts')
    .first('id', 'amount', 'credit_applied_delta', 'credit_applied_total', 'canceled_checkout_payment_intent_id');
}

// A different saved card can collect the exact same amount. Check for the
// invoice's other pending attempts independently of the incoming PI metadata.
async function assertNoConflictingAuthenticationSettlement(intent, invoice, verifiedAttempt, database) {
  if (!invoice || !isUuid(invoice.id) || (invoice.status === 'paid' && invoice.stripe_payment_intent_id === intent.id)) return;
  const query = database('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id });
  if (verifiedAttempt) query.whereNot({ id: verifiedAttempt.id });
  const conflict = await whereAwaitingAuthentication(query, 'stripe_invoice_charge_attempts').first('id');
  if (conflict) {
    // An earlier lookup may have seen this attempt as claimed/ambiguous (or
    // just missed its transition), while this read sees the worker's committed
    // authentication_required state. Re-run the complete identity matcher on
    // the same database handle. Only the exact attempt/invoice/customer/method/
    // PI match is retryable; wrong-card/source/binding challenges keep the
    // ordinary conflict quarantine below. A retry authorizes nothing itself.
    const metadataAttemptId = intent.metadata?.saved_card_attempt_id;
    const transitioned = metadataAttemptId && String(conflict.id) === String(metadataAttemptId)
      ? await findSettlingAuthenticationAttempt(intent, invoice, database)
      : null;
    if (transitioned && String(transitioned.id) === String(conflict.id)) {
      throw Object.assign(new Error(`Saved-card attempt ${conflict.id} changed state during succeeded settlement; retry`), {
        code: 'SAVED_CARD_SETTLEMENT_STATE_CHANGED',
        attemptId: conflict.id,
      });
    }
    throw Object.assign(new Error(`Captured PI ${intent.id} conflicts with pending saved-card authentication ${conflict.id} on invoice ${invoice.id}`), {
      code: 'SAVED_CARD_SETTLEMENT_IDENTITY_CONFLICT', invoice,
    });
  }
}

// A webhook can arrive before the worker records the decline. Without a
// method, its candidate clears the hold only if the worker binds the same PI.
async function recordAuthenticationCancellation(intent, database) {
  const match = matchingCancellation(intent, database);
  if (match) await match.query.update(match.evidence);
}

// Run inside the transaction that pays the invoice. A signed success alone
// cannot release a hold when the payment was quarantined or linked elsewhere.
async function recordAuthenticationSettlement(intent, trx) {
  if (intent.status !== 'succeeded') return;
  const match = matchingSavedCardIntent(intent, trx, { settled: true });
  if (!match) return;
  const { query, methodId } = match;
  if (!methodId) query.where({ stripe_payment_intent_id: intent.id });
  return whereAwaitingAuthentication(query, 'stripe_invoice_charge_attempts')
    .whereExists(trx('payments').select('id').where({
      customer_id: intent.metadata.waves_customer_id, stripe_payment_intent_id: intent.id, status: 'paid',
    }).whereRaw("(metadata->>'invoice_id' IS NULL OR metadata->>'invoice_id' = ?)", [intent.metadata.waves_invoice_id]))
    .update({
      status: 'succeeded', stripe_payment_intent_id: intent.id, decline_code: null, error_message: null,
      resolved_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
}

async function verifySavedCardCancellation({ attemptId, intentId, stripe, database, execute = false }) {
  if (!isUuid(attemptId) || !/^pi_[A-Za-z0-9]+$/.test(intentId || '')) {
    throw new Error('Supply a saved-card attempt UUID and a Stripe PaymentIntent ID.');
  }
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (intent?.id !== intentId || intent.metadata?.saved_card_attempt_id !== attemptId.toLowerCase()) {
    throw new Error('Stripe did not return the requested PaymentIntent for this saved-card attempt.');
  }
  const match = matchingCancellation(intent, database, execute);
  if (!match) throw new Error('Stripe did not verify a canceled saved-card payment for this invoice.');

  // Historical recovery is for a finished authentication decline only. The
  // UPDATE repeats every identity check, including any intervening binding.
  const { query, evidence } = match;
  query.where({ status: 'failed', decline_code: 'authentication_required' }).whereNotNull('resolved_at')
    .where(function compatibleEvidence() {
      this.whereNull('authentication_canceled_intent_id').orWhere('authentication_canceled_intent_id', intentId);
    });
  if (!evidence.stripe_payment_intent_id) query.where({ stripe_payment_intent_id: intentId });

  const verified = execute ? await query.update(evidence) : await query.first('id');
  if (!verified) throw new Error('The local authentication decline or its payment identity does not match the Stripe cancellation.');
  return { attemptId, intentId, result: execute ? 'cancellation_recorded' : 'cancellation_verified' };
}

module.exports = {
  whereAwaitingAuthentication, findSettlingAuthenticationAttempt, assertNoConflictingAuthenticationSettlement, recordAuthenticationCancellation,
  recordAuthenticationSettlement, verifySavedCardCancellation,
};
