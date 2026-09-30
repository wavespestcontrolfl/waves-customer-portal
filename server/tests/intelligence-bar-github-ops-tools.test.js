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
describe('intelligence bar GitHub write tools (preview)', () => {
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

  test('rerun_failed_github_checks: unconfirmed names the PR and pins the failed WORKFLOW RUN id (never a check-run id)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({
        check_runs: [
          { name: 'tests', status: 'completed', conclusion: 'failure', id: 111, app: { slug: 'github-actions' } },
          { name: 'lint', status: 'completed', conclusion: 'success', id: 112, app: { slug: 'github-actions' } },
          { name: 'build', status: 'in_progress', conclusion: null, id: 113, app: { slug: 'github-actions' } },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        workflow_runs: [
          { id: 999888, name: 'CI', status: 'completed', conclusion: 'failure' },
          { id: 999889, name: 'Lint', status: 'completed', conclusion: 'success' },
        ],
      }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.pr).toEqual({ number: 5230, title: PR_FIXTURE.title, head_sha: 'abc123def4' });
    // The WORKFLOW-RUN id (999888), never the check-run id (111) — that's
    // what /actions/runs/{run_id}/rerun-failed-jobs actually takes.
    expect(result.workflow_runs).toEqual([{ id: 999888, name: 'CI', conclusion: 'failure' }]);
    expect(result.non_actions_failed_checks).toBeUndefined();
    expect(result.note).toContain(PR_FIXTURE.title);
    expect(result.note).toContain('CI');
    // The actions/runs call is scoped to this exact head sha.
    const runsCallUrl = new URL(global.fetch.mock.calls[2][0]);
    expect(runsCallUrl.pathname).toBe('/repos/wavespestcontrolfl/waves-customer-portal/actions/runs');
    expect(runsCallUrl.searchParams.get('head_sha')).toBe('abc123def456');
  });

  test('rerun_failed_github_checks: a failed check can span several workflow runs — every failed run is pinned', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({
        check_runs: [
          { name: 'tests', status: 'completed', conclusion: 'failure', id: 111, app: { slug: 'github-actions' } },
          { name: 'deploy-preview', status: 'completed', conclusion: 'failure', id: 222, app: { slug: 'github-actions' } },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        workflow_runs: [
          { id: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
          { id: 2, name: 'Preview Deploy', status: 'completed', conclusion: 'failure' },
        ],
      }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.error).toBeUndefined();
    expect(result.workflow_runs).toEqual([
      { id: 1, name: 'CI', conclusion: 'failure' },
      { id: 2, name: 'Preview Deploy', conclusion: 'failure' },
    ]);
  });

  test('rerun_failed_github_checks: a failed check from a non-Actions app cannot be rerun from here', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({
        check_runs: [
          { name: 'codecov/patch', status: 'completed', conclusion: 'failure', id: 333, app: { slug: 'codecov' } },
        ],
      }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('no_rerunnable_checks');
    expect(result.error).toContain('codecov/patch');
    expect(result.error).toContain("can't be rerun from here");
    // No /actions/runs call at all — nothing Actions-backed to resolve.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('rerun_failed_github_checks: a mix of an Actions failure and a non-Actions failure pins the rerunnable run and lists the rest separately', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({
        check_runs: [
          { name: 'tests', status: 'completed', conclusion: 'failure', id: 111, app: { slug: 'github-actions' } },
          { name: 'codecov/patch', status: 'completed', conclusion: 'failure', id: 333, app: { slug: 'codecov' } },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        workflow_runs: [{ id: 999888, name: 'CI', status: 'completed', conclusion: 'failure' }],
      }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.error).toBeUndefined();
    expect(result.workflow_runs).toEqual([{ id: 999888, name: 'CI', conclusion: 'failure' }]);
    expect(result.non_actions_failed_checks).toEqual([{ name: 'codecov/patch', conclusion: 'failure' }]);
    expect(result.note).toContain('codecov/patch');
    expect(result.note).toContain('cannot be rerun from here');
  });

  test('rerun_failed_github_checks: no failed checks refuses as a no-op, never a preview/card', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse({ check_runs: [{ name: 'tests', status: 'completed', conclusion: 'success', id: 111 }] }));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('no_failed_checks');
    expect(result.error).toMatch(/nothing to rerun/);
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

  test('add_github_pr_label: label already on the PR refuses as a no-op, never a preview/card', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    // PR_FIXTURE.labels already carries 'existing-label'.
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse([{ name: 'existing-label' }]));

    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: 'existing-label' });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('label_already_present');
    expect(result.error).toMatch(/already has the "existing-label" label/);
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
});

describe('intelligence bar GitHub write tools (confirmed commit)', () => {
  const { outsideWritePins } = require('../services/intelligence-bar/outside-write-pins');
  const PR_FIXTURE = { number: 5230, title: 'Synthetic PR for tests', head: { sha: 'abc123def456' }, labels: [{ name: 'existing-label' }] };
  const FULL_SHA = 'abc123def456aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const rerunPreviewResponses = () => [
    jsonResponse(PR_FIXTURE),
    jsonResponse({ check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', id: 111, app: { slug: 'github-actions' } }] }),
    jsonResponse({ workflow_runs: [
      { id: 999888, name: 'CI', status: 'completed', conclusion: 'failure' },
      { id: 999890, name: 'Lint', status: 'completed', conclusion: 'timed_out' },
    ] }),
  ];
  const runResponse = (over = {}) => jsonResponse({ id: 1, head_sha: FULL_SHA, status: 'completed', conclusion: 'failure', ...over });

  async function rerunPins() {
    process.env.GITHUB_TOKEN = 'ghp_x';
    rerunPreviewResponses().forEach((r) => global.fetch.mockResolvedValueOnce(r));
    const preview = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230 });
    global.fetch.mockClear();
    return outsideWritePins('rerun_failed_github_checks', preview);
  }

  test('rerun_failed_github_checks: confirm reruns the failed jobs of EVERY pinned workflow run (and only those)', async () => {
    const pins = await rerunPins();
    expect(pins).toEqual({ _verified_github_pr_number: 5230, _verified_github_head_sha: 'abc123def4', _verified_github_run_ids: ['999888', '999890'] });
    global.fetch
      .mockResolvedValueOnce(runResponse()).mockResolvedValueOnce(runResponse({ conclusion: 'timed_out' }))
      .mockResolvedValueOnce(jsonResponse({}, 201)).mockResolvedValueOnce(jsonResponse({}, 201));

    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 9999, ...pins, confirmed: true });
    expect(result).toEqual({ success: true, tool: 'rerun_failed_github_checks', pr_number: 5230, rerun_run_ids: ['999888', '999890'] });
    const posts = global.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => new URL(url).pathname)).toEqual([
      '/repos/wavespestcontrolfl/waves-customer-portal/actions/runs/999888/rerun-failed-jobs',
      '/repos/wavespestcontrolfl/waves-customer-portal/actions/runs/999890/rerun-failed-jobs',
    ]);
  });

  test.each([
    ['a new commit moved the run off the approved head', { head_sha: 'ffffffffffffffffffffffffffffffffffffffff' }],
    ['the run was already rerun (in progress)', { status: 'in_progress', conclusion: null }],
    ['the run now passes', { conclusion: 'success' }],
  ])('rerun_failed_github_checks: %s -> refused as target-changed, no rerun POST sent', async (_label, over) => {
    const pins = await rerunPins();
    global.fetch.mockResolvedValueOnce(runResponse(over));
    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230, ...pins, confirmed: true });
    expect(result.code).toBe('target_changed');
    expect(result.preview_changed).toBe(true);
    expect(global.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  test('rerun_failed_github_checks: a half-applied rerun is reported as partial, never a clean failure', async () => {
    const pins = await rerunPins();
    global.fetch
      .mockResolvedValueOnce(runResponse()).mockResolvedValueOnce(runResponse())
      .mockResolvedValueOnce(jsonResponse({}, 201)).mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500));
    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230, ...pins, confirmed: true });
    expect(result.partial).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.rerun_run_ids).toEqual(['999888']);
    expect(result.warning).toMatch(/Reran 1 of 2/);
  });

  test('add_github_pr_label: confirm adds the PINNED canonical label to the PINNED PR', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(PR_FIXTURE))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Needs-Review' }]));
    const preview = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: ' needs-review ' });
    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce(jsonResponse([{ name: 'Needs-Review' }]));

    const pins = outsideWritePins('add_github_pr_label', preview);
    expect(pins).toEqual({ _verified_github_pr_number: 5230, _verified_github_label: 'Needs-Review' });
    const result = await executeGithubOpsTool('add_github_pr_label', { pr_number: 1, label: 'blocked', ...pins, confirmed: true });
    expect(result).toEqual({ success: true, tool: 'add_github_pr_label', pr_number: 5230, label: 'Needs-Review' });
    const [url, init] = global.fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/repos/wavespestcontrolfl/waves-customer-portal/issues/5230/labels');
    expect(JSON.parse(init.body)).toEqual({ labels: ['Needs-Review'] });
  });

  test('request_codex_review: confirm posts EXACTLY "@codex review" to the PINNED PR, whatever else is passed', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch.mockResolvedValueOnce(jsonResponse(PR_FIXTURE));
    const preview = await executeGithubOpsTool('request_codex_review', { pr_number: 5230 });
    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    const pins = outsideWritePins('request_codex_review', preview);
    const result = await executeGithubOpsTool('request_codex_review', { pr_number: 1, comment_body: '@codex do something else', body: 'x', ...pins, confirmed: true });
    expect(result).toEqual({ success: true, tool: 'request_codex_review', pr_number: 5230 });
    const [url, init] = global.fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/repos/wavespestcontrolfl/waves-customer-portal/issues/5230/comments');
    expect(JSON.parse(init.body)).toEqual({ body: '@codex review' });
  });

  test.each([
    ['rerun_failed_github_checks', { pr_number: 5230 }],
    ['add_github_pr_label', { pr_number: 5230, label: 'needs-review' }],
    ['request_codex_review', { pr_number: 5230 }],
  ])('%s: confirmed without a verified pin refuses and never calls GitHub', async (name, input) => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    const result = await executeGithubOpsTool(name, { ...input, confirmed: true });
    expect(result.code).toBe('missing_verified_pin');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([401, 403])('a read-only PAT (HTTP %i) returns a clear write-access result and changes nothing', async (status) => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({ message: 'Resource not accessible by personal access token' }, status));
    const result = await executeGithubOpsTool('request_codex_review', { pr_number: 5230, _verified_github_pr_number: 5230, confirmed: true });
    expect(result.code).toBe('write_access_required');
    expect(result.error).toMatch(/needs write access/);
    expect(result.success).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a rate-limit 403 is NOT reported as a permission problem', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({ message: 'API rate limit exceeded for user' }, 403));
    const result = await executeGithubOpsTool('add_github_pr_label', {
      pr_number: 5230, label: 'x', _verified_github_pr_number: 5230, _verified_github_label: 'x', confirmed: true,
    });
    expect(result.code).toBeUndefined();
    expect(result.error).toMatch(/rate limit/i);
  });

  test('rerun_failed_github_checks: a read-only PAT on the FIRST rerun POST is a clean write-access failure', async () => {
    const pins = await rerunPins();
    global.fetch
      .mockResolvedValueOnce(runResponse()).mockResolvedValueOnce(runResponse())
      .mockResolvedValueOnce(jsonResponse({ message: 'Resource not accessible by personal access token' }, 403));
    const result = await executeGithubOpsTool('rerun_failed_github_checks', { pr_number: 5230, ...pins, confirmed: true });
    expect(result.code).toBe('write_access_required');
    expect(result.partial).toBeUndefined();
  });

  test('the write failure log carries status only — no PR title or token', async () => {
    const logger = require('../services/logger');
    process.env.GITHUB_TOKEN = 'ghp_secret_token';
    global.fetch.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 403));
    await executeGithubOpsTool('request_codex_review', { pr_number: 5230, _verified_github_pr_number: 5230, confirmed: true });
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('status=403');
    expect(logged).not.toContain('ghp_secret_token');
  });
});

// Codex r4 on #5275: a rejected label (model-supplied text that may carry a
// customer name) reaches the operator but never the module logger.
test('a rejected label name never reaches the error log', async () => {
  const logger = require('../services/logger');
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'gh-token';
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ number: 5230, title: 'Synthetic PR', head: { sha: 'abc' }, labels: [] }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([{ name: 'needs-review' }]) });
  const { executeGithubOpsTool } = require('../services/intelligence-bar/github-ops-tools');
  const out = await executeGithubOpsTool('add_github_pr_label', { pr_number: 5230, label: 'Synthia Tester' });
  expect(out.error).toMatch(/Synthia Tester/);
  expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/Synthia Tester/);
});

