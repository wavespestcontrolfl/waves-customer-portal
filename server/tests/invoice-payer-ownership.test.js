/**
 * Codex round-39 P1 (PR #5331): ONE live payer-ownership verdict shared by the pay page's Zelle visibility check
 * (routes/pay-v2 zellePayerOwnership) and the SMS invoice-status facts (context-aggregator).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockResolve = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolve(...a), scheduledServicesHasSelfPay: async () => true }));

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
  // Codex round-40 P1: rows that can feed the owed balance are judged however far down they sit; ownLimit only bounds the status LIST
  test('alwaysJudge rows are judged even after ownLimit is reached (the cap is for the display list, never the balance)', async () => {
    mockResolve.mockImplementation(async ({ scheduledServiceId }) => ({ payerId: scheduledServiceId === 'ap' ? 'p' : null }));
    const rows = [{ id: 'c', scheduled_service_id: 'own' }, { id: 'd', scheduled_service_id: 'own2' }, { id: 'e', scheduled_service_id: 'ap' }, { id: 'f', scheduled_service_id: 'ap2' }];
    const out = await liveInvoiceOwnership('c1', rows, undefined, { ownLimit: 1, alwaysJudge: (r) => r.id === 'e' || r.id === 'f' });
    expect([...out.ownedIds]).toEqual(['e']); // e resolves to the payer; f ('ap2') resolves to self-pay; d is skipped (unjudged)
    expect(mockResolve).toHaveBeenCalledTimes(3); // c, e, f - d skipped
  });
  test('any unverifiable row marks the batch unverifiable', async () => {
    mockResolve.mockRejectedValue(new Error('down'));
    expect((await liveInvoiceOwnership('c1', [{ id: 'a' }])).unverifiable).toBe(true);
  });
});

// Codex round-47 P2: a long monthly history (one scheduled service per visit) must not hit the lookup cap and lose billing
describe('liveInvoiceOwnership byCandidatePayer', () => {
  const fakeDb = ({ cust = { payer_id: null }, services = [], fail = false } = {}) => {
    const dbh = jest.fn((table) => {
      const q = { where: () => q, whereIn: () => q,
        first: async () => { if (fail) throw new Error('down'); return table === 'customers' ? cust : undefined; },
        select: async () => { if (fail) throw new Error('down'); return table === 'scheduled_services' ? services : []; } };
      return q;
    });
    return dbh;
  };
  const visits = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, scheduled_service_id: `ss${i}` }));
  test('200 self-pay visits: no resolver lookups, verifiable, nothing owned', async () => {
    const out = await liveInvoiceOwnership('c1', visits(200), fakeDb(), { maxResolutions: 30, byCandidatePayer: true });
    expect(out).toEqual({ ownedIds: new Set(), unverifiable: false });
    expect(mockResolve).not.toHaveBeenCalled();
  });
  test('a default payer on 200 visits: ONE lookup through the real resolver; a pinned self-pay visit stays the homeowner\'s', async () => {
    mockResolve.mockResolvedValue({ payerId: 'p9' });
    const services = [{ id: 'ss3', payer_id: null, self_pay_override: true }, { id: 'ss4', payer_id: 'p2' }];
    mockResolve.mockImplementation(async ({ scheduledServiceId }) => ({ payerId: scheduledServiceId === 'ss4' ? 'p2' : 'p9' }));
    const out = await liveInvoiceOwnership('c1', visits(200), fakeDb({ cust: { payer_id: 'p9' }, services }), { maxResolutions: 30, byCandidatePayer: true });
    expect(out.unverifiable).toBe(false);
    expect(out.ownedIds.has('i3')).toBe(false);
    expect(out.ownedIds.has('i4')).toBe(true);
    expect(out.ownedIds.size).toBe(199);
    expect(mockResolve).toHaveBeenCalledTimes(2); // p9 once, p2 once
  });
  test('an inactive candidate payer (resolver says self-pay) owns nothing', async () => {
    mockResolve.mockResolvedValue({ payerId: null });
    const out = await liveInvoiceOwnership('c1', visits(50), fakeDb({ cust: { payer_id: 'gone' } }), { maxResolutions: 30, byCandidatePayer: true });
    expect(out).toEqual({ ownedIds: new Set(), unverifiable: false });
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });
  test('a failed batched read is unverifiable', async () => {
    expect((await liveInvoiceOwnership('c1', visits(3), fakeDb({ fail: true }), { byCandidatePayer: true })).unverifiable).toBe(true);
  });
});
