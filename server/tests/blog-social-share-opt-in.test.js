/**
 * Social sharing on a scheduled blog publish is opt-IN (owner rule,
 * 2026-07-15 audit → owner decision 2026-07-16): the silent default-true at
 * every layer (route, scheduler signature, UI checkbox, column default) let
 * scheduling a publish trigger a customer-facing social share unnoticed.
 * Route + scheduler layers are pinned here; the column default lives in
 * migration 20260716150000; the Calendar checkbox default is client-side.
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
jest.mock('../services/content-scheduler', () => ({ scheduleBlogPost: jest.fn().mockResolvedValue({ id: 'p1' }) }));

const db = require('../models/db');
const ContentScheduler = require('../services/content-scheduler');
const router = require('../routes/admin-content-v2');

function findHandler(method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(body) {
  const handler = findHandler('post', '/schedule-blog/:id');
  let payload = null;
  const res = { status() { return this; }, json(p) { payload = p; return this; } };
  await handler({ params: { id: 'p1' }, body, query: {} }, res, () => {});
  return payload;
}

describe('POST /schedule-blog/:id social share opt-in', () => {
  beforeEach(() => jest.clearAllMocks());

  test('omitted autoShareSocial schedules WITHOUT sharing', async () => {
    await invoke({ publishAt: '2026-07-20T09:00:00Z' });
    expect(ContentScheduler.scheduleBlogPost).toHaveBeenCalledWith('p1', '2026-07-20T09:00:00Z', false);
  });

  test('only an explicit true opts in (truthy junk does not)', async () => {
    await invoke({ publishAt: 'x', autoShareSocial: true });
    expect(ContentScheduler.scheduleBlogPost).toHaveBeenLastCalledWith('p1', 'x', true);
    await invoke({ publishAt: 'x', autoShareSocial: 'yes' });
    expect(ContentScheduler.scheduleBlogPost).toHaveBeenLastCalledWith('p1', 'x', false);
  });
});

describe('ContentScheduler.scheduleBlogPost default', () => {
  test('the signature default is false (no caller can inherit a silent share)', async () => {
    const realScheduler = jest.requireActual('../services/content-scheduler');
    let written = null;
    db.mockImplementation(() => ({
      where: jest.fn(function () { return this; }),
      first: jest.fn(() => Promise.resolve({ id: 'p1', title: 'T' })),
      update: jest.fn(function (u) { written = u; return this; }),
      returning: jest.fn(() => Promise.resolve([{ id: 'p1', title: 'T' }])),
    }));
    await realScheduler.scheduleBlogPost('p1', '2026-07-20T09:00:00Z');
    expect(written.auto_share_social).toBe(false);
    await realScheduler.scheduleBlogPost('p1', '2026-07-20T09:00:00Z', true);
    expect(written.auto_share_social).toBe(true);
  });
});

// Agent lane: opt-in must be enforced at TOOL EXECUTION, not just prompt
// text — a model that calls distribute_to_social anyway gets a refusal, and
// schedule_content can't smuggle auto_share_social=true into a non-opted run.
describe('content-agent tool-level enforcement', () => {
  test('runBatch topic specs cannot override the normalized send gate', async () => {
    jest.resetModules();
    const agent = require('../services/content/content-agent');
    const seen = [];
    const origRun = agent.run;
    agent.run = jest.fn(async (o) => { seen.push(o.distributeSocial); return {}; });
    try {
      await agent.runBatch([{ topic: 't1', distributeSocial: 'yes' }, { topic: 't2', distributeSocial: true }], { distributeSocial: false });
      expect(seen).toEqual([false, false]);
      seen.length = 0;
      await agent.runBatch([{ topic: 't3' }], { distributeSocial: true });
      expect(seen).toEqual([true]);
    } finally {
      agent.run = origRun;
    }
  });


  test('schedule_content tool treats omitted auto_share_social as FALSE', async () => {
    jest.resetModules();
    jest.doMock('../services/content-scheduler', () => ({ scheduleBlogPost: jest.fn().mockResolvedValue({}) }));
    const tools = require('../services/content/content-agent-tools');
    const scheduler = require('../services/content-scheduler');
    const exec = tools.executeContentTool || tools.executeTool;
    const r = await exec('schedule_content', { post_id: 'p1', publish_at: '2026-07-20T09:00:00Z' });
    expect(scheduler.scheduleBlogPost).toHaveBeenCalledWith('p1', '2026-07-20T09:00:00Z', false);
    expect(r.auto_share_social).toBe(false);
  });
});
