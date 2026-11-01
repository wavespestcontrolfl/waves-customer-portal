// Booking-miss bells close themselves (owner 2026-10-24: "Alerts must clear once
// the thing happened"). classifyOpenBookingMiss is pure: five verdicts, one per
// way a call's open bells end. The close pass tests run the whole tick against a
// stand-in database and read the writes it makes. All fixture identities are
// synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), alertRingOnceLive: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));

const mockState = { calls: [], booked: [], customers: [], open: [], updates: [], inserts: [], failClose: false, notificationFilters: [] };

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const ctx = { table, ids: null, callIds: null, probe: false };
    const rows = () => {
      // The close pass reads only the calls its open bells name (whereIn id).
      if (table === 'call_log') return ctx.callIds ? mockState.calls.filter((c) => ctx.callIds.includes(c.id)) : mockState.calls;
      if (table === 'scheduled_services') return mockState.booked;
      if (table === 'customers') return mockState.customers;
      if (table === 'notifications') return ctx.probe ? mockState.open : [];
      return [];
    };
    const b = {
      where: () => b,
      whereRaw: (sql, args) => { if (table === 'notifications') mockState.notificationFilters.push([sql, args]); return b; },
      whereNotNull: () => b,
      whereNull: () => { ctx.probe = true; return b; },
      whereIn: (col, ids) => {
        if (table === 'notifications' && col === 'id') ctx.ids = ids;
        if (table === 'call_log' && col === 'id') ctx.callIds = ids;
        return b;
      },
      groupByRaw: () => b,
      orderBy: () => b,
      select: () => b,
      first: () => Promise.resolve(undefined),
      pluck: (col) => Promise.resolve(rows().map((r) => r[col])),
      insert: (payload) => { mockState.inserts.push({ table, payload }); return Promise.resolve([]); },
      update: (payload) => {
        if (mockState.failClose) return Promise.reject(new Error('db down'));
        mockState.updates.push({ table, ids: ctx.ids, payload });
        return Promise.resolve(ctx.ids ? ctx.ids.length : 1);
      },
      then: (res, rej) => Promise.resolve(rows()).then(res, rej),
    };
    return b;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = jest.fn((sql, args) => ({ raw: sql, args }));
  return db;
});

jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(),
  markAdminDone: jest.fn(async (ids) => ids.length),
  normalizeAdminText: ({ title, body, detail }) => ({ title, body, detail }),
  _private: {
    openToCloser: (query, by) => { query.closedBy = by; return query; },
    doneColumns: ({ by, resolution }) => ({ done_by: by, resolution }),
  },
}));

const logger = require('../services/logger');
const {
  runCallBookingMissWatchdog,
  classifyOpenBookingMiss,
  OTHER_DAY_MATCH_DAYS,
  PAST_AFTER_DAYS,
} = require('../services/call-booking-miss-watchdog');

// Mon Oct 26 2026, 12:00 ET. The call agreed Wed Nov 4 at 4:00 PM ET, 9 days out.
const NOW = new Date('2026-10-26T16:00:00Z');
const CALL_ID = 'call-close-1';
const CALL_AT = '2026-10-20T14:00:00Z';
const AFTER_CALL = '2026-10-20T15:00:00Z';

const call = (over = {}) => ({
  id: CALL_ID, twilio_call_sid: 'CAsynthetic700', customer_id: 'cust-1', direction: 'outbound', created_at: CALL_AT,
  from_phone: '+19415550100', to_phone: '+19415550111',
  ai_extraction_enriched: {
    caller: { name_full: 'Sam Sample' },
    service_request: { specific_service_name: 'Waves Assessment' },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-11-04T16:00:00-05:00' },
  },
  ...over,
});
const SLOT = { dateET: '2026-11-04', minutes: 16 * 60, name: 'Sam Sample', service: 'Waves Assessment' };
const visit = (over = {}) => ({
  id: 'visit-1', customer_id: 'cust-1', status: 'confirmed', service_type: 'Waves Assessment', sched_date: '2026-11-04', window_start: '16:00:00',
  created_at: AFTER_CALL, source_call_log_id: null, notes: null, internal_notes: null, ...over,
});
const bell = (id, minute, over = {}) => ({
  id, title: "Schedule — book Sam Sample's Waves Assessment", created_at: `2026-10-20T15:${minute}:00Z`,
  mismatch_visit_id: null, mismatch_date: null, mismatch_time: null, ...over,
});
const classify = (rows, open = [bell('n1', '10')], opts = {}) => classifyOpenBookingMiss(call(opts.call), opts.slot || SLOT, rows, open, { now: opts.now || NOW, namesakes: opts.namesakes || new Map() });

describe('classifyOpenBookingMiss', () => {
  test('booked: the visit on the agreed slot closes every bell, naming the visit', () => {
    const plan = classify([visit({ sched_date: '2026-11-04' })], [bell('n1', '10'), bell('n2', '20')]);
    expect(plan.verdict).toBe('booked');
    expect(plan.closes).toEqual([{ ids: ['n2', 'n1'], resolution: 'Visit booked for Wed Nov 4 at 4:00 PM' }]);
    expect(plan.keep).toBeNull();
    expect(plan.ring).toBeNull();
  });

  test('booked: a visit booked from the call and later cancelled still counts (provenance rule unchanged)', () => {
    const plan = classify([visit({ status: 'cancelled', sched_date: '2026-11-10', source_call_log_id: CALL_ID })]);
    expect(plan.verdict).toBe('booked');
    expect(plan.closes).toEqual([{ ids: ['n1'], resolution: 'Visit booked for Tue Nov 10 at 4:00 PM, later cancelled' }]);
  });

  test('done_other_day: the call\'s own customer completed a later visit on another day', () => {
    const plan = classify([visit({ status: 'completed', sched_date: '2026-10-29', window_start: '09:00:00' })]);
    expect(plan.verdict).toBe('done_other_day');
    expect(plan.closes).toEqual([{ ids: ['n1'], resolution: 'Visit done Thu Oct 29' }]);
  });

  test('a namesake\'s completed visit never closes: it may be another person', () => {
    const namesakes = new Map([[CALL_ID, new Set(['cust-2'])]]);
    const plan = classify([visit({ customer_id: 'cust-2', status: 'completed', sched_date: '2026-10-29' })], [bell('n1', '10')], { namesakes });
    expect(plan.verdict).toBe('still_missed');
    expect(plan.closes).toEqual([]);
    expect(plan.keep).toBe('n1');
  });

  test('a namesake\'s live visit on another day is a date check', () => {
    const namesakes = new Map([[CALL_ID, new Set(['cust-2'])]]);
    const plan = classify([visit({ customer_id: 'cust-2', sched_date: '2026-10-29' })], [bell('n1', '10')], { namesakes });
    expect(plan.verdict).toBe('booked_other_day');
  });

  test('booked_other_day: office booked Wed Oct 28 4:00 PM for an agreed Wed Nov 4 4:00 PM', () => {
    const plan = classify([visit({ id: 'visit-9', sched_date: '2026-10-28' })]);
    expect(plan.verdict).toBe('booked_other_day');
    expect(plan.mismatch).toEqual({ visit_id: 'visit-9', date: '2026-10-28', time: '16:00' });
    // A wrong-day booking is a new episode: ring a fresh bell (keyed by the bell it replaces), then close the old one.
    expect(plan.ring).toEqual({ mismatch: plan.mismatch, dedupeKey: `call-booking-miss-date:${CALL_ID}:n1:visit-9:2026-10-28:16:00` });
    expect(plan.closes).toEqual([{ ids: ['n1'], resolution: 'Replaced by a date check' }]);
    expect(plan.keep).toBeNull();
  });

  test('booked_other_day: the same day outside the window tolerance', () => {
    const plan = classify([visit({ sched_date: '2026-11-04', window_start: '08:00:00' })]);
    expect(plan.verdict).toBe('booked_other_day');
    expect(plan.mismatch.time).toBe('08:00');
  });

  test('booked_other_day: raises once for a changed visit, and is a no-op once the newest bell shows it', () => {
    const rows = [visit({ id: 'visit-9', sched_date: '2026-10-28' })];
    const first = classify(rows, [bell('n1', '10'), bell('n2', '20')]);
    expect(first.ring.mismatch).toEqual({ visit_id: 'visit-9', date: '2026-10-28', time: '16:00' });
    expect(first.closes).toEqual([{ ids: ['n2', 'n1'], resolution: 'Replaced by a date check' }]);
    const stamped = { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' };
    const same = classify(rows, [bell('n1', '10'), bell('n2', '20', stamped)]);
    expect(same.ring).toBeNull();
    expect(same.keep).toBe('n2');
    expect(same.closes).toEqual([{ ids: ['n1'], resolution: 'Replaced by a newer alert for this call' }]);
    // The office moved the visit to another time: a new date check.
    expect(classify([visit({ id: 'visit-9', sched_date: '2026-10-28', window_start: '10:00:00' })], [bell('n2', '20', stamped)]).ring.mismatch).toMatchObject({ time: '10:00' });
  });

  test('the date check is answered by the booked visit moving to the agreed slot', () => {
    expect(classify([visit({ id: 'visit-9', sched_date: '2026-11-04' })], [bell('n2', '20', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' })]).verdict).toBe('booked');
  });

  test('a visit more than the match window from the agreed day is not the answer', () => {
    const far = new Date(Date.parse('2026-11-04T12:00:00Z') + (OTHER_DAY_MATCH_DAYS + 1) * 86400000).toISOString().slice(0, 10);
    expect(classify([visit({ sched_date: far }), visit({ id: 'v2', status: 'completed', sched_date: far })]).verdict).toBe('still_missed');
  });

  describe('a standing date check follows its own visit (pre-push P1)', () => {
    const check = (over = {}) => bell('d1', '40', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00', ...over });

    test('its visit cancelled or deleted: the bell turns back into "book it" (raise first, then close)', () => {
      for (const rows of [[visit({ id: 'visit-9', sched_date: '2026-10-28', status: 'cancelled' })], []]) {
        const plan = classify(rows, [bell('n1', '10'), check()]);
        expect(plan.verdict).toBe('still_missed');
        expect(plan.ring).toEqual({ mismatch: null, dedupeKey: `call-booking-miss-rebook:${CALL_ID}:d1` });
        expect(plan.closes).toEqual([{ ids: ['d1', 'n1'], resolution: 'The booked visit is gone; replaced by a new alert to book it' }]);
      }
    });

    test('its visit moved beyond the match window is still followed: a new date check, not "book it"', () => {
      const plan = classify([visit({ id: 'visit-9', sched_date: '2026-12-02' })], [check()]);
      expect(plan.verdict).toBe('booked_other_day');
      expect(plan.ring.mismatch).toEqual({ visit_id: 'visit-9', date: '2026-12-02', time: '16:00' });
    });

    test('its visit completed on the wrong day closes the bell, even beyond the match window', () => {
      const plan = classify([visit({ id: 'visit-9', sched_date: '2026-12-02', status: 'completed' })], [check()]);
      expect(plan.verdict).toBe('done_other_day');
      expect(plan.closes).toEqual([{ ids: ['d1'], resolution: 'Visit done Wed Dec 2' }]);
    });

    test('a plain "book it" bell with nothing booked stays as it is (no rebook)', () => {
      const plan = classify([], [bell('n1', '10')]);
      expect(plan).toMatchObject({ verdict: 'still_missed', ring: null, keep: 'n1', closes: [] });
    });
  });

  test('a later visit for another service never answers the call (pre-push P1)', () => {
    for (const status of ['completed', 'confirmed']) {
      expect(classify([visit({ status, sched_date: '2026-10-29', service_type: 'Every 6 Weeks Lawn Care Service' })]).verdict).toBe('still_missed');
    }
    // No agreed service known: no other-day verdict either.
    expect(classify([visit({ sched_date: '2026-10-29' })], [bell('n1', '10')], { slot: { ...SLOT, service: null } }).verdict).toBe('still_missed');
  });

  test('the service name matches whatever its spacing and case; a title cut with an ellipsis matches by prefix', () => {
    expect(classify([visit({ sched_date: '2026-10-28', service_type: '  waves   ASSESSMENT ' })]).verdict).toBe('booked_other_day');
    const cut = { ...SLOT, service: 'Waves Assess…' };
    expect(classify([visit({ sched_date: '2026-10-28' })], [bell('n1', '10')], { slot: cut }).verdict).toBe('booked_other_day');
    expect(classify([visit({ sched_date: '2026-10-28', service_type: 'Waves' })], [bell('n1', '10')], { slot: cut }).verdict).toBe('still_missed');
  });

  test('a visit created before the call is not a later visit', () => {
    expect(classify([visit({ sched_date: '2026-10-28', created_at: '2026-10-19T10:00:00Z' })]).verdict).toBe('still_missed');
  });

  test('a cancelled or skipped later visit on another day is nothing', () => {
    for (const status of ['cancelled', 'rescheduled', 'skipped', 'no_show']) {
      expect(classify([visit({ sched_date: '2026-10-28', status })]).verdict).toBe('still_missed');
    }
  });

  test('past: no visit, agreed day 14 days ago closes; 13 days ago stays', () => {
    const slotAgo = (days) => ({ ...SLOT, dateET: new Date(Date.parse('2026-10-26T12:00:00Z') - days * 86400000).toISOString().slice(0, 10) });
    const old = classify([], [bell('n1', '10'), bell('n2', '20')], { slot: slotAgo(PAST_AFTER_DAYS) });
    expect(old.verdict).toBe('past');
    expect(old.closes).toEqual([{ ids: ['n2', 'n1'], resolution: 'Agreed day passed with no visit booked' }]);
    expect(classify([], [bell('n1', '10')], { slot: slotAgo(PAST_AFTER_DAYS - 1) }).verdict).toBe('still_missed');
  });

  test('still_missed: only the newest bell is kept, older duplicates close as replaced', () => {
    const plan = classify([], [bell('n1', '10'), bell('n3', '30'), bell('n2', '20')]);
    expect(plan.verdict).toBe('still_missed');
    expect(plan.keep).toBe('n3');
    expect(plan.closes).toEqual([{ ids: ['n2', 'n1'], resolution: 'Replaced by a newer alert for this call' }]);
  });

  test('with no open bells it is a verdict only (the ring path)', () => {
    const plan = classify([visit({ sched_date: '2026-10-28' })], []);
    expect(plan).toMatchObject({ verdict: 'booked_other_day', closes: [], keep: null, ring: null });
  });

  // Owner 2026-11-01: Dismiss on the Dispatch held row means the office will not book it.
  test('dismissed: a call whose held row was dismissed closes every bell, with nothing booked', () => {
    const plan = classify([], [bell('n1', '10'), bell('n2', '20')], { call: { held_visit_dismissed_at: '2026-10-21T13:00:00.000Z' } });
    expect(plan).toMatchObject({ verdict: 'dismissed', keep: null, ring: null });
    expect(plan.closes).toEqual([{ ids: ['n2', 'n1'], resolution: 'Dismissed on Dispatch: not booking' }]);
  });

  test('a dismissed call that was booked anyway closes as booked, and a later visit on another day as dismissed', () => {
    const dismissed = { call: { held_visit_dismissed_at: '2026-10-21T13:00:00.000Z' } };
    expect(classify([visit({ sched_date: '2026-11-04' })], [bell('n1', '10')], dismissed).verdict).toBe('booked');
    const elsewhere = classify([visit({ sched_date: '2026-10-28' })], [bell('n1', '10')], dismissed);
    expect(elsewhere).toMatchObject({ verdict: 'dismissed', ring: null });
  });
});

describe('close pass', () => {
  const NotificationService = require('../services/notification-service');
  const { planOpenBookingMissBells } = require('../services/call-booking-miss-watchdog');
  const stamp = { confirmed_date_et: '2026-11-04', confirmed_time_et: '16:00' };
  const wrongWeek = () => [visit({ id: 'visit-9', sched_date: '2026-10-28' })];
  const DATE_KEY = `call-booking-miss-date:${CALL_ID}:n2:visit-9:2026-10-28:16:00`;
  beforeEach(() => {
    mockState.calls = [call()];
    mockState.booked = [];
    mockState.customers = [];
    mockState.open = [];
    mockState.updates = [];
    mockState.inserts = [];
    mockState.failClose = false;
    NotificationService.notifyAdmin.mockReset();
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-date', deduped: false });
    logger.warn.mockClear();
  });
  const tick = () => runCallBookingMissWatchdog({ now: NOW });
  const open = (id, minute, over = {}) => ({ ...bell(id, minute, over), call_log_id: CALL_ID, ...stamp });

  test('a dismissed call: its bells close as dismissed and nothing rings', async () => {
    mockState.calls = [call({ held_visit_dismissed_at: '2026-10-21T13:00:00.000Z' })];
    mockState.open = [open('n1', '10')];
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, raised: 0, alerted: 0 });
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['n1'], payload: { done_by: 'call-booking-miss', resolution: 'Dismissed on Dispatch: not booking' } }]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('closes a booked call\'s bells even when nothing new rings', async () => {
    mockState.calls = [call({ created_at: '2026-07-01T14:00:00Z' })];
    mockState.open = [open('n1', '10'), open('n2', '20')];
    mockState.booked = [visit({ created_at: '2026-07-01T15:00:00Z' })];
    const result = await tick();
    expect(result).toMatchObject({ closed: 2, raised: 0 });
    expect(result).not.toHaveProperty('rewritten');
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['n2', 'n1'], payload: { done_by: 'call-booking-miss', resolution: 'Visit booked for Wed Nov 4 at 4:00 PM' } }]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a visit on another day rings one fresh date check, then closes the old bells', async () => {
    mockState.open = [open('n1', '10'), open('n2', '20')];
    mockState.booked = wrongWeek();
    const result = await tick();
    expect(result).toMatchObject({ closed: 2, raised: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title).toBe("Schedule — check Sam Sample's visit date");
    expect(why).toBe('Booked Wed Oct 28 at 4:00 PM; the call agreed Wed Nov 4 at 4:00 PM.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: DATE_KEY,
      link: '/admin/dispatch?tab=schedule&date=2026-10-28',
      metadata: {
        call_log_id: CALL_ID, customer_id: 'cust-1', confirmed_date_et: '2026-11-04', confirmed_time_et: '16:00', confirmed_service: 'Waves Assessment',
        mismatch: { visit_id: 'visit-9', date: '2026-10-28', time: '16:00' }, doneWhen: 'visit_booked', subject: { type: 'call', id: CALL_ID },
      },
    });
    expect(opts.dedupeWindowMs).toBeUndefined();
    expect(opts.detail).toMatch(/^Sam Sample \(\+19415550111\) agreed Waves Assessment for Wed Nov 4 at 4:00 PM on a outbound call at /);
    expect(opts.detail).toMatch(/The visit on the calendar is Wed Oct 28 at 4:00 PM\. Move it to the agreed day/);
    // The old rows close only after the raise, as replaced by the date check; nothing is rewritten.
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['n2', 'n1'], payload: { done_by: 'call-booking-miss', resolution: 'Replaced by a date check' } }]);
    expect(mockState.updates.some((u) => 'read_at' in u.payload || 'metadata' in u.payload)).toBe(false);
  });

  test('a date check that already exists under the key (a person marked it Done) is not raised again, and the old bells close', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-standing', deduped: true });
    mockState.open = [open('n1', '10')];
    mockState.booked = wrongWeek();
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, raised: 0 });
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['n1'], payload: { done_by: 'call-booking-miss', resolution: 'Replaced by a date check' } }]);
  });

  test('a visit moved A -> B -> A rings a fresh date check for A again (pre-push P1: no stale key match)', async () => {
    // Back on A while the open bell is B's date check: the key names the bell it replaces.
    mockState.open = [open('d2', '30', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-30', mismatch_time: '16:00' })];
    mockState.booked = wrongWeek();
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, raised: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe(`call-booking-miss-date:${CALL_ID}:d2:visit-9:2026-10-28:16:00`);
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['d2'], payload: { done_by: 'call-booking-miss', resolution: 'Replaced by a date check' } }]);
  });

  test('a date check whose visit was cancelled rings a fresh "book it" bell, then closes', async () => {
    mockState.open = [open('d1', '40', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' })];
    mockState.booked = [visit({ id: 'visit-9', sched_date: '2026-10-28', status: 'cancelled' })];
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, raised: 1 });
    const [, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toBe("Schedule — book Sam Sample's Waves Assessment");
    expect(why).toBe('Confirmed Wed Nov 4 at 4:00 PM on a call; nothing is on the calendar.');
    expect(opts.dedupeKey).toBe(`call-booking-miss-rebook:${CALL_ID}:d1`);
    expect(opts.metadata).toMatchObject({ confirmed_service: 'Waves Assessment' });
    expect(opts.metadata).not.toHaveProperty('mismatch');
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['d1'], payload: { done_by: 'call-booking-miss', resolution: 'The booked visit is gone; replaced by a new alert to book it' } }]);
  });

  test('second pass after the replacement: with the call reprocessed, the date check still closes when its visit is done', async () => {
    // The call no longer confirms a slot; the date check's own stamps (date, time, service) stand in.
    mockState.calls = [call({ ai_extraction_enriched: { caller: { name_full: 'Sam Sample' }, scheduling: { status: 'none' } } })];
    mockState.open = [open('d1', '40', {
      title: "Schedule — check Sam Sample's visit date", confirmed_service: 'Waves Assessment',
      mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00',
    })];
    mockState.booked = [visit({ id: 'visit-9', sched_date: '2026-10-28', status: 'completed' })];
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, raised: 0 });
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['d1'], payload: { done_by: 'call-booking-miss', resolution: 'Visit done Wed Oct 28' } }]);
  });

  test('the close pass and the ring path share one alert budget per run (pre-push P1)', async () => {
    const { MAX_ALERTS_PER_RUN } = require('../services/call-booking-miss-watchdog');
    const n = MAX_ALERTS_PER_RUN + 1;
    mockState.calls = [];
    mockState.open = [];
    mockState.booked = [];
    for (let i = 0; i < n; i += 1) {
      mockState.calls.push(call({ id: `c${i}`, customer_id: `cust-${i}` }));
      mockState.open.push({ ...open(`n${i}`, '10'), call_log_id: `c${i}` });
      mockState.booked.push(visit({ id: `v${i}`, customer_id: `cust-${i}`, sched_date: '2026-10-28' }));
    }
    // A fresh miss inside the first-ring window: it would ring if any budget were left.
    mockState.calls.push(call({ id: 'c-new', customer_id: 'cust-new', created_at: '2026-10-25T14:00:00Z' }));
    const result = await tick();
    expect(result).toMatchObject({ raised: MAX_ALERTS_PER_RUN, alerted: 0, closed: MAX_ALERTS_PER_RUN });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN);
    // The plan over budget keeps its old bell open for the next tick.
    const closedIds = mockState.updates.flatMap((u) => u.ids);
    expect(closedIds).toHaveLength(MAX_ALERTS_PER_RUN);
    expect(closedIds).not.toContain(`n${n - 1}`);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/close pass: alert cap hit \(8\); 1 replacement\(s\) wait for the next tick/));
  });

  test('a raise that fails closes nothing: the alert is never lost', async () => {
    mockState.open = [open('n1', '10')];
    mockState.booked = wrongWeek();
    for (const failure of [() => Promise.resolve(null), () => Promise.reject(new Error('insert down')), () => Promise.resolve({ id: null, suppressed: true })]) {
      NotificationService.notifyAdmin.mockImplementation(failure);
      const result = await tick();
      expect(result).toMatchObject({ closed: 0, raised: 0 });
    }
    expect(mockState.updates).toEqual([]);
  });

  test('no-op when the newest open bell already shows this visit; older duplicates close as replaced', async () => {
    mockState.open = [open('n1', '10'), open('n2', '20', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' })];
    mockState.booked = wrongWeek();
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, raised: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['n1'], payload: { done_by: 'call-booking-miss', resolution: 'Replaced by a newer alert for this call' } }]);
  });

  test('the date check bell\'s own stamp stands in when the call no longer confirms a slot', async () => {
    mockState.calls = [call({ ai_extraction_enriched: { caller: { name_full: 'Sam Sample' }, scheduling: { status: 'none' } } })];
    mockState.open = [open('n1', '10')];
    mockState.booked = wrongWeek();
    await tick();
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toBe("Schedule — check Sam Sample's visit date");
  });

  test('a call with neither a slot nor a stamp is left alone', async () => {
    mockState.calls = [call({ ai_extraction_enriched: null })];
    mockState.open = [{ ...open('n1', '10'), confirmed_date_et: null, confirmed_time_et: null }];
    expect(await tick()).toMatchObject({ closed: 0, raised: 0 });
    expect(mockState.updates).toEqual([]);
  });

  test('leaves a still-missed single bell alone', async () => {
    mockState.open = [open('n1', '10')];
    expect(await tick()).toMatchObject({ closed: 0, raised: 0 });
    expect(mockState.updates).toEqual([]);
  });

  test('a close that fails logs a warning and never fails the tick', async () => {
    mockState.open = [open('n1', '10')];
    mockState.booked = [visit()];
    mockState.failClose = true;
    const result = await tick();
    expect(result).toMatchObject({ skipped: false, closed: 0 });
    expect(logger.warn.mock.calls.some(([msg]) => /failed to close/.test(msg))).toBe(true);
  });

  describe('dry run (the plan on its own)', () => {
    test('reads everything, writes nothing, and returns one plan per call', async () => {
      mockState.open = [open('n1', '10'), open('n2', '20')];
      mockState.booked = wrongWeek();
      const plans = await planOpenBookingMissBells({ now: NOW });
      const mismatch = { visit_id: 'visit-9', date: '2026-10-28', time: '16:00' };
      expect(plans.map(({ call: c, plan }) => ({ callId: c.id, ...plan }))).toEqual([{
        callId: CALL_ID, verdict: 'booked_other_day', row: expect.objectContaining({ id: 'visit-9' }), mismatch, keep: null,
        ring: { mismatch, dedupeKey: DATE_KEY }, closes: [{ ids: ['n2', 'n1'], resolution: 'Replaced by a date check' }],
      }]);
      expect(mockState.updates).toEqual([]);
      expect(mockState.inserts).toEqual([]);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    test('plans cover a booked call and a still-missed duplicate pair too', async () => {
      mockState.calls = [call(), call({ id: 'call-close-2', customer_id: 'cust-2', twilio_call_sid: 'CAsynthetic701' })];
      mockState.open = [open('n1', '10'), open('n2', '20'), { ...open('n3', '30'), call_log_id: 'call-close-2' }];
      mockState.booked = [visit({ sched_date: '2026-11-04' })];
      const plans = await planOpenBookingMissBells({ now: NOW });
      const byCall = Object.fromEntries(plans.map(({ call: c, plan }) => [c.id, plan]));
      expect(byCall[CALL_ID]).toMatchObject({ verdict: 'booked', closes: [{ ids: ['n2', 'n1'] }], ring: null });
      expect(byCall['call-close-2']).toMatchObject({ verdict: 'still_missed', closes: [], keep: 'n3', ring: null });
      expect(mockState.updates).toEqual([]);
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });
  });
});

// Dismiss on the Dispatch held row (owner 2026-11-01) closes the call's open bells at once, as
// the person's Done, through the one person-Done writer (markAdminDone).
describe('closeBookingMissBellsForCall', () => {
  const NotificationService = require('../services/notification-service');
  const { closeBookingMissBellsForCall } = require('../services/call-booking-miss-watchdog');
  beforeEach(() => {
    mockState.open = [];
    mockState.notificationFilters = [];
    NotificationService.markAdminDone.mockClear();
  });

  test("closes this call's open booking-miss bells as the admin's Done", async () => {
    mockState.open = [{ id: 'n1' }, { id: 'n2' }];
    await expect(closeBookingMissBellsForCall(CALL_ID, { by: 'tech-1' })).resolves.toBe(2);
    expect(mockState.notificationFilters).toEqual([
      ["metadata->>'call_log_id' = ?", [CALL_ID]],
      ["metadata->>'dedupeKey' LIKE ?", ['call-booking-miss%']],
    ]);
    expect(NotificationService.markAdminDone).toHaveBeenCalledWith(['n1', 'n2'], { by: 'tech-1', resolution: 'Dismissed on Dispatch: not booking', role: 'admin' });
  });

  test('with no open bell it writes nothing', async () => {
    await expect(closeBookingMissBellsForCall(CALL_ID, { by: 'tech-1' })).resolves.toBe(0);
    expect(NotificationService.markAdminDone).not.toHaveBeenCalled();
  });
});
