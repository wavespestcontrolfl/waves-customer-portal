/**
 * visit-context/balance.js — open-balance facts delegated to the canonical
 * openBalanceSummary (services/open-balance.js), including live payer
 * re-resolution, statement/withdrawn/chemical-hold exclusions, and positive
 * remainder checks.
 */
const mockOpenBalanceSummary = jest.fn();

jest.mock('../services/open-balance', () => ({
  openBalanceSummary: (...args) => mockOpenBalanceSummary(...args),
}));

const defaultDb = require('../models/db');
const { openInvoiceFacts } = require('../services/visit-context/balance');

describe('openInvoiceFacts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('delegates to openBalanceSummary with the caller db and maps balance, count, and overdue', async () => {
    mockOpenBalanceSummary.mockResolvedValue({ total: 123.5, count: 2, overdueCount: 1, complete: true });
    const result = await openInvoiceFacts('cust-1');
    expect(mockOpenBalanceSummary).toHaveBeenCalledWith('cust-1', { database: defaultDb });
    expect(result).toEqual({ balance: 123.5, count: 2, overdue: true, complete: true });
  });

  test('passes a custom db/trx through and normalizes zero overdueCount to false', async () => {
    const trx = { custom: true };
    mockOpenBalanceSummary.mockResolvedValue({ total: 88.25, count: 3, overdueCount: 0, complete: true });
    expect(await openInvoiceFacts('cust-1', { db: trx })).toEqual({ balance: 88.25, count: 3, overdue: false, complete: true });
    expect(mockOpenBalanceSummary).toHaveBeenCalledWith('cust-1', { database: trx });
  });

  test('missing customerId returns zero-defaults without querying; incomplete or missing summary reports unavailable', async () => {
    expect(await openInvoiceFacts(null)).toEqual({ balance: 0, count: 0, overdue: false, complete: true });
    expect(mockOpenBalanceSummary).not.toHaveBeenCalled();

    mockOpenBalanceSummary.mockResolvedValue({ total: 45, count: 1, overdueCount: 1, complete: false });
    expect(await openInvoiceFacts('cust-1')).toEqual({
      balance: null, count: null, overdue: false, complete: false, unavailable: true,
    });

    mockOpenBalanceSummary.mockResolvedValue(null);
    expect(await openInvoiceFacts('cust-1')).toEqual({
      balance: null, count: null, overdue: false, complete: false, unavailable: true,
    });
  });
});
