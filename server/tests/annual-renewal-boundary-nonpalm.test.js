// Audit repro r1-sched-series-1: a prior term's stamped visit inside the
// renewal term's window is counted as the NEW term's coverage on the
// NON-palm path (coverageRowsForTerm only applies rowLinkedToAnotherTerm
// inside the palm branch), so the renewal seeds and stamps one short.
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
jest.mock('../services/customer-credit', () => ({ postCreditMovement: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

const db = require('../models/db');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;
const { notifyAdmin } = require('../services/notification-service');

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  ['whereIn', 'whereNull', 'whereNot', 'whereBetween', 'whereNotIn', 'orderBy', 'select', 'forUpdate',
    'leftJoin', 'whereRaw', 'whereNotNull', 'orWhereNotNull', 'orWhereNull', 'orWhereRaw', 'orWhereNot',
    'orWhereIn', 'orWhereNotIn', 'andWhere'].forEach((m) => { q[m] = jest.fn(() => q); });
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
      if (table === 'annual_prepay_terms as apt_owner_probe') return query({ first: { customer_id: 'owner-unchanged' } });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

const COLS = {
  scheduled_date: {}, service_type: {}, annual_prepay_term_id: {}, is_recurring: {},
  recurring_pattern: {}, recurring_parent_id: {}, recurring_ongoing: {}, technician_id: {},
  window_start: {}, window_end: {}, time_window: {}, customer_notes: {}, zone: {}, notes: {},
  estimated_duration_minutes: {}, prepaid_amount: {}, prepaid_method: {}, prepaid_at: {},
  prepaid_note: {}, updated_at: {}, status: {},
};

const NEW_TERM = {
  id: 'term-NEW', customer_id: 'customer-1', prepay_amount: 400,
  term_start: '2026-06-15', term_end: '2027-06-15',
  coverage_service_type: 'Quarterly Pest Control', coverage_visit_count: 4,
};

// The prior term's final visit, weather-rescheduled past OLD.term_end into NEW's window.
const OLD_ROW = {
  id: 'v-prior-term', scheduled_date: '2026-06-20', service_type: 'Quarterly Pest Control',
  annual_prepay_term_id: 'term-OLD', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice',
  is_recurring: true, status: 'pending',
};

describe('audit r1-sched-series-1: renewal boundary, non-palm coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.raw = jest.fn().mockResolvedValue({ rows: [{ locked: true }] });
    db.transaction = jest.fn(async (cb) => cb(db));
    _private.resetCachesForTests();
  });

  test('coverageRowsForTerm (non-palm) returns the OTHER-term row as NEW coverage; palm control excludes it', async () => {
    setDbQueues({ scheduled_services: [query({ rows: [OLD_ROW] })] });
    const nonPalm = await _private.coverageRowsForTerm(NEW_TERM);
    // Control: identical shape on the palm family is excluded (the r21 filter).
    setDbQueues({
      scheduled_services: [query({ rows: [{ ...OLD_ROW, service_type: 'Palm Injection', service_id: 'cat-palm-semi' }] })],
      services: [query({ first: { id: 'cat-palm-semi' } }), query({ first: { id: 'cat-palm-onetime' } })],
    });
    const palm = await _private.coverageRowsForTerm({ ...NEW_TERM, coverage_service_type: 'Palm Injection', coverage_visit_count: 2 });
    expect(palm.map((r) => r.id)).toEqual([]);
    expect(nonPalm.map((r) => r.id)).toEqual([]); // ACTUAL: ['v-prior-term']
  });

  test('ensureCoverageRowsForTerm seeds the FULL sold count when the only in-window row belongs to another term', async () => {
    const inserts = [
      query({ returning: [{ id: 'svc-1', scheduled_date: '2026-06-15' }] }),
      query({ returning: [{ id: 'svc-2', scheduled_date: '2026-09-15' }] }),
      query({ returning: [{ id: 'svc-3', scheduled_date: '2026-12-15' }] }),
      query({ returning: [{ id: 'svc-4', scheduled_date: '2027-03-15' }] }),
    ];
    setDbQueues({
      scheduled_services: [query({ columnInfo: COLS }), query({ rows: [OLD_ROW] }), query({ first: undefined }), ...inserts],
    });
    const result = await _private.ensureCoverageRowsForTerm({ ...NEW_TERM }, undefined, { today: '2026-01-01' });
    expect(result).toMatchObject({ existingCount: 0, createdCount: 4 }); // ACTUAL: existingCount 1, createdCount 3
  });

  test('applyPrepaidCoverageForTerm stamps 4 of 4 and files nothing — actual: 3 of 4 with no exception', async () => {
    const rows = [
      OLD_ROW,
      { id: 'svc-2', scheduled_date: '2026-09-15', service_type: 'Quarterly Pest Control', annual_prepay_term_id: 'term-NEW', status: 'pending' },
      { id: 'svc-3', scheduled_date: '2026-12-15', service_type: 'Quarterly Pest Control', annual_prepay_term_id: 'term-NEW', status: 'pending' },
      { id: 'svc-4', scheduled_date: '2027-03-15', service_type: 'Quarterly Pest Control', annual_prepay_term_id: 'term-NEW', status: 'pending' },
    ];
    const updates = rows.map((r) => query({ returning: [{ id: r.id }] }));
    setDbQueues({
      scheduled_services: [query({ columnInfo: COLS }), query({ rows }), ...updates],
      notifications: [query({ first: undefined })],
    });
    const result = await AnnualPrepayRenewals.applyPrepaidCoverageForTerm({ ...NEW_TERM });
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(result.matchedCount).toBe(4);
    expect(result.stampedCount).toBe(4); // ACTUAL: 3 — the OLD-linked row is `continue`d silently
  });
});
