// markConverted's claim (codex #3834 r11 P1, r18 P1) and the repeat's funnel
// row (r14 P2, r18 P1, r27 P1): the status write is conditional on the status
// AND identity the caller read, and where a repeat's win lands in the funnel
// is settled INSIDE the conversion write, after it — so a preview stub that
// swaps markConverted out swaps the row out with it.
let mockUpdateRows = 1;
let mockFirstRow = null;
const mockCalls = [];
jest.mock('../models/db', () => {
  const db = (table) => {
    const q = {
      where: (...a) => { mockCalls.push([table, 'where', ...a]); return q; },
      whereNull: (...a) => { mockCalls.push([table, 'whereNull', ...a]); return q; },
      whereIn: (...a) => { mockCalls.push([table, 'whereIn', ...a]); return q; },
      whereNot: (...a) => { mockCalls.push([table, 'whereNot', ...a]); return q; },
      orWhereIn: (...a) => { mockCalls.push([table, 'orWhereIn', ...a]); return q; },
      select: (...a) => { mockCalls.push([table, 'select', ...a]); return q; },
      whereNotExists: (sub) => { mockCalls.push([table, 'whereNotExists', sub]); return q; },
      update: async (patch) => { mockCalls.push([table, 'update', patch]); return mockUpdateRows; },
      insert: async (row) => { mockCalls.push([table, 'insert', row]); return [row]; },
      first: async () => mockFirstRow,
    };
    return q;
  };
  db.raw = (s) => ({ __raw: s });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadFunnelStage: jest.fn(async () => ({ updated: 0 })),
  stampLeadFunnelRow: jest.fn(async () => 'asa-1'),
}));
let mockRepeatRow = null;
jest.mock('../services/lead-estimate-link', () => ({
  linkLeadEstimatesToCustomer: jest.fn(async () => {}),
  settleRepeatFunnelRow: jest.fn(async () => mockRepeatRow),
}));

const db = require('../models/db');
const { bridgeLeadFunnelStage, stampLeadFunnelRow } = require('../services/lead-funnel-bridge');
const { settleRepeatFunnelRow } = require('../services/lead-estimate-link');
const { markConverted, settleWonFunnelRow } = require('../services/lead-attribution');
// The claim = every leads predicate chained before the status UPDATE (the
// estimate→customer backfill re-reads the row afterwards).
const claimCalls = () => mockCalls.slice(0, mockCalls.findIndex((c) => c[1] === 'update')).filter((c) => c[0] === 'leads');

describe('markConverted claims', () => {
  beforeEach(() => { mockCalls.length = 0; mockUpdateRows = 1; mockFirstRow = null; mockRepeatRow = null; jest.clearAllMocks(); });

  test('a win the bridge lands on no row is settled AFTER the conversion write (root re-read then); the settlement owns the rebuild — nothing is stamped here (codex r22 P2, r27 P1; pre-push P1 on 28489d7)', async () => {
    mockRepeatRow = null;
    const ok = await markConverted('lead-manual', { customerId: 'c1' });
    expect(ok).toBe(true);
    expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('lead-manual', 'won');
    expect(settleRepeatFunnelRow).toHaveBeenCalledWith(db, 'lead-manual', { customerId: 'c1', estimateId: null });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
    const statusWrite = mockCalls.findIndex((c) => c[1] === 'update');
    expect(statusWrite).toBeGreaterThanOrEqual(0);
    expect(bridgeLeadFunnelStage.mock.invocationCallOrder[0]).toBeLessThan(settleRepeatFunnelRow.mock.invocationCallOrder[0]);
  });

  test('an estimate-scoped conversion (deposit_paid / acceptance) hands the estimate to the settlement so a root linked to another estimate is never booked for it (pre-push P1 on 1ea5d47)', async () => {
    mockRepeatRow = null;
    await markConverted('lead-rep', { customerId: 'c1', estimateId: 'e-B' });
    expect(settleRepeatFunnelRow).toHaveBeenCalledWith(db, 'lead-rep', { customerId: 'c1', estimateId: 'e-B' });
  });

  test('an estimate-scoped conversion persists that scope on the won row (extracted_data.won_estimate_id, never the estimate_id FK) so a replay without an estimate settles the same way; an unscoped conversion writes no extracted_data (codex r37 P1)', async () => {
    await markConverted('lead-rep', { customerId: 'c1', estimateId: 'e-B' });
    const patch = mockCalls.find((c) => c[1] === 'update')[2];
    expect(patch.extracted_data).toEqual({ __raw: expect.stringContaining("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb") });
    expect(patch).not.toHaveProperty('estimate_id');
    mockCalls.length = 0;
    await markConverted('lead-rep', { customerId: 'c1' });
    expect(mockCalls.find((c) => c[1] === 'update')[2]).not.toHaveProperty('extracted_data');
  });

  test('a settled win (the root took it) or a non-repeat with no funnel row stamps nothing — an inbound call on the Ads bridge number keeps its slot for the delayed paid-call bridge (codex r24 P1, r27 P2)', async () => {
    mockRepeatRow = null; // settleRepeatFunnelRow: root bridged, or not a quote_wizard row with a marker
    await markConverted('lead-call', { customerId: 'c1' });
    expect(settleRepeatFunnelRow).toHaveBeenCalledWith(db, 'lead-call', { customerId: 'c1', estimateId: null });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('a settlement read that fails is best-effort — the conversion still completes with its activity (codex r28 P2)', async () => {
    settleRepeatFunnelRow.mockRejectedValueOnce(new Error('db boom'));
    const ok = await markConverted('lead-flaky', { customerId: 'c1' });
    expect(ok).toBe(true);
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
    expect(mockCalls.some((c) => c[0] === 'lead_activities')).toBe(true);
  });

  test('settleWonFunnelRow is the shared won-funnel mechanism (the admin book route calls it post-commit): bridge, then settle; the bridge result is returned for callers that surface it (codex r32 P1, r34 P1)', async () => {
    mockRepeatRow = null;
    bridgeLeadFunnelStage.mockResolvedValueOnce({ reason: 'error' });
    await expect(settleWonFunnelRow('lead-booked', 'c1')).resolves.toEqual({ reason: 'error' });
    expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('lead-booked', 'won');
    expect(settleRepeatFunnelRow).toHaveBeenCalledWith(db, 'lead-booked', { customerId: 'c1', estimateId: null });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
    expect(mockCalls.some((c) => c[0] === 'leads' && c[1] === 'update')).toBe(false);
  });

  test('a win the bridge DID land is still settled — a row the repeat kept when /calculate\'s delete failed is reconciled against its root (codex r29 P2)', async () => {
    bridgeLeadFunnelStage.mockResolvedValueOnce({ updated: 1, stage: 'booked' });
    mockRepeatRow = null;
    await markConverted('lead-bridged', { customerId: 'c1' });
    expect(settleRepeatFunnelRow).toHaveBeenCalledWith(db, 'lead-bridged', { customerId: 'c1', estimateId: null });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('onlyIfStatusIn + onlyIfIdentity pin the status AND identity the caller read on the status write', async () => {
    const identity = { customer_id: null, phone: '9415550142', email: 'a@example.com' };
    const ok = await markConverted('lead-1', { customerId: 'c1', onlyIfStatusIn: ['new', 'contacted'], onlyIfIdentity: identity });
    expect(ok).toBe(true);
    expect(claimCalls()).toEqual([
      ['leads', 'where', 'id', 'lead-1'],
      ['leads', 'whereNull', 'deleted_at'],
      ['leads', 'whereIn', 'status', ['new', 'contacted']],
      ['leads', 'where', identity],
    ]);
    expect(mockCalls.find((c) => c[1] === 'update')[2]).toEqual(expect.objectContaining({ status: 'won', customer_id: 'c1' }));
  });

  test('onlyIfSoleLinkedRow makes the status write conditional on NO other live row of that estimate being open or won — in the same statement (codex #3883 r1 P1)', async () => {
    const ok = await markConverted('lead-dup', { customerId: 'c1', onlyIfStatusIn: ['duplicate'], onlyIfIdentity: { customer_id: 'c1' }, onlyIfSoleLinkedRow: 'estimate-1', estimateId: 'estimate-1' });
    expect(ok).toBe(true);
    const outer = claimCalls().filter((c) => c[1] !== 'select');
    expect(outer.slice(0, 4)).toEqual([
      ['leads', 'where', 'id', 'lead-dup'],
      ['leads', 'whereNull', 'deleted_at'],
      ['leads', 'whereIn', 'status', ['duplicate']],
      ['leads', 'where', { customer_id: 'c1' }],
    ]);
    // The subquery: other rows of this estimate, live, won or open.
    const sub = claimCalls().slice(claimCalls().findIndex((c) => c[1] === 'select') + 1);
    expect(sub.slice(0, 3)).toEqual([
      ['leads', 'where', 'estimate_id', 'estimate-1'],
      ['leads', 'whereNot', 'id', 'lead-dup'],
      ['leads', 'whereNull', 'deleted_at'],
    ]);
    const grouped = sub[3];
    expect(grouped[1]).toBe('where');
    const inner = [];
    const g = { where: (...a) => { inner.push(['where', ...a]); return g; }, orWhereIn: (...a) => { inner.push(['orWhereIn', ...a]); return g; } };
    grouped[2](g);
    expect(inner).toEqual([['where', 'status', 'won'], ['orWhereIn', 'status', ['new', 'contacted', 'estimate_sent', 'estimate_viewed']]]);
    expect(sub[4][1]).toBe('whereNotExists');
  });

  test('a lost claim (0 rows) converts nothing — no bridge, no settling, no funnel row, no activity', async () => {
    mockUpdateRows = 0;
    mockRepeatRow = { id: 'lead-rep', customer_id: 'c1' };
    const ok = await markConverted('lead-rep', { customerId: 'c1', onlyIfStatusIn: ['duplicate'], onlyIfIdentity: { customer_id: 'c1', phone: null, email: null } });
    expect(ok).toBe(false);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(settleRepeatFunnelRow).not.toHaveBeenCalled();
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
    expect(mockCalls.some((c) => c[0] === 'lead_activities')).toBe(false);
  });

  test('without a claim the write is unconditional', async () => {
    await markConverted('lead-2', { customerId: 'c1' });
    expect(claimCalls()).toEqual([
      ['leads', 'where', 'id', 'lead-2'],
      ['leads', 'whereNull', 'deleted_at'],
    ]);
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });
});
