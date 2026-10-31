/**
 * DELETE /api/admin/content/schedule/:id for a blog row (audit 2026-10-30,
 * BLOG-04): a run that already claimed the row keeps going and opens the PR,
 * so the cancel is refused instead of reported; a preview PR the run already
 * opened is named in the response. Handlers are invoked off the router stack.
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
jest.mock('../services/content-astro/astro-publisher', () => ({ publishAstro: jest.fn(), generatePlannedImage: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-content-v2');

const ID = '3f2a9c34-1111-2222-3333-444455556666';

// blog_posts reads return `row`; the guarded update reports `cleared` rows and
// records its WHERE so the test can see the claim guard.
function setupDb({ row, cleared }) {
  const writes = [];
  db.mockImplementation((table) => {
    const filters = [];
    const q = {
      where: jest.fn((a, b) => {
        if (typeof a === 'function') a({ whereNull: (c) => { filters.push(['whereNull', c]); return { orWhereNot: (col, val) => filters.push(['orWhereNot', col, val]) }; } });
        else filters.push([a, b]);
        return q;
      }),
      first: jest.fn(() => Promise.resolve(table === 'blog_posts' ? row : null)),
      update: jest.fn((updates) => {
        writes.push({ table, filters: filters.slice(), updates });
        return Promise.resolve(cleared);
      }),
    };
    return q;
  });
  return writes;
}

async function unschedule() {
  const layer = router.stack.find((l) => l.route?.path === '/schedule/:id' && l.route.methods.delete);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  let statusCode = 200;
  let payload = null;
  const res = { status(c) { statusCode = c; return this; }, json(p) { payload = p; return this; } };
  await handler({ params: { id: ID } }, res, (err) => { throw err; });
  return { statusCode, payload };
}

beforeEach(() => jest.clearAllMocks());

describe('DELETE /schedule/:id — blog rows (BLOG-04)', () => {
  test('a run already publishing the row keeps it: 409, not a reported cancel', async () => {
    const writes = setupDb({ row: { id: ID, publish_status: 'publishing' }, cleared: 0 });
    const r = await unschedule();
    expect(r.statusCode).toBe(409);
    expect(r.payload.error).toMatch(/already started/);
    // the claim guard is in the UPDATE's WHERE, not only in the read
    expect(writes[0].filters).toEqual(expect.arrayContaining([['orWhereNot', 'publish_status', 'publishing']]));
  });

  test('a pending schedule clears; a preview PR the run opened is named', async () => {
    setupDb({ row: { id: ID, publish_status: 'pending' }, cleared: 1 });
    expect((await unschedule()).payload).toEqual({ success: true, type: 'blog', id: ID, pr_number: null });

    const writes = setupDb({ row: { id: ID, publish_status: 'pending_review', astro_pr_number: 42 }, cleared: 1 });
    const r = await unschedule();
    expect(r.payload).toEqual({ success: true, type: 'blog', id: ID, pr_number: 42 });
    expect(writes[0].updates).toMatchObject({ scheduled_publish_at: null, publish_status: null });
  });
});
