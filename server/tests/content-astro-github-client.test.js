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

  test('compareFiles reports both sides of a renamed entry and the merge base (GH r23)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ files: [{ filename: 'public/images/blog/x/body-2.webp', previous_filename: 'public/images/blog/x/body-1.webp', status: 'renamed' }, { filename: 'src/content/blog/x.mdx', status: 'modified' }], merge_base_commit: { sha: 'mb' } }));
    const res = await gh.compareFiles('content/blog-x');
    expect(res).toEqual({ files: ['public/images/blog/x/body-2.webp', 'public/images/blog/x/body-1.webp', 'src/content/blog/x.mdx'], mergeBaseSha: 'mb' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/compare/main...content%2Fblog-x'), expect.any(Object));
  });

  test('getFile percent-encodes reserved filename characters — a literal `?` in a name is not a query string (GH r29)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ sha: 'x', path: 'public/images/blog/x/what?name.webp', content: '' }));
    await gh.getFile('public/images/blog/x/what?name.webp');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/contents/public/images/blog/x/what%3Fname.webp?ref='), expect.any(Object));
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

  test('mergePr (no expectBaseSha) still PUTs /merge — the atomic ref-update path is opt-in only', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ merged: true, sha: 'merge-sha' }));

    await expect(gh.mergePr(42, { sha: 'head-sha' })).resolves.toMatchObject({ merged: true, sha: 'merge-sha' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/pulls/42/merge');
    expect(global.fetch.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ sha: 'head-sha' });
  });

  test('mergePr(expectBaseSha) without verifyPaths keeps the squash endpoint behind a base re-read', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ state: 'open', base: { ref: 'main', sha: 'base-sha' }, head: { sha: 'head-sha' } }))
      .mockResolvedValueOnce(jsonResponse({ merged: true, sha: 'merge-sha' }));

    await expect(gh.mergePr(42, { sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main' }))
      .resolves.toMatchObject({ merged: true, sha: 'merge-sha' });
    expect(global.fetch.mock.calls[1][0]).toContain('/pulls/42/merge');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toMatchObject({ merge_method: 'squash', sha: 'head-sha' });

    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ state: 'open', base: { ref: 'main', sha: 'moved-sha' }, head: { sha: 'head-sha' } }));
    await expect(gh.mergePr(42, { sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main' }))
      .rejects.toMatchObject({ code: 'BLOG_BASE_MOVED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe('mergePr(expectBaseSha) — atomic base-bound merge via the git data API', () => {
    const openPr = (overrides = {}) => jsonResponse({
      state: 'open',
      base: { ref: 'main', sha: 'base-sha' },
      head: { sha: 'head-sha' },
      mergeable: true,
      merge_commit_sha: 'test-merge-sha',
      ...overrides,
    });
    const testMergeCommit = (overrides = {}) => jsonResponse({
      sha: 'test-merge-sha',
      tree: { sha: 'tree-sha' },
      parents: [{ sha: 'base-sha' }, { sha: 'head-sha' }],
      ...overrides,
    });
    const newCommit = () => jsonResponse({ sha: 'new-merge-commit-sha' });
    const refPatchOk = () => jsonResponse({ object: { sha: 'new-merge-commit-sha' } });

    test('happy path: re-reads the PR, validates the test-merge parents, creates a real merge commit from its tree, and fast-forwards the base ref', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit())
        .mockResolvedValueOnce(newCommit())
        .mockResolvedValueOnce(refPatchOk())
        .mockResolvedValueOnce(openPr());

      const res = await gh.mergePr(42, {
        sha: 'head-sha', title: 'Blog: Title', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      });

      expect(res).toEqual({ sha: 'new-merge-commit-sha', merged: true });
      // post-merge PR re-read only; an unchanged head is left for GitHub to mark merged
      expect(global.fetch).toHaveBeenCalledTimes(5);
      expect(global.fetch.mock.calls[4][0]).toContain('/pulls/42');
      expect(global.fetch.mock.calls[4][1]?.method || 'GET').toBe('GET');
      expect(global.fetch.mock.calls[0][0]).toContain('/pulls/42');
      expect(global.fetch.mock.calls[1][0]).toContain('/git/commits/test-merge-sha');
      expect(global.fetch.mock.calls[2][0]).toContain('/git/commits');
      const commitBody = JSON.parse(global.fetch.mock.calls[2][1].body);
      expect(commitBody).toMatchObject({ tree: 'tree-sha', parents: ['base-sha', 'head-sha'], message: 'Blog: Title' });
      expect(global.fetch.mock.calls[3][0]).toContain('/git/refs/heads/main');
      expect(global.fetch.mock.calls[3][1].method).toBe('PATCH');
      const refBody = JSON.parse(global.fetch.mock.calls[3][1].body);
      expect(refBody).toEqual({ sha: 'new-merge-commit-sha', force: false });
      // never touches the merge endpoint on this path
      expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/pulls/42/merge'))).toBe(false);
    });

    test.each([
      ['base moved', { base: { ref: 'main', sha: 'different-base' } }],
      ['retargeted', { base: { ref: 'release', sha: 'base-sha' } }],
      ['head moved', { head: { sha: 'other-head-sha' } }],
      ['closed', { state: 'closed' }],
      ['mergeable still computing', { mergeable: null }],
      ['conflicting', { mergeable: false, merge_commit_sha: null }],
    ])('fails closed (BLOG_BASE_MOVED) at the PR re-read when %s', async (_label, overrides) => {
      global.fetch = jest.fn().mockResolvedValueOnce(openPr(overrides));

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      })).rejects.toMatchObject({ code: 'BLOG_BASE_MOVED' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('PR unavailable at the re-read fails closed', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => 'application/json' }, text: async () => '' });

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      })).rejects.toMatchObject({ code: 'BLOG_BASE_MOVED' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('stale test-merge commit (parents do not match [base, head]) fails closed', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit({ parents: [{ sha: 'base-sha' }, { sha: 'some-older-head' }] }));

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      })).rejects.toMatchObject({ code: 'BLOG_BASE_MOVED' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('verifyPaths blob mismatch at the test-merge tree fails closed', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit())
        // getFile(path, merge_commit_sha) — blob differs from head
        .mockResolvedValueOnce(jsonResponse({ sha: 'blob-at-merge', path: 'src/content/blog/x.mdx', content: '' }))
        // getFile(path, headSha)
        .mockResolvedValueOnce(jsonResponse({ sha: 'blob-at-head', path: 'src/content/blog/x.mdx', content: '' }));

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main',
        verifyPaths: ['src/content/blog/x.mdx'],
      })).rejects.toMatchObject({ code: 'BLOG_BASE_MOVED' });
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    test('verifyPaths: identical blobs (or both absent) at merge vs head pass through to the merge commit', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit())
        .mockResolvedValueOnce(jsonResponse({ sha: 'same-blob', path: 'src/content/blog/x.mdx', content: '' }))
        .mockResolvedValueOnce(jsonResponse({ sha: 'same-blob', path: 'src/content/blog/x.mdx', content: '' }))
        .mockResolvedValueOnce(newCommit())
        .mockResolvedValueOnce(refPatchOk());

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main',
        verifyPaths: ['src/content/blog/x.mdx'],
      })).resolves.toEqual({ sha: 'new-merge-commit-sha', merged: true });
    });

    test('422 on the ref PATCH (base moved during merge) is converted to BLOG_BASE_MOVED', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit())
        .mockResolvedValueOnce(newCommit())
        .mockResolvedValueOnce({ ok: false, status: 422, headers: { get: () => 'application/json' }, text: async () => 'Update is not a fast forward' })
        // the 422 handler re-reads the ref to rule out a landed retry
        .mockResolvedValueOnce(jsonResponse({ object: { sha: 'someone-elses-commit' } }));

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      })).rejects.toMatchObject({ code: 'BLOG_BASE_MOVED' });
      expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    test('422 on the ref PATCH, but the ref already carries our new commit (an earlier attempt landed): reports success rather than failing', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit())
        .mockResolvedValueOnce(newCommit())
        .mockResolvedValueOnce({ ok: false, status: 422, headers: { get: () => 'application/json' }, text: async () => 'Update is not a fast forward' })
        .mockResolvedValueOnce(jsonResponse({ object: { sha: 'new-merge-commit-sha' } }))
        .mockResolvedValueOnce(openPr());

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      })).resolves.toEqual({ sha: 'new-merge-commit-sha', merged: true });
      expect(global.fetch).toHaveBeenCalledTimes(6);
    });

    test('a push that lands during the merge: reports the verified merge and closes the PR as superseded', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce(openPr())
        .mockResolvedValueOnce(testMergeCommit())
        .mockResolvedValueOnce(newCommit())
        .mockResolvedValueOnce(refPatchOk())
        .mockResolvedValueOnce(openPr({ head: { sha: 'newer-head-sha' } }))
        .mockResolvedValueOnce(jsonResponse({ id: 1 }))
        .mockResolvedValueOnce(jsonResponse({ state: 'closed' }));

      await expect(gh.mergePr(42, {
        sha: 'head-sha', expectBaseSha: 'base-sha', expectBaseRef: 'main', verifyPaths: [],
      })).resolves.toEqual({ sha: 'new-merge-commit-sha', merged: true, headAdvanced: 'newer-head-sha' });
      expect(global.fetch.mock.calls[5][0]).toContain('/issues/42/comments');
      expect(JSON.parse(global.fetch.mock.calls[5][1].body).body).toContain('newer-he');
      expect(global.fetch.mock.calls[6][0]).toContain('/pulls/42');
      expect(JSON.parse(global.fetch.mock.calls[6][1].body)).toEqual({ state: 'closed' });
    });
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

  test('rejects a moved expected head before creating blobs or a commit', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ object: { sha: 'new-head' } }));
    await expect(gh.commitFiles({ branch: 'content/test', message: 'evidence', expectedHeadSha: 'reviewed-head',
      files: [{ path: 'evidence.json', content: '{}' }] })).rejects.toThrow('branch changed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
