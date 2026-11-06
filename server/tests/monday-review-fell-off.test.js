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

describe('the reply judgement', () => {
  const { answered, witnessItem, isCustomerContact } = fellOff._private;
  const EVENT = new Date('2026-10-30T15:00:00Z');
  const at = (hours) => new Date(EVENT.getTime() + hours * 3600 * 1000);
  const bundle = (over = {}) => ({
    anchor: EVENT, shared: null, textAt: null, backAt: null, inAt: null, visitAt: null, quote: false, replyAt: null, lastInboundAt: null, ...over,
  });
  const customerItem = { id: 'n1', kind: 'customer', refs: { customerId: 'c1' } };
  const smsItem = { id: 'n2', kind: 'sms', refs: { sid: 'SM1', customerId: 'c1' } };
  const judge = (item, b, eventAt = EVENT) => answered({ item, bundle: b, eventAt, meta: {}, database: jest.fn() });
  // The estimate hand-off witness is the relevance sweep's own (its SQL runs in the Postgres suite).
  let quoteAnswered;
  beforeEach(() => { quoteAnswered = jest.spyOn(require('../services/admin-alert-relevance'), 'quoteAnswered').mockResolvedValue(false); });
  afterEach(() => quoteAnswered.mockRestore());

  test('a person text, call back, answered call or email after the event answers it', async () => {
    for (const field of ['textAt', 'backAt', 'inAt', 'replyAt']) {
      expect(await judge(customerItem, bundle({ [field]: at(2) }))).toBe(true);
    }
  });

  test('contact before the event, or at the same instant, answers nothing', async () => {
    expect(await judge(customerItem, bundle({ textAt: at(-5), backAt: EVENT }), at(1))).toBe(false);
    // The alert was refreshed after the reply: the later event is the boundary.
    expect(await judge(customerItem, bundle({ textAt: at(2) }), at(5))).toBe(false);
  });

  test('a booking or a handed-off quote answers a call, email or portal alert, never a text', async () => {
    expect(await judge(customerItem, bundle({ visitAt: at(3) }))).toBe(true);
    expect(await judge({ id: 'n3', kind: 'voice', refs: { customerId: null } }, bundle({ quote: true }))).toBe(true);
    expect(await judge(smsItem, bundle({ shared: false, visitAt: at(3), quote: true }))).toBe(false);
    // A text alert read by its customer after the text was not found is a text alert still.
    expect(await judge(smsItem, bundle({ shared: null, visitAt: at(3) }))).toBe(false);
    expect(await judge(smsItem, bundle({ shared: false, textAt: at(1) }))).toBe(true);
  });

  test('an unknown sender is answered only by a reply after their LATEST text', async () => {
    const item = { id: 'n4', kind: 'sms', refs: { sid: 'SM9', customerId: null, unknownSender: true } };
    expect(await judge(item, bundle({ shared: false, textAt: at(2), lastInboundAt: at(4) }))).toBe(false);
    expect(await judge(item, bundle({ shared: false, textAt: at(6), lastInboundAt: at(4) }))).toBe(true);
  });

  test('a quote handed to the customer after the event answers a non-text alert, read at the later of anchor and event', async () => {
    quoteAnswered.mockResolvedValue(true);
    expect(await judge(customerItem, bundle(), at(2))).toBe(true);
    expect(quoteAnswered.mock.calls[0][1]).toMatchObject({ customerId: 'c1', bellAt: at(2) });
    quoteAnswered.mockClear();
    expect(await judge(smsItem, bundle({ shared: false }), at(2))).toBe(false);
    expect(quoteAnswered).not.toHaveBeenCalled();
  });

  test('no bundle (the alert could not be checked) is not an answer', async () => {
    expect(await judge(customerItem, undefined)).toBe(false);
    expect(await judge(null, undefined)).toBe(false);
  });

  test('an alert with no witness bundle, or whose check throws, is listed unchecked; a thrown check warns once; the rest are judged', async () => {
    const { settleEntries } = fellOff._private;
    const logger = require('../services/logger');
    logger.warn.mockClear();
    quoteAnswered.mockRejectedValueOnce(new Error('canceling statement due to statement timeout')).mockRejectedValueOnce(new Error('again'));
    const mk = (id, bundleOver, item = { id, kind: 'customer', refs: { customerId: `c${id}` } }) => ({
      row: { id, title: `Alert ${id}` }, meta: {}, eventAt: EVENT, who: { name: `Name ${id}` }, item, bundle: bundle(bundleOver),
    });
    const judged = [mk('a'), mk('b'), mk('c', { textAt: at(2) }), mk('d'), mk('e', {}, null)];
    // d has an item but no bundle was found for it; e names nothing the witnesses can find.
    const bundles = new Map(judged.filter((e) => ['a', 'b', 'c'].includes(e.row.id)).map((e) => [e.row.id, e.bundle]));
    const out = await settleEntries(judged, bundles, jest.fn());
    expect(out.entries.map((e) => [e.title, e.unchecked])).toEqual([
      ['Alert a', true], ['Alert b', true], ['Alert d', true], ['Alert e', true],
    ]); // c was answered by a text
    expect(out.unverified).toBe(4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toContain('Name');
  });

  test('a checked, unanswered alert is listed without the unchecked mark', async () => {
    const { settleEntries } = fellOff._private;
    const judged = [{ row: { id: 'a', title: 'Alert a' }, meta: {}, eventAt: EVENT, who: null, item: customerItem }];
    const out = await settleEntries(judged, new Map([['a', bundle()]]), jest.fn());
    expect(out.entries).toEqual([{ name: '', title: 'Alert a', at: EVENT, unchecked: false }]);
    expect(out.unverified).toBe(0);
  });

  test('an email answers a customer alert but never a text alert, including a text read by its customer', async () => {
    expect(await judge(customerItem, bundle({ replyAt: at(2) }))).toBe(true);
    expect(await judge(smsItem, bundle({ shared: false, replyAt: at(2) }))).toBe(false);
    // The text could not be found and the alert was read by its customer: a later email still answers no text.
    expect(await judge(smsItem, bundle({ shared: null, replyAt: at(2) }))).toBe(false);
    quoteAnswered.mockClear();
    expect(quoteAnswered).not.toHaveBeenCalled();
    // A person's text or call still answers it.
    expect(await judge(smsItem, bundle({ shared: null, textAt: at(2) }))).toBe(true);
    expect(await judge(smsItem, bundle({ shared: null, backAt: at(2) }))).toBe(true);
  });

  test('what each alert is read by: a text by its text, a customer by id, then the call or email it names, else nothing', () => {
    const row = (over = {}) => ({ category: 'inbound_sms', link: '/admin/communications?message=SM123', ...over });
    expect(witnessItem(row(), {}, { id: 'c1' }, EVENT)).toMatchObject({ kind: 'sms', refs: { sid: 'SM123', customerId: 'c1', unknownSender: false }, alt: { kind: 'customer', refs: { customerId: 'c1' } } });
    expect(witnessItem(row(), {}, null, EVENT)).toMatchObject({ kind: 'sms', refs: { sid: 'SM123', customerId: null, unknownSender: true }, alt: null });
    expect(witnessItem(row({ category: 'alert', link: '/admin/x' }), {}, { id: 'c1' }, EVENT)).toMatchObject({ kind: 'customer', refs: { customerId: 'c1' } });
    expect(witnessItem(row({ category: 'voicemail_callback', link: null }), { payload: { callLogId: 'cl1', phone: '+15555550100' } }, null, EVENT))
      .toMatchObject({ kind: 'voice', refs: { callLogId: 'cl1' } });
    expect(witnessItem(row({ category: 'inbound_email', link: null }), { payload: { emailId: 'e1' } }, null, EVENT)).toMatchObject({ kind: 'email', refs: { emailId: 'e1' } });
    expect(witnessItem(row({ category: 'new_lead', link: null }), {}, null, EVENT)).toBeNull();
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
