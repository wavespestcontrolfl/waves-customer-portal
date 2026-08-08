/**
 * Review sync health check (2026-08-08 audit follow-up): the degraded-sync
 * bell only fires when the sync MECHANICS fail — these tests pin the
 * OUTCOME-level classes it missed for months (Venice's silently-empty feed,
 * frozen Places stats, never-ingested reviews) and the exception-only
 * email-first escalation.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockNotifyAdmin = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockEmailSend = jest.fn(async () => ({ ok: true }));
jest.mock('../services/email', () => ({ send: (...a) => mockEmailSend(...a) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: async (_k, fn) => fn() }));

const db = require('../models/db');
db.raw = (sql) => sql;
const gbp = require('../services/google-business');

const NOW = Date.parse('2026-08-08T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

describe('_classifyLocationSyncHealth (pure classifier)', () => {
  const classify = (over = {}) => gbp._classifyLocationSyncHealth({
    hasResource: true,
    source: 'gbp',
    pulledCount: 100,
    rowCount: 100,
    newestIngestAt: daysAgo(1),
    statsUpdatedAt: daysAgo(1),
    statsTotal: 100,
    now: NOW,
    ...over,
  });

  test('healthy location classifies null', () => {
    expect(classify()).toBeNull();
  });

  test('non-GBP location and concurrent skips are never findings', () => {
    expect(classify({ hasResource: false, source: 'none', rowCount: 0 })).toBeNull();
    expect(classify({ source: 'concurrent_skip', rowCount: 0 })).toBeNull();
  });

  test('nothing synced at all → feed_down FIX', () => {
    expect(classify({ source: 'none' })).toMatchObject({ cls: 'feed_down', severity: 'FIX' });
  });

  test('Places-sample fallback → feed_degraded ACT', () => {
    expect(classify({ source: 'places_fallback' })).toMatchObject({ cls: 'feed_degraded', severity: 'ACT' });
  });

  test('GBP pull succeeds on an EMPTY feed → silent_empty ACT (the Venice class)', () => {
    // Mechanically "healthy": source is gbp, no error — but the CURRENT pull
    // returned zero reviews. Judged on the pull, not retained rows: a wiped
    // profile keeps its historical rows (missing_since-stamped), so a
    // stored-row count would read healthy forever after the wipe.
    expect(classify({ pulledCount: 0, rowCount: 0, statsTotal: undefined, statsUpdatedAt: null, newestIngestAt: null }))
      .toMatchObject({ cls: 'silent_empty', severity: 'ACT' });
    // The post-wipe shape: 47 retained stamped rows, empty feed → still caught.
    expect(classify({ pulledCount: 0, rowCount: 47 }))
      .toMatchObject({ cls: 'silent_empty', severity: 'ACT' });
  });

  test('Google shows more reviews than ever ingested + 14d of silence → ingest_stale ACT', () => {
    expect(classify({ rowCount: 47, statsTotal: 60, newestIngestAt: daysAgo(58) }))
      .toMatchObject({ cls: 'ingest_stale', severity: 'ACT' });
    // Fresh ingest with the same totals gap is NOT stale — reviews may just
    // be mid-sync this hour.
    expect(classify({ rowCount: 47, statsTotal: 60, newestIngestAt: daysAgo(2) })).toBeNull();
  });

  test('frozen or missing Places stats → stats_stale ACT', () => {
    expect(classify({ statsUpdatedAt: daysAgo(71) })).toMatchObject({ cls: 'stats_stale', severity: 'ACT' });
    expect(classify({ statsUpdatedAt: null })).toMatchObject({ cls: 'stats_stale', severity: 'ACT' });
    expect(classify({ statsUpdatedAt: daysAgo(2) })).toBeNull();
  });
});

describe('_assessReviewSyncHealth (escalation)', () => {
  function installDb({ aggregates = [], stats = [], recentNotification = null } = {}) {
    db.mockImplementation((table) => {
      const q = {
        select: jest.fn(function () { return this; }),
        groupBy: jest.fn(async function () { return aggregates; }),
        where: jest.fn(function (a) {
          this._statsQuery = a && a.reviewer_name === '_stats';
          this._notifQuery = a && a.recipient_type === 'admin';
          return this;
        }),
        first: jest.fn(async () => recentNotification),
      };
      // The _stats select resolves via .select() being awaited after .where()
      q.select = jest.fn(function () {
        if (this._statsQuery) return Promise.resolve(stats);
        return this;
      });
      return q;
    });
  }

  beforeEach(() => {
    // The assessment compares fixtures against the REAL clock — freeze it to
    // the fixture anchor or the suite starts failing by itself once the
    // calendar passes the fixtures' window (codex #3298 r1).
    jest.useFakeTimers().setSystemTime(NOW);
    mockEmailSend.mockClear();
    mockNotifyAdmin.mockClear();
    delete process.env.REVIEW_SYNC_HEALTH_EMAIL;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('healthy fleet sends NOTHING (exception-based)', async () => {
    installDb({
      aggregates: [
        { location_id: 'bradenton', row_count: '109', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
        { location_id: 'parrish', row_count: '33', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
        { location_id: 'sarasota', row_count: '47', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
        { location_id: 'venice', row_count: '12', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
      ],
      stats: [],
    });
    const out = await gbp._assessReviewSyncHealth(
      { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' },
      { bradenton: 109, parrish: 33, sarasota: 47, venice: 12 },
    );
    expect(out).toEqual({ healthy: true });
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('problems email contact@ FIRST with the ACT:/FIX: subject and bell as dedupe marker', async () => {
    installDb({ aggregates: [], stats: [] }); // venice-class everywhere: zero rows
    const out = await gbp._assessReviewSyncHealth(
      { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' },
      { bradenton: 0, parrish: 0, sarasota: 0, venice: 0 },
    );
    expect(out.emailed).toBe(true);
    const sent = mockEmailSend.mock.calls[0][0];
    expect(sent.to).toBe('contact@wavespestcontrol.com');
    expect(sent.subject).toMatch(/^ACT: Google review sync/);
    expect(sent.body).toContain('silent_empty');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    // The dedupe/backup bell must survive GATE_ADMIN_BELL_POLICY — without
    // the explicit tag the marker vanishes and the email resends hourly.
    expect(mockNotifyAdmin.mock.calls[0][3]).toMatchObject({ bell: true });
    // Marker-first ordering: the durable claim lands BEFORE the SMTP send.
    expect(mockNotifyAdmin.mock.invocationCallOrder[0])
      .toBeLessThan(mockEmailSend.mock.invocationCallOrder[0]);
    // Signature-keyed title: a different location/class set must NOT be
    // suppressed by this escalation's dedupe row.
    expect(mockNotifyAdmin.mock.calls[0][1]).toMatch(/^Review sync health escalation \[.*silent_empty/);
  });

  test('feed_down escalates the subject to FIX:', async () => {
    installDb({ aggregates: [], stats: [] });
    await gbp._assessReviewSyncHealth({ bradenton: 'none', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {});
    expect(mockEmailSend.mock.calls[0][0].subject).toMatch(/^FIX: Google review sync/);
  });

  test('24h dedupe: a recent notification row suppresses the resend', async () => {
    installDb({ aggregates: [], stats: [], recentNotification: { id: 'n1' } });
    const out = await gbp._assessReviewSyncHealth({ venice: 'gbp' });
    expect(out).toEqual({ deduped: true });
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('email failure still leaves the full escalation on the bell', async () => {
    mockEmailSend.mockResolvedValueOnce({ ok: false, error: 'smtp down' });
    installDb({ aggregates: [], stats: [] });
    const out = await gbp._assessReviewSyncHealth({ venice: 'gbp' });
    expect(out.emailed).toBe(false);
    // The bell always carries the whole body — it is the durable claim AND
    // the backup surface, written before the send.
    const bell = mockNotifyAdmin.mock.calls[0];
    expect(bell[2]).toContain('silent_empty');
    expect(bell[2]).toMatch(/^ACT: Google review sync/);
  });

  test('a failed marker write blocks the email — no marker, no send', async () => {
    // notifyAdmin swallows DB errors and returns null; sending anyway would
    // resend the email every hourly run with no dedupe row to stop it.
    mockNotifyAdmin.mockResolvedValueOnce(null);
    installDb({ aggregates: [], stats: [] });
    const out = await gbp._assessReviewSyncHealth({ venice: 'gbp' });
    expect(out).toEqual({ skipped: 'marker_failed' });
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a partial cycle (concurrent_skip anywhere) defers the whole assessment', async () => {
    // Two overlapping runners each hold some location locks — each would see
    // a different partial fleet, build a different signature, and both would
    // email. A split cycle waits for the next complete one instead.
    installDb({ aggregates: [], stats: [] });
    const out = await gbp._assessReviewSyncHealth({ bradenton: 'gbp', venice: 'concurrent_skip' }, { bradenton: 0 });
    expect(out).toEqual({ skipped: 'partial_cycle' });
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('kill switch REVIEW_SYNC_HEALTH_EMAIL=off disables the whole check', async () => {
    process.env.REVIEW_SYNC_HEALTH_EMAIL = 'off';
    const out = await gbp._assessReviewSyncHealth({ venice: 'none' });
    expect(out).toEqual({ skipped: 'disabled' });
    expect(mockEmailSend).not.toHaveBeenCalled();
  });
});
