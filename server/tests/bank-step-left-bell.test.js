/**
 * Bank step left bell (server/services/bank-step-left-bell.js, owner 2026-11-24 "build bell"): one office bell per
 * invoice whose pay page was left on Bank account, unpaid, 30 minutes to 24 hours ago. Stripe search and the alert
 * writer are injected; the invoice read is a mocked db.
 */
const invoices = {};
jest.mock('../models/db', () => jest.fn(() => {
  let id = null;
  const q = {
    where: jest.fn((w) => { id = w.id; return q; }),
    first: jest.fn(async () => invoices[id] || undefined),
  };
  return q;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { runBankStepLeftBell, __private } = require('../services/bank-step-left-bell');

const NOW = new Date('2026-11-24T21:00:00Z');
const sec = (iso) => String(Math.floor(new Date(iso).getTime() / 1000));

function pi(id, invoiceId, touchedIso, extra = {}) {
  return {
    id,
    created: Math.floor(new Date('2026-11-24T12:00:00Z').getTime() / 1000),
    metadata: { waves_invoice_id: invoiceId, selected_method_category: 'us_bank_account', pay_session_touched_at: sec(touchedIso) },
    last_payment_error: null,
    ...extra,
  };
}

function invoice(id, piId, extra = {}) {
  return { id, invoice_number: `WPC-2026-${id}`, status: 'viewed', total: '155.00', credit_applied: '0', amount_paid: '0', stripe_payment_intent_id: piId, payer_id: null, payer_statement_id: null, archived_at: null, ...extra };
}

function stripeWith(pages) {
  const search = jest.fn(async () => pages.shift());
  return { paymentIntents: { search } };
}

beforeEach(() => { for (const k of Object.keys(invoices)) delete invoices[k]; });

test('rings once for an invoice left on Bank account 30+ minutes ago, through the bill-payment alert path', async () => {
  invoices['0100'] = invoice('0100', 'pi_a');
  const stripe = stripeWith([{ data: [pi('pi_a', '0100', '2026-11-24T20:20:00Z')], has_more: false }]);
  const alert = jest.fn(async () => ({ notified: true }));
  const tally = await runBankStepLeftBell({ now: NOW, stripe, alert });
  expect(stripe.paymentIntents.search).toHaveBeenCalledWith({ query: __private.SEARCH_QUERY, limit: 100 });
  expect(__private.SEARCH_QUERY).toBe("status:'requires_payment_method' AND metadata['selected_method_category']:'us_bank_account'");
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({
    invoice: invoices['0100'], phase: 'bank_step_left', methodCategory: 'us_bank_account', paymentIntentId: 'pi_a', source: 'server',
  }));
  expect(tally).toMatchObject({ candidates: 1, rang: 1, duplicate: 0, failed: 0 });
});

test('counts an already-rung invoice as a duplicate (the alert path dedupes per invoice for 24 h)', async () => {
  invoices['0100'] = invoice('0100', 'pi_a');
  const stripe = stripeWith([{ data: [pi('pi_a', '0100', '2026-11-24T20:00:00Z')], has_more: false }]);
  const tally = await runBankStepLeftBell({ now: NOW, stripe, alert: jest.fn(async () => ({ notified: false, duplicate: true })) });
  expect(tally).toMatchObject({ rang: 0, duplicate: 1 });
});

test.each([
  ['too_recent', () => pi('pi_a', '0100', '2026-11-24T20:45:00Z'), () => invoice('0100', 'pi_a')],
  ['too_old', () => pi('pi_a', '0100', '2026-11-23T20:00:00Z'), () => invoice('0100', 'pi_a')],
  ['payment_error_on_intent', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z', { last_payment_error: { code: 'x' } }), () => invoice('0100', 'pi_a')],
  ['invoice_not_found', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => null],
  ['intent_replaced', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => invoice('0100', 'pi_newer')],
  ['not_collectible', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => invoice('0100', 'pi_a', { status: 'paid' })],
  ['not_collectible', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => invoice('0100', 'pi_a', { status: 'processing' })],
  ['payer_billed', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => invoice('0100', 'pi_a', { payer_id: 'payer-1' })],
  ['archived', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => invoice('0100', 'pi_a', { archived_at: '2026-11-24T19:00:00Z' })],
  ['nothing_due', () => pi('pi_a', '0100', '2026-11-24T20:00:00Z'), () => invoice('0100', 'pi_a', { amount_paid: '155.00' })],
])('does not ring: %s', async (reason, makePi, makeInvoice) => {
  const inv = makeInvoice();
  if (inv) invoices['0100'] = inv;
  const alert = jest.fn();
  const tally = await runBankStepLeftBell({ now: NOW, stripe: stripeWith([{ data: [makePi()], has_more: false }]), alert });
  expect(alert).not.toHaveBeenCalled();
  expect(tally.skipped).toEqual({ [reason]: 1 });
});

test('follows Stripe search pages and stops when has_more is false', async () => {
  invoices.a = invoice('a', 'pi_a');
  invoices.b = invoice('b', 'pi_b');
  const stripe = stripeWith([
    { data: [pi('pi_a', 'a', '2026-11-24T20:00:00Z')], has_more: true, next_page: 'p2' },
    { data: [pi('pi_b', 'b', '2026-11-24T20:00:00Z')], has_more: false },
  ]);
  const alert = jest.fn(async () => ({ notified: true }));
  const tally = await runBankStepLeftBell({ now: NOW, stripe, alert });
  expect(stripe.paymentIntents.search).toHaveBeenNthCalledWith(2, { query: __private.SEARCH_QUERY, limit: 100, page: 'p2' });
  expect(tally).toMatchObject({ candidates: 2, rang: 2 });
});

test('one failing intent is logged and the rest still run', async () => {
  invoices.a = invoice('a', 'pi_a');
  invoices.b = invoice('b', 'pi_b');
  const alert = jest.fn().mockRejectedValueOnce(Object.assign(new Error('db'), { code: 'ECONNRESET' })).mockResolvedValueOnce({ notified: true });
  const tally = await runBankStepLeftBell({ now: NOW, stripe: stripeWith([{ data: [pi('pi_a', 'a', '2026-11-24T20:00:00Z'), pi('pi_b', 'b', '2026-11-24T20:00:00Z')], has_more: false }]), alert });
  expect(tally).toMatchObject({ failed: 1, rang: 1 });
});

test('does nothing without a Stripe client', async () => {
  expect(await runBankStepLeftBell({ now: NOW, stripe: null })).toEqual({ skipped: 'stripe_unavailable', candidates: 0, rang: 0 });
});
