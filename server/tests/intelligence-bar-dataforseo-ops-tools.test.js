/**
 * DataForSEO account ops tool — unit tests with a mocked API.
 * Read-only contract: benign dark state, balance extraction, failures as
 * { error }. Deliberately does NOT go through services/seo/dataforseo.js —
 * the balance read must work with the seoIntelligence gate off.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'DATAFORSEO_API_BASE'];
const savedEnv = {};
let executeDataforseoOpsTool;

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
  ({ executeDataforseoOpsTool } = require('../services/intelligence-bar/dataforseo-ops-tools'));
});

describe('intelligence bar DataForSEO ops tool', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeDataforseoOpsTool('get_dataforseo_balance');
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/DATAFORSEO_LOGIN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.DATAFORSEO_LOGIN = 'user';
    process.env.DATAFORSEO_PASSWORD = 'pass';
    const result = await executeDataforseoOpsTool('post_serp_task');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('extracts balance, total spend, and daily limits', async () => {
    process.env.DATAFORSEO_LOGIN = 'user';
    process.env.DATAFORSEO_PASSWORD = 'pass';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      tasks: [{
        result: [{
          money: { balance: 42.5, total: 310.75 },
          limits: { day: { total_tasks: 2000 } },
        }],
      }],
    }));

    const result = await executeDataforseoOpsTool('get_dataforseo_balance');
    expect(result.error).toBeUndefined();
    expect(result.balance).toBe(42.5);
    expect(result.total_spent).toBe(310.75);
    expect(result.rates_limits).toEqual({ total_tasks: 2000 });
    expect(String(global.fetch.mock.calls[0][0])).toContain('/v3/appendix/user_data');
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.DATAFORSEO_LOGIN = 'user';
    process.env.DATAFORSEO_PASSWORD = 'bad';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));
    const result = await executeDataforseoOpsTool('get_dataforseo_balance');
    expect(result.error).toMatch(/rejected the credentials/);
  });

  test('empty result body surfaces as { error }', async () => {
    process.env.DATAFORSEO_LOGIN = 'user';
    process.env.DATAFORSEO_PASSWORD = 'pass';
    global.fetch.mockResolvedValueOnce(jsonResponse({ tasks: [] }));
    const result = await executeDataforseoOpsTool('get_dataforseo_balance');
    expect(result.error).toMatch(/no account data/);
  });
});
