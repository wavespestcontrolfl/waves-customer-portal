// The 8 AM banner job (server/services/morning-banner.js, owner 2026-11-03 "ok add", choice C):
// what counts as waiting for the owner (judged by needs-me's own mapAlertRow), the area summary, nothing waiting = no
// banner, and the once-per-ET-day claim. Rows are synthetic; no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  scopeAdminFeedToRole: jest.fn((q) => q),
  _private: { NOTIFICATION_VERSION_SQL: jest.requireActual('../services/notification-service')._private.NOTIFICATION_VERSION_SQL },
}));
const mockDb = jest.fn();
mockDb.raw = jest.fn();
jest.mock('../models/db', () => mockDb);
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
let activeAdmins;
beforeEach(() => {
  jest.clearAllMocks();
  rowSeq = 0;
  claimed = new Set();
  activeAdmins = [{ id: 1, email: 'contact@wavespestcontrol.com' }];
  mockDb.raw.mockImplementation(async (_sql, [key]) => {
    if (claimed.has(key)) return { rows: [] };
    claimed.add(key);
    return { rows: [{ id: claimed.size }] };
  });
  const del = jest.fn().mockResolvedValue(1);
  mockDb.mockImplementation((table) => {
    if (table === 'technicians') {
      return { where: () => ({ select: async () => activeAdmins }) };
    }
    return {
      where: ({ claim_key: key }) => ({
        first: async () => (claimed.has(key) ? { id: 1 } : null),
        del: async () => { claimed.delete(key); return del(); },
      }),
      whereIn: (_col, keys) => ({
        first: async () => (keys.some((k) => claimed.has(k)) ? { id: 1 } : null),
        del: async () => { for (const k of keys) claimed.delete(k); return del(); },
      }),
    };
  });
  mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
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
    expect(mockOpenRows).toHaveBeenCalledWith('admin', null, true);
    expect(result).toMatchObject({ count: 7, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('waiting_summary', {
      count: 7,
      total: 7,
      areas: [{ area: 'Comms', count: 3 }, { area: 'Billing', count: 2 }, { area: 'Schedule', count: 1 }, { area: 'Estimates', count: 1 }],
      day: '2026-11-03',
    }, { pushOnly: true, onlyUserIds: [1] });
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
      count: 4, total: 4, areas: [{ area: 'Billing', count: 2 }, { area: 'Comms', count: 1 }, { area: 'Schedule', count: 1 }],
    });
    expect(summarize([{ kind: 'standing', area: 'Billing', who: 'person', severity: 'needs-you', count: 12 }])).toEqual({ count: 0, total: 0, areas: [] });
  });

  // Owner 2026-11-04 "fix count": the title counts what nobody has read; read items only add to "open in all".
  test('read items count toward the total, not the title or the areas', async () => {
    mockOpenRows.mockResolvedValue([
      ...many(3, { area: 'Comms' }),
      row({ area: 'Billing' }, { read_at: '2026-10-20T12:00:00Z' }),
      row({ area: 'Billing' }, { read_at: '2026-10-21T12:00:00Z' }),
    ]);
    const result = await runMorningBanner({ now: MORNING });
    expect(result).toMatchObject({ count: 3, sent: true });
    expect(mockTrigger.mock.calls[0][1]).toEqual({ count: 3, total: 5, areas: [{ area: 'Comms', count: 3 }], day: '2026-11-03' });
    expect(logger.info).toHaveBeenCalledWith('[morning-banner] 2026-11-03: 3 unread of 5 waiting, banner sent');
  });
});

describe('when it sends nothing', () => {
  test('nothing waiting: no banner and no claim, one log line with the count', async () => {
    mockOpenRows.mockResolvedValue([row({ severity: 'fyi' }), row({ who: 'claude' })]);
    const result = await runMorningBanner({ now: MORNING });
    expect(result).toEqual({ count: 0, sent: false, skipped: 'nothing_waiting' });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockDb.raw).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[morning-banner] 2026-11-03: 0 unread of 0 waiting, no banner');
  });

  test('everything waiting was already read: no banner and no claim', async () => {
    mockOpenRows.mockResolvedValue([row({ area: 'Comms' }, { read_at: '2026-10-20T12:00:00Z' }), row({ area: 'Billing' }, { read_at: '2026-10-21T12:00:00Z' })]);
    const result = await runMorningBanner({ now: MORNING });
    expect(result).toEqual({ count: 0, sent: false, skipped: 'nothing_waiting' });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockDb.raw).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[morning-banner] 2026-11-03: 0 unread of 2 waiting, no banner');
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
    expect([...claimed].sort()).toEqual(['morning_banner:2026-11-03', 'morning_banner:2026-11-03:owner', 'morning_banner:2026-11-03:scoped']);
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

  test('a send that definitely did not happen releases the claim so a rerun can send, while post-handoff failure keeps it', async () => {
    mockOpenRows.mockResolvedValue(many(2));
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, prefsUnavailable: true });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, pushFailed: 'recipient_lookup' });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, pushFailed: 'before_handoff' });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    mockTrigger.mockRejectedValueOnce(new Error('boom'));
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    // Missing push credentials (skipped with apns_not_configured / push_not_configured)
    // is a delivery failure, NOT a routine skip — releases the claim so retry works once configured.
    mockTrigger.mockResolvedValueOnce({
      bellWritten: false,
      push: { sent: 0, failed: 0, skipped: 1, subscriptions: 1, results: [{ sent: false, skipped: true, reason: 'apns_not_configured' }] },
    });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, error: 'push_not_configured' });
    expect(claimed.size).toBe(0);
    // Opt-outs / empty subscriptions (sent=0, failed=0, no config error) report skipped and release claim.
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: { sent: 0, failed: 0, subscriptions: 0 } });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, skipped: 'no_delivery' });
    expect(claimed.size).toBe(0);
    // Per-device failure after handoff (push.failed > 0) may have had its ack lost ->
    // treat as uncertain and KEEP the claim so a rerun never sends a duplicate banner.
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: { sent: 0, failed: 2, subscriptions: 2 } });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, uncertain: true });
    expect(claimed.has('morning_banner:2026-11-03')).toBe(true);
    expect(claimed.has('morning_banner:2026-11-03:owner')).toBe(true);
    claimed.clear();
    // Provider handoff may already have happened -> keep both claims to avoid duplicates,
    // but report uncertain delivery instead of claiming sent: true.
    mockTrigger.mockResolvedValueOnce({ bellWritten: false, push: null, pushFailed: 'push_dispatch' });
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, uncertain: true });
    expect(claimed.has('morning_banner:2026-11-03')).toBe(true);
    expect(claimed.has('morning_banner:2026-11-03:owner')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('delivery uncertain'));
    mockTrigger.mockClear();
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ sent: false, skipped: 'already_claimed' });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('a failed recipient lookup leaves no stranded daily claim so a rerun succeeds', async () => {
    mockOpenRows.mockResolvedValue(many(2));
    let failOnce = true;
    const origImpl = mockDb.getMockImplementation();
    mockDb.mockImplementation((table) => {
      if (table === 'technicians' && failOnce) {
        failOnce = false;
        return { where: () => ({ select: async () => { throw new Error('technicians lookup failed'); } }) };
      }
      return origImpl(table);
    });
    await expect(runMorningBanner({ now: MORNING })).resolves.toEqual({ count: 2, sent: false, error: 'dispatch_failed' });
    expect(claimed.size).toBe(0);
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ count: 2, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
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
    expect(logger.info).toHaveBeenCalledWith('[morning-banner] 2026-11-03: 4 unread of 4 waiting, banner sent');
    for (const [line] of [...logger.info.mock.calls, ...logger.error.mock.calls]) expect(line).not.toMatch(/Synthetic item/);
  });

  test('unread ownerOnly alerts ring only the owner and keep non-owner admin banners restricted', async () => {
    activeAdmins = [
      { id: 1, email: 'contact@wavespestcontrol.com' },
      { id: 2, email: 'office@wavespestcontrol.com' },
    ];

    // Only an ownerOnly cash-forecast alert is unread -> only the owner gets a banner.
    mockOpenRows.mockResolvedValue([row({ area: 'Billing', ownerOnly: true })]);
    const ownerOnlyResult = await runMorningBanner({ now: MORNING });
    expect(ownerOnlyResult).toMatchObject({ count: 1, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith(
      'waiting_summary',
      { count: 1, total: 1, areas: [{ area: 'Billing', count: 1 }], day: '2026-11-03' },
      { pushOnly: true, onlyUserIds: [1] },
    );

    // Mix of ownerOnly + shared alerts -> owner gets 2, other admin gets 1.
    mockTrigger.mockClear();
    claimed.clear();
    mockOpenRows.mockResolvedValue([
      row({ area: 'Billing', ownerOnly: true }),
      row({ area: 'Comms' }),
    ]);
    const mixedResult = await runMorningBanner({ now: MORNING });
    expect(mixedResult).toMatchObject({ count: 2, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(2);
    expect(mockTrigger).toHaveBeenCalledWith(
      'waiting_summary',
      { count: 2, total: 2, areas: [{ area: 'Comms', count: 1 }, { area: 'Billing', count: 1 }], day: '2026-11-03' },
      { pushOnly: true, onlyUserIds: [1] },
    );
    expect(mockTrigger).toHaveBeenCalledWith(
      'waiting_summary',
      { count: 1, total: 1, areas: [{ area: 'Comms', count: 1 }], day: '2026-11-03' },
      { pushOnly: true, onlyUserIds: [2] },
    );

    // Partial failure: owner dispatch fails with prefsUnavailable while shared succeeds ->
    // reports dispatch_failed, keeps shared claim, releases owner claim so retry sends only to owner.
    mockTrigger.mockClear();
    claimed.clear();
    mockTrigger
      .mockResolvedValueOnce({ bellWritten: false, push: null, prefsUnavailable: true })
      .mockResolvedValueOnce({ bellWritten: false, push: { sent: 1 } })
      .mockResolvedValueOnce({ bellWritten: false, push: { sent: 1 } });
    const partial = await runMorningBanner({ now: MORNING });
    expect(partial).toEqual({ count: 2, sent: false, error: 'dispatch_failed' });
    expect([...claimed].sort()).toEqual(['morning_banner:2026-11-03', 'morning_banner:2026-11-03:scoped', 'morning_banner:2026-11-03:shared']);

    mockTrigger.mockClear();
    const retry = await runMorningBanner({ now: MORNING });
    expect(retry).toMatchObject({ count: 2, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith(
      'waiting_summary',
      { count: 2, total: 2, areas: [{ area: 'Comms', count: 1 }, { area: 'Billing', count: 1 }], day: '2026-11-03' },
      { pushOnly: true, onlyUserIds: [1] },
    );

    // Same-day rerun after the alert mix changes (shared-only -> mixed) keeps stable keys
    // and never sends a duplicate banner to either audience.
    mockTrigger.mockClear();
    claimed.clear();
    mockOpenRows.mockResolvedValue([row({ area: 'Comms' })]);
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ count: 1, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(2);
    expect([...claimed].sort()).toEqual(['morning_banner:2026-11-03', 'morning_banner:2026-11-03:owner', 'morning_banner:2026-11-03:scoped', 'morning_banner:2026-11-03:shared']);

    mockTrigger.mockClear();
    mockOpenRows.mockResolvedValue([row({ area: 'Comms' }), row({ area: 'Billing', ownerOnly: true })]);
    await expect(runMorningBanner({ now: MORNING })).resolves.toEqual({ count: 2, sent: false, skipped: 'already_claimed' });
    expect(mockTrigger).not.toHaveBeenCalled();

    // Reverse mix change (owner-only -> mixed): owner is already claimed, so only non-owner admins send.
    mockTrigger.mockClear();
    claimed.clear();
    mockOpenRows.mockResolvedValue([row({ area: 'Billing', ownerOnly: true })]);
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ count: 1, sent: true });
    expect([...claimed].sort()).toEqual(['morning_banner:2026-11-03', 'morning_banner:2026-11-03:owner', 'morning_banner:2026-11-03:scoped']);

    mockTrigger.mockClear();
    mockOpenRows.mockResolvedValue([row({ area: 'Billing', ownerOnly: true }), row({ area: 'Comms' })]);
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ count: 2, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith(
      'waiting_summary',
      { count: 1, total: 1, areas: [{ area: 'Comms', count: 1 }], day: '2026-11-03' },
      { pushOnly: true, onlyUserIds: [2] },
    );

    // Interrupted new run (legacy + :scoped committed, crash before either audience claimed):
    // rerun detects the :scoped marker and resumes unclaimed audiences.
    mockTrigger.mockClear();
    claimed.clear();
    claimed.add('morning_banner:2026-11-03');
    claimed.add('morning_banner:2026-11-03:scoped');
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ count: 2, sent: true });
    expect(mockTrigger).toHaveBeenCalledTimes(2);

    // Rollout order 1 (old -> new): a legacy bare-date claim (`morning_banner:<day>`) written by
    // the previous release suppresses both per-audience banners on a same-day rerun.
    mockTrigger.mockClear();
    claimed.clear();
    claimed.add('morning_banner:2026-11-03');
    await expect(runMorningBanner({ now: MORNING })).resolves.toEqual({ count: 2, sent: false, skipped: 'already_claimed' });
    expect(mockTrigger).not.toHaveBeenCalled();

    // Rollout order 2 (new -> old): new release atomically reserves `morning_banner:<day>` too,
    // so an older instance attempting takeSendClaim('morning_banner:2026-11-03') gets false.
    mockTrigger.mockClear();
    claimed.clear();
    await expect(runMorningBanner({ now: MORNING })).resolves.toMatchObject({ count: 2, sent: true });
    expect(claimed.has('morning_banner:2026-11-03')).toBe(true);
    const oldInstanceClaim = await mockDb.raw('INSERT INTO sms_send_claims (claim_key) VALUES (?) ON CONFLICT DO NOTHING RETURNING id', ['morning_banner:2026-11-03']);
    expect(oldInstanceClaim.rows).toEqual([]);
  });
});
