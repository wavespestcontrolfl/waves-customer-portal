/**
 * Codex round-39 P1 (PR #5331): ONE live payer-ownership verdict shared by the pay page's Zelle visibility check
 * (routes/pay-v2 zellePayerOwnership) and the SMS invoice-status facts (context-aggregator).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockResolve = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolve(...a) }));

const { invoicePayerOwnership, liveInvoiceOwnership } = require('../services/invoice-payer-ownership');

beforeEach(() => { mockResolve.mockReset(); mockResolve.mockResolvedValue({ payerId: null }); });

describe('invoicePayerOwnership', () => {
  test('stamped payer_id / payer_statement_id => payer_owned with no lookup', async () => {
    expect(await invoicePayerOwnership({ id: 'i', customer_id: 'c', payer_id: 7 })).toBe('payer_owned');
    expect(await invoicePayerOwnership({ id: 'i', customer_id: 'c', payer_statement_id: 's' })).toBe('payer_owned');
    expect(mockResolve).not.toHaveBeenCalled();
  });
  test('no customer => unverifiable; resolver failure => unverifiable; live payer => payer_owned; none => null', async () => {
    expect(await invoicePayerOwnership({ id: 'i' })).toBe('payer_unverifiable');
    mockResolve.mockRejectedValueOnce(new Error('down'));
    expect(await invoicePayerOwnership({ id: 'i', customer_id: 'c' })).toBe('payer_unverifiable');
    mockResolve.mockResolvedValueOnce({ payerId: 'p1' });
    expect(await invoicePayerOwnership({ id: 'i', customer_id: 'c', scheduled_service_id: 's1' })).toBe('payer_owned');
    expect(mockResolve).toHaveBeenLastCalledWith(expect.objectContaining({ customerId: 'c', scheduledServiceId: 's1', throwOnError: true }));
    expect(await invoicePayerOwnership({ id: 'i', customer_id: 'c' })).toBeNull();
  });
});

describe('liveInvoiceOwnership', () => {
  test('collects payer-owned ids, flags unverifiable, memoizes per scheduled service, and stops at ownLimit', async () => {
    mockResolve.mockImplementation(async ({ scheduledServiceId }) => ({ payerId: scheduledServiceId === 'ap' ? 'p' : null }));
    const rows = [{ id: 'a', scheduled_service_id: 'ap' }, { id: 'b', scheduled_service_id: 'ap' }, { id: 'c', scheduled_service_id: 'own' }, { id: 'd', scheduled_service_id: 'own' }, { id: 'e', scheduled_service_id: 'ap' }];
    const out = await liveInvoiceOwnership('c1', rows);
    expect([...out.ownedIds].sort()).toEqual(['a', 'b', 'e']);
    expect(out.unverifiable).toBe(false);
    expect(mockResolve).toHaveBeenCalledTimes(2);
    mockResolve.mockClear();
    const limited = await liveInvoiceOwnership('c1', rows, undefined, { ownLimit: 1 });
    expect([...limited.ownedIds].sort()).toEqual(['a', 'b']); // stopped after the first self-pay row (c); d / e left unjudged
  });
  test('any unverifiable row marks the batch unverifiable', async () => {
    mockResolve.mockRejectedValue(new Error('down'));
    expect((await liveInvoiceOwnership('c1', [{ id: 'a' }])).unverifiable).toBe(true);
  });
});
