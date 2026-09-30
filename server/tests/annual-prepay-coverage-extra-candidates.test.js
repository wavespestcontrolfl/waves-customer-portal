// coverageRowsForTerm extraCandidateRows (re-price guard, secure-prepay
// coverage rail): an overridden visit competes for sold slots at its NEW
// date, and one moved out of the window never survives via its stale DB row
// (pre-push audit P0 + P1 on fix/reprice-guard-secure-prepay-coverage).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
  retireRodentSetupObligationForRevivedPrepay: jest.fn(async () => null),
  _retireSwitchRestoredInvoicesForRevivedPrepay: jest.fn(async () => 0),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
  WAVEGUARD_EXTENSION_RESTORE_BY: 'system:waveguard_tier_extension_restore',
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

const db = require('../models/db');
const { _private } = require('../services/annual-prepay-renewals');

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  ['whereIn', 'whereNull', 'whereNot', 'whereBetween', 'whereNotIn', 'orderBy', 'select', 'forUpdate',
    'leftJoin', 'whereRaw', 'whereNotNull', 'orWhereNotNull', 'orWhereNull', 'orWhereRaw', 'orWhereNot',
    'orWhereIn', 'orWhereNotIn'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(q); return q; });
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; });
  q.orWhere = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.columnInfo = jest.fn(async () => columnInfo || {});
  q.catch = jest.fn(() => Promise.resolve());
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) {
      if (table === 'annual_prepay_terms as apt_owner_probe') {
        return query({ first: { customer_id: 'owner-unchanged' } });
      }
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

const TERM = {
  id: 'term-PENDING', customer_id: 'customer-1',
  coverage_service_type: 'Quarterly Pest Control Service', coverage_visit_count: 1,
  term_start: '2026-01-01', term_end: '2026-12-31',
};
const visit = (id, date) => ({
  id, customer_id: 'customer-1', scheduled_date: date, window_start: '09:00:00',
  service_type: 'Quarterly Pest Control Service', is_recurring: true, status: 'pending',
});

describe('coverageRowsForTerm extraCandidateRows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.raw = jest.fn().mockResolvedValue({ rows: [{ locked: true }] });
    _private.resetCachesForTests();
  });

  const run = (dbRows, extraCandidateRows) => {
    setDbQueues({
      scheduled_services: [query({ rows: dbRows })],
      annual_prepay_terms: [query({ rows: [] })],
    });
    return _private.coverageRowsForTerm(TERM, db, { extraCandidateRows });
  };

  test('without overrides the earliest visit takes the one sold slot', async () => {
    const selected = await run([visit('v-june', '2026-06-10'), visit('v-aug', '2026-08-10')]);
    expect(selected.map((r) => r.id)).toEqual(['v-june']);
  });

  test('a visit moved EARLIER in the same save takes the slot at its new position', async () => {
    const selected = await run(
      [visit('v-june', '2026-06-10'), visit('v-aug', '2026-08-10')],
      [visit('v-aug', '2026-03-10')],
    );
    expect(selected.map((r) => r.id)).toEqual(['v-aug']);
  });

  test('a visit moved INTO the window from outside competes by date', async () => {
    const selected = await run([visit('v-june', '2026-06-10')], [visit('v-new', '2026-02-01')]);
    expect(selected.map((r) => r.id)).toEqual(['v-new']);
  });

  test('a visit moved OUT of the window drops out instead of surviving via its stale DB row', async () => {
    const selected = await run([visit('v-june', '2026-06-10')], [visit('v-june', '2027-03-01')]);
    expect(selected.map((r) => r.id)).toEqual([]);
  });

  test('an override without window_start keeps the stored one for ordering', async () => {
    const early = { ...visit('v-b', '2026-06-10'), window_start: '08:00:00' };
    const { window_start: _omit, ...bare } = early;
    const selected = await run([visit('v-a', '2026-06-10'), early], [bare]);
    expect(selected.map((r) => r.id)).toEqual(['v-b']);
  });

  test('start times are compared as times, not raw strings ("9:00" sorts before "10:00:00")', async () => {
    const a = { ...visit('v-a', '2026-06-10'), window_start: '10:00:00' };
    const b = { ...visit('v-b', '2026-06-10'), window_start: '09:30:00' };
    const selected = await run([b, a], [{ ...a, window_start: '9:00' }]);
    expect(selected.map((r) => r.id)).toEqual(['v-a']);
  });
});
