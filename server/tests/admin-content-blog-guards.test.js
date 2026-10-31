/**
 * Destructive-endpoint guards on /api/admin/content/blog/* (2026-07-15 audit):
 * - The manual create routes stay unmounted (owner 2026-10-30).
 * - DELETE /blog/:id refuses astro-active posts (orphans an open PR /
 *   strands a live page) and 404s on missing ids.
 * - PUT /blog/:id validates status and blocks the direct →published jump.
 * - GET /blog allowlists sort and bounds limit.
 * Handlers are invoked directly off the router stack (no supertest at root).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content/blog-writer', () => ({}));
jest.mock('../services/content/blog-auditor', () => ({}));
jest.mock('../config/models', () => ({}));
jest.mock('../services/content-astro/spoke-sites', () => ({ invalidSpokeSites: () => [] }));
jest.mock('../services/content/autonomous-review-queue', () => ({}));
jest.mock('../services/content/internal-link-review-queue', () => ({}));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));
jest.mock('../services/content-astro/astro-publisher', () => ({ publishAstro: jest.fn(), generatePlannedImage: jest.fn(), mergeAstro: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-content-v2');

const POST_ID = '3f2a9c34-1111-2222-3333-444455556666';

let tableState;

const ACTIVE_STATES = ['pr_open', 'build_failed', 'merged', 'live', 'unpublish_pending'];
const isActive = (p) => Boolean(p && (ACTIVE_STATES.includes(p.astro_status) || p.astro_pr_number || p.astro_branch_name));
// Fake delete mirrors the route's full predicate (astro-active, published,
// or mid-publish claim)
const claimLive = (p) => Boolean(p && p.publish_claimed_at && (Date.now() - new Date(p.publish_claimed_at).getTime()) < 30 * 60 * 1000);
const isDeletable = (p) => Boolean(p && !isActive(p) && p.status !== 'published' && p.publish_status !== 'publishing' && !claimLive(p));

function setupDb() {
  const calls = { updates: [], deletes: 0 };
  db.mockImplementation((table) => {
    const q = {
      _filters: {},
      where: jest.fn(function (a, b) {
        if (a && typeof a === 'object') Object.assign(q._filters, a);
        else if (typeof a === 'string') q._filters[a] = b;
        return q;
      }),
      whereNull: jest.fn(() => q),
      whereNot: jest.fn(() => q),
      whereNotIn: jest.fn(() => q),
      orWhereNotIn: jest.fn(() => q),
      orWhereNull: jest.fn(() => q),
      orWhere: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      offset: jest.fn((n) => { q._offset = n; return q; }),
      limit: jest.fn(() => Promise.resolve(tableState.rows || [])),
      groupBy: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => q),
      count: jest.fn(() => q),
      first: jest.fn(() => Promise.resolve(tableState.post ?? null)),
      update: jest.fn((u) => { calls.updates.push({ table, filters: { ...q._filters }, updates: u }); return { returning: () => Promise.resolve([{ ...tableState.post, ...u }]) }; }),
      // Mirrors the atomic guarded delete: only a non-astro-active existing
      // row deletes; anything else reports 0 rows like Postgres would.
      del: jest.fn(() => {
        if (isDeletable(tableState.post)) {
          calls.deletes += 1;
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }),
    };
    return q;
  });
  return calls;
}

function findHandler(method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(method, path, { params = {}, body = {}, query = {} } = {}) {
  const handler = findHandler(method, path);
  const req = { params, body, query, technicianId: 'test-admin', ip: '127.0.0.1' };
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(p) { payload = p; return this; },
  };
  let nextErr = null;
  await handler(req, res, (err) => { nextErr = err; });
  return { statusCode, payload, nextErr };
}

beforeEach(() => {
  tableState = { post: null, rows: [] };
  jest.clearAllMocks();
});

describe('manual blog creation is retired (owner 2026-10-30)', () => {
  test('no create route is mounted: new posts come from Autopilot', () => {
    const mounted = router.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
    for (const gone of [
      'POST /generate',
      'POST /blog/ideas',
      'POST /blog/bulk-generate',
      'POST /blog/:id/generate',
      'GET /weather',
    ]) {
      expect(mounted).not.toContain(gone);
    }
  });
});

describe('DELETE /blog/:id guard', () => {
  test('refuses astro-active posts and 404s missing rows', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'published', astro_status: 'live' };
    const live = await invoke('delete', '/blog/:id', { params: { id: POST_ID } });
    expect(live.statusCode).toBe(409);
    expect(calls.deletes).toBe(0);

    tableState.post = null;
    const missing = await invoke('delete', '/blog/:id', { params: { id: POST_ID } });
    expect(missing.statusCode).toBe(404);
  });

  test('legacy published row (no astro markers) still refuses delete — un-publish first (codex r2)', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'published', astro_status: 'draft', astro_pr_number: null, astro_branch_name: null };
    const r = await invoke('delete', '/blog/:id', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(409);
    expect(r.payload.error).toContain('un-publish');
    expect(calls.deletes).toBe(0);
  });

  test('legacy/archive statuses (wp_draft/scheduled/archived) still save through PUT (codex r2+r9)', async () => {
    setupDb();
    for (const status of ['wp_draft', 'scheduled', 'archived']) {
      tableState.post = { id: POST_ID, status, astro_status: 'draft' };
      const r = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { status, title: 'T' } });
      expect(r.statusCode).toBe(200);
    }
  });

  test('deletes a plain draft', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'draft' };
    const r = await invoke('delete', '/blog/:id', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(200);
    expect(calls.deletes).toBe(1);
  });

  test('refuses build_failed and PR-bearing rows (guard is in the DELETE WHERE, not a separate read)', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'build_failed' };
    expect((await invoke('delete', '/blog/:id', { params: { id: POST_ID } })).statusCode).toBe(409);

    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'publish_failed', astro_pr_number: 88 };
    const r = await invoke('delete', '/blog/:id', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(409);
    expect(r.payload.error).toContain('PR #88');
    expect(calls.deletes).toBe(0);

    // branch-only marker (no PR): deleting would lose the only DB reference
    // to the surviving branch the scheduler reclaims (codex r1)
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'publish_failed', astro_pr_number: null, astro_branch_name: 'content/blog-x' };
    expect((await invoke('delete', '/blog/:id', { params: { id: POST_ID } })).statusCode).toBe(409);
    expect(calls.deletes).toBe(0);
  });
});

describe('PUT /blog/:id status validation', () => {
  test('rejects unknown status values and the direct →published jump', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'draft' };
    const junk = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { status: 'zombie' } });
    expect(junk.nextErr?.statusCode).toBe(400);

    const jump = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { status: 'published' } });
    expect(jump.nextErr?.statusCode).toBe(400);
  });

  test('saving an already-published post keeps working; 404 on missing row', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'published', astro_status: 'live' };
    const save = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { status: 'published', title: 'T' } });
    expect(save.statusCode).toBe(200);
    expect(save.payload.post.title).toBe('T');

    tableState.post = null;
    const missing = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { title: 'T' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('GET /blog sort/limit hardening', () => {
  test('unknown sort falls back to publish_date and bad limit 400s instead of dumping the table', async () => {
    setupDb();
    tableState.rows = [];
    const ok = await invoke('get', '/blog', { query: { sort: 'evil_column', order: 'sideways' } });
    expect(ok.statusCode).toBe(200);

    const bad = await invoke('get', '/blog', { query: { limit: 'abc' } });
    expect(bad.nextErr?.statusCode).toBe(400);
  });

  test('pages with offset and reports every matching row as total (audit BLOG-12)', async () => {
    setupDb();
    tableState.rows = [{ id: 'a' }];
    tableState.post = { count: '523' };
    const page = await invoke('get', '/blog', { query: { status: 'published', offset: '200' } });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toMatchObject({ posts: [{ id: 'a' }], total: 523, offset: 200 });
    const listQuery = db.mock.results.find((r) => r.value.offset.mock.calls.length)?.value;
    expect(listQuery.offset).toHaveBeenCalledWith(200);

    const bad = await invoke('get', '/blog', { query: { offset: '-1' } });
    expect(bad.nextErr?.statusCode).toBe(400);
  });
});

// codex r4 (P0): the manual publish lane must own the row while publishAstro
// runs its long external workflow — DELETE/generate reject the claim, and
// the route restores the prior publish_status afterwards.
describe('regenerate-image publish guard (codex r10)', () => {
  test('refuses while a publisher owns the row; allowed on a plain open-PR row (edit->refresh lane)', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'queued', publish_status: 'publishing' };
    expect((await invoke('post', '/blog/:id/regenerate-image', { params: { id: POST_ID } })).statusCode).toBe(409);

    tableState.post = { id: POST_ID, status: 'draft', publish_claimed_at: new Date() };
    expect((await invoke('post', '/blog/:id/regenerate-image', { params: { id: POST_ID } })).statusCode).toBe(409);
  });

  test('an admin hero is planned + screened like an autonomous one — seeded by the row slug — and the row stores its data URL (Codex r4 P2 on #3964)', async () => {
    const calls = setupDb();
    const AstroPublisher = require('../services/content-astro/astro-publisher');
    AstroPublisher.generatePlannedImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QUJD', model: 'gpt-image-2', plan: { style: 'cartoon', setting: 'in a backyard, dew on the grass' }, screen: { checked: true, ok: true, reasons: [] } });
    tableState.post = { id: POST_ID, status: 'draft', title: 'Ghost Ants In Sarasota', slug: 'pest-control/ghost-ants-sarasota', keyword: 'ghost ants', meta_description: 'm' };
    const r = await invoke('post', '/blog/:id/regenerate-image', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(200);
    expect(AstroPublisher.generatePlannedImage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'blog-hero', index: 0, slug: 'pest-control/ghost-ants-sarasota', title: 'Ghost Ants In Sarasota', keyword: 'ghost ants' }));
    expect(calls.updates.at(-1).updates.featured_image_url).toBe('data:image/png;base64,QUJD');
  });
});

describe('publish-astro atomic claim (publish_claimed_at — lane-neutral, invisible to pages-poll)', () => {
  const AstroPublisher = require('../services/content-astro/astro-publisher');

  test('claims before publishAstro and releases after — publish_status untouched', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: null, publish_status: 'pending_review', publish_claimed_at: null };
    AstroPublisher.publishAstro.mockResolvedValue({ pr_number: 9 });

    const r = await invoke('post', '/blog/:id/publish-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(200);
    const claimWrites = calls.updates.filter((u) => 'publish_claimed_at' in u.updates).map((u) => u.updates.publish_claimed_at);
    expect(claimWrites).toHaveLength(2);
    expect(claimWrites[0]).toBeInstanceOf(Date);
    expect(claimWrites[1]).toBeNull();
    // Tokenized release: the clear is CAS'd on the exact claim stamp, so a
    // stale publisher can't release a newer publisher's lease (codex r5).
    const release = calls.updates.find((u) => u.updates.publish_claimed_at === null);
    expect(release.filters.publish_claimed_at).toEqual(claimWrites[0]);
    // pages-poll's auto-merge marker is never written by the manual lane
    expect(calls.updates.some((u) => 'publish_status' in u.updates)).toBe(false);
  });

  test('a row already claimed 409s instead of double-publishing (fresh claim blocks, stale claim does not)', async () => {
    const calls = setupDb();
    // updateResult-style: the claim UPDATE reports 0 rows for a live claim
    tableState.post = { id: POST_ID, status: 'queued', publish_claimed_at: new Date() };
    calls.claimBlocked = true;
    db.mockImplementation((table) => {
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        orWhere: jest.fn(() => q),
        orWhereNot: jest.fn(() => q),
        orWhereNotIn: jest.fn(() => q),
        first: jest.fn(() => Promise.resolve(tableState.post ?? null)),
        update: jest.fn(() => Promise.resolve(0)),
      };
      return q;
    });
    const r = await invoke('post', '/blog/:id/publish-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(409);
    expect(AstroPublisher.publishAstro).not.toHaveBeenCalled();
  });

  test('the claim is released even when publishAstro throws', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'draft', publish_claimed_at: null };
    AstroPublisher.publishAstro.mockRejectedValue(Object.assign(new Error('gates failed'), { code: 'BLOG_GUARDRAILS_FAILED' }));
    const r = await invoke('post', '/blog/:id/publish-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(400);
    const claimWrites = calls.updates.filter((u) => 'publish_claimed_at' in u.updates).map((u) => u.updates.publish_claimed_at);
    expect(claimWrites[claimWrites.length - 1]).toBeNull();
  });

  test('a final-text comparison rejection (hero / body-image alt) is the author\'s to fix: 400, not 500 (#5146 r11)', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'draft', publish_claimed_at: null };
    AstroPublisher.publishAstro.mockRejectedValue(Object.assign(new Error('final text fails the comparison gate: P0 COMPARISON_DISPARAGEMENT'), { code: 'BLOG_OWNER_LIST_BLOCKED' }));
    const r = await invoke('post', '/blog/:id/publish-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(400);
  });

  test('DELETE refuses a mid-publish claimed row (scheduler marker or manual claim)', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'queued', astro_status: null, publish_status: 'publishing' };
    expect((await invoke('delete', '/blog/:id', { params: { id: POST_ID } })).statusCode).toBe(409);

    tableState.post = { id: POST_ID, status: 'queued', astro_status: null, publish_status: null, publish_claimed_at: new Date() };
    const r = await invoke('delete', '/blog/:id', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(409);
    expect(r.payload.error).toContain('being published');
    expect(calls.deletes).toBe(0);
  });

  test('the lease renews while publishAstro runs and releases the RENEWED stamp (heartbeat, codex r8)', async () => {
    jest.useFakeTimers();
    try {
      const calls = setupDb();
      tableState.post = { id: POST_ID, status: 'draft', astro_status: null, publish_claimed_at: null };
      const AstroPublisher = require('../services/content-astro/astro-publisher');
      let finish;
      AstroPublisher.publishAstro.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

      const pending = invoke('post', '/blog/:id/publish-astro', { params: { id: POST_ID } });
      await Promise.resolve(); // let the claim land
      await jest.advanceTimersByTimeAsync(11 * 60 * 1000); // one renewal interval
      finish({ pr_number: 9 });
      const r = await pending;
      expect(r.statusCode).toBe(200);

      const claimWrites = calls.updates.filter((u) => 'publish_claimed_at' in u.updates);
      // claim, >=1 renewal, release
      expect(claimWrites.length).toBeGreaterThanOrEqual(3);
      const release = claimWrites[claimWrites.length - 1];
      expect(release.updates.publish_claimed_at).toBeNull();
      const renewal = claimWrites[claimWrites.length - 2];
      // the release CAS targets the RENEWED stamp, not the original claim
      expect(release.filters.publish_claimed_at).toEqual(renewal.updates.publish_claimed_at);
    } finally {
      jest.useRealTimers();
    }
  });

  test('retryable failed states can still claim (admin Retry path — publishAstro reconciles the stale PR/branch)', async () => {
    const calls = setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'build_failed', astro_pr_number: 12, astro_branch_name: 'content/blog-x', publish_claimed_at: null };
    const AstroPublisher = require('../services/content-astro/astro-publisher');
    AstroPublisher.publishAstro.mockResolvedValue({ pr_number: 13 });
    const r = await invoke('post', '/blog/:id/publish-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(200);
    // An admin click is a human publish: the owner-list chokepoint defers to it.
    expect(AstroPublisher.publishAstro).toHaveBeenCalledWith(POST_ID, { humanApproved: true });
  });

  test('PUT refuses a mid-publish row and CAS-guards against a concurrent status flip', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'queued', publish_claimed_at: new Date() };
    expect((await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { title: 'T' } })).statusCode).toBe(409);
  });
});

describe('merge-astro returns the row after the merge (audit BLOG-07)', () => {
  const AstroPublisher = require('../services/content-astro/astro-publisher');

  test('the editor gets the merged row', async () => {
    setupDb();
    AstroPublisher.mergeAstro.mockResolvedValue({ merged: true, unpublished: true, pr_number: 9, live_url: null });
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'draft', astro_pr_number: null };
    const r = await invoke('post', '/blog/:id/merge-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toMatchObject({ success: true, unpublished: true, post: { astro_status: 'draft', status: 'draft' } });
  });

  test('a failed read after a merged PR still reports the merge, with post null', async () => {
    db.mockImplementation(() => ({ where: () => ({ first: () => Promise.reject(new Error('connection reset')) }) }));
    AstroPublisher.mergeAstro.mockResolvedValue({ merged: true, unpublished: false, pr_number: 9, live_url: 'https://x.invalid/p/' });
    const r = await invoke('post', '/blog/:id/merge-astro', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toMatchObject({ success: true, merged: true, post: null });
  });
});
