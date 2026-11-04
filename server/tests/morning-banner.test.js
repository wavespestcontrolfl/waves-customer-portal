// The 8 AM banner job (server/services/morning-banner.js, GATE_MORNING_BANNER, owner 2026-11-03 "ok add", choice C):
// what counts as waiting for the owner (judged by needs-me's own mapAlertRow), the area summary, nothing waiting = no
// banner, gate off = no read, and the once-per-ET-day claim. Rows are synthetic; no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  scopeAdminFeedToRole: jest.fn((q) => q),
  _private: { NOTIFICATION_VERSION_SQL: jest.requireActual('../services/notification-service')._private.NOTIFICATION_VERSION_SQL },
}));
const mockDb = jest.fn();
mockDb.raw = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ morningBannerLive: jest.fn(() => true) }));
const mockTrigger = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTrigger(...args),
  // needs-me reads a stored registry event's declared severity.
  TRIGGER_REGISTRY: { payment_succeeded: { rule: { severity: 'fyi' } } },
}));
const mockOpenRows = jest.fn();
jest.mock('../services/needs-me', () => ({
  openAlertRows: (...args) => mockOpenRows(...args),
  mapAlertRow: jest.requireActual('../services/needs-me').mapAlertRow,
}));

const logger = require('../services/logger');
const { morningBannerLive } = require('../config/feature-gates');
const { runMorningBanner, summarize } = require('../services/morning-banner');

let rowSeq = 0;
// A stored admin alert row as openAlertRows returns it: a composed row names its own area, severity and who.
const row = (meta = {}, over = {}) => {
  rowSeq += 1;
  return {
    id: `n${rowSeq}`, category: 'system', title: `Synthetic item ${rowSeq}`, link: '/admin/agents',
    metadata: { area: 'System', severity: 'needs-you', who: 'person', doneWhen: 'handled', subject: { type: 'customer', id: `c${rowSeq}` }, ...meta },
    created_at: '2026-11-03T12:00:00Z', read_at: null, ...over,
  };
};
const many = (n, meta) => Array.from({ length: n }, () => row(meta));

const MORNING = new Date('2026-11-03T13:00:00Z'); // 8:00 AM EST

let claimed;
beforeEach(() => {
  jest.clearAllMocks();
  rowSeq = 0;
  morningBannerLive.mockReturnValue(true);
  claimed = new Set();
  mockDb.raw.mockImplementation(async (_sql, [key]) => {
    if (claimed.has(key)) return { rows: [] };
    claimed.add(key);
    return { rows: [{ id: claimed.size }] };
  });
  const del = jest.fn().mockResolvedValue(1);
  mockDb.mockImplementation(() => ({ where: ({ claim_key: key }) => ({ del: async () => { claimed.delete(key); return del(); } }) }));
  mockTrigger.mockResolvedValue({ bellWritten: false, push: { sent: 1 } });
});

describe('what counts as waiting', () => {
  test('counts open needs-you and broken alerts for a person, grouped by area, busiest first', async () => {
    mockOpenRows.mockResolvedValue([
      ...many(2, { area: 'Billing' }),
      ...many(3, { area: 'Comms' }),
      row({ area: 'Schedule', severity: 'broken' }),
      row({ area: 'Estimates' }),
    ]);
    const result = await runMorningBanner({ now: MORNING });
    expect(mockOpenRows).toHaveBeenCalledWith('admin');
    expect(result).toMatchObject({ count: 7, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('waiting_summary', {
      count: 7,
      areas: [{ area: 'Comms', count: 3 }, { area: 'Billing', count: 2 }, { area: 'Schedule', count: 1 }, { area: 'Estimates', count: 1 }],
      day: '2026-11-03',
    }, { pushOnly: true });
  });

  test('leaves out fyi, Claude and either rows, Activity-only rows, rows sent to Claude and unsorted rows', async () => {
    mockOpenRows.mockResolvedValue([
      row({ area: 'Comms' }), // counts
      row({ severity: 'fyi' }),
      row({ who: 'claude' }),
      row({ who: 'either' }),
      row({ feed: 'activity' }),
      row({ claudeQueue: 'sent-to-claude' }),
      // A raw row with no stamped severity that is neither a digest nor a registry event: unsorted.
      row({ area: undefined, severity: undefined, who: undefined, doneWhen: undefined, subject: undefined }, { category: 'misc_raw' }),
      // A registry event whose rule is fyi, stored without a severity stamp, is a fact, not work.
      row({ area: undefined, severity: undefined, who: undefined, doneWhen: undefined, subject: undefined, triggerKey: 'payment_succeeded' }, { category: 'payment' }),
    ]);
    const result = await runMorningBanner({ now: MORNING });
    expect(result.count).toBe(1);
    expect(mockTrigger.mock.calls[0][1].areas).toEqual([{ area: 'Comms', count: 1 }]);
  });

  test('summarize ties break in the catalog area order, and the dashboard standing counts are not counted', () => {
    const alert = (area) => ({ kind: 'alert', area, who: 'person', severity: 'needs-you' });
    expect(summarize([alert('Billing'), alert('Comms'), alert('Schedule'), alert('Billing')])).toEqual({
      count: 4, areas: [{ area: 'Billing', count: 2 }, { area: 'Comms', count: 1 }, { area: 'Schedule', count: 1 }],
    });
    expect(summarize([{ kind: 'standing', area: 'Billing', who: 'person', severity: 'needs-you', count: 12 }])).toEqual({ count: 0, areas: [] });
  });
});

describe('when it sends nothing', () => {
  test('nothing waiting: no banner and no claim, one log line with the count', async () => {
    mockOpenRows.mockResolvedValue([row({ severity: 'fyi' }), row({ who: 'claude' })]);
    const result = await runMorningBanner({ now: MORNING });
    expect(result).toEqual({ count: 0, sent: false, skipped: 'nothing_waiting' });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockDb.raw).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[morning-banner] 2026-11-03: 0 items waiting, no banner');
  });

  test('gate off: returns before any read', async () => {
    morningBannerLive.mockReturnValue(false);
    mockOpenRows.mockResolvedValue(many(3));
    await expect(runMorningBanner({ now: MORNING })).resolves.toEqual({ skipped: 'gate_off' });
    expect(mockOpenRows).not.toHaveBeenCalled();
    expect(mockDb.raw).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('an unreadable list sends nothing and does not throw', async () => {
    mockOpenRows.mockRejectedValue(new Error('connection reset'));
    await expect(runMorningBanner({ now: MORNING })).resolves.toEqual({ count: 0, sent: false, error: 'count_failed' });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[morning-banner] count failed: connection reset');
  });
});

describe('once per ET day', () => {
  test('a second run the same ET day (another instance, a restart) sends nothing', async () => {
    mockOpenRows.mockResolvedValue(many(2));
    expect((await runMorningBanner({ now: MORNING })).sent).toBe(true);
    const again = await runMorningBanner({ now: new Date('2026-11-03T13:00:40Z') });
    expect(again).toEqual({ count: 2, sent: false, skipped: 'already_claimed' });
    // Late in the evening ET it is still the same ET day.
    expect((await runMorningBanner({ now: new Date('2026-11-04T03:30:00Z') })).skipped).toBe('already_claimed');
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect([...claimed]).toEqual(['morning_banner:2026-11-03']);
  });

  test('the next ET day sends again, across the November fall-back day too', async () => {
    mockOpenRows.mockResolvedValue(many(2));
    // 8:00 AM ET on 2026-11-01 (clocks fell back at 2 AM) is 13:00 UTC; on 2026-10-31 it was 12:00 UTC.
    await runMorningBanner({ now: new Date('2026-10-31T12:00:00Z') });
    await runMorningBanner({ now: new Date('2026-11-01T13:00:00Z') });
    await runMorningBanner({ now: new Date('2026-11-02T13:00:00Z') });
    expect(mockTrigger).toHaveBeenCalledTimes(3);
    expect(mockTrigger.mock.calls.map(([, payload]) => payload.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  test('a send that definitely did not happen releases the claim so a rerun can send', async () => {
    mockOpenRows.mockResolvedValue(many(2));
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, prefsUnavailable: true });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    mockTrigger.mockRejectedValueOnce(new Error('boom'));
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: true });
    expect(claimed.size).toBe(1);
  });

  test('a claim that cannot be taken sends nothing', async () => {
    mockOpenRows.mockResolvedValue(many(2));
    mockDb.raw.mockRejectedValueOnce(Object.assign(new Error('relation missing'), { code: '42P01' }));
    await expect(runMorningBanner({ now: MORNING })).resolves.toEqual({ count: 2, sent: false, error: 'claim_failed' });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('the log line carries the count and no customer data', async () => {
    mockOpenRows.mockResolvedValue(many(4));
    await runMorningBanner({ now: MORNING });
    expect(logger.info).toHaveBeenCalledWith('[morning-banner] 2026-11-03: 4 item(s) waiting, banner sent');
    for (const [line] of [...logger.info.mock.calls, ...logger.error.mock.calls]) expect(line).not.toMatch(/Synthetic item/);
  });
});
