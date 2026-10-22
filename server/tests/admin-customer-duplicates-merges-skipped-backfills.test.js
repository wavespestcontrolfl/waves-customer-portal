/**
 * GET /merges returns skipped_backfills (built from the journal evidence) so
 * the office can see an email the automatic merge left off the kept customer
 * (GATE_DEDUPE_NO_UNVERIFIED_BACKFILL).
 */
let mockJournalRows = [];
jest.mock('../models/db', () => {
  const chain = (table) => {
    const q = new Proxy(function noop() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve(String(table).startsWith('customer_merge_journal') ? mockJournalRows : []).then(resolve, reject);
        }
        return () => q;
      },
    });
    return q;
  };
  const fn = jest.fn((table) => chain(table));
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/customer-dedupe', () => ({
  findDuplicateGroups: jest.fn(),
  duplicatePairEligibility: jest.fn(),
  executeMerge: jest.fn(),
  revertMerge: jest.fn(),
  recordLinkedProperty: jest.fn(),
  acquirePairAdjudicationLock: jest.fn(),
  REVERT_FINANCIAL_TABLES: new Set(),
  CONSENT_CRITICAL_TABLES: new Set(),
  countActivityRows: jest.fn(),
  activityColumnsFor: jest.fn(),
  UNDO_MERGE_DISMISSAL_REASON: 'undo_merge',
}));

const router = require('../routes/admin-customer-duplicates');

function getMerges() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/merges' && l.route.methods.get);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    handle({ query: {} }, res, (err) => reject(err || new Error('next()')));
  });
}

const baseRow = {
  winner_customer_id: 'w1', loser_customer_id: 'l1', tier: 'green', performed_by: 'auto:dedupe-cron',
  created_at: new Date('2026-10-22T08:40:00Z'), undone_at: new Date('2026-10-22T09:00:00Z'), undone_by: 'admin',
  loser_snapshot: JSON.stringify({ id: 'l1', first_name: 'Pat', last_name: 'Lead' }),
  repointed_ids: null, winner_first_name: 'Pat', winner_last_name: 'Real', winner_active: true, winner_deleted_at: null,
  winner_stripe_customer_id: null, loser_row_id: 'l1', loser_row_deleted_at: new Date(),
};

describe('GET /merges skipped_backfills', () => {
  test('lists the email the automatic merge did not copy', async () => {
    mockJournalRows = [
      { ...baseRow, id: 'j1', evidence: JSON.stringify({ unverified_shell_backfills_skipped: { email: 'typed@example.test' } }) },
      { ...baseRow, id: 'j2', evidence: { kind: 'phone' } },
      { ...baseRow, id: 'j3', evidence: null },
    ];
    const res = await getMerges();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.merges.map((m) => [m.journalId, m]));
    expect(byId.j1.skipped_backfills).toEqual({ email: 'typed@example.test' });
    expect(byId.j2.skipped_backfills).toBeNull();
    expect(byId.j3.skipped_backfills).toBeNull();
  });
});
