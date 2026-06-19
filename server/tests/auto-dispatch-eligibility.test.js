const { isEligibleForAutoDispatch, isRecurringPlanActive } = require('../services/auto-dispatch/eligibility');

// today=2026-06-18, lock boundary = today+14 = 2026-07-02 (inclusive lock)
const CTX = { today: '2026-06-18', lockBoundary: '2026-07-02', lockWindowDays: 14 };

function svc(overrides = {}) {
  return {
    id: 's1',
    customer_id: 'c1',
    is_recurring: true,
    recurring_parent_id: null,
    status: 'confirmed',
    scheduled_date: '2026-07-20', // 20+ days out
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    customer_active: true,
    lat: 27.4,
    lng: -82.5,
    ...overrides,
  };
}

describe('isEligibleForAutoDispatch', () => {
  test('recurring visit ~20 days out is eligible', () => {
    expect(isEligibleForAutoDispatch(svc(), CTX)).toMatchObject({ eligible: true });
  });

  test('booster-month row (is_recurring=false but has a parent) is NON_RECURRING', () => {
    // booster visits carry recurring_parent_id but is_recurring=false on purpose;
    // they must NOT be auto-dispatched.
    const r = isEligibleForAutoDispatch(svc({ is_recurring: false, recurring_parent_id: 'p1' }), CTX);
    expect(r).toMatchObject({ eligible: false, reason_code: 'NON_RECURRING' });
  });

  test('one-time visit is NON_RECURRING', () => {
    expect(isEligibleForAutoDispatch(svc({ is_recurring: false, recurring_parent_id: null }), CTX))
      .toMatchObject({ eligible: false, reason_code: 'NON_RECURRING' });
  });

  test('inside the 14-day lock window is INSIDE_LOCK_WINDOW', () => {
    // 2026-06-25 is within today+14 (<= 2026-07-02)
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-06-25' }), CTX))
      .toMatchObject({ eligible: false, reason_code: 'INSIDE_LOCK_WINDOW' });
  });

  test('boundary date (exactly today+14) is locked, day after is eligible', () => {
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-07-02' }), CTX).reason_code)
      .toBe('INSIDE_LOCK_WINDOW');
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-07-03' }), CTX).eligible).toBe(true);
  });

  test.each(['completed', 'cancelled', 'skipped', 'en_route', 'on_site', 'rescheduled'])('status %s is not auto-dispatchable', (status) => {
    expect(isEligibleForAutoDispatch(svc({ status }), CTX).eligible).toBe(false);
  });

  test("'rescheduled' (an un-actioned customer request) is skipped with a clear reason", () => {
    expect(isEligibleForAutoDispatch(svc({ status: 'rescheduled' }), CTX))
      .toMatchObject({ reason_code: 'RESCHEDULE_REQUEST_PENDING' });
  });

  test('accepts a pg Date object for scheduled_date (not INVALID_DATE)', () => {
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: new Date('2026-07-20T00:00:00Z') }), CTX).eligible).toBe(true);
  });

  test('manually locked is MANUALLY_LOCKED', () => {
    expect(isEligibleForAutoDispatch(svc({ auto_dispatch_locked: true }), CTX))
      .toMatchObject({ reason_code: 'MANUALLY_LOCKED' });
  });

  test('excluded is AUTO_DISPATCH_EXCLUDED', () => {
    expect(isEligibleForAutoDispatch(svc({ auto_dispatch_excluded: true }), CTX))
      .toMatchObject({ reason_code: 'AUTO_DISPATCH_EXCLUDED' });
  });

  test('inactive customer is CUSTOMER_INACTIVE', () => {
    expect(isEligibleForAutoDispatch(svc({ customer_active: false }), CTX))
      .toMatchObject({ reason_code: 'CUSTOMER_INACTIVE' });
  });

  test('no usable geo (service or customer) is MISSING_GEO', () => {
    expect(isEligibleForAutoDispatch(svc({ lat: null, lng: null }), CTX))
      .toMatchObject({ reason_code: 'MISSING_GEO' });
  });

  test('falls back to customer latitude/longitude when service coords missing', () => {
    const r = isEligibleForAutoDispatch(svc({ lat: null, lng: null, customer_latitude: 27.4, customer_longitude: -82.5 }), CTX);
    expect(r.eligible).toBe(true);
  });
});

describe('isRecurringPlanActive', () => {
  function fakeDb({ alert = null, subs = [] }) {
    return (table) => {
      if (table === 'recurring_plan_alerts') {
        return {
          where: function () { return this; },
          whereIn: function () { return this; },
          whereNull: function () { return this; },
          first: async () => alert,
        };
      }
      if (table === 'customer_subscriptions') {
        return {
          where: function () { return this; },
          select: async () => subs,
        };
      }
      throw new Error(`unexpected table ${table}`);
    };
  }

  test('active when no alert and no subscriptions', async () => {
    expect(await isRecurringPlanActive(svc(), fakeDb({}))).toMatchObject({ active: true });
  });

  test('inactive when an unresolved plan_lapsed alert exists', async () => {
    const r = await isRecurringPlanActive(svc({ recurring_parent_id: 'p1' }), fakeDb({ alert: { id: 'a1', alert_type: 'plan_lapsed' } }));
    expect(r).toMatchObject({ active: false, reason_code: 'RECURRING_PLAN_INACTIVE' });
  });

  test('does NOT veto on legacy paused/cancelled customer_subscriptions', async () => {
    // active recurring plans are driven by scheduled_services; stale legacy subs
    // must not exclude an otherwise-valid recurring visit.
    const r = await isRecurringPlanActive(svc(), fakeDb({ subs: [{ status: 'paused' }, { status: 'cancelled' }] }));
    expect(r.active).toBe(true);
  });
});
