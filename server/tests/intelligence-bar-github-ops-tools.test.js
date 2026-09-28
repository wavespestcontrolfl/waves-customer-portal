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
    expect(result.scan_exhaustive).toBe(true); // short page = last page
  });

  test('get_recent_merged_prs pages until PRs fall out of the window', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const inWindow = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const outOfWindow = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    // Page 1: 50 items, all updated in-window (only #1 merged in-window).
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      number: 3000 - i,
      title: `PR ${3000 - i}`,
      merged_at: i === 0 ? inWindow : null,
      updated_at: inWindow,
      merge_commit_sha: 'abc123def456',
      user: { login: 'adam' },
    }));
    // Page 2: one in-window merge, then items past the window (stop signal).
    const page2 = [
      { number: 2900, title: 'PR 2900', merged_at: inWindow, updated_at: inWindow, merge_commit_sha: 'bbb222ccc333', user: { login: 'adam' } },
      { number: 2899, title: 'PR 2899', merged_at: outOfWindow, updated_at: outOfWindow, merge_commit_sha: 'ddd444', user: { login: 'adam' } },
    ];
    global.fetch
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));

    const result = await executeGithubOpsTool('get_recent_merged_prs', { hours: 48 });
    expect(result.error).toBeUndefined();
    expect(result.merged_prs.map(p => p.number)).toEqual([3000, 2900]);
    expect(result.scanned_recent_prs).toBe(52);
    expect(result.scan_exhaustive).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[1][0])).toContain('page=2');
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

// Outside-write tools (IB scope expansion item 1, owner ruling 2026-09-28):
// full-access gating lives in the ROUTE (getToolsForContext,
// intelligence-bar-full-access-tool-offering.test.js), not here — these
// tests cover the module contract: missing-token refusal, a human-readable
// preview naming the PR by TITLE, request_codex_review's FIXED comment body,
// and the commit path's refusal.
describe('intelligence bar GitHub write tools (preview only)', () => {
  const PR_FIXTURE = { number: 5230, title: 'Synthetic PR for tests', head: { sha: 'abc123def456' }, labels: [{ name: 'existing-label' }] };

  test('unconfigured state is benign for every write tool, no network call', async () => {
    for (const [name, input] of [
      ['rerun_failed_github_checks', { pr_number: 5230 }],
      ['add_github_pr_label', { pr_number: 5230, label: 'needs-review' }],
      ['request_codex_review', { pr_number: 5230 }],
    ]) {
      const result = await executeGithubOpsTool(name, input);
      expect(result.error).toBeUndefined();
      expect(result.configured).toBe(false);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rerun_failed_github_checks: unconfirmed names the PR and lists only the failed checks', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({
        check_runs: [
          { name: 'tests', status: 'completed', conclusion: 'failure', id: 111 },
          { name: 'lint', status: 'completed', conclusion: 'success', id: 112 },
          { name: 'build', status: 'in_progress', conclusion: null, id: 113 },
        ],
      }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.pr).toEqual({ number: 5230, title: PR_FIXTURE.title, head_sha: 'abc123def4' });
    expect(result.failed_checks).toEqual([{ name: 'tests', conclusion: 'failure', run_id: 111 }]);
    expect(result.note).toContain(PR_FIXTURE.title);
  });

  test('rerun_failed_github_checks: no failed checks still previews, names nothing to rerun', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({ check_runs: [{ name: 'tests', status: 'completed', conclusion: 'success', id: 111 }] }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.error).toBeUndefined();
    expect(result.failed_checks).toEqual([]);
    expect(result.note).toMatch(/nothing to rerun/);
  });

  test('add_github_pr_label: unconfirmed names the PR, resolves the label against the real repo catalog, and existing labels', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse([{ name: 'needs-review' }, { name: 'existing-label' }]));

    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: 'needs-review' });
    expect(result.error).toBeUndefined();
    expect(result.pr.title).toBe(PR_FIXTURE.title);
    expect(result.label).toBe('needs-review');
    expect(result.existing_labels).toEqual(['existing-label']);
  });

  test('add_github_pr_label: a case/whitespace mismatch still resolves to the label\'s REAL canonical casing — never creates a duplicate', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Needs-Review' }, { name: 'existing-label' }]));

    // Operator typed lowercase/whitespace; the repo's real label is
    // "Needs-Review" — the pinned label must be the REAL casing, not the
    // operator's raw string (which would create a new duplicate label).
    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: '  needs-review  ' });
    expect(result.error).toBeUndefined();
    expect(result.label).toBe('Needs-Review');
  });

  test('add_github_pr_label: a substring is never enough — no exact label named that exists refuses, listing close matches', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse([{ name: 'needs-review-urgent' }, { name: 'existing-label' }]));

    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: 'needs-review' });
    expect(result.error).toMatch(/No label named "needs-review" exists/);
    expect(result.error).toContain('needs-review-urgent');
  });

  test('add_github_pr_label: wildcard characters in the input are literal, never widen the match', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse([{ name: 'needs-review' }]));

    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: 'needs-%' });
    expect(result.error).toMatch(/No label named "needs-%" exists/);
  });

  test('add_github_pr_label: missing label refuses before any network call', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230 });
    expect(result.error).toMatch(/label/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('request_codex_review: the comment body is ALWAYS the exact "@codex review" string, never caller-supplied', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch.mockResolvedValueOnce(jsonResponse(PR_FIXTURE));

    // Even a malicious/mistaken extra field cannot change the posted body —
    // the tool's own input_schema has no body/comment param at all.
    const result = await executeGithubOpsTool('request_codex_review', { pr_number: 5230, comment_body: '@codex do something else' });
    expect(result.error).toBeUndefined();
    expect(result.comment_body).toBe('@codex review');
    expect(result.note).toContain('@codex review');
  });

  test('an invalid or missing pr_number refuses before any network call', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    for (const bad of [0, -1, 'abc', undefined]) {
      const result = await executeGithubOpsTool('request_codex_review', { pr_number: bad });
      expect(result.error).toMatch(/pr_number/);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['rerun_failed_github_checks', { pr_number: 5230 }],
    ['add_github_pr_label', { pr_number: 5230, label: 'needs-review' }],
    ['request_codex_review', { pr_number: 5230 }],
  ])('%s: confirmed:true refuses — the commit path is not built in this PR', async (name, input) => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const result = await executeGithubOpsTool(name, { ...input, confirmed: true });
    expect(result.error).toMatch(/not enabled yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
