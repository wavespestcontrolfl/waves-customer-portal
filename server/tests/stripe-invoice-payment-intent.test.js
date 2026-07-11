describe('StripeService.createInvoicePaymentIntent', () => {
  let invoiceRow;
  let updateInvoice;
  let stripeClient;
  let dbMock;
  let trxMock;
  // Configurable per test: the customer's account-credit balance and what
  // applyAccountCreditToInvoice does to the invoice row when the gated auto-apply
  // path runs. Default to no credit so existing cases keep the original lifecycle.
  let customerAccountCredits;
  let applyCreditSideEffect;

  beforeEach(() => {
    jest.resetModules();
    customerAccountCredits = '0.00';
    applyCreditSideEffect = null;

    invoiceRow = {
      id: 'inv_123',
      invoice_number: 'WPC-2026-0060',
      status: 'viewed',
      total: '75.00',
      title: null,
      customer_id: 'cust_123',
      stripe_payment_intent_id: 'pi_canceled',
    };
    updateInvoice = jest.fn().mockResolvedValue(1);
    stripeClient = {
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          id: 'pi_canceled',
          status: 'canceled',
          metadata: { waves_invoice_id: invoiceRow.id },
        }),
        cancel: jest.fn(),
        create: jest.fn()
          .mockResolvedValueOnce({
            id: 'pi_canceled',
            status: 'canceled',
            client_secret: 'pi_canceled_secret',
          })
          .mockResolvedValueOnce({
            id: 'pi_fresh',
            status: 'requires_payment_method',
            client_secret: 'pi_fresh_secret',
          }),
        update: jest.fn().mockImplementation(async (id, params) => ({
          id,
          status: 'requires_payment_method',
          client_secret: `${id}_secret`,
          ...params,
        })),
      },
    };

    const rootInvoiceQuery = {
      where: jest.fn(() => rootInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
    };
    const lockedInvoiceQuery = {
      where: jest.fn(() => lockedInvoiceQuery),
      forUpdate: jest.fn(() => lockedInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
      whereNotIn: jest.fn(() => lockedInvoiceQuery),
      update: updateInvoice,
    };
    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      first: jest.fn().mockResolvedValue(null),
    };
    // Auto-apply resolves the customer's account-credit balance up front; these
    // cases have no credit, so the original PI lifecycle must run untouched.
    const customersQuery = {
      where: jest.fn(() => customersQuery),
      first: jest.fn(async () => ({ account_credits: customerAccountCredits })),
    };

    trxMock = jest.fn(table => {
      if (table === 'invoices') return lockedInvoiceQuery;
      if (table === 'payments') return paymentsQuery;
      if (table === 'customers') return customersQuery;
      throw new Error(`Unexpected trx table: ${table}`);
    });
    dbMock = jest.fn(table => {
      if (table === 'invoices') return rootInvoiceQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async callback => callback(trxMock));

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_mock',
      publishableKey: 'pk_test_mock',
    }));
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/customer-credit', () => ({
      applyAccountCreditToInvoice: jest.fn(async () => {
        if (applyCreditSideEffect) applyCreditSideEffect();
      }),
    }));
  });

  test('does not return a canceled idempotency replay when replacing an invoice PaymentIntent', async () => {
    const StripeService = require('../services/stripe');
    const result = await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    expect(result.paymentIntentId).toBe('pi_fresh');
    expect(result.clientSecret).toBe('pi_fresh_secret');
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledTimes(2);
    expect(stripeClient.paymentIntents.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      amount: 7500,
      payment_method_types: ['card'],
      metadata: expect.objectContaining({
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
    expect(stripeClient.paymentIntents.create.mock.calls[0][1].idempotencyKey).toContain('pi_canceled');
    expect(stripeClient.paymentIntents.create.mock.calls[1][1].idempotencyKey).toContain('_replacement_');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_fresh',
    });
  });

  test('reuses an already-bound open PaymentIntent instead of failing setup', async () => {
    invoiceRow.stripe_payment_intent_id = 'pi_open';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_open',
      status: 'requires_payment_method',
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    const result = await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    expect(result.paymentIntentId).toBe('pi_open');
    expect(result.clientSecret).toBe('pi_open_secret');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_open', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['card'],
      setup_future_usage: '',
      metadata: expect.objectContaining({
        waves_invoice_id: invoiceRow.id,
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
    expect(stripeClient.paymentIntents.update.mock.calls[0][1]).not.toHaveProperty('currency');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_open',
    });
  });

  test('reusing an open PaymentIntent clears stale surcharge-finalization metadata', async () => {
    // A declined /finalize leaves surcharge_policy_version on the PI; Stripe
    // metadata updates MERGE, so without an explicit '' clear the reused PI
    // keeps the stale key and the webhook quarantine reads it as "finalized" —
    // settling a base-only card confirm without the surcharge (audit P1).
    invoiceRow.stripe_payment_intent_id = 'pi_open';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_open',
      status: 'requires_payment_method',
      metadata: {
        waves_invoice_id: invoiceRow.id,
        surcharge_policy_version: 'v3',
        surcharge_rate_bps: '290',
        card_funding: 'credit',
      },
    });

    const StripeService = require('../services/stripe');
    await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_open', expect.objectContaining({
      metadata: expect.objectContaining({
        surcharge_policy_version: '',
        surcharge_rate_bps: '',
        card_funding: '',
      }),
    }));
  });

  test('setup returns a client-safe conflict when a bound PaymentIntent is already in progress', async () => {
    invoiceRow.stripe_payment_intent_id = 'pi_processing';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_processing',
      status: 'processing',
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({
        message: 'Invoice payment is already in progress',
        statusCode: 409,
        // Money genuinely in flight (ACH processing) → the pay page routes the
        // customer to the receipt's "bank payment processing" state.
        inProgress: true,
      });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
  });

  test('recovers a card PI stuck in requires_action by canceling and minting a fresh one', async () => {
    // An abandoned 3DS handoff leaves a card PI in requires_action with the
    // invoice still unpaid — no money moved. Rather than hard-block the customer
    // (and re-raise an admin alert on every reload), cancel the dead intent and
    // mint a fresh one the customer can actually pay.
    invoiceRow.stripe_payment_intent_id = 'pi_requires_action';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_requires_action',
      status: 'requires_action',
      // No `verify_with_microdeposits` next_action → this is a card 3DS handoff,
      // not an ACH bank verification, so it is safe to cancel and re-mint.
      metadata: { waves_invoice_id: invoiceRow.id },
    });
    stripeClient.paymentIntents.cancel.mockResolvedValueOnce({ id: 'pi_requires_action', status: 'canceled' });
    stripeClient.paymentIntents.create = jest.fn().mockResolvedValue({
      id: 'pi_fresh',
      status: 'requires_payment_method',
      client_secret: 'pi_fresh_secret',
    });

    const StripeService = require('../services/stripe');
    const result = await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_requires_action');
    expect(result.paymentIntentId).toBe('pi_fresh');
    expect(result.clientSecret).toBe('pi_fresh_secret');
    // The replacement create's idempotency key is keyed off the old PI id so a
    // stale setup cannot replay an older intent for this invoice.
    expect(stripeClient.paymentIntents.create.mock.calls[0][1].idempotencyKey).toContain('pi_requires_action');
    expect(updateInvoice).toHaveBeenCalledWith({
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_fresh',
    });
  });

  test('never cancels an ACH micro-deposit verification stuck in requires_action (inProgress=true, no alert)', async () => {
    // The customer chose bank debit; Stripe sent two micro-deposits and is waiting
    // (1–2 business days) for them to confirm the amounts. The PI sits in
    // `requires_action` with a `verify_with_microdeposits` next_action. A returning
    // customer reloads this same pay page to verify — canceling here would destroy
    // the verification and force them to restart ACH. It is benign in-flight money,
    // so: never cancel, never mint a replacement, inProgress=true so no admin alert.
    // (Real-world WPC-2026-0164 / -0190 / -0191.)
    invoiceRow.stripe_payment_intent_id = 'pi_ach_microdeposit';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_ach_microdeposit',
      status: 'requires_action',
      next_action: { type: 'verify_with_microdeposits' },
      payment_method_types: ['us_bank_account'],
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({
        message: 'Invoice payment is already in progress',
        statusCode: 409,
        inProgress: true,
        microdepositPending: true,
      });
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(updateInvoice).not.toHaveBeenCalled();
  });

  test('does NOT cancel-and-replace a requires_capture invoice PI (authorized hold must not be voided)', async () => {
    // requires_capture = a card authorization is already held (money in flight per
    // invoice.js). It is excluded from SETUP_RECOVERABLE_PI_STATUSES, so a pay-page
    // reload must take the non-replaceable 409 path, never cancel the auth.
    invoiceRow.stripe_payment_intent_id = 'pi_requires_capture';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_requires_capture',
      status: 'requires_capture',
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({
        message: 'Invoice payment is already in progress',
        statusCode: 409,
        inProgress: false,
      });
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('applies account credit before replacing a stale card requires_action PI (no gross overcharge)', async () => {
    // Customer with account credit returns from an abandoned 3DS. The stale-PI
    // triage must clear the dead card intent so credit applies, and the
    // replacement must be priced at amount due ($75 − $50 = $25), not the gross.
    customerAccountCredits = '50.00';
    applyCreditSideEffect = () => { invoiceRow.credit_applied = '50.00'; };
    invoiceRow.stripe_payment_intent_id = 'pi_stale_card';
    stripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_stale_card',
      status: 'requires_action', // no verify_with_microdeposits → a card 3DS, cancelable
      metadata: { waves_invoice_id: invoiceRow.id },
    });
    stripeClient.paymentIntents.cancel.mockResolvedValue({ id: 'pi_stale_card', status: 'canceled' });
    stripeClient.paymentIntents.create = jest.fn().mockResolvedValue({
      id: 'pi_fresh_credit',
      status: 'requires_payment_method',
      client_secret: 'pi_fresh_credit_secret',
    });

    const StripeService = require('../services/stripe');
    const result = await StripeService.createInvoicePaymentIntent(invoiceRow.id);

    // Triage canceled + cleared the stale card PI so credit could apply.
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_stale_card');
    expect(updateInvoice).toHaveBeenCalledWith({ stripe_payment_intent_id: null });
    // Replacement is minted at AMOUNT DUE ($25 = 2500 cents), not the $75 gross.
    expect(stripeClient.paymentIntents.create.mock.calls[0][0].amount).toBe(2500);
    expect(result.paymentIntentId).toBe('pi_fresh_credit');
  });

  test('does NOT cancel an ACH micro-deposit PI in the credit triage even with credit available', async () => {
    // The triage must keep its micro-deposit carve-out: a verifying ACH intent is
    // in-flight bank money and stays attached (credit fail-closes), never canceled.
    customerAccountCredits = '50.00';
    invoiceRow.stripe_payment_intent_id = 'pi_ach_microdeposit';
    stripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_ach_microdeposit',
      status: 'requires_action',
      next_action: { type: 'verify_with_microdeposits' },
      payment_method_types: ['us_bank_account'],
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({ statusCode: 409, inProgress: true, microdepositPending: true });
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('credit triage validates PI ownership before canceling (refuses another invoice’s PI)', async () => {
    // Defense-in-depth: if an invoice row ever points at a PI whose metadata
    // belongs to a different invoice, the triage must NOT cancel it — it raises
    // the same ownership error the main setup path does.
    customerAccountCredits = '50.00';
    invoiceRow.stripe_payment_intent_id = 'pi_other_invoice';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_other_invoice',
      status: 'requires_action',
      metadata: { waves_invoice_id: 'a_different_invoice' },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toThrow('PaymentIntent does not belong to this invoice');
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('credit triage fails closed (409) when a stale card PI cannot be cleared — never re-mints at gross', async () => {
    // If the triage cancel fails transiently, credit can't apply; continuing would
    // re-mint the replacement at the gross total. Refuse with a retryable 409
    // instead of charging the customer the pre-credit amount.
    customerAccountCredits = '50.00';
    invoiceRow.stripe_payment_intent_id = 'pi_stale_card';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_stale_card',
      status: 'requires_action',
      metadata: { waves_invoice_id: invoiceRow.id },
    });
    stripeClient.paymentIntents.cancel.mockRejectedValueOnce(new Error('network blip'));
    stripeClient.paymentIntents.create = jest.fn();

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('fails closed when a stuck requires_action PI cannot be canceled before replacement', async () => {
    // If the cancel fails the old PI may have just raced into processing/succeeded;
    // minting a replacement while its client secret can still collect would
    // double-charge. Refuse with a 409 instead of repointing the invoice.
    invoiceRow.stripe_payment_intent_id = 'pi_requires_action';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_requires_action',
      status: 'requires_action',
      metadata: { waves_invoice_id: invoiceRow.id },
    });
    stripeClient.paymentIntents.cancel.mockRejectedValueOnce(new Error(
      'You cannot cancel this PaymentIntent because it has a status of processing.'
    ));

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({
        message: 'Could not replace the existing payment — please try again in a moment',
        statusCode: 409,
      });
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_requires_action');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(updateInvoice).not.toHaveBeenCalled();
  });

  test('setup conflict for a succeeded PI with no local row is an alert-worthy mismatch (inProgress=false)', async () => {
    // A stored PI reporting `succeeded` while no live local payment row exists
    // means money was captured but reconciliation never ran (a lost/failed
    // webhook). It must NOT show the benign "bank payment processing" copy —
    // inProgress stays false so the route raises an admin reconciliation alert.
    invoiceRow.stripe_payment_intent_id = 'pi_succeeded';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_succeeded',
      status: 'succeeded',
      metadata: { waves_invoice_id: invoiceRow.id },
    });

    const StripeService = require('../services/stripe');
    await expect(StripeService.createInvoicePaymentIntent(invoiceRow.id))
      .rejects.toMatchObject({
        message: 'Invoice payment is already in progress',
        statusCode: 409,
        inProgress: false,
      });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
  });
});

describe('StripeService.updateInvoicePaymentIntentMethod', () => {
  let invoiceRow;
  let stripeClient;
  let dbMock;

  beforeEach(() => {
    jest.resetModules();

    invoiceRow = {
      id: 'inv_123',
      invoice_number: 'WPC-2026-0060',
      status: 'viewed',
      total: '75.00',
      customer_id: 'cust_123',
      stripe_payment_intent_id: 'pi_invoice',
    };
    stripeClient = {
      paymentIntents: {
        update: jest.fn().mockImplementation(async (id, params) => ({
          id,
          ...params,
        })),
        retrieve: jest.fn().mockResolvedValue({ id: 'pi_invoice', status: 'requires_payment_method' }),
        create: jest.fn().mockImplementation(async (params) => ({
          id: 'pi_replacement',
          client_secret: 'cs_replacement',
          ...params,
        })),
        cancel: jest.fn().mockResolvedValue({ id: 'pi_invoice', status: 'canceled' }),
      },
    };

    const rootInvoiceQuery = {
      where: jest.fn(() => rootInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
    };
    // Transaction-scoped invoice query: supports the forUpdate read and the
    // guarded repoint update used by replaceInvoicePaymentIntentForTender.
    const trxInvoiceQuery = {
      where: jest.fn(() => trxInvoiceQuery),
      forUpdate: jest.fn(() => trxInvoiceQuery),
      whereNotIn: jest.fn(() => trxInvoiceQuery),
      first: jest.fn().mockResolvedValue(invoiceRow),
      update: jest.fn().mockResolvedValue(1),
    };
    dbMock = jest.fn(table => {
      if (table === 'invoices') return rootInvoiceQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async (cb) => {
      const trx = jest.fn(table => {
        if (table === 'invoices') return trxInvoiceQuery;
        throw new Error(`Unexpected trx table: ${table}`);
      });
      return cb(trx);
    });

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_mock',
      publishableKey: 'pk_test_mock',
    }));
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../models/db', () => dbMock);
  });

  test('card-family updates keep the PaymentIntent at base amount (surcharge deferred to /finalize)', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_invoice', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['card'],
      metadata: expect.objectContaining({
        selected_method_category: 'card',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
  });

  test('ACH updates lock the PaymentIntent to bank account at the base total', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'us_bank_account');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_invoice', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['us_bank_account'],
      metadata: expect.objectContaining({
        selected_method_category: 'us_bank_account',
        base_amount: '75',
        card_surcharge: '0',
      }),
    }));
  });

  test('updates reject when the invoice has no PaymentIntent at all', async () => {
    invoiceRow.stripe_payment_intent_id = null;
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/does not belong/);
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
  });

  test('a stale id that IS the replaced lineage with a matching tender replays onto the CURRENT PI (lost-response retry recovery)', async () => {
    // A prior /update-amount can take the replacement path (fresh PI minted,
    // invoice repointed) with the response lost in transit — the client's
    // network retry then still carries the dead PI's id. The caller-supplied
    // stale PI must never be updated; the tender lock applies to the invoice's
    // current PI, returned with replaced+clientSecret so Elements re-mounts.
    invoiceRow.stripe_payment_intent_id = 'pi_current';
    stripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_current',
      status: 'requires_payment_method',
      payment_method_types: ['card'],
      metadata: { replaced_from: 'pi_dead_replaced' },
    });
    stripeClient.paymentIntents.update.mockImplementation(async (id, params) => ({
      id,
      client_secret: `cs_${id}`,
      ...params,
    }));
    const StripeService = require('../services/stripe');

    const result = await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_dead_replaced', 'card');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_current', expect.objectContaining({
      amount: 7500,
      payment_method_types: ['card'],
    }));
    expect(result).toMatchObject({
      paymentIntentId: 'pi_current',
      base: 75,
      surcharge: 0,
      total: 75,
      replaced: true,
      clientSecret: 'cs_pi_current',
    });
  });

  test('a stale lineage id with a DIFFERENT tender is rejected — a late out-of-order sync must never flip the current lock', async () => {
    // Codex P1 on the blanket retarget: an older overlapped /update-amount
    // (e.g. an abandoned ACH toggle from a dead Elements mount) still carrying
    // the canceled id must NOT rewrite payment_method_types under a pending
    // card confirm/finalize.
    invoiceRow.stripe_payment_intent_id = 'pi_current';
    stripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_current',
      status: 'requires_payment_method',
      payment_method_types: ['card'],
      metadata: { replaced_from: 'pi_dead_replaced' },
    });
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_dead_replaced', 'us_bank_account'),
    ).rejects.toThrow(/does not belong/);
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
  });

  test('a stale id with no replacement lineage is rejected (fail-closed, includes retrieve failure)', async () => {
    invoiceRow.stripe_payment_intent_id = 'pi_current';
    stripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_current',
      status: 'requires_payment_method',
      payment_method_types: ['card'],
      metadata: {},
    });
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_never_ours', 'card'),
    ).rejects.toThrow(/does not belong/);

    // Retrieve failure = lineage unverifiable = reject, never retarget blind.
    stripeClient.paymentIntents.retrieve.mockRejectedValueOnce(new Error('network blip'));
    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_never_ours', 'card'),
    ).rejects.toThrow(/does not belong/);
    expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
  });

  test('a matching PI id does NOT report replaced (no spurious Elements re-mount)', async () => {
    const StripeService = require('../services/stripe');

    const result = await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    expect(result.replaced).toBeUndefined();
    expect(result.clientSecret).toBeUndefined();
  });

  test('tender updates clear stale surcharge-finalization metadata (merge-delete via empty strings)', async () => {
    // Same failure mode createStatementPaymentIntent fixed: a declined
    // /finalize leaves surcharge_policy_version on the PI and a later reuse
    // must delete it (empty string) or the webhook quarantine is disabled.
    const StripeService = require('../services/stripe');
    await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    expect(stripeClient.paymentIntents.update).toHaveBeenCalledWith('pi_invoice', expect.objectContaining({
      metadata: expect.objectContaining({
        surcharge_policy_version: '',
        surcharge_rate_bps: '',
        card_funding: '',
      }),
    }));
  });

  test('tender switch blocked by an attached PM recreates the PaymentIntent for the new tender', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent. Please replace the PaymentMethod first or include us_bank_account in the allowed types.',
    ));
    const StripeService = require('../services/stripe');

    const result = await StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card');

    // Fresh PI minted for the selected tender, lock preserved.
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 7500,
        payment_method_types: ['card'],
        metadata: expect.objectContaining({
          selected_method_category: 'card',
          card_surcharge: '0',
          // Lineage stamp — update-amount uses it to recognize a lost-response
          // replay of this replacement (retry still carrying the canceled id).
          replaced_from: 'pi_invoice',
        }),
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('invoice_pi_replace_') }),
    );
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_invoice');
    expect(stripeClient.paymentIntents.cancel.mock.invocationCallOrder[0])
      .toBeLessThan(stripeClient.paymentIntents.create.mock.invocationCallOrder[0]);
    expect(result).toEqual(expect.objectContaining({
      replaced: true,
      paymentIntentId: 'pi_replacement',
      clientSecret: 'cs_replacement',
      total: 75,
      surcharge: 0,
    }));
  });

  test('tender switch will not cancel a PaymentIntent that is already processing', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent.',
    ));
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_invoice', status: 'processing' });
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/already in progress/);
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test('tender switch fails closed when the stale PI cannot be canceled before replacement', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent.',
    ));
    stripeClient.paymentIntents.cancel.mockRejectedValueOnce(new Error(
      'You cannot cancel this PaymentIntent because it has a status of processing.',
    ));
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/already in progress/);
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_invoice');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('tender switch fails closed when the stale PI status cannot be read', async () => {
    stripeClient.paymentIntents.update.mockRejectedValueOnce(new Error(
      'The allowed types provided (card) are incompatible with the attached PaymentMethod on the PaymentIntent.',
    ));
    stripeClient.paymentIntents.retrieve.mockRejectedValueOnce(new Error('Stripe API unavailable'));
    const StripeService = require('../services/stripe');

    await expect(
      StripeService.updateInvoicePaymentIntentMethod(invoiceRow.id, 'pi_invoice', 'card'),
    ).rejects.toThrow(/could not verify the existing payment status/i);
    // Never repoint the invoice or cancel the old PI when status is unknown.
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
  });
});
