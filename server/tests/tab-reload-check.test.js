/**
 * tab-reload-check: the nightly read-only check that posts one engineering
 * FIX row when a staff page view ran an out-of-date portal build that should
 * have reloaded (owner 2026-11-19, option A: logging and a daily check), and
 * retires the row on a clean night. The SQL itself runs against PostgreSQL in
 * tab-reload-check-postgres.test.js.
 */
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
const { runTabReloadCheck, readWindow, OPS_KEY, FAILED_NAMES } = require('../services/tab-reload-check');
const { RELOAD_BLOCKERS } = require('../routes/admin-usage');

const TECH_A = 'a0000000-0000-4000-8000-000000000001';
const TECH_B = 'b0000000-0000-4000-8000-000000000002';
const rows = (list) => jest.fn(async () => list);
// Nov 20 2026, 11:51:02 PM EST: a nightly run, and the window it reads.
const NOW = new Date('2026-11-21T04:51:02Z');
const START = new Date('2026-11-20T04:50:00Z');
const END = new Date('2026-11-21T04:50:00Z');
// The check's own mark of how far it has read: none yet, unless a test sets one.
const markStore = { get: jest.fn(), set: jest.fn() };
const run = (options) => runTabReloadCheck({ markStore, now: NOW, ...options });

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  markStore.get.mockResolvedValue(null);
  markStore.set.mockResolvedValue();
});

describe('runTabReloadCheck', () => {
  test('a clean night retires the standing row and posts nothing', async () => {
    const readRows = rows([]);

    await expect(run({ readRows })).resolves.toEqual({ views: 0 });
    expect(readRows).toHaveBeenCalledWith({ start: START, end: END });
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
    expect(markStore.set).toHaveBeenCalledWith(END);
  });

  test('missed reloads post one FIX row with the totals for each cause and page', async () => {
    const readRows = rows([
      { reload_hold: null, page_key: 'pipeline', technician_id: TECH_A, views: '3' },
      { reload_hold: 'reloaded', page_key: 'dashboard', technician_id: TECH_A, views: '1' },
      { reload_hold: 'reloaded', page_key: 'pipeline', technician_id: TECH_B, views: '2' },
    ]);

    const result = await run({ readRows });

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
      itemKeys: ['none', 'reloaded'],
      subject: 'FIX: 6 staff page views missed a reload to the live portal build',
      headline: 'System — fix the reload of out-of-date staff tabs',
    });
    expect(sent).not.toHaveProperty('dedupeWindowMs');
    expect(sent.headline.length).toBeLessThanOrEqual(60);
    expect(sent.summary.length).toBeLessThanOrEqual(110);
    expect(sent.text).toContain('6 staff page views by 2 staff members');
    expect(sent.text).toContain('Since the last check that finished, 6 staff page views');
    expect(sent.text).toContain('- reloaded (3): three reloads for the live build');
    expect(sent.text).toContain('- no name (3): the move was due a reload');
    expect(sent.text).toContain('- pipeline: 5\n- dashboard: 1');
    expect(result.delivery).toEqual({ ok: true, channel: 'in_app', id: 'n1' });
    expect(markStore.set).toHaveBeenCalledWith(END);
  });

  // The mark moves only once a window is handled, so the next run reads again
  // what a failed run left: a read that throws, a finding not delivered.
  test('a finding that was not delivered leaves the mark, so the next run reads the window again', async () => {
    deliverOpsDigest.mockResolvedValueOnce({ ok: false, error: 'row write failed' });

    const result = await run({ readRows: rows([{ reload_hold: null, page_key: 'pipeline', technician_id: TECH_A, views: 1 }]) });

    expect(result).toEqual({ views: 1, delivery: { ok: false, error: 'row write failed' } });
    expect(markStore.set).not.toHaveBeenCalled();
    expect(retireIfClean).not.toHaveBeenCalled();
  });

  test('a run after a night that failed reads from the mark, both nights in one read', async () => {
    const twoNightsBack = new Date('2026-11-19T04:50:00Z');
    markStore.get.mockResolvedValue(twoNightsBack);
    const readRows = rows([]);

    await run({ readRows });

    expect(readRows).toHaveBeenCalledWith({ start: twoNightsBack, end: END });
    expect(markStore.set).toHaveBeenCalledWith(END);
  });

  test('a run after a finished run has read this far reads nothing and leaves the row and the mark', async () => {
    markStore.get.mockResolvedValue(END);
    const readRows = rows([]);

    // By hand the next afternoon: the night's run finished this window.
    await expect(run({ readRows, now: new Date('2026-11-21T20:00:00Z') })).resolves.toEqual({ views: 0, upToDate: true });
    expect(readRows).not.toHaveBeenCalled();
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
    expect(markStore.set).not.toHaveBeenCalled();
  });

  test('one view reads in the singular, and the html escapes what it lists', async () => {
    await run({ readRows: rows([{ reload_hold: 'reloaded', page_key: 'a<b', technician_id: TECH_A, views: 1 }]) });

    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent.subject).toBe('FIX: 1 staff page view missed a reload to the live portal build');
    expect(sent.text).toContain('1 staff page view by 1 staff member ran');
    expect(sent.text).toContain('- reloaded (1): three reloads for the live build came back on the old build');
    expect(sent.html).toContain('a&lt;b: 1');
  });

  test('a reload that came back on the build it left is a failed reload', async () => {
    await run({ readRows: rows([{ reload_hold: 'reload-missed', page_key: 'schedule', technician_id: TECH_B, views: '2' }]) });

    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent.itemKeys).toEqual(['reload-missed']);
    expect(sent.text).toContain("- reload-missed (2): the tab's own reload for a newer build came back on the build it left");
  });

  // The route stores a name only when it is on its list (RELOAD_BLOCKERS), so
  // a name this check reads that the route cannot store would never be found.
  // 'never-heard' is not read: a healthy tab sends it for a move made before
  // its first server answer.
  test('every name the check reads is a name the route stores, and each has its cause line', async () => {
    expect(FAILED_NAMES).toEqual(['reloaded', 'reload-missed']);
    for (const name of FAILED_NAMES) expect(RELOAD_BLOCKERS.has(name)).toBe(true);

    for (const name of [null, ...FAILED_NAMES]) {
      deliverOpsDigest.mockClear();
      await run({ readRows: rows([{ reload_hold: name, page_key: 'pipeline', technician_id: TECH_A, views: 1 }]) });
      const sent = deliverOpsDigest.mock.calls[0][0];
      expect(sent.text).not.toContain('undefined');
      expect(sent.html).not.toContain('undefined');
    }
  });

  test('a read that throws fails the run and never retires the row', async () => {
    const readRows = jest.fn().mockRejectedValue(new Error('column "stale_build" does not exist'));

    await expect(run({ readRows })).rejects.toThrow('stale_build');
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
    expect(markStore.set).not.toHaveBeenCalled();
  });

  test('the email fallback goes only to the internal ops inbox, and fails when the mailer is not set up', async () => {
    await run({ readRows: rows([{ reload_hold: null, page_key: 'pipeline', technician_id: TECH_A, views: '2' }]) });
    const { sendEmail } = deliverOpsDigest.mock.calls[0][0];

    await sendEmail();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FIX: 2 staff page views missed a reload to the live portal build',
      categories: ['ops', OPS_KEY],
    }));

    // The provider's answer can quote an address; the error goes to
    // job_health and the log with the status only.
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('SendGrid 403: from a@b.example does not match a verified Sender Identity'), { status: 403 }));
    await expect(sendEmail()).rejects.toThrow(/^the email to the ops inbox failed \(status 403\)$/);
    sendgrid.sendOne.mockRejectedValueOnce(new Error('connect ETIMEDOUT a@b.example'));
    await expect(sendEmail()).rejects.toThrow(/^the email to the ops inbox failed \(status unknown\)$/);

    sendgrid.sendOne.mockClear();
    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendEmail()).rejects.toThrow('mailer not configured');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

// A run reads from its mark up to the latest edge that has come: 11:50 PM
// Eastern, one minute before the job runs. From one edge to the next is 25
// hours on the night the clocks go back and 23 on the night they go forward.
describe('readWindow', () => {
  const win = (text, readTo) => {
    const { start, end } = readWindow(new Date(text), readTo ? new Date(readTo) : null);
    return [start.toISOString(), end.toISOString()];
  };
  const NOV_19 = '2026-11-20T04:50:00.000Z';
  const NOV_20 = '2026-11-21T04:50:00.000Z';
  const NOV_21 = '2026-11-22T04:50:00.000Z';

  test('with no mark, a nightly run reads from the edge of the night before up to its own', () => {
    // Nov 20 2026, 11:51:02 PM EST: up to 11:50:00 PM, not up to now.
    expect(win('2026-11-21T04:51:02Z')).toEqual([NOV_19, NOV_20]);
    // At the edge to the millisecond, and held up past midnight.
    expect(win('2026-11-21T04:50:00.000Z')).toEqual([NOV_19, NOV_20]);
    expect(win('2026-11-21T05:20:00Z')).toEqual([NOV_19, NOV_20]);
    // By hand the next day, and one millisecond before the next edge.
    expect(win('2026-11-21T15:00:00Z')).toEqual([NOV_19, NOV_20]);
    expect(win('2026-11-22T04:49:59.999Z')).toEqual([NOV_19, NOV_20]);
  });

  test('with no mark, the night the clocks go back is 25 hours and the night they go forward 23', () => {
    // Nov 1 2026, 11:51:02 PM EST. The edge before it was Oct 31, 11:50 PM EDT.
    expect(win('2026-11-02T04:51:02Z')).toEqual(['2026-11-01T03:50:00.000Z', '2026-11-02T04:50:00.000Z']);
    // Mar 14 2027, 11:51:02 PM EDT. The edge before it was Mar 13, 11:50 PM EST.
    expect(win('2027-03-15T03:51:02Z')).toEqual(['2027-03-14T04:50:00.000Z', '2027-03-15T03:50:00.000Z']);
  });

  test('a run starts at the mark: the next night, a night that failed, and never more than 7 nights back', () => {
    // The night after a finished run: it starts where that run ended.
    expect(win('2026-11-22T04:51:02Z', NOV_20)).toEqual([NOV_20, NOV_21]);
    // The run of Nov 20 failed: the run of Nov 21 reads both nights.
    expect(win('2026-11-22T04:51:02Z', NOV_19)).toEqual([NOV_19, NOV_21]);
    // A mark 7 nights back is read from; an older one is read from 7 nights back.
    expect(win('2026-11-22T04:51:02Z', '2026-11-15T04:50:00.000Z')).toEqual(['2026-11-15T04:50:00.000Z', NOV_21]);
    expect(win('2026-11-22T04:51:02Z', '2026-11-15T04:49:59.999Z')).toEqual(['2026-11-15T04:50:00.000Z', NOV_21]);
    expect(win('2026-11-22T04:51:02Z', '2026-10-01T03:50:00.000Z')).toEqual(['2026-11-15T04:50:00.000Z', NOV_21]);
  });

  test('a mark at or past the latest edge leaves nothing to read', () => {
    expect(win('2026-11-21T20:00:00Z', NOV_20)).toEqual([NOV_20, NOV_20]);
    expect(win('2026-11-21T20:00:00Z', NOV_21)).toEqual([NOV_20, NOV_20]);
  });
});
