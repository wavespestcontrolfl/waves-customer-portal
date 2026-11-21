/**
 * Monday review bell (owner 2026-11-02, B2): one weekly needs-you row for the work that sits.
 * Unit proof of the five list readers' assembly, the one composed alert (real composer rules), the
 * replace / zero / same-day behavior and the gate. The SQL of lists 1, 3 and 4 runs against Postgres in
 * monday-review-bell-db.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(), _private: {}, safeErrorSummary: jest.fn(() => 'ECONNRESET') }));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(),
  closeAdminAlertKeys: jest.fn(),
}));

const logger = require('../services/logger');
const { notifyAdmin } = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const { composeAdminAlert, MAX_WHY_CHARS, MAX_HEADLINE_CHARS } = require('../services/admin-alert-compose');
const review = require('../services/monday-review-bell');

const { buildLists, composeReview, loadUnreadAlerts, loadOpenPastVisits, reviewerLabel, shortDate, REPLACED, NOTHING } = review._private;

// Monday 2026-11-02, 9:20 AM EST (the clocks went back on Nov 1).
const MONDAY = new Date('2026-11-02T14:20:00Z');
const TODAY_KEY = 'monday-review:2026-11-02';

const ALERTS = { count: 3, oldestAt: new Date('2026-10-10T15:00:00Z'), headlines: [
  { headline: 'Billing — follow up on 1 quiet overdue invoice', at: new Date('2026-10-10T15:00:00Z') },
  { headline: 'Comms — answer a customer text', at: new Date('2026-10-12T15:00:00Z') },
] };
const PROMISES = { count: 37, oldestAt: new Date('2026-10-03T20:00:00Z') };
const DRAFTS = { count: 22, total: 2442, oldestId: 'inv-1', oldestNumber: 'WPC-1042' };
const VISITS = { count: 38, priced: 3617, oldestDate: '2026-09-12' };
const loaders = (over = {}) => ({
  alerts: jest.fn(async () => ALERTS),
  promises: jest.fn(async () => PROMISES),
  drafts: jest.fn(async () => DRAFTS),
  visits: jest.fn(async () => VISITS),
  parked: jest.fn(async () => ({ count: 0, entries: [] })),
  ...over,
});
const ZERO = {
  alerts: async () => ({ count: 0, headlines: [] }),
  promises: async () => ({ count: 0 }),
  drafts: async () => ({ count: 0, total: 0 }),
  visits: async () => ({ count: 0, priced: 0 }),
  parked: async () => ({ count: 0, entries: [] }),
};

beforeEach(() => {
  jest.clearAllMocks();
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockResolvedValue(0);
  notifyAdmin.mockResolvedValue({ id: 'n1' });
});

describe('one alert for a busy week', () => {
  test('raises one needs-you row that rings, with a line and a page per list', async () => {
    const out = await review.runMondayReview({ now: MONDAY, loaders: loaders() });
    expect(out).toMatchObject({ count: 4, outcome: 'raised', counts: { alerts: 3, promises: 37, drafts: 22, visits: 38 } });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toBe('System — review 4 lists that sit');
    expect(body).toBe('Waiting for you: 3 unread alerts, 37 late promises, 22 unsent drafts, 38 open past visits.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: TODAY_KEY,
      link: '/admin/dashboard',
      metadata: { area: 'System', severity: 'needs-you', who: 'person', doneWhen: 'reviewed', subject: { type: 'check', id: 'monday-review' }, mondayReview: true, weekOf: '2026-11-02' },
    });
    // The detail names every list with its count and the page that opens it.
    const lines = opts.detail.split('\n');
    expect(opts.detail).toContain('4 lists have work that sits.');
    expect(opts.detail).toContain('1. Needs-you alerts nobody read for 14+ days: 3.');
    expect(opts.detail).toContain('Billing — follow up on 1 quiet overdue invoice (idle since Oct 10)');
    expect(opts.detail).toContain('2. Promises to callers that are overdue: 37. Oldest due Oct 3. Page: /admin/communications#tab=owed');
    expect(opts.detail).toContain('3. Completed visits whose only invoice is an unsent draft: 22, $2,442.00. Oldest: WPC-1042. Page: /admin/invoices?invoice=inv-1');
    expect(opts.detail).toContain('4. Past-dated visits still open: 38, $3,617 priced. Oldest Sep 12. Page: /admin/dashboard');
    expect(lines.length).toBeGreaterThanOrEqual(7);
  });

  test('a list with no work is left out, and the wording follows the count', async () => {
    const out = await review.runMondayReview({
      now: MONDAY,
      loaders: { ...ZERO, promises: async () => ({ count: 1, oldestAt: new Date('2026-10-30T20:00:00Z') }) },
    });
    expect(out.count).toBe(1);
    const [, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(title).toBe('System — review 1 list that sits');
    expect(body).toBe('Waiting for you: 1 late promise.');
    expect(opts.detail).not.toContain('unsent draft');
    expect(opts.detail).not.toContain('Past-dated');
    expect(opts.metadata.counts).toEqual({ promises: 1 });
  });

  test('the composer accepts the alert at worst-case lengths (headline <= 60, why <= 110, one sentence)', () => {
    const { spec } = composeReview(buildLists({
      alerts: { count: 99999, headlines: [] }, promises: { count: 99999 },
      drafts: { count: 99999, total: 1234567.89 }, visits: { count: 99999, priced: 9999999 },
    }));
    const alert = composeAdminAlert(spec);
    expect(alert.headline.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
    expect(alert.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    expect(alert.link).toBe('/admin/dashboard');
    expect(alert.metadata).toMatchObject({ area: 'System', severity: 'needs-you', who: 'person', doneWhen: 'reviewed' });
  });

  test('a bell with one list opens that list\'s page: parked reviews only opens Reviews', () => {
    const { spec } = composeReview(buildLists({
      alerts: { count: 0, headlines: [] }, promises: { count: 0 }, drafts: { count: 0, total: 0 }, visits: { count: 0, priced: 0 },
      parked: { count: 2, entries: [{ name: 'Dana Whitfield', at: new Date('2026-11-13T15:00:00Z'), location: 'Lakewood Ranch', checkGoogle: false }, { name: 'Lee Park', at: new Date('2026-11-14T15:00:00Z'), location: 'Venice', checkGoogle: false }] },
    }));
    expect(composeAdminAlert(spec).link).toBe('/admin/reviews');
  });
});

describe('last week, zero weeks, and the same day', () => {
  test("closes last week's row before it raises this week's, and never closes its own key", async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['monday-review:2026-10-26', TODAY_KEY]);
    episodes.closeAdminAlertKeys.mockImplementation(async () => {
      expect(notifyAdmin).not.toHaveBeenCalled(); // closed first
      return 1;
    });
    await review.runMondayReview({ now: MONDAY, loaders: loaders() });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), 'monday-review:');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    const [, keys, reason, opts] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(keys).toEqual(['monday-review:2026-10-26']);
    expect(reason).toBe('replaced');
    expect(opts.resolution).toBe(REPLACED);
    expect(REPLACED).toBe("Replaced by this week's review");
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('same day rerun: this key is not closed and the second write is a plain dedupe', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([TODAY_KEY]);
    notifyAdmin.mockResolvedValue({ id: 'n1', deduped: true });
    const out = await review.runMondayReview({ now: MONDAY, loaders: loaders() });
    expect(out.outcome).toBe('unchanged');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe(TODAY_KEY);
    // No refresh option: a second run never rewrites or re-rings the row.
    expect(notifyAdmin.mock.calls[0][3].refreshOnDedupe).toBeUndefined();
  });

  test('the parked-reviews list that cannot be read is left out: one warning, the week still goes out', async () => {
    const out = await review.runMondayReview({
      now: MONDAY, loaders: loaders({ parked: async () => { throw new Error('connection reset by peer'); } }),
    });
    expect(out).toMatchObject({ count: 4, outcome: 'raised' });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('parked-reviews list not read');
    expect(logger.warn.mock.calls[0][0]).toContain('ECONNRESET');
    expect(logger.warn.mock.calls[0][0]).not.toContain('connection reset by peer');
  });

  test('an unreadable parked-reviews list is not a zero: with every other list empty nothing is raised and nothing is closed', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['monday-review:2026-11-02']);
    const out = await review.runMondayReview({
      now: MONDAY, loaders: { ...ZERO, parked: async () => { throw new Error('connection reset'); } },
    });
    expect(out).toEqual({ count: 0, outcome: 'unknown' });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a capped alert scan that found no row is not a zero: with every other list empty nothing is raised and nothing is closed', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['monday-review:2026-11-02']);
    const out = await review.runMondayReview({
      now: MONDAY, loaders: { ...ZERO, alerts: async () => ({ count: 0, capped: true, headlines: [] }) },
    });
    expect(out).toEqual({ count: 0, outcome: 'unknown' });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('every count zero: nothing raised, older rows closed as "Nothing to review"', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['monday-review:2026-10-26', TODAY_KEY]);
    episodes.closeAdminAlertKeys.mockResolvedValue(2);
    const out = await review.runMondayReview({ now: MONDAY, loaders: ZERO });
    expect(out).toEqual({ count: 0, outcome: 'closed' });
    expect(notifyAdmin).not.toHaveBeenCalled();
    const [, keys, reason, opts] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(keys).toEqual(['monday-review:2026-10-26', TODAY_KEY]);
    expect(reason).toBe('count_zero');
    expect(opts.resolution).toBe(NOTHING);
  });

  test('every count zero and nothing open: a clear run writes nothing', async () => {
    const out = await review.runMondayReview({ now: MONDAY, loaders: ZERO });
    expect(out).toEqual({ count: 0, outcome: 'clear' });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed read throws and closes nothing', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['monday-review:2026-10-26']);
    await expect(review.runMondayReview({
      now: MONDAY, loaders: loaders({ drafts: async () => { throw new Error('connection reset'); } }),
    })).rejects.toThrow('connection reset');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('the owner silenced the category: reported, not an error', async () => {
    notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
    expect((await review.runMondayReview({ now: MONDAY, loaders: loaders() })).outcome).toBe('suppressed');
  });

  test('a write that failed throws', async () => {
    notifyAdmin.mockResolvedValue(null);
    await expect(review.runMondayReview({ now: MONDAY, loaders: loaders() })).rejects.toThrow('not written');
  });
});

// A knex builder stand-in: every chain method returns itself; `select` resolves the rows.
function fakeKnex(rows) {
  const calls = [];
  const chain = new Proxy(function chain() {}, {
    get(_t, name) {
      if (name === 'then') return undefined;
      return (...args) => {
        calls.push([name, args]);
        if (name === 'select') return Promise.resolve(rows);
        return chain;
      };
    },
  });
  const database = jest.fn(() => chain);
  // The cursor column is a raw select (created_at::text); the fake hands the SQL back as the column marker.
  database.raw = jest.fn((sql) => sql);
  database.calls = calls;
  return database;
}
const DAY = 24 * 60 * 60 * 1000;
const aged = (days) => new Date(MONDAY.getTime() - days * DAY).toISOString();
const row = (id, over = {}) => ({
  id, category: 'billing', title: `Row ${id}`, link: '/admin/invoices', created_at: aged(20), read_at: null,
  metadata: { severity: 'needs-you', who: 'person' }, ...over,
});

describe('list 1: needs-you alerts unread 14+ days', () => {
  test('keeps known needs-you rows; drops Activity, Claude, unsorted, fyi and recently refreshed rows', async () => {
    const database = fakeKnex([
      row('a-old', { created_at: aged(25), title: 'Oldest needs-you' }),
      row('b-activity', { metadata: { severity: 'needs-you', feed: 'activity' } }),
      row('c-claude-queue', { metadata: { severity: 'needs-you', claudeQueue: 'ib-fault', who: 'claude', feed: 'activity' } }),
      row('d-who-claude', { metadata: { severity: 'needs-you', who: 'claude' } }),
      row('e-unsorted', { metadata: {} }),
      row('f-fyi', { metadata: { severity: 'fyi' } }),
      row('g-rung-recently', { created_at: aged(40), metadata: { severity: 'needs-you', rungAt: aged(3) } }),
      row('h-rung-long-ago', { created_at: aged(40), title: 'Rung 16 days ago', metadata: { severity: 'needs-you', rungAt: aged(16) } }),
      row('i-string-meta', { title: 'Meta as text', created_at: aged(18), metadata: JSON.stringify({ severity: 'needs-you' }) }),
    ]);
    const out = await loadUnreadAlerts({ now: MONDAY, database });
    expect(out.count).toBe(3);
    // Oldest last activity first: 25 days, 18 days, then the row rung 16 days ago.
    expect(out.headlines.map((h) => h.headline)).toEqual(['Oldest needs-you', 'Meta as text', 'Rung 16 days ago']);
    expect(out.oldestAt.toISOString()).toBe(aged(25));
  });

  test('the headline list stops at five, oldest first, and the count is the whole list', async () => {
    const rows = Array.from({ length: 8 }, (_v, i) => row(`r${i}`, { title: `Alert ${i}`, created_at: aged(15 + i) }));
    const out = await loadUnreadAlerts({ now: MONDAY, database: fakeKnex(rows) });
    expect(out.count).toBe(8);
    expect(out.headlines).toHaveLength(5);
    expect(out.headlines[0].headline).toBe('Alert 7');
    expect(out.oldestAt.toISOString()).toBe(aged(22));
  });

  test('the query reads only unread, not-done admin rows older than 14 days and skips its own key', async () => {
    const database = fakeKnex([]);
    await loadUnreadAlerts({ now: MONDAY, database });
    const calls = database.calls.map(([name, args]) => [name, args]);
    expect(calls).toContainEqual(['where', [{ recipient_type: 'admin' }]]);
    expect(calls).toContainEqual(['whereNull', ['done_at']]);
    expect(calls).toContainEqual(['whereNull', ['read_at']]);
    const cutoff = calls.find(([name, args]) => name === 'where' && args[0] === 'created_at')[1][2];
    expect(MONDAY.getTime() - cutoff.getTime()).toBe(14 * DAY);
    expect(calls.some(([name, args]) => name === 'whereRaw' && String(args[0]).includes("NOT LIKE 'monday-review:%'"))).toBe(true);
  });
});

describe('list 2: overdue promises', () => {
  test('counts the watchdog selection, minus internal test customers and promises no longer open', async () => {
    jest.resetModules();
    const open = [
      { id: 'p1', customer_id: 'c1' }, { id: 'p2', customer_id: 'c2' }, { id: 'p3', customer_id: 'internal' }, { id: 'p4', customer_id: 'c4' },
    ];
    const due = { p1: new Date('2026-10-20T04:00:00Z'), p2: new Date('2026-10-03T04:00:00Z'), p3: new Date('2026-09-01T04:00:00Z'), p4: new Date('2026-10-01T04:00:00Z') };
    const stillOpenIds = jest.fn(async () => new Set(['p1', 'p2', 'p3']));
    const listOpenCommitments = jest.fn(async () => open);
    jest.doMock('../services/call-commitments', () => ({
      listOpenCommitments,
      selectOverdue: (rows) => rows,
      stillOpenIds,
      overdueAt: (r) => due[r.id],
    }));
    jest.doMock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: (id) => id === 'internal' }));
    const fresh = require('../services/monday-review-bell')._private;
    const out = await fresh.loadOverduePromises({ now: MONDAY, database: {} });
    expect(listOpenCommitments).toHaveBeenCalledWith({}, expect.objectContaining({ party: 'waves', prepare: false, includeHints: true, offset: 0 }));
    expect(stillOpenIds).toHaveBeenCalledWith({}, ['p1', 'p2', 'p4'], { now: MONDAY });
    expect(out.count).toBe(2);
    expect(out.oldestAt).toEqual(due.p2);
    jest.dontMock('../services/call-commitments');
    jest.dontMock('../services/internal-test-customers');
  });

  test('an empty queue is a zero', async () => {
    jest.resetModules();
    jest.doMock('../services/call-commitments', () => ({
      listOpenCommitments: async () => [], selectOverdue: () => [], stillOpenIds: async () => new Set(), overdueAt: () => null,
    }));
    const fresh = require('../services/monday-review-bell')._private;
    expect(await fresh.loadOverduePromises({ now: MONDAY, database: {} })).toEqual({ count: 0, oldestAt: null });
    jest.dontMock('../services/call-commitments');
  });
});

describe('list 4: open past visits', () => {
  test('counts the stale-visit sweep list and adds up the priced ones', async () => {
    const visits = [
      { id: 'v1', scheduled_date: '2026-10-05' }, { id: 'v2', scheduled_date: new Date('2026-09-12T00:00:00Z') }, { id: 'v3', scheduled_date: '2026-10-30' },
    ];
    const findStaleVisits = jest.fn(async () => visits);
    const database = jest.fn(() => ({
      whereIn() { return this; }, where() { return this; }, sum() { return this; }, first: async () => ({ total: '1250.50' }),
    }));
    const out = await loadOpenPastVisits({ now: MONDAY, database, findStaleVisits });
    expect(findStaleVisits).toHaveBeenCalledWith(MONDAY);
    expect(out).toEqual({ count: 3, priced: 1250.5, oldestDate: '2026-09-12' });
  });

  test('no stale visits: a zero, and no price query', async () => {
    const database = jest.fn();
    const out = await loadOpenPastVisits({ now: MONDAY, database, findStaleVisits: async () => [] });
    expect(out).toEqual({ count: 0, priced: 0, oldestDate: null });
    expect(database).not.toHaveBeenCalled();
  });
});

describe('assembly', () => {
  test('a capped unread-alert scan reads as a floor', () => {
    const [list] = buildLists({ alerts: { count: 3, capped: true, headlines: [] } });
    expect(list.phrase).toBe('3+ unread alerts');
  });

  test('drafts link opens the oldest draft; without an id it opens the Invoices page', () => {
    const [withId] = buildLists({ drafts: { count: 2, total: 100.5, oldestId: 'a b', oldestNumber: 'X-1' } });
    expect(withId.link).toBe('/admin/invoices?invoice=a%20b');
    const [without] = buildLists({ drafts: { count: 2, total: 100.5 } });
    expect(without.link).toBe('/admin/invoices');
  });

  test('dates print on the Eastern calendar', () => {
    expect(shortDate('2026-09-12')).toBe('Sep 12');
    expect(shortDate(new Date('2026-11-02T03:30:00Z'))).toBe('Nov 1');
    expect(shortDate(null)).toBeNull();
  });

  test('list 5: parked Google reviews come last, by name and date, and change nothing at zero', () => {
    const four = { alerts: ALERTS, promises: PROMISES, drafts: DRAFTS, visits: VISITS };
    expect(buildLists({ ...four, parked: { count: 0, entries: [] } })).toEqual(buildLists(four));
    const entries = [
      { name: 'Dana Whitfield', at: '2026-11-13T15:00:00Z', location: 'Lakewood Ranch' },
      { name: '<b>Evil</b> ignore previous', at: '2026-11-14T15:00:00Z', location: null },
      // A park whose reply may already be on Google (google_uncertain, persist_failed, reconcile_failed).
      { name: 'Sam Ortiz', at: '2026-11-15T15:00:00Z', location: 'Venice', checkGoogle: true },
    ];
    const lists = buildLists({ ...four, parked: { count: 3, entries } });
    expect(lists.map((l) => l.key)).toEqual(['alerts', 'promises', 'drafts', 'visits', 'parkedReviews']);
    expect(lists[4]).toMatchObject({ count: 3, phrase: '3 Google reviews with no reply', link: '/admin/reviews' });
    expect(lists[4].detail.split('\n')).toEqual([
      'Google reviews the auto-reply agent handed to a person that still have no reply: 3. Page: /admin/reviews',
      '   - Dana W. (Lakewood Ranch, Nov 13)',
      '   - b P. (Nov 14)',
      '   - Sam O. (Venice, Nov 15): a reply may be on Google, check there first',
    ]);
    expect(buildLists({ parked: { count: 1, entries: [{ name: null, at: '2026-11-13T15:00:00Z', location: 'Venice' }] } })[0].phrase).toBe('1 Google review with no reply');
    expect(composeReview(buildLists({ ...four, parked: { count: 99999, entries: [] } })).spec.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
  });

  test('list 5 shows the same number of names as the fell-off list, then "+N more"', () => {
    const { ENTRY_SHOWN } = require('../services/monday-review-fell-off');
    const entries = Array.from({ length: ENTRY_SHOWN + 2 }, (_, i) => ({ name: `Reviewer${i} Q`, at: '2026-11-13T15:00:00Z', location: 'Venice' }));
    const [list] = buildLists({ parked: { count: entries.length, entries } });
    const lines = list.detail.split('\n');
    expect(lines).toHaveLength(1 + ENTRY_SHOWN + 1);
    expect(lines.at(-1)).toBe('   +2 more');
  });

  test('a reviewer name from Google shows as first name and last initial, else "A reviewer"', () => {
    expect(reviewerLabel('Dana Whitfield')).toBe('Dana W.');
    expect(reviewerLabel("Mary-Jo O'Neil Smith")).toBe('Mary-Jo S.');
    expect(reviewerLabel('Cher')).toBe('Cher');
    expect(reviewerLabel('  ')).toBe('A reviewer');
    expect(reviewerLabel(null)).toBe('A reviewer');
    expect(reviewerLabel('1234 \u{1F600}')).toBe('A reviewer');
  });

  test('no list, no alert', () => {
    expect(buildLists({})).toEqual([]);
    expect(buildLists({ alerts: { count: 0 }, promises: { count: 0 }, drafts: { count: 0 }, visits: { count: 0 } })).toEqual([]);
  });
});
