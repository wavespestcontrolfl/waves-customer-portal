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
  test('unconfigured state is benign — no error field (must not trip the shared breaker) and no network call', async () => {
    const result = await executeOpsTool('get_railway_status', {});
    // Critically NOT { error } — the /query loop counts result.error against
    // the shared admin breaker, so the dark feature must return a benign shape.
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/RAILWAY_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token'; // past the not-configured guard
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
        deployments: { edges: [{ node: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z', serviceId: 's1' } }] },
      }));

    const result = await executeOpsTool('get_railway_deployments', { service_name: 'portal', limit: 9999 });
    expect(result.error).toBeUndefined();
    expect(result.service).toBe('portal');
    expect(result.deployments).toHaveLength(1);
    expect(result.deployments[0].service).toBe('portal');

    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.variables.first).toBeLessThanOrEqual(25);
    expect(body.variables.input.serviceId).toBe('s1');
  });

  test('get_railway_deployments attributes each row to its service on the all-services path', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch
      .mockResolvedValueOnce(gqlResponse({
        environment: {
          id: 'env-1',
          name: 'production',
          serviceInstances: {
            edges: [
              { node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } },
              { node: { serviceId: 's2', serviceName: 'postgres', latestDeployment: { id: 'd2', status: 'SUCCESS', createdAt: '2026-07-11T09:00:00Z' } } },
            ],
          },
        },
      }))
      .mockResolvedValueOnce(gqlResponse({
        deployments: {
          edges: [
            { node: { id: 'd9', status: 'FAILED', createdAt: '2026-07-11T11:00:00Z', serviceId: 's2' } },
            { node: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z', serviceId: 's1' } },
          ],
        },
      }));

    const result = await executeOpsTool('get_railway_deployments', {});
    expect(result.error).toBeUndefined();
    expect(result.service).toBe('all services');
    // A failed deploy is useless without knowing which service failed (P3).
    expect(result.deployments[0]).toMatchObject({ id: 'd9', service: 'postgres', status: 'FAILED' });
    expect(result.deployments[1]).toMatchObject({ id: 'd1', service: 'portal', status: 'SUCCESS' });

    // Unfiltered path must not scope the query to a single service.
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.variables.input.serviceId).toBeUndefined();
  });

  test('get_railway_logs never accepts a caller-supplied deployment id', async () => {
    // The tool must not expose a deployment_id parameter — an arbitrary id
    // would bypass environment scoping under a broad account token (P2).
    const { OPS_TOOLS } = require('../services/intelligence-bar/ops-tools');
    const logsTool = OPS_TOOLS.find(t => t.name === 'get_railway_logs');
    expect(logsTool.input_schema.properties.deployment_id).toBeUndefined();

    // And even if passed, it is ignored — logs resolve via the scoped service.
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch
      .mockResolvedValueOnce(gqlResponse({
        environment: {
          id: 'env-1',
          name: 'production',
          serviceInstances: {
            edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'scoped-d1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } }],
          },
        },
      }))
      .mockResolvedValueOnce(gqlResponse({ deploymentLogs: [{ timestamp: '2026-07-11T10:01:00Z', severity: 'info', message: 'ok' }] }));

    const result = await executeOpsTool('get_railway_logs', { deployment_id: 'foreign-deploy-999' });
    expect(result.error).toBeUndefined();
    expect(result.deployment_id).toBe('scoped-d1');
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.variables.deploymentId).toBe('scoped-d1');
    expect(JSON.stringify(body)).not.toContain('foreign-deploy-999');
  });
});

// Outside-write tools (IB scope expansion item 1, owner ruling 2026-09-28):
// full-access gating lives in the ROUTE (getToolsForContext,
// intelligence-bar-full-access-tool-offering.test.js), not here — these
// tests cover the module contract: missing-token refusal, a human-readable
// preview naming the real service and its current status, and the commit
// path's refusal.
describe('intelligence bar Railway write tools (preview only)', () => {
  const ENVIRONMENT_FIXTURE = gqlResponse({
    environment: {
      id: 'env-1',
      name: 'production',
      serviceInstances: {
        edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } }],
      },
    },
  });

  test('unconfigured state is benign for both write tools, no network call', async () => {
    for (const name of ['redeploy_railway_service', 'restart_railway_service']) {
      const result = await executeOpsTool(name, { service_name: 'portal' });
      expect(result.error).toBeUndefined();
      expect(result.configured).toBe(false);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('redeploy_railway_service: unconfirmed names the real service by its pinned id and current deploy status', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch.mockResolvedValueOnce(ENVIRONMENT_FIXTURE);

    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'portal' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    // The pinned canonical identity (id + exact name), not just the name.
    expect(result.service).toEqual({ id: 's1', service: 'portal', latest_deployment_status: 'SUCCESS', deployed_at: '2026-07-11T10:00:00Z' });
    expect(result.note).toContain('portal');
    expect(result.note).toMatch(/Redeploy/);
  });

  test('redeploy_railway_service: a substring is never enough — it never picks a service that merely contains the input', async () => {
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
            { node: { serviceId: 's2', serviceName: 'portal-worker', latestDeployment: { id: 'd2', status: 'SUCCESS', createdAt: '2026-07-11T09:00:00Z' } } },
          ],
        },
      },
    }));

    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'portal' });
    // Exact match on 'portal' exists (the other row only CONTAINS it), so
    // this still resolves — proves the substring row is never conflated in.
    expect(result.error).toBeUndefined();
    expect(result.service.id).toBe('s1');
  });

  test('redeploy_railway_service: wildcard characters in the input are literal, never widen the match', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch.mockResolvedValueOnce(ENVIRONMENT_FIXTURE);

    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'port%' });
    expect(result.error).toMatch(/No Railway service found exactly named "port%"/);
  });

  test('redeploy_railway_service: several services exactly named the same thing is a refusal, never an arbitrary pick', async () => {
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
            { node: { serviceId: 's2', serviceName: 'Portal', latestDeployment: { id: 'd2', status: 'SUCCESS', createdAt: '2026-07-11T09:00:00Z' } } },
          ],
        },
      },
    }));

    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'portal' });
    expect(result.error).toMatch(/Multiple Railway services are exactly named/);
  });

  test('restart_railway_service: unconfirmed names the real service too', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch.mockResolvedValueOnce(ENVIRONMENT_FIXTURE);

    const result = await executeOpsTool('restart_railway_service', { service_name: 'portal' });
    expect(result.error).toBeUndefined();
    expect(result.note).toMatch(/Restart/);
    expect(result.note).toContain('no new deploy');
  });

  test('an unknown service name returns an error result, no confirm', async () => {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    global.fetch.mockResolvedValueOnce(ENVIRONMENT_FIXTURE);

    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'nonexistent' });
    expect(result.error).toMatch(/No Railway service found exactly named/);
  });

  test.each(['redeploy_railway_service', 'restart_railway_service'])(
    '%s: confirmed:true refuses — the commit path is not built in this PR',
    async (name) => {
      process.env.RAILWAY_TOKEN = 'proj-token';
      process.env.RAILWAY_PROJECT_ID = 'proj-1';
      process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
      const result = await executeOpsTool(name, { service_name: 'portal', confirmed: true });
      expect(result.error).toMatch(/not enabled yet/);
      expect(result.code).toBe('not_yet_implemented');
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );
});
