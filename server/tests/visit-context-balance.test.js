/**
 * visit-context/balance.js — the shared feed-grade open-balance query.
 *
 * Contract (extracted verbatim from the day-schedule feed, Codex r1 there):
 *   - status sent/viewed/overdue only (OPEN_INVOICE_STATUSES)
 *   - payer_id NULL — third-party-billed AR is never the homeowner's balance
 *     (the inline tech-tools copy this replaces omitted exactly this clause)
 *   - credit-net, floor-at-zero SQL aggregate; count; BOOL_OR overdue
 *   - normalized { balance:number, count:number, overdue:boolean } with
 *     zero-defaults when the aggregate row is missing
 */
const mockTableResults = { row: undefined, lastCalls: null };

jest.mock('../models/db', () => {
  const mkChain = () => {
    const q = { _calls: [] };
    for (const m of ['where', 'whereIn', 'whereNull']) {
      q[m] = (...args) => { q._calls.push([m, args]); return q; };
    }
    q.first = (...args) => {
      q._calls.push(['first', args]);
      mockTableResults.lastCalls = q._calls;
      return Promise.resolve(mockTableResults.row);
    };
    return q;
  };
  const dbFn = jest.fn(() => mkChain());
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const { openInvoiceFacts } = require('../services/visit-context/balance');
const { OPEN_INVOICE_STATUSES } = require('../services/visit-context/statuses');

describe('openInvoiceFacts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTableResults.row = undefined;
    mockTableResults.lastCalls = null;
  });

  test('issues the day-feed-shaped query: open statuses, payer-free, credit-net aggregates', async () => {
    mockTableResults.row = { balance: 123.5, count: 2, overdue: true };
    await openInvoiceFacts('cust-1');
    expect(mockTableResults.lastCalls).toEqual([
      ['where', [{ customer_id: 'cust-1' }]],
      ['whereIn', ['status', OPEN_INVOICE_STATUSES]],
      ['whereNull', ['payer_id']],
      ['first', [
        'COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)), 0)::float as balance',
        'COUNT(*)::int as count',
        "COALESCE(BOOL_OR(status = 'overdue'), false) as overdue",
      ]],
    ]);
    expect(OPEN_INVOICE_STATUSES).toEqual(['sent', 'viewed', 'overdue']);
  });

  test('normalizes the aggregate row', async () => {
    mockTableResults.row = { balance: '88.25', count: '3', overdue: false };
    expect(await openInvoiceFacts('cust-1')).toEqual({ balance: 88.25, count: 3, overdue: false });
  });

  test('missing aggregate row → zero-defaults, never throws', async () => {
    mockTableResults.row = undefined;
    expect(await openInvoiceFacts('cust-1')).toEqual({ balance: 0, count: 0, overdue: false });
  });
});
