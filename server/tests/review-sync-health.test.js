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
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...a) => mockNotifyAdmin(...a),
  // Pass-through: the digest rewrite's normalization (emoji strip + the
  // ops_digest brevity cut) is pinned in notification-admin-brevity-and-activity.
  normalizeAdminText: ({ title, body, detail }) => ({ title, body, detail }),
}));
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

  test('a profile that has never had a review is quiet only when Google agrees and nothing was ever stored (Venice 2026-09-28)', () => {
    // Also never stats_stale: Places writes no stats row for a listing with
    // no reviews, so statsUpdatedAt stays null here.
    const neverReviewed = { pulledCount: 0, rowCount: 0, storedCount: 0, placesTotal: 0, statsTotal: undefined, statsUpdatedAt: null, newestIngestAt: null };
    expect(classify(neverReviewed)).toBeNull();
    // Places did not answer this run: nothing confirms the profile is empty.
    expect(classify({ ...neverReviewed, placesTotal: undefined })).toMatchObject({ cls: 'silent_empty' });
    // Google's public listing shows reviews the feed does not return.
    expect(classify({ ...neverReviewed, placesTotal: 12 })).toMatchObject({ cls: 'silent_empty' });
    // A wipe: both sources now read zero, but the removal-stamped rows stay stored.
    expect(classify({ ...neverReviewed, storedCount: 47, newestIngestAt: daysAgo(60) })).toMatchObject({ cls: 'silent_empty' });
    // Google once showed reviews that were never ingested: the stats row
    // alone is stored, and a later zero never clears it.
    expect(classify({ ...neverReviewed, storedCount: 1, statsTotal: 3, statsUpdatedAt: daysAgo(40) })).toMatchObject({ cls: 'silent_empty' });
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
        // Digest content-rewrite predicate (A -> B -> A refresh): chainable no-ops.
        whereNot: jest.fn(function () { return this; }),
        orWhereNot: jest.fn(function () { return this; }),
        whereNull: jest.fn(function () { return this; }),
        orWhereNull: jest.fn(function () { return this; }),
        orWhereRaw: jest.fn(function () { return this; }),
        whereIn: jest.fn(function () { return this; }),
        orderBy: jest.fn(function () { return this; }),
        limit: jest.fn(function () { return this; }),
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

  test('a never-reviewed profile Google confirms empty leaves the fleet healthy; the same empty feed after a wipe still escalates', async () => {
    // Production 2026-09-28: Venice has no stored row at all, so the
    // aggregate query returns no row for it. stored_count includes each
    // location's _stats row.
    const fleet = [
      { location_id: 'bradenton', row_count: '117', stored_count: '120', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
      { location_id: 'parrish', row_count: '39', stored_count: '40', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
      { location_id: 'sarasota', row_count: '48', stored_count: '49', newest_ingest_at: daysAgo(1), stats_updated_at: daysAgo(1) },
    ];
    const sources = { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' };
    const pulled = { bradenton: 117, parrish: 39, sarasota: 48, venice: 0 };
    const observedAt = new Date(NOW).toISOString();

    installDb({ aggregates: fleet, stats: [] });
    expect(await gbp._assessReviewSyncHealth(sources, pulled, {}, observedAt, { venice: 0 })).toEqual({ healthy: true });
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();

    installDb({ aggregates: [...fleet, { location_id: 'venice', row_count: '0', stored_count: '12', newest_ingest_at: daysAgo(30), stats_updated_at: null }], stats: [] });
    const out = await gbp._assessReviewSyncHealth(sources, pulled, {}, observedAt, { venice: 0 });
    expect(out.emailed).toBe(true);
    expect(mockNotifyAdmin.mock.calls[0][1]).toBe('Review sync health escalation [venice:silent_empty]');

    // Google once showed reviews that never ingested: only the stats row is
    // stored (no review rows), and today's zero leaves it in place.
    mockEmailSend.mockClear();
    mockNotifyAdmin.mockClear();
    installDb({
      aggregates: [...fleet, { location_id: 'venice', row_count: '0', stored_count: '1', newest_ingest_at: null, stats_updated_at: daysAgo(40) }],
      stats: [{ location_id: 'venice', review_text: '{"rating":5,"totalReviews":3}' }],
    });
    expect((await gbp._assessReviewSyncHealth(sources, pulled, {}, observedAt, { venice: 0 })).emailed).toBe(true);
    expect(mockNotifyAdmin.mock.calls[0][1]).toBe('Review sync health escalation [venice:silent_empty]');
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
    // marker observedAt, digest observedAt, then the digest content rewrite:
    // findings A -> B -> A must not leave the standing digest describing B,
    // so the digest's title/body follow the CURRENT findings and it
    // re-surfaces unread even while the companion marker dedupes.
    expect(updates).toHaveLength(3);
    expect(JSON.parse(updates[1].metadata.bindings[0]).observedAt).toBe(t3);
    expect(updates[2]).toMatchObject({ read_at: null });
    // Same row shape deliverOpsDigest writes (codex r2 P1 on #5236): short
    // title with no ACT:/FIX: prefix, the full report in `detail`, and the
    // kind/audience/feed stamps refreshed with it.
    expect(updates[2].title).not.toMatch(/^(ACT|FIX):/);
    expect(updates[2].title.length).toBeLessThanOrEqual(60);
    expect(updates[2].detail).toMatch(/Hourly Google review sync/);
    const rewriteMeta = JSON.parse(updates[2].metadata.bindings[0]);
    expect(rewriteMeta.observedAt).toBe(t3);
    expect(rewriteMeta.subject).toMatch(/^(ACT|FIX): Google review sync/);
    expect(['ACT', 'FIX']).toContain(rewriteMeta.kind);
    expect(rewriteMeta.feed).toBe(rewriteMeta.kind === 'FIX' ? 'activity' : null);
    expect(rewriteMeta.audience).toBe(rewriteMeta.kind === 'FIX' ? 'engineering' : 'owner');
    expect(await gbp._assessReviewSyncHealth({ venice: 'gbp' }, {}, {}, t2)).toEqual({ stale: true });
    expect(marker.metadata.observedAt).toBe(t3);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  // admin-alerts-ring scope (2026-09-28): this direct rewrite bypasses
  // notifyAdmin entirely, so it applies the SAME ring-only-on-change test
  // by hand (ringOnRefreshFrom) — a repeat same-signature failure that
  // hasn't grown past the standing digest's own count keeps read_at AND
  // feed/quiet exactly as they were, even though the content still
  // rewrites (a later run's re-observed subject/detail).
  test('a repeat same-signature failure with a flat or shrinking count keeps the digest quiet — read_at and feed/quiet stay as they were', async () => {
    const t1 = new Date(NOW - 3 * 3600000).toISOString();
    const t3 = new Date(NOW - 3600000).toISOString();
    // A standing digest that already reported MORE findings (10) than this
    // 4-location wipe will (4) — no growth, so the ring test says quiet.
    const marker = {
      id: 'n_quiet_repeat', created_at: t1,
      metadata: { opsKey: 'gbp-sync-health', observedAt: t1, count: 10 },
    };
    const updates = installDb({ aggregates: [], stats: [], recentNotification: marker });
    // Zero rows everywhere -> silent_empty at all 4 locations -> ACT (owner),
    // same deterministic fixture as 'problems email contact@ FIRST...' above.
    const out = await gbp._assessReviewSyncHealth(
      { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {}, {}, t3,
    );
    expect(out).toEqual({ deduped: true });
    expect(updates).toHaveLength(3);
    const rewrite = updates[2];
    expect(rewrite).not.toHaveProperty('read_at'); // kept as-is, not cleared
    expect(rewrite.title).not.toMatch(/^(ACT|FIX):/); // content still rewrites
    const rewriteMeta = JSON.parse(rewrite.metadata.bindings[0]);
    expect(rewriteMeta.kind).toBe('ACT');
    expect(rewriteMeta.audience).toBe('owner');
    expect(rewriteMeta.count).toBe(4); // still stamped, unconditionally
    expect(rewriteMeta).not.toHaveProperty('feed'); // dropped — existing feed/quiet stand
    expect(rewriteMeta).not.toHaveProperty('quiet');
  });

  test('an engineering-audience (FIX) repeat rewrite always rings — never gated, byte-identical to before this scope', async () => {
    const t1 = new Date(NOW - 3 * 3600000).toISOString();
    const t3 = new Date(NOW - 3600000).toISOString();
    const marker = {
      id: 'n_fix_repeat', created_at: t1,
      // A count far above anything this run could report — if this were
      // owner-gated it would go quiet; FIX must ring anyway.
      metadata: { opsKey: 'gbp-sync-health', observedAt: t1, count: 999 },
    };
    const updates = installDb({ aggregates: [], stats: [], recentNotification: marker });
    // feed_down at one location -> FIX (engineering), same deterministic
    // fixture as 'feed_down escalates the subject to FIX:' above.
    const out = await gbp._assessReviewSyncHealth(
      { bradenton: 'none', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {}, {}, t3,
    );
    expect(out).toEqual({ deduped: true });
    expect(updates).toHaveLength(3);
    const rewrite = updates[2];
    expect(rewrite).toMatchObject({ read_at: null });
    const rewriteMeta = JSON.parse(rewrite.metadata.bindings[0]);
    expect(rewriteMeta.kind).toBe('FIX');
    expect(rewriteMeta.audience).toBe('engineering');
    expect(rewriteMeta.feed).toBe('activity');
    expect(rewriteMeta.quiet).toBe(false);
  });

  // admin-alerts-ring-v2 follow-up: an audience flip changes which surface
  // the row belongs to, not merely whether it rings — a FIX->ACT flip whose
  // count hasn't grown (quiet by the plain ring test) must still land the
  // owner's row visible, or it stays hidden behind a stale feed:'activity'.
  test('a FIX->ACT flip rings into the owner bell even with a flat/shrinking count (the FIX row may have been read in Activity)', async () => {
    const t1 = new Date(NOW - 3 * 3600000).toISOString();
    const t3 = new Date(NOW - 3600000).toISOString();
    // The standing row is CURRENTLY engineering/Activity-only, with a count
    // well above anything this run's 4-location wipe reports (4) — the
    // plain ring-only-on-change test alone would say quiet.
    const marker = {
      id: 'n_flip_quiet', created_at: t1,
      metadata: { opsKey: 'gbp-sync-health', observedAt: t1, audience: 'engineering', feed: 'activity', count: 10 },
    };
    const updates = installDb({ aggregates: [], stats: [], recentNotification: marker });
    // Zero rows everywhere -> silent_empty at all 4 locations -> ACT (owner).
    const out = await gbp._assessReviewSyncHealth(
      { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {}, {}, t3,
    );
    expect(out).toEqual({ deduped: true });
    expect(updates).toHaveLength(3);
    const rewrite = updates[2];
    expect(rewrite.read_at).toBeNull(); // entering the owner audience rings even though the count fell (10 -> 4)
    const rewriteMeta = JSON.parse(rewrite.metadata.bindings[0]);
    expect(rewriteMeta.kind).toBe('ACT');
    expect(rewriteMeta.audience).toBe('owner');
    // The flip still applies, despite the quiet refresh: the row is owner
    // now, so it must not stay hidden behind the old engineering feed.
    expect(rewriteMeta.feed).toBeNull();
    expect(rewriteMeta.quiet).toBe(false);
  });

  // admin-alerts-ring follow-up (codex r8 P1): item identity from the
  // findings themselves — `<location id>:<class>` — the same pair the
  // dedupe signature already sorts and joins, on both surfaces this
  // finding reaches (the direct same-signature rewrite, and the standing
  // ops_digest row deliverOpsDigest writes/refreshes). An empty aggregate
  // with no pulledCount given classifies stats_stale at all 4 locations
  // (no _stats row) — the same fixture the quiet-repeat/FIX->ACT tests above
  // use; only the class label matters here, not which one it is.
  test('a pre-identity standing row rings on its first identified same-count refresh (codex r1 on #5282)', async () => {
    const t1 = new Date(NOW - 3 * 3600000).toISOString();
    const t3 = new Date(NOW - 3600000).toISOString();
    const marker = {
      id: 'n_legacy_identity', created_at: t1,
      metadata: { opsKey: 'gbp-sync-health', observedAt: t1, count: 4 }, // no itemKeys/itemSetHash
    };
    const updates = installDb({ aggregates: [], stats: [], recentNotification: marker });
    await gbp._assessReviewSyncHealth(
      { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {}, {}, t3,
    );
    expect(updates[2].read_at).toBeNull(); // rang: first identity at an equal count (4 -> 4)
  });

  test('the direct rewrite stamps itemKeys/itemSetHash unconditionally, like count', async () => {
    const t1 = new Date(NOW - 3 * 3600000).toISOString();
    const t3 = new Date(NOW - 3600000).toISOString();
    // Same shrinking-count fixture as the quiet-repeat test above — the
    // identity stamp is unconditional, independent of whether it rings.
    const marker = {
      id: 'n_item_identity', created_at: t1,
      metadata: { opsKey: 'gbp-sync-health', observedAt: t1, count: 10 },
    };
    const updates = installDb({ aggregates: [], stats: [], recentNotification: marker });
    const out = await gbp._assessReviewSyncHealth(
      { bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {}, {}, t3,
    );
    expect(out).toEqual({ deduped: true });
    const rewriteMeta = JSON.parse(updates[2].metadata.bindings[0]);
    expect(rewriteMeta.itemKeys).toEqual(['bradenton:stats_stale', 'parrish:stats_stale', 'sarasota:stats_stale', 'venice:stats_stale']);
    expect(typeof rewriteMeta.itemSetHash).toBe('string');
    expect(rewriteMeta.itemSetHash).toHaveLength(64); // sha256 hex, itemSetHashFor
  });

  test('deliverOpsDigest wires the same item identity through to notifyAdmin: a same-count finding swap rings, the same set stays quiet', async () => {
    process.env.GATE_OPS_DIGESTS_IN_APP = 'true';
    process.env.GATE_AGENT_ACTIVITY = 'true';
    try {
      installDb({ aggregates: [], stats: [] }); // no standing 'review' row -> the fresh-marker branch runs
      mockNotifyAdmin.mockResolvedValue({ id: 'n-digest', deduped: false });
      await gbp._assessReviewSyncHealth({ bradenton: 'gbp', parrish: 'gbp', sarasota: 'gbp', venice: 'gbp' }, {}, {});
      const digestCall = mockNotifyAdmin.mock.calls.find(([category]) => category === 'ops_digest');
      expect(digestCall).toBeDefined();
      const opts = digestCall[3];
      const itemKeys = ['bradenton:stats_stale', 'parrish:stats_stale', 'sarasota:stats_stale', 'venice:stats_stale'];
      expect(opts.metadata.itemKeys).toEqual(itemKeys);
      expect(typeof opts.ringOnRefresh).toBe('function');
      // Same set at the same count -> quiet; a swapped location -> rings,
      // even though the count is unchanged (4 -> 4) in both cases.
      expect(opts.ringOnRefresh({}, { count: 4, itemKeys })).toBe(false);
      expect(opts.ringOnRefresh({}, {
        count: 4, itemKeys: ['bradenton:stats_stale', 'parrish:stats_stale', 'sarasota:stats_stale', 'venice:feed_degraded'],
      })).toBe(true);
    } finally {
      delete process.env.GATE_OPS_DIGESTS_IN_APP;
      delete process.env.GATE_AGENT_ACTIVITY;
    }
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
