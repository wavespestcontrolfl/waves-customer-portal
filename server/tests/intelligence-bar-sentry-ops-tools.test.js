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
