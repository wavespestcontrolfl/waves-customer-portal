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
beforeEach(() => {
  jest.clearAllMocks();
  estimateRows = [];
  clickRows = [];
  claimed = new Set();
  mockLastCalled.mockResolvedValue(new Map());
  mockDb.raw.mockImplementation(async (_sql, [key]) => {
    if (claimed.has(key)) return { rows: [] };
    claimed.add(key);
    return { rows: [{ id: claimed.size }] };
  });
  const chain = (rows) => {
    const q = { where: () => q, whereNull: () => q, whereRaw: () => q, whereIn: () => q, groupBy: () => q, select: () => q, max: () => q, then: (ok, no) => Promise.resolve(rows).then(ok, no) };
    return q;
  };
  mockDb.mockImplementation((table) => {
    if (table === 'estimates') return chain(estimateRows);
    if (table === 'short_codes') return chain(clickRows);
    if (table === 'sms_send_claims') return { where: ({ claim_key: key }) => ({ del: async () => { claimed.delete(key); return 1; } }) };
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
      body: 'Opened in the last 2 days. Nobody has called yet.',
      link: '/admin/estimates?view=call_today',
    });
    expect(build({ count: 1 }).title).toBe('Call today: 1 estimate');
    expect(rule).toEqual({ area: 'Estimates', severity: 'fyi', who: 'person', expiryDays: 7 });
    expect(techVisible).toBeUndefined();
    // Never a customer name or phone, whatever the payload carries.
    const text = JSON.stringify(build({ count: 2, customerName: 'Synthetic Person', customerPhone: '+19415550101' }));
    expect(text).not.toMatch(/Synthetic|\+1941/);
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
    expect(mockDb.raw).not.toHaveBeenCalled();
  });

  test('a failed read sends nothing and says so', async () => {
    estimateRows = [row('a', 5)];
    mockLastCalled.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toEqual({ count: 0, sent: false, error: 'count_failed' });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[estimate-call-today] count failed: ECONNRESET');
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

  test('a send that did not happen frees the day for a retry', async () => {
    estimateRows = [row('a', 5)];
    mockTrigger.mockResolvedValueOnce({ error: 'x' });
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    mockTrigger.mockRejectedValueOnce(new Error('boom'));
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toMatchObject({ sent: true });
  });

  test('a failed claim sends nothing', async () => {
    estimateRows = [row('a', 5)];
    mockDb.raw.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    await expect(runEstimateCallTodayPush({ now: NOW })).resolves.toEqual({ count: 1, sent: false, error: 'claim_failed' });
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
