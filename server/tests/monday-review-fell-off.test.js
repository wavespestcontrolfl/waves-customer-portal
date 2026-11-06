/**
 * Monday review bell, list 1 as "customer alerts that fell off with no reply" (GATE_MONDAY_FELL_OFF_LINE; owner
 * 2026-11-05, decision D3). Unit proof of the assembly (buildLists / composeReview with the new list under the real
 * composer rules), of which gate state picks the list, and of the reply judgement. The SQL and the witnesses run
 * against Postgres in monday-review-fell-off-db.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(), _private: {}, safeErrorSummary: jest.fn(() => 'err') }));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(),
  closeAdminAlertKeys: jest.fn(),
}));
jest.mock('../services/monday-review-fell-off', () => ({
  ...jest.requireActual('../services/monday-review-fell-off'),
  loadFellOffAlerts: jest.fn(),
}));

const { notifyAdmin } = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const fellOff = require('../services/monday-review-fell-off');
const { composeAdminAlert, MAX_WHY_CHARS, MAX_HEADLINE_CHARS } = require('../services/admin-alert-compose');
const review = require('../services/monday-review-bell');

const { buildLists, composeReview } = review._private;
const MONDAY = new Date('2026-11-02T14:20:00Z');

const entries = (n, over = {}) => Array.from({ length: n }, (_v, i) => ({
  name: `Customer ${i + 1}`,
  title: `SMS from Someone Else ${i + 1}`,
  at: new Date(Date.UTC(2026, 9, 31, 15, 0) - i * 3600 * 1000),
  ...over,
}));
const fellOffOf = (n, over = {}) => ({ kind: 'fell-off', count: n, capped: false, unchecked: false, entries: entries(n), ...over });
const PROMISES = { count: 2, oldestAt: new Date('2026-10-03T20:00:00Z') };

describe('buildLists with the fell-off list', () => {
  test('no alert fell off: no list', () => {
    expect(buildLists({ alerts: fellOffOf(0) })).toEqual([]);
  });

  test('one alert: singular wording, the name once, the title, the Eastern date and the page', () => {
    const [list] = buildLists({ alerts: fellOffOf(1, { entries: [{ name: 'Jane Doe', title: 'Comms — answer a text', at: new Date('2026-10-31T03:30:00Z') }] }) });
    expect(list.key).toBe('fellOff');
    expect(list.count).toBe(1);
    expect(list.phrase).toBe('1 customer alert fell off with no reply');
    expect(list.link).toBe('/admin/dashboard');
    const lines = list.detail.split('\n');
    expect(lines[0]).toBe('Customer alerts that fell off the bell after 3 quiet days with no reply: 1. Page: the bell, Recently done (Reopen puts one back).');
    // 03:30 UTC on Oct 31 is still Oct 30 on the Eastern calendar.
    expect(lines[1]).toBe('   - Jane Doe: Comms — answer a text (Oct 30)');
    expect(lines).toHaveLength(2);
  });

  test('three alerts read "3 customer alerts fell off with no reply"', () => {
    const [list] = buildLists({ alerts: fellOffOf(3) });
    expect(list.phrase).toBe('3 customer alerts fell off with no reply');
    expect(list.detail.split('\n')).toHaveLength(1 + 3);
    expect(list.detail).not.toContain('more');
  });

  test('exactly 15 entries show all of them and no "more" line', () => {
    const [list] = buildLists({ alerts: fellOffOf(15) });
    expect(list.detail.split('\n')).toHaveLength(1 + 15);
    expect(list.detail).not.toContain('+');
  });

  test('16 or more show 15, newest first as given, then "+N more"', () => {
    const [list] = buildLists({ alerts: fellOffOf(18) });
    const lines = list.detail.split('\n');
    expect(lines).toHaveLength(1 + 15 + 1);
    expect(lines[1]).toContain('Customer 1:');
    expect(lines[15]).toContain('Customer 15:');
    expect(lines[16]).toBe('   +3 more');
    expect(list.count).toBe(18);
  });

  test('a title that already holds the name stands alone; an alert with no name shows its title', () => {
    const [list] = buildLists({ alerts: fellOffOf(2, { entries: [
      { name: 'Jane Doe', title: 'SMS from Jane Doe', at: new Date('2026-10-30T15:00:00Z') },
      { name: '', title: 'Missed call from (941) ***-**12', at: new Date('2026-10-29T15:00:00Z') },
    ] }) });
    const lines = list.detail.split('\n');
    expect(lines[1]).toBe('   - SMS from Jane Doe (Oct 30)');
    expect(lines[2]).toBe('   - Missed call from (941) ***-**12 (Oct 29)');
  });

  test('a long title is cut at a word', () => {
    const title = `Comms — ${'a very long customer alert title '.repeat(6)}`.trim();
    const [list] = buildLists({ alerts: fellOffOf(1, { entries: [{ name: '', title, at: new Date('2026-10-30T15:00:00Z') }] }) });
    const line = list.detail.split('\n')[1];
    expect(line.length).toBeLessThan(title.length);
    expect(line.endsWith('(Oct 30)')).toBe(true);
  });

  test('a capped scan shows a plus; an unchecked week says the reply check did not run', () => {
    const [capped] = buildLists({ alerts: fellOffOf(4, { capped: true }) });
    expect(capped.phrase).toBe('4+ customer alerts fell off with no reply');
    expect(capped.detail.split('\n')[0]).toContain('no reply: 4+.');
    const [one] = buildLists({ alerts: fellOffOf(3, { unchecked: true, uncheckedCount: 1 }) });
    expect(one.detail).toContain('   The reply check could not run for 1 of these, so that one may have been answered.');
    const [many] = buildLists({ alerts: fellOffOf(3, { unchecked: true, uncheckedCount: 2 }) });
    expect(many.detail).toContain('   The reply check could not run for 2 of these, so those may have been answered.');
    // Only the flag, no count (the whole check could not run): every listed alert is unchecked.
    const [all] = buildLists({ alerts: fellOffOf(2, { unchecked: true }) });
    expect(all.detail).toContain('could not run for 2 of these, so those may have been answered.');
    const [none] = buildLists({ alerts: fellOffOf(2) });
    expect(none.detail).not.toContain('reply check');
  });

  test('an alert whose reply was not checked says so on its own line', () => {
    const [list] = buildLists({ alerts: fellOffOf(2, { unchecked: true, uncheckedCount: 1, entries: [
      { name: 'Jane Doe', title: 'Comms — answer a text', at: new Date('2026-11-03T15:00:00Z'), unchecked: true },
      { name: 'John Roe', title: 'Comms — answer a text', at: new Date('2026-11-02T15:00:00Z'), unchecked: false },
    ] }) });
    const lines = list.detail.split('\n');
    expect(lines.find((l) => l.includes('Jane Doe'))).toBe('   - Jane Doe: Comms — answer a text (Nov 3, reply not checked)');
    expect(lines.find((l) => l.includes('John Roe'))).toBe('   - John Roe: Comms — answer a text (Nov 2)');
  });

  test('the other lists are unchanged and keep their order after list 1', () => {
    const lists = buildLists({ alerts: fellOffOf(2), promises: PROMISES });
    expect(lists.map((l) => l.key)).toEqual(['fellOff', 'promises']);
  });

  test('the old list still builds from the old shape (no kind)', () => {
    const [list] = buildLists({ alerts: { count: 3, headlines: [{ headline: 'Comms — answer a customer text', at: new Date('2026-10-12T15:00:00Z') }] } });
    expect(list.key).toBe('alerts');
    expect(list.phrase).toBe('3 unread alerts');
    expect(list.detail).toContain('Needs-you alerts nobody read for 14+ days: 3.');
  });
});

describe('composeReview with the fell-off list', () => {
  test('the real composer accepts the alert at worst-case lengths', () => {
    const { spec, detail } = composeReview(buildLists({
      alerts: fellOffOf(99999, { capped: true }), promises: { count: 99999 },
      drafts: { count: 99999, total: 1234567.89 }, visits: { count: 99999, priced: 9999999 },
    }));
    const alert = composeAdminAlert(spec);
    expect(alert.headline.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
    expect(alert.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    expect(alert.why.startsWith('Waiting for you: 99999+ customer alerts fell off')).toBe(true);
    expect(detail).toContain('1. Customer alerts that fell off the bell');
  });

  test('a normal week keeps the why on one sentence under the limit', () => {
    const { spec } = composeReview(buildLists({ alerts: fellOffOf(3), promises: PROMISES }));
    expect(spec.why).toBe('Waiting for you: 3 customer alerts fell off with no reply, 2 late promises.');
    expect(() => composeAdminAlert(spec)).not.toThrow();
  });
});

describe('which loader the gate picks for list 1', () => {
  const SAVED = process.env.GATE_MONDAY_FELL_OFF_LINE;
  beforeEach(() => {
    jest.clearAllMocks();
    episodes.openAdminAlertKeys.mockResolvedValue([]);
    episodes.closeAdminAlertKeys.mockResolvedValue(0);
    notifyAdmin.mockResolvedValue({ id: 'n1' });
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.GATE_MONDAY_FELL_OFF_LINE; else process.env.GATE_MONDAY_FELL_OFF_LINE = SAVED;
  });

  // The 14-day reader is handed a database that returns no rows; the other three lists are replaced.
  const rest = { promises: async () => ({ count: 0 }), drafts: async () => ({ count: 0, total: 0 }), visits: async () => ({ count: 0, priced: 0 }) };
  const emptyDatabase = () => {
    const chain = new Proxy(function chain() {}, { get: (_t, name) => (name === 'then' ? undefined : (name === 'select' ? () => Promise.resolve([]) : () => chain)) });
    const database = jest.fn(() => chain);
    database.raw = jest.fn((sql) => sql);
    return database;
  };

  test('on: the fell-off reader runs, and its list is what the Monday row names', async () => {
    process.env.GATE_MONDAY_FELL_OFF_LINE = 'true';
    fellOff.loadFellOffAlerts.mockResolvedValue(fellOffOf(2));
    const out = await review.runMondayReview({ now: MONDAY, database: emptyDatabase(), gateEnabled: true, loaders: rest });
    expect(fellOff.loadFellOffAlerts).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ count: 1, outcome: 'raised', counts: { fellOff: 2 } });
    const [, , body, opts] = notifyAdmin.mock.calls[0];
    expect(body).toBe('Waiting for you: 2 customer alerts fell off with no reply.');
    expect(opts.detail).toContain('1. Customer alerts that fell off the bell after 3 quiet days with no reply: 2.');
  });

  test('off, unset or not exactly true: the 14-day reader runs and the fell-off reader never does', async () => {
    for (const value of [undefined, 'false', '1', 'TRUE', 'yes']) {
      if (value === undefined) delete process.env.GATE_MONDAY_FELL_OFF_LINE; else process.env.GATE_MONDAY_FELL_OFF_LINE = value;
      const out = await review.runMondayReview({ now: MONDAY, database: emptyDatabase(), gateEnabled: true, loaders: rest });
      expect(out).toEqual({ count: 0, outcome: 'clear' });
    }
    expect(fellOff.loadFellOffAlerts).not.toHaveBeenCalled();
  });

  test('on, and the fell-off list cannot be read at all: the other lists still go out, with one warning', async () => {
    process.env.GATE_MONDAY_FELL_OFF_LINE = 'true';
    fellOff.loadFellOffAlerts.mockRejectedValue(new Error('connection reset'));
    const out = await review.runMondayReview({
      now: MONDAY, database: emptyDatabase(), gateEnabled: true, loaders: { ...rest, promises: async () => PROMISES },
    });
    expect(out).toMatchObject({ count: 1, outcome: 'raised', counts: { promises: 2 } });
    expect(notifyAdmin.mock.calls[0][2]).toBe('Waiting for you: 2 late promises.');
    expect(require('../services/logger').warn).toHaveBeenCalledTimes(1);
    expect(require('../services/logger').warn.mock.calls[0][0]).toContain('without it');
  });

  test('a test that mocks feature-gates without the reader reads the gate as off', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ mondayReviewBellLive: () => true }));
      const isolated = require('../services/monday-review-bell');
      expect(isolated.runMondayReview).toBeDefined();
    });
  });
});

describe('the sweep\'s verdict decides who is listed', () => {
  const { judgeOne, judgeRows, isCustomerContact } = fellOff._private;
  const logger = require('../services/logger');
  const row = (id = 'n1') => ({ id, category: 'inbound_sms', metadata: {} });
  // A stand-in for admin-alert-relevance: only the four calls the loader makes.
  const relevance = (over = {}) => ({
    classify: jest.fn(() => ({ key: 'inbound_sms', contact: 'sms' })),
    subjectFor: jest.fn(() => ({ contact: { anchor: new Date() }, contactUnknown: false })),
    judge: jest.fn(() => ({ reason: null, would: null })),
    ...over,
  });
  const state = () => ({ warned: false });

  beforeEach(() => logger.warn.mockClear());

  test('a verdict of either kind (it would close, or it closes) means handled', () => {
    for (const verdict of [{ reason: 'Answered by text', would: null }, { reason: null, would: 'Answered by text' }]) {
      expect(judgeOne(relevance({ judge: jest.fn(() => verdict) }), row(), {}, '2026-11-02', state())).toEqual({ handled: true });
    }
  });

  test('the sweep is asked as if the contact gate were on, and is handed the day in Eastern time', () => {
    const r = relevance();
    judgeOne(r, row(), { data: 1 }, '2026-11-02', state());
    expect(r.classify).toHaveBeenCalledWith(row(), { assumeContactLive: true });
    expect(r.subjectFor).toHaveBeenCalledWith(row(), { data: 1 }, '2026-11-02');
  });

  test('no verdict with its witnesses read: listed, checked', () => {
    expect(judgeOne(relevance(), row(), {}, '2026-11-02', state())).toEqual({ handled: false, unchecked: false });
  });

  test('listed and unchecked: no subject data, no class, a class without its witnesses, a failed witness load', () => {
    expect(judgeOne(relevance(), row(), null, '2026-11-02', state())).toEqual({ handled: false, unchecked: true });
    expect(judgeOne(relevance({ classify: jest.fn(() => null) }), row(), {}, '2026-11-02', state())).toEqual({ handled: false, unchecked: true });
    const noWitness = relevance({ subjectFor: jest.fn(() => ({ contact: null, contactUnknown: false })) });
    expect(judgeOne(noWitness, row(), {}, '2026-11-02', state())).toEqual({ handled: false, unchecked: true });
    const failedLoad = relevance({ subjectFor: jest.fn(() => ({ contact: null, contactUnknown: true })) });
    expect(judgeOne(failedLoad, row(), {}, '2026-11-02', state())).toEqual({ handled: false, unchecked: true });
    // A class that judges without contact witnesses has nothing missing.
    const plain = relevance({ classify: jest.fn(() => ({ key: 'lead_repeat_form' })), subjectFor: jest.fn(() => ({ contact: null })) });
    expect(judgeOne(plain, row(), {}, '2026-11-02', state())).toEqual({ handled: false, unchecked: false });
  });

  test('a row that throws is listed unchecked; the run warns once, with no row data', () => {
    const boom = relevance({ judge: jest.fn(() => { throw new Error('boom for Jane Doe'); }) });
    const shared = state();
    expect(judgeOne(boom, row('a'), {}, '2026-11-02', shared)).toEqual({ handled: false, unchecked: true });
    expect(judgeOne(boom, row('b'), {}, '2026-11-02', shared)).toEqual({ handled: false, unchecked: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toContain('Jane');
  });

  test('a subject load that fails lists its whole batch unchecked, with one warning', async () => {
    const real = require('../services/admin-alert-relevance');
    const spy = jest.spyOn(real, 'loadSubjects').mockRejectedValue(new Error('canceling statement due to statement timeout'));
    try {
      const rows = Array.from({ length: 450 }, (_v, i) => row(`n${i}`));
      const verdicts = await judgeRows(rows, jest.fn(), MONDAY);
      expect(verdicts.size).toBe(450);
      expect([...verdicts.values()].every((v) => v.handled === false && v.unchecked === true)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(3); // 200 + 200 + 50
      expect(spy.mock.calls[0][2]).toEqual({ judgeContact: true });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a customer contact is a contact category or a declared contact; money and system rows are not', () => {
    expect(isCustomerContact({ category: 'inbound_sms' }, {})).toBe(true);
    expect(isCustomerContact({ category: 'missed_call' }, {})).toBe(true);
    expect(isCustomerContact({ category: 'schedule' }, { contact: true })).toBe(true);
    expect(isCustomerContact({ category: 'schedule' }, { triggerKey: 'appointment_reschedule_intent' })).toBe(true);
    expect(isCustomerContact({ category: 'schedule' }, {})).toBe(false);
    expect(isCustomerContact({ category: 'billing' }, {})).toBe(false);
    expect(isCustomerContact({ category: 'system' }, {})).toBe(false);
  });
});
