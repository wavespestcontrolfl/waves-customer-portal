/**
 * A merge PREVIEW discloses the stamped combined payment sessions it would
 * cancel (listUnconfirmedCombinedSessionsForCustomer, read-only) and the
 * release re-reads them under its lock and refuses if the set moved
 * (expectedPaymentIntentIds → previewChanged) — Codex #4348 r4 P1.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: jest.fn(async () => null), cancelPaymentIntent: jest.fn() }));

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

test('the plan lists stamped sessions (sorted by PaymentIntent id) and nothing for a missing customer', async () => {
  const db = database({ L: [{ id: 'inv-2', invoice_number: 'INV-2', stripe_payment_intent_id: 'pi_b' }, { id: 'inv-1', invoice_number: null, stripe_payment_intent_id: 'pi_a' }] });
  expect(await listUnconfirmedCombinedSessionsForCustomer(db, 'L')).toEqual([
    { invoice_id: 'inv-1', invoice_number: null, payment_intent_id: 'pi_a' },
    { invoice_id: 'inv-2', invoice_number: 'INV-2', payment_intent_id: 'pi_b' },
  ]);
  expect(await listUnconfirmedCombinedSessionsForCustomer(db, null)).toEqual([]);
  expect(db.raw).not.toHaveBeenCalled(); // read-only: no lock
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
