/**
 * Stale-visit sweep — nightly detection bell for past-dated open visits.
 * Covers the pure helpers (signature, summary copy, prior-bell coverage),
 * the gate short-circuit, the query classification, and the ring/dedupe
 * decision. Detection-only: the sweep must never touch scheduled_services
 * beyond the read. Also pins the dashboard read surface's deep link
 * (admin-command-center getStaleVisits): rows must open the dispatch
 * SCHEDULE tab, since the default Board tab ignores ?date=.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({}) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), alertEpisodesLive: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));
jest.mock('../services/admin-alert-episodes', () => ({
  closeAdminAlertIds: jest.fn(async (_conn, ids) => ids.length),
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async (_conn, keys) => keys.length),
}));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const { isEnabled, alertEpisodesLive } = require('../config/feature-gates');
const { runStaleVisitSweep, _private } = require('../services/stale-visit-sweep');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    ...overrides,
  };
}

const BACKLOG = [
  { id: 'a', status: 'pending', scheduled_date: '2026-07-10', customer_id: 'c1' },
  { id: 'b', status: 'pending', scheduled_date: '2026-07-12', customer_id: 'c2' },
  { id: 'c', status: 'on_site', scheduled_date: '2026-05-02', customer_id: 'c3' },
];

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.notifyAdmin.mockResolvedValue({});
  alertEpisodesLive.mockReturnValue(true);
  episodes.openAdminAlertKeys.mockResolvedValue([]);
});

// The sweep's two reads of `notifications`: the newest row of the category (lastBell, .first) and the open rows
// (openRowIds, .select).
function notifications({ last = null, open = [] } = {}) {
  return chain({
    first: jest.fn().mockResolvedValue(last),
    select: jest.fn().mockResolvedValue(open.map((id) => ({ id }))),
  });
}

describe('summarySignature / summarize', () => {
  test('signature covers total, per-status counts, and the oldest date', () => {
    const sig = _private.summarySignature(BACKLOG);
    expect(sig).toContain('total:3');
    expect(sig).toContain('pending:2');
    expect(sig).toContain('on_site:1');
    expect(sig).toContain('oldest:2026-05-02');
  });

  test('signature is stable across row order and normalizes Date objects', () => {
    const asDates = [...BACKLOG].reverse().map((v) => ({
      ...v,
      // pg returns plain DATE columns as Date objects.
      scheduled_date: new Date(`${v.scheduled_date}T00:00:00Z`),
    }));
    expect(_private.summarySignature(asDates)).toBe(_private.summarySignature(BACKLOG));
  });

  test('membership churn changes the signature even when counts and oldest date match', () => {
    // One visit resolves while a different one goes stale with the same
    // status and date — total, per-status counts, and oldest all unchanged.
    // The sorted-ID hash must still ring the swap.
    const swapped = [BACKLOG[0], { ...BACKLOG[1], id: 'z' }, BACKLOG[2]];
    expect(_private.summarySignature(swapped)).not.toBe(_private.summarySignature(BACKLOG));
  });

  test('summarize names non-zero statuses with counts and the oldest date', () => {
    const text = _private.summarize(BACKLOG);
    expect(text).toContain('3 past-dated visits still open');
    expect(text).toContain('2 pending');
    expect(text).toContain('1 on site');
    expect(text).not.toContain('confirmed');
    expect(text).toContain('oldest 2026-05-02');
  });
});

describe('priorBellCovers', () => {
  const now = new Date('2026-07-19T12:00:00Z');
  const sig = _private.summarySignature(BACKLOG);

  test('recent bell with the same signature covers', () => {
    expect(_private.priorBellCovers({ signature: sig, createdAt: '2026-07-18T12:00:00Z' }, sig, now)).toBe(true);
  });

  test('a changed picture is never covered', () => {
    expect(_private.priorBellCovers({ signature: 'total:2|other', createdAt: '2026-07-18T12:00:00Z' }, sig, now)).toBe(false);
  });

  test('no prior bell → not covered', () => {
    expect(_private.priorBellCovers(null, sig, now)).toBe(false);
  });

  test('a same-signature bell older than REMIND_DAYS re-rings (a frozen backlog must not go silent)', () => {
    expect(_private.priorBellCovers({ signature: sig, createdAt: '2026-07-01T12:00:00Z' }, sig, now)).toBe(false);
  });
});

describe('runStaleVisitSweep', () => {
  test('gated off → skipped, no queries', async () => {
    isEnabled.mockReturnValue(false);
    const r = await runStaleVisitSweep();
    expect(r).toEqual({ skipped: true, reason: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('clean backlog → no bell', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation(() => chain());
    const r = await runStaleVisitSweep();
    expect(r.clean).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('backlog with no prior bell rings ONE bell with the summary fingerprint', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      return chain();
    });
    const r = await runStaleVisitSweep();
    expect(r.rang).toBe(true);
    expect(r.items).toBe(3);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('stale_visit_sweep');
    expect(title).toContain('Stale visits');
    expect(body).toContain('3 past-dated visits still open');
    expect(opts.link).toBe('/admin/dashboard');
    expect(opts.metadata.summary_signature).toBe(_private.summarySignature(BACKLOG));
    expect(opts.metadata.counts).toEqual({ pending: 2, confirmed: 0, en_route: 0, on_site: 1 });
    expect(opts.metadata.oldest_date).toBe('2026-05-02');
  });

  test('an unchanged backlog covered by a recent bell stays silent', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      if (table === 'notifications') {
        return chain({
          first: jest.fn().mockResolvedValue({
            metadata: { summary_signature: _private.summarySignature(BACKLOG) },
            created_at: new Date(Date.now() - 24 * 3600e3),
          }),
        });
      }
      return chain();
    });
    const r = await runStaleVisitSweep();
    expect(r.deduped).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a changed backlog re-rings even with a recent bell', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      if (table === 'notifications') {
        return chain({
          first: jest.fn().mockResolvedValue({
            // Yesterday's picture had one fewer row — the summary changed.
            metadata: { summary_signature: _private.summarySignature(BACKLOG.slice(0, 2)) },
            created_at: new Date(Date.now() - 24 * 3600e3),
          }),
        });
      }
      return chain();
    });
    const r = await runStaleVisitSweep();
    expect(r.rang).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('query classifies on the open-status allowlist and an ET calendar-date cutoff', async () => {
    isEnabled.mockReturnValue(true);
    let visitChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        visitChain = chain();
        return visitChain;
      }
      return chain();
    });
    await runStaleVisitSweep();
    // Allowlist, not a terminal-state blocklist — rescheduled/skipped/any
    // future terminal status must never ring.
    expect(visitChain.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed', 'en_route', 'on_site']);
    // scheduled_date is an ET wall-clock DATE — the cutoff must be an ET
    // calendar-date string, never a JS Date instant.
    expect(visitChain.where).toHaveBeenCalledWith(
      'scheduled_date',
      '<',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    // Detection-only: the sweep must never mutate the rows it found.
    expect(visitChain.update).not.toHaveBeenCalled();
  });

  test('a query failure fails the sweep loudly instead of reporting clean', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        return chain({ select: jest.fn().mockRejectedValue(new Error('relation missing')) });
      }
      return chain();
    });
    await expect(runStaleVisitSweep()).rejects.toThrow('relation missing');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed bell insert fails the sweep instead of recording a ring', async () => {
    isEnabled.mockReturnValue(true);
    NotificationService.notifyAdmin.mockResolvedValue(null); // insert failed
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      return chain();
    });
    await expect(runStaleVisitSweep()).rejects.toThrow('bell not recorded');
  });
});

// 2026-11-11 audit: each night's changed list left its own row open (three rows with one title, the counts 61,
// 64 and 67, none read), because nothing closed the row a newer list replaced.
describe('one open row', () => {
  const withBacklog = (rows, notif) => db.mockImplementation((table) => {
    if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(rows) });
    if (table === 'notifications') return notifications(notif);
    return chain();
  });

  beforeEach(() => { isEnabled.mockReturnValue(true); });

  test('a new bell closes the rows that were open before it, by id', async () => {
    withBacklog(BACKLOG, { open: ['n-61', 'n-64'] });
    const r = await runStaleVisitSweep();
    expect(r).toMatchObject({ rang: true, closed: 2 });
    expect(episodes.closeAdminAlertIds).toHaveBeenCalledTimes(1);
    const [, ids, reason, opts] = episodes.closeAdminAlertIds.mock.calls[0];
    expect(ids).toEqual(['n-61', 'n-64']);
    expect(reason).toBe('stale_visits_superseded');
    expect(opts.resolution).toBe('Replaced by a newer list of stale visits');
  });

  test('a muted write leaves no new row, so the older rows stay open', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
    withBacklog(BACKLOG, { open: ['n-61'] });
    const r = await runStaleVisitSweep();
    expect(r).toMatchObject({ rang: true, closed: 0 });
    expect(episodes.closeAdminAlertIds).not.toHaveBeenCalled();
  });

  test('an unchanged list writes nothing and closes nothing', async () => {
    withBacklog(BACKLOG, {
      last: { metadata: { summary_signature: _private.summarySignature(BACKLOG) }, created_at: new Date(Date.now() - 24 * 3600e3) },
      open: ['n-61'],
    });
    const r = await runStaleVisitSweep();
    expect(r.deduped).toBe(true);
    expect(episodes.closeAdminAlertIds).not.toHaveBeenCalled();
  });

  // By key prefix through the episodes helper, which also stamps a row a person already marked done (it keeps
  // that person's done stamps). An open-rows-only close left a dismissed row as the 7-day dedupe baseline.
  test('a clean sweep clears every row not yet cleared, a dismissed one too', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue(['stale_visit_sweep:total:61', 'stale_visit_sweep:total:64']);
    withBacklog([], {});
    const r = await runStaleVisitSweep();
    expect(r).toMatchObject({ clean: true, closed: 2 });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(db, 'stale_visit_sweep:');
    const [, keys, reason, opts] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(keys).toEqual(['stale_visit_sweep:total:61', 'stale_visit_sweep:total:64']);
    expect(reason).toBe('stale_visits_clear');
    expect(opts.resolution).toBe('Cleared: no past-dated visit is still open');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('the same visits open again after a clean sweep ring again: the cleared row is no baseline', async () => {
    const cleared = { summary_signature: _private.summarySignature(BACKLOG), autoCleared: true, autoClearedReason: 'stale_visits_clear' };
    withBacklog(BACKLOG, { last: { metadata: cleared, created_at: new Date(Date.now() - 24 * 3600e3) } });
    const r = await runStaleVisitSweep();
    expect(r.rang).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('ALERT_EPISODES off: the bell still rings and nothing is closed', async () => {
    alertEpisodesLive.mockReturnValue(false);
    withBacklog(BACKLOG, { open: ['n-61'] });
    expect(await runStaleVisitSweep()).toMatchObject({ rang: true, closed: 0 });
    episodes.openAdminAlertKeys.mockResolvedValue(['stale_visit_sweep:total:61']);
    withBacklog([], { open: ['n-61'] });
    expect(await runStaleVisitSweep()).toMatchObject({ clean: true, closed: 0 });
    expect(episodes.closeAdminAlertIds).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});

describe('dashboard stale-card deep links (admin-command-center source contract)', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../routes/admin-command-center.js'),
    'utf8',
  );

  test('day links open the Schedule tab — a bare /admin/dispatch?date= lands on Board, which drops the date (Codex P2)', () => {
    // AdminDispatchPage defaults an absent ?tab= to the Board tab and only
    // mounts DispatchPageV2 — the surface whose initializers read ?date= and
    // open Day view on it — for tab=schedule. Without the tab param the
    // operator lands on the map board and the deep-linked day is ignored.
    expect(source).toMatch(/function dispatchDayHref\(date\) \{[\s\S]{0,500}return `\/admin\/dispatch\?tab=schedule&date=\$\{encodeURIComponent\(date\)\}`;\s*\n\}/);
    // And the stale rows use the day-link builder for their href.
    expect(source).toMatch(/href: dispatchDayHref\(scheduledDate\),/);
  });
});
