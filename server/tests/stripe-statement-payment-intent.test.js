// Mirrors stripe-invoice-payment-intent.test.js for the monthly-statement pay
// flow. The PI-recovery branch in createStatementPaymentIntent is a mechanical
// twin of the single-invoice path, including the ACH micro-deposit carve-out:
// a `requires_action` PaymentIntent that is verifying bank micro-deposits is
// benign in-flight money and must never be canceled, while a stale card 3DS
// intent in the same status is recovered by cancel-and-re-mint.
describe('StripeService.createStatementPaymentIntent', () => {
  let statementRow;
  let updateStatement;
  let stripeClient;
  let dbMock;
  let trxMock;

  beforeEach(() => {
    jest.resetModules();

    statementRow = {
      id: 'stmt_123',
      payer_id: 'payer_123',
      status: 'viewed',
      total: '250.00',
      stripe_payment_intent_id: 'pi_existing',
    };
    updateStatement = jest.fn().mockResolvedValue(1);
    stripeClient = {
      paymentIntents: {
        retrieve: jest.fn(),
        cancel: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const rootStatementQuery = {
      where: jest.fn(() => rootStatementQuery),
      first: jest.fn().mockResolvedValue(statementRow),
    };
    const lockedStatementQuery = {
      where: jest.fn(() => lockedStatementQuery),
      forUpdate: jest.fn(() => lockedStatementQuery),
      first: jest.fn().mockResolvedValue(statementRow),
      whereIn: jest.fn(() => lockedStatementQuery),
      update: updateStatement,
    };

    trxMock = jest.fn(table => {
      if (table === 'payer_statements') return lockedStatementQuery;
      throw new Error(`Unexpected trx table: ${table}`);
    });
    trxMock.fn = { now: () => 'NOW' };

    dbMock = jest.fn(table => {
      if (table === 'payer_statements') return rootStatementQuery;
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
    jest.doMock('../services/payer-statement-settle', () => ({
      PAYABLE_STATEMENT_STATUSES: new Set(['finalized', 'sent', 'viewed']),
      isPayableStatementStatus: status => ['finalized', 'sent', 'viewed'].includes(status),
    }));
  });

  test('never cancels an ACH micro-deposit verification stuck in requires_action (inProgress=true, no alert)', async () => {
    // The payer chose bank debit on the statement; Stripe sent two micro-deposits
    // and is waiting (1–2 business days) for them to confirm the amounts. The PI
    // sits in `requires_action` with a `verify_with_microdeposits` next_action.
    // A returning payer reloads this same statement pay page to verify — canceling
    // would destroy the verification and force them to restart ACH. Benign
    // in-flight money: never cancel, never mint a replacement, inProgress=true.
    statementRow.stripe_payment_intent_id = 'pi_ach_microdeposit';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_ach_microdeposit',
      status: 'requires_action',
      next_action: { type: 'verify_with_microdeposits' },
      payment_method_types: ['us_bank_account'],
      metadata: { waves_statement_id: statementRow.id },
    });

    const StripeService = require('../services/stripe');
    jest.spyOn(StripeService, 'ensureStripePayerCustomer').mockResolvedValue('cus_test');

    await expect(StripeService.createStatementPaymentIntent(statementRow.id))
      .rejects.toMatchObject({
        message: 'A payment is already in progress for this statement',
        statusCode: 409,
        inProgress: true,
        microdepositPending: true,
      });
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(updateStatement).not.toHaveBeenCalled();
  });

  test('does NOT cancel-and-replace a requires_capture statement PI (authorized hold must not be voided)', async () => {
    // requires_capture is excluded from SETUP_RECOVERABLE_PI_STATUSES — an
    // authorized hold takes the non-replaceable 409 path, never a cancel.
    statementRow.stripe_payment_intent_id = 'pi_requires_capture';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_requires_capture',
      status: 'requires_capture',
      metadata: { waves_statement_id: statementRow.id },
    });

    const StripeService = require('../services/stripe');
    jest.spyOn(StripeService, 'ensureStripePayerCustomer').mockResolvedValue('cus_test');

    await expect(StripeService.createStatementPaymentIntent(statementRow.id))
      .rejects.toMatchObject({
        message: 'A payment is already in progress for this statement',
        statusCode: 409,
      });
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('recovers a card PI stuck in requires_action by canceling and minting a fresh one', async () => {
    // A card 3DS handoff abandoned mid-statement leaves a never-captured PI in
    // requires_action with NO verify_with_microdeposits next_action. Cancel it and
    // mint a fresh one the payer can actually pay, keyed off the old PI id.
    statementRow.stripe_payment_intent_id = 'pi_card_3ds';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_card_3ds',
      status: 'requires_action',
      metadata: { waves_statement_id: statementRow.id },
    });
    stripeClient.paymentIntents.cancel.mockResolvedValueOnce({ id: 'pi_card_3ds', status: 'canceled' });
    stripeClient.paymentIntents.create.mockResolvedValueOnce({
      id: 'pi_fresh',
      status: 'requires_payment_method',
      client_secret: 'pi_fresh_secret',
    });

    const StripeService = require('../services/stripe');
    jest.spyOn(StripeService, 'ensureStripePayerCustomer').mockResolvedValue('cus_test');

    const result = await StripeService.createStatementPaymentIntent(statementRow.id);

    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_card_3ds');
    expect(result.paymentIntentId).toBe('pi_fresh');
    expect(result.clientSecret).toBe('pi_fresh_secret');
    expect(stripeClient.paymentIntents.create.mock.calls[0][1].idempotencyKey).toContain('pi_card_3ds');
    expect(updateStatement).toHaveBeenCalledWith(expect.objectContaining({
      stripe_payment_intent_id: 'pi_fresh',
    }));
  });

  test('fails closed when a stuck requires_action card PI cannot be canceled before replacement', async () => {
    // If the cancel fails the old PI may have raced into processing/succeeded;
    // minting a replacement while its client secret can still collect would
    // double-charge. Refuse with a 409 instead of repointing the statement.
    statementRow.stripe_payment_intent_id = 'pi_card_3ds';
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_card_3ds',
      status: 'requires_action',
      metadata: { waves_statement_id: statementRow.id },
    });
    stripeClient.paymentIntents.cancel.mockRejectedValueOnce(new Error(
      'You cannot cancel this PaymentIntent because it has a status of processing.'
    ));

    const StripeService = require('../services/stripe');
    jest.spyOn(StripeService, 'ensureStripePayerCustomer').mockResolvedValue('cus_test');

    await expect(StripeService.createStatementPaymentIntent(statementRow.id))
      .rejects.toMatchObject({
        message: 'Could not replace the existing payment — please try again in a moment',
        statusCode: 409,
      });
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith('pi_card_3ds');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(updateStatement).not.toHaveBeenCalled();
  });
});
