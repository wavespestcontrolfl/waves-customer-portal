/**
 * tab-reload-check: the nightly read-only check that posts one engineering
 * FIX row when a staff page view ran an out-of-date portal build that should
 * have reloaded (owner 2026-11-19, option A: logging and a daily check), and
 * retires the row on a clean night. The SQL itself runs against PostgreSQL in
 * tab-reload-check-postgres.test.js.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n1' })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 0) }));
// Only for the route's list of names (routes/admin-usage.js).
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const sendgrid = require('../services/sendgrid-mail');
const { deliverOpsDigest } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const { runTabReloadCheck, readWindow, OPS_KEY, RUN_AT, FAILED_NAMES } = require('../services/tab-reload-check');
const { RELOAD_BLOCKERS, NO_SERVER_HEARD } = require('../routes/admin-usage');

const TECH_A = 'a0000000-0000-4000-8000-000000000001';
const TECH_B = 'b0000000-0000-4000-8000-000000000002';
const rows = (list) => jest.fn(async () => list);

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
});

describe('runTabReloadCheck', () => {
  test('a clean night retires the standing row and posts nothing', async () => {
    const readRows = rows([]);
    const now = new Date('2026-11-21T04:34:00Z');

    await expect(runTabReloadCheck({ readRows, now })).resolves.toEqual({ views: 0 });
    expect(readRows).toHaveBeenCalledWith({ now });
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('missed reloads post one FIX row with the totals for each cause and page', async () => {
    const readRows = rows([
      { reload_hold: null, page_key: 'pipeline', technician_id: TECH_A, views: '3' },
      { reload_hold: 'no-server-heard', page_key: 'dashboard', technician_id: TECH_A, views: '1' },
      { reload_hold: 'no-server-heard', page_key: 'pipeline', technician_id: TECH_B, views: '2' },
    ]);

    const result = await runTabReloadCheck({ readRows });

    expect(result.views).toBe(6);
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent).toMatchObject({
      key: OPS_KEY,
      fallOff: true,
      dedupeKey: OPS_KEY,
      refreshOnDedupe: true,
      count: 6,
      itemKeys: ['no-server-heard', 'none'],
      subject: 'FIX: 6 staff page views missed a reload to the live portal build',
      headline: 'System — fix the reload of out-of-date staff tabs',
    });
    expect(sent).not.toHaveProperty('dedupeWindowMs');
    expect(sent.headline.length).toBeLessThanOrEqual(60);
    expect(sent.summary.length).toBeLessThanOrEqual(110);
    expect(sent.text).toContain('6 staff page views by 2 staff members');
    expect(sent.text).toContain('In the day before this check, 6 staff page views');
    expect(sent.text).toContain('- no-server-heard (3): the tab had still heard no server');
    expect(sent.text).toContain('- no name (3): the move was due a reload');
    expect(sent.text).toContain('- pipeline: 5\n- dashboard: 1');
    expect(result.delivery).toEqual({ ok: true, channel: 'in_app', id: 'n1' });
  });

  test('one view reads in the singular, and the html escapes what it lists', async () => {
    await runTabReloadCheck({ readRows: rows([{ reload_hold: 'reloaded', page_key: 'a<b', technician_id: TECH_A, views: 1 }]) });

    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent.subject).toBe('FIX: 1 staff page view missed a reload to the live portal build');
    expect(sent.text).toContain('1 staff page view by 1 staff member ran');
    expect(sent.text).toContain('- reloaded (1): three reloads for the live build came back on the old build');
    expect(sent.html).toContain('a&lt;b: 1');
  });

  test('a reload that came back on the build it left is a failed reload', async () => {
    await runTabReloadCheck({ readRows: rows([{ reload_hold: 'reload-missed', page_key: 'schedule', technician_id: TECH_B, views: '2' }]) });

    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent.itemKeys).toEqual(['reload-missed']);
    expect(sent.text).toContain("- reload-missed (2): the tab's own reload for a newer build came back on the build it left");
  });

  // The route stores a name a tab sends only when it is on its list
  // (RELOAD_BLOCKERS), and one name of its own (NO_SERVER_HEARD). A name this
  // check reads that the route cannot store would never be found. The name a
  // tab sends for "heard no server" is not read: the route never stores it,
  // and a row that holds it is older than that rule.
  test('every name the check reads is a name the route stores, and each has its cause line', async () => {
    expect(FAILED_NAMES).toEqual(['no-server-heard', 'reloaded', 'reload-missed']);
    expect(FAILED_NAMES).toContain(NO_SERVER_HEARD);
    for (const name of FAILED_NAMES) expect(name === NO_SERVER_HEARD || RELOAD_BLOCKERS.has(name)).toBe(true);

    for (const name of [null, ...FAILED_NAMES]) {
      deliverOpsDigest.mockClear();
      await runTabReloadCheck({ readRows: rows([{ reload_hold: name, page_key: 'pipeline', technician_id: TECH_A, views: 1 }]) });
      const sent = deliverOpsDigest.mock.calls[0][0];
      expect(sent.text).not.toContain('undefined');
      expect(sent.html).not.toContain('undefined');
    }
  });

  test('a read that throws fails the run and never retires the row', async () => {
    const readRows = jest.fn().mockRejectedValue(new Error('column "stale_build" does not exist'));

    await expect(runTabReloadCheck({ readRows })).rejects.toThrow('stale_build');
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('the email fallback goes only to the internal ops inbox, and fails when the mailer is not set up', async () => {
    await runTabReloadCheck({ readRows: rows([{ reload_hold: null, page_key: 'pipeline', technician_id: TECH_A, views: '2' }]) });
    const { sendEmail } = deliverOpsDigest.mock.calls[0][0];

    await sendEmail();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FIX: 2 staff page views missed a reload to the live portal build',
      categories: ['ops', OPS_KEY],
    }));

    sendgrid.sendOne.mockClear();
    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendEmail()).rejects.toThrow('mailer not configured');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

// A run reads from the scheduled time of the run before it up to its own.
// From one 11:51 PM Eastern to the next is 25 hours on the night the clocks
// go back and 23 on the night they go forward.
describe('readWindow', () => {
  const iso = (text) => readWindow(new Date(text)).start.toISOString();
  const end = (text) => readWindow(new Date(text)).end.toISOString();

  test('a run reads up to its own scheduled time, so the next run starts where it ended', () => {
    // Nov 20 2026, 11:51:02 PM EST: up to 11:51:00 PM, not up to now.
    expect(end('2026-11-21T04:51:02Z')).toBe('2026-11-21T04:51:00.000Z');
    expect(iso('2026-11-22T04:51:02Z')).toBe('2026-11-21T04:51:00.000Z');
    // A moment early, and held up past midnight: the same night.
    expect(end('2026-11-21T04:50:59.990Z')).toBe('2026-11-21T04:51:00.000Z');
    expect(end('2026-11-21T05:20:00Z')).toBe('2026-11-21T04:51:00.000Z');
    // The nights the clocks change: 25 hours, then 23.
    expect(end('2026-11-02T04:51:02Z')).toBe('2026-11-02T04:51:00.000Z');
    expect(end('2027-03-15T03:51:02Z')).toBe('2027-03-15T03:51:00.000Z');
    // By hand at 10:00 AM EST: the night that ended half a day ago or more.
    expect(end('2026-11-21T15:00:00Z')).toBe('2026-11-21T04:51:00.000Z');
  });

  test('a run starts its read at the scheduled time of the night before', () => {
    // Nov 20 2026, 11:51:02 PM EST.
    expect(iso('2026-11-21T04:51:02Z')).toBe('2026-11-20T04:51:00.000Z');
    expect(iso('2026-11-21T04:51:00.000Z')).toBe('2026-11-20T04:51:00.000Z');
    // A moment early, and held up past midnight: the same night before.
    expect(iso('2026-11-21T04:50:59.990Z')).toBe('2026-11-20T04:51:00.000Z');
    expect(iso('2026-11-21T05:20:00Z')).toBe('2026-11-20T04:51:00.000Z');
  });

  test('the night the clocks go back is read whole: 25 hours', () => {
    // Nov 1 2026, 11:51:02 PM EST. The run before it was Oct 31, 11:51 PM EDT.
    expect(iso('2026-11-02T04:51:02Z')).toBe('2026-11-01T03:51:00.000Z');
    // The night after is 24 hours again.
    expect(iso('2026-11-03T04:51:02Z')).toBe('2026-11-02T04:51:00.000Z');
  });

  test('the night the clocks go forward is read once: 23 hours', () => {
    // Mar 14 2027, 11:51:02 PM EDT. The run before it was Mar 13, 11:51 PM EST.
    expect(iso('2027-03-15T03:51:02Z')).toBe('2027-03-14T04:51:00.000Z');
  });

  test('a run by hand in the day reads from the last scheduled run at least half a day old', () => {
    // Nov 21 2026, 3:00 PM EST: the run of the night before.
    expect(iso('2026-11-21T20:00:00Z')).toBe('2026-11-21T04:51:00.000Z');
    // 10:00 AM EST: that run is 10 hours old, so the one before it.
    expect(iso('2026-11-21T15:00:00Z')).toBe('2026-11-20T04:51:00.000Z');
    // Half a day to the second, 11:51:00 AM EST, and one second short of it.
    expect(iso('2026-11-21T16:51:00Z')).toBe('2026-11-21T04:51:00.000Z');
    expect(iso('2026-11-21T16:50:59Z')).toBe('2026-11-20T04:51:00.000Z');
    // 11:55 AM EST: half a day ago is 11:55 PM, after that day's scheduled time.
    expect(iso('2026-11-21T16:55:00Z')).toBe('2026-11-21T04:51:00.000Z');
  });
});

describe('scheduler wiring', () => {
  test('runs nightly at 11:51 PM ET under runExclusive, with a lazy require and a job_health rethrow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    // The read starts at this scheduled time of the night before (RUN_AT).
    const [hour, minute] = RUN_AT.split(':');
    expect(`cron.schedule('${Number(minute)} ${Number(hour)} * * *'`).toBe("cron.schedule('51 23 * * *'");
    const i = src.indexOf("cron.schedule('51 23 * * *'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('timezone', i) + 40);
    expect(block).toContain("runExclusive('tab-reload-check'");
    expect(block).toContain("require('./tab-reload-check')");
    expect(block).toContain('result.delivery.ok === false');
    expect(block).toContain("timezone: 'America/New_York'");
    // #3208 rule. failing-jobs-check.test.js also checks that no fixed or hourly job shares the minute.
    expect(src.match(/cron\.schedule\('51 23 \* \* \*'/g)).toHaveLength(1);
  });
});
