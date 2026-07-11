/**
 * Railway ops tools — unit tests with a mocked Railway GraphQL API.
 * Verifies the read-only contract: friendly error when unconfigured,
 * variable NAMES only (never values), log truncation, and that every
 * failure surfaces as { error } instead of throwing into the route loop.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const RAILWAY_ENV_KEYS = [
  'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_GRAPHQL_URL',
];

const savedEnv = {};
let executeOpsTool;

function gqlResponse(data) {
  return { ok: true, json: async () => ({ data }) };
}

beforeAll(() => {
  for (const key of RAILWAY_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of RAILWAY_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of RAILWAY_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeOpsTool } = require('../services/intelligence-bar/ops-tools'));
});

describe('intelligence bar Railway ops tools', () => {
  test('returns a setup hint instead of throwing when no token is configured', async () => {
    const result = await executeOpsTool('get_railway_status', {});
    expect(result.error).toMatch(/RAILWAY_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    const result = await executeOpsTool('restart_service', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_railway_status maps service instances to deploy statuses', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch.mockResolvedValueOnce(gqlResponse({
      environment: {
        id: 'env-1',
        name: 'production',
        serviceInstances: {
          edges: [
            { node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } },
            { node: { serviceId: 's2', serviceName: 'postgres', latestDeployment: null } },
          ],
        },
      },
    }));

    const result = await executeOpsTool('get_railway_status', {});
    expect(result.error).toBeUndefined();
    expect(result.environment).toBe('production');
    expect(result.services).toEqual([
      { service: 'portal', latest_deployment_status: 'SUCCESS', deployed_at: '2026-07-11T10:00:00Z' },
      { service: 'postgres', latest_deployment_status: 'NONE', deployed_at: null },
    ]);

    // Project tokens authenticate via the Project-Access-Token header.
    const [, requestInit] = global.fetch.mock.calls[0];
    expect(requestInit.headers['Project-Access-Token']).toBe('proj-token');
    expect(requestInit.headers.Authorization).toBeUndefined();
  });

  test('get_railway_variable_names returns names only — never values', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch
      .mockResolvedValueOnce(gqlResponse({
        environment: {
          id: 'env-1',
          name: 'production',
          serviceInstances: {
            edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } }],
          },
        },
      }))
      .mockResolvedValueOnce(gqlResponse({
        variables: { STRIPE_SECRET_KEY: 'sk_live_supersecret', MODEL_DEEP: 'claude-fable-5' },
      }));

    const result = await executeOpsTool('get_railway_variable_names', {});
    expect(result.error).toBeUndefined();
    expect(result.variable_names).toEqual(['MODEL_DEEP', 'STRIPE_SECRET_KEY']);
    expect(JSON.stringify(result)).not.toContain('sk_live_supersecret');
    expect(JSON.stringify(result)).not.toContain('claude-fable-5');
  });

  test('get_railway_logs reads the latest deployment and truncates long lines', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch
      .mockResolvedValueOnce(gqlResponse({
        environment: {
          id: 'env-1',
          name: 'production',
          serviceInstances: {
            edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } }],
          },
        },
      }))
      .mockResolvedValueOnce(gqlResponse({
        deploymentLogs: [
          { timestamp: '2026-07-11T10:01:00Z', severity: 'error', message: 'x'.repeat(2000) },
          { timestamp: '2026-07-11T10:02:00Z', severity: 'info', message: 'ok' },
        ],
      }));

    const result = await executeOpsTool('get_railway_logs', { filter: '@level:error', limit: 50 });
    expect(result.error).toBeUndefined();
    expect(result.deployment_id).toBe('d1');
    expect(result.total).toBe(2);
    expect(result.lines[0].message.length).toBeLessThan(600);
    expect(result.lines[0].message).toMatch(/\[truncated\]$/);
    expect(result.lines[1].message).toBe('ok');

    // The filter must reach the GraphQL variables untouched.
    const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondBody.variables.filter).toBe('@level:error');
    expect(secondBody.variables.limit).toBe(50);
  });

  test('GraphQL errors surface as { error } results, not exceptions', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ errors: [{ message: 'Not Authorized' }] }) });

    const result = await executeOpsTool('get_railway_status', {});
    expect(result.error).toMatch(/Not Authorized/);
  });

  test('get_railway_deployments clamps the limit and filters by service name', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch
      .mockResolvedValueOnce(gqlResponse({
        environment: {
          id: 'env-1',
          name: 'production',
          serviceInstances: {
            edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } }],
          },
        },
      }))
      .mockResolvedValueOnce(gqlResponse({
        deployments: { edges: [{ node: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } }] },
      }));

    const result = await executeOpsTool('get_railway_deployments', { service_name: 'portal', limit: 9999 });
    expect(result.error).toBeUndefined();
    expect(result.service).toBe('portal');
    expect(result.deployments).toHaveLength(1);

    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.variables.first).toBeLessThanOrEqual(25);
    expect(body.variables.input.serviceId).toBe('s1');
  });
});
