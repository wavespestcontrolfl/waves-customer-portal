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
          whereNotIn: () => ({ first: async () => (typeof dupeRow === 'function' ? dupeRow() : dupeRow) }),
          whereRaw: function whereRaw() { return { whereRaw, update: async () => 1 }; },
          update: async () => 1,
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
  test('rejects an empty challenge on a VALID estimate with a 400', async () => {
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: [],
      note: '',
      database: mockDb(),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    })).rejects.toMatchObject({ status: 400 });
  });

  test('an empty challenge on an UNKNOWN token 404s — never a gate-state oracle (codex final-head P0)', async () => {
    // Pre-fix, the empty-body 400 fired before the token lookup: the same
    // probe returned 404 while the gate was dark and 400 while live,
    // leaking gate state to anonymous probes.
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-unknown',
      reasons: [],
      note: '',
      database: mockDb({ estimate: null }),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
  });

  test('404s an unknown token and an ineligible estimate identically', async () => {
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb({ estimate: null }),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb({ estimate: { ...ESTIMATE_ROW, status: 'accepted' } }),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
  });

  test('404s an estimate with NO priced lawn basis (codex r3: pest-only estimates take no lawn challenge)', async () => {
    const database = mockDb();
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => null,
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
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result.success).toBe(true);
    expect(lockCalls).toContain('forUpdate');
  });

  test('re-validates eligibility on the LOCKED row (local-audit P1: concurrent accept during lock wait)', async () => {
    const database = mockDb();
    // The row re-read under the lock comes back ACCEPTED — a concurrent
    // accept committed while this request waited. Must 404 with no writes.
    database.transaction = async (fn) => {
      const trx = (table) => {
        if (table === 'estimates') {
          return {
            where: () => ({
              forUpdate: () => ({ first: async () => ({ ...ESTIMATE_ROW, status: 'accepted' }) }),
              first: async () => ({ ...ESTIMATE_ROW, status: 'accepted' }),
            }),
          };
        }
        return database(table);
      };
      trx.raw = database.raw;
      return fn(trx);
    };
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    })).rejects.toMatchObject({ status: 404 });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('policy suppression is terminal success — no retry, no loud error (codex final-head P3)', async () => {
    // Internal/demo accounts: notifyAdmin resolves { suppressed: true } by
    // DESIGN — retrying would double the deterministically suppressed call
    // and page the log with a phantom outage.
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb(),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: false });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a real persistence failure retries once, then succeeds (notifyAdmin never rejects)', async () => {
    NotificationService.notifyAdmin
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'notif-2' });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb(),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: false });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
  });

  test('404s when a concurrent revision REMOVES the lawn basis during the lock wait (local-audit P1)', async () => {
    const database = mockDb();
    database.transaction = async (fn) => {
      const trx = (table) => database(table);
      trx.raw = database.raw;
      // Locked re-read returns a REVISED row the basis derivation no longer
      // recognizes (lawn line removed by a concurrent revision).
      const revised = { ...ESTIMATE_ROW, estimate_data: { revised: true } };
      const lockedTrx = (table) => {
        if (table === 'estimates') {
          return {
            where: () => ({
              forUpdate: () => ({ first: async () => revised }),
              first: async () => revised,
            }),
          };
        }
        return database(table);
      };
      lockedTrx.raw = database.raw;
      return fn(lockedTrx);
    };
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      // Pre-lock row has a basis; the locked (revised) row does not.
      basisFor: (row) => (row?.estimate_data?.revised ? null : { sqft: 7500, source: 'AI satellite measurement' }),
    })).rejects.toMatchObject({ status: 404 });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('404s when the call-side linkage verdict blocks the LOCKED row (local-audit P0)', async () => {
    const database = mockDb();
    database.transaction = async (fn) => {
      const trx = (table) => database(table);
      trx.raw = database.raw;
      const lockedTrx = (table) => {
        if (table === 'estimates') {
          return {
            where: () => ({
              forUpdate: () => ({ first: async () => ESTIMATE_ROW }),
              first: async () => ESTIMATE_ROW,
            }),
          };
        }
        return database(table);
      };
      lockedTrx.raw = database.raw;
      return fn(lockedTrx);
    };
    await expect(createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
      // Call processing invalidated the linkage between the route's
      // pre-check and the lock — fail closed with zero writes.
      callSideBlockedFor: async () => true,
    })).rejects.toMatchObject({ status: 404 });
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
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
      database,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
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
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(database.inserts[0].pricing_revision).reasons).toEqual([]);
  });

  test('a duplicate open request dedupes via the PRE-CHECK and RE-ARMS an undelivered handoff (codex P2)', async () => {
    const err = new Error('duplicate key');
    err.code = '23505';
    // The dupe row has NO notifiedAt stamp — both original attempts failed,
    // so this customer retry must re-send the office notification.
    const database = mockDb({ insertError: err, dupeRow: { id: 'req-existing', subject: 'Re-measure', description: 'd', customer_id: 'cust-1', pricing_revision: '{}' } });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: true });
    // Pre-check dedupe: no insert is even attempted — but the UNDELIVERED
    // handoff is re-sent so the office cannot permanently miss a challenge.
    expect(database.inserts).toHaveLength(0);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a dedupe against a FRESH lease never double-arms (another sender is mid-flight)', async () => {
    const database = mockDb({ dupeRow: { id: 'req-existing', pricing_revision: JSON.stringify({ notifyLeaseAt: new Date().toISOString() }) } });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a dedupe against a STALE lease re-arms (crashed sender is recoverable)', async () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const database = mockDb({ dupeRow: { id: 'req-existing', subject: 's', description: 'd', customer_id: 'cust-1', pricing_revision: JSON.stringify({ notifyLeaseAt: stale }) } });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: true });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a dedupe against a DELIVERED request never double-rings the office', async () => {
    const database = mockDb({ dupeRow: { id: 'req-existing', pricing_revision: JSON.stringify({ notifiedAt: '2026-08-13' }) } });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('unserialized path: a 23505 race still dedupes via the catch (pre-check missed)', async () => {
    const err = new Error('duplicate key');
    err.code = '23505';
    let calls = 0;
    // Pre-check sees nothing (race window); the catch re-query finds the row.
    const database = mockDb({ insertError: err, dupeRow: () => (calls++ === 0 ? null : { id: 'req-existing' }) });
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database,
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
    });
    expect(result).toEqual({ success: true, deduped: true });
    // The catch-path dupe row carries no notifiedAt → handoff re-armed.
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a failed admin notification never loses the parked request', async () => {
    NotificationService.notifyAdmin.mockRejectedValueOnce(new Error('notif outage'));
    const result = await createEstimateMeasurementReview({
      estimateToken: 'tok-1',
      reasons: ['bigger'],
      database: mockDb(),
      viewabilityCheck: viewable,
      basisFor: () => ({ sqft: 7500, source: 'AI satellite measurement' }),
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
  test('estimate_measurement_review is owner-overridable under the admin bell policy (silent by default, owner ruling 2026-08-28)', () => {
    // Owner ruling 2026-08-28: this lane no longer rings by default. The
    // policy INVARIANT still holds — a silenced category must be listed as
    // overridable so the owner can re-enable it from Settings → Notifications
    // (a suppressible category nobody can re-enable is a dead letterbox).
    const policySrc = require('fs').readFileSync(
      require.resolve('../services/notification-bell-policy'), 'utf8'
    );
    const allowlistBlock = policySrc.split('CATEGORY_BELL_ALLOWLIST')[1].split(']')[0];
    expect(allowlistBlock).not.toContain("'estimate_measurement_review'");
    const overridableBlock = policySrc.split('OVERRIDABLE_CATEGORIES = [')[1].split(']')[0];
    expect(overridableBlock).toContain("'estimate_measurement_review'");
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
