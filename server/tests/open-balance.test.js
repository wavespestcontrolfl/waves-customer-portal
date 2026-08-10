/**
 * open-balance.js — selection contract for the previous-balance surfaces
 * (owner ruling 2026-08-08, Donovan case).
 *
 * Contract (mirrors the portalPayNow open-invoice authority, hardened by the
 * pre-push round):
 *   - status sent/viewed/overdue only, payer_id NULL, payer_statement_id
 *     NULL, positive remainder in SQL, oldest first, bounded (logged valve)
 *   - excludeInvoiceId keeps the invoice being viewed/emailed out of its own
 *     previous balance
 *   - LIVE payer re-resolution per row: a payer that exists only on the
 *     visit (or as the customer default) drops the row; a resolve failure
 *     drops it too (fail closed)
 *   - rows whose cents-safe amountDue is 0 are dropped in JS even if the SQL
 *     predicate admitted them
 *   - summary: total/count over the FULL set, display list capped with
 *     moreCount carrying the remainder
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
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

const { openBalanceInvoices, openBalanceSummary, MAX_OPEN_INVOICES } = require('../services/open-balance');

describe('open-balance selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tableResults.rows = [];
    tableResults.lastCalls = null;
    mockResolveForInvoice.mockImplementation(async () => ({ payerId: null }));
  });

  test('issues the portalPayNow-shaped query: delivered statuses, payer-free, statement-free, positive remainder, oldest first, bounded', async () => {
    await openBalanceInvoices('cust-1', { excludeInvoiceId: 'inv-current' });
    expect(tableResults.lastCalls).toEqual(expect.arrayContaining([
      ['where', [{ customer_id: 'cust-1' }]],
      ['whereIn', ['status', ['sent', 'viewed', 'overdue']]],
      ['whereNull', ['payer_id']],
      ['whereNull', ['payer_statement_id']],
      ['whereRaw', ['GREATEST(total - COALESCE(credit_applied, 0), 0) > 0']],
      ['orderBy', ['created_at', 'asc']],
      ['limit', [MAX_OPEN_INVOICES]],
      ['whereNot', ['id', 'inv-current']],
    ]));
  });

  test('no customer id → empty, no query', async () => {
    expect(await openBalanceInvoices(null)).toEqual([]);
    expect(tableResults.lastCalls).toBeNull();
  });

  test('live payer re-resolution drops payer-billed rows the invoice column missed', async () => {
    tableResults.rows = [
      { id: 'a', invoice_number: 'INV-A', total: '100.00', credit_applied: 0, scheduled_service_id: 'svc-a' },
      { id: 'b', invoice_number: 'INV-B', total: '200.00', credit_applied: 0, scheduled_service_id: 'svc-b' },
    ];
    // svc-a resolves to a live payer (assigned after mint) — must drop.
    mockResolveForInvoice.mockImplementation(async ({ scheduledServiceId }) => (
      scheduledServiceId === 'svc-a' ? { payerId: 'payer-1' } : { payerId: null }
    ));
    const rows = await openBalanceInvoices('cust-1');
    expect(rows.map((r) => r.id)).toEqual(['b']);
    expect(mockResolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', scheduledServiceId: 'svc-a', throwOnError: true,
    }));
  });

  test('a payer resolve failure drops the row (fail closed)', async () => {
    tableResults.rows = [
      { id: 'a', invoice_number: 'INV-A', total: '100.00', credit_applied: 0, scheduled_service_id: 'svc-a' },
    ];
    mockResolveForInvoice.mockRejectedValue(new Error('payer service down'));
    expect(await openBalanceInvoices('cust-1')).toEqual([]);
  });

  test('a row with no visit still checks the customer default payer', async () => {
    tableResults.rows = [
      { id: 'a', invoice_number: 'INV-A', total: '100.00', credit_applied: 0, scheduled_service_id: null },
    ];
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-default' });
    expect(await openBalanceInvoices('cust-1')).toEqual([]);
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-1', throwOnError: true });
  });

  test('drops rows whose cents-safe remainder is zero even when SQL admitted them', async () => {
    tableResults.rows = [
      { id: 'a', total: '49.00', credit_applied: '49.00' },
      { id: 'b', total: '107.10', credit_applied: '7.10' },
    ];
    const rows = await openBalanceInvoices('cust-1');
    expect(rows.map((r) => r.id)).toEqual(['b']);
    // Fully-credited rows never hit the payer resolver.
    expect(mockResolveForInvoice).toHaveBeenCalledTimes(1);
  });

  test('summary: cents-safe total over the FULL set, display list capped with moreCount', async () => {
    // 107.10−7.10=100.00 and 62.10 must sum to exactly 162.10 — no float drift.
    tableResults.rows = [
      { id: 'a', total: '107.10', credit_applied: '7.10' },
      { id: 'b', total: '62.10', credit_applied: null },
      { id: 'c', total: '10.00', credit_applied: null },
    ];
    const summary = await openBalanceSummary('cust-1', { displayLimit: 2 });
    expect(summary.total).toBe(172.1);
    expect(summary.count).toBe(3);
    expect(summary.moreCount).toBe(1);
    expect(summary.invoices.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
