/**
 * Codex #4311 r27: the payer-change fence over combined pay-page sessions.
 *  - every session is VERIFIED before any is canceled, so a change refused
 *    because one customer's money is in flight has not already destroyed
 *    another customer's confirmable session (a Stripe cancel does not roll
 *    back with the caller's transaction);
 *  - the scheduled-service variant scans the whole packet, not only the
 *    member the combined invoice is anchored to.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockRetrievePaymentIntent = jest.fn();
const mockCancelPaymentIntent = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...args) => mockRetrievePaymentIntent(...args),
  cancelPaymentIntent: (...args) => mockCancelPaymentIntent(...args),
}));

const db = require('../models/db');
const PayCombined = require('../services/pay-combined');

const ANCHOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const SIBLING_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function combinedPi(id, status) {
  return { id, status, metadata: { waves_invoice_id: ANCHOR_ID, combined_allocation: `${ANCHOR_ID}:10530,${SIBLING_ID}:4455` } };
}

// Minimal knex stand-in: the invoice scan resolves to `rows`, and every
// stamp-clearing update is recorded instead of executed.
function mockDb(rowsByCustomer, { onInvoiceQuery = () => {} } = {}) {
  const updates = [];
  db.mockImplementation((table) => {
    if (table !== 'invoices') throw new Error(`unexpected table ${table}`);
    const q = { customerId: null };
    ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'orderBy'].forEach((m) => {
      q[m] = jest.fn((...args) => {
        if (m === 'where' && args[0] && args[0].customer_id) q.customerId = String(args[0].customer_id);
        onInvoiceQuery(m, args);
        return q;
      });
    });
    // The stamp cleanup re-queries by PaymentIntent id, not by customer.
    q.select = jest.fn(async () => (q.customerId ? rowsByCustomer[q.customerId] || [] : []));
    q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
    return q;
  });
  db.raw = jest.fn(async () => ({}));
  return updates;
}

beforeEach(() => { jest.clearAllMocks(); });

test('an in-flight session on ONE customer refuses the change without canceling another customer\'s session', async () => {
  mockDb({
    'cust-1': [{ id: ANCHOR_ID, invoice_number: 'WPC-1', stripe_payment_intent_id: 'pi_confirmable' }],
    'cust-2': [{ id: SIBLING_ID, invoice_number: 'WPC-2', stripe_payment_intent_id: 'pi_processing' }],
  });
  mockRetrievePaymentIntent.mockImplementation(async (id) => (id === 'pi_processing'
    ? combinedPi(id, 'processing') : combinedPi(id, 'requires_confirmation')));

  const result = await PayCombined.releaseUnconfirmedCombinedSessionsForCustomers(db, ['cust-1', 'cust-2']);

  expect(result).toEqual({ released: 0, inFlight: 1 });
  expect(mockRetrievePaymentIntent).toHaveBeenCalledTimes(2);
  expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
});

test('with nothing in flight every unconfirmed session is canceled and unstamped', async () => {
  const updates = mockDb({
    'cust-1': [
      { id: ANCHOR_ID, invoice_number: 'WPC-1', stripe_payment_intent_id: 'pi_one' },
      { id: SIBLING_ID, invoice_number: 'WPC-2', stripe_payment_intent_id: 'pi_two' },
    ],
  });
  mockRetrievePaymentIntent.mockImplementation(async (id) => combinedPi(id, id === 'pi_two' ? 'canceled' : 'requires_payment_method'));
  mockCancelPaymentIntent.mockResolvedValue({ status: 'canceled' });

  expect(await PayCombined.releaseUnconfirmedCombinedSessionsForCustomers(db, ['cust-1'])).toEqual({ released: 2, inFlight: 0 });
  // The already-canceled PI is not re-canceled; its stamp cleanup still runs.
  expect(mockCancelPaymentIntent).toHaveBeenCalledTimes(1);
  expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_one');
  expect(updates).toHaveLength(2);
});

test('the scheduled-service scan covers every invoice in the edited member\'s packet', async () => {
  const seen = [];
  mockDb({}, { onInvoiceQuery: (method, args) => seen.push([method, args]) });
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      const q = {};
      q.whereIn = jest.fn(() => q);
      q.distinct = jest.fn(() => q);
      q.pluck = jest.fn(async () => ['cust-1']);
      return q;
    }
    if (table === 'visit_completion_packet_items') {
      const q = {};
      q.whereIn = jest.fn(() => q);
      q.select = jest.fn(() => 'PACKET_ITEMS_SUBQUERY');
      return q;
    }
    const q = {};
    ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'orderBy'].forEach((m) => {
      q[m] = jest.fn((...args) => { seen.push([m, args]); return q; });
    });
    q.select = jest.fn(async () => []);
    return q;
  });
  db.raw = jest.fn(async () => ({}));

  expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(db, ['svc-1']))
    .toEqual({ released: 0, inFlight: 0 });
  // The scan's first clause is a grouped OR (anchored member OR packet
  // sibling) — a plain whereIn on scheduled_service_id alone would miss the
  // combined invoice anchored to another member of the same packet.
  const grouped = seen.find(([m, args]) => m === 'where' && typeof args[0] === 'function');
  expect(grouped).toBeDefined();
  const sub = { whereIn: jest.fn(() => sub), orWhereIn: jest.fn(() => sub) };
  grouped[1][0](sub);
  expect(sub.whereIn).toHaveBeenCalledWith('scheduled_service_id', ['svc-1']);
  expect(sub.orWhereIn).toHaveBeenCalledWith('visit_completion_packet_id', 'PACKET_ITEMS_SUBQUERY');
});
