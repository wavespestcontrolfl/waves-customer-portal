/**
 * GitHub deploy-provenance ops tools — unit tests with a mocked GitHub API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), merged-PR windowing, SHA validation, the
 * fine-grained-PAT 404 hint, and that every failure surfaces as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const GITHUB_ENV_KEYS = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_PORTAL_REPO', 'GITHUB_API_BASE'];

const savedEnv = {};
let executeGithubOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of GITHUB_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of GITHUB_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of GITHUB_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeGithubOpsTool } = require('../services/intelligence-bar/github-ops-tools'));
});

describe('intelligence bar GitHub ops tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeGithubOpsTool('get_recent_merged_prs', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/GITHUB_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const result = await executeGithubOpsTool('merge_pr', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_recent_merged_prs keeps only PRs merged inside the window, newest first', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const newer = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    global.fetch.mockResolvedValueOnce(jsonResponse([
      { number: 2626, title: 'Referral credit fix', merged_at: recent, merge_commit_sha: '64c92ace6dabcdef', user: { login: 'adam' } },
      { number: 2620, title: 'Closed without merging', merged_at: null, merge_commit_sha: null, user: { login: 'adam' } },
      { number: 2601, title: 'Old merge', merged_at: stale, merge_commit_sha: 'aaaa', user: { login: 'adam' } },
      { number: 2629, title: 'Flea automation', merged_at: newer, merge_commit_sha: 'f815af2ddc999999', user: { login: 'adam' } },
    ]));

    const result = await executeGithubOpsTool('get_recent_merged_prs', { hours: 48 });
    expect(result.error).toBeUndefined();
    expect(result.merged_prs.map(p => p.number)).toEqual([2629, 2626]);
    expect(result.merged_prs[0].merge_commit_sha).toBe('f815af2ddc');
    expect(result.repo).toBe('wavespestcontrolfl/waves-customer-portal');
  });

  test('get_commit_info validates the sha before any network call', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const result = await executeGithubOpsTool('get_commit_info', { sha: 'not-a-sha!' });
    expect(result.error).toMatch(/hex commit SHA/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('get_commit_info returns the first message line and change stats', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      sha: '64c92ace6d1234567890',
      commit: { message: 'Fix referral credit (#2626)\n\nLong body here', author: { name: 'Adam', date: '2026-07-11T12:00:00Z' } },
      files: [{}, {}, {}],
      stats: { additions: 40, deletions: 12 },
    }));

    const result = await executeGithubOpsTool('get_commit_info', { sha: '64c92ace6d' });
    expect(result.error).toBeUndefined();
    expect(result.sha).toBe('64c92ace6d');
    expect(result.message).toBe('Fix referral credit (#2626)');
    expect(result.files_changed).toBe(3);
    expect(result.additions).toBe(40);
  });

  test('a 404 (fine-grained PAT without repo access) surfaces the PAT hint as { error }', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));

    const result = await executeGithubOpsTool('get_recent_merged_prs', {});
    expect(result.error).toMatch(/PAT may not grant read access/);
  });
});
