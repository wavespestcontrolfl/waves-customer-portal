/**
 * Managed Agents ops tool — unit tests with a mocked Anthropic API.
 * Read-only contract: benign dark state, session mapping with agent
 * labeling from env ids, status rollup, title truncation, beta header on
 * the request, failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_BASE', 'BI_AGENT_ID', 'LEAD_AGENT_ID'];
const savedEnv = {};
let executeManagedAgentsOpsTool;

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
  ({ executeManagedAgentsOpsTool } = require('../services/intelligence-bar/managed-agents-ops-tools'));
});

describe('intelligence bar managed agents ops tool', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeManagedAgentsOpsTool('get_managed_agent_runs', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    const result = await executeManagedAgentsOpsTool('create_agent_session', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('maps sessions, labels known agents, rolls up statuses, and sends the beta header', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    process.env.BI_AGENT_ID = 'agent_bi_1';
    process.env.LEAD_AGENT_ID = 'agent_lead_1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      data: [
        {
          id: 'sesn_1', title: 'Weekly BI Briefing 2026-07-14', status: 'idle',
          created_at: '2026-07-14T10:00:00Z', updated_at: '2026-07-14T10:20:00Z',
          agent: { type: 'agent', id: 'agent_bi_1', version: 3 },
          usage: { input_tokens: 91000, output_tokens: 12000 },
        },
        {
          id: 'sesn_2', title: 'x'.repeat(300), status: 'terminated',
          created_at: '2026-07-17T02:00:00Z', updated_at: '2026-07-17T02:01:00Z',
          agent: 'agent_unknown_9',
        },
        {
          id: 'sesn_3', title: 'Lead follow-up', status: 'running',
          created_at: '2026-07-17T19:00:00Z', updated_at: '2026-07-17T19:05:00Z',
          agent: { type: 'agent', id: 'agent_lead_1', version: 1 },
        },
      ],
    }));

    const result = await executeManagedAgentsOpsTool('get_managed_agent_runs', { limit: 10 });
    expect(result.error).toBeUndefined();
    expect(result.sessions[0].agent).toBe('Weekly BI Briefing');
    expect(result.sessions[0].usage).toEqual({ input_tokens: 91000, output_tokens: 12000 });
    // Unknown agent id → labeled null, id still surfaced
    expect(result.sessions[1].agent).toBeNull();
    expect(result.sessions[1].agent_id).toBe('agent_unknown_9');
    expect(result.sessions[1].title).toHaveLength(120);
    expect(result.sessions[2].agent).toBe('Lead Response');
    expect(result.by_status).toEqual({ idle: 1, terminated: 1, running: 1 });
    expect(result.total).toBe(3);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(String(url)).toContain('/v1/sessions?limit=10');
    expect(opts.headers['anthropic-beta']).toBe('managed-agents-2026-04-01');
    expect(opts.headers['x-api-key']).toBe('sk-ant-x');
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-bad';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));
    const result = await executeManagedAgentsOpsTool('get_managed_agent_runs', {});
    expect(result.error).toMatch(/rejected the key/);
  });
});
