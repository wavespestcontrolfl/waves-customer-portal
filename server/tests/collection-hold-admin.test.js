/** B10 C: staff can see and release a collections hold; release resumes charging. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockDbRow = { row: null, updates: [] };
const mockTrx = (table) => {
  if (table !== 'collections_flags') throw new Error(`unexpected table ${table}`);
  const qb = {
    where: () => qb,
    whereNull: () => qb,
    forUpdate: () => qb,
    first: async () => mockDbRow.row,
    update: async (patch) => { mockDbRow.updates.push(patch); return 1; },
  };
  return qb;
};
jest.mock('../models/db', () => {
  const db = (t) => mockTrx(t);
  db.transaction = async (fn) => fn(mockTrx);
  return db;
});
const mockActive = jest.fn();
const mockRelease = jest.fn();
jest.mock('../services/collections/outbound-voice/flags', () => ({
  activeFlags: (...a) => mockActive(...a), releaseFlag: (...a) => mockRelease(...a),
}));
const { listCollectionHolds, releaseCollectionHold } = require('../services/collections/collection-hold-admin');

test('lists only collection_hold rows and says which ones stop charges', async () => {
  mockActive.mockResolvedValue([
    { flag: 'pays_by_check', reason: 'x' },
    { id: 'hold-1', flag: 'collection_hold', reason: 'dispute on call: bill wrong', created_by: 'system:collections_voice', created_at: 't' },
    { flag: 'collection_hold', reason: 'wrong-party answer on billing follow-up call; review card failed to file' },
  ]);
  const holds = await listCollectionHolds('c-1');
  expect(holds).toHaveLength(2);
  expect(holds[0]).toMatchObject({ id: 'hold-1', stops_charges: true, reason: 'dispute on call: bill wrong' });
  expect(holds[1].stops_charges).toBe(false);
});

beforeEach(() => { mockDbRow.row = null; mockDbRow.updates = []; mockRelease.mockReset(); });

test('release goes through the one writer, only for collection_hold, and names the exact row', async () => {
  mockDbRow.row = { id: 'hold-1', reason: 'dispute on call: bill wrong' };
  mockRelease.mockResolvedValue({ ok: true, released: 1 });
  expect(await releaseCollectionHold('c-1', { holdId: 'hold-1' })).toEqual({ ok: true, released: 1 });
  expect(mockRelease).toHaveBeenCalledWith({ customerId: 'c-1', flag: 'collection_hold', id: 'hold-1', trx: mockTrx });
  expect(mockDbRow.updates).toEqual([]);
});

// Codex P1: after the dispute is released the SAME row stands as the fallback. A repeated
// request (or a second admin's stale holdId) must not lift it.
test('a repeated release of the same holdId finds a fallback row and releases nothing', async () => {
  mockDbRow.row = { id: 'hold-1', reason: 'wrong-party answer on billing follow-up call; review card failed to file' };
  expect(await releaseCollectionHold('c-1', { holdId: 'hold-1' })).toEqual({ ok: true, released: 0 });
  expect(mockRelease).not.toHaveBeenCalled();
  expect(mockDbRow.updates).toEqual([]);
});

test('a hold that is no longer active releases nothing (the caller reports a conflict)', async () => {
  mockDbRow.row = null;
  expect(await releaseCollectionHold('c-1', { holdId: 'hold-1' })).toEqual({ ok: true, released: 0 });
  expect(mockRelease).not.toHaveBeenCalled();
});

// A dispute raised on top of an active wrong-number / wrong-party fallback hold shares that
// row; releasing the dispute must put the fallback back, never lift the outreach block.
test.each([
  ['wrong-number', 'wrong-number report on billing follow-up call; wrong_number flag write failed'],
  ['wrong-party', 'wrong-party answer on billing follow-up call; review card failed to file'],
])('releasing a dispute over an active %s fallback restores the fallback and keeps the row active', async (_n, prior) => {
  const { embedPriorHoldReason } = require('../services/collections/collection-hold');
  mockDbRow.row = { id: 'hold-1', reason: embedPriorHoldReason('dispute on call: bill wrong', prior) };
  const out = await releaseCollectionHold('c-1', { holdId: 'hold-1' });
  expect(out).toEqual({ ok: true, released: 1, fallbackRestored: true });
  expect(mockRelease).not.toHaveBeenCalled(); // released_at is never stamped
  expect(mockDbRow.updates).toEqual([{ reason: prior }]);
});

test('a dispute over a reason-less active hold restores a reason-less active hold', async () => {
  const { embedPriorHoldReason } = require('../services/collections/collection-hold');
  mockDbRow.row = { id: 'hold-1', reason: embedPriorHoldReason('dispute raised on call', null) };
  expect(await releaseCollectionHold('c-1', { holdId: 'hold-1' })).toMatchObject({ released: 1, fallbackRestored: true });
  expect(mockDbRow.updates).toEqual([{ reason: null }]);
});

test('a failing read never reports a release', async () => {
  const db = require('../models/db');
  const orig = db.transaction;
  db.transaction = async () => { throw new Error('pg down'); };
  try {
    expect(await releaseCollectionHold('c-1', { holdId: 'hold-1' })).toEqual({ ok: false, reason: 'release_failed' });
  } finally { db.transaction = orig; }
});

test('a release with no hold id is refused before it reaches the writer', async () => {
  expect(await releaseCollectionHold('c-1')).toEqual({ ok: false, reason: 'hold_id_required' });
  expect(mockRelease).not.toHaveBeenCalled();
});

test('the routes are admin-only and audited', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-customers.js'), 'utf8');
  expect(src).toMatch(/router\.get\('\/:id\/collection-holds', requireAdmin/);
  expect(src).toMatch(/router\.post\('\/:id\/collection-holds\/release', requireAdmin/);
  expect(src).toMatch(/customer\.collection_hold_released/);
});

test('the hold routes sit above the property-address comment block, not between it and its handler', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-customers.js'), 'utf8');
  const holds = src.indexOf("router.get('/:id/collection-holds'");
  const release = src.indexOf("router.post('/:id/collection-holds/release'");
  const propsComment = src.indexOf('// GET /api/admin/customers/:id/properties');
  expect(holds).toBeGreaterThan(0);
  expect(release).toBeLessThan(propsComment);
  // the properties comment is followed by its own code, not by the hold routes
  expect(src.slice(propsComment, propsComment + 2500)).not.toMatch(/collection-holds/);
});

describe('prior-hold trailer (the one writer / one reader)', () => {
  const { embedPriorHoldReason, priorHoldReasonOf, withoutPriorHoldReason } = require('../services/collections/collection-hold');

  test('round trips, and a plain dispute or a fallback reads as no trailer', () => {
    const merged = embedPriorHoldReason('dispute on call: bill wrong', 'wrong-party answer on billing follow-up call');
    expect(merged).toBe('dispute on call: bill wrong [earlier hold: wrong-party answer on billing follow-up call]');
    expect(priorHoldReasonOf(merged)).toEqual({ prior: 'wrong-party answer on billing follow-up call' });
    expect(withoutPriorHoldReason(merged)).toBe('dispute on call: bill wrong');
    expect(priorHoldReasonOf('dispute raised on call')).toBeNull();
    expect(priorHoldReasonOf('wrong-party answer on billing follow-up call')).toBeNull();
    expect(priorHoldReasonOf(null)).toBeNull();
    expect(withoutPriorHoldReason('dispute raised on call')).toBe('dispute raised on call');
  });

  test('a summary that itself mentions the marker cannot hide or fake the fallback (the last trailer wins)', () => {
    const merged = embedPriorHoldReason('dispute on call: said [earlier hold: nothing] twice', 'wrong-number report');
    expect(priorHoldReasonOf(merged)).toEqual({ prior: 'wrong-number report' });
  });

  test('a long dispute summary is trimmed, the fallback text is kept whole', () => {
    const prior = 'wrong-number report on billing follow-up call; wrong_number flag write failed';
    const merged = embedPriorHoldReason(`dispute on call: ${'x'.repeat(2000)}`, prior);
    expect(priorHoldReasonOf(merged)).toEqual({ prior });
  });

  test('an empty prior reads as { prior: null }', () => {
    expect(priorHoldReasonOf(embedPriorHoldReason('dispute raised on call', ''))).toEqual({ prior: null });
  });
});
