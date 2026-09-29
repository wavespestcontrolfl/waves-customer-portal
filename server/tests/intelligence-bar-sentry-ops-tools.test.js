/**
 * Sentry ops tools — unit tests with a mocked Sentry API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), issue mapping, truncation, and that every
 * failure surfaces as { error } instead of throwing into the route loop.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SENTRY_ENV_KEYS = ['SENTRY_API_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_API_BASE'];

const savedEnv = {};
let executeSentryOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const issueFixture = {
  id: '111',
  shortId: 'WAVES-PORTAL-1A',
  title: 'TypeError: cannot read properties of undefined',
  culprit: 'server/routes/admin-schedule.js in completeVisit',
  level: 'error',
  count: '42',
  userCount: 3,
  firstSeen: '2026-07-10T00:00:00Z',
  lastSeen: '2026-07-11T12:00:00Z',
  permalink: 'https://sentry.io/organizations/waves/issues/111/',
};

const memberFixture = {
  id: 'member-1',
  email: 'adam@wavespestcontrol.com',
  name: 'Adam Benetti',
  user: { id: 'user-1', username: 'adam', name: 'Adam Benetti', email: 'adam@wavespestcontrol.com' },
};

beforeAll(() => {
  for (const key of SENTRY_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of SENTRY_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of SENTRY_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeSentryOpsTool } = require('../services/intelligence-bar/sentry-ops-tools'));
});

describe('intelligence bar Sentry ops tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeSentryOpsTool('get_sentry_top_issues', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/SENTRY_API_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    const result = await executeSentryOpsTool('resolve_issue', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_sentry_top_issues maps issues and clamps the window', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([issueFixture]));

    const result = await executeSentryOpsTool('get_sentry_top_issues', { hours: 99999, limit: 5 });
    expect(result.error).toBeUndefined();
    expect(result.window_hours).toBe(336); // clamped to the 14-day ceiling
    expect(result.issues).toEqual([{
      short_id: 'WAVES-PORTAL-1A',
      title: issueFixture.title,
      culprit: issueFixture.culprit,
      level: 'error',
      events: 42,
      users_affected: 3,
      first_seen: issueFixture.firstSeen,
      last_seen: issueFixture.lastSeen,
      link: issueFixture.permalink,
    }]);

    const calledUrl = String(global.fetch.mock.calls[0][0]);
    expect(calledUrl).toContain('sort=freq');
    expect(calledUrl).toContain('is%3Aunresolved');
  });

  test('get_sentry_new_issues queries by age', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([]));

    const result = await executeSentryOpsTool('get_sentry_new_issues', { hours: 12 });
    expect(result.error).toBeUndefined();
    expect(result.first_seen_within_hours).toBe(12);
    const calledUrl = decodeURIComponent(String(global.fetch.mock.calls[0][0]));
    expect(calledUrl).toContain('age:-12h');
  });

  test('get_sentry_issue_detail returns exception summary with capped frames', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    const frames = Array.from({ length: 12 }, (_, i) => ({
      function: `fn${i}`, module: `mod${i}`, lineNo: i,
    }));
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse({
        message: 'boom',
        entries: [{ type: 'exception', data: { values: [{ type: 'TypeError', value: 'x'.repeat(500), stacktrace: { frames } }] } }],
      }));

    const result = await executeSentryOpsTool('get_sentry_issue_detail', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toBeUndefined();
    // Short ids only resolve via shortIdLookup with the bare id as the query.
    const lookupUrl = decodeURIComponent(String(global.fetch.mock.calls[0][0]));
    expect(lookupUrl).toContain('query=WAVES-PORTAL-1A');
    expect(lookupUrl).toContain('shortIdLookup=1');
    expect(result.latest_event.exception_type).toBe('TypeError');
    expect(result.latest_event.exception_value).toMatch(/…\[truncated\]$/);
    expect(result.latest_event.innermost_frames).toHaveLength(5);
    // Innermost = tail of Sentry's frame ordering.
    expect(result.latest_event.innermost_frames[4].function).toBe('fn11');
  });

  test('get_sentry_issue_detail without a short id returns an error result', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    const result = await executeSentryOpsTool('get_sentry_issue_detail', {});
    expect(result.error).toMatch(/issue_short_id/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('auth rejection surfaces a scope hint as { error }, never a throw', async () => {
    process.env.SENTRY_API_TOKEN = 'bad-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 403));

    const result = await executeSentryOpsTool('get_sentry_top_issues', {});
    expect(result.error).toMatch(/SENTRY_API_TOKEN scope/);
  });
});

// Outside-write tools (IB scope expansion item 1, owner ruling 2026-09-28):
// full-access gating lives in the ROUTE (getToolsForContext,
// intelligence-bar-full-access-tool-offering.test.js), not here — these
// tests cover the module contract: missing-token refusal, a human-readable
// preview naming the issue by TITLE, and the commit path's refusal.
describe('intelligence bar Sentry write tools (preview only)', () => {
  test('unconfigured state is benign for every write tool, no network call', async () => {
    for (const name of ['resolve_sentry_issue', 'ignore_sentry_issue', 'assign_sentry_issue']) {
      const result = await executeSentryOpsTool(name, { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' });
      expect(result.error).toBeUndefined();
      expect(result.configured).toBe(false);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('resolve_sentry_issue: unconfirmed builds a preview naming the issue by title and its pinned internal id, never resolves', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([issueFixture]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.action).toBe('Resolve');
    expect(result.issue.short_id).toBe('WAVES-PORTAL-1A');
    expect(result.issue.title).toBe(issueFixture.title);
    // The pinned canonical internal id, not just the display short id.
    expect(result.issue.id).toBe(issueFixture.id);
    expect(result.note).toContain(issueFixture.title);
  });

  test('the write preview fingerprint ignores live issue counters, so an active issue can still be confirmed', async () => {
    const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([issueFixture]));
    const before = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    global.fetch.mockResolvedValueOnce(jsonResponse([{ ...issueFixture, count: '999', userCount: 77, lastSeen: '2099-01-01T00:00:00Z' }]));
    const after = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(after.issue).not.toHaveProperty('events');
    expect(after.issue).not.toHaveProperty('users_affected');
    expect(previewFingerprint(after)).toBe(previewFingerprint(before));
  });

  test('resolve_sentry_issue: binds the current (stable) status into the preview', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([{ ...issueFixture, status: 'unresolved' }]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toBeUndefined();
    expect(result.issue.status).toBe('unresolved');
  });

  // Codex r3 P2 on #5275: resolve/ignore on an issue already in that state
  // would propose a card that could only report success without changing
  // anything — refuse it like the other no-op writes in this PR.
  test('resolve_sentry_issue: refuses as a no-op when the issue is already resolved, never a preview/card', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([{ ...issueFixture, status: 'resolved' }]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_resolved');
    expect(result.error).toContain(issueFixture.title);
    expect(result.error).toContain('already resolved');
  });

  test('ignore_sentry_issue: refuses as a no-op when the issue is already ignored, never a preview/card', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([{ ...issueFixture, status: 'ignored' }]));

    const result = await executeSentryOpsTool('ignore_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_ignored');
    expect(result.error).toContain('already ignored');
  });

  // An ignored issue is still an eligible RESOLVE target (and vice versa) —
  // the no-op check is scoped to the exact matching status, not "not
  // unresolved".
  test('resolve_sentry_issue: an ignored (not resolved) issue is a real transition, not a no-op', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([{ ...issueFixture, status: 'ignored' }]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.issue.status).toBe('ignored');
  });

  test('resolve_sentry_issue: a mixed-case / whitespace short id still resolves the exact issue', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([issueFixture]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: '  waves-portal-1a  ' });
    expect(result.error).toBeUndefined();
    expect(result.issue.short_id).toBe('WAVES-PORTAL-1A');
  });

  test('resolve_sentry_issue: shortIdLookup falling back to a fuzzy text-search hit is refused, never trusted as a match', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    // Simulates Sentry's shortIdLookup silently degrading to a full-text
    // search: the query didn't resolve to the real short id, but the API
    // still returned SOME issue (an unrelated one whose title/message
    // happens to contain the query text) instead of erroring.
    global.fetch.mockResolvedValueOnce(jsonResponse([{ ...issueFixture, shortId: 'WAVES-PORTAL-9Z' }]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toMatch(/No Sentry issue found for short id "WAVES-PORTAL-1A"/);
  });

  test('ignore_sentry_issue: unconfirmed names the issue too', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([issueFixture]));

    const result = await executeSentryOpsTool('ignore_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('Ignore');
    expect(result.issue.short_id).toBe('WAVES-PORTAL-1A');
  });

  test('assign_sentry_issue: unconfirmed resolves the assignee against the real org roster by email, pins id + display name, never the email', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'Adam@WavesPestControl.com' });
    expect(result.error).toBeUndefined();
    expect(result.assignee).toEqual({ id: 'user-1', name: 'Adam Benetti' });
    expect(result.note).toContain('Adam Benetti');
    // The account email must never ride into the preview surface at all.
    expect(JSON.stringify(result)).not.toContain('adam@wavespestcontrol.com');
  });

  test('assign_sentry_issue: also resolves by exact Sentry username', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' });
    expect(result.error).toBeUndefined();
    expect(result.assignee).toEqual({ id: 'user-1', name: 'Adam Benetti' });
  });

  test('assign_sentry_issue: also resolves by exact display name', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'Adam Benetti' });
    expect(result.error).toBeUndefined();
    expect(result.assignee).toEqual({ id: 'user-1', name: 'Adam Benetti' });
  });

  test('assign_sentry_issue: no matching org member refuses without ever echoing the operator\'s input', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'nobody@wavespestcontrol.com' });
    expect(result.error).toMatch(/No Sentry org member matches/);
    expect(result.error).not.toContain('nobody@wavespestcontrol.com');
    expect(result.assignee).toBeUndefined();
  });

  test('assign_sentry_issue: several matching org members refuses, never an arbitrary pick', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse([
        memberFixture,
        { id: 'member-2', email: 'adam2@wavespestcontrol.com', name: 'Adam Benetti', user: { id: 'user-2', username: 'adam2', name: 'Adam Benetti' } },
      ]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'Adam Benetti' });
    expect(result.error).toMatch(/More than one Sentry org member matches/);
    expect(result.assignee).toBeUndefined();
  });

  // Codex r3 P2 on #5275: assigning to the CURRENT assignee would propose a
  // card that could only report success without changing anything.
  test('assign_sentry_issue: refuses as a no-op when already assigned to the resolved member, never a preview/card', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([{ ...issueFixture, assignedTo: { type: 'user', id: 'user-1', name: 'Adam Benetti' } }]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_assigned');
    expect(result.error).toContain('Adam Benetti');
    expect(result.assignee).toBeUndefined();
  });

  test('assign_sentry_issue: a real reassignment binds the CURRENT (stable) assignee into the preview, id + name only, never email', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([{ ...issueFixture, assignedTo: { type: 'user', id: 'user-2', name: 'Virginia', email: 'virginia@wavespestcontrol.com' } }]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.assignee).toEqual({ id: 'user-1', name: 'Adam Benetti' });
    expect(result.current_assignee).toEqual({ id: 'user-2', name: 'Virginia' });
    expect(JSON.stringify(result)).not.toContain('virginia@wavespestcontrol.com');
  });

  test('assign_sentry_issue: current_assignee is null when the issue is currently unassigned', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([issueFixture]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' });
    expect(result.error).toBeUndefined();
    expect(result.current_assignee).toBeNull();
  });

  test('assign_sentry_issue: current_assignee is null when currently assigned to a TEAM, not a person', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse([{ ...issueFixture, assignedTo: { type: 'team', id: 'team-1', name: 'Backend' } }]))
      .mockResolvedValueOnce(jsonResponse([memberFixture]));

    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' });
    expect(result.error).toBeUndefined();
    expect(result.current_assignee).toBeNull();
  });

  test('assign_sentry_issue: missing assignee refuses before any network call', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    const result = await executeSentryOpsTool('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' });
    expect(result.error).toMatch(/assignee/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown short id returns an error result, no confirm', async () => {
    process.env.SENTRY_API_TOKEN = 'sentry-token';
    global.fetch.mockResolvedValueOnce(jsonResponse([]));

    const result = await executeSentryOpsTool('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-9Z' });
    expect(result.error).toMatch(/No Sentry issue found/);
  });

  test.each(['resolve_sentry_issue', 'ignore_sentry_issue', 'assign_sentry_issue'])(
    '%s: confirmed:true refuses — the commit path is not built in this PR',
    async (name) => {
      process.env.SENTRY_API_TOKEN = 'sentry-token';
      const result = await executeSentryOpsTool(name, { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam', confirmed: true });
      expect(result.error).toMatch(/not enabled yet/);
      expect(result.code).toBe('not_yet_implemented');
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
});
