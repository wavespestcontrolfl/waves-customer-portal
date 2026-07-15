const gh = require('../services/content-astro/github-client');

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('content-astro github-client pagination', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_OWNER = 'wavespestcontrolfl';
    process.env.GITHUB_ASTRO_REPO = 'wavespestcontrol-astro-';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('listIssueComments paginates past the first 100 rows', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const secondPage = [{ id: 101 }];
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    const rows = await gh.listIssueComments(123);

    expect(rows).toHaveLength(101);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/issues/123/comments?per_page=100&page=1'),
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/issues/123/comments?per_page=100&page=2'),
      expect.any(Object)
    );
  });

  test('listPrReviews paginates pull request reviews', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))))
      .mockResolvedValueOnce(jsonResponse([]));

    const rows = await gh.listPrReviews(456);

    expect(rows).toHaveLength(100);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/pulls/456/reviews?per_page=100&page=2'),
      expect.any(Object)
    );
  });
});

describe('commitFiles — atomic multi-file commit via the git data API', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_OWNER = 'wavespestcontrolfl';
    process.env.GITHUB_ASTRO_REPO = 'wavespestcontrol-astro-';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('text + binary + delete land as ONE commit: blob for bytes, inline content for text, sha:null delete, force:false ref update', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (url.includes('/git/refs/heads/') && (init.method || 'GET') === 'GET') {
        return jsonResponse({ object: { sha: 'head-sha' } });
      }
      if (url.includes('/git/commits/head-sha')) return jsonResponse({ tree: { sha: 'base-tree-sha' } });
      if (url.endsWith('/git/blobs')) return jsonResponse({ sha: 'blob-sha' });
      if (url.endsWith('/git/trees')) return jsonResponse({ sha: 'new-tree-sha' });
      if (url.endsWith('/git/commits')) return jsonResponse({ sha: 'new-commit-sha' });
      if (url.includes('/git/refs/heads/') && init.method === 'PATCH') return jsonResponse({ object: { sha: 'new-commit-sha' } });
      throw new Error(`unexpected fetch: ${init.method || 'GET'} ${url}`);
    });

    const buffer = Buffer.from([0xff, 0xd8, 0x00, 0x01]); // non-UTF8 bytes
    const res = await gh.commitFiles({
      branch: 'content/autonomous-test-abc123',
      message: 'feat(blog): publish test',
      files: [
        { path: 'public/images/blog/test/hero.webp', buffer },
        { path: 'src/content/blog/test.mdx', content: '---\ntitle: t\n---\nbody' },
      ],
      deletes: ['src/content/blog/legacy.md'],
    });

    expect(res).toEqual({ commit: { sha: 'new-commit-sha' } });

    // Binary bytes go through a base64 blob — never the UTF-8 tree field.
    const blobCall = calls.find((c) => c.url.endsWith('/git/blobs'));
    expect(blobCall.body).toEqual({ content: buffer.toString('base64'), encoding: 'base64' });

    // One tree carries the write, the text file, and the deletion together.
    const treeCall = calls.find((c) => c.url.endsWith('/git/trees'));
    expect(treeCall.body.base_tree).toBe('base-tree-sha');
    expect(treeCall.body.tree).toEqual([
      { path: 'public/images/blog/test/hero.webp', mode: '100644', type: 'blob', sha: 'blob-sha' },
      { path: 'src/content/blog/test.mdx', mode: '100644', type: 'blob', content: '---\ntitle: t\n---\nbody' },
      { path: 'src/content/blog/legacy.md', mode: '100644', type: 'blob', sha: null },
    ]);

    // Exactly ONE commit object, parented on the branch head.
    const commitCall = calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST');
    expect(commitCall.body).toEqual({ message: 'feat(blog): publish test', tree: 'new-tree-sha', parents: ['head-sha'] });

    // Ref update is a non-forced fast-forward — a concurrent push 422s
    // instead of being clobbered (same lost-update posture as Contents sha).
    const refPatch = calls.find((c) => c.method === 'PATCH');
    expect(refPatch.body).toEqual({ sha: 'new-commit-sha', force: false });
  });

  test('refuses an empty commit and a missing branch', async () => {
    await expect(gh.commitFiles({ branch: 'b', message: 'm' })).rejects.toThrow('at least one file');
    await expect(gh.commitFiles({ message: 'm', files: [{ path: 'a', content: 'x' }] })).rejects.toThrow('requires branch');
  });
});
