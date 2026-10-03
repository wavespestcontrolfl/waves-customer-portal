/**
 * The saved-card charge transaction takes its row locks in the order every Bill-To writer does:
 * customer, then visit, then invoice. (The customer and visit locks the Auto Pay and self-pay checks
 * take used to come after the invoice lock, so a charge and a payer edit could wait on each other.)
 */
describe('chargeInvoiceWithSavedCard lock order', () => {
  beforeEach(() => { jest.resetModules(); });

  test('customer, then visit, then invoice, before any check runs', async () => {
    const invoice = {
      id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'draft', subtotal: '200.00', total: '200.00',
      discount_amount: '0.00', credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: null,
    };
    const card = { id: 'pm-1', customer_id: 'cust-1', method_type: 'card', stripe_payment_method_id: 'pm_stripe_1', card_funding: 'debit', last_four: '4242' };
    const pausedCustomer = { id: 'cust-1', stripe_customer_id: 'cus-1', autopay_enabled: true, autopay_paused_until: new Date(Date.now() + 86400000), autopay_payment_method_id: 'pm-1', ach_status: null };
    const locks = [];
    let chargeAttempt = null;
    const db = jest.fn((table) => {
      const chain = {};
      ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'orWhereColumn', 'orderBy'].forEach((method) => {
        chain[method] = jest.fn((arg) => { if (method === 'where' && typeof arg === 'function') arg.call(chain); return chain; });
      });
      chain.forUpdate = jest.fn(() => { locks.push(table); return chain; });
      chain.first = jest.fn(async () => {
        if (table === 'invoices') return invoice;
        if (table === 'payment_methods') return card;
        if (table === 'customers') return pausedCustomer;
        if (table === 'scheduled_services') return { id: 'visit-1', customer_id: 'cust-1', status: 'completed' };
        if (table === 'stripe_invoice_charge_attempts') return chargeAttempt;
        return null;
      });
      chain.insert = jest.fn((payload) => { if (table === 'stripe_invoice_charge_attempts') chargeAttempt = { ...payload, created_at: new Date(), resolved_at: null }; return chain; });
      chain.returning = jest.fn(async () => (chargeAttempt ? [chargeAttempt] : []));
      chain.update = jest.fn(async (payload) => { if (table === 'stripe_invoice_charge_attempts' && chargeAttempt) Object.assign(chargeAttempt, payload); return 1; });
      chain.select = jest.fn(async () => { const row = await chain.first(); return row ? [row] : []; });
      return chain;
    });
    db.transaction = jest.fn(async (callback) => { locks.push('TX'); return callback(db); });
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const stripeClient = { paymentIntents: { retrieve: jest.fn(), cancel: jest.fn(), create: jest.fn() } };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    const StripeService = require('../services/stripe');
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {
      requireAutopayForCustomerId: 'cust-1', requireSelfPayScheduledServiceId: 'visit-1',
    })).rejects.toThrow('Auto Pay is no longer active');
    // The charge transaction's first three row locks (the durable claim has its own transaction
    // before it) are in the Bill-To writers' order.
    const at = locks.indexOf('scheduled_services');
    expect(at).toBeGreaterThan(0);
    expect(locks.slice(at - 1, at + 2)).toEqual(['customers', 'scheduled_services', 'invoices']);
  });

  test('an explicit charge with no lock options still locks the customer first when credit can apply', async () => {
    const invoice = {
      id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'draft', subtotal: '200.00', total: '200.00',
      discount_amount: '0.00', credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: null,
    };
    const card = { id: 'pm-1', customer_id: 'cust-1', method_type: 'card', stripe_payment_method_id: 'pm_stripe_1', card_funding: 'debit', last_four: '4242' };
    const pausedCustomer = { id: 'cust-1', stripe_customer_id: 'cus-1', autopay_enabled: true, autopay_paused_until: new Date(Date.now() + 86400000), autopay_payment_method_id: 'pm-1', ach_status: null };
    const locks = [];
    let chargeAttempt = null;
    const db = jest.fn((table) => {
      const chain = {};
      ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'orWhereColumn', 'orderBy'].forEach((method) => {
        chain[method] = jest.fn((arg) => { if (method === 'where' && typeof arg === 'function') arg.call(chain); return chain; });
      });
      chain.forUpdate = jest.fn(() => { locks.push(table); return chain; });
      chain.first = jest.fn(async () => {
        if (table === 'invoices') return invoice;
        if (table === 'payment_methods') return card;
        if (table === 'customers') return pausedCustomer;
        if (table === 'scheduled_services') return { id: 'visit-1', customer_id: 'cust-1', status: 'completed' };
        if (table === 'stripe_invoice_charge_attempts') return chargeAttempt;
        return null;
      });
      chain.insert = jest.fn((payload) => { if (table === 'stripe_invoice_charge_attempts') chargeAttempt = { ...payload, created_at: new Date(), resolved_at: null }; return chain; });
      chain.returning = jest.fn(async () => (chargeAttempt ? [chargeAttempt] : []));
      chain.update = jest.fn(async (payload) => { if (table === 'stripe_invoice_charge_attempts' && chargeAttempt) Object.assign(chargeAttempt, payload); return 1; });
      chain.select = jest.fn(async () => { const row = await chain.first(); return row ? [row] : []; });
      return chain;
    });
    db.transaction = jest.fn(async (callback) => { locks.push('TX'); return callback(db); });
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const stripeClient = { paymentIntents: { retrieve: jest.fn(), cancel: jest.fn(), create: jest.fn() } };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: true } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    const StripeService = require('../services/stripe');
    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1').catch(() => {});
    // The charge transaction's first three row locks (the durable claim has its own transaction
    // before it) are in the Bill-To writers' order.
    const customerAt = locks.indexOf('customers');
    const invoiceAt = locks.indexOf('invoices', locks.indexOf('TX', 1));
    expect(customerAt).toBeGreaterThan(0);
    expect(customerAt).toBeLessThan(invoiceAt);
  });
});
