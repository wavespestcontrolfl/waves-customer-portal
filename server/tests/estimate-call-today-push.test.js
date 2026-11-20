// The 9 AM "Call today" estimate banner (server/services/estimate-call-today-push.js, owner 2026-11-19, plan page
// "Lead to Customer Plan", phase 1): the count is the Estimates page's own Call today list (the shared rule), the words
// carry a count only, nothing goes out at zero, and the once-per-ET-day claim. Rows are synthetic; no database.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockDb = jest.fn();
mockDb.raw = jest.fn();
jest.mock('../models/db', () => mockDb);
const mockTrigger = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTrigger(...args),
}));
const mockLastCalled = jest.fn();
jest.mock('../services/estimate-call-list', () => ({
  ...jest.requireActual('../services/estimate-call-list'),
  lastCalledAtByEstimateId: (...args) => mockLastCalled(...args),
}));

const logger = require('../services/logger');
const { runEstimateCallTodayPush, countCallToday } = require('../services/estimate-call-today-push');
const { callTodayFields } = require('../services/estimate-call-list');
const shared = require('../../shared/estimate-call-today.cjs');
const realTriggers = jest.requireActual('../services/notification-triggers');

const NOW = new Date('2026-11-19T14:00:00Z'); // 9:00 AM EST
const HOUR = 3600000;
const ago = (hours) => new Date(NOW.getTime() - hours * HOUR).toISOString();

const row = (id, viewedHoursAgo, over = {}) => ({
  id, status: 'viewed', customer_phone: '+19415550101', archived_at: null,
  sent_at: ago(viewedHoursAgo + 24), viewed_at: ago(viewedHoursAgo), last_viewed_at: ago(viewedHoursAgo),
  last_follow_up_at: null, ...over,
});

let estimateRows;
let clickRows;
let claimed;
let estimateCalls; // the list query's method calls, in order
let releaseFails; // the claim row's delete throws
beforeEach(() => {
  jest.clearAllMocks();
  estimateRows = [];
  clickRows = [];
  estimateCalls = [];
  releaseFails = false;
  claimed = new Set();
  mockLastCalled.mockResolvedValue(new Map());
  mockDb.raw.mockImplementation((sql, bindings) => {
    if (!bindings) return { raw: sql }; // a select expression (the self-serve flag and first delivery)
    const [key] = bindings;
    if (claimed.has(key)) return Promise.resolve({ rows: [] });
    claimed.add(key);
    return Promise.resolve({ rows: [{ id: claimed.size }] });
  });
  const chain = (rows) => {
    const q = { where: () => q, whereNull: () => q, whereRaw: () => q, whereIn: () => q, groupBy: () => q, select: () => q, sum: () => q, max: () => q, then: (ok, no) => Promise.resolve(rows).then(ok, no) };
    return q;
  };
  // The estimates list query: records every call and applies limit(n) to the rows (newest first, as the query orders them).
  const listQuery = () => {
    let limit = Infinity;
    const q = {};
    for (const name of ['leftJoin', 'select', 'clearSelect', 'orderBy', 'where', 'whereNull', 'whereNotNull', 'orWhereIn', 'whereIn']) {
      q[name] = (...args) => { estimateCalls.push([name, ...args]); return q; };
    }
    q.limit = (n) => { limit = n; estimateCalls.push(['limit', n]); return q; };
    q.then = (ok, no) => Promise.resolve(estimateRows.slice(0, limit)).then(ok, no);
    return q;
  };
  mockDb.mockImplementation((table) => {
    if (table === 'estimates') return listQuery();
    if (table === 'short_codes') return chain(clickRows);
    if (table === 'sms_send_claims') return { where: ({ claim_key: key }) => ({ del: async () => { if (releaseFails) throw Object.assign(new Error('delete from sms_send_claims'), { code: '57P01' }); claimed.delete(key); return 1; } }) };
    throw new Error(`unexpected table ${table}`);
  });
  mockTrigger.mockResolvedValue({ bellWritten: false, push: { sent: 1 } });
});

describe('the count is the page list', () => {
  test('counts viewed offers last touched 2 h to 48 h ago with nobody reached since', async () => {
    estimateRows = [
      row('a', 5), row('b', 30), row('fresh', 1), row('cold', 72),
      row('called', 6), row('followed', 6, { last_follow_up_at: ago(2) }),
      row('stale-followup', 6, { last_follow_up_at: ago(20) }),
    ];
    mockLastCalled.mockResolvedValue(new Map([['called', ago(1)]]));
    expect(await countCallToday(NOW.getTime())).toBe(3); // a, b, stale-followup
  });

  test('a link tap after the last view counts as the last touch', async () => {
    estimateRows = [row('tapped', 60), row('tapped-fresh', 60)];
    clickRows = [{ entity_id: 'tapped', last_clicked_at: ago(5) }, { entity_id: 'tapped-fresh', last_clicked_at: ago(1) }];
    expect(await countCallToday(NOW.getTime())).toBe(1);
  });

  test('a self-serve quote nobody delivered is never counted, by the shared rule the page reads (zero-follow-up contract)', async () => {
    const { undeliveredSelfServeSql } = require('../services/self-serve-estimates');
    estimateRows = [row('a', 5), row('undelivered', 5, { undelivered_self_serve: true }), row('delivered', 5, { undelivered_self_serve: false })];
    expect(await countCallToday(NOW.getTime())).toBe(2);
    // The flag is the list route's rule as SQL, selected as one more column before the page's limit.
    const selects = estimateCalls.filter(([name]) => name === 'select').map(([, arg]) => arg);
    expect(selects).toContainEqual({ raw: `${undeliveredSelfServeSql('estimates')} AS undelivered_self_serve` });
    expect(estimateCalls.findIndex(([name, arg]) => name === 'select' && arg?.raw))
      .toBeLessThan(estimateCalls.findIndex(([name]) => name === 'limit'));
    // The page drops the same row: the shared rule reads the flag through the shared mapping.
    expect(shared.isCallTodayEstimate(callTodayFields(estimateRows[1], { undeliveredSelfServe: true }), NOW.getTime())).toBe(false);
    expect(shared.isCallTodayEstimate(callTodayFields(estimateRows[1]), NOW.getTime())).toBe(true);
  });

  test('a delivered self-serve quote counts only touches since its first delivery, in the push and on the page (codex pre-push P1)', async () => {
    const { selfServeDeliveredAtSql } = require('../services/self-serve-estimates');
    // Both opened 5 h ago from the portal; staff first sent one 3 h ago (after the look), the other 8 h ago.
    estimateRows = [
      row('looked-then-sent', 5, { self_serve_delivered_at: new Date(ago(3)) }),
      row('opened-after-send', 5, { self_serve_delivered_at: new Date(ago(8)) }),
    ];
    expect(await countCallToday(NOW.getTime())).toBe(1);
    const selects = estimateCalls.filter(([name]) => name === 'select').map(([, arg]) => arg);
    expect(selects).toContainEqual({ raw: `${selfServeDeliveredAtSql('estimates')} AS self_serve_delivered_at` });
    // The page judges the rows the same way: the list route passes the same value to the same mapping.
    const judged = estimateRows.map((r) => shared.isCallTodayEstimate(
      callTodayFields(r, { selfServeDeliveredAt: r.self_serve_delivered_at }), NOW.getTime()));
    expect(judged).toEqual([false, true]);
    // A tap on the sent link is a touch since the send.
    clickRows = [{ entity_id: 'looked-then-sent', last_clicked_at: ago(2.5) }];
    expect(await countCallToday(NOW.getTime())).toBe(2);
  });

  test('a row never sent has no views, so only a tap can put it on the list (the page rule)', async () => {
    estimateRows = [row('unsent', 5, { sent_at: null })];
    expect(await countCallToday(NOW.getTime())).toBe(0);
  });

  test('agrees with the shared rule on every row, using the list route mapping', async () => {
    estimateRows = [row('a', 5), row('b', 1), row('c', 50), row('d', 47.9), row('e', 2.1)];
    const expected = estimateRows.filter((r) => shared.isCallTodayEstimate(callTodayFields(r), NOW.getTime())).length;
    expect(await countCallToday(NOW.getTime())).toBe(expected);
    expect(expected).toBe(3);
  });

  test('counts only rows the page loads: the sent list, newest 2000, unarchived', async () => {
    estimateRows = [row('a', 5)];
    await countCallToday(NOW.getTime());
    expect(estimateCalls).toContainEqual(['limit', 2000]);
    expect(estimateCalls).toContainEqual(['whereNull', 'estimates.archived_at']);
    // The sent-list scope: a row with sent_at, or a delivery attempt status. A viewed row never sent is outside it.
    const scope = estimateCalls.find(([name, arg]) => name === 'where' && typeof arg === 'function');
    const inner = [];
    const rec = { whereNotNull: (...a) => { inner.push(['whereNotNull', ...a]); return rec; }, orWhereIn: (...a) => { inner.push(['orWhereIn', ...a]); return rec; } };
    scope[1].call(rec);
    expect(inner).toEqual([['whereNotNull', 'estimates.sent_at'], ['orWhereIn', 'estimates.status', ['scheduled', 'sending', 'send_failed']]]);
  });

  test('an estimate older than the newest 2000 the page loads is not counted', async () => {
    // Newest first, as the query orders them: 2000 not-yet-eligible rows, then one old eligible one.
    estimateRows = [...Array.from({ length: 2000 }, (_, i) => row(`new-${i}`, 1)), row('old-but-eligible', 5)];
    expect(await countCallToday(NOW.getTime())).toBe(0);
    estimateRows = [row('eligible', 5), ...Array.from({ length: 1999 }, (_, i) => row(`new-${i}`, 1))];
    expect(await countCallToday(NOW.getTime())).toBe(1);
  });

  test('the list route and the push take their rows from the same estimateListQuery', () => {
    const repo = path.join(__dirname, '..', '..');
    const route = fs.readFileSync(path.join(repo, 'server/routes/admin-estimates.js'), 'utf8');
    const push = fs.readFileSync(path.join(repo, 'server/services/estimate-call-today-push.js'), 'utf8');
    expect(route).toMatch(/estimateListQuery\(db, \{/);
    expect(push).toMatch(/estimateListQuery\(db, \{ sentOnly: true \}\)\.clearSelect\(\)\.select\(CALL_TODAY_COLUMNS\)\s*\.select\(undeliveredSelfServe\)\.select\(selfServeDeliveredAt\)\.limit\(ESTIMATE_LIST_LIMIT\)/);
    expect(route).not.toMatch(/db\('estimates'\)\s*\.leftJoin\('technicians'/);
  });

  test('the page and the push import the same rule file, with no second copy', () => {
    const repo = path.join(__dirname, '..', '..');
    const page = fs.readFileSync(path.join(repo, 'client/src/pages/admin/PipelineAnalytics.jsx'), 'utf8');
    expect(page).toMatch(/from "@estimate-call-today"/);
    expect(page).not.toMatch(/function (isCallTodayEstimate|lastEngagementMs)/);
    const vite = fs.readFileSync(path.join(repo, 'client/vite.config.js'), 'utf8');
    expect(vite).toContain("'@estimate-call-today': fileURLToPath(new URL('../shared/estimate-call-today.cjs'"); // resolve.alias
    expect(vite).toMatch(/include: \[[^\]]*'@estimate-call-today'/); // optimizeDeps.include
    expect(vite).toContain('/shared\\/estimate-call-today\\.cjs$/'); // commonjsOptions.include
    const push = fs.readFileSync(path.join(repo, 'server/services/estimate-call-today-push.js'), 'utf8');
    expect(push).toMatch(/require\('\.\.\/\.\.\/shared\/estimate-call-today\.cjs'\)/);
    expect(push).not.toMatch(/function (isCallTodayEstimate|lastEngagementMs)/);
  });
});

describe('the banner', () => {
  test('sends one pushOnly banner with the count and the day', async () => {
    estimateRows = [row('a', 5), row('b', 30)];
    const result = await runEstimateCallTodayPush({ now: NOW });
    expect(result).toMatchObject({ count: 2, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('estimate_call_today', { count: 2, day: '2026-11-19' }, { pushOnly: true });
    expect(logger.info).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: 2 on the list, banner sent');
  });

  test('says "1 estimate" for one, counts only, and opens the Call today list', () => {
    const { build, rule, techVisible } = realTriggers.TRIGGER_REGISTRY.estimate_call_today;
    expect(build({ count: 3, day: '2026-11-19' })).toEqual({
      title: 'Call today: 3 estimates',
      body: 'Follow up on these recently active estimates.',
      link: '/admin/estimates?view=call_today',
    });
    expect(build({ count: 1 }).title).toBe('Call today: 1 estimate');
    expect(rule).toEqual({ area: 'Estimates', severity: 'fyi', who: 'person', expiryDays: 7 });
    expect(techVisible).toBeUndefined();
    // Never a customer name or phone, whatever the payload carries.
    const text = JSON.stringify(build({ count: 2, customerName: 'Synthetic Person', customerPhone: '+19415550101' }));
    expect(text).not.toMatch(/Synthetic|\+1941|[Nn]obody/);
  });

  test('registers its tag, sound and bell-policy entry', () => {
    expect(realTriggers.__private.pushTagFor('estimate_call_today', { day: '2026-11-19' })).toBe('waves-estimate_call_today-2026-11-19');
    expect(realTriggers.__private.pushTagFor('estimate_call_today', { day: '2026-11-20' })).not.toBe(realTriggers.__private.pushTagFor('estimate_call_today', { day: '2026-11-19' }));
    expect(require('../services/alert-sounds').soundForTrigger('estimate_call_today')).toBe('waves-reminder.caf');
    expect(require('../services/notification-bell-policy')._private.TRIGGER_BELL_ALLOWLIST.has('estimate_call_today')).toBe(true);
  });

  test('nothing on the list sends nothing and takes no claim', async () => {
    estimateRows = [row('fresh', 1), row('cold', 72)];
    const result = await runEstimateCallTodayPush({ now: NOW });
    expect(result).toEqual({ count: 0, sent: false, skipped: 'nothing_to_call' });
    expect(mockTrigger).not.toHaveBeenCalled();
    // No claim: the only raw call is the list query's select expression (no bindings).
    expect(mockDb.raw.mock.calls.filter(([, bindings]) => bindings)).toEqual([]);
  });

  test('a failed read sends nothing and says so', async () => {
    estimateRows = [row('a', 5)];
    mockLastCalled.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toEqual({ count: 0, sent: false, error: 'count_failed' });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] count failed (ECONNRESET)');
  });

  test('a failed read without a driver code never logs the error text (it can carry customer phones)', async () => {
    estimateRows = [row('a', 5)];
    mockLastCalled.mockRejectedValue(new Error('select ... where to_phone in (+19415550101, +19415550102)'));
    await runEstimateCallTodayPush({ now: NOW });
    expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] count failed (no code)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/\+1941/);
  });

  test('one claim per ET day: a second run the same day is skipped, the next day sends again', async () => {
    estimateRows = [row('a', 5)];
    expect((await runEstimateCallTodayPush({ now: NOW })).sent).toBe(true);
    const again = await runEstimateCallTodayPush({ now: new Date('2026-11-19T14:00:40Z') });
    expect(again).toMatchObject({ sent: false, skipped: 'already_claimed' });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect((await runEstimateCallTodayPush({ now: new Date('2026-11-20T14:00:00Z') })).sent).toBe(true);
    expect([...claimed]).toEqual(['estimate_call_today:2026-11-19', 'estimate_call_today:2026-11-20']);
  });

  test('no dispatch result is uncertain: the claim is kept, so a rerun sends no second banner', async () => {
    estimateRows = [row('a', 5)];
    mockTrigger.mockResolvedValueOnce(undefined);
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toEqual({ count: 1, sent: false, error: 'delivery_uncertain' });
    expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
    expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: delivery uncertain (no dispatch result); claim kept');
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: false, skipped: 'already_claimed' });
  });

  test('the push marker outranks an error a deduped dispatch also set', async () => {
    estimateRows = [row('a', 5)];
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, retryable: true, error: 'provider down', pushFailed: 'push_dispatch' });
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toEqual({ count: 1, sent: false, error: 'push_dispatch_failed' });
    expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
  });

  test('a send that did not happen frees the day for a retry', async () => {
    estimateRows = [row('a', 5)];
    mockTrigger.mockResolvedValueOnce({ error: 'x' });
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    mockTrigger.mockRejectedValueOnce(new Error('boom'));
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: true });
  });

  describe('success needs a phone that accepted the banner', () => {
    const run = () => runEstimateCallTodayPush({ now: NOW });
    beforeEach(() => { estimateRows = [row('a', 5)]; });

    test('push off (push null): a skip, the claim is released, a later run may try', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: null });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, skipped: 'no_push_delivered' });
      expect([...claimed]).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: banner skipped (push off or no device to send to); claim released');
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('banner sent'));
      mockTrigger.mockResolvedValue({ bellWritten: false, push: { sent: 1, failed: 0 } });
      await expect(run()).resolves.toMatchObject({ sent: true });
    });

    test('no device to send to (sent 0, no failure): a skip, the claim is released', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: { subscriptions: 0, sent: 0, expired: 0, failed: 0, skipped: 0 } });
      await expect(run()).resolves.toMatchObject({ sent: false, skipped: 'no_push_delivered' });
      expect([...claimed]).toEqual([]);
    });

    test('every device failed (sent 0, failed 1): uncertain, the claim stays, no second banner that day', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: { subscriptions: 1, sent: 0, failed: 1 } });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'delivery_uncertain' });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: delivery uncertain (no device accepted it, or the result was not recognized); claim kept');
      await expect(run()).resolves.toMatchObject({ skipped: 'already_claimed' });
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['an empty push object', { push: {} }],
      ['counters missing', { push: { subscriptions: 1 } }],
      ['sent without a number', { push: { sent: 'x', failed: 0 } }],
      ['sent 0 with no failed counter', { push: { sent: 0 } }],
      ['a retry pending', { push: { sent: 0, failed: 0, retryable: 1 } }],
      ['push not an object', { push: 'ok' }],
      ['no push field at all', {}],
    ])('an unrecognized delivery result (%s): uncertain, the claim stays, a same-day rerun does not dispatch again', async (_label, result) => {
      mockTrigger.mockResolvedValue({ bellWritten: false, ...result });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'delivery_uncertain' });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
      await expect(run()).resolves.toMatchObject({ skipped: 'already_claimed' });
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });

    // Phones exist but their provider has no credentials: the push service skips each device (sent 0, failed 0). That
    // is a lost banner, not a quiet day: the run reports an error so job health shows it, and the claim is released so a
    // rerun after the fix may send.
    test.each(['apns_not_configured', 'fcm_not_configured', 'push_not_configured'])(
      'a device skipped because its provider is not configured (%s): an error, the claim is released',
      async (reason) => {
        mockTrigger.mockResolvedValue({
          bellWritten: false,
          push: { subscriptions: 2, sent: 0, expired: 0, failed: 0, skipped: 2,
            results: [{ sent: false, skipped: true, reason }, { sent: false, skipped: true, reason: 'superseded' }] },
        });
        await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_not_configured' });
        expect([...claimed]).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: banner not delivered (a push provider is not configured); claim released');
      },
    );

    test('devices skipped for another reason (superseded) stay a skip', async () => {
      mockTrigger.mockResolvedValue({
        bellWritten: false,
        push: { subscriptions: 1, sent: 0, expired: 0, failed: 0, skipped: 1, results: [{ sent: false, skipped: true, reason: 'superseded' }] },
      });
      await expect(run()).resolves.toMatchObject({ sent: false, skipped: 'no_push_delivered' });
      expect([...claimed]).toEqual([]);
    });

    test.each(['claude_queue', 'bell_policy', 'superseded_before_push'])(
      'a recognized pre-send skip (sent 0, skipped %s): a skip, the claim is released',
      async (reason) => {
        mockTrigger.mockResolvedValue({ bellWritten: false, push: { sent: 0, skipped: reason } });
        await expect(run()).resolves.toMatchObject({ sent: false, skipped: 'no_push_delivered' });
        expect([...claimed]).toEqual([]);
      },
    );

    // A skip text the dispatcher never writes, or one beside a failed device, is no proof nothing reached a phone.
    test.each([
      ['an unknown skip text', { sent: 0, skipped: 'unknown' }],
      ['a known skip beside a failed device', { sent: 0, failed: 1, skipped: 'bell_policy' }],
      ['an unknown skip beside a failed device', { sent: 0, failed: 1, skipped: 'unknown' }],
      ['an empty skip text', { sent: 0, skipped: '' }],
    ])('%s: uncertain, the claim stays, a same-day rerun does not dispatch again', async (_label, push) => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'delivery_uncertain' });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
      await expect(run()).resolves.toMatchObject({ skipped: 'already_claimed' });
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });

    test('the dispatcher says its push dispatch threw (pushFailed push_dispatch): an error, the claim stays, a rerun does not dispatch', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: null, pushFailed: 'push_dispatch' });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_dispatch_failed' });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: push dispatch failed (push_dispatch); claim kept');
      await expect(run()).resolves.toMatchObject({ skipped: 'already_claimed' });
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });

    test.each(['recipient_lookup', 'before_handoff'])('the dispatcher says it threw before any push reached a provider (%s): an error, the claim is released, a rerun sends', async (marker) => {
      mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, pushFailed: marker });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'push_failed_before_handoff' });
      expect([...claimed]).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(`[estimate-call-today] 2026-11-19: push failed before any handoff (${marker}); claim released`);
      // The database is back: the same-day rerun takes the claim and sends.
      await expect(run()).resolves.toMatchObject({ count: 1, sent: true });
      expect(mockTrigger).toHaveBeenCalledTimes(2);
    });

    test('a failed recipient lookup whose claim release fails is claim_release_failed', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: null, pushFailed: 'recipient_lookup' });
      releaseFails = true;
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'claim_release_failed' });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: push failed before any handoff (recipient_lookup); claim release failed');
    });

    test('a skip whose claim release fails is claim_release_failed, and the log says the release failed', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: null });
      releaseFails = true;
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'claim_release_failed' });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']); // the row stays and blocks a same-day retry
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] claim release failed for 2026-11-19 (57P01)');
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: banner skipped (push off or no device to send to) but the claim release failed; claim kept');
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('claim released'));
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/delete from/);
    });

    test('a dispatch error or throw whose claim release fails is claim_release_failed too', async () => {
      releaseFails = true;
      mockTrigger.mockResolvedValue({ error: 'x' });
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'claim_release_failed' });
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: banner not sent (dispatch error); claim release failed');
      claimed.clear();
      mockTrigger.mockRejectedValue(Object.assign(new Error('boom'), { code: 'E1' }));
      await expect(run()).resolves.toEqual({ count: 1, sent: false, error: 'claim_release_failed' });
      expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] 2026-11-19: banner failed (E1); claim release failed');
    });

    test('one device took it and another failed: sent', async () => {
      mockTrigger.mockResolvedValue({ bellWritten: false, push: { subscriptions: 2, sent: 1, failed: 1 } });
      await expect(run()).resolves.toMatchObject({ sent: true });
      expect([...claimed]).toEqual(['estimate_call_today:2026-11-19']);
    });
  });

  test('a failed claim sends nothing', async () => {
    estimateRows = [row('a', 5)];
    // The claim INSERT fails; the list query's select expression (no bindings) still builds.
    mockDb.raw.mockImplementation((sql, bindings) => (bindings ? Promise.reject(Object.assign(new Error('x'), { code: '57P01' })) : { raw: sql }));
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toEqual({ count: 1, sent: false, error: 'claim_failed' });
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
