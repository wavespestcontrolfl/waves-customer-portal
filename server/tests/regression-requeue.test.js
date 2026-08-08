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
  const state = { updates: [], rawBinds: [], excluded: [], evidence: [], statusFilters: [], orderBy: [] };
  const fakeDb = () => {
    const q = {
      _id: null,
      _limit: null,
      where: (col, val) => {
        // Both the paused-bucket exclusion and the parked-status exclusion are
        // callback predicates.
        if (typeof col === 'function') {
          const sub = {
            whereRaw: () => sub,
            whereNull: () => sub,
            orWhereNotIn: (_c, vals) => { state.excluded.push(...vals); return sub; },
            whereIn: (_c, vals) => { state.evidence.push(...vals); return sub; },
            orWhere: (_c, op, v) => {
              if (op === '<>') state.statusFilters.push(v); else state.evidence.push(v);
              return sub;
            },
          };
          col(sub);
          return q;
        }
        if (col === 'id') q._id = val;
        return q;
      },
      // The cooldown-evidence filter is now a plain top-level whereIn.
      whereIn: (_col, vals) => { state.evidence.push(...vals); return q; },
      whereRaw: (sql, binds) => { state.rawBinds.push(...(binds || [])); return q; },
      whereNotNull: () => q,
      whereNull: () => q,
      orderBy: (...a) => { state.orderBy.push(a); return q; },
      limit: (n) => { q._limit = n; return q; },
      select: async () => pending.slice(0, q._limit || pending.length),
      first: async () => (cooldownHit ? { id: 'prior-row' } : undefined),
      update: async (patch) => {
        if (state.failUpdates) throw new Error('update failed');
        state.updates.push({ id: q._id, ...patch });
        return 1;
      },
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
  resolvePostByUrl: jest.fn(async () => ({ id: 42, slug: 'bed-bugs-bradenton' })),
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

  test('unsupported_target when the URL matched no published blog post', () => {
    expect(requeueStatusFor({ resolved: null })).toBe('unsupported_target');
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

    // cycleKey per regression: without it the stable dedupe key preserves an
    // earlier status='done' and the page can never be refreshed twice.
    expect(refreshAudit.enqueueRefresh).toHaveBeenCalledWith({ blogPostId: 42, cycleKey: 'reg-imp-1' });
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

    expect(refreshAudit.resolvePostByUrl).not.toHaveBeenCalled();
    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    // A cooldown EXPIRES — it defers the regression, it does not consume it.
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'cooldown', requeue_attempts: 1 });
    expect(db.state.updates[0].requeued_at).toBeUndefined();
    expect(out.queued).toBe(0);
  });

  test('a target outside the lane is PARKED, not consumed — requeued_at stays null', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ resolvePostByUrl: jest.fn(async () => null) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'unsupported_target' });
    // The crucial bit: NOT marked handled. enqueueRefresh is blogPostId-keyed
    // so a city/service Astro page cannot be handed to this lane today — but
    // when a URL-keyed path lands, clearing this status alone revives them all.
    expect(db.state.updates[0].requeued_at).toBeUndefined();
    expect(out.unsupported).toBe(1);
  });

  test('parked targets are excluded from the scan so they cost nothing nightly', async () => {
    const db = makeDb({ pending: [row()] });
    await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });
    // The scan filters them out by status rather than by a handled-marker.
    expect(db.state.excluded).toContain('unsupported_target');
  });

  test('after a failed stamp, the retry RECOVERS its own queue row as success', async () => {
    // The retry re-enqueues under the same cycleKey and gets queued=false back
    // (the row it created is now pending/claimed/done). `own` marks it as this
    // cycle's row, so it must read as 'queued' — not as a foreign in-flight
    // edit that eventually retires the regression with the fix still queued.
    const db = makeDb({ pending: [row({ requeue_attempts: 1 })] });
    const refreshAudit = audit({
      enqueueRefresh: jest.fn(async () => ({ queued: false, own: true, status: 'claimed' })),
    });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.queued).toBe(1);
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'queued' });
  });

  test('a foreign in-flight edit is still NOT treated as our corrective work', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({
      enqueueRefresh: jest.fn(async () => ({ queued: false, own: false, status: 'claimed' })),
    });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });
    expect(out.results[0].status).toBe('inflight:claimed');
    expect(out.queued).toBe(0);
  });

  test('a failed marker write is NOT reported as success', async () => {
    // The marker is the exactly-once contract; swallowing its failure would
    // have the next sweep reprocess and eventually retire the regression as an
    // exhausted no-op even though work HAD been queued.
    const db = makeDb({ pending: [row()] });
    db.state.failUpdates = true;
    const out = await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });

    expect(out.queued).toBe(0);
    expect(out.results[0]).toMatchObject({ status: 'stamp_failed', intended: 'queued' });
  });

  test('queued=false does NOT consume the regression — it retries under the attempt budget', async () => {
    // Another page-editing action holding the page reports queued=false, and
    // that edit is not a fix for this regression.
    for (const status of ['claimed', 'pending_review']) {
      const db = makeDb({ pending: [row({ requeue_attempts: 0 })] });
      const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => ({ queued: false, own: false, status })) });
      const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

      expect(out.results[0].status).toBe(`inflight:${status}`);
      expect(db.state.updates[0]).toMatchObject({ requeue_attempts: 1, requeue_status: `inflight:${status}` });
      expect(db.state.updates[0].requeued_at).toBeUndefined();
    }
  });

  test('a page blocked for many days is NEVER retired — the blocking edit will clear', async () => {
    // A legitimate pending_review edit can hold a page well past any small
    // retry cap; retiring the regression then would discard it at exactly the
    // moment the block lifts.
    const db = makeDb({ pending: [row({ requeue_attempts: 40 })] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => ({ queued: false, own: false, status: 'pending_review' })) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.results[0].status).toBe('inflight:pending_review');
    expect(db.state.updates[0]).toMatchObject({ requeue_attempts: 41 });
    expect(db.state.updates[0].requeued_at).toBeUndefined();
    expect(out.blocked).toBe(1);
  });

  test('blocked rows are DEMOTED, not dropped — fewest attempts sort first', async () => {
    const db = makeDb({ pending: [row()] });
    await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });
    // Ordering is what stops a stuck row occupying the bounded batch.
    expect(db.state.orderBy[0]).toEqual(['requeue_attempts', 'asc']);
    expect(db.state.orderBy[1]).toEqual(['checked_21d_at', 'asc']);
  });

  test('a RECOVERABLE coded refusal is recorded but stays actionable', async () => {
    const err = new Error('no Search Console impressions'); err.code = 'NO_GSC_SIGNAL';
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw err; }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    // GSC signal comes back when traffic does; consuming the regression here
    // would drop it for a condition that had already healed.
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'no_gsc_signal', requeue_attempts: 1 });
    expect(db.state.updates[0].requeued_at).toBeUndefined();
    expect(out.queued).toBe(0);
  });

  test('a TRANSIENT failure counts an attempt but does NOT stamp a terminal status', async () => {
    const db = makeDb({ pending: [row({ requeue_attempts: 0 })] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw new Error('connection reset'); }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.results[0].status).toBe('error');
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0]).toMatchObject({ requeue_attempts: 1, requeue_status: 'error' });
    // Not consumed — the next sweep retries it.
    expect(db.state.updates[0].requeued_at).toBeUndefined();
  });

  test('a persistently failing row keeps counting attempts but is never consumed', async () => {
    const db = makeDb({ pending: [row({ requeue_attempts: 25 })] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw new Error('still broken'); }) });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.results[0].status).toBe('error');
    expect(db.state.updates[0]).toMatchObject({ requeue_attempts: 26 });
    expect(db.state.updates[0].requeued_at).toBeUndefined();
  });

  test('gate OFF does not even count a transient failure', async () => {
    process.env.GATE_REGRESSION_REQUEUE = 'false';
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ resolvePostByUrl: jest.fn(async () => { throw new Error('boom'); }) });
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

  test('cooldown evidence is EXACTLY queued — no status that queued nothing counts', async () => {
    const db = makeDb({ pending: [row()], cooldownHit: true });
    await requeueRegressedPages({ db, refreshAudit: audit(), tracker: tracker() });

    // Only a real corrective refresh may start a 90-day suppression. In
    // particular `inflight:<status>_exhausted` IS stamped but means the
    // attempt budget ran out with nothing queued, so an `inflight:%` pattern
    // would silently match it and suppress the next valid regression.
    expect(db.state.evidence).toEqual(['queued']);
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
      resolvePostByUrl: jest.fn()
        .mockImplementationOnce(async () => { throw new Error('boom'); })
        .mockImplementationOnce(async () => ({ id: 43 })),
    });
    const out = await requeueRegressedPages({ db, refreshAudit, tracker: tracker() });

    expect(out.scanned).toBe(2);
    expect(out.queued).toBe(1);
    // imp-1 only had its attempt counted; imp-2 is the one actually consumed.
    const consumed = db.state.updates.filter((u) => u.requeued_at);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ id: 'imp-2', requeue_status: 'queued' });
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
    expect(refreshAudit.resolvePostByUrl).not.toHaveBeenCalled();
  });
});
