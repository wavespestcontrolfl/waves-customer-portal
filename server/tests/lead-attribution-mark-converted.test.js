// markConverted's claim (codex #3834 r11 P1, r18 P1) and the repeat's funnel
// row (r14 P2, r18 P1): the status write is conditional on the status AND
// identity the caller read, and a repeat's booked row is part of the
// conversion write — so a preview stub that swaps markConverted out swaps
// the row out with it.
let mockUpdateRows = 1;
let mockFirstRow = null;
const mockCalls = [];
jest.mock('../models/db', () => {
  const db = (table) => {
    const q = {
      where: (...a) => { mockCalls.push([table, 'where', ...a]); return q; },
      whereNull: (...a) => { mockCalls.push([table, 'whereNull', ...a]); return q; },
      whereIn: (...a) => { mockCalls.push([table, 'whereIn', ...a]); return q; },
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
  findWizardRepeatRow: jest.fn(async () => mockRepeatRow),
}));

const db = require('../models/db');
const { bridgeLeadFunnelStage, stampLeadFunnelRow } = require('../services/lead-funnel-bridge');
const { markConverted } = require('../services/lead-attribution');
// The claim = every leads predicate chained before the status UPDATE (the
// estimate→customer backfill re-reads the row afterwards).
const claimCalls = () => mockCalls.slice(0, mockCalls.findIndex((c) => c[1] === 'update')).filter((c) => c[0] === 'leads');

describe('markConverted claims', () => {
  beforeEach(() => { mockCalls.length = 0; mockUpdateRows = 1; mockFirstRow = null; mockRepeatRow = null; jest.clearAllMocks(); });

  test('a win the bridge lands on no row (a repeat converted by hand after /calculate dropped its row) rebuilds the booked row from the lead itself (codex r22 P2)', async () => {
    mockRepeatRow = { id: 'lead-manual', status: 'won', customer_id: 'c1', lead_type: 'quote_wizard', extracted_data: { duplicate_of_lead_id: 'lead-root' }, first_contact_at: '2026-09-01T12:00:00Z' };
    const ok = await markConverted('lead-manual', { customerId: 'c1' });
    expect(ok).toBe(true);
    expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('lead-manual', 'won');
    expect(stampLeadFunnelRow).toHaveBeenCalledWith(db, mockRepeatRow, { customerId: 'c1', funnelStage: 'booked' });
  });

  test('a non-repeat with no funnel row is left alone — an inbound call on the Ads bridge number keeps its slot for the delayed paid-call bridge (codex r24 P1)', async () => {
    mockRepeatRow = null; // findWizardRepeatRow: not a quote_wizard row with a marker
    await markConverted('lead-call', { customerId: 'c1' });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('a win the bridge DID land needs no rebuilt row', async () => {
    bridgeLeadFunnelStage.mockResolvedValueOnce({ updated: 1, stage: 'booked' });
    await markConverted('lead-bridged', { customerId: 'c1' });
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

  test('a lost claim (0 rows) converts nothing — no bridge, no funnel row, no activity', async () => {
    mockUpdateRows = 0;
    const repeat = { id: 'lead-rep', customer_id: 'c1' };
    const ok = await markConverted('lead-rep', { customerId: 'c1', onlyIfStatusIn: ['duplicate'], onlyIfIdentity: { customer_id: 'c1', phone: null, email: null }, funnelRowFor: repeat });
    expect(ok).toBe(false);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
    expect(mockCalls.some((c) => c[0] === 'lead_activities')).toBe(false);
  });

  test("funnelRowFor stamps the repeat's booked row inside the conversion write, after the bridge", async () => {
    const repeat = { id: 'lead-rep', customer_id: null, status: 'duplicate' };
    const ok = await markConverted('lead-rep', { customerId: 'c1', onlyIfStatusIn: ['duplicate'], funnelRowFor: repeat });
    expect(ok).toBe(true);
    expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('lead-rep', 'won');
    expect(stampLeadFunnelRow).toHaveBeenCalledWith(db, repeat, { customerId: 'c1', funnelStage: 'booked' });
    expect(bridgeLeadFunnelStage.mock.invocationCallOrder[0]).toBeLessThan(stampLeadFunnelRow.mock.invocationCallOrder[0]);
  });

  test('without a claim or a funnel row the write is unconditional and stamps nothing', async () => {
    await markConverted('lead-2', { customerId: 'c1' });
    expect(claimCalls()).toEqual([
      ['leads', 'where', 'id', 'lead-2'],
      ['leads', 'whereNull', 'deleted_at'],
    ]);
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });
});
