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

  // Owner 2026-11-26: "all visits should be checked": a one-time visit and a plan's first visit may move too.
  test('a one-time visit is eligible', () => {
    expect(isEligibleForAutoDispatch(svc({ is_recurring: false, recurring_parent_id: null }), CTX)).toMatchObject({ eligible: true });
    expect(isEligibleForAutoDispatch(svc({ is_recurring: null, recurring_parent_id: null }), CTX)).toMatchObject({ eligible: true });
  });

  test("a plan's first visit (the parent row) is eligible", () => {
    expect(isEligibleForAutoDispatch(svc({ recurring_parent_id: null }), CTX)).toMatchObject({ eligible: true });
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


// Owner 2026-11-22: a customer confirmation no longer freezes a deferred occurrence either; the result is the
// same as for the unconfirmed row.
test.each([null, '09:00'])('a customer confirmation does not change a deferred occurrence with window %s', (windowStart) => {
  const base = { status: 'pending', scheduled_date: '2026-06-19', recurring_dispatch_due_date: '2026-06-19', window_start: windowStart };
  const confirmed = isEligibleForAutoDispatch(svc({ ...base, customer_confirmed: true }), CTX);
  expect(confirmed.reason_code).not.toBe('CUSTOMER_CONFIRMED');
  expect(confirmed).toEqual(isEligibleForAutoDispatch(svc({ ...base, customer_confirmed: false }), CTX));
});

// GATE_AUTO_DISPATCH_FLEX_TIER — since owner 2026-11-26 a series' first visit
// and a one-time visit are Flexible too; only a booster-month row stays out;
// eligibility.js imposes no days-out lock of its own for Flexible-tier
// visits — that lock is the 73h reminder freeze, decided later in index.js.
describe('GATE_AUTO_DISPATCH_FLEX_TIER ctx', () => {
  const FLEX_CTX = { ...CTX, flexTier: { enabled: true } };

  test('a series first visit and a one-time visit are eligible with the flex ctx', () => {
    expect(isEligibleForAutoDispatch(svc({ recurring_parent_id: null }), FLEX_CTX)).toMatchObject({ eligible: true });
    expect(isEligibleForAutoDispatch(svc({ is_recurring: false, recurring_parent_id: null }), FLEX_CTX)).toMatchObject({ eligible: true });
  });

  test('a booster-month row stays out with the flex ctx', () => {
    expect(isEligibleForAutoDispatch(svc({ is_recurring: false, recurring_parent_id: 'p1' }), FLEX_CTX))
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
  // query sends, so a wrong column or value makes a test miss the row; the
  // newest-placement subquery is evaluated like PostgreSQL would.
  function fakeDb({ log = [], fail = false, row = null, services = null } = {}) {
    const slotChanged = (r) => r.original_date !== r.new_date || r.original_window !== r.new_window;
    // PLACEMENT_SQL in JS: the date, or the first five characters of the window's start, changed.
    const startText = (w) => String(w || '').split('-')[0].slice(0, 5);
    const placed = (r) => r.original_date !== r.new_date || (r.new_window != null && r.new_window !== ''
      && startText(r.original_window) !== startText(r.new_window));
    const fake = (table) => {
      if (table === 'scheduled_services') {
        const read = { forShare: () => read, first: async () => { if (fail) throw new Error('connection reset'); return row; } };
        return { where: () => read };
      }
      if (table === 'services') {
        if (!services) throw new Error('unexpected table services');
        return { where: ({ id }) => ({ first: async () => (String(id) === String(services.id) ? services : null) }) };
      }
      if (table !== 'reschedule_log') throw new Error(`unexpected table ${table}`);
      const preds = [];
      let newestFirst = false;
      let cap = Infinity;
      const chain = {
        where(key, value) { preds.push((r) => String(r[key]) === String(value)); return chain; },
        orderBy(key, dir) {
          if (key !== 'created_at' || dir !== 'desc') throw new Error(`unexpected order ${key} ${dir}`);
          newestFirst = true;
          return chain;
        },
        limit(n) { cap = n; return chain; },
        whereNotNull(key) { preds.push((r) => r[key] != null); return chain; },
        whereRaw(sql) {
          const { PLACEMENT_SQL } = require('../services/auto-dispatch/eligibility');
          const newestOf = sql.includes('split_part') ? placed : slotChanged;
          if (sql === '(original_date IS DISTINCT FROM new_date OR original_window IS DISTINCT FROM new_window)') {
            preds.push(slotChanged);
          } else if (sql === PLACEMENT_SQL) {
            preds.push(placed);
          } else if (/created_at = \(SELECT max\(r2\.created_at\)/.test(sql)) {
            preds.push((r) => {
              const peers = log.filter((x) => x.scheduled_service_id === r.scheduled_service_id && x.new_date != null && newestOf(x));
              const max = Math.max(...peers.map((x) => new Date(x.created_at).getTime()));
              return new Date(r.created_at).getTime() === max;
            });
          } else throw new Error(`unexpected raw sql ${sql}`);
          return chain;
        },
        select: async () => {
          if (fail) throw new Error('connection reset');
          const rows = log.filter((r) => preds.every((p) => p(r)));
          if (newestFirst) rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          return rows.slice(0, cap);
        },
      };
      return chain;
    };
    // loadNewestSlotRows withIntent selects a raw after_intent column; a log row carries its own after_intent.
    fake.raw = (sql) => ({ sql });
    return fake;
  }
  const T1 = '2026-10-06T00:49:58Z';
  const row = (o = {}) => ({ id: 'l1', scheduled_service_id: 's1', series_move_id: 'm1', original_date: '2026-10-07', new_date: '2026-10-18', original_window: '13:00-14:00', new_window: '09:00-10:00', initiated_by: 'customer_self_serve', created_at: T1, ...o });
  const visit = { id: 's1', scheduled_date: '2026-10-18', window_start: '09:00:00' };

  // Owner 2026-11-26: "even reservices or reschedules by customers can be moved, if they are before the 72 hr reminders".
  test("a customer's own move no longer holds the visit", async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row()] }))).toEqual({ placed: false });
  });

  // Owner 2026-11-22: "i dont think it matters if staff pick it", then "this is all too limiting".
  test('a staff move alone no longer holds the visit, whoever on staff made it', async () => {
    for (const initiated_by of ['admin', 'admin_ib', 'admin_bulk', 'operator', 'tech']) {
      expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by, series_move_id: null })] }))).toEqual({ placed: false });
    }
  });

  test('customer self-serve, text and call moves leave the visit free too', async () => {
    for (const initiated_by of ['customer_self_serve', 'customer_sms', 'sms_offer_ai', 'customer', 'customer_portal', 'ai_call_pipeline']) {
      expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by })] }))).toEqual({ placed: false });
    }
  });

  test('no mover holds a visit by itself, a new unknown one included', async () => {
    for (const initiated_by of ['auto_dispatch', 'system', 'machine', 'weather_auto', 'day_replan', 'booking_make_room', 'admin', 'some_new_flow']) {
      expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by })] }))).toEqual({ placed: false });
    }
  });

  test('a never-moved visit is optimizable', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [] }))).toEqual({ placed: false });
  });










  // Local audit 2026-11-22 (round 3): an end-only edit never makes an asked time stale; a later change of start does.
  test('an asked time survives a later end-only edit, and ends at a later change of start', async () => {
    const askedVisit = { ...visit, customer_asked_time: true, customer_asked_time_at: '2026-10-07T00:00:00Z', date_exception_source: null };
    const longer = row({ id: 'l2', initiated_by: 'admin_bulk', series_move_id: null, created_at: '2026-10-08T12:00:00Z',
      original_date: '2026-10-18', original_window: '09:00-10:00', new_window: '09:00-10:30', after_intent: true });
    const booked = row({ initiated_by: 'admin', series_move_id: null, after_intent: false });
    expect(await isPersonPlacedVisit(askedVisit, fakeDb({ log: [booked, longer] })))
      .toMatchObject({ placed: true, reason_code: 'CUSTOMER_ASKED_TIME' });
    expect(await isPersonPlacedVisit(askedVisit, fakeDb({ log: [longer] })))
      .toMatchObject({ placed: true, reason_code: 'CUSTOMER_ASKED_TIME' });
    const restart = row({ id: 'l3', initiated_by: 'admin', series_move_id: null, created_at: '2026-10-09T12:00:00Z',
      original_date: '2026-10-18', original_window: '13:00-14:00', new_window: '09:00-10:00', after_intent: true });
    expect(await isPersonPlacedVisit(askedVisit, fakeDb({ log: [booked, longer, restart] }))).toEqual({ placed: false });
  });

  test('a staff move for the customer\'s request no longer holds either', async () => {
    for (const reason_code of ['customer_call_request', 'customer_call_request_series', 'ai_call_reschedule', 'customer_request', 'admin', null]) {
      expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row({ initiated_by: 'admin', reason_code, series_move_id: null })] })))
        .toEqual({ placed: false });
    }
  });


  // Local audit 2026-11-22 (round 5): the day-only promise's pick check reads the same placement rows.
  test('isCustomerPickedVisit: an end-only edit keeps the pick; another start ends it; a customer-request reason counts', async () => {
    const { isCustomerPickedVisit } = require('../services/auto-dispatch/eligibility');
    const longer = row({ id: 'l2', initiated_by: 'admin_bulk', series_move_id: null, created_at: '2026-10-07T12:00:00Z',
      original_date: '2026-10-18', original_window: '09:00-10:00', new_window: '09:00-10:30' });
    expect(await isCustomerPickedVisit(visit, fakeDb({ log: [row(), longer] }))).toEqual({ picked: true });
    expect(await isCustomerPickedVisit({ ...visit, window_start: '13:00:00' }, fakeDb({ log: [row()] }))).toEqual({ picked: false });
    const { window_start: _unused, ...bare } = visit;
    expect(await isCustomerPickedVisit(bare, fakeDb({ log: [row()] }))).toEqual({ picked: true });
    const requested = row({ initiated_by: 'admin', reason_code: 'ai_call_reschedule_series', series_move_id: null });
    expect(await isCustomerPickedVisit(visit, fakeDb({ log: [requested] }))).toEqual({ picked: true });
    expect(await isCustomerPickedVisit(visit, fakeDb({ log: [row({ initiated_by: 'admin' })] }))).toEqual({ picked: false });
  });


  test('not placed after a later automatic move, even one that returned the visit to the same date', async () => {
    const later = row({ id: 'l2', initiated_by: 'auto_dispatch', series_move_id: null, created_at: '2026-10-06T08:10:19Z', new_date: '2026-10-19' });
    const back = row({ id: 'l3', initiated_by: 'auto_dispatch', series_move_id: null, created_at: '2026-10-07T08:10:19Z', new_date: '2026-10-18' });
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [row(), later, back] }))).toEqual({ placed: false });
  });

  test('not placed when the visit left the chosen date', async () => {
    expect(await isPersonPlacedVisit({ ...visit, scheduled_date: '2026-10-19' }, fakeDb({ log: [row()] }))).toEqual({ placed: false });
  });

  test('a customer date edit (date-exception stamp, no log row) no longer holds; nor a staff edit', async () => {
    const edited = { ...visit, date_exception: true, date_exception_source: 'customer_self_serve', date_exception_at: '2026-10-05T15:00:00Z' };
    expect(await isPersonPlacedVisit(edited, fakeDb({ log: [] }))).toEqual({ placed: false });
    const autoAfter = row({ initiated_by: 'auto_dispatch', created_at: '2026-10-06T08:10:00Z' });
    expect(await isPersonPlacedVisit(edited, fakeDb({ log: [autoAfter] }))).toEqual({ placed: false });
    const staffEdit = { ...edited, date_exception_source: 'admin' };
    expect(await isPersonPlacedVisit(staffEdit, fakeDb({ log: [] }))).toEqual({ placed: false });
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
    expect(await isPersonPlacedVisit(rider, fakeDb({ log: [] }))).toEqual({ placed: false });
  });

  test('a technician-only reassignment (same date and window) chose no date', async () => {
    const techOnly = row({ initiated_by: 'admin', series_move_id: null, original_date: '2026-10-18', new_date: '2026-10-18', original_window: '09:00-10:00', new_window: '09:00-10:00' });
    expect(await isPersonPlacedVisit(visit, fakeDb({ log: [techOnly] }))).toEqual({ placed: false });
  });

  test('a windowless recurring due visit is never protected (the run must place it)', async () => {
    const due = { id: 's1', scheduled_date: '2026-10-18', window_start: null, recurring_dispatch_due_date: '2026-10-18' };
    expect(await isPersonPlacedVisit(due, fakeDb({ log: [row({ initiated_by: 'admin' })] }))).toEqual({ placed: false });
  });


  // Owner 2026-11-26: "lock waves assessments, but clear the rest".
  test('a Waves Assessment is held, by its name or by its catalog row', async () => {
    expect(await isPersonPlacedVisit({ ...visit, service_type: 'Waves Assessment', service_id: null }, fakeDb({ log: [] })))
      .toMatchObject({ placed: true, reason_code: 'WAVES_ASSESSMENT_FIXED' });
    const byCatalog = fakeDb({ log: [], services: { id: 'cat1', service_key: 'lawn_inspection', name: 'Lawn Look' } });
    expect(await isPersonPlacedVisit({ ...visit, service_type: 'Lawn Look', service_id: 'cat1' }, byCatalog))
      .toMatchObject({ placed: true, reason_code: 'WAVES_ASSESSMENT_FIXED' });
    const pest = fakeDb({ log: [], services: { id: 'cat2', service_key: 'general_pest', name: 'General Pest Control' } });
    expect(await isPersonPlacedVisit({ ...visit, service_type: 'General Pest Control', service_id: 'cat2' }, pest)).toEqual({ placed: false });
  });

  test('a Waves Assessment is held on the apply-time refresh too', async () => {
    const renamed = fakeDb({ log: [], row: { auto_dispatch_locked: false, service_type: 'Waves Assessment', service_id: null } });
    expect(await isPersonPlacedVisit({ ...visit, customer_asked_time: null, date_exception_source: null, service_type: 'X', service_id: null },
      renamed, { refresh: true })).toMatchObject({ placed: true, reason_code: 'WAVES_ASSESSMENT_FIXED' });
  });

  test('an unreadable catalog row holds the visit (fail closed)', async () => {
    expect(await isPersonPlacedVisit({ ...visit, service_type: 'Lawn Look', service_id: 'cat1' }, fakeDb({ log: [] })))
      .toMatchObject({ placed: true, degraded: true });
  });

  test('a staff lock on the row protects the visit', async () => {
    expect(await isPersonPlacedVisit({ ...visit, auto_dispatch_locked: true }, fakeDb({ log: [] })))
      .toMatchObject({ placed: true, reason_code: 'MANUALLY_LOCKED' });
  });

  // A snapshot with the intent and stamp columns (the night run selects scheduled_services.*).
  const snapshot = { ...visit, customer_asked_time: null, customer_asked_time_at: null, date_exception: false, date_exception_source: null,
    service_type: 'General Pest Control', service_id: null };

  test('refresh re-reads the lock and stamp the snapshot does not have (edit screen after pass 1)', async () => {
    const locked = fakeDb({ log: [], row: { auto_dispatch_locked: true } });
    expect(await isPersonPlacedVisit(snapshot, locked)).toEqual({ placed: false }); // snapshot only
    expect(await isPersonPlacedVisit(snapshot, locked, { refresh: true })).toMatchObject({ placed: true, reason_code: 'MANUALLY_LOCKED' });
    const stamped = fakeDb({ log: [], row: { auto_dispatch_locked: false, date_exception: true, date_exception_source: 'customer_self_serve', date_exception_at: '2026-10-07T01:00:00Z' } });
    expect(await isPersonPlacedVisit(snapshot, stamped, { refresh: true })).toEqual({ placed: false }); // owner 2026-11-26
  });

  test('a snapshot without the intent or stamp columns is read fresh, never taken as "not asked"', async () => {
    const lockedRow = fakeDb({ log: [], row: { auto_dispatch_locked: true } });
    expect(await isPersonPlacedVisit(visit, lockedRow)).toMatchObject({ placed: true, reason_code: 'MANUALLY_LOCKED' });
  });

  // Owner 2026-11-22: "i dont think it matters if staff pick it or tom confirmed it".
  test('a customer confirmation no longer holds the visit, on the snapshot or on refresh', async () => {
    const confirmed = fakeDb({ log: [], row: { auto_dispatch_locked: false, customer_confirmed: true } });
    expect(await isPersonPlacedVisit({ ...snapshot, customer_confirmed: true }, confirmed)).toEqual({ placed: false });
    expect(await isPersonPlacedVisit(snapshot, confirmed, { refresh: true })).toEqual({ placed: false });
  });

  test('the customer asked for this time (no move since): held; recorded "day only" does not hold by itself', async () => {
    const askedRow = { ...snapshot, customer_asked_time: true, customer_asked_time_at: '2026-10-05T15:00:00Z' };
    expect(await isPersonPlacedVisit(askedRow, fakeDb({ log: [] })))
      .toMatchObject({ placed: true, reason_code: 'CUSTOMER_ASKED_TIME', reason_description: 'The customer asked for this time' });
    expect(await isPersonPlacedVisit({ ...askedRow, customer_asked_time: false }, fakeDb({ log: [] }))).toEqual({ placed: false });
  });

  test('recorded "day only" never holds, whoever made the move', async () => {
    const dayOnly = { ...visit, customer_asked_time: false, customer_asked_time_at: '2026-10-06T00:49:58Z', date_exception_source: null };
    const requested = row({ initiated_by: 'admin', reason_code: 'ai_call_reschedule', series_move_id: null, after_intent: false });
    expect(await isPersonPlacedVisit(dayOnly, fakeDb({ log: [requested] }))).toEqual({ placed: false });
    expect(await isPersonPlacedVisit(dayOnly, fakeDb({ log: [row({ after_intent: false })] }))).toEqual({ placed: false });
  });

  test('refresh sees an asked time that landed after the snapshot', async () => {
    const askedLater = fakeDb({ log: [], row: { auto_dispatch_locked: false, customer_asked_time: true, customer_asked_time_at: '2026-10-07T01:00:00Z' } });
    expect(await isPersonPlacedVisit(snapshot, askedLater)).toEqual({ placed: false }); // snapshot only
    expect(await isPersonPlacedVisit(snapshot, askedLater, { refresh: true })).toMatchObject({ placed: true, reason_code: 'CUSTOMER_ASKED_TIME' });
  });

  test('refresh fails closed and degraded on a read error', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ fail: true }), { refresh: true })).toMatchObject({ placed: true, degraded: true });
  });

  test('fails closed and degraded on a read error', async () => {
    expect(await isPersonPlacedVisit(visit, fakeDb({ fail: true }))).toMatchObject({ placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN' });
  });
});

// Owner 2026-11-22 ("i dont think it matters if staff pick it or tom confirmed it"; "this is all too limiting"):
// replaces the 2026-10-09 rule that a confirmed visit is never eligible.
test('a visit the customer confirmed is eligible like any other', () => {
  expect(isEligibleForAutoDispatch(svc({ status: 'confirmed', customer_confirmed: true }), CTX)).toMatchObject({ eligible: true });
  expect(isEligibleForAutoDispatch(svc({ status: 'confirmed', customer_confirmed: false }), CTX)).toMatchObject({ eligible: true });
});

// One read for many series (Codex #6208 r21 P2).
describe('lapsedPlanKeys', () => {
  const { lapsedPlanKeys, planKey } = require('../services/auto-dispatch/eligibility');
  const rows = [{ id: 'a', customer_id: 'c1', recurring_parent_id: 'p1' }, { id: 'b', customer_id: 'c2', recurring_parent_id: 'p2' }, { id: 'c', customer_id: 'c1', recurring_parent_id: 'p1' }];
  const dbWith = (select) => {
    const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), whereNull: jest.fn(() => q), select };
    const db = jest.fn(() => q);
    db.q = q;
    return db;
  };

  test('reads every series once and keys a lapse by customer and series', async () => {
    const db = dbWith(jest.fn(async () => [{ recurring_parent_id: 'p1', customer_id: 'c1' }, { recurring_parent_id: 'p2', customer_id: 'other' }]));
    const lapsed = await lapsedPlanKeys(rows, db);
    expect(db).toHaveBeenCalledTimes(1);
    expect(db.q.whereIn).toHaveBeenCalledWith('recurring_parent_id', ['p1', 'p2']);
    expect(db.q.where).toHaveBeenCalledWith('alert_type', 'plan_lapsed');
    expect(rows.map((r) => lapsed.has(planKey(r)))).toEqual([true, false, true]);
  });

  test('an unreadable table lapses nothing, and no rows reads nothing', async () => {
    expect((await lapsedPlanKeys(rows, dbWith(jest.fn(async () => { throw new Error('no table'); })))).size).toBe(0);
    const db = dbWith(jest.fn());
    expect((await lapsedPlanKeys([], db)).size).toBe(0);
    expect(db).not.toHaveBeenCalled();
  });
});
