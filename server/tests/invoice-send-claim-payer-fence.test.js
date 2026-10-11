/**
 * A payer assignment must not land while a standalone invoice's send claim is live (PR #6117 round 8).
 * The Intelligence Bar's claim holds the customer row FOR SHARE only until the claim commits; from then until
 * the delivery finalizes, the claim row (status 'sending') is the fence, and the Bill-To writers ask
 * packetInvoiceSendInFlight. Before round 8 it saw only combined-visit and renewal invoices. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visit-linked-invoice-withdrawal', () => ({ linkedInvoiceChargeInFlight: jest.fn(async () => false) }));

const { packetInvoiceSendInFlight } = require('../services/visit-completion-packets');
const { linkedInvoiceChargeInFlight } = require('../services/visit-linked-invoice-withdrawal');

// A knex-shaped recorder: every query is a list of [method, args]; `first` answers by the query's shape.
function fakeDatabase({ standaloneRow = null } = {}) {
  const queries = [];
  const database = (table) => {
    const calls = [];
    queries.push({ table, calls });
    const q = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'first') {
          return async () => {
            const standalone = calls.some(([m, a]) => m === 'whereNull' && a[0] === 'visit_completion_packet_id')
              && calls.some(([m, a]) => m === 'where' && a[0] && a[0].status === 'sending');
            return standalone ? standaloneRow : null;
          };
        }
        return (...args) => { calls.push([prop, args]); return q; };
      },
    });
    return q;
  };
  database.raw = (sql) => sql;
  return { database, queries };
}
const standaloneQuery = (queries) => queries.find((q) => q.table === 'invoices'
  && q.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'visit_completion_packet_id')
  && q.calls.some(([m, a]) => m === 'where' && a[0] && a[0].status === 'sending'));

beforeEach(() => jest.clearAllMocks());

describe('the payer writers\' in-flight fence sees a standalone invoice with a live send claim', () => {
  test('a customer\'s standalone invoice in "sending" blocks the Bill-To change', async () => {
    const { database, queries } = fakeDatabase({ standaloneRow: { id: 'inv-1' } });
    await expect(packetInvoiceSendInFlight({ customerId: 'cust-1' }, database)).resolves.toBe(true);
    const q = standaloneQuery(queries);
    expect(q.calls).toEqual(expect.arrayContaining([
      ['whereNull', ['payer_id']],
      ['where', [{ customer_id: 'cust-1' }]],
    ]));
    expect(linkedInvoiceChargeInFlight).not.toHaveBeenCalled();
  });

  test('a claim that has not been written for ten minutes is stale and does not block (a stuck row never blocks a Bill-To change for good)', async () => {
    const { database, queries } = fakeDatabase();
    const before = Date.now();
    await packetInvoiceSendInFlight({ customerId: 'cust-1' }, database);
    const window = standaloneQuery(queries).calls.find(([m, a]) => m === 'where' && a[0] === 'updated_at');
    expect(window[1][1]).toBe('>');
    const cutoff = window[1][2].getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(10 * 60 * 1000 - 50);
    expect(before - cutoff).toBeLessThan(10 * 60 * 1000 + 5000);
  });

  test('the scheduled-service and payer scopes reach the standalone invoices too', async () => {
    const { database, queries } = fakeDatabase();
    await packetInvoiceSendInFlight({ scheduledServiceId: 'visit-1' }, database);
    expect(standaloneQuery(queries).calls).toEqual(expect.arrayContaining([['where', [{ scheduled_service_id: 'visit-1' }]]]));
    const second = fakeDatabase();
    await packetInvoiceSendInFlight({ payerId: 'payer-1' }, second.database);
    const wheres = standaloneQuery(second.queries).calls.filter(([m]) => m === 'where');
    expect(wheres.some(([, a]) => typeof a[0] === 'function')).toBe(true);
  });

  test('with no claim in flight the answer is the visit-linked fence\'s, as before', async () => {
    const { database } = fakeDatabase();
    linkedInvoiceChargeInFlight.mockResolvedValueOnce(true);
    await expect(packetInvoiceSendInFlight({ customerId: 'cust-1' }, database)).resolves.toBe(true);
    await expect(packetInvoiceSendInFlight({ customerId: 'cust-1' }, database)).resolves.toBe(false);
    await expect(packetInvoiceSendInFlight({}, database)).resolves.toBe(false);
  });
});
