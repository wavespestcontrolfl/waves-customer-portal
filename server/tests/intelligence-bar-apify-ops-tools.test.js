/**
 * Apify account ops tool — unit tests with a mocked Apify API.
 * Read-only contract: benign dark state, usage/limit extraction, failed-run
 * counting, failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['APIFY_API_TOKEN', 'APIFY_API_BASE'];
const savedEnv = {};
let executeApifyOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeApifyOpsTool } = require('../services/intelligence-bar/apify-ops-tools'));
});

describe('intelligence bar Apify ops tool', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeApifyOpsTool('get_apify_status');
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/APIFY_API_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.APIFY_API_TOKEN = 'apify_token';
    const result = await executeApifyOpsTool('run_actor');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('maps usage vs limit and counts failed recent runs', async () => {
    process.env.APIFY_API_TOKEN = 'apify_token';
    global.fetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v2/users/me/limits')) {
        return Promise.resolve(jsonResponse({
          data: { current: { monthlyUsageUsd: 3.72 }, limits: { maxMonthlyUsageUsd: 5 } },
        }));
      }
      return Promise.resolve(jsonResponse({
        data: {
          items: [
            { actId: 'scraper1', status: 'SUCCEEDED', startedAt: '2026-07-17T06:00:00Z', finishedAt: '2026-07-17T06:04:00Z', usageTotalUsd: 0.12 },
            { actId: 'scraper1', status: 'FAILED', startedAt: '2026-07-16T06:00:00Z', finishedAt: '2026-07-16T06:01:00Z', usageTotalUsd: 0.02 },
            { actId: 'scraper2', status: 'RUNNING', startedAt: '2026-07-17T19:00:00Z', finishedAt: null, usageTotalUsd: null },
          ],
        },
      }));
    });

    const result = await executeApifyOpsTool('get_apify_status');
    expect(result.error).toBeUndefined();
    expect(result.monthly_usage_usd).toBe(3.72);
    expect(result.monthly_usage_limit_usd).toBe(5);
    expect(result.recent_runs).toHaveLength(3);
    // RUNNING and SUCCEEDED are healthy; only FAILED counts
    expect(result.failed_recent).toBe(1);
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.APIFY_API_TOKEN = 'bad';
    global.fetch.mockResolvedValue(jsonResponse({}, 401));
    const result = await executeApifyOpsTool('get_apify_status');
    expect(result.error).toMatch(/rejected the token/);
  });
});
