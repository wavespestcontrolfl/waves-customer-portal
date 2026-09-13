/**
 * POST /merge and /link-as-property refuse on EVERY non-eligible answer from
 * duplicatePairEligibility — a merge decision never falls through a list of
 * known refusal codes to executeMerge (pre-push Codex P0: an unreadable
 * dismissals table answered dismissals_unreadable and reached the executor).
 * The one admitted exception: link-as-property proceeds on address_conflict,
 * because that path exists to keep the loser's address as a property row.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', name: 'Admin' }; req.technicianId = 'admin-1'; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
const mockEligibility = jest.fn();
const mockExecuteMerge = jest.fn();
const mockAcquirePairLock = jest.fn(async () => undefined);
jest.mock('../services/customer-dedupe', () => ({
  acquirePairAdjudicationLock: (...args) => mockAcquirePairLock(...args),
  findDuplicateGroups: jest.fn(),
  duplicatePairEligibility: (...args) => mockEligibility(...args),
  executeMerge: (...args) => mockExecuteMerge(...args),
  revertMerge: jest.fn(),
  recordLinkedProperty: jest.fn(),
  REVERT_FINANCIAL_TABLES: new Set(),
  CONSENT_CRITICAL_TABLES: new Set(),
  countActivityRows: jest.fn(),
  activityColumnsFor: jest.fn(),
}));

const router = require('../routes/admin-customer-duplicates');

// Handlers are invoked directly off the router stack (no supertest at root).
function handler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function post(routePath, body) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    handler('post', routePath)({ body, query: {}, technician: { id: 'admin-1', name: 'Admin' }, technicianId: 'admin-1' }, res, (err) => reject(err || new Error('next()')));
  });
}

const WINNER = '10000000-0000-4000-8000-000000000001';
const LOSER = '10000000-0000-4000-8000-000000000002';
const body = { winnerId: WINNER, loserId: LOSER };

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteMerge.mockResolvedValue({ journalId: 'j1', repointed: {}, backfills: {}, loserSnapshot: {} });
});

describe('merge eligibility gate', () => {
  test.each([
    ['not_in_queue', 409, /no longer in the duplicate queue/],
    ['red_pair', 409, /two different people/],
    ['address_conflict', 409, /Merge \+ keep address/],
    ['dismissals_unreadable', 503, /could not be read/],
    ['some_future_code', 409, /cannot be merged right now/],
  ])('/merge refuses %s (%s) and never reaches executeMerge', async (code, status, message) => {
    const reasons = {
      not_in_queue: 'Pair is no longer in the duplicate queue',
      red_pair: 'This pair looks like two different people and cannot be merged from the queue',
      address_conflict: "This duplicate has a different service address — use 'Merge + keep address' so the address isn't lost",
      dismissals_unreadable: 'Operator dismissal verdicts could not be read — refusing to treat this pair as mergeable right now',
      some_future_code: null,
    };
    mockEligibility.mockResolvedValueOnce({ eligible: false, code, reason: reasons[code], candidate: null });
    const res = await post('/merge', body);
    expect(res.status).toBe(status);
    expect(res.body.error).toMatch(message);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('/link-as-property proceeds on address_conflict (its whole purpose) but still refuses every other non-eligible code', async () => {
    mockEligibility.mockResolvedValueOnce({ eligible: false, code: 'address_conflict', reason: 'different address', candidate: { tier: 'yellow', reasons: ['address_conflict'] } });
    const ok = await post('/link-as-property', body);
    expect(ok.status).toBe(200);
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1);
    // The executor re-decides eligibility inside its transaction; it must be
    // told this caller admits address_conflict or it refuses what the gate
    // above just let through (pre-push Claude P1).
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ requireQueueEligibility: true, allowAddressConflict: true }));

    mockEligibility.mockResolvedValueOnce({ eligible: false, code: 'dismissals_unreadable', reason: 'Operator dismissal verdicts could not be read', candidate: null });
    const refused = await post('/link-as-property', body);
    expect(refused.status).toBe(503);
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1);
  });

  test('the executor\'s locked re-decision is an expected stale-queue race: 409, or 503 when the dismissal verdicts could not be read — never 500 (Codex r14 P2)', async () => {
    for (const [code, status] of [['not_in_queue', 409], ['red_pair', 409], ['dismissals_unreadable', 503]]) {
      mockEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'green', reasons: [] } });
      const err = new Error(`executeMerge: the pair is no longer mergeable (${code}) — review a fresh proposal`);
      err.previewChanged = true;
      mockExecuteMerge.mockRejectedValueOnce(err);
      const res = await post('/merge', body);
      expect(res.status).toBe(status);
      expect(res.body.error).toMatch(new RegExp(`no longer mergeable \\(${code}\\)`));
    }
    // A fingerprint drift refusal is the same class.
    mockEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'green', reasons: [] } });
    const drift = new Error('executeMerge: the rows that would move changed since this merge was approved — review a fresh proposal');
    drift.previewChanged = true;
    mockExecuteMerge.mockRejectedValueOnce(drift);
    expect((await post('/link-as-property', body)).status).toBe(409);
    // An unexplained executor failure is still a 500.
    mockEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'green', reasons: [] } });
    mockExecuteMerge.mockRejectedValueOnce(new Error('executeMerge: repoint failed on invoices.customer_id: boom'));
    expect((await post('/merge', body)).status).toBe(500);
  });

  test('eligible pair merges with the admin actor identity', async () => {
    mockEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'green', reasons: [] } });
    const res = await post('/merge', body);
    expect(res.status).toBe(200);
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ winnerId: WINNER, loserId: LOSER, mode: 'manual', performedBy: 'admin:Admin', performedById: 'admin-1', requireQueueEligibility: true, allowAddressConflict: false }));
  });
});

describe('dismiss', () => {
  test('records the verdict inside a transaction under the pair adjudication lock (the confirmed-card merge re-decides eligibility under the same lock)', async () => {
    const db = require('../models/db');
    const chain = {};
    for (const m of ['insert', 'onConflict']) chain[m] = jest.fn(() => chain);
    chain.ignore = jest.fn(async () => 1);
    const trx = jest.fn(() => chain);
    db.transaction = jest.fn(async (cb) => cb(trx));
    const res = await post('/dismiss', { customerIdA: LOSER, customerIdB: WINNER, reason: 'two tenants' });
    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockAcquirePairLock).toHaveBeenCalledWith(trx, WINNER, LOSER); // ordered pair, same key the merge locks
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ customer_id_a: WINNER, customer_id_b: LOSER, reason: 'two tenants' }));
    expect(mockAcquirePairLock.mock.invocationCallOrder[0]).toBeLessThan(chain.insert.mock.invocationCallOrder[0]);
  });

  test('folds UUID case before ordering, locking and inserting — an uppercase id sorts ahead of a lowercase one, so the raw pair stored the reverse of the canonical key findDuplicateGroups looks for and the dismissal silently never took effect (Codex r15 P2)', async () => {
    const db = require('../models/db');
    const chain = {};
    for (const m of ['insert', 'onConflict']) chain[m] = jest.fn(() => chain);
    chain.ignore = jest.fn(async () => 1);
    const trx = jest.fn(() => chain);
    db.transaction = jest.fn(async (cb) => cb(trx));
    // 'B' (0x42) sorts BEFORE 'a' (0x61), so the raw ordering was reversed.
    const UPPER_B = 'B0000000-0000-4000-8000-00000000000A';
    const LOWER_A = 'a0000000-0000-4000-8000-00000000000b';
    const res = await post('/dismiss', { customerIdA: UPPER_B, customerIdB: LOWER_A, reason: 'separate households' });
    expect(res.status).toBe(200);
    expect(mockAcquirePairLock).toHaveBeenCalledWith(trx, LOWER_A, UPPER_B.toLowerCase());
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ customer_id_a: LOWER_A, customer_id_b: UPPER_B.toLowerCase() }));
  });

  test('the same customer in two cases is not a distinct pair', async () => {
    const id = 'a0000000-0000-4000-8000-00000000000b';
    const res = await post('/dismiss', { customerIdA: id.toUpperCase(), customerIdB: id });
    expect(res.status).toBe(400);
  });
});
