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

const { listUnconfirmedCombinedSessionsForCustomer, releaseUnconfirmedCombinedSessionsForCustomer, releaseUnconfirmedCombinedSessions, planStampedSessionRelease, applyStampedSessionRelease } = require('../services/pay-combined');

function database(rowsByCustomer) {
  const fn = jest.fn((table) => {
    const q = { _table: table };
    for (const m of ['where', 'whereNotNull', 'whereNotIn', 'orderBy', 'select']) q[m] = jest.fn((...args) => { if (m === 'where') q._where = args[0]; return q; });
    q.update = jest.fn(async () => 1); // the stamp cleanup after a cancel
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

test('a merge cancels the single-invoice checkouts it invalidates; every other caller still leaves them open (Codex r7 P1)', async () => {
  StripeService.retrievePaymentIntent.mockImplementation(async (id) => PI[id] || null);
  // pi_c is an ordinary single-invoice checkout — no combined metadata.
  const rows = { L: [{ id: 'inv-3', invoice_number: 'INV-3', stripe_payment_intent_id: 'pi_c' }] };

  // The payer-change route and the collection rails pass nothing: unchanged
  // single-PI contract, nothing cancelled.
  await expect(releaseUnconfirmedCombinedSessionsForCustomer(database(rows), 'L')).resolves.toEqual({ released: 0, inFlight: 0 });
  expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();

  // A merge retiring this record says its checkouts are invalidated: the PI
  // metadata still names the customer about to be archived, so leaving it
  // open would let a later save-card success mirror consent/autopay onto
  // the retired row.
  await expect(releaseUnconfirmedCombinedSessionsForCustomer(database(rows), 'L', { invalidatedSingleInvoice: true }))
    .resolves.toEqual({ released: 1, inFlight: 0 });
  expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_c');

  // The preview says exactly what the release just did.
  expect(await listUnconfirmedCombinedSessionsForCustomer(database(rows), 'L', { invalidatedSingleInvoice: true }))
    .toEqual([{ invoice_id: 'inv-3', invoice_number: 'INV-3', payment_intent_id: 'pi_c', outcome: 'cancel_single_invoice' }]);

  // Money already moving on a single-invoice checkout is never cancelled —
  // it is reported so the merge defers, exactly like a combined one.
  StripeService.cancelPaymentIntent.mockClear();
  const inFlightRows = { L: [{ id: 'inv-5', invoice_number: 'INV-5', stripe_payment_intent_id: 'pi_e' }] };
  StripeService.retrievePaymentIntent.mockImplementation(async () => ({ id: 'pi_e', status: 'processing', metadata: { invoice_id: 'inv-5' } }));
  await expect(releaseUnconfirmedCombinedSessionsForCustomer(database(inFlightRows), 'L', { invalidatedSingleInvoice: true }))
    .resolves.toEqual({ released: 0, inFlight: 1 });
  expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
});

test('the lock+pin step is separable from the Stripe release, so a caller can resolve a side before its rows move (Codex r8 P1)', async () => {
  const { lockAndPinStampedSessionsForCustomer, releaseUnconfirmedCombinedSessions } = require('../services/pay-combined');
  StripeService.retrievePaymentIntent.mockImplementation(async (id) => PI[id] || null);
  const rows = [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }];

  // The read takes the per-customer lock and returns the rows — nothing in
  // Stripe is touched yet, so the caller can do this before a sweep repoints
  // the invoices onto another customer.
  const db = database({ L: rows });
  await expect(lockAndPinStampedSessionsForCustomer(db, 'L', { expectedPaymentIntentIds: ['pi_a'] })).resolves.toEqual(rows);
  expect(db.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['pay.combined.customer', 'L']);
  expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();

  // The pin is checked at read time, per side.
  await expect(lockAndPinStampedSessionsForCustomer(database({ L: rows }), 'L', { expectedPaymentIntentIds: [] }))
    .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/combined payment sessions changed/) });

  // Releasing the SNAPSHOT later cancels exactly those sessions, with no
  // second read of the (by then repointed) invoice rows.
  const later = database({});
  await expect(releaseUnconfirmedCombinedSessions(later, rows)).resolves.toEqual({ released: 1, inFlight: 0 });
  expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_a');
});


test('an intent whose OUTCOME changed since the card refuses with previewChanged — the id pin alone would have let it through (Codex r10 P1)', async () => {
  // Approved as `cancel`; the customer confirmed it with Stripe in the
  // meantime, so it now reads `in_flight`. Same id, same stamp — only the
  // outcome moved, which is exactly what the id pin cannot see.
  StripeService.retrievePaymentIntent.mockImplementation(async () => ({ id: 'pi_a', status: 'processing', metadata: { combined_allocation: '{"x":1}' } }));
  const rows = [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }];
  const db = database({ L: rows });
  await expect(releaseUnconfirmedCombinedSessions(db, rows, { expectedOutcomes: { pi_a: 'cancel' } }))
    .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/the card said cancel, it is now in_flight/) });
  expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
  // Unchanged outcome → released normally.
  StripeService.retrievePaymentIntent.mockImplementation(async () => PI.pi_a);
  await expect(releaseUnconfirmedCombinedSessions(database({ L: rows }), rows, { expectedOutcomes: { pi_a: 'cancel' } }))
    .resolves.toEqual({ released: 1, inFlight: 0 });
  // No pin at all (a direct call with no card) → the outcome is not asserted.
  StripeService.retrievePaymentIntent.mockImplementation(async () => ({ id: 'pi_a', status: 'processing', metadata: { combined_allocation: '{"x":1}' } }));
  await expect(releaseUnconfirmedCombinedSessions(database({ L: rows }), rows)).resolves.toEqual({ released: 0, inFlight: 1 });
});


test('planning cancels nothing and retrieves each distinct intent ONCE, however many invoices it is stamped on (Codex r11 P1 + P2)', async () => {
  StripeService.retrievePaymentIntent.mockImplementation(async (id) => PI[id] || null);
  // pi_a stamped on three invoices, pi_b (processing → in_flight) on one.
  const rows = [
    { id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' },
    { id: 'inv-2', invoice_number: 'INV-2', stripe_payment_intent_id: 'pi_a' },
    { id: 'inv-3', invoice_number: 'INV-3', stripe_payment_intent_id: 'pi_a' },
    { id: 'inv-4', invoice_number: 'INV-4', stripe_payment_intent_id: 'pi_b' },
  ];
  const plan = await planStampedSessionRelease(database({ L: rows }), rows);
  expect(StripeService.retrievePaymentIntent).toHaveBeenCalledTimes(2); // not 4
  expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled(); // planning writes nothing
  expect(plan.inFlight).toBe(1);
  expect(plan.intents).toEqual([
    { piId: 'pi_a', outcome: 'cancel', status: 'requires_payment_method' },
    { piId: 'pi_b', outcome: 'in_flight', status: 'processing' },
  ]);
  // Applying the plan performs the writes, and never re-reads Stripe.
  StripeService.retrievePaymentIntent.mockClear();
  const applied = await applyStampedSessionRelease(database({ L: rows }), plan);
  expect(StripeService.retrievePaymentIntent).not.toHaveBeenCalled();
  expect(StripeService.cancelPaymentIntent).toHaveBeenCalledTimes(1);
  expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_a');
  expect(applied).toEqual({ released: 1, inFlight: 1 });
});


test('the preview retrieves each intent once and gives every invoice row of one intent the SAME outcome (Codex r12 P2)', async () => {
  let call = 0;
  // Second read of the same intent reports a different status: the preview
  // must not see it, because it retrieves once.
  StripeService.retrievePaymentIntent.mockImplementation(async (id) => {
    call += 1;
    if (id !== 'pi_a') return PI[id] || null;
    return call === 1 ? PI.pi_a : { id: 'pi_a', status: 'processing', metadata: { combined_allocation: '{"x":1}' } };
  });
  const rows = [
    { id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' },
    { id: 'inv-2', invoice_number: 'INV-2', stripe_payment_intent_id: 'pi_a' },
    { id: 'inv-3', invoice_number: 'INV-3', stripe_payment_intent_id: 'pi_a' },
  ];
  const sessions = await listUnconfirmedCombinedSessionsForCustomer(database({ L: rows }), 'L');
  expect(StripeService.retrievePaymentIntent).toHaveBeenCalledTimes(1);
  expect(sessions).toHaveLength(3);
  expect([...new Set(sessions.map((s) => s.outcome))]).toEqual(['cancel']);
});
