/**
 * Destructive-endpoint guards on /api/admin/content/blog/* (2026-07-15 audit):
 * - POST /blog/:id/generate refuses published / astro-active posts (it
 *   unconditionally overwrites content and forces status back to draft).
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
jest.mock('../services/content/blog-writer', () => ({
  generatePost: jest.fn().mockResolvedValue({ success: true, content: 'x' }),
}));
jest.mock('../services/content/blog-auditor', () => ({}));
jest.mock('../config/models', () => ({}));
jest.mock('../services/content-astro/spoke-sites', () => ({ invalidSpokeSites: () => [] }));
jest.mock('../services/content/autonomous-review-queue', () => ({}));
jest.mock('../services/content/internal-link-review-queue', () => ({}));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));
jest.mock('../services/content-astro/astro-publisher', () => ({ publishAstro: jest.fn() }));

const db = require('../models/db');
const BlogWriter = require('../services/content/blog-writer');
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
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      whereNot: jest.fn(() => q),
      whereNotIn: jest.fn(() => q),
      orWhereNotIn: jest.fn(() => q),
      orWhereNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => Promise.resolve(tableState.rows || [])),
      groupBy: jest.fn(() => Promise.resolve([])),
      select: jest.fn(() => q),
      count: jest.fn(() => q),
      first: jest.fn(() => Promise.resolve(tableState.post ?? null)),
      update: jest.fn((u) => { calls.updates.push({ table, updates: u }); return { returning: () => Promise.resolve([{ ...tableState.post, ...u }]) }; }),
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

describe('POST /blog/:id/generate guard', () => {
  test('refuses a published post (content would be irreversibly overwritten)', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'published', astro_status: 'live' };
    const r = await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(409);
    expect(BlogWriter.generatePost).not.toHaveBeenCalled();
  });

  test('refuses an astro-active draft (open PR would be orphaned from its content)', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'pr_open' };
    const r = await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } });
    expect(r.statusCode).toBe(409);
  });

  test('refuses build_failed and marker-bearing publish_failed posts (PR/branch still exists)', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'build_failed' };
    expect((await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } })).statusCode).toBe(409);

    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'publish_failed', astro_pr_number: 88 };
    expect((await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } })).statusCode).toBe(409);

    // branch-only failure marker (branch created, PR creation failed):
    // astro_branch_name is the row's ONLY reference to the surviving branch
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'publish_failed', astro_pr_number: null, astro_branch_name: 'content/blog-x' };
    expect((await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } })).statusCode).toBe(409);

    // publish_failed with NO external markers is a plain retryable row
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'publish_failed', astro_pr_number: null, astro_branch_name: null };
    expect((await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } })).statusCode).toBe(200);

    // mid-publish scheduler claim: markers don't exist yet but the publisher
    // already captured the row's content (codex r3)
    tableState.post = { id: POST_ID, status: 'queued', astro_status: 'draft', publish_status: 'publishing' };
    expect((await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } })).statusCode).toBe(409);
  });

  test('allows a plain draft and 404s junk / missing ids', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'draft', astro_status: 'draft' };
    const ok = await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } });
    expect(ok.statusCode).toBe(200);
    expect(BlogWriter.generatePost).toHaveBeenCalledWith(POST_ID);

    tableState.post = null;
    const missing = await invoke('post', '/blog/:id/generate', { params: { id: POST_ID } });
    expect(missing.statusCode).toBe(404);

    const junk = await invoke('post', '/blog/:id/generate', { params: { id: 'not-a-uuid' } });
    expect(junk.nextErr?.statusCode).toBe(404);
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

  test('legacy statuses (wp_draft/scheduled) still save through PUT (codex r2)', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'wp_draft', astro_status: 'draft' };
    const a = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { status: 'wp_draft', title: 'T' } });
    expect(a.statusCode).toBe(200);
    tableState.post = { id: POST_ID, status: 'scheduled', astro_status: 'draft' };
    const b = await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { status: 'scheduled', title: 'T' } });
    expect(b.statusCode).toBe(200);
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
});

// codex r4 (P0): the manual publish lane must own the row while publishAstro
// runs its long external workflow — DELETE/generate reject the claim, and
// the route restores the prior publish_status afterwards.
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

  test('PUT refuses a mid-publish row and CAS-guards against a concurrent status flip', async () => {
    setupDb();
    tableState.post = { id: POST_ID, status: 'queued', publish_claimed_at: new Date() };
    expect((await invoke('put', '/blog/:id', { params: { id: POST_ID }, body: { title: 'T' } })).statusCode).toBe(409);
  });
});
