const {
  assertNoInvoiceChargeReconciliationPending,
  claimInvoiceSavedCardCharge,
  commitInvoiceSavedCardChargeSubmission,
  isAmbiguousStripeChargeError,
  markInvoiceSavedCardChargeAttempt,
  parkInvoiceForSavedCardReconciliation,
  persistSavedCardChargeCreditDelta,
  resolveFailedInvoiceSavedCardChargeAttempt,
  resolveNoFundsSavedCardChargeAttempt,
  resolveSettledInvoiceSavedCardChargeAttempt,
  savedCardClaimIsStale,
  savedCardAttemptOutcome,
  savedCardChargeNeedsReconciliation,
  savedCardChargeSuppressesAlternateCollection,
  shouldTreatSavedCardFailureAsAmbiguous,
} = require('../services/stripe');

describe('Stripe charge outcome classification', () => {
  test.each(['StripeConnectionError', 'StripeAPIError'])(
    'treats a %s without a PaymentIntent as ambiguous',
    (type) => {
      expect(isAmbiguousStripeChargeError({ type })).toBe(true);
      expect(isAmbiguousStripeChargeError({ raw: { type } })).toBe(true);
    },
  );

  test('does not classify deterministic failures as ambiguous', () => {
    expect(isAmbiguousStripeChargeError({ type: 'StripeCardError', code: 'card_declined' })).toBe(false);
    expect(isAmbiguousStripeChargeError({ type: 'StripeInvalidRequestError' })).toBe(false);
  });

  test('does not classify a Stripe error with a returned PaymentIntent as ambiguous', () => {
    expect(isAmbiguousStripeChargeError({
      type: 'StripeAPIError',
      payment_intent: { id: 'pi_known_1' },
    })).toBe(false);
    expect(isAmbiguousStripeChargeError({
      raw: { type: 'StripeConnectionError', payment_intent: { id: 'pi_known_2' } },
    })).toBe(false);
  });

  test.each([
    'STRIPE_CHARGED_DB_FAILED',
    'STRIPE_AMBIGUOUS_OUTCOME',
  ])('requires reconciliation for terminal saved-card outcome %s', (code) => {
    expect(savedCardChargeNeedsReconciliation({ code })).toBe(true);
  });

  test('suppresses alternate collection without parking for a fresh in-progress claim', () => {
    const err = { code: 'STRIPE_CHARGE_IN_PROGRESS' };
    expect(savedCardChargeSuppressesAlternateCollection(err)).toBe(true);
    expect(savedCardChargeNeedsReconciliation(err)).toBe(false);
  });

  test('only treats a claimed attempt as stale after the recovery window', () => {
    const now = Date.parse('2026-07-14T12:10:00Z');
    expect(savedCardClaimIsStale({ created_at: '2026-07-14T12:06:00Z' }, now)).toBe(false);
    expect(savedCardClaimIsStale({ created_at: '2026-07-14T12:05:00Z' }, now)).toBe(true);
  });

  test('suppresses deposit-held completion prompts without treating them as a saved-card charge outcome', () => {
    const err = { code: 'DEPOSIT_RECONCILIATION_REQUIRED' };
    expect(savedCardChargeSuppressesAlternateCollection(err)).toBe(true);
    expect(savedCardChargeNeedsReconciliation(err)).toBe(false);
  });

  test('only treats transport failures as charge ambiguity after create was submitted', () => {
    const error = { type: 'StripeConnectionError' };
    expect(shouldTreatSavedCardFailureAsAmbiguous({ chargeSubmitted: false, error })).toBe(false);
    expect(shouldTreatSavedCardFailureAsAmbiguous({ chargeSubmitted: true, error })).toBe(true);
  });
});

function reconciliationDb({ chargeAttempt = null, orphan = null, ambiguous = null } = {}) {
  const updates = [];
  const database = jest.fn((table) => {
    const query = {};
    ['where', 'whereIn', 'whereNull', 'whereRaw', 'orWhereColumn'].forEach((method) => {
      query[method] = jest.fn((arg) => {
        if (method === 'where' && typeof arg === 'function') arg.call(query);
        return query;
      });
    });
    query.first = jest.fn(async () => {
      if (table === 'stripe_invoice_charge_attempts') return chargeAttempt;
      if (table === 'stripe_orphan_charges') return orphan;
      return ambiguous;
    });
    query.update = jest.fn(async (payload) => {
      updates.push(payload);
      return 1;
    });
    return query;
  });
  database.updates = updates;
  return database;
}

describe('saved-card invoice reconciliation fence', () => {
  test('blocks while a committed charge claim is active', async () => {
    const database = reconciliationDb({
      chargeAttempt: { id: 'attempt-1', status: 'claimed', idempotency_key: 'attempt-key-1' },
    });

    await expect(assertNoInvoiceChargeReconciliationPending('inv-1', database))
      .rejects.toMatchObject({
        code: 'STRIPE_CHARGE_IN_PROGRESS',
        chargeAttemptId: 'attempt-1',
        idempotencyKey: 'attempt-key-1',
        reconciliationRequired: false,
      });
    expect(database).not.toHaveBeenCalledWith('stripe_orphan_charges');
  });

  test('promotes a stale committed claim to ambiguous reconciliation', async () => {
    const database = reconciliationDb({
      chargeAttempt: {
        id: 'attempt-stale',
        status: 'claimed',
        idempotency_key: 'attempt-key-stale',
        submitted_at: new Date(Date.now() - (6 * 60 * 1000)).toISOString(),
        created_at: new Date(Date.now() - (6 * 60 * 1000)).toISOString(),
      },
    });

    await expect(assertNoInvoiceChargeReconciliationPending('inv-1', database))
      .rejects.toMatchObject({
        code: 'STRIPE_AMBIGUOUS_OUTCOME',
        chargeAttemptId: 'attempt-stale',
        reconciliationRequired: true,
      });
    expect(database.updates).toContainEqual(expect.objectContaining({ status: 'ambiguous' }));
  });

  test('releases a stale claim that never reached Stripe submission', async () => {
    const database = reconciliationDb({
      chargeAttempt: {
        id: 'attempt-pre-submit',
        status: 'claimed',
        idempotency_key: 'attempt-key-pre-submit',
        amount: '42.00',
        submitted_at: null,
        stripe_payment_intent_id: null,
        created_at: new Date(Date.now() - (6 * 60 * 1000)).toISOString(),
      },
    });

    await expect(assertNoInvoiceChargeReconciliationPending('inv-1', database))
      .resolves.toBeUndefined();
    expect(database.updates).toContainEqual(expect.objectContaining({
      status: 'failed',
      resolved_at: expect.any(Date),
    }));
    expect(database).toHaveBeenCalledWith('stripe_orphan_charges');
  });

  test('blocks a later charge while an orphaned Stripe collection is unresolved', async () => {
    const database = reconciliationDb({ orphan: { stripe_payment_intent_id: 'pi_orphan_1' } });

    await expect(assertNoInvoiceChargeReconciliationPending('inv-1', database))
      .rejects.toMatchObject({
        code: 'STRIPE_CHARGED_DB_FAILED',
        stripePaymentIntentId: 'pi_orphan_1',
      });
    expect(database).toHaveBeenCalledWith('stripe_orphan_charges');
    expect(database).not.toHaveBeenCalledWith('payments');
  });

  test('blocks a later charge while a no-PI Stripe outcome is unresolved', async () => {
    const database = reconciliationDb({ ambiguous: { id: 'pay-ambiguous-1' } });

    await expect(assertNoInvoiceChargeReconciliationPending('inv-1', database))
      .rejects.toMatchObject({
        code: 'STRIPE_AMBIGUOUS_OUTCOME',
        paymentRecordId: 'pay-ambiguous-1',
      });
  });

  test('allows collection when no reconciliation fence exists', async () => {
    await expect(assertNoInvoiceChargeReconciliationPending('inv-1', reconciliationDb()))
      .resolves.toBeUndefined();
  });
});

function claimDb({ insertError = null, blocking = null } = {}) {
  let insertedAttempt = null;
  let insertFailuresRemaining = insertError ? 1 : 0;
  const calls = [];
  const makeQuery = (table, { root = false } = {}) => {
    calls.push(`${root ? 'root' : 'trx'}:${table}`);
    const query = {};
    ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereNull', 'orWhereColumn', 'forUpdate', 'orderByRaw'].forEach((method) => {
      query[method] = jest.fn((arg) => {
        if (['where', 'orWhere'].includes(method) && typeof arg === 'function') arg.call(query, query);
        return query;
      });
    });
    query.insert = jest.fn((payload) => {
      insertedAttempt = payload;
      return query;
    });
    query.returning = jest.fn(async () => {
      if (insertFailuresRemaining > 0) {
        insertFailuresRemaining -= 1;
        throw insertError;
      }
      return [{ ...insertedAttempt }];
    });
    query.first = jest.fn(async () => {
      if (table === 'invoices') return { id: 'inv-1' };
      return root ? blocking : null;
    });
    query.update = jest.fn(async () => 1);
    return query;
  };
  const database = jest.fn(table => makeQuery(table, { root: true }));
  database.transaction = jest.fn(async callback => callback(table => makeQuery(table)));
  database.calls = calls;
  return database;
}

describe('saved-card charge claim', () => {
  test('commits a stable attempt-scoped Stripe idempotency key before charging', async () => {
    const database = claimDb();

    await expect(claimInvoiceSavedCardCharge({
      invoiceId: 'inv-1',
      paymentMethodId: 'pm-1',
      stripePaymentMethodId: 'pm-stripe-1',
      attemptId: 'attempt-new',
      database,
    })).resolves.toMatchObject({
      id: 'attempt-new',
      status: 'claimed',
      stripe_payment_method_id: 'pm-stripe-1',
      idempotency_key: 'inv_card_on_file_inv-1_attempt-new',
    });
    expect(database.calls.slice(0, 5)).toEqual([
      'trx:invoices',
      'trx:stripe_invoice_charge_attempts',
      'trx:stripe_orphan_charges',
      'trx:payments',
      'trx:stripe_invoice_charge_attempts',
    ]);
  });

  test('maps a concurrent partial-unique collision to a non-retryable conflict', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    const database = claimDb({
      insertError: duplicate,
      blocking: { id: 'attempt-first', status: 'claimed', idempotency_key: 'attempt-key-first' },
    });

    await expect(claimInvoiceSavedCardCharge({
      invoiceId: 'inv-1',
      paymentMethodId: 'pm-2',
      stripePaymentMethodId: 'pm-stripe-2',
      attemptId: 'attempt-second',
      database,
    })).rejects.toMatchObject({
      code: 'STRIPE_CHARGE_IN_PROGRESS',
      chargeAttemptId: 'attempt-first',
      idempotencyKey: 'attempt-key-first',
      reconciliationRequired: false,
    });
  });

  test('keeps an ambiguous committed attempt terminal on a later collision', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    const database = claimDb({
      insertError: duplicate,
      blocking: { id: 'attempt-first', status: 'ambiguous', idempotency_key: 'attempt-key-first' },
    });

    await expect(claimInvoiceSavedCardCharge({
      invoiceId: 'inv-1',
      paymentMethodId: 'pm-2',
      stripePaymentMethodId: 'pm-stripe-2',
      attemptId: 'attempt-second',
      database,
    })).rejects.toMatchObject({
      code: 'STRIPE_AMBIGUOUS_OUTCOME',
      chargeAttemptId: 'attempt-first',
    });
  });

  test('releases a collided stale pre-submit claim and acquires a new claim', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    const database = claimDb({
      insertError: duplicate,
      blocking: {
        id: 'attempt-abandoned',
        status: 'claimed',
        idempotency_key: 'attempt-key-abandoned',
        amount: '42.00',
        submitted_at: null,
        stripe_payment_intent_id: null,
        created_at: new Date(Date.now() - (6 * 60 * 1000)).toISOString(),
      },
    });

    await expect(claimInvoiceSavedCardCharge({
      invoiceId: 'inv-1',
      paymentMethodId: 'pm-2',
      stripePaymentMethodId: 'pm-stripe-2',
      attemptId: 'attempt-second',
      database,
    })).resolves.toMatchObject({
      id: 'attempt-second',
      status: 'claimed',
    });
  });
});

describe('saved-card attempt state updates', () => {
  test('atomically records worker provenance with a create-returned PaymentIntent', async () => {
    const updates = [];
    const query = {};
    query.where = jest.fn(() => query);
    query.whereIn = jest.fn(() => query);
    query.whereNull = jest.fn(() => query);
    query.update = jest.fn(async (payload) => {
      updates.push(payload);
      return 1;
    });
    const database = jest.fn(() => query);

    await markInvoiceSavedCardChargeAttempt(
      'attempt-worker',
      { status: 'ambiguous', stripe_payment_intent_id: 'pi-worker', resolved_at: null },
      database,
    );

    expect(updates).toEqual([expect.objectContaining({
      status: 'ambiguous',
      stripe_payment_intent_id: 'pi-worker',
      stripe_payment_intent_bound_at: expect.any(Date),
    })]);
  });

  test('adds only worker provenance when an exact failure webhook wins the ordering race', async () => {
    const queries = [];
    const updateResults = [0, 1];
    const database = jest.fn(() => {
      const query = {};
      ['where', 'whereIn', 'whereNull', 'whereNotNull'].forEach((method) => {
        query[method] = jest.fn(() => query);
      });
      query.update = jest.fn(async (payload) => {
        query.payload = payload;
        return updateResults.shift();
      });
      queries.push(query);
      return query;
    });

    await expect(markInvoiceSavedCardChargeAttempt(
      'attempt-webhook-first',
      { status: 'ambiguous', stripe_payment_intent_id: 'pi-failed-first', resolved_at: null },
      database,
    )).resolves.toBeUndefined();

    expect(queries).toHaveLength(2);
    expect(queries[1].where).toHaveBeenCalledWith({
      id: 'attempt-webhook-first', stripe_payment_intent_id: 'pi-failed-first',
    });
    expect(queries[1].whereNotNull).toHaveBeenCalledWith('resolved_at');
    expect(queries[1].payload).toEqual({
      worker_payment_intent_id: 'pi-failed-first',
      stripe_payment_intent_bound_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
  });

  test('guards bookkeeping writes so a final webhook cannot be reopened', async () => {
    const query = {};
    query.where = jest.fn(() => query);
    query.whereIn = jest.fn(() => query);
    query.whereNull = jest.fn(() => query);
    query.update = jest.fn(async () => 0);
    const database = jest.fn(() => query);

    await expect(markInvoiceSavedCardChargeAttempt(
      'attempt-resolved',
      { status: 'ambiguous', resolved_at: null },
      database,
    )).rejects.toMatchObject({ code: 'STRIPE_CHARGE_ATTEMPT_FENCE_LOST' });
    expect(query.whereIn).toHaveBeenCalledWith('status', ['claimed', 'ambiguous']);
    expect(query.whereNull).toHaveBeenCalledWith('resolved_at');
  });

  test('commits the submission marker in its own transaction before Stripe can be called', async () => {
    const updates = [];
    const submissionTrx = jest.fn(() => {
      const query = {};
      query.where = jest.fn(() => query);
      query.whereIn = jest.fn(() => query);
      query.whereNull = jest.fn(() => query);
      query.update = jest.fn(async (payload) => {
        updates.push(payload);
        return 1;
      });
      return query;
    });
    const database = { transaction: jest.fn(async (callback) => callback(submissionTrx)) };

    await commitInvoiceSavedCardChargeSubmission({
      attemptId: 'attempt-submit',
      amount: 42.5,
      creditAppliedDelta: 10,
      creditAppliedTotal: 10,
      canceledCheckoutPaymentIntentId: 'pi_checkout_old',
      database,
    });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      amount: 42.5,
      credit_applied_delta: 10,
      credit_applied_total: 10,
      canceled_checkout_payment_intent_id: 'pi_checkout_old',
      submitted_at: expect.any(Date),
    }));
  });
});

function settledAttemptDb({
  attempt = { id: 'attempt-1', status: 'ambiguous', resolved_at: null },
  invoice = { id: 'inv-1' },
  payment = { id: 'pay-1', amount: '42.50' },
} = {}) {
  const updates = [];
  const trx = jest.fn((table) => {
    const query = {};
    ['where', 'whereIn', 'whereNull', 'forUpdate'].forEach((method) => {
      query[method] = jest.fn(() => query);
    });
    query.first = jest.fn(async () => {
      if (table === 'stripe_invoice_charge_attempts') return attempt;
      if (table === 'invoices') return invoice;
      if (table === 'payments') return payment;
      return null;
    });
    query.update = jest.fn(async (payload) => {
      updates.push(payload);
      return 1;
    });
    return query;
  });
  return {
    database: { transaction: jest.fn(async (callback) => callback(trx)) },
    updates,
  };
}

describe('saved-card succeeded-webhook attempt repair', () => {
  const args = {
    attemptId: 'attempt-1',
    invoiceId: 'inv-1',
    customerId: 'cust-1',
    stripePaymentIntentId: 'pi-1',
    amount: 42.5,
  };

  test('resolves the attempt after its invoice and payment row are both settled', async () => {
    const { database, updates } = settledAttemptDb();

    await expect(resolveSettledInvoiceSavedCardChargeAttempt({ ...args, database }))
      .resolves.toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'succeeded',
      stripe_payment_intent_id: 'pi-1',
      amount: 42.5,
      error_message: null,
    }));
  });

  test('clears the orphan fence even when the request already closed the attempt', async () => {
    const { database, updates } = settledAttemptDb({
      attempt: { id: 'attempt-1', status: 'succeeded', resolved_at: new Date().toISOString() },
    });

    await expect(resolveSettledInvoiceSavedCardChargeAttempt({ ...args, database }))
      .resolves.toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({
      resolved: true,
      resolution_notes: expect.stringContaining('succeeded webhook'),
    }));
  });

  test.each([
    ['invoice is not settled', { invoice: null }],
    ['payment row is not settled', { payment: null }],
    ['attempt was already resolved', { attempt: null }],
  ])('does not close the fence when the %s', async (_label, state) => {
    const { database, updates } = settledAttemptDb(state);

    await expect(resolveSettledInvoiceSavedCardChargeAttempt({ ...args, database }))
      .resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });
});

function failedAttemptDb({ invoiceStatus = 'processing', invoicePaymentIntentId = null } = {}) {
  const state = {
    invoice: {
      id: 'inv-1',
      customer_id: 'cust-1',
      status: invoiceStatus,
      stripe_payment_intent_id: invoicePaymentIntentId,
      credit_applied: 25,
      due_date: '2099-01-01',
    },
    attempt: {
      id: 'attempt-1',
      worker_payment_intent_id: 'pi-failed',
      credit_applied_delta: 15,
      credit_applied_total: 25,
    },
    customer: { id: 'cust-1', account_credits: 10 },
    ledger: [],
    updates: [],
  };
  const trx = jest.fn((table) => {
    const query = {};
    ['where', 'whereIn', 'whereNull', 'forUpdate'].forEach((method) => {
      query[method] = jest.fn(() => query);
    });
    query.first = jest.fn(async () => {
      if (table === 'invoices') return state.invoice;
      if (table === 'stripe_invoice_charge_attempts') return state.attempt;
      if (table === 'customers') return state.customer;
      return null;
    });
    query.update = jest.fn(async (payload) => {
      state.updates.push({ table, payload });
      if (table === 'invoices') Object.assign(state.invoice, payload);
      if (table === 'customers') Object.assign(state.customer, payload);
      return 1;
    });
    query.insert = jest.fn((payload) => {
      if (table === 'customer_credit_ledger') state.ledger.push(payload);
      return query;
    });
    query.returning = jest.fn(async () => [state.ledger.at(-1)]);
    return query;
  });
  trx.fn = { now: jest.fn(() => 'NOW') };
  return {
    database: { transaction: jest.fn(async (callback) => callback(trx)) },
    state,
  };
}

describe('saved-card failed-webhook attempt repair', () => {
  test('reopens the invoice, resolves the fence, and returns reserved credit', async () => {
    const { database, state } = failedAttemptDb();

    await expect(resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId: 'attempt-1',
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      stripePaymentIntentId: 'pi-failed',
      failureMessage: 'card declined',
      database,
    })).resolves.toBe(true);

    expect(state.invoice).toEqual(expect.objectContaining({
      status: 'sent',
      stripe_payment_intent_id: null,
      credit_applied: 10,
    }));
    expect(state.customer.account_credits).toBe(25);
    expect(state.ledger).toContainEqual(expect.objectContaining({
      customer_id: 'cust-1',
      delta: 15,
      invoice_id: 'inv-1',
    }));
    expect(state.updates).toContainEqual(expect.objectContaining({
      table: 'stripe_invoice_charge_attempts',
      payload: expect.objectContaining({
        status: 'failed',
        stripe_payment_intent_id: 'pi-failed',
      }),
    }));
    const attemptUpdate = state.updates.find((entry) => entry.table === 'stripe_invoice_charge_attempts');
    expect(attemptUpdate.payload).not.toHaveProperty('stripe_payment_intent_bound_at');
    expect(state.updates).toContainEqual(expect.objectContaining({
      table: 'stripe_orphan_charges',
      payload: expect.objectContaining({
        resolved: true,
        resolution_notes: expect.stringContaining('final payment failure'),
      }),
    }));
  });

  test('withholds invoice and credit writes until the original worker binds a webhook-first failure', async () => {
    const { database, state } = failedAttemptDb();
    state.attempt.worker_payment_intent_id = null;
    state.attempt.status = 'ambiguous'; // a concurrent checkout promoted the claim while the worker is still waiting
    await expect(resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId: 'attempt-1', invoiceId: 'inv-1', customerId: 'cust-1', stripePaymentIntentId: 'pi-failed', database,
    })).rejects.toMatchObject({ code: 'SAVED_CARD_WORKER_INTENT_PENDING' });
    expect(state.ledger).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  test('a completed create timeout stays held without independent request proof, even if processing stamped the invoice', async () => {
    const { database, state } = failedAttemptDb();
    Object.assign(state.attempt, { status: 'ambiguous', worker_payment_intent_id: null, worker_create_timed_out_at: new Date(), submitted_at: new Date(), idempotency_key: 'original-create' });
    state.invoice.stripe_payment_intent_id = 'pi-failed';
    const failure = { attemptId: 'attempt-1', invoiceId: 'inv-1', customerId: 'cust-1', stripePaymentIntentId: 'pi-failed', database };
    await expect(resolveFailedInvoiceSavedCardChargeAttempt({ ...failure, requestIdempotencyKey: 'other-create' })).resolves.toBe(false);
    expect(state.updates).toEqual([]);
    await expect(resolveFailedInvoiceSavedCardChargeAttempt({ ...failure, requestIdempotencyKey: 'original-create' })).resolves.toBe(true);
    expect(state.customer.account_credits).toBe(25);
  });

  test('an exact failure leaves a different customer checkout attached to a collectible invoice', async () => {
    const { database, state } = failedAttemptDb({ invoiceStatus: 'sent' });
    state.invoice.stripe_payment_intent_id = 'pi_customer_checkout';
    await expect(resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId: 'attempt-1', invoiceId: 'inv-1', customerId: 'cust-1', stripePaymentIntentId: 'pi-failed', database,
    })).resolves.toBe(true);
    expect(state.invoice.stripe_payment_intent_id).toBe('pi_customer_checkout');
  });

  test('does not release a fence beside a terminal invoice', async () => {
    const { database, state } = failedAttemptDb({ invoiceStatus: 'paid' });

    await expect(resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId: 'attempt-1',
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      stripePaymentIntentId: 'pi-failed',
      database,
    })).resolves.toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  test('preserves a different pay-page PI on a still-collectible invoice', async () => {
    const { database, state } = failedAttemptDb({
      invoiceStatus: 'sent', invoicePaymentIntentId: 'pi_pay_page',
    });
    state.attempt.worker_payment_intent_id = 'pi_failed_saved_card';

    await expect(resolveFailedInvoiceSavedCardChargeAttempt({
      attemptId: 'attempt-1',
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      stripePaymentIntentId: 'pi_failed_saved_card',
      database,
    })).resolves.toBe(true);

    expect(state.invoice.stripe_payment_intent_id).toBe('pi_pay_page');
    expect(state.updates.find(({ table }) => table === 'invoices').payload)
      .not.toHaveProperty('stripe_payment_intent_id');
  });
});

function preChargeFailureDb({ attemptStatus = 'ambiguous', paymentIntentId = null } = {}) {
  const state = {
    invoice: {
      id: 'inv-1',
      status: 'processing',
      stripe_payment_intent_id: paymentIntentId,
      due_date: '2099-01-01',
    },
    attempt: { id: 'attempt-1', status: attemptStatus },
    updates: [],
  };
  const trx = jest.fn((table) => {
    const query = {};
    ['where', 'whereIn', 'whereNull', 'forUpdate'].forEach((method) => {
      query[method] = jest.fn(() => query);
    });
    query.first = jest.fn(async () => (
      table === 'invoices' ? state.invoice : state.attempt
    ));
    query.update = jest.fn(async (payload) => {
      state.updates.push({ table, payload });
      if (table === 'invoices') Object.assign(state.invoice, payload);
      if (table === 'stripe_invoice_charge_attempts') Object.assign(state.attempt, payload);
      return 1;
    });
    return query;
  });
  return {
    database: { transaction: jest.fn(async (callback) => callback(trx)) },
    state,
  };
}

describe('saved-card pre-charge failure release', () => {
  test('records charge-worker provenance with an authentication-required PI', async () => {
    const { database, state } = preChargeFailureDb({ attemptStatus: 'claimed' });
    await expect(resolveNoFundsSavedCardChargeAttempt({
      attemptId: 'attempt-1',
      invoiceId: 'inv-1',
      failureMessage: 'authentication required',
      declineCode: 'authentication_required',
      authenticationIntentId: 'pi_authentication',
      database,
    })).resolves.toEqual({ resolved: true, reopened: false });
    expect(state.attempt).toEqual(expect.objectContaining({
      stripe_payment_intent_id: 'pi_authentication',
      stripe_payment_intent_bound_at: expect.any(Date),
    }));
  });

  test('reopens a parked invoice when the stale ambiguous owner proves no charge was submitted', async () => {
    const { database, state } = preChargeFailureDb();
    await expect(resolveNoFundsSavedCardChargeAttempt({
      attemptId: 'attempt-1',
      invoiceId: 'inv-1',
      failureMessage: 'lookup failed before create',
      database,
    })).resolves.toEqual({ resolved: true, reopened: true });
    expect(state.invoice.status).toBe('sent');
    expect(state.attempt).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  test.each([
    ['a fresh claimed attempt', { attemptStatus: 'claimed' }],
    ['another active PI', { paymentIntentId: 'pi-other' }],
  ])('resolves but does not reopen beside %s', async (_label, options) => {
    const { database, state } = preChargeFailureDb(options);
    await expect(resolveNoFundsSavedCardChargeAttempt({
      attemptId: 'attempt-1',
      invoiceId: 'inv-1',
      failureMessage: 'pre-charge failure',
      database,
    })).resolves.toEqual({ resolved: true, reopened: false });
    expect(state.invoice.status).toBe('processing');
    expect(state.attempt.status).toBe('failed');
  });
});

describe('saved-card orphan attempt lifecycle', () => {
  test('keeps processing ACH unresolved until Stripe reports a final outcome', () => {
    expect(savedCardAttemptOutcome({
      durableSettlementReady: true,
      paymentIntentStatus: 'processing',
    })).toEqual({ status: 'ambiguous', resolved: false });
  });

  test('only closes a durable orphan attempt on final succeeded status', () => {
    expect(savedCardAttemptOutcome({
      durableSettlementReady: true,
      paymentIntentStatus: 'succeeded',
    })).toEqual({ status: 'succeeded', resolved: true });
    expect(savedCardAttemptOutcome({
      durableSettlementReady: false,
      paymentIntentStatus: 'succeeded',
    })).toEqual({ status: 'claimed', resolved: false });
  });
});

function parkingDb({
  invoiceStatus = 'sent',
  stripePaymentIntentId = null,
  unresolvedAttempt = true,
} = {}) {
  const updates = [];
  const trx = jest.fn((table) => {
    const query = {};
    ['where', 'whereIn', 'whereNull', 'forUpdate'].forEach((method) => {
      query[method] = jest.fn(() => query);
    });
    query.first = jest.fn(async () => {
      if (table === 'invoices') {
        return { id: 'inv-1', status: invoiceStatus, stripe_payment_intent_id: stripePaymentIntentId };
      }
      if (table === 'stripe_invoice_charge_attempts') {
        return unresolvedAttempt ? { id: 'attempt-1' } : null;
      }
      return null;
    });
    query.update = jest.fn(async (payload) => {
      updates.push(payload);
      return 1;
    });
    return query;
  });
  const database = { transaction: jest.fn(async (callback) => callback(trx)) };
  return { database, updates };
}

describe('saved-card invoice parking', () => {
  test('parks an open invoice when a Stripe outcome is ambiguous', async () => {
    const { database, updates } = parkingDb();

    await expect(parkInvoiceForSavedCardReconciliation({
      invoiceId: 'inv-1',
      error: { code: 'STRIPE_AMBIGUOUS_OUTCOME' },
      database,
    })).resolves.toMatchObject({ reconciliationRequired: true, invoice: { status: 'processing' } });
    expect(updates).toContainEqual(expect.objectContaining({ status: 'processing' }));
  });

  test('clears an abandoned PI binding when parking a no-PI ambiguity', async () => {
    const { database, updates } = parkingDb({ stripePaymentIntentId: 'pi-abandoned' });

    await parkInvoiceForSavedCardReconciliation({
      invoiceId: 'inv-1',
      error: { code: 'STRIPE_AMBIGUOUS_OUTCOME' },
      database,
    });
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'processing',
      stripe_payment_intent_id: null,
    }));
  });

  test('does not re-park after a definitive webhook already resolved the attempt', async () => {
    const { database, updates } = parkingDb({ unresolvedAttempt: false });

    await expect(parkInvoiceForSavedCardReconciliation({
      invoiceId: 'inv-1',
      error: { code: 'STRIPE_AMBIGUOUS_OUTCOME', chargeAttemptId: 'attempt-1' },
      chargeAttemptId: 'attempt-1',
      database,
    })).resolves.toMatchObject({
      reconciliationRequired: false,
      attemptResolved: true,
      invoice: { status: 'sent' },
    });
    expect(updates).not.toContainEqual(expect.objectContaining({ status: 'processing' }));
  });

});

function creditPersistenceDb({ creditApplied = 10, accountCredits = 25, unresolvedAttempt = true, invoiceCustomerId = 'cust-1' } = {}) {
  const state = { creditApplied, accountCredits, ledger: [] };
  const trx = jest.fn((table) => {
    const query = {};
    ['where', 'whereIn', 'whereNull', 'forUpdate'].forEach((method) => {
      query[method] = jest.fn(() => query);
    });
    query.first = jest.fn(async () => {
      if (table === 'invoices') return { id: 'inv-1', customer_id: invoiceCustomerId, credit_applied: state.creditApplied };
      if (table === 'customers') return { id: 'cust-1', account_credits: state.accountCredits };
      if (table === 'stripe_invoice_charge_attempts') return unresolvedAttempt ? { id: 'attempt-1' } : null;
      return null;
    });
    query.update = jest.fn(async (payload) => {
      if (table === 'invoices') state.creditApplied = Number(payload.credit_applied);
      if (table === 'customers') state.accountCredits = Number(payload.account_credits);
      return 1;
    });
    query.insert = jest.fn((payload) => {
      if (table === 'customer_credit_ledger') state.ledger.push(payload);
      return query;
    });
    query.returning = jest.fn(async () => [state.ledger.at(-1)]);
    return query;
  });
  trx.fn = { now: jest.fn(() => 'now') };
  const database = { transaction: jest.fn(async (callback) => callback(trx)) };
  return { database, state };
}

describe('saved-card ambiguity credit persistence', () => {
  test('does not spend the former customer’s credit after invoice ownership changes', async () => {
    const { database, state } = creditPersistenceDb({ invoiceCustomerId: 'cust-2' });

    await expect(persistSavedCardChargeCreditDelta({
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      originalCreditApplied: 10,
      creditDelta: 15,
      reference: 'attempt attempt-1',
      database,
    })).resolves.toBe(false);

    expect(state.creditApplied).toBe(10);
    expect(state.accountCredits).toBe(25);
    expect(state.ledger).toHaveLength(0);
  });

  test('commits the charged credit delta exactly once before reconciliation', async () => {
    const { database, state } = creditPersistenceDb();
    const args = {
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      originalCreditApplied: 10,
      creditDelta: 15,
      reference: 'attempt attempt-1',
      database,
    };

    await persistSavedCardChargeCreditDelta(args);
    await persistSavedCardChargeCreditDelta(args);

    expect(state.creditApplied).toBe(25);
    expect(state.accountCredits).toBe(10);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toEqual(expect.objectContaining({
      customer_id: 'cust-1',
      delta: -15,
      invoice_id: 'inv-1',
      source: 'adjustment',
    }));
  });

  test('does not reserve credit after a failed webhook resolved the attempt', async () => {
    const { database, state } = creditPersistenceDb({ unresolvedAttempt: false });

    await expect(persistSavedCardChargeCreditDelta({
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      attemptId: 'attempt-1',
      originalCreditApplied: 10,
      creditDelta: 15,
      targetCreditApplied: 25,
      reference: 'attempt attempt-1',
      database,
    })).resolves.toBe(false);

    expect(state.creditApplied).toBe(10);
    expect(state.accountCredits).toBe(25);
    expect(state.ledger).toHaveLength(0);
  });
});
