/**
 * pastDueSmsLineForCustomer — the {past_due_line} clause for the
 * with-invoice completion texts (GATE_COMPLETION_SMS_BALANCE, owner
 * directive 2026-08-15).
 *
 * Contract (mirrors reservice-link's line shape and the balanceVisibility
 * email note's selection):
 *   - gate OFF → '' with NO balance query (renders byte-identical to today)
 *   - gate ON + no open balance → ''
 *   - gate ON + balance → one clause ending '\n\n', singular/plural by
 *     invoice count, cents-exact amount
 *   - excludeInvoiceId keeps the visit's own invoice out of the balance
 *   - any failure → '' (a balance-line error must never suppress the
 *     completion text)
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
}));

const mockIsEnabled = jest.fn(() => false);
jest.mock('../config/feature-gates', () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
  gates: {},
}));

const tableResults = { rows: [], lastCalls: null, queryCount: 0 };

jest.mock('../models/db', () => {
  const mkChain = () => {
    const q = { _calls: [] };
    const passthrough = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'orderBy', 'limit', 'select'];
    for (const m of passthrough) q[m] = (...args) => { q._calls.push([m, args]); return q; };
    q.then = (onOk, onErr) => {
      tableResults.lastCalls = q._calls;
      tableResults.queryCount += 1;
      if (tableResults.rows instanceof Error) return Promise.reject(tableResults.rows).then(onOk, onErr);
      return Promise.resolve(tableResults.rows).then(onOk, onErr);
    };
    return q;
  };
  const dbFn = jest.fn(() => mkChain());
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const { pastDueSmsLineForCustomer } = require('../services/open-balance');

describe('pastDueSmsLineForCustomer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tableResults.rows = [];
    tableResults.lastCalls = null;
    tableResults.queryCount = 0;
    mockIsEnabled.mockImplementation(() => false);
    mockResolveForInvoice.mockImplementation(async () => ({ payerId: null }));
  });

  test('gate OFF → empty string and no balance query', async () => {
    expect(await pastDueSmsLineForCustomer('cust-1', { excludeInvoiceId: 'inv-now' })).toBe('');
    expect(tableResults.queryCount).toBe(0);
  });

  test('gate consulted by name', async () => {
    await pastDueSmsLineForCustomer('cust-1');
    expect(mockIsEnabled).toHaveBeenCalledWith('completionSmsBalance');
  });

  test('no customer id → empty string even with the gate on', async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    expect(await pastDueSmsLineForCustomer(null)).toBe('');
    expect(tableResults.queryCount).toBe(0);
  });

  test('gate ON + no open balance → empty string', async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    tableResults.rows = [];
    expect(await pastDueSmsLineForCustomer('cust-1', { excludeInvoiceId: 'inv-now' })).toBe('');
  });

  test('gate ON + one open invoice → singular clause, cents-exact, trailing paragraph break', async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    tableResults.rows = [
      { id: 'a', invoice_number: 'INV-A', total: '52.10', credit_applied: 0, scheduled_service_id: null },
    ];
    expect(await pastDueSmsLineForCustomer('cust-1', { excludeInvoiceId: 'inv-now' })).toBe(
      "Reminder: your account also has a past-due balance of $52.10 from an earlier invoice, separate from today's invoice.\n\n",
    );
  });

  test('gate ON + several open invoices → plural clause over the summed remainders', async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    tableResults.rows = [
      { id: 'a', invoice_number: 'INV-A', total: '52.10', credit_applied: 0, scheduled_service_id: null },
      { id: 'b', invoice_number: 'INV-B', total: '100.00', credit_applied: '25.00', scheduled_service_id: null },
    ];
    expect(await pastDueSmsLineForCustomer('cust-1')).toBe(
      "Reminder: your account also has a past-due balance of $127.10 from 2 earlier invoices, separate from today's invoice.\n\n",
    );
  });

  test("the visit's own invoice is excluded from its past-due balance", async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    tableResults.rows = [];
    await pastDueSmsLineForCustomer('cust-1', { excludeInvoiceId: 'inv-now' });
    expect(tableResults.lastCalls).toEqual(expect.arrayContaining([
      ['whereNot', ['id', 'inv-now']],
    ]));
  });

  test('payer-billed rows never surface to the homeowner (live re-resolution drops them)', async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    tableResults.rows = [
      { id: 'a', invoice_number: 'INV-A', total: '52.10', credit_applied: 0, scheduled_service_id: 'svc-a' },
    ];
    mockResolveForInvoice.mockImplementation(async () => ({ payerId: 'payer-1' }));
    expect(await pastDueSmsLineForCustomer('cust-1')).toBe('');
  });

  test('lookup failure → empty string, never throws', async () => {
    mockIsEnabled.mockImplementation((k) => k === 'completionSmsBalance');
    tableResults.rows = new Error('db down');
    await expect(pastDueSmsLineForCustomer('cust-1')).resolves.toBe('');
  });
});
