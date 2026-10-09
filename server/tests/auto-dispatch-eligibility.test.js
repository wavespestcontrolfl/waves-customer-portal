const { isEligibleForAutoDispatch, isRecurringPlanActive, isPersonPlacedVisit } = require('../services/auto-dispatch/eligibility');

// today=2026-06-18, lock boundary = today+14 = 2026-07-02 (inclusive lock)
const CTX = { today: '2026-06-18', lockBoundary: '2026-07-02', lockWindowDays: 14 };

function svc(overrides = {}) {
  return {
    id: 's1',
    customer_id: 'c1',
    is_recurring: true,
    recurring_parent_id: 'p1', // a child occurrence (parents are excluded)
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

  test('recurring parent/template row (no recurring_parent_id) is excluded', () => {
    expect(isEligibleForAutoDispatch(svc({ recurring_parent_id: null }), CTX))
      .toMatchObject({ eligible: false, reason_code: 'PARENT_TEMPLATE_ROW' });
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
        const predicates = {};
        return {
          where: function (key, value) { predicates[key] = value; return this; },
          whereIn: function () { return this; },
          whereNull: function () { return this; },
          first: async () => alert && Object.entries(predicates).every(([key, value]) => ({ customer_id: 'c1', recurring_parent_id: 'p1', ...alert })[key] === value) ? alert : null,
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

  test('a reassigned series is not blocked by the former owner’s lapse alert', async () => {
    const result = await isRecurringPlanActive(svc({ recurring_parent_id: 'p1', customer_id: 'c2' }),
      fakeDb({ alert: { id: 'a1', customer_id: 'c1', recurring_parent_id: 'p1', alert_type: 'plan_lapsed' } }));
    expect(result.active).toBe(true);
  });

  test('a stale plan_ending reminder cannot block a live recurring visit', async () => {
    const result = await isRecurringPlanActive(svc({ recurring_parent_id: 'p1' }), fakeDb({ alert: { id: 'a1', alert_type: 'plan_ending' } }));
    expect(result).toMatchObject({ active: true });
  });

  test('does NOT veto on legacy paused/cancelled customer_subscriptions', async () => {
    // active recurring plans are driven by scheduled_services; stale legacy subs
    // must not exclude an otherwise-valid recurring visit.
    const r = await isRecurringPlanActive(svc(), fakeDb({ subs: [{ status: 'paused' }, { status: 'cancelled' }] }));
    expect(r.active).toBe(true);
  });
});


test('a deferred visit can be placed inside the normal date lock, but staff locks still win', () => {
  const row = svc({ scheduled_date: '2026-06-21', recurring_dispatch_due_date: '2026-06-21', window_start: null });
  expect(isEligibleForAutoDispatch(row, CTX)).toMatchObject({ eligible: true });
  expect(isEligibleForAutoDispatch(row, { ...CTX, routeTiers: { enabled: true, today: CTX.today } })).toMatchObject({ eligible: true });
  expect(isEligibleForAutoDispatch({ ...row, auto_dispatch_locked: true }, CTX)).toMatchObject({ eligible: false, reason_code: 'MANUALLY_LOCKED' });
  expect(isEligibleForAutoDispatch({ ...row, auto_dispatch_excluded: true }, CTX)).toMatchObject({ eligible: false, reason_code: 'AUTO_DISPATCH_EXCLUDED' });
});


test.each([null, '09:00'])('customer confirmation freezes a deferred occurrence with window %s', (windowStart) => {
  expect(isEligibleForAutoDispatch(svc({
    status: 'pending', scheduled_date: '2026-06-19', recurring_dispatch_due_date: '2026-06-19',
    window_start: windowStart, customer_confirmed: true,
  }), CTX)).toMatchObject({ eligible: false, reason_code: 'CUSTOMER_CONFIRMED' });
});

// GATE_AUTO_DISPATCH_FLEX_TIER — a series' first visit (the parent template
// row) and any one-time/first-time visit stay Fixed-tier, excluded by the
// SAME checks flex-tier relies on (NON_RECURRING / PARENT_TEMPLATE_ROW);
// eligibility.js imposes no days-out lock of its own for Flexible-tier
// visits — that lock is the 73h reminder freeze, decided later in index.js.
describe('GATE_AUTO_DISPATCH_FLEX_TIER ctx', () => {
  const FLEX_CTX = { ...CTX, flexTier: { enabled: true } };

  test('a series first visit (parent/template row) stays Fixed-tier — excluded even with the flex ctx', () => {
    expect(isEligibleForAutoDispatch(svc({ recurring_parent_id: null }), FLEX_CTX))
      .toMatchObject({ eligible: false, reason_code: 'PARENT_TEMPLATE_ROW' });
  });

  test('a one-time visit stays Fixed-tier — excluded even with the flex ctx', () => {
    expect(isEligibleForAutoDispatch(svc({ is_recurring: false, recurring_parent_id: null }), FLEX_CTX))
      .toMatchObject({ eligible: false, reason_code: 'NON_RECURRING' });
  });

  test('a 2nd+ occurrence just inside the legacy 14-day lock window is eligible under the flex ctx', () => {
    // 2026-06-25 is inside CTX's legacy 14-day lock (locked under plain CTX,
    // see "inside the 14-day lock window" above) — the flex ctx imposes no
    // days-out lock at all, so the visit clears eligibility here; the 73h
    // freeze itself is checked later, against the live reminder row.
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-06-25' }), FLEX_CTX))
      .toMatchObject({ eligible: true });
  });

  test('still denies on every other check (locked/excluded/inactive/status) under the flex ctx', () => {
    expect(isEligibleForAutoDispatch(svc({ auto_dispatch_locked: true }), FLEX_CTX))
      .toMatchObject({ eligible: false, reason_code: 'MANUALLY_LOCKED' });
    expect(isEligibleForAutoDispatch(svc({ customer_active: false }), FLEX_CTX))
      .toMatchObject({ eligible: false, reason_code: 'CUSTOMER_INACTIVE' });
    expect(isEligibleForAutoDispatch(svc({ status: 'cancelled' }), FLEX_CTX))
      .toMatchObject({ eligible: false, reason_code: 'CANCELLED' });
  });
});

describe('isPersonPlacedVisit', () => {
  // An in-memory reschedule_log. Rows are filtered by the predicates the
  // query sends, so a wrong column or value makes a test miss the row.
  // An in-memory reschedule_log. Rows are filtered by the predicates the
  // query sends, so a wrong column or value makes a test miss the row; the
  // newest-placement subquery is evaluated like PostgreSQL would.
  function fakeDb({ log = [], fail = false, row = null } = {}) {
    const slotChanged = (r) => r.original_date !== r.new_date || r.original_window !== r.new_window;
    return (table) => {
      if (table === 'scheduled_services') {
        return { where: () => ({ first: async () => { if (fail) throw new Error('connection reset'); return row; } }) };
      }
      if (table !== 'reschedule_log') throw new Error(`unexpected table ${table}`);
      const preds = [];
      const chain = {
        where(key, value) { preds.push((r) => String(r[key]) === String(value)); return chain; },
        whereNotNull(key) { preds.push((r) => r[key] != null); return chain; },
        whereRaw(sql) {
          if (sql === '(original_date IS DISTINCT FROM new_date OR original_window IS DISTINCT FROM new_window)') {
            preds.push(slotChanged);
          } else if (/created_at = \(SELECT max\(r2\.created_at\)/.test(sql)) {
            preds.push((r) => {
              const peers = log.filter((x) => x.scheduled_service_id === r.scheduled_service_id && x.new_date != null && slotChanged(x));
              const max = Math.max(...peers.map((x) => new Date(x.created_at).getTime()));
              return new Date(r.created_at).getTime() === max;
            });
          } else throw new Error(`unexpected raw sql ${sql}`);
          return chain;
        },
        select: async () => {
          if (fail) throw new Error('connection reset');
          return log.filter((r) => preds.every((p) => p(r)));
        },
      };
      return chain;
    };
  }
  const T1 = '2026-10-06T00:49:58Z';
  const row = (o = {}) => ({ id: 'l1', scheduled_service_id: 's1', series_move_id: 'm1', original_date: '2026-10-07', new_date: '2026-10-18', original_window: '13:00-14:00', new_window: '09:00-10:00', initiated_by: 'customer_self_serve', created_at: T1, ...o });
  const visit = { id: 's1', scheduled_date: '2026-10-18', window_start: '09:00:00' };

  test('placed when the customer moved the visit to its current date', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row()] })))
      .toMatchObject({ placed: true, reason_code: 'PERSON_PLACED', reason_description: 'Date chosen by the customer (series move m1)' });
  });

  test('a staff single-visit move counts', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by: 'admin', series_move_id: null })] })))
      .toMatchObject({ placed: true, reason_description: 'Date chosen by staff (move by admin)' });
  });

  test('customer text and call flows read as the customer', async () => {
    for (const initiated_by of ['customer_sms', 'sms_offer_ai', 'customer', 'customer_portal', 'ai_call_pipeline']) {
      expect((await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by })] }))).reason_description).toContain('the customer');
    }
  });

  test('only known automatic movers leave a moved visit optimizable; an unknown mover protects', async () => {
    for (const initiated_by of ['auto_dispatch', 'system', 'machine', 'weather_auto']) {
      expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by })] }))).toEqual({ placed: false });
    }
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by: 'some_new_flow' })] }))).toMatchObject({ placed: true });
  });

  test('a never-moved visit is optimizable', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [] }))).toEqual({ placed: false });
  });

  test('a grouped partner the move carried is protected by its own row', async () => {
    expect(await isPersonPlacedVisit({ ...visit, id: 's2' }, fakeDb({ log: [row({ id: 'l2', scheduled_service_id: 's2' })] })))
      .toMatchObject({ placed: true });
  });

  test('rows written in the same move transaction count together', async () => {
    const sameTx = row({ id: 'l9', initiated_by: 'system', series_move_id: null });
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [sameTx, row()] }))).toMatchObject({ placed: true });
  });

  test('a later audit-only row (no new_date, e.g. a no-show record) does not shadow the move', async () => {
    const noshow = row({ id: 'l2', initiated_by: 'system', series_move_id: null, created_at: '2026-10-07T12:00:00Z', new_date: null });
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by: 'admin' }), noshow] }))).toMatchObject({ placed: true });
  });

  test('not placed after a later automatic move, even one that returned the visit to the same date', async () => {
    const later = row({ id: 'l2', initiated_by: 'auto_dispatch', series_move_id: null, created_at: '2026-10-06T08:10:19Z', new_date: '2026-10-19' });
    const back = row({ id: 'l3', initiated_by: 'auto_dispatch', series_move_id: null, created_at: '2026-10-07T08:10:19Z', new_date: '2026-10-18' });
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row(), later, back] }))).toEqual({ placed: false });
  });

  test('not placed when the visit left the chosen date', async () => {
    expect(await isPersonPlacedVisit({ ...visit, scheduled_date: '2026-10-19' }, fakeDb({ log: [row()] }))).toEqual({ placed: false });
  });

  test('a staff direct date edit (date-exception stamp, no log row) protects; a later automatic move ends it', async () => {
    const edited = { ...visit, date_exception: true, date_exception_source: 'admin', date_exception_at: '2026-10-05T15:00:00Z' };
    expect(await isPersonPlacedVisit(edited, fakeDb({ log: [] }))).toMatchObject({ placed: true, reason_description: 'Date chosen by staff (date edit)' });
    const autoAfter = row({ initiated_by: 'auto_dispatch', created_at: '2026-10-06T08:10:00Z' });
    expect(await isPersonPlacedVisit(edited, fakeDb({ log: [autoAfter] }))).toEqual({ placed: false });
  });

  test('a backfill date-exception stamp is not a person', async () => {
    const backfilled = { ...visit, date_exception: true, date_exception_source: 'backfill_cadence', date_exception_at: '2026-10-05T15:00:00Z' };
    expect(await isPersonPlacedVisit(backfilled, fakeDb({ log: [] }))).toEqual({ placed: false });
  });

  test('generated replacements and unknown stamp sources are not a person', async () => {
    for (const date_exception_source of ['cancel_reseed', 'backfill_preserved', 'something_new']) {
      const v = { ...visit, date_exception: true, date_exception_source, date_exception_at: '2026-10-05T15:00:00Z' };
      expect(await isPersonPlacedVisit(v, fakeDb({ log: [] }))).toEqual({ placed: false });
    }
    const rider = { ...visit, date_exception: true, date_exception_source: 'rider_onetime_move', date_exception_at: '2026-10-05T15:00:00Z' };
    expect(await isPersonPlacedVisit(rider, fakeDb({ log: [] }))).toMatchObject({ placed: true });
  });

  test('a technician-only reassignment (same date and window) chose no date', async () => {
    const techOnly = row({ initiated_by: 'admin', series_move_id: null, original_date: '2026-10-18', new_date: '2026-10-18', original_window: '09:00-10:00', new_window: '09:00-10:00' });
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [techOnly] }))).toEqual({ placed: false });
    // ...and a later one does not hide an earlier customer choice
    const later = { ...techOnly, id: 'l2', created_at: '2026-10-07T12:00:00Z' };
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row(), later] }))).toMatchObject({ placed: true });
  });

  test('a windowless recurring due visit is never protected (the run must place it)', async () => {
    const due = { id: 's1', scheduled_date: '2026-10-18', window_start: null, recurring_dispatch_due_date: '2026-10-18' };
    expect(await isPersonPlacedVisit(due, fakeDb({ log: [row({ initiated_by: 'admin' })] }))).toEqual({ placed: false });
  });

  test('a Date scheduled_date compares as its calendar date', async () => {
    expect(await isPersonPlacedVisit({ ...visit, scheduled_date: new Date('2026-10-18T04:00:00Z') }, fakeDb({ log: [row()] })))
      .toMatchObject({ placed: true });
  });

  test('a staff lock on the row protects the visit', async () => {
    expect(await isPersonPlacedVisit({ ...visit, auto_dispatch_locked: true }, fakeDb({ log: [] })))
      .toMatchObject({ placed: true, reason_code: 'MANUALLY_LOCKED' });
  });

  test('refresh re-reads the lock and stamp the snapshot does not have (edit screen after pass 1)', async () => {
    const locked = fakeDb({ log: [], row: { auto_dispatch_locked: true } });
    expect(await isPersonPlacedVisit(visit, locked)).toEqual({ placed: false }); // snapshot only
    expect(await isPersonPlacedVisit(visit, locked, { refresh: true })).toMatchObject({ placed: true, reason_code: 'MANUALLY_LOCKED' });
    const stamped = fakeDb({ log: [], row: { auto_dispatch_locked: false, date_exception: true, date_exception_source: 'admin', date_exception_at: '2026-10-07T01:00:00Z' } });
    expect(await isPersonPlacedVisit(visit, stamped, { refresh: true })).toMatchObject({ placed: true, reason_description: 'Date chosen by staff (date edit)' });
  });

  test('refresh fails closed and degraded on a read error', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ fail: true }), { refresh: true })).toMatchObject({ placed: true, degraded: true });
  });

  test('fails closed and degraded on a read error', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ fail: true }))).toMatchObject({ placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN' });
  });
});

test('a visit the customer confirmed is never eligible, with or without a due date (owner 2026-10-09)', () => {
  expect(isEligibleForAutoDispatch(svc({ status: 'confirmed', customer_confirmed: true }), CTX))
    .toMatchObject({ eligible: false, reason_code: 'CUSTOMER_CONFIRMED' });
  expect(isEligibleForAutoDispatch(svc({ status: 'confirmed', customer_confirmed: false }), CTX))
    .toMatchObject({ eligible: true });
});
