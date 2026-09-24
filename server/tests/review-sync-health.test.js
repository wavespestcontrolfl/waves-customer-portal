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
let mockNotificationLockHeld = false;
let mockTransactionDepth = 0;
jest.mock('../utils/cron-lock', () => ({ runExclusive: async (_k, fn) => {
  mockNotificationLockHeld = true;
  try { return await fn(); } finally { mockNotificationLockHeld = false; }
} }));
const mockRetireIfClean = jest.fn(async () => 1);
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: (...args) => mockRetireIfClean(...args) }));

const db = require('../models/db');
db.raw = (sql, bindings) => ({ sql, bindings });
db.transaction = async (callback) => {
  mockTransactionDepth += 1;
  try { return await callback(db); } finally { mockTransactionDepth -= 1; }
};
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

  test('feed_down carries the GBP failure cause when the caller has one', () => {
    expect(classify({ source: 'none', gbpFailure: 'stored-token lookup failed: Knex: Timeout' }).detail).toContain('stored-token lookup failed: Knex: Timeout');
    expect(classify({ source: 'none' }).detail).toMatch(/the GBP pull failed and no Places sample landed/);
  });

  test('nothing synced at all → feed_down FIX', () => {
    expect(classify({ source: 'none' })).toMatchObject({ cls: 'feed_down', severity: 'FIX' });
  });

  test('Places-sample fallback → feed_degraded ACT', () => {
    expect(classify({ source: 'places_fallback' })).toMatchObject({ cls: 'feed_degraded', severity: 'ACT' });
  });

  test('feed_degraded names the real GBP failure — only a missing client is a credentials story (Parrish 2026-09-03)', () => {
    expect(classify({ source: 'places_fallback', gbpFailure: 'no_client' }).detail).toMatch(/^GBP credentials are broken/);
    expect(classify({ source: 'places_fallback' }).detail).toMatch(/^GBP credentials are broken/);
    const dbErr = classify({ source: 'places_fallback', gbpFailure: 'update "google_reviews" set ...\n duplicate key value violates unique constraint' });
    expect(dbErr.detail).toMatch(/^the GBP pull failed: update "google_reviews" set \.\.\. duplicate key/);
    expect(dbErr.detail).not.toMatch(/credentials/);
    expect(classify({ source: 'places_fallback', gbpFailure: 'GBP getReviews 503: unavailable' }).detail).toContain('503');
    // A breaker trip pulled the feed and failed WRITING it (codex r5 P2).
    const trip = classify({ source: 'places_fallback', gbpFailure: 'review upsert failed: 3 review rows failed on connection-class errors this run — aborting the location (1 stored; last: read ECONNRESET)' });
    expect(trip.detail).toMatch(/^the review writes failed: 3 review rows failed on connection-class errors/);
    expect(trip.detail).not.toMatch(/pull failed|credentials/);
    expect(classify({ source: 'none', gbpFailure: 'review upsert failed: 3 review rows failed on connection-class errors this run — aborting the location (0 stored; last: read ECONNRESET)' }).detail).toMatch(/^nothing synced this run — the review writes failed: 3 review rows/);
    // Part of the feed stored before the abort and the sample landed nothing:
    // degraded, never "nothing synced" (codex r10 P2).
    const partial = classify({ source: 'gbp_partial', gbpFailure: 'review upsert failed: 3 review rows failed on connection-class errors this run — aborting the location (2 stored; last: read ECONNRESET)' });
    expect(partial).toMatchObject({ cls: 'feed_degraded', severity: 'ACT' });
    expect(partial.detail).toMatch(/^the review writes failed: 3 review rows.*part of the GBP feed stored before the abort, no Places sample landed/);
    expect(partial.detail).not.toMatch(/nothing synced/);
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
  function installDb({ aggregates = [], stats = [], recentNotification = null, cleanAt = null } = {}) {
    const updates = [];
    const whereCalls = [];
    db.mockImplementation((table) => {
      const q = {
        select: jest.fn(function () { return this; }),
        groupBy: jest.fn(async function () { return aggregates; }),
        where: jest.fn(function (a, ...rest) {
          whereCalls.push([table, a, ...rest]);
          if (typeof a === 'function') a(this);
          else if (a && typeof a === 'object') {
            this._statsQuery = a.reviewer_name === '_stats';
            this._notifQuery = a.recipient_type === 'admin';
            this._id = a.id;
          }
          return this;
        }),
        orWhere: jest.fn(function (callback) { callback(this); return this; }),
        whereRaw: jest.fn(function (sql, bindings) {
          if (sql.includes("metadata->>'resolved'")) this._unresolvedOnly = true;
          if (sql.includes('> ?::timestamptz')) this._newerThan = bindings[0];
          return this;
        }),
        first: jest.fn(async function () {
          if (table === 'system_settings') return cleanAt ? { value: cleanAt } : null;
          if (this._newerThan) {
            const observation = recentNotification?.metadata?.observedAt || recentNotification?.created_at;
            return Date.parse(observation) > Date.parse(this._newerThan) ? recentNotification : null;
          }
          return this._unresolvedOnly && recentNotification?.metadata?.resolved === true ? null : recentNotification;
        }),
        update: jest.fn(async function (patch) {
          updates.push(patch);
          if (this._id === recentNotification?.id && recentNotification) {
            recentNotification.metadata ||= {};
            Object.assign(recentNotification.metadata, JSON.parse(patch.metadata.bindings[0]));
          }
          return 1;
        }),
      };
      // The _stats select resolves via .select() being awaited after .where()
      q.select = jest.fn(function () {
        if (this._statsQuery) return Promise.resolve(stats);
        return this;
      });
      return q;
    });
    updates.whereCalls = whereCalls;
    return updates;
  }

  beforeEach(() => {
    // The assessment compares fixtures against the REAL clock — freeze it to
    // the fixture anchor or the suite starts failing by itself once the
    // calendar passes the fixtures' window (codex #3298 r1).
    jest.useFakeTimers().setSystemTime(NOW);
    mockEmailSend.mockClear();
    mockNotifyAdmin.mockClear();
    mockRetireIfClean.mockClear();
    delete process.env.REVIEW_SYNC_HEALTH_EMAIL;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('healthy fleet sends NOTHING (exception-based)', async () => {
    const cleanObservedAt = new Date(NOW - 2 * 3600000).toISOString();
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
      {}, cleanObservedAt,
    );
    expect(out).toEqual({ healthy: true });
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockRetireIfClean).toHaveBeenCalledWith('gbp-sync-health', {
      alsoRetire: { category: 'review', field: 'opsKey', legacyTitlePrefix: 'Review sync health escalation [' },
      lockKey: 'ops-digest:gbp-sync-health',
      notAfter: cleanObservedAt,
    });
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
    expect(mockNotifyAdmin.mock.calls[0][3]).toMatchObject({ bell: true, metadata: { opsKey: 'gbp-sync-health' } });
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

  test('unresolved-marker dedupe: ANY unresolved same-title row suppresses the resend, not just one younger than 24h', async () => {
    // Same signature stayed broken for a week: the old `created_at > dayAgo`
    // bound let a fresh 'review' marker ring every day in addition to the
    // ops_digest bell (codex/audit finding). The dedupe now has no age
    // bound — only "unresolved" gates it — so a week-old unresolved marker
    // still suppresses the resend.
    const updates = installDb({ aggregates: [], stats: [], recentNotification: { id: 'n1', created_at: new Date(NOW - 8 * 86400000).toISOString() } });
    const out = await gbp._assessReviewSyncHealth({ venice: 'gbp' });
    expect(out).toEqual({ deduped: true });
    expect(mockEmailSend).not.toHaveBeenCalled();
    // The 'review' marker query must never filter on created_at any more.
    const reviewMarkerWhereCalls = updates.whereCalls.filter(([table]) => table === 'notifications');
    expect(reviewMarkerWhereCalls.some(([, field]) => field === 'created_at')).toBe(false);
  });

  test('same-signature failures advance marker/digest observation and reject older failure repeats', async () => {
    const t1 = new Date(NOW - 3 * 3600000).toISOString();
    const t2 = new Date(NOW - 2 * 3600000).toISOString();
    const t3 = new Date(NOW - 3600000).toISOString();
    const marker = { id: 'n_same_signature', created_at: t1, metadata: { opsKey: 'gbp-sync-health', observedAt: t1 } };
    const updates = installDb({ recentNotification: marker });
    expect(await gbp._assessReviewSyncHealth({ venice: 'gbp' }, {}, {}, t3)).toEqual({ deduped: true });
    expect(marker.metadata.observedAt).toBe(t3);
    expect(updates).toHaveLength(2);
    expect(JSON.parse(updates[1].metadata.bindings[0]).observedAt).toBe(t3);
    expect(await gbp._assessReviewSyncHealth({ venice: 'gbp' }, {}, {}, t2)).toEqual({ stale: true });
    expect(marker.metadata.observedAt).toBe(t3);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('a delayed older failure cannot resurrect after the durable newer clean watermark', async () => {
    const t1 = new Date(NOW - 2 * 3600000).toISOString();
    const t2 = new Date(NOW - 3600000).toISOString();
    installDb({ cleanAt: t2 });
    expect(await gbp._assessReviewSyncHealth({ venice: 'none' }, {}, {}, t1)).toEqual({ stale: true });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('SMTP runs after the durable marker transaction and notification lock release', async () => {
    installDb();
    mockEmailSend.mockImplementationOnce(async () => {
      expect(mockNotificationLockHeld).toBe(false);
      expect(mockTransactionDepth).toBe(0);
      return { ok: true };
    });
    expect((await gbp._assessReviewSyncHealth({ venice: 'none' })).emailed).toBe(true);
  });

  test('a retired review marker permits the same finding to recur inside its former dedupe window', async () => {
    installDb({ aggregates: [], stats: [], recentNotification: { id: 'n_retired', metadata: { resolved: true, opsKey: 'gbp-sync-health' } } });
    const out = await gbp._assessReviewSyncHealth({ venice: 'gbp' });
    expect(out.emailed).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    expect(mockRetireIfClean).not.toHaveBeenCalled();
  });

  test('an unproven clean cycle with a database failure cannot retire earlier findings', async () => {
    db.mockImplementationOnce(() => { throw new Error('review inventory unavailable'); });
    await expect(gbp._assessReviewSyncHealth({ venice: 'gbp' })).rejects.toThrow('review inventory unavailable');
    expect(mockRetireIfClean).not.toHaveBeenCalled();
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
    expect(mockRetireIfClean).not.toHaveBeenCalled();
  });

  test('kill switch REVIEW_SYNC_HEALTH_EMAIL=off disables the whole check', async () => {
    process.env.REVIEW_SYNC_HEALTH_EMAIL = 'off';
    const out = await gbp._assessReviewSyncHealth({ venice: 'none' });
    expect(out).toEqual({ skipped: 'disabled' });
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockRetireIfClean).not.toHaveBeenCalled();
  });
});
