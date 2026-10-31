/**
 * DELETE /api/admin/content/schedule/:id for a blog row (audit 2026-10-30,
 * BLOG-04): a run that already claimed the row keeps going and opens the PR,
 * so the cancel is refused instead of reported; a preview PR the run already
 * opened is named in the response. Handlers are invoked off the router stack.
 *
 * Also covers Calendar scheduling of a saved Social Studio campaign draft
 * (SOC-01): the draft list, POST /schedule-social with a postId, and
 * unscheduling it back to a pickable draft. The social tests run against a
 * small in-memory social_media_posts table so the conditional WHEREs decide.
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

// --- Saved campaign drafts (SOC-01) ----------------------------------------

function draftRow(over = {}) {
  return {
    id: ID,
    title: 'Synthetic campaign',
    description: 'Synthetic description',
    source_url: 'https://wavespestcontrol.com/pest-control/',
    source_guid: 'campaign_builder_1',
    source_type: 'campaign_builder',
    platforms_posted: JSON.stringify(['facebook', 'gbp']),
    image_url: 'https://cdn.example.com/card.png',
    custom_content: JSON.stringify({ facebook: 'fb copy', gbp: 'gbp copy' }),
    status: 'draft',
    publish_status: 'pending',
    scheduled_for: null,
    ...over,
  };
}

// Minimal knex stand-in: where/whereNull filter, update reports rows touched
// (and supports .returning), insert returns the new row.
function fakeSocialDb(rows, runs = []) {
  db.mockImplementation((table) => {
    let matches = table === 'social_media_posts' ? rows.slice()
      : table === 'social_content_studio_runs' ? runs.slice() : [];
    let selected = null;
    const q = {
      rows: () => matches,
      selectedColumn: () => selected,
      modify(fn) { fn(q); return q; },
      whereNotNull(col) { matches = matches.filter((r) => r[col] != null); return q; },
      whereNotIn(col, sub) {
        const ids = sub.rows().map((r) => r[sub.selectedColumn()]);
        matches = matches.filter((r) => !ids.includes(r[col]));
        return q;
      },
      where(a, b) {
        const cond = typeof a === 'object' ? a : { [a]: b };
        matches = matches.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      whereNull(col) { matches = matches.filter((r) => r[col] == null); return q; },
      whereIn(col, values) { matches = matches.filter((r) => values.includes(r[col])); return q; },
      select(col) { selected = col; return q; },
      orderBy() { return q; },
      limit() { return q; },
      first: () => Promise.resolve(matches[0]),
      update(updates) {
        matches.forEach((r) => Object.assign(r, updates));
        const done = Promise.resolve(matches.length);
        done.returning = () => Promise.resolve(matches.map((r) => ({ ...r })));
        return done;
      },
      insert(values) {
        const row = { id: 'new-post', ...values };
        rows.push(row);
        return { returning: () => Promise.resolve([row]) };
      },
      then: (resolve, reject) => Promise.resolve(matches).then(resolve, reject),
    };
    return q;
  });
}

async function callRoute(method, path, { params = {}, body = {} } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  let statusCode = 200;
  let payload = null;
  let error = null;
  const res = { status(c) { statusCode = c; return this; }, json(p) { payload = p; return this; } };
  await handler({ params, body, query: {} }, res, (err) => { error = err; });
  if (error) return { statusCode: error.statusCode || 500, payload: { error: error.message } };
  return { statusCode, payload };
}

// 2026-11-05 09:00 Eastern is EST (the clocks went back Nov 1).
const NOV_5_9AM_ET = '2026-11-05T14:00:00.000Z';

describe('POST /schedule-social with a saved draft (SOC-01)', () => {
  test('gives the saved row its time and keeps its copy, image, channels, title and link', async () => {
    const rows = [draftRow()];
    fakeSocialDb(rows);
    const r = await callRoute('post', '/schedule-social', { body: { postId: ID, scheduledFor: '2026-11-05T09:00:00' } });
    expect(r.statusCode).toBe(200);
    expect(rows).toHaveLength(1); // the same row, not a new title-only one
    expect(rows[0].scheduled_for.toISOString()).toBe(NOV_5_9AM_ET);
    expect(rows[0]).toMatchObject({
      status: 'scheduled',
      publish_status: 'pending',
      source_type: 'campaign_builder',
      title: 'Synthetic campaign',
      source_url: 'https://wavespestcontrol.com/pest-control/',
      image_url: 'https://cdn.example.com/card.png',
      platforms_posted: JSON.stringify(['facebook', 'gbp']),
    });
    expect(r.payload.post.id).toBe(ID);
  });

  test.each([
    ['already published', { status: 'published', publish_status: 'published' }],
    ['already scheduled', { status: 'scheduled', scheduled_for: new Date('2026-11-06T14:00:00Z') }],
    ['claimed by the scheduler', { publish_status: 'publishing' }],
    ['not a campaign draft', { source_type: 'scheduled' }],
  ])('a row that is %s is refused with 409 and not changed', async (_label, over) => {
    const rows = [draftRow(over)];
    const before = JSON.stringify(rows[0]);
    fakeSocialDb(rows);
    const r = await callRoute('post', '/schedule-social', { body: { postId: ID, scheduledFor: '2026-11-05T09:00:00' } });
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(rows[0])).toBe(before);
  });

  test('an unknown id is 409, a junk id is 404 before the database, a missing time is 400', async () => {
    fakeSocialDb([draftRow()]);
    expect((await callRoute('post', '/schedule-social', { body: { postId: '9f2a9c34-1111-2222-3333-444455556666', scheduledFor: '2026-11-05T09:00:00' } })).statusCode).toBe(409);
    db.mockClear();
    expect((await callRoute('post', '/schedule-social', { body: { postId: 'not-a-uuid', scheduledFor: '2026-11-05T09:00:00' } })).statusCode).toBe(404);
    expect(db).not.toHaveBeenCalled();
    expect((await callRoute('post', '/schedule-social', { body: { postId: ID } })).statusCode).toBe(400);
  });

  test('without a postId a typed post still creates a new scheduled row', async () => {
    const rows = [draftRow()];
    fakeSocialDb(rows);
    const r = await callRoute('post', '/schedule-social', { body: { title: 'Typed post', scheduledFor: '2026-11-05T09:00:00' } });
    expect(r.statusCode).toBe(200);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ title: 'Typed post', source_type: 'scheduled', status: 'scheduled', publish_status: 'pending' });
    expect(rows[0].scheduled_for).toBeNull();
  });
});

describe('GET /social-drafts (SOC-01)', () => {
  test('lists only saved campaign drafts that have no time, with their channels', async () => {
    fakeSocialDb([
      draftRow(),
      draftRow({ id: 'p2', status: 'scheduled', scheduled_for: new Date() }),
      draftRow({ id: 'p3', status: 'published', publish_status: 'published' }),
      draftRow({ id: 'p4', source_type: 'scheduled' }),
    ]);
    const r = await callRoute('get', '/social-drafts');
    expect(r.payload).toEqual({ drafts: [{ id: ID, title: 'Synthetic campaign', channels: ['facebook', 'gbp'] }] });
  });
});

describe('autonomous-run drafts stay out of the Calendar (SOC-01)', () => {
  const RUN_POST = '9c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff';
  const runs = [{ id: 'run-1', social_media_post_id: RUN_POST }, { id: 'run-2', social_media_post_id: null }];

  test('a draft an autonomous run saved is not listed', async () => {
    fakeSocialDb([draftRow(), draftRow({ id: RUN_POST, title: 'Run draft' })], runs);
    const r = await callRoute('get', '/social-drafts');
    expect(r.payload.drafts.map((d) => d.id)).toEqual([ID]);
  });

  test('scheduling an autonomous run draft is a 409 and leaves it untouched', async () => {
    const rows = [draftRow({ id: RUN_POST })];
    fakeSocialDb(rows, runs);
    const r = await callRoute('post', '/schedule-social', { body: { postId: RUN_POST, scheduledFor: '2026-11-02T14:00:00.000Z' } });
    expect(r.statusCode).toBe(409);
    expect(rows[0]).toMatchObject({ status: 'draft', scheduled_for: null });
  });
});

describe('DELETE /schedule/:id — social rows (SOC-01)', () => {
  test('a scheduled saved draft goes back to a draft with no time, and can be picked again', async () => {
    const rows = [draftRow({ status: 'scheduled', scheduled_for: new Date('2026-11-05T14:00:00Z') })];
    fakeSocialDb(rows);
    const r = await callRoute('delete', '/schedule/:id', { params: { id: ID } });
    expect(r.payload).toEqual({ success: true, type: 'social', id: ID });
    expect(rows[0]).toMatchObject({ status: 'draft', publish_status: 'pending', scheduled_for: null });
    expect((await callRoute('get', '/social-drafts')).payload.drafts.map((d) => d.id)).toEqual([ID]);
  });

  test.each([['publishing'], ['published']])('a saved draft the scheduler already %s is refused with 409 and not changed', async (state) => {
    const rows = [draftRow({ status: 'scheduled', publish_status: state, scheduled_for: new Date('2026-11-05T14:00:00Z') })];
    const before = JSON.stringify(rows[0]);
    fakeSocialDb(rows);
    const r = await callRoute('delete', '/schedule/:id', { params: { id: ID } });
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(rows[0])).toBe(before);
  });

  test('a typed (title-only) scheduled post unschedules exactly as before', async () => {
    const rows = [draftRow({ source_type: 'scheduled', status: 'scheduled', scheduled_for: new Date('2026-11-05T14:00:00Z') })];
    fakeSocialDb(rows);
    const r = await callRoute('delete', '/schedule/:id', { params: { id: ID } });
    expect(r.payload).toEqual({ success: true, type: 'social', id: ID });
    expect(rows[0]).toMatchObject({ status: 'draft', publish_status: null, scheduled_for: null });
  });

  test('a typed post the scheduler already claimed is a 409 and keeps publishing', async () => {
    const rows = [draftRow({ source_type: 'scheduled', status: 'scheduled', publish_status: 'publishing', scheduled_for: new Date('2026-11-05T14:00:00Z') })];
    fakeSocialDb(rows);
    const r = await callRoute('delete', '/schedule/:id', { params: { id: ID } });
    expect(r.statusCode).toBe(409);
    expect(rows[0]).toMatchObject({ status: 'scheduled', publish_status: 'publishing' });
  });
});
