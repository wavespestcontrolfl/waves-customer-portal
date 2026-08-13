/**
 * "Does the lawn size look off?" — the customer challenge flow (owner GO
 * 2026-08-12). Invariants under test:
 *
 *   - a challenge NEVER mutates the estimate — the only write is the
 *     service_requests row (+ admin notification); shown == sent until the
 *     office re-measures.
 *   - no customer comms anywhere in the flow (owner sends all comms).
 *   - the FULL customer-viewability contract gates the write (codex r2):
 *     a leaked draft/archived/past-expiry/linkage-invalidated token 404s
 *     with zero rows written.
 *   - empty challenges (no chip, no note) are rejected, not parked.
 *   - unknown/duplicate reason keys are dropped, not stored.
 *   - a concurrent duplicate open request dedupes via the partial unique
 *     index (23505) instead of erroring the sheet.
 *   - the admin notification category rings under the bell policy (codex
 *     r2 P1: a suppressed category = silent dead letterbox).
 */

jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));
jest.mock('../services/estimate-add-service-request', () => {
  const actual = jest.requireActual('../services/estimate-add-service-request');
  return {
    ...actual,
    resolveEstimateCustomer: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Pat' }),
  };
});

const NotificationService = require('../services/notification-service');
const {
  MEASUREMENT_REVIEW_REASONS,
  normalizeReasons,
  isMeasurementReviewEligible,
  createEstimateMeasurementReview,
} = require('../services/estimate-measurement-review');

const ESTIMATE_ROW = {
  id: 'est-1',
  token: 'tok-1',
  status: 'sent',
  estimate_number: 'EST-2026-0042',
  customer_id: 'cust-1',
};

// Minimal knex-shaped mock: database(table) returns a chainable whose
// terminal calls resolve from per-table programmed results.
function mockDb({ estimate = ESTIMATE_ROW, insertResult, insertError, dupeRow } = {}) {
  const inserts = [];
  const database = (table) => {
    if (table === 'estimates') {
      return { where: () => ({ first: async () => estimate }) };
    }
    if (table === 'service_requests') {
      return {
        insert: (row) => ({
          returning: async () => {
            inserts.push(row);
            if (insertError) throw insertError;
            return [insertResult || { id: 'req-1', ...row }];
          },
        }),
        where: () => ({
          whereNotIn: () => ({ first: async () => dupeRow }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  database.raw = (s) => s;
  database.inserts = inserts;
  return database;
}

// Every call injects a viewability stub — the default lazily requires the
// full estimate-public route module, whose real isEstimateCustomerViewable
// is covered by its own suites.
const viewable = () => true;

beforeEach(() => jest.clearAllMocks());

describe('normalizeReasons', () => {
  test('keeps only known keys, deduped, in order', () => {
    expect(normalizeReasons(['bigger', 'nope', 'bigger', 'less_lawn', 42, null]))
      .toEqual(['bigger', 'less_lawn']);
    expect(normalizeReasons('bigger')).toEqual([]);
    expect(normalizeReasons(undefined)).toEqual([]);
  });
});

describe('isMeasurementReviewEligible', () => {
  test('active statuses eligible; terminal statuses and missing rows not', () => {
    expect(isMeasurementReviewEligible({ status: 'sent' })).toBe(true);
    expect(isMeasurementReviewEligible({ status: 'viewed' })).toBe(true);
    for (const status of ['accepted', 'declined', 'expired', 'send_failed']) {
      expect(isMeasurementReviewEligible({ status })).toBe(false);
    }
    expect(isMeasurementReviewEligible(null)).toBe(false);
  });
});

describe('createEstimateMeasurementReview', () => {
  test('rejects an empty challenge (no chip, no note) with a 400', async () => {
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: [],
      note: '',
      database: mockDb(),
      viewabilityCheck: viewable,
    })).rejects.toMatchObject({ status: 400 });
  });

  test('404s an unknown token and an ineligible estimate identically', async () => {
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb({ estimate: null }),
      viewabilityCheck: viewable,
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb({ estimate: { ...ESTIMATE_ROW, status: 'accepted' } }),
      viewabilityCheck: viewable,
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
  });

  test('404s an estimate with NO priced lawn basis (codex r3: pest-only estimates take no lawn challenge)', async () => {
    const database = mockDb();
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      lawnBasisPresent: false,
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('serializes per-estimate when the database supports transactions (codex r3 P1: duplicate customer race)', async () => {
    const database = mockDb();
    const lockCalls = [];
    // knex-shaped transaction: hand the callback a trx that records the
    // estimate row lock, then behaves like the base mock.
    database.transaction = async (fn) => {
      const trx = (table) => {
        if (table === 'estimates') {
          return {
            where: () => ({
              forUpdate: () => ({ first: async () => { lockCalls.push('forUpdate'); return ESTIMATE_ROW; } }),
              first: async () => ESTIMATE_ROW,
            }),
          };
        }
        return database(table);
      };
      trx.raw = database.raw;
      return fn(trx);
    };
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
    });
    expect(result.success).toBe(true);
    expect(lockCalls).toContain('forUpdate');
  });

  test('404s a non-viewable estimate BEFORE any write (codex r2: leaked/archived/expired tokens)', async () => {
    const database = mockDb();
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      // Full customer-viewability contract says no (archived / past expiry /
      // linkage-invalidated / unpublished) even though the status string is
      // 'sent' — must 404 with zero rows written and zero notifications.
      viewabilityCheck: () => false,
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('parks a lawn_area_review row and notifies the ADMIN only', async () => {
    const database = mockDb();
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['less_lawn', 'rock_or_beds'],
      note: 'Back half is river rock <script>',
      shownSqFt: 7500,
      shownSource: 'AI satellite measurement',
      database,
      viewabilityCheck: viewable,
    });
    expect(result).toEqual({ success: true, deduped: false });
    expect(database.inserts).toHaveLength(1);
    const row = database.inserts[0];
    expect(row.requested_service).toBe('lawn_area_review');
    expect(row.category).toBe('measurement_review');
    expect(row.status).toBe('new');
    expect(row.customer_id).toBe('cust-1');
    expect(row.estimate_id).toBe('est-1');
    const revision = JSON.parse(row.pricing_revision);
    expect(revision).toMatchObject({
      type: 'lawn_area_review',
      reasons: ['less_lawn', 'rock_or_beds'],
      shownSqFt: 7500,
      shownSource: 'AI satellite measurement',
    });
    // Angle brackets stripped, note preserved.
    expect(revision.note).toBe('Back half is river rock script');
    // Admin notification carries the subject; NO customer notification path
    // exists in this module at all.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toContain('EST-2026-0042');
  });

  test('note-only challenges are accepted', async () => {
    const database = mockDb();
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      note: 'The side yard is fenced off',
      database,
      viewabilityCheck: viewable,
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(database.inserts[0].pricing_revision).reasons).toEqual([]);
  });

  test('a duplicate open request dedupes instead of erroring the sheet', async () => {
    const err = new Error('duplicate key');
    err.code = '23505';
    const database = mockDb({ insertError: err, dupeRow: { id: 'req-existing' } });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
    });
    expect(result).toEqual({ success: true, deduped: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed admin notification never loses the parked request', async () => {
    NotificationService.notifyAdmin.mockRejectedValueOnce(new Error('notif outage'));
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb(),
      viewabilityCheck: viewable,
    });
    expect(result).toEqual({ success: true, deduped: false });
  });

  test('chip labels match the approved mockup set', () => {
    expect(Object.values(MEASUREMENT_REVIEW_REASONS)).toEqual([
      'We have less lawn than that',
      'Part of the yard is rock or beds',
      'New pool or landscaping',
      "A fenced area shouldn't be treated",
      "It's bigger than that",
    ]);
  });
});

describe('bell + lifecycle guards (codex r2 P1s)', () => {
  test('estimate_measurement_review rings under the admin bell policy', () => {
    // The admin notification is the flow's ONLY handoff — if the bell policy
    // suppresses the category, the office never learns a customer is waiting
    // on a promised same-day re-check.
    const policySrc = require('fs').readFileSync(
      require.resolve('../services/notification-bell-policy'), 'utf8'
    );
    const allowlistBlock = policySrc.split('CATEGORY_BELL_ALLOWLIST')[1].split(']')[0];
    expect(allowlistBlock).toContain("'estimate_measurement_review'");
  });

  test('admin-requests lifecycle email skips measurement_review rows', () => {
    // "Mark handled" on a measurement_review request must NOT email the
    // customer — office-only contract (owner sends all comms).
    const routeSrc = require('fs').readFileSync(
      require.resolve('../routes/admin-requests'), 'utf8'
    );
    expect(routeSrc).toMatch(/statusChanged\s*&&\s*updated\.category\s*!==\s*'measurement_review'/);
  });
});
