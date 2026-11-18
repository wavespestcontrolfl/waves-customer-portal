jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/stripe', () => ({ getPaymentHistory: jest.fn() }));
jest.mock('../services/invoice-payer-ownership', () => ({
  liveInvoiceOwnership: jest.fn(async () => ({ ownedIds: new Set(), unverifiable: false })),
}));

const { recoveryInvoiceIndexFor } = require('../services/portal-payment-history');
const { liveInvoiceOwnership } = require('../services/invoice-payer-ownership');

const INV_A = '11111111-1111-4111-8111-111111111111';
const INV_B = '22222222-2222-4222-8222-222222222222';

function invoice(overrides = {}) {
  return {
    id: INV_A,
    customer_id: 'cust-1',
    token: 'tok-a',
    invoice_number: 'WPC-100',
    status: 'sent',
    total: '95.00',
    credit_applied: '0',
    amount_paid: '0',
    payer_id: null,
    payer_statement_id: null,
    scheduled_send_error: null,
    stripe_payment_intent_id: 'pi-a',
    stripe_charge_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  liveInvoiceOwnership.mockResolvedValue({ ownedIds: new Set(), unverifiable: false });
});

function reader(rows) {
  return jest.fn(() => {
    const query = {};
    for (const method of [
      'where', 'whereNull', 'whereIn', 'orWhere', 'orWhereIn',
    ]) {
      query[method] = (...args) => {
        if (typeof args[0] === 'function') args[0].call(query);
        return query;
      };
    }
    query.select = async () => rows;
    return query;
  });
}

test('a failed payment receives only its own verified invoice and remaining amount', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', amount: '95.00',
    metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-a',
  }], reader([invoice({ total: '100.00', credit_applied: '5.00' })]));

  expect(recovery.get('pay-a')).toEqual({
    payUrl: '/pay/tok-a', amountDue: 95, invoiceNumber: 'WPC-100',
  });
});

test('two failed payments map to their own invoices instead of the oldest account invoice', async () => {
  const second = invoice({
    id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', total: '60.00',
    stripe_payment_intent_id: 'pi-b',
  });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-a' },
    { id: 'pay-b', status: 'failed', metadata: { invoice_id: INV_B }, stripe_payment_intent_id: 'pi-b' },
  ], reader([second, invoice()]));

  expect(recovery.get('pay-a')?.payUrl).toBe('/pay/tok-a');
  expect(recovery.get('pay-b')).toEqual({ payUrl: '/pay/tok-b', amountDue: 60, invoiceNumber: 'WPC-200' });
});

test('combined ACH shares keep their invoice-specific recovery links after a bounce', async () => {
  const second = invoice({
    id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', total: '60.00',
    stripe_payment_intent_id: 'pi-shared',
  });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    {
      id: 'pay-a', status: 'failed', stripe_payment_intent_id: 'pi-shared',
      metadata: { invoice_id: INV_A, combined_payment: true },
    },
    {
      id: 'pay-b', status: 'failed', stripe_payment_intent_id: 'pi-shared',
      metadata: { invoice_id: INV_B, combined_payment: true },
    },
  ], reader([second, invoice({ stripe_payment_intent_id: 'pi-shared' })]));

  expect(recovery.get('pay-a')?.payUrl).toBe('/pay/tok-a');
  expect(recovery.get('pay-b')?.payUrl).toBe('/pay/tok-b');
});

test('an unmarked shared Stripe identifier remains ambiguous', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', stripe_payment_intent_id: 'pi-shared',
    metadata: { invoice_id: INV_A },
  }], reader([
    invoice({ stripe_payment_intent_id: 'pi-shared' }),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-shared' }),
  ]));

  expect(recovery.has('pay-a')).toBe(false);
});

test('serialized null metadata cannot break recovery for a legacy failed row', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-legacy', status: 'failed', metadata: 'null', stripe_payment_intent_id: 'pi-a',
  }], reader([invoice()]));

  expect(recovery.get('pay-legacy')?.payUrl).toBe('/pay/tok-a');
});

test('conflicting non-explicit identifiers fail closed instead of choosing an invoice', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-conflict', status: 'failed', metadata: null,
    stripe_payment_intent_id: 'pi-a', stripe_charge_id: 'ch-b',
  }], reader([
    invoice(),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-b', stripe_charge_id: 'ch-b' }),
  ]));

  expect(recovery.has('pay-conflict')).toBe(false);
});

test.each([
  ['Stripe intent', { metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-b' }],
  ['Stripe charge', { metadata: { invoice_id: INV_A }, stripe_charge_id: 'ch-b' }],
  ['invoice number', { metadata: { invoice_id: INV_A }, description: 'Invoice WPC-200 — card' }],
  ['legacy alias', { metadata: { invoice_id: INV_A, dispute_invoice_id: INV_A, waves_invoice_id: INV_B } }],
  ['unrecognized metadata ID', { metadata: { invoice_id: 'legacy' }, stripe_payment_intent_id: 'pi-b' }],
  ['unmatched intent', { metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'unmatched' }],
])('withholds the link when the %s cannot confirm the same payable invoice', async (_label, fields) => {
  const invoices = [
    invoice(),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-b', stripe_charge_id: 'ch-b' }),
  ];
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'attempt', status: 'failed', ...fields },
  ], reader(invoices));
  expect(recovery.has('attempt')).toBe(false);
});

test('a legacy metadata alias and a matching intent identify the same invoice', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'attempt', status: 'failed', metadata: JSON.stringify({ waves_invoice_id: INV_A }), stripe_payment_intent_id: 'pi-a',
  }], reader([invoice()]));
  expect(recovery.get('attempt')?.payUrl).toBe('/pay/tok-a');
});

test.each([
  ['parked for reconciliation', { superseded_by_payment_id: 'attempt' }],
  ['collected by another attempt', { superseded_by_payment_id: 'paid-retry' }],
  ['ambiguous before parking', { metadata: { invoice_id: INV_A, ambiguous_outcome: 'true' } }],
  ['card authentication pending', { metadata: { invoice_id: INV_A, requires_action: true } }],
  ['never attempted', { next_retry_at: '2026-12-01', metadata: { invoice_id: INV_A, deferred_reason: 'lock_contention' } }],
])('a failed attempt %s cannot offer another payment on an unpaid draft', async (_reason, fields) => {
  const database = reader([invoice({ status: 'draft' })]);
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'attempt', status: 'failed', metadata: { invoice_id: INV_A }, ...fields },
  ], database);
  expect(recovery.size).toBe(0);
  expect(database).not.toHaveBeenCalled();
});

test('the failed-draft rescue requires the explicit invoice ID used by Billing', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [
    { id: 'explicit', status: 'failed', metadata: { invoice_id: INV_A } },
    { id: 'intent-only', status: 'failed', stripe_payment_intent_id: 'pi-a' },
  ], reader([invoice({ status: 'draft' })]));
  expect(recovery.get('explicit')?.payUrl).toBe('/pay/tok-a');
  expect(recovery.has('intent-only')).toBe(false);
});

test('an explicit settled invoice id never falls through to a different payable identifier', async () => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-explicit', status: 'failed', metadata: { invoice_id: INV_A }, stripe_payment_intent_id: 'pi-b',
  }], reader([
    invoice({ status: 'paid' }),
    invoice({ id: INV_B, token: 'tok-b', invoice_number: 'WPC-200', stripe_payment_intent_id: 'pi-b' }),
  ]));

  expect(recovery.has('pay-explicit')).toBe(false);
});

test('a live-resolved payer invoice never exposes its bearer pay link', async () => {
  liveInvoiceOwnership.mockResolvedValueOnce({ ownedIds: new Set([INV_A]), unverifiable: false });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice()]));

  expect(recovery.has('pay-a')).toBe(false);
});

test('unverifiable live payer ownership withholds every recovery link', async () => {
  liveInvoiceOwnership.mockResolvedValueOnce({ ownedIds: new Set(), unverifiable: true });
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice()]));

  expect(recovery.size).toBe(0);
});

test.each([
  ['settled', { status: 'paid' }],
  ['fully credited', { total: '95.00', credit_applied: '95.00' }],
  ['payer owned', { payer_id: 'payer-1' }],
  ['statement accrued', { payer_statement_id: 'statement-1' }],
  ['withdrawn to a payer', { status: 'draft', scheduled_send_error: 'payer_billed:packet-1' }],
  ['missing token', { token: null }],
])('%s invoices never produce a recovery link', async (_label, change) => {
  const recovery = await recoveryInvoiceIndexFor('cust-1', [{
    id: 'pay-a', status: 'failed', metadata: { invoice_id: INV_A },
  }], reader([invoice(change)]));

  expect(recovery.has('pay-a')).toBe(false);
});
