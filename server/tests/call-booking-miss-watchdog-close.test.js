// Booking-miss bells close themselves (owner 2026-10-24: "Alerts must clear once
// the thing happened"). classifyOpenBookingMiss is pure: five verdicts, one per
// way a call's open bells end. The close pass tests run the whole tick against a
// stand-in database and read the writes it makes. All fixture identities are
// synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), alertRingOnceLive: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));

const mockState = { calls: [], booked: [], customers: [], open: [], updates: [], failClose: false };

jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const ctx = { table, ids: null, probe: false };
    const rows = () => {
      if (table === 'call_log') return mockState.calls;
      if (table === 'scheduled_services') return mockState.booked;
      if (table === 'customers') return mockState.customers;
      if (table === 'notifications') return ctx.probe ? mockState.open : [];
      return [];
    };
    const b = {
      where: () => b,
      whereRaw: () => b,
      whereNotNull: () => b,
      whereNull: () => { ctx.probe = true; return b; },
      whereIn: (col, ids) => { if (table === 'notifications' && col === 'id') ctx.ids = ids; return b; },
      groupByRaw: () => b,
      orderBy: () => b,
      select: () => b,
      first: () => Promise.resolve(undefined),
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
  id: 'visit-1', customer_id: 'cust-1', status: 'confirmed', sched_date: '2026-11-04', window_start: '16:00:00',
  created_at: AFTER_CALL, source_call_log_id: null, notes: null, internal_notes: null, ...over,
});
const bell = (id, minute, over = {}) => ({
  id, title: "Schedule — book Sam Sample's Waves Assessment", created_at: `2026-10-20T15:${minute}:00Z`,
  mismatch_visit_id: null, mismatch_date: null, mismatch_time: null, ...over,
});
const classify = (rows, open = [bell('n1', '10')], opts = {}) => classifyOpenBookingMiss(call(opts.call), opts.slot || SLOT, rows, open, { now: opts.now || NOW, namesakes: opts.namesakes });

describe('classifyOpenBookingMiss', () => {
  test('booked: the visit on the agreed slot closes every bell, naming the visit', () => {
    const plan = classify([visit({ sched_date: '2026-11-04' })], [bell('n1', '10'), bell('n2', '20')]);
    expect(plan.verdict).toBe('booked');
    expect(plan.closes).toEqual([{ ids: ['n2', 'n1'], resolution: 'Visit booked for Wed Nov 4 at 4:00 PM' }]);
    expect(plan.keep).toBeNull();
    expect(plan.rewrite).toBeNull();
  });

  test('booked: a visit booked from the call and later cancelled still counts (provenance rule unchanged)', () => {
    const plan = classify([visit({ status: 'cancelled', sched_date: '2026-11-10', source_call_log_id: CALL_ID })]);
    expect(plan.verdict).toBe('booked');
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
    expect(plan.rewrite).toEqual({ id: 'n1', mismatch: plan.mismatch });
    expect(plan.keep).toBe('n1');
    expect(plan.closes).toEqual([]);
  });

  test('booked_other_day: the same day outside the window tolerance', () => {
    const plan = classify([visit({ sched_date: '2026-11-04', window_start: '08:00:00' })]);
    expect(plan.verdict).toBe('booked_other_day');
    expect(plan.mismatch.time).toBe('08:00');
  });

  test('booked_other_day: keeps the newest bell, closes older ones, and rewrites only when the booked visit changed', () => {
    const rows = [visit({ id: 'visit-9', sched_date: '2026-10-28' })];
    const first = classify(rows, [bell('n1', '10'), bell('n2', '20')]);
    expect(first.keep).toBe('n2');
    expect(first.closes).toEqual([{ ids: ['n1'], resolution: 'Replaced by a newer alert for this call' }]);
    expect(first.rewrite).toMatchObject({ id: 'n2' });
    const stamped = { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' };
    expect(classify(rows, [bell('n2', '20', stamped)]).rewrite).toBeNull();
    // The office moved the visit to another time: the text changes again.
    expect(classify([visit({ id: 'visit-9', sched_date: '2026-10-28', window_start: '10:00:00' })], [bell('n2', '20', stamped)]).rewrite).toMatchObject({ id: 'n2' });
  });

  test('the date check is answered by the booked visit moving to the agreed slot', () => {
    expect(classify([visit({ id: 'visit-9', sched_date: '2026-11-04' })], [bell('n2', '20', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' })]).verdict).toBe('booked');
  });

  test('a visit more than the match window from the agreed day is not the answer', () => {
    const far = new Date(Date.parse('2026-11-04T12:00:00Z') + (OTHER_DAY_MATCH_DAYS + 1) * 86400000).toISOString().slice(0, 10);
    expect(classify([visit({ sched_date: far }), visit({ id: 'v2', status: 'completed', sched_date: far })]).verdict).toBe('still_missed');
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
    expect(plan).toMatchObject({ verdict: 'booked_other_day', closes: [], keep: null, rewrite: null });
  });
});

describe('close pass', () => {
  const stamp = { confirmed_date_et: '2026-11-04', confirmed_time_et: '16:00' };
  beforeEach(() => {
    mockState.calls = [call()];
    mockState.booked = [];
    mockState.customers = [];
    mockState.open = [];
    mockState.updates = [];
    mockState.failClose = false;
    logger.warn.mockClear();
  });
  const tick = () => runCallBookingMissWatchdog({ now: NOW });
  const open = (id, minute, over = {}) => ({ ...bell(id, minute, over), call_log_id: CALL_ID, ...stamp });

  test('closes a booked call\'s bells even when nothing new rings', async () => {
    mockState.calls = [call({ created_at: '2026-07-01T14:00:00Z' })];
    mockState.open = [open('n1', '10'), open('n2', '20')];
    mockState.booked = [visit({ created_at: '2026-07-01T15:00:00Z' })];
    const result = await tick();
    expect(result).toMatchObject({ closed: 2, rewritten: 0 });
    expect(mockState.updates).toEqual([{ table: 'notifications', ids: ['n2', 'n1'], payload: { done_by: 'call-booking-miss', resolution: 'Visit booked for Wed Nov 4 at 4:00 PM' } }]);
  });

  test('turns the kept bell into the date check, unread, and closes the older duplicate', async () => {
    mockState.open = [open('n1', '10'), open('n2', '20')];
    mockState.booked = [visit({ id: 'visit-9', sched_date: '2026-10-28' })];
    const result = await tick();
    expect(result).toMatchObject({ closed: 1, rewritten: 1 });
    const [closeOld, rewrite] = mockState.updates;
    expect(closeOld).toMatchObject({ ids: ['n1'], payload: { resolution: 'Replaced by a newer alert for this call' } });
    expect(rewrite.ids).toBeNull();
    expect(rewrite.payload).toMatchObject({
      title: "Schedule — check Sam Sample's visit date",
      body: 'Booked Wed Oct 28 at 4:00 PM; the call agreed Wed Nov 4 at 4:00 PM.',
      link: '/admin/dispatch?tab=schedule&date=2026-10-28',
      read_at: null, done_at: null, done_by: null, resolution: null,
    });
    expect(rewrite.payload.detail).toMatch(/^Sam Sample \(\+19415550111\) agreed Waves Assessment for Wed Nov 4 at 4:00 PM on a outbound call at /);
    expect(rewrite.payload.detail).toMatch(/The visit on the calendar is Wed Oct 28 at 4:00 PM\. Move it to the agreed day/);
    expect(rewrite.payload.metadata.args).toEqual([JSON.stringify({ mismatch: { visit_id: 'visit-9', date: '2026-10-28', time: '16:00' } })]);
  });

  test('does not touch a date check that already shows this visit', async () => {
    mockState.open = [open('n2', '20', { mismatch_visit_id: 'visit-9', mismatch_date: '2026-10-28', mismatch_time: '16:00' })];
    mockState.booked = [visit({ id: 'visit-9', sched_date: '2026-10-28' })];
    expect(await tick()).toMatchObject({ closed: 0, rewritten: 0 });
    expect(mockState.updates).toEqual([]);
  });

  test('the bell\'s own stamp stands in when the call no longer confirms a slot', async () => {
    mockState.calls = [call({ ai_extraction_enriched: { caller: { name_full: 'Sam Sample' }, scheduling: { status: 'none' } } })];
    mockState.open = [open('n1', '10')];
    mockState.booked = [visit({ id: 'visit-9', sched_date: '2026-10-28' })];
    await tick();
    expect(mockState.updates).toHaveLength(1);
    expect(mockState.updates[0].payload.title).toBe("Schedule — check Sam Sample's visit date");
  });

  test('a call with neither a slot nor a stamp is left alone', async () => {
    mockState.calls = [call({ ai_extraction_enriched: null })];
    mockState.open = [{ ...open('n1', '10'), confirmed_date_et: null, confirmed_time_et: null }];
    expect(await tick()).toMatchObject({ closed: 0, rewritten: 0 });
    expect(mockState.updates).toEqual([]);
  });

  test('leaves a still-missed single bell alone', async () => {
    mockState.open = [open('n1', '10')];
    expect(await tick()).toMatchObject({ closed: 0, rewritten: 0 });
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
});
