const routeHandlers = {};
const useHandlers = [];

jest.mock('express', () => ({
  Router: () => ({
    use: jest.fn((...handlers) => useHandlers.push(...handlers)),
    get: jest.fn((path, ...handlers) => { routeHandlers[`GET ${path}`] = handlers; }),
    post: jest.fn((path, ...handlers) => { routeHandlers[`POST ${path}`] = handlers; }),
  }),
}));

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (req.token === 'admin') {
      req.techRole = 'admin';
      return next();
    }
    if (req.token === 'tech') {
      req.techRole = 'technician';
      return next();
    }
    return res.status(401).json({ error: 'Admin authentication required' });
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

jest.mock('../services/content/content-registry', () => ({
  runContentRegistrySync: jest.fn(),
}));

jest.mock('../services/content/content-registry-admin', () => ({
  listContentRegistry: jest.fn(),
}));

const registry = require('../services/content/content-registry');
const contentRegistryRouter = require('../routes/admin-content-registry');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function runStack(req) {
  const res = makeRes();
  let idx = 0;
  const stack = [...useHandlers, ...routeHandlers['POST /sync']];
  const next = async (err) => {
    if (err) throw err;
    const handler = stack[idx++];
    if (handler) await handler(req, res, next);
  };
  await next();
  return res;
}

describe('admin content registry sync route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes sync body for GitHub-backed commit runs', () => {
    expect(contentRegistryRouter.normalizeSyncBody({
      commit: 'true',
      source: 'github',
      content_type: 'blog',
      github_ref: 'main',
    })).toEqual(expect.objectContaining({
      commit: true,
      astroSource: 'github',
      contentType: 'blog',
      githubRef: 'main',
    }));
  });

  test('requires admin and returns a compact sync response', async () => {
    registry.runContentRegistrySync.mockResolvedValue({
      ok: true,
      mode: 'commit',
      source: 'github',
      astro_root: 'github:wavespestcontrolfl/wavespestcontrol-astro@main',
      github_ref: 'main',
      sync_run_id: 'sync-1',
      summary: { astro_files_scanned: 2, matched_count: 1 },
      rows: [{ id: 'not-returned' }],
    });

    const forbidden = await runStack({ token: 'tech', body: { commit: true } });
    expect(forbidden.statusCode).toBe(403);

    const res = await runStack({
      token: 'admin',
      body: { commit: true, source: 'github', content_type: 'blog', github_ref: 'main' },
    });

    expect(res.statusCode).toBe(200);
    expect(registry.runContentRegistrySync).toHaveBeenCalledWith(expect.objectContaining({
      commit: true,
      astroSource: 'github',
      contentType: 'blog',
      githubRef: 'main',
    }));
    expect(res.body).toEqual({
      ok: true,
      mode: 'commit',
      source: 'github',
      astro_root: 'github:wavespestcontrolfl/wavespestcontrol-astro@main',
      github_ref: 'main',
      sync_run_id: 'sync-1',
      summary: { astro_files_scanned: 2, matched_count: 1 },
      error: undefined,
      code: undefined,
    });
  });

  test('surfaces failed syncs without registry rows', async () => {
    registry.runContentRegistrySync.mockResolvedValue({
      ok: false,
      mode: 'commit',
      source: 'github',
      sync_run_id: 'sync-failed',
      summary: { error_count: 1 },
      error: 'GITHUB_TOKEN not set',
      code: 'GITHUB_TOKEN_MISSING',
      rows: [{ id: 'not-returned' }],
    });

    const res = await runStack({
      token: 'admin',
      body: { commit: true, source: 'github' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      error: 'GITHUB_TOKEN not set',
      code: 'GITHUB_TOKEN_MISSING',
    }));
    expect(res.body.rows).toBeUndefined();
  });
});
