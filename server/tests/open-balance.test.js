/**
 * open-balance.js — selection contract for the previous-balance surfaces
 * (owner ruling 2026-08-08, Donovan case).
 *
 * Contract (mirrors the portalPayNow open-invoice authority):
 *   - status sent/viewed/overdue only, payer_id NULL, payer_statement_id
 *     NULL, positive remainder in SQL, oldest first
 *   - excludeInvoiceId keeps the invoice being viewed/emailed out of its own
 *     previous balance
 *   - rows whose cents-safe amountDue is 0 are dropped in JS even if the SQL
 *     predicate admitted them
 *   - summary total = pure cents-safe sum of per-invoice remainders (never
 *     re-discounted / re-taxed)
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const tableResults = { rows: [], lastCalls: null };

jest.mock('../models/db', () => {
  const mkChain = () => {
    const q = { _calls: [] };
    const passthrough = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'orderBy', 'limit', 'select'];
    for (const m of passthrough) q[m] = (...args) => { q._calls.push([m, args]); return q; };
    q.then = (onOk, onErr) => {
      tableResults.lastCalls = q._calls;
      return Promise.resolve(tableResults.rows).then(onOk, onErr);
    };
    return q;
  };
  const dbFn = jest.fn(() => mkChain());
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const { openBalanceInvoices, openBalanceSummary } = require('../services/open-balance');

describe('open-balance selection', () => {
  beforeEach(() => {
    tableResults.rows = [];
    tableResults.lastCalls = null;
  });

  test('issues the portalPayNow-shaped query: delivered statuses, payer-free, statement-free, positive remainder, oldest first', async () => {
    await openBalanceInvoices('cust-1', { excludeInvoiceId: 'inv-current' });
    expect(tableResults.lastCalls).toEqual(expect.arrayContaining([
      ['where', [{ customer_id: 'cust-1' }]],
      ['whereIn', ['status', ['sent', 'viewed', 'overdue']]],
      ['whereNull', ['payer_id']],
      ['whereNull', ['payer_statement_id']],
      ['whereRaw', ['GREATEST(total - COALESCE(credit_applied, 0), 0) > 0']],
      ['orderBy', ['created_at', 'asc']],
      ['whereNot', ['id', 'inv-current']],
    ]));
  });

  test('no customer id → empty, no query', async () => {
    expect(await openBalanceInvoices(null)).toEqual([]);
    expect(tableResults.lastCalls).toBeNull();
  });

  test('drops rows whose cents-safe remainder is zero even when SQL admitted them', async () => {
    tableResults.rows = [
      { id: 'a', total: '49.00', credit_applied: '49.00' },
      { id: 'b', total: '107.10', credit_applied: '7.10' },
    ];
    const rows = await openBalanceInvoices('cust-1');
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  test('summary total is the cents-safe sum of remainders', async () => {
    // 0.1 + 0.2 style float traps: 107.10−7.10=100.00 and 62.10 must sum to
    // exactly 162.10, not 162.10000000000002.
    tableResults.rows = [
      { id: 'a', total: '107.10', credit_applied: '7.10' },
      { id: 'b', total: '62.10', credit_applied: null },
    ];
    const summary = await openBalanceSummary('cust-1');
    expect(summary.total).toBe(162.1);
    expect(summary.count).toBe(2);
  });
});
