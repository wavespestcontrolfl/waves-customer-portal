const { validate: isUuid } = require('uuid');

// An off-session authentication decline closes the local claim, but its
// PaymentIntent can still settle. Both checkout and Billing use this predicate.
function whereAwaitingAuthentication(query, table) {
  return query.where(function awaitingOriginalIntent() {
    this.where(function authenticationDecline() {
      // Keep this comparison two-valued. Callers such as the termite renewal
      // presentation guard negate this whole predicate; a historical NULL
      // decline is an ordinary provider failure, not SQL UNKNOWN. Conflicting
      // worker/provider identities below still remain held regardless of the
      // nullable decline code.
      this.where({ [`${table}.status`]: 'failed' })
        .whereRaw('COALESCE(?? = ?, FALSE)', [`${table}.decline_code`, 'authentication_required'])
        .whereNotNull(`${table}.resolved_at`).where(function withoutMatchingCancellation() {
          this.whereNull(`${table}.authentication_canceled_intent_id`)
            .orWhereNull(`${table}.stripe_payment_intent_id`)
            .orWhereNull(`${table}.worker_payment_intent_id`)
            .orWhereColumn(`${table}.authentication_canceled_intent_id`, '<>', `${table}.stripe_payment_intent_id`)
            .orWhereColumn(`${table}.authentication_canceled_intent_id`, '<>', `${table}.worker_payment_intent_id`);
        });
    }).orWhere(function conflictingIdentities() {
      // A legacy failure handler can still change the general ID and decline
      // code. Neither its new status nor a cancellation for that ID is proof.
      this.whereRaw('?? IS NOT NULL AND ?? IS NOT NULL AND ?? <> ??', [
        `${table}.worker_payment_intent_id`, `${table}.stripe_payment_intent_id`,
        `${table}.worker_payment_intent_id`, `${table}.stripe_payment_intent_id`,
      ]);
    });
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
           AND (repointed_ids -> 'tables' -> 'invoices.customer_id') @> jsonb_build_array((?::uuid)::text)
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

// Validate every provider-controlled identity field before opening a
// transaction or reading the database. Unrelated cancellation payloads remain
// a no-op without consuming a connection.
function cancellationIdentity(intent) {
  const meta = intent.metadata || {};
  if (intent.status !== 'canceled' || !intent.id || meta.source !== 'admin_card_on_file') return;
  if (![meta.waves_invoice_id, meta.waves_customer_id, meta.saved_card_attempt_id].every(isUuid)) return;
  const methodId = (typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id)
    || intent.last_payment_error?.payment_method?.id || null;
  return {
    intent,
    meta,
    methodId,
    evidence: {
      authentication_canceled_intent_id: intent.id,
    },
  };
}

// Both the signed webhook and the operator's server-side Stripe retrieval
// must identify the same saved-card attempt, invoice, owner and tender. For a
// writer this query is built only AFTER the invoice lock statement completes,
// so its ownership journal read receives a fresh READ COMMITTED snapshot.
function matchingCancellation(identity, database) {
  const { intent, meta, methodId, evidence } = identity;
  const invoiceAlias = 'cancellation_invoice';
  const invoice = database(`invoices as ${invoiceAlias}`).select(`${invoiceAlias}.id`)
    .where(`${invoiceAlias}.id`, meta.waves_invoice_id);
  whereProvenInvoiceOwner(invoice, {
    invoiceAlias,
    invoiceId: meta.waves_invoice_id,
    metadataCustomerId: meta.waves_customer_id,
  });
  const query = database('stripe_invoice_charge_attempts')
    .where({ id: meta.saved_card_attempt_id, invoice_id: meta.waves_invoice_id })
    .whereIn('invoice_id', invoice)
    .where(function relevantAttempt() {
      this.whereIn('status', ['claimed', 'ambiguous']).orWhere({ status: 'failed', decline_code: 'authentication_required' });
    })
    .where(function originalIntent() {
      this.whereNull('worker_payment_intent_id').orWhere('worker_payment_intent_id', intent.id);
    })
    .where(function compatibleIntent() {
      this.whereNull('stripe_payment_intent_id').orWhere('stripe_payment_intent_id', intent.id);
    })
    .where(function compatibleCancellation() {
      // A signed cancellation can arrive before the charging worker binds the
      // intent. Keep that candidate until the worker identifies the actual PI.
      this.whereNull('authentication_canceled_intent_id')
        .orWhere('authentication_canceled_intent_id', intent.id)
        .orWhere('stripe_payment_intent_id', intent.id);
    });
  if (methodId) query.where({ stripe_payment_method_id: methodId });
  return { query, evidence };
}

async function withCancellationInvoiceLock(database, identity, write) {
  const run = async (trx) => {
    // ID only: ownership can change while this statement waits. The separate
    // write below must re-read both the invoice and its journal after the lock.
    const invoice = await trx('invoices')
      .where({ id: identity.meta.waves_invoice_id })
      .forShare()
      .first('id');
    if (!invoice) return 0;
    return write(trx);
  };
  return database?.isTransaction === true ? run(database) : database.transaction(run);
}

// A webhook can arrive before the worker records the decline. Without a
// method, its candidate clears the hold only if the worker binds the same PI.
async function recordAuthenticationCancellation(intent, database) {
  const identity = cancellationIdentity(intent);
  if (!identity) return;
  await withCancellationInvoiceLock(database, identity, async (trx) => {
    const match = matchingCancellation(identity, trx);
    return match.query.update(match.evidence);
  });
}

module.exports = {
  whereAwaitingAuthentication, recordAuthenticationCancellation,
};
