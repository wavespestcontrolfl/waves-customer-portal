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
jest.mock('../services/customer-dedupe', () => ({
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

    mockEligibility.mockResolvedValueOnce({ eligible: false, code: 'dismissals_unreadable', reason: 'Operator dismissal verdicts could not be read', candidate: null });
    const refused = await post('/link-as-property', body);
    expect(refused.status).toBe(503);
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1);
  });

  test('eligible pair merges with the admin actor identity', async () => {
    mockEligibility.mockResolvedValueOnce({ eligible: true, code: 'eligible', reason: null, candidate: { tier: 'green', reasons: [] } });
    const res = await post('/merge', body);
    expect(res.status).toBe(200);
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ winnerId: WINNER, loserId: LOSER, mode: 'manual', performedBy: 'admin:Admin', performedById: 'admin-1' }));
  });
});
