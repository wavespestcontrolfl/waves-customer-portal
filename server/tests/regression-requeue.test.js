jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const requeue = require('../services/seo/regression-requeue');
const { requeueRegressedPages, requeueStatusFor } = requeue;

// Minimal knex stand-in for content_optimization_impact. `pending` feeds the
// scan; `cooldownHit` decides what the cooldown .first() sees; every .update()
// is recorded with the id it was keyed on.
function makeDb({ pending = [], cooldownHit = false } = {}) {
  const state = { updates: [] };
  const fakeDb = () => {
    const q = {
      _id: null,
      _limit: null,
      where: (col, val) => { if (col === 'id') q._id = val; return q; },
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

const audit = (over = {}) => ({
  resolvePublishedPostByUrl: jest.fn(async () => ({ id: 42, slug: 'bed-bugs-bradenton' })),
  enqueueRefresh: jest.fn(async () => ({ queued: true, status: 'pending' })),
  ...over,
});

beforeEach(() => { process.env.GATE_REGRESSION_REQUEUE = 'true'; });
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
    const out = await requeueRegressedPages({ db, refreshAudit });

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
    const out = await requeueRegressedPages({ db, refreshAudit });

    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates).toHaveLength(0);
    expect(out.results[0].status).toBe('gated');
    expect(out.queued).toBe(0);
  });

  test('gate OFF also withholds the stamp on a REFUSAL, so the flip sees the real backlog', async () => {
    process.env.GATE_REGRESSION_REQUEUE = 'false';
    const db = makeDb({ pending: [row()], cooldownHit: true });
    const out = await requeueRegressedPages({ db, refreshAudit: audit() });
    expect(db.state.updates).toHaveLength(0);
    expect(out.results[0].status).toBe('gated');
  });

  test('cooldown: a page re-queued recently is left alone (no second enqueue)', async () => {
    const db = makeDb({ pending: [row()], cooldownHit: true });
    const refreshAudit = audit();
    const out = await requeueRegressedPages({ db, refreshAudit });

    expect(refreshAudit.resolvePublishedPostByUrl).not.toHaveBeenCalled();
    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'cooldown' });
    expect(out).toMatchObject({ queued: 0, skipped: 1 });
  });

  test('an unresolvable URL is recorded, not silently retried forever', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ resolvePublishedPostByUrl: jest.fn(async () => null) });
    await requeueRegressedPages({ db, refreshAudit });

    expect(refreshAudit.enqueueRefresh).not.toHaveBeenCalled();
    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'unresolved_page' });
  });

  test('a coded refusal from the refresh lane is terminal and stamped', async () => {
    const err = new Error('no Search Console impressions'); err.code = 'NO_GSC_SIGNAL';
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw err; }) });
    const out = await requeueRegressedPages({ db, refreshAudit });

    expect(db.state.updates[0]).toMatchObject({ requeue_status: 'no_gsc_signal' });
    expect(out).toMatchObject({ queued: 0, skipped: 1 });
  });

  test('a TRANSIENT failure leaves the row unstamped so the next sweep retries', async () => {
    const db = makeDb({ pending: [row()] });
    const refreshAudit = audit({ enqueueRefresh: jest.fn(async () => { throw new Error('connection reset'); }) });
    const out = await requeueRegressedPages({ db, refreshAudit });

    expect(db.state.updates).toHaveLength(0);
    expect(out.results[0].status).toBe('error');
  });

  test('one bad page does not stop the rest of the batch', async () => {
    const db = makeDb({ pending: [row(), row({ id: 'imp-2', page_url: 'https://www.wavespestcontrol.com/b/' })] });
    const refreshAudit = audit({
      resolvePublishedPostByUrl: jest.fn()
        .mockImplementationOnce(async () => { throw new Error('boom'); })
        .mockImplementationOnce(async () => ({ id: 43 })),
    });
    const out = await requeueRegressedPages({ db, refreshAudit });

    expect(out.scanned).toBe(2);
    expect(out.queued).toBe(1);
    expect(db.state.updates).toHaveLength(1);
    expect(db.state.updates[0].id).toBe('imp-2');
  });

  test('the nightly fan-out is bounded', async () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: `imp-${i}`, page_url: `https://www.wavespestcontrol.com/p${i}/` }));
    const db = makeDb({ pending: many });
    const out = await requeueRegressedPages({ db, refreshAudit: audit() });
    expect(out.scanned).toBe(requeue.THRESHOLDS.MAX_PER_RUN);
  });

  test('an empty backlog is a no-op', async () => {
    const db = makeDb({ pending: [] });
    const refreshAudit = audit();
    const out = await requeueRegressedPages({ db, refreshAudit });
    expect(out).toMatchObject({ scanned: 0, queued: 0, skipped: 0 });
    expect(refreshAudit.resolvePublishedPostByUrl).not.toHaveBeenCalled();
  });
});
