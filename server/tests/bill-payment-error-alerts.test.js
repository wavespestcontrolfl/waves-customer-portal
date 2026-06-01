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
