/**
 * A merge PREVIEW discloses the stamped combined payment sessions it would
 * cancel (listUnconfirmedCombinedSessionsForCustomer, read-only) and the
 * release re-reads them under its lock and refuses if the set moved
 * (expectedPaymentIntentIds → previewChanged) — Codex #4348 r4 P1. Each
 * listed session carries the outcome the release will actually apply to it,
 * decided by the same Stripe metadata read (r5 P1).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: jest.fn(async () => null), cancelPaymentIntent: jest.fn() }));
beforeEach(() => { jest.clearAllMocks(); });

const { listUnconfirmedCombinedSessionsForCustomer, releaseUnconfirmedCombinedSessionsForCustomer } = require('../services/pay-combined');

function database(rowsByCustomer) {
  const fn = jest.fn((table) => {
    const q = { _table: table };
    for (const m of ['where', 'whereNotNull', 'whereNotIn', 'select']) q[m] = jest.fn((...args) => { if (m === 'where') q._where = args[0]; return q; });
    q.then = (resolve, reject) => Promise.resolve(rowsByCustomer[q._where?.customer_id] || []).then(resolve, reject);
    return q;
  });
  fn.raw = jest.fn(async () => ({ rows: [] }));
  return fn;
}

const StripeService = require('../services/stripe');
const PI = {
  pi_a: { id: 'pi_a', status: 'requires_payment_method', metadata: { combined_allocation: '{"x":1}' } },
  pi_b: { id: 'pi_b', status: 'processing', metadata: { combined_allocation: '{"x":1}' } },
  pi_c: { id: 'pi_c', status: 'requires_payment_method', metadata: { invoice_id: 'inv-3' } }, // single-invoice checkout
  pi_d: { id: 'pi_d', status: 'canceled', metadata: { combined_allocation: '{"x":1}' } },
};

test('the plan lists stamped sessions (sorted by PaymentIntent id) with the per-intent outcome the release decides, and nothing for a missing customer', async () => {
  StripeService.retrievePaymentIntent.mockImplementation(async (id) => PI[id] || null);
  const db = database({ L: [
    { id: 'inv-3', invoice_number: 'INV-3', stripe_payment_intent_id: 'pi_c' },
    { id: 'inv-2', invoice_number: 'INV-2', stripe_payment_intent_id: 'pi_b' },
    { id: 'inv-4', invoice_number: null, stripe_payment_intent_id: 'pi_d' },
    { id: 'inv-1', invoice_number: null, stripe_payment_intent_id: 'pi_a' },
  ] });
  expect(await listUnconfirmedCombinedSessionsForCustomer(db, 'L')).toEqual([
    { invoice_id: 'inv-1', invoice_number: null, payment_intent_id: 'pi_a', outcome: 'cancel' },
    { invoice_id: 'inv-2', invoice_number: 'INV-2', payment_intent_id: 'pi_b', outcome: 'in_flight' },
    { invoice_id: 'inv-3', invoice_number: 'INV-3', payment_intent_id: 'pi_c', outcome: 'kept_single_invoice' },
    { invoice_id: 'inv-4', invoice_number: null, payment_intent_id: 'pi_d', outcome: 'stamps_cleared' },
  ]);
  expect(await listUnconfirmedCombinedSessionsForCustomer(db, null)).toEqual([]);
  expect(db.raw).not.toHaveBeenCalled(); // read-only: no lock
});

test('the plan fails closed when an intent cannot be verified (Stripe unavailable or erroring) — no card promises an unchecked outcome', async () => {
  const db = database({ L: [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }] });
  StripeService.retrievePaymentIntent.mockResolvedValueOnce(null);
  await expect(listUnconfirmedCombinedSessionsForCustomer(db, 'L')).rejects.toThrow(/Could not verify payment session pi_a for the merge preview \(payment service unavailable\)/);
  StripeService.retrievePaymentIntent.mockRejectedValueOnce(new Error('rate limited'));
  await expect(listUnconfirmedCombinedSessionsForCustomer(db, 'L')).rejects.toThrow(/Could not verify payment session pi_a for the merge preview \(rate limited\)/);
});

test('stampedSessionOutcome is the single per-intent rule (the release branches on the same answer)', () => {
  const { stampedSessionOutcome } = require('../services/pay-combined');
  expect(stampedSessionOutcome(null)).toBeNull();
  expect(stampedSessionOutcome(PI.pi_a)).toBe('cancel');
  expect(stampedSessionOutcome({ status: 'requires_action', metadata: { combined_allocation: '1' } })).toBe('cancel');
  expect(stampedSessionOutcome(PI.pi_b)).toBe('in_flight');
  expect(stampedSessionOutcome({ status: 'succeeded', metadata: { combined_allocation: '1' } })).toBe('in_flight');
  expect(stampedSessionOutcome(PI.pi_c)).toBe('kept_single_invoice');
  expect(stampedSessionOutcome({ status: 'canceled', metadata: {} })).toBe('kept_single_invoice');
  expect(stampedSessionOutcome(PI.pi_d)).toBe('stamps_cleared');
});

test('the release re-reads under the pay.combined lock and refuses with previewChanged when the pinned set moved; a matching pin proceeds', async () => {
  const db = database({ L: [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }] });
  await expect(releaseUnconfirmedCombinedSessionsForCustomer(db, 'L', { expectedPaymentIntentIds: [] }))
    .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/combined payment sessions changed/) });
  expect(db.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['pay.combined.customer', 'L']);
  const empty = database({});
  await expect(releaseUnconfirmedCombinedSessionsForCustomer(empty, 'L', { expectedPaymentIntentIds: [] })).resolves.toEqual({ released: 0, inFlight: 0 });
  // No pin (admin queue merge): the release runs as before.
  await expect(releaseUnconfirmedCombinedSessionsForCustomer(empty, 'L')).resolves.toEqual({ released: 0, inFlight: 0 });
});
