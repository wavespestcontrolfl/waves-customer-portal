describe('bill-payment-error-alerts', () => {
  let returningRows;
  let triggerNotification;
  let dbMock;
  let customerRow;

  beforeEach(() => {
    jest.resetModules();
    returningRows = [{ id: 'alert-1', occurrence_count: 1 }];
    triggerNotification = jest.fn().mockResolvedValue({ bellWritten: true });
    customerRow = {
      id: 'cust_123',
      first_name: 'Virginia',
      last_name: 'Demo',
      phone: '+19415551234',
    };

    dbMock = jest.fn((table) => {
      if (table === 'customers') {
        const customerQuery = {
          where: jest.fn(() => customerQuery),
          first: jest.fn().mockResolvedValue(customerRow),
        };
        return customerQuery;
      }
      if (table === 'bill_payment_error_alerts') {
        return {
          insert: jest.fn(() => ({
            onConflict: jest.fn(() => ({
              merge: jest.fn(() => ({
                returning: jest.fn().mockResolvedValue(returningRows),
              })),
            })),
          })),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    dbMock.raw = jest.fn((sql) => ({ raw: sql }));
    dbMock.fn = { now: jest.fn(() => 'now()') };

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/notification-triggers', () => ({ triggerNotification }));
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
  });

  test('creates one high-signal admin notification for a first bill payment error', async () => {
    const { alertBillPaymentError } = require('../services/bill-payment-error-alerts');

    const result = await alertBillPaymentError({
      invoice: {
        id: 'inv_123',
        invoice_number: 'WPC-2026-0100',
        customer_id: 'cust_123',
        total: '125.50',
        stripe_payment_intent_id: 'pi_123',
      },
      phase: 'stripe_confirm',
      methodCategory: 'us_bank_account',
      error: new Error('Bank account could not be verified'),
      source: 'client',
    });

    expect(result).toEqual({ notified: true, alertId: 'alert-1' });
    expect(triggerNotification).toHaveBeenCalledWith('bill_payment_error', expect.objectContaining({
      amount: 125.5,
      customerName: 'Virginia Demo',
      invoiceId: 'inv_123',
      invoiceNumber: 'WPC-2026-0100',
      methodLabel: 'Bank account',
      phaseLabel: 'Stripe confirmation',
      reason: 'Bank account could not be verified',
      source: 'client',
    }));
  });

  test('suppresses duplicate notifications after the dedupe row already exists', async () => {
    returningRows = [{ id: 'alert-1', occurrence_count: 2 }];
    const { alertBillPaymentError } = require('../services/bill-payment-error-alerts');

    const result = await alertBillPaymentError({
      invoice: {
        id: 'inv_123',
        invoice_number: 'WPC-2026-0100',
        customer_id: 'cust_123',
        total: '125.50',
      },
      phase: 'update_amount',
      methodCategory: 'us_bank_account',
      message: 'Could not update payment total',
    });

    expect(result).toEqual({ notified: false, duplicate: true, alertId: 'alert-1' });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('suppresses client Stripe.js form-validation errors without writing a row or notifying', async () => {
    const { alertBillPaymentError } = require('../services/bill-payment-error-alerts');

    // Mirrors the real WPC-2026-0156 case: customer hit "Pay" with a half-typed card.
    const result = await alertBillPaymentError({
      invoice: {
        id: 'inv_123',
        invoice_number: 'WPC-2026-0156',
        customer_id: 'cust_123',
        total: '117.00',
        stripe_payment_intent_id: 'pi_123',
      },
      phase: 'payment_form_submit',
      methodCategory: 'card',
      message: 'Your card number is incomplete.',
      code: 'incomplete_number',
      source: 'client',
      metadata: { stripe_type: 'validation_error' },
    });

    expect(result).toEqual({ notified: false, skipped: true, reason: 'client_validation_error' });
    // Early return — no audit row, no admin notification.
    expect(dbMock).not.toHaveBeenCalledWith('bill_payment_error_alerts');
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('suppresses the benign 409 "already in progress" conflict without writing a row or notifying', async () => {
    const { alertBillPaymentError } = require('../services/bill-payment-error-alerts');

    // Mirrors the real WPC-2026-0190 case: customer started an ACH bank payment
    // (sits in `processing` for days), then reloaded the pay link / returned
    // from the bank redirect — /setup 409s against the in-flight PaymentIntent.
    // That is not a failure, so it must never raise a "bill payment error" alert.
    const result = await alertBillPaymentError({
      invoice: {
        id: 'inv_123',
        invoice_number: 'WPC-2026-0190',
        customer_id: 'cust_123',
        total: '35.67',
        stripe_payment_intent_id: 'pi_123',
      },
      phase: 'setup',
      methodCategory: 'card',
      message: 'Invoice payment is already in progress',
      statusCode: 409,
      source: 'server',
    });

    expect(result).toEqual({ notified: false, skipped: true, reason: 'payment_in_progress_conflict' });
    // Early return — no audit row, no admin notification.
    expect(dbMock).not.toHaveBeenCalledWith('bill_payment_error_alerts');
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('isInProgressConflict matches only a 409 status code', () => {
    const { __private } = require('../services/bill-payment-error-alerts');
    const { isInProgressConflict } = __private;

    expect(isInProgressConflict({ statusCode: 409 })).toBe(true);
    expect(isInProgressConflict({ statusCode: '409' })).toBe(true);
    expect(isInProgressConflict({ statusCode: 400 })).toBe(false);
    expect(isInProgressConflict({ statusCode: 500 })).toBe(false);
    expect(isInProgressConflict({})).toBe(false);
  });

  test('still alerts on a real server-side decline (not a validation error)', async () => {
    const { alertBillPaymentError } = require('../services/bill-payment-error-alerts');

    const result = await alertBillPaymentError({
      invoice: {
        id: 'inv_123',
        invoice_number: 'WPC-2026-0100',
        customer_id: 'cust_123',
        total: '125.50',
      },
      phase: 'stripe_confirm',
      methodCategory: 'card',
      message: 'Your card was declined.',
      code: 'card_declined',
      source: 'server',
    });

    expect(result).toEqual({ notified: true, alertId: 'alert-1' });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('isClientFormValidationError only matches client-sourced validation events', () => {
    const { __private } = require('../services/bill-payment-error-alerts');
    const { isClientFormValidationError } = __private;

    // client + validation_error type AT the submit phase → suppressed
    expect(isClientFormValidationError({ source: 'client', phase: 'payment_form_submit', metadata: { stripe_type: 'validation_error' } })).toBe(true);
    // client + validation_error type at a confirm / next-action phase → NOT suppressed
    // (real stuck payment — no server catch or webhook covers it)
    expect(isClientFormValidationError({ source: 'client', phase: 'stripe_confirm', metadata: { stripe_type: 'validation_error' } })).toBe(false);
    expect(isClientFormValidationError({ source: 'client', phase: 'next_action', metadata: { stripe_type: 'validation_error' } })).toBe(false);
    // client + incomplete_* field code → suppressed regardless of phase (unambiguous)
    expect(isClientFormValidationError({ source: 'client', phase: 'stripe_confirm', code: 'incomplete_cvc' })).toBe(true);
    // server-sourced validation_error → NOT suppressed (real failures route through server)
    expect(isClientFormValidationError({ source: 'server', phase: 'payment_form_submit', metadata: { stripe_type: 'validation_error' } })).toBe(false);
    // client-sourced real decline → NOT suppressed
    expect(isClientFormValidationError({ source: 'client', phase: 'stripe_confirm', code: 'card_declined' })).toBe(false);
    // default source (server) → NOT suppressed
    expect(isClientFormValidationError({ code: 'incomplete_number' })).toBe(false);
  });

  test('dedupe key ignores volatile Stripe ids inside the error message', () => {
    const { __private } = require('../services/bill-payment-error-alerts');

    const first = __private.buildDedupeKey({
      invoiceId: 'inv_123',
      paymentIntentId: 'pi_outer',
      phase: 'stripe_confirm',
      methodCategory: 'us_bank_account',
      errorMessage: 'PaymentIntent pi_111 failed for PaymentMethod pm_111',
    });
    const second = __private.buildDedupeKey({
      invoiceId: 'inv_123',
      paymentIntentId: 'pi_outer',
      phase: 'stripe_confirm',
      methodCategory: 'us_bank_account',
      errorMessage: 'PaymentIntent pi_222 failed for PaymentMethod pm_222',
    });

    expect(first).toBe(second);
  });
});
