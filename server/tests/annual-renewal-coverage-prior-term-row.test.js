// Audit repro r1-sched-series-1: a NON-palm visit explicitly linked to a
// DIFFERENT (prior) annual-prepay term, sitting inside the renewal term's
// window, must never consume one of the renewal term's sold slots.
// Mirrors the palm-only pin at tests/annual-prepay-renewals.test.js:826
// ("a visit linked to a DIFFERENT term never commits") but with the common
// quarterly pest-control coverage type.
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

const PRIOR_TERM_ROW = {
  id: 'v-prior-term', customer_id: 'customer-1', scheduled_date: '2026-06-20',
  service_type: 'Quarterly Pest Control Service', annual_prepay_term_id: 'term-OLD',
  prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', is_recurring: true, status: 'pending',
};

describe('audit r1-sched-series-1: non-palm row linked to another term must not consume a renewal slot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.raw = jest.fn().mockResolvedValue({ rows: [{ locked: true }] });
    db.transaction = jest.fn(async (cb) => cb(db));
    _private.resetCachesForTests();
  });

  test('coverageRowsForTerm excludes a row explicitly linked to a different term (non-palm)', async () => {
    setDbQueues({ scheduled_services: [query({ rows: [PRIOR_TERM_ROW] })] });
    const selected = await _private.coverageRowsForTerm({
      id: 'term-NEW', customer_id: 'customer-1',
      coverage_service_type: 'Quarterly Pest Control Service', coverage_visit_count: 4,
      term_start: '2026-06-15', term_end: '2027-06-15',
    });
    expect(selected.map((r) => r.id)).toEqual([]);
  });

  test('ensureCoverageRowsForTerm seeds the FULL sold count when the only in-window match belongs to the prior term (non-palm)', async () => {
    const colQ = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, annual_prepay_term_id: {}, is_recurring: {},
        recurring_pattern: {}, recurring_parent_id: {}, recurring_ongoing: {}, technician_id: {},
        window_start: {}, window_end: {}, time_window: {}, customer_notes: {}, zone: {}, notes: {},
        estimated_duration_minutes: {},
      },
    });
    const rowsQ = query({ rows: [PRIOR_TERM_ROW] });
    const inserts = [
      query({ returning: [{ id: 'svc-t1', scheduled_date: '2026-06-15' }] }),
      query({ returning: [{ id: 'svc-t2', scheduled_date: '2026-09-15' }] }),
      query({ returning: [{ id: 'svc-t3', scheduled_date: '2026-12-15' }] }),
      query({ returning: [{ id: 'svc-t4', scheduled_date: '2027-03-15' }] }),
    ];
    setDbQueues({ scheduled_services: [colQ, rowsQ, query({ first: undefined }), ...inserts] });

    const result = await _private.ensureCoverageRowsForTerm({
      id: 'term-NEW', customer_id: 'customer-1',
      term_start: '2026-06-15', term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control Service', coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' });

    expect(result.existingCount).toBe(0);
    expect(result.createdCount).toBe(4);
    // And no seeded visit may be parented to the prior term's visit.
    for (const ins of inserts) {
      for (const call of ins.insert.mock.calls) {
        expect(call[0].recurring_parent_id).not.toBe('v-prior-term');
      }
    }
  });
});
