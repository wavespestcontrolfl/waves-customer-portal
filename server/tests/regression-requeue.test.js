jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The real lock needs a DB session; assert only that the sweep runs THROUGH it.
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn((_name, fn) => fn()),
}));

const { runExclusive } = require('../utils/cron-lock');
const requeue = require('../services/seo/regression-requeue');
const { requeueRegressedPages, requeueStatusFor } = requeue;

// Minimal knex stand-in for content_optimization_impact. `pending` feeds the
// scan; `cooldownHit` decides what the cooldown .first() sees; every .update()
// is recorded with the id it was keyed on, and every whereRaw bind is captured
// so the cooldown's page-identity predicate can be asserted.
function makeDb({ pending = [], cooldownHit = false } = {}) {
  const state = { updates: [], rawBinds: [], excluded: [], evidence: [] };
  const fakeDb = () => {
    const q = {
      _id: null,
      _limit: null,
      where: (col, val) => {
        // Both the paused-bucket exclusion and the cooldown-evidence filter
        // are callback predicates; record what each one asked for.
        if (typeof col === 'function') {
          const sub = {
            whereRaw: () => sub,
            whereNull: () => sub,
            orWhereNotIn: (_c, vals) => { state.excluded.push(...vals); return sub; },
            whereIn: (_c, vals) => { state.evidence.push(...vals); return sub; },
            orWhere: (_c, _op, v) => { state.evidence.push(v); return sub; },
          };
          col(sub);
          return q;
        }
        if (col === 'id') q._id = val;
        return q;
      },
      whereRaw: (sql, binds) => { state.rawBinds.push(...(binds || [])); return q; },
      whereNotNull: () => q,
      whereNull: () => q,
      orderBy: () => q,
      limit: (n) => { q._limit = n; return q; },
      select: async () => pending.slice(0, q._limit || pending.length),
      first: async () => (cooldownHit ? { id: 'prior-row' } : undefined),
      update: async (patch) => { state.updates.push({ id: q._id, ...patch }); return 1; },
    };
    return q;
  };
  fakeDb.state = state;
  return fakeDb;
}

const row = (over = {}) => ({
  id: 'imp-1',
  page_url: 'https://www.wavespestcontrol.com/bed-bugs-bradenton/',
  bucket: 'thin_content',
  estimated_lift_position: -4.2,
  checked_21d_at: new Date('2026-08-01T12:00:00Z'),
  ...over,
});

// Real identity helpers, mirrored from refresh-audit — the point of the
// cooldown fix is that BOTH lanes key a page the same way.
const identity = {
  canonPathSql: (col) => `canon(${col})`,
  hostRegistrableSql: (col) => `host(${col})`,
  urlToPath: (u) => String(u).split('?')[0].replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '') || '/',
  registrableDomain: (u) => String(u).replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase(),
};

const audit = (over = {}) => ({
  _identity: identity,
  resolvePublishedPostByUrl: jest.fn(async () => ({ id: 42, slug: 'bed-bugs-bradenton' })),
  enqueueRefresh: jest.fn(async () => ({ queued: true, status: 'pending' })),
  ...over,
});

const tracker = (paused = []) => ({ pausedBuckets: jest.fn(async () => paused) });

beforeEach(() => { process.env.GATE_REGRESSION_REQUEUE = 'true'; runExclusive.mockClear(); });
afterAll(() => { delete process.env.GATE_REGRESSION_REQUEUE; });

describe('requeueStatusFor', () => {
  test('queued when the refresh lane accepted the page', () => {
    expect(requeueStatusFor({ resolved: {}, enqueue: { queued: true, status: 'pending' } })).toBe('queued');
  });

  test('inflight when a run for the page is already claimed/done/in-review', () => {
    expect(requeueStatusFor({ resolved: {}, enqueue: { queued: false, status: 'claimed' } })).toBe('inflight:claimed');
  });

  test('unresolved_page when the URL matched no published post', () => {
    expect(requeueStatusFor({ resolved: null })).toBe('unresolved_page');
  });

  test('a coded refusal is recorded verbatim, lowercased', () => {
    expect(requeueStatusFor({ resolved: {}, errorCode: 'NO_GSC_SIGNAL' })).toBe('no_gsc_signal');
    expect(requeueStatusFor({ resolved: null, errorCode: 'NO_SERVICE' })).toBe('no_service');
  });

  test('never exceeds the requeue_status column width', () => {
    const out = requeueStatusFor({ resolved: {}, enqueue: { queued: false, status: 'x'.repeat(80) } });
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe('requeueRegressedPages', () => {
  test('queues a resolved page through the EXISTING refresh lane and stamps it', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit();
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(refreshAudit.enqueueRefresh).toHaveBeenCalledWith({ blogPostId: 42 });
    expect(out).toMatchObject({ scanned: 1, queued: 1, skipped: 0 });
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0]).toMatchObject({ id: 'imp-1', requeue_status: 'queued' });
    expect(db.state.updates[0].requeued_at).toBeInstanceOf(Date);
  });

  test('gate OFF: decides and logs, but never enqueues and never stamps', async () => {
    process.env.GATE_REGRESSION_REQUEUE = 'false';
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit();
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates).toHaveLength(0);
    expect(out.results[0].status).toBe('gated');
    expect(out.queued).toBe(0);
  });

  test('gate OFF also withholds the stamp on a REFUSAL, so the flip sees the real backlog', async () => {
    process.env.GATE_REGRESSION_REQUEUE = 'false';
    const db = makeDb({ pending: [row()], cooldownHit: true });
    const out = await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });
    expect(db.state.updates).toHaveLength(0);
    expect(out.results[0].status).toBe('gated');
  });

  test('cooldown: a page re-queued recently is left alone (no second enqueue)', async () => {
    const db = makeDb({ pending: [row()], cooldownHit: true });
    const refreshAudit = audit();
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(refreshAudit.resolvePublishedPostByUrl).not.toHaveBeenCalled();
    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'cooldown' });
    expect(out).toMatchObject({ queued: 0, skipped: 1 });
  });

  test('an unresolvable URL is recorded, not silently retried forever', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ resolvePublishedPostByUrl: jest.fn(async () => null) });
    await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'unresolved_page' });
  });

  test('a coded refusal from the refresh lane is terminal and stamped', async () => {
    const err = new Error('no Search Console impressions'); err.code = 'NO_GSC_SIGNAL';
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw err; }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'no_gsc_signal' });
    expect(out).toMatchObject({ queued: 0, skipped: 1 });
  });

  test('a TRANSIENT failure counts an attempt but does NOT stamp a terminal status', async () => {
    const db = makeDb({ pending: [row({ requeue_attempts: 0 })] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw new Error('connection reset'); }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.results[0].status).toBe('error');
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0]).toMatchObject({ requeue_attempts: 1 });
    // Not stamped terminal — the next sweep retries it.
    expect(db.state.updates[0].requeued_at).toBeUndefined();
    expect(db.state.updates[0].requeue_status).toBeUndefined();
  });

  test('a row that keeps failing is retired at the cap, so it cannot starve the batch', async () => {
    const attempts = requeue.THRESHOLDS.MAX_TRANSIENT_ATTEMPTS - 1;
    const db = makeDb({ pending: [row({ requeue_attempts: attempts })] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw new Error('still broken'); }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.results[0].status).toBe('error_exhausted');
    expect(db.state.updates[0]).toMatchObject({
      requeue_status: 'error_exhausted',
      requeue_attempts: requeue.THRESHOLDS.MAX_TRANSIENT_ATTEMPTS,
    });
    expect(db.state.updates[0].requeued_at).toBeInstanceOf(Date);
  });

  test('gate OFF does not even count a transient failure', async () => {
    process.env.GATE_REGRESSION_REQUEUE = 'false';
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ resolvePublishedPostByUrl: jest.fn(async () => { throw new Error('boom'); }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(db.state.updates).toHaveLength(0);
    expect(out.results[0].status).toBe('gated');
  });

  test('a PAUSED bucket is excluded from the scan — enqueueRefresh would launder it into an unpaused one', async () => {
    const db = makeDb({ pending: [row()] });
    await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker([{ bucket: 'thin_content', regressions: 3 }]) });
    // enqueueRefresh writes bucket='content_refresh_audit', so the runner's own
    // pause guard would NOT catch a regression from a paused lane. It has to be
    // excluded here, and left unstamped so it returns when the bucket clears.
    expect(db.state.excluded).toContain('thin_content');
  });

  test('FAILS CLOSED when the paused-bucket list is unavailable', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit();
    const broken = { pausedBuckets: jest.fn(async () => { throw new Error('db down'); }) };
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: broken });

    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates).toHaveLength(0);
    expect(out).toMatchObject({ scanned: 0, queued: 0 });
  });

  test('asks pausedBuckets in STRICT mode — the default swallows its own error and returns []', async () => {
    const t = tracker();
    await requeueRegressedPages({ db: makeDb({ pending: [] }), refreshAudit: audit(), tracker: t });
    expect(t.pausedBuckets).toHaveBeenCalledWith(expect.objectContaining({ strict: true }));
  });

  test('cooldown evidence is only real refresh work, never a refusal stamp', async () => {
    const db = makeDb({ pending: [row()], cooldownHit: true });
    await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });

    // 'queued' + 'inflight:%' count. A page stamped unresolved_page /
    // no_gsc_signal / cooldown was never refreshed and must not suppress its
    // own next valid regression, nor roll the window forward forever.
    expect(db.state.evidence).toContain('queued');
    expect(db.state.evidence).toContain('inflight:%');
    expect(db.state.evidence).not.toContain('unresolved_page');
    expect(db.state.evidence).not.toContain('cooldown');
  });

  test('the sweep runs inside the distributed cron lock', async () => {
    await requeueRegressedPages({ db: makeDb({ pending: [] }), refreshAudit: audit(), tracker: tracker() });
    expect(runExclusive).toHaveBeenCalledWith('regression-requeue', expect.any(Function));
  });

  test('cooldown is keyed on canonical domain + path, never the raw URL string', async () => {
    const db = makeDb({
      pending: [row({ page_url: 'https://www.wavespestcontrol.com/bed-bugs-bradenton/?utm_source=gbp' })],
      cooldownHit: true,
    });
    await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });

    // The ?utm variant and the trailing slash must be normalized away, and the
    // domain must be bound — otherwise a www/non-www twin slips the loop breaker.
    expect(db.state.rawBinds).toContain('/bed-bugs-bradenton');
    expect(db.state.rawBinds).toContain('wavespestcontrol.com');
  });

  test('one bad page does not stop the rest of the batch', async () => {
    const db = makeDb({ pending: [row(), row({ id: 'imp-2', page_url: 'https://www.wavespestcontrol.com/b/' })] });
    const refreshAudit = audit({
      resolvePublishedPostByUrl: jest.fn()
        .mockImplementationOnce(async () => { throw new Error('boom'); })
        .mockImplementationOnce(async () => ({ id: 43 })),
    });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.scanned).toBe(2);
    expect(out.queued).toBe(1);
    // imp-1 only had its attempt counted; imp-2 still got its terminal stamp.
    const stamped = db.state.updates.filter((u) => u.requeue_status);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]).toMatchObject({ id: 'imp-2', requeue_status: 'queued' });
  });

  test('the nightly fan-out is bounded', async () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: `imp-${i}`, page_url: `https://www.wavespestcontrol.com/p${i}/` }));
    const db = makeDb({ pending: many });
    const out = await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });
    expect(out.scanned).toBe(requeue.THRESHOLDS.MAX_PER_RUN);
  });

  test('an empty backlog is a no-op', async () => {
    const db = makeDb({ pending: [] });
    const refreshAudit = audit();
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });
    expect(out).toMatchObject({ scanned: 0, queued: 0, skipped: 0 });
    expect(refreshAudit.resolvePublishedPostByUrl).not.toHaveBeenCalled();
  });
});
