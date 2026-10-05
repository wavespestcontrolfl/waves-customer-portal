/**
 * Admin duplicates routes x GATE_DUPLICATES_SAME_NAME. Gate off: the list
 * response, the merge path and every refusal are exactly today's. Gate on:
 * GET / also carries `sameNameGroups`, and POST /merge | /link-as-property
 * accept kind 'same_name' for those pairs. Technicians are refused by the
 * router-level requireAdmin (the REAL one).
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
const mockFindSameName = jest.fn();
const mockEligibility = jest.fn();
const mockExecuteMerge = jest.fn();
jest.mock('../services/customer-dedupe', () => ({
  acquirePairAdjudicationLock: jest.fn(async () => undefined),
  findDuplicateGroups: (...a) => mockFindGroups(...a),
  findSameAddressGroups: (...a) => mockFindSameAddress(...a),
  findSameNameGroups: (...a) => mockFindSameName(...a),
  SAME_ADDRESS_KIND: 'same_address',
  SAME_NAME_KIND: 'same_name',
  duplicatePairEligibility: (...a) => mockEligibility(...a),
  executeMerge: (...a) => mockExecuteMerge(...a),
  revertMerge: jest.fn(),
  recordLinkedProperty: jest.fn(async () => undefined),
  REVERT_FINANCIAL_TABLES: new Set(),
  CONSENT_CRITICAL_TABLES: new Set(),
  countActivityRows: jest.fn(),
  activityColumnsFor: jest.fn(),
  UNDO_MERGE_DISMISSAL_REASON: 'undo_merge',
}));
const mockRecordCallProperty = jest.fn();
jest.mock('../services/customer-properties', () => ({
  recordCallProperty: (...a) => mockRecordCallProperty(...a),
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

const W = '20000000-0000-4000-8000-000000000001';
const L = '20000000-0000-4000-8000-000000000002';
const phoneGroup = { phone10: '9415550100', winner: { id: W }, candidates: [{ loser: { id: L }, tier: 'yellow', reasons: ['name_conflict'], evidence: { phone10: '9415550100' } }] };
const sameNameGroup = {
  kind: 'same_name', phone10: null, winner: { id: W, phone: '+19415550101', upcoming_visits: 1 },
  candidates: [{ loser: { id: L, phone: '+19415550102', upcoming_visits: 0 }, tier: 'yellow', reasons: ['same_name_different_phone', 'address_conflict'], evidence: { kind: 'same_name' } }],
};

const savedName = process.env.GATE_DUPLICATES_SAME_NAME;
const savedAddress = process.env.GATE_DUPLICATES_SAME_ADDRESS;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DUPLICATES_SAME_NAME;
  delete process.env.GATE_DUPLICATES_SAME_ADDRESS;
  mockFindGroups.mockResolvedValue([phoneGroup]);
  mockFindSameAddress.mockResolvedValue([]);
  mockFindSameName.mockResolvedValue([sameNameGroup]);
  mockEligibility.mockResolvedValue({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: [] } });
  mockExecuteMerge.mockResolvedValue({
    journalId: 'j1', repointed: {}, backfills: {},
    loserSnapshot: { address_line1: '2 Sample Way', city: 'Sarasota', zip: '34231' },
    phoneCarry: { status: 'carried', slot: 1, phone_key: '9415550102' },
  });
  mockRecordCallProperty.mockResolvedValue({ created: true, propertyId: 'p1' });
});
afterAll(() => {
  for (const [name, value] of [['GATE_DUPLICATES_SAME_NAME', savedName], ['GATE_DUPLICATES_SAME_ADDRESS', savedAddress]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const TODAY_LIST = {
  groups: [{
    phone10: '9415550100', winner: { id: W },
    candidates: [{ customer: { id: L }, tier: 'yellow', reasons: ['name_conflict'], evidence: { phone10: '9415550100' } }],
  }],
};

describe('gate off (the default and any non-"true" value): byte-identical to today', () => {
  test.each([[undefined], ['false'], ['1'], ['TRUE'], ['']])('GET / with GATE=%p is exactly today\'s payload and never reads the new queue', async (value) => {
    if (value !== undefined) process.env.GATE_DUPLICATES_SAME_NAME = value;
    const res = await call('get', '/');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toBe(JSON.stringify(TODAY_LIST));
    expect(mockFindSameName).not.toHaveBeenCalled();
  });

  test.each([['/merge'], ['/link-as-property']])('POST %s naming kind same_name is an ordinary phone-queue request: same eligibility call, same executor args, same response keys', async (url) => {
    const res = await call('post', url, { body: { winnerId: W, loserId: L, kind: 'same_name' } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L);
    expect(mockEligibility.mock.calls[0]).toHaveLength(2);
    const args = mockExecuteMerge.mock.calls[0][0];
    expect(args).not.toHaveProperty('pairKind');
    expect(args.evidence).toEqual({ via: url === '/merge' ? 'admin_review_queue' : 'admin_link_as_property' });
    expect(Object.keys(res.body)).not.toContain('phoneCarry');
  });

  test('a same-name pair is refused as not in the queue when the gate is off (the phone queue does not list it)', async () => {
    mockEligibility.mockResolvedValueOnce({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_name' } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Pair is no longer in the duplicate queue — refresh and retry' });
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('the same-address gate alone does not open the same-name kind', async () => {
    process.env.GATE_DUPLICATES_SAME_ADDRESS = 'true';
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_name' } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L);
    expect(mockExecuteMerge.mock.calls[0][0]).not.toHaveProperty('pairKind');
    const list = await call('get', '/');
    expect(list.body).not.toHaveProperty('sameNameGroups');
    expect(mockFindSameName).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_DUPLICATES_SAME_NAME = 'true'; });

  test('GET / keeps the phone groups untouched and adds the same-name section', async () => {
    const res = await call('get', '/');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual(TODAY_LIST.groups);
    expect(res.body.sameNameGroups).toEqual([{
      kind: 'same_name',
      winner: sameNameGroup.winner,
      candidates: [{ customer: sameNameGroup.candidates[0].loser, tier: 'yellow', reasons: ['same_name_different_phone', 'address_conflict'], evidence: { kind: 'same_name' } }],
    }]);
    expect(res.body).not.toHaveProperty('sameNameError');
    expect(res.body).not.toHaveProperty('sameAddressGroups');
  });

  test('both review sections can be on at once, each from its own queue', async () => {
    process.env.GATE_DUPLICATES_SAME_ADDRESS = 'true';
    const res = await call('get', '/');
    expect(res.body.sameAddressGroups).toEqual([]);
    expect(res.body.sameNameGroups).toHaveLength(1);
  });

  test('a failure reading the new queue leaves the phone queue intact and flags the section', async () => {
    mockFindSameName.mockRejectedValueOnce(new Error('boom'));
    const res = await call('get', '/');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual(TODAY_LIST.groups);
    expect(res.body.sameNameGroups).toEqual([]);
    expect(res.body.sameNameError).toMatch(/same-name/i);
  });

  test('POST /merge kind same_name rechecks the same-name queue, merges as that kind, and returns the phone carry', async () => {
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_name' } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L, undefined, { kind: 'same_name' });
    const args = mockExecuteMerge.mock.calls[0][0];
    expect(args).toMatchObject({ pairKind: 'same_name', requireQueueEligibility: true, mode: 'manual', allowAddressConflict: false });
    expect(args.evidence).toEqual({ via: 'admin_review_queue', kind: 'same_name' });
    expect(res.body.phoneCarry).toEqual({ status: 'carried', slot: 1, phone_key: '9415550102' });
    expect(res.body.propertyLinked).toBe(false);
    expect(mockRecordCallProperty).not.toHaveBeenCalled();
  });

  test('POST /link-as-property kind same_name merges as that kind and saves the other address as a second property', async () => {
    const res = await call('post', '/link-as-property', { body: { winnerId: W, loserId: L, kind: 'same_name' } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L, undefined, { kind: 'same_name' });
    const args = mockExecuteMerge.mock.calls[0][0];
    expect(args).toMatchObject({ pairKind: 'same_name', requireQueueEligibility: true, allowAddressConflict: true });
    expect(args.evidence).toEqual({ via: 'admin_link_as_property', kind: 'same_name' });
    expect(mockRecordCallProperty).toHaveBeenCalledWith(expect.objectContaining({ customerId: W, address_line1: '2 Sample Way' }));
    expect(res.body).toMatchObject({ ok: true, propertyLinked: true, phoneCarry: { status: 'carried' } });
  });

  test('POST /merge without a kind still uses the phone queue', async () => {
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L } });
    expect(res.status).toBe(200);
    expect(mockEligibility).toHaveBeenCalledWith(W, L);
    expect(mockExecuteMerge.mock.calls[0][0]).not.toHaveProperty('pairKind');
    expect(res.body).not.toHaveProperty('phoneCarry');
  });

  test.each([
    ['not_in_queue', 409], ['red_pair', 409], ['dismissals_unreadable', 503],
  ])('a same-name pair the recheck answers %s is refused (%i) and never reaches the executor', async (code, status) => {
    mockEligibility.mockResolvedValueOnce({ eligible: false, code, reason: `refused: ${code}`, candidate: null });
    const res = await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_name' } });
    expect(res.status).toBe(status);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('the executor\'s own refusals (two Stripe profiles, two payers, a changed pair) stay 409s', async () => {
    mockExecuteMerge.mockRejectedValueOnce(new Error('executeMerge: both customers have a Stripe profile — resolve in Stripe first'));
    expect((await call('post', '/merge', { body: { winnerId: W, loserId: L, kind: 'same_name' } })).status).toBe(409);
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the pair is no longer mergeable (not_in_queue) — review a fresh proposal'), { previewChanged: true }));
    expect((await call('post', '/link-as-property', { body: { winnerId: W, loserId: L, kind: 'same_name' } })).status).toBe(409);
  });
});

describe('technicians cannot read or act on any of it (router-level requireAdmin)', () => {
  test.each([['on', 'true'], ['off', undefined]])('gate %s: every duplicates route answers 403 to a technician and reads nothing', async (_label, gate) => {
    if (gate) process.env.GATE_DUPLICATES_SAME_NAME = gate;
    for (const [method, url, body] of [
      ['get', '/'], ['post', '/merge', { winnerId: W, loserId: L, kind: 'same_name' }],
      ['post', '/link-as-property', { winnerId: W, loserId: L, kind: 'same_name' }],
      ['post', '/dismiss', { customerIdA: W, customerIdB: L }],
    ]) {
      const res = await call(method, url, { role: 'technician', body });
      expect(res.status).toBe(403);
    }
    expect(mockFindGroups).not.toHaveBeenCalled();
    expect(mockFindSameName).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });
});
