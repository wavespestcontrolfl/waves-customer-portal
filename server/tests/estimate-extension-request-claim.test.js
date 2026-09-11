jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async (run) => run(db));
  db.raw = jest.fn((sql) => ({ sql }));
  db.fn = { now: () => 'NOW()' };
  return db;
});
jest.mock('../services/estimate-extension', () => ({ fixedBidBlocksExtension: jest.fn(async () => false), extendEstimate: jest.fn() }));

const db = require('../models/db');
const { fixedBidBlocksExtension } = require('../services/estimate-extension');
const { claimNotifyOnlyExtensionRequest } = require('../routes/estimate-public');

function table(row, updated = 1) {
  const b = {};
  for (const m of ['where', 'whereRaw', 'orWhere', 'whereNull']) b[m] = jest.fn((k) => { if (typeof k === 'function') k(b); return b; });
  b.first = jest.fn(async () => row);
  b.update = jest.fn(async () => updated);
  return b;
}
const dedupe = (b) => b.whereNull('extension_requested_at');

describe('notify-only extension claim (GH codex P1 r5 on #4309)', () => {
  beforeEach(() => { jest.clearAllMocks(); fixedBidBlocksExtension.mockResolvedValue(false); });
  test('a grouped row takes the group lock, re-judges the CURRENT group, and only then burns the dedupe window', async () => {
    const b = table({ id: 'e1', estimate_group_id: 'g1', estimate_data: {} });
    db.mockReturnValue(b);
    await expect(claimNotifyOnlyExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 1, blocked: false });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), ['estimate-group-send', 'g1']);
    expect(fixedBidBlocksExtension).toHaveBeenCalledWith(db, expect.objectContaining({ estimate_group_id: 'g1' }));
    expect(b.update).toHaveBeenCalledWith({ extension_requested_at: 'NOW()' });
  });
  test('a fixed hold that appeared since the preflight blocks BEFORE the claim — nothing is burned, the answer is the generic 404', async () => {
    const b = table({ id: 'e1', estimate_group_id: 'g1', estimate_data: {} });
    db.mockReturnValue(b);
    fixedBidBlocksExtension.mockResolvedValue(true);
    await expect(claimNotifyOnlyExtensionRequest('e1', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
    expect(b.update).not.toHaveBeenCalled();
  });
  test('an ungrouped row takes no group lock; a lost dedupe race is a plain zero, not a block', async () => {
    const b = table({ id: 'e2', estimate_group_id: null, estimate_data: {} }, 0);
    db.mockReturnValue(b);
    await expect(claimNotifyOnlyExtensionRequest('e2', dedupe)).resolves.toEqual({ claimed: 0, blocked: false });
    expect(db.raw).not.toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), expect.anything());
  });
  test('a row that vanished is a block', async () => {
    db.mockReturnValue(table(null));
    await expect(claimNotifyOnlyExtensionRequest('gone', dedupe)).resolves.toEqual({ claimed: 0, blocked: true });
  });
});
