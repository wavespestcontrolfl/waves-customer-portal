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
