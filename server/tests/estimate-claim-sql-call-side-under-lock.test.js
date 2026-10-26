// callSideBlockedUnderLock (utils/estimate-claim-sql.js): the call-side verdict a public write re-runs inside its own
// transaction and holds through the write (the commercial first visit and the estimate assessment bookings). Steps,
// in order: the estimate-side linkage markers, the linked lead locked, the call row locked with the stale-linkage
// check, then the call verdict on that row. Any block, and a verdict it cannot read, refuses (fail closed).

jest.mock('../models/db', () => jest.fn());
const mockStaleLinkage = jest.fn();
jest.mock('../services/admin-estimate-persistence', () => ({ staleCallLinkageReason: (...args) => mockStaleLinkage(...args) }));

const { callSideBlockedUnderLock } = require('../utils/estimate-claim-sql');

const LINKED = { lead_id: 'lead-1', lead_linkage: 'sid', estimatorEngine: { callLogId: 'call-1' } };

// A transaction stub: records every table read in order, answers call_log with `callRow` (or throws).
// A settled call (processed, no claim token) whose sid resolves to the linked lead: clear.
const SETTLED_CALL = { id: 'call-1', twilio_call_sid: 'CA-sample', metadata: {}, processing_status: 'processed', processing_token: null };
function fakeTrx({ callRow = SETTLED_CALL, callThrows = false } = {}) {
  const reads = [];
  const trx = jest.fn((table) => {
    const q = { table, locked: false };
    reads.push(q);
    const self = {
      where: jest.fn(() => self),
      whereNull: jest.fn(() => self),
      orderBy: jest.fn(() => self),
      forUpdate: jest.fn(() => { q.locked = true; return self; }),
      first: jest.fn(async () => {
        if (table === 'call_log') {
          if (callThrows) throw new Error('boom');
          return callRow;
        }
        return table === 'leads' ? { id: 'lead-1' } : undefined;
      }),
    };
    return self;
  });
  return { trx, reads };
}

beforeEach(() => {
  mockStaleLinkage.mockReset().mockResolvedValue(null);
});

test('an estimate-side linkage marker blocks before any lead or call read', async () => {
  const { trx } = fakeTrx();
  const row = { status: 'sent', estimate_data: { ...LINKED, estimatorEngine: { callLogId: 'call-1', linkage_invalidated_at: '2026-10-26T12:00:00Z' } } };
  expect(await callSideBlockedUnderLock(trx, row)).toBe(true);
  expect(trx).not.toHaveBeenCalled();
  expect(mockStaleLinkage).not.toHaveBeenCalled();
});

test('the order holds the verdict: the linked lead locked, then the call row locked in the stale-linkage check', async () => {
  const { trx, reads } = fakeTrx();
  const order = [];
  mockStaleLinkage.mockImplementation(async (conn, data, opts) => { order.push(['stale', opts.lockCallRow]); return null; });
  trx.mockImplementationOnce((table) => { order.push(['lock', table]); return fakeTrx().trx(table); });
  const row = { status: 'sent', estimate_data: JSON.stringify(LINKED) };
  expect(await callSideBlockedUnderLock(trx, row)).toBe(false);
  expect(order[0]).toEqual(['lock', 'leads']);
  expect(order[1]).toEqual(['stale', true]);
  expect(mockStaleLinkage).toHaveBeenCalledWith(trx, expect.objectContaining({ lead_id: 'lead-1' }), expect.objectContaining({ lockCallRow: true, estimateStatus: 'sent' }));
  expect(reads.some((q) => q.table === 'call_log')).toBe(true);
});

test('a stale call linkage blocks', async () => {
  mockStaleLinkage.mockResolvedValue('call_linkage_changed');
  const { trx } = fakeTrx();
  expect(await callSideBlockedUnderLock(trx, { status: 'sent', estimate_data: LINKED })).toBe(true);
});

test('a call verdict it cannot read blocks (fail closed)', async () => {
  const { trx } = fakeTrx({ callThrows: true });
  expect(await callSideBlockedUnderLock(trx, { status: 'sent', estimate_data: LINKED })).toBe(true);
});

test('an estimate with no call behind it is clear, with no lead lock', async () => {
  const { trx, reads } = fakeTrx();
  expect(await callSideBlockedUnderLock(trx, { status: 'sent', estimate_data: {} })).toBe(false);
  expect(reads.some((q) => q.table === 'leads')).toBe(false);
});
