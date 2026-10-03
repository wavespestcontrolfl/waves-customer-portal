/**
 * Admin duplicates routes x GATE_DUPLICATES_SAME_ADDRESS (owner ruling
 * 2026-10-03). Gate off: the list response, the merge path and every refusal
 * are exactly today's. Gate on: GET / also carries `sameAddressGroups`, and
 * POST /merge | /link-as-property accept kind 'same_address' for those pairs.
 * Technicians are refused by the router-level requireAdmin (the REAL one).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// adminAuthenticate is stubbed to read the role from a header; requireAdmin is the real middleware.
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    adminAuthenticate: (req, _res, next) => {
      req.techRole = req.headers['x-role'];
      req.technicianId = 'staff-1';
      req.technician = { id: 'staff-1', name: 'Staff' };
      next();
    },
    requireAdmin: actual.requireAdmin,
  };
});
const mockFindGroups = jest.fn();
const mockFindSameAddress = jest.fn();
const mockEligibility = jest.fn();
const mockExecuteMerge = jest.fn();
jest.mock('../services/customer-dedupe', () => ({
  acquirePairAdjudicationLock: jest.fn(async () => undefined),
  findDuplicateGroups: (...a) => mockFindGroups(...a),
  findSameAddressGroups: (...a) => mockFindSameAddress(...a),
  SAME_ADDRESS_KIND: 'same_address',
  duplicatePairEligibility: (...a) => mockEligibility(...a),
  executeMerge: (...a) => mockExecuteMerge(...a),
  revertMerge: jest.fn(),
  recordLinkedProperty: jest.fn(),
  REVERT_FINANCIAL_TABLES: new Set(),
  CONSENT_CRITICAL_TABLES: new Set(),
  countActivityRows: jest.fn(),
  activityColumnsFor: jest.fn(),
  UNDO_MERGE_DISMISSAL_REASON: 'undo_merge',
}));

const router = require('../routes/admin-customer-duplicates');

function call(method, url, { role = 'admin', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method: method.toUpperCase(), url, originalUrl: url, headers: { 'x-role': role }, body, query: {}, params: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      setHeader() {}, getHeader() {}, end() { resolve({ status: this.statusCode, body: undefined }); },
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: 'fell through' })));
  });
}

const W = '10000000-0000-4000-8000-000000000001';
const L = '10000000-0000-4000-8000-000000000002';
const phoneGroup = { phone10: '9415550100', winner: { id: W }, candidates: [{ loser: { id: L }, tier: 'yellow', reasons: ['name_conflict'], evidence: { phone10: '9415550100' } }] };
const sameAddressGroup = {
  kind: 'same_address', phone10: null, winner: { id: W, phone: '+19415550101', upcoming_visits: 1 },
  candidates: [{ loser: { id: L, phone: '+19415550102', upcoming_visits: 0 }, tier: 'yellow', reasons: ['same_address_different_phone'], evidence: { kind: 'same_address' } }],
};

const savedGate = process.env.GATE_DUPLICATES_SAME_ADDRESS;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DUPLICATES_SAME_ADDRESS;
  mockFindGroups.mockResolvedValue([phoneGroup]);
  mockFindSameAddress.mockResolvedValue([sameAddressGroup]);
  mockEligibility.mockResolvedValue({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: [] } });
  mockExecuteMerge.mockResolvedValue({ journalId: 'j1', repointed: {}, backfills: {}, loserSnapshot: {}, phoneCarry: { status: 'carried', slot: 1, phone_key: '9415550102' } });
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_DUPLICATES_SAME_ADDRESS;
  else process.env.GATE_DUPLICATES_SAME_ADDRESS = savedGate;
});

const TODAY_LIST = {
  groups: [{
    phone10: '9415550100', winner: { id: W },
    candidates: [{ customer: { id: L }, tier: 'yellow', reasons: ['name_conflict'], evidence: { phone10: '9415550100' } }],
  }],
};

describe('gate off (the default and any non-"true" value): byte-identical to today', () => {
  test.each([[undefined], ['false'], ['1'], ['TRUE'], ['']])('GET / with GATE=%p is exactly today\'s payload and never reads the new queue', async (value) => {
    if (value !== undefined) process.env.GATE_DUPLICATES_SAME_ADDRESS = value;
    const res = await call('get', '/');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toBe(JSON.stringify(TODAY_LIST));
    expect(mockFindSameAddress).not.toHaveBeenCalled();
  });

  test('POST /merge naming kind same_address is treated as an ordinary phone-queue merge: same eligibility call, same executor args, same response keys', async () => {
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_address' } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L);
    expect(mockEligibility.mock.calls[0]).toHaveLength(2);
    const args = mockExecuteMerge.mock.calls[0][0];
    expect(args).not.toHaveProperty('pairKind');
    expect(args.evidence).toEqual({ via: 'admin_review_queue' });
    expect(Object.keys(res.body).sort()).toEqual(['backfills', 'journalId', 'ok', 'propertyLinked', 'repointed']);
  });

  test('a same-address pair is refused as not in the queue when the gate is off', async () => {
    mockEligibility.mockResolvedValueOnce({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_address' } });
    expect(res.status).toBe(409);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_DUPLICATES_SAME_ADDRESS = 'true'; });

  test('GET / keeps the phone groups untouched and adds the same-address section', async () => {
    const res = await call('get', '/');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual(TODAY_LIST.groups);
    expect(res.body.sameAddressGroups).toEqual([{
      kind: 'same_address',
      winner: sameAddressGroup.winner,
      candidates: [{ customer: sameAddressGroup.candidates[0].loser, tier: 'yellow', reasons: ['same_address_different_phone'], evidence: { kind: 'same_address' } }],
    }]);
    expect(res.body).not.toHaveProperty('sameAddressError');
  });

  test('a failure reading the new queue leaves the phone queue intact and flags the section', async () => {
    mockFindSameAddress.mockRejectedValueOnce(new Error('boom'));
    const res = await call('get', '/');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual(TODAY_LIST.groups);
    expect(res.body.sameAddressGroups).toEqual([]);
    expect(res.body.sameAddressError).toMatch(/same-address/i);
  });

  test('POST /merge kind same_address rechecks the same-address queue, merges as that kind, and returns the phone carry', async () => {
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_address' } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L, undefined, { kind: 'same_address' });
    const args = mockExecuteMerge.mock.calls[0][0];
    expect(args).toMatchObject({ pairKind: 'same_address', requireQueueEligibility: true, mode: 'manual' });
    expect(args.evidence).toEqual({ via: 'admin_review_queue', kind: 'same_address' });
    expect(res.body.phoneCarry).toEqual({ status: 'carried', slot: 1, phone_key: '9415550102' });
  });

  test('POST /merge without a kind still uses the phone queue', async () => {
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L);
    expect(mockExecuteMerge.mock.calls[0][0]).not.toHaveProperty('pairKind');
    expect(res.body).not.toHaveProperty('phoneCarry');
  });

  test('a same-address pair that is no longer in its queue is refused and never reaches the executor', async () => {
    mockEligibility.mockResolvedValueOnce({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_address' } });
    expect(res.status).toBe(409);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });
});

describe('technicians cannot read or act on any of it (router-level requireAdmin)', () => {
  test.each([['on', 'true'], ['off', undefined]])('gate %s: every duplicates route answers 403 to a technician and reads nothing', async (_label, gate) => {
    if (gate) process.env.GATE_DUPLICATES_SAME_ADDRESS = gate;
    for (const [method, url, body] of [
      ['get', '/'], ['post', '/merge', { winnerId: W, loserId: L, kind: 'same_address' }],
      ['post', '/link-as-property', { winnerId: W, loserId: L, kind: 'same_address' }],
      ['post', '/dismiss', { customerIdA: W, customerIdB: L }],
    ]) {
      const res = await call(method, url, { role: 'technician', body });
      expect(res.status).toBe(403);
    }
    expect(mockFindGroups).not.toHaveBeenCalled();
    expect(mockFindSameAddress).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });
});
