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
    // The pinned canonical identity (id + exact name), not just the name —
    // latest_deployment_id (codex r3 P1 on #5275) is what actually binds the
    // fingerprint to WHICH deployment, since deployed_at is volatile.
    expect(result.service).toEqual({
      id: 's1', service: 'portal', latest_deployment_id: 'd1',
      latest_deployment_status: 'SUCCESS', deployed_at: '2026-07-11T10:00:00Z',
    });
    expect(result.note).toContain('portal');
    expect(result.note).toMatch(/Redeploy/);
  });

  // Codex r3 P1 on #5275: deployed_at is volatile (stripped by the
  // fingerprint's `_at`-suffix rule), so a NEW deploy landing between preview
  // and confirm — with the SAME status text (e.g. another SUCCESS) — must
  // still be caught as drift. Only latest_deployment_id makes that possible.
  test('redeploy_railway_service: the preview fingerprint changes when the deployment id changes, even with identical status text', async () => {
    const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    const env = (depId, createdAt) => gqlResponse({
      environment: {
        id: 'env-1',
        name: 'production',
        serviceInstances: { edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: depId, status: 'SUCCESS', createdAt } } }] },
      },
    });
    global.fetch.mockResolvedValueOnce(env('d1', '2026-07-11T10:00:00Z'));
    const before = await executeOpsTool('redeploy_railway_service', { service_name: 'portal' });
    // A brand-new successful deploy — identical status text, only the id
    // (and the volatile timestamp) differ.
    global.fetch.mockResolvedValueOnce(env('d2', '2026-07-12T10:00:00Z'));
    const after = await executeOpsTool('redeploy_railway_service', { service_name: 'portal' });
    expect(previewFingerprint(after)).not.toBe(previewFingerprint(before));

    // A re-fetch of the SAME deployment still fingerprints identically.
    global.fetch.mockResolvedValueOnce(env('d1', '2026-07-11T10:00:00Z'));
    const again = await executeOpsTool('redeploy_railway_service', { service_name: 'portal' });
    expect(previewFingerprint(again)).toBe(previewFingerprint(before));
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
});

describe('intelligence bar Railway write tools (confirmed commit)', () => {
  const { outsideWritePins } = require('../services/intelligence-bar/outside-write-pins');

  const envFixture = (deploymentId = 'd1') => gqlResponse({
    environment: {
      id: 'env-1',
      name: 'production',
      serviceInstances: {
        edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: deploymentId ? { id: deploymentId, status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } : null } }],
      },
    },
  });

  function railwayEnv() {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
  }

  async function previewPins(name) {
    railwayEnv();
    global.fetch.mockResolvedValueOnce(envFixture('d1'));
    const preview = await executeOpsTool(name, { service_name: 'portal' });
    global.fetch.mockClear();
    return outsideWritePins(name, preview);
  }

  test('redeploy_railway_service: confirm runs serviceInstanceRedeploy for the PINNED service + the env id, after re-asserting the deployment', async () => {
    const pins = await previewPins('redeploy_railway_service');
    expect(pins).toEqual({ _verified_railway_service_id: 's1', _verified_railway_deployment_id: 'd1' });
    global.fetch
      .mockResolvedValueOnce(envFixture('d1'))
      .mockResolvedValueOnce(gqlResponse({ serviceInstanceRedeploy: true }));

    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'something-else', ...pins, confirmed: true });
    expect(result).toEqual({ success: true, tool: 'redeploy_railway_service', service_id: 's1', redeployed_from_deployment_id: 'd1' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const mutation = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(mutation.query).toContain('serviceInstanceRedeploy');
    expect(mutation.variables).toEqual({ serviceId: 's1', environmentId: 'env-1' });
  });

  test('restart_railway_service: confirm runs deploymentRestart on the PINNED deployment id', async () => {
    const pins = await previewPins('restart_railway_service');
    global.fetch
      .mockResolvedValueOnce(envFixture('d1'))
      .mockResolvedValueOnce(gqlResponse({ deploymentRestart: true }));

    const result = await executeOpsTool('restart_railway_service', { service_name: 'portal', ...pins, confirmed: true });
    expect(result).toEqual({ success: true, tool: 'restart_railway_service', service_id: 's1', restarted_deployment_id: 'd1' });
    const mutation = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(mutation.query).toContain('deploymentRestart');
    expect(mutation.variables).toEqual({ id: 'd1' });
  });

  test.each(['redeploy_railway_service', 'restart_railway_service'])(
    '%s: a deploy that landed after the card was shown is refused as target-changed, no mutation sent',
    async (name) => {
      const pins = await previewPins(name);
      global.fetch.mockResolvedValueOnce(envFixture('d2-newer'));

      const result = await executeOpsTool(name, { service_name: 'portal', ...pins, confirmed: true });
      expect(result.code).toBe('target_changed');
      expect(result.preview_changed).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1); // the re-read only
    },
  );

  test('a pinned service that vanished from the environment is refused as target-changed', async () => {
    const pins = await previewPins('redeploy_railway_service');
    global.fetch.mockResolvedValueOnce(gqlResponse({ environment: { id: 'env-1', name: 'production', serviceInstances: { edges: [] } } }));
    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'portal', ...pins, confirmed: true });
    expect(result.code).toBe('target_changed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('restart on a service with no deployment refuses instead of guessing', async () => {
    railwayEnv();
    global.fetch.mockResolvedValueOnce(envFixture(null));
    const result = await executeOpsTool('restart_railway_service', {
      service_name: 'portal', _verified_railway_service_id: 's1', _verified_railway_deployment_id: null, confirmed: true,
    });
    expect(result.code).toBe('no_deployment');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each(['redeploy_railway_service', 'restart_railway_service'])(
    '%s: confirmed without a verified pin refuses and never calls Railway',
    async (name) => {
      railwayEnv();
      const result = await executeOpsTool(name, { service_name: 'portal', confirmed: true });
      expect(result.code).toBe('missing_verified_pin');
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['HTTP 403', { ok: false, status: 403, json: async () => ({}) }],
    ['HTTP 401', { ok: false, status: 401, json: async () => ({}) }],
    ['a GraphQL "Not Authorized" error', { ok: true, status: 200, json: async () => ({ errors: [{ message: 'Not Authorized' }] }) }],
  ])('a read-only token (%s) on the mutation returns a clear write-access result and reports no success', async (_label, denied) => {
    const pins = await previewPins('redeploy_railway_service');
    global.fetch.mockResolvedValueOnce(envFixture('d1')).mockResolvedValueOnce(denied);
    const result = await executeOpsTool('redeploy_railway_service', { service_name: 'portal', ...pins, confirmed: true });
    expect(result.code).toBe('write_access_required');
    expect(result.error).toMatch(/cannot deploy or restart.*write access/i);
    expect(result.success).toBeUndefined();
  });

  test('a non-permission GraphQL failure on the mutation stays a plain error', async () => {
    const pins = await previewPins('restart_railway_service');
    global.fetch.mockResolvedValueOnce(envFixture('d1'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Deployment is not restartable' }] }) });
    const result = await executeOpsTool('restart_railway_service', { service_name: 'portal', ...pins, confirmed: true });
    expect(result.error).toMatch(/not restartable/);
    expect(result.code).toBeUndefined();
  });
});

// set_railway_gate (owner ruling 2026-09-28, Decision 5): PREVIEW ONLY. The
// preview reads the live value of ONE variable on the portal's production
// service; it never echoes a non-boolean value or any other variable, and
// confirmed:true refuses without touching the network.
describe('intelligence bar set_railway_gate (preview only)', () => {
  const KNOWN_GATE = 'GATE_STAMPED_ZERO_FREE';
  // Sentinel values that must never appear in any result: another variable's
  // secret and a non-boolean value of the gate itself.
  const OTHER_SECRET = 'sk_live_OTHER_VARIABLE_SECRET';
  const WEIRD_VALUE = 'weird-non-boolean-value-123';

  const ENVIRONMENT = (name = 'production') => gqlResponse({
    environment: {
      id: 'env-1',
      name,
      serviceInstances: {
        edges: [
          { node: { serviceId: 'svc-other', serviceName: 'postgres', latestDeployment: { id: 'd0', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } },
          { node: { serviceId: 'svc-portal', serviceName: 'waves-customer-portal', latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } },
        ],
      },
    },
  });
  const variables = (vars) => gqlResponse({ variables: vars });

  function configure() {
    process.env.RAILWAY_TOKEN = 'proj-token';
    process.env.RAILWAY_PROJECT_ID = 'proj-1';
    process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
    process.env.RAILWAY_SERVICE_ID = 'svc-portal';
  }
  const propose = (input) => executeOpsTool('set_railway_gate', { gate_name: KNOWN_GATE, value: 'true', ...input });

  // Codex r1 on #5489: an inverted (…_OFF) gate's 'true' DISABLES the named
  // thing — the card must say so instead of presenting 'true' as "on".
  test('an inverted _OFF gate: the card cautions that true may turn something OFF', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ GATE_LATE_PAYMENT_CHECKER_OFF: 'false' }));
    const result = await propose({ gate_name: 'GATE_LATE_PAYMENT_CHECKER_OFF', value: 'true' });
    expect(result.preview).toBe(true);
    expect(result.inverted).toBe(true);
    expect(result.meaning).toMatch(/The name suggests 'true' turns something OFF/);
  });

  // Codex r3 on #5489: no synthesized ON/OFF claim — only the literal change.
  test('a normal gate: the meaning line states the literal change, not "feature ON"', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [KNOWN_GATE]: 'false' }));
    const result = await propose({});
    expect(result.inverted).toBe(false);
    expect(result.meaning).toMatch(/Sets the Railway variable GATE_STAMPED_ZERO_FREE to 'true'/);
    expect(result.meaning).toMatch(/does not by itself mean the feature is on/);
    expect(result.meaning).not.toMatch(/turns this gate's feature ON/);
  });

  test('the value schema describes a raw variable value and names the inverted suffixes', () => {
    const def = require('../services/intelligence-bar/ops-tools').OPS_TOOLS.find((t) => t.name === 'set_railway_gate');
    expect(def.input_schema.properties.value.description).toMatch(/literal variable value/);
    expect(def.input_schema.properties.value.description).toMatch(/_OFF/);
    expect(def.description).toMatch(/RAW variable value, not "on\/off"/);
  });

  test('unconfigured: configured:false, no error, no card, no network call', async () => {
    const result = await propose({});
    expect(result.configured).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.preview).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unconfigured also wins over confirmed:true (a configured:false answer, not a card)', async () => {
    const result = await propose({ confirmed: true });
    expect(result.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preview shows gate, current → new, what it controls, the restart notice and the pins', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [KNOWN_GATE]: 'false', OTHER_TOKEN: OTHER_SECRET }));
    const result = await propose({});
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.tool).toBe('set_railway_gate');
    expect(result.gate).toBe(KNOWN_GATE);
    expect(result.current_value).toBe('false');
    expect(result.new_value).toBe('true');
    expect(result.change).toBe(`${KNOWN_GATE}: false → true`);
    expect(result.controls).toMatch(/bills nothing/);
    expect(result.redeploy_notice).toMatch(/redeploys the portal/);
    expect(result.target).toEqual({
      service_id: 'svc-portal', service: 'waves-customer-portal', environment_id: 'env-1', environment: 'production',
    });
    expect(result.prior_value).toBe('false');
    expect(result.prior_kind).toBe('boolean');
    expect(result.prior_value_digest).toBeNull();
    // Reads, never writes: two GraphQL queries, no mutation.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of global.fetch.mock.calls) expect(JSON.parse(init.body).query).not.toMatch(/mutation/);
    // No other variable's value anywhere in the result.
    expect(JSON.stringify(result)).not.toContain(OTHER_SECRET);
  });

  test('an unset gate shows "unset" and pins a null prior value', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ OTHER_TOKEN: OTHER_SECRET }));
    const result = await propose({});
    expect(result.preview).toBe(true);
    expect(result.current_value).toBe('unset');
    expect(result.prior_value).toBeNull();
    expect(result.prior_kind).toBe('unset');
    expect(JSON.stringify(result)).not.toContain(OTHER_SECRET);
  });

  test('a non-boolean current value is never echoed; only a keyed digest is pinned', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [KNOWN_GATE]: WEIRD_VALUE, OTHER_TOKEN: OTHER_SECRET }));
    const result = await propose({});
    expect(result.preview).toBe(true);
    expect(result.current_value).toBe('set to a non-boolean value');
    expect(result.prior_value).toBeNull();
    expect(result.prior_kind).toBe('non_boolean');
    expect(result.prior_value_digest).toMatch(/^[0-9a-f]{16}$/);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(WEIRD_VALUE);
    expect(blob).not.toContain(OTHER_SECRET);
  });

  test('no-op: already at the desired value returns a plain answer, no card', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [KNOWN_GATE]: 'true' }));
    const result = await propose({ value: 'true' });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_set');
    expect(result.error).toBeUndefined();
    expect(result.already_set).toBe(true);
    expect(result.message).toMatch(/already set to true/);
  });

  // Codex r2 on #5489: "already set" is judged with the gate's own reader.
  const LOOSE_GATE = 'GATE_TECH_LINES'; // read only via gateEnvValue
  test.each(['1', 'on', 'TRUE', 'On'])('a gateEnvValue gate stored as %p already reads on: enable is a no-op, value not echoed', async (stored) => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [LOOSE_GATE]: stored }));
    const result = await propose({ gate_name: LOOSE_GATE, value: 'true' });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_set');
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/already reads as true/);
    expect(JSON.stringify(result)).not.toContain(`"${stored}"`);
  });

  test('a gateEnvValue gate stored as "on": disable is still a real change', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [LOOSE_GATE]: 'on' }));
    const result = await propose({ gate_name: LOOSE_GATE, value: 'false' });
    expect(result.preview).toBe(true);
    expect(result.prior_kind).toBe('non_boolean');
  });

  test('a strict gate stored as "1" is not judged: enable still previews (another reader could differ)', async () => {
    configure();
    global.fetch
      .mockResolvedValueOnce(ENVIRONMENT())
      .mockResolvedValueOnce(variables({ [KNOWN_GATE]: '1' }));
    const result = await propose({ value: 'true' });
    expect(result.preview).toBe(true);
    expect(result.current_value).toBe('set to a non-boolean value');
  });

  test.each([
    ['a name the portal does not know', 'GATE_TOTALLY_MADE_UP_FOR_TEST'],
    ['a lowercase name', 'gate_stamped_zero_free'],
    ['a name without the GATE_ prefix', 'STRIPE_SECRET_KEY'],
    ['a name with injection characters', 'GATE_X"; DROP'],
    ['a retired gate', 'GATE_ONE_TIME_WELCOME_EMAIL'],
    ['the retired self-book day cap', 'GATE_SELF_BOOK_DAY_CAP'],
    ['a retired glass theme gate', 'GATE_PORTAL_GLASS'],
  ])('refuses %s without any network call and without echoing it', async (_label, name) => {
    configure();
    const result = await propose({ gate_name: name });
    expect(result.code).toBe('unknown_gate');
    expect(result.preview).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(name);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['a timestamp gate', 'GATE_PEST_STRANDED_RECOVERY'],
    ['an off | shadow | auto gate', 'GATE_REVIEW_AUTO_REPLY'],
    ['a shadow | true gate', 'GATE_SMS_SPAM_CLASSIFIER'],
  ])('%s is refused (no bare true/false write), with no network call', async (_label, name) => {
    configure();
    const result = await propose({ gate_name: name });
    expect(result.code).toBe('not_a_boolean_gate');
    expect(result.error).toMatch(/mode or timestamp/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a known gate only named in a comment (reading unverified) is refused too', async () => {
    configure();
    const { knownGateCatalog } = require('../config/feature-gates');
    const unverified = [...knownGateCatalog().values()].find((e) => e.kind === 'unverified');
    const result = await propose({ gate_name: unverified.name });
    expect(result.code).toBe('not_a_boolean_gate');
    expect(result.error).toMatch(/does not show it is a plain on\/off switch/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('value must be exactly "true" or "false"', async () => {
    configure();
    for (const value of ['TRUE', '1', 'on', '', undefined]) {
      const result = await propose({ value });
      expect(result.code).toBe('invalid_value');
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('refuses when the Railway environment is not production', async () => {
    configure();
    global.fetch.mockResolvedValueOnce(ENVIRONMENT('staging'));
    const result = await propose({});
    expect(result.error).toMatch(/only available on the production environment/);
    expect(result.preview).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('never targets another service: no portal service in the environment refuses', async () => {
    configure();
    process.env.RAILWAY_SERVICE_ID = 'svc-not-here';
    global.fetch.mockResolvedValueOnce(gqlResponse({
      environment: {
        id: 'env-1', name: 'production',
        serviceInstances: { edges: [{ node: { serviceId: 'svc-other', serviceName: 'postgres', latestDeployment: null } }] },
      },
    }));
    const result = await propose({});
    expect(result.error).toMatch(/Could not identify the portal service/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('confirmed:true refuses (the commit path is not built in this PR) and makes no network call', async () => {
    configure();
    const result = await propose({ confirmed: true });
    expect(result.error).toMatch(/cannot be committed yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a Railway failure surfaces as { error } without echoing the gate input', async () => {
    configure();
    global.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await propose({});
    expect(result.error).toBe('network down');
    const logger = require('../services/logger');
    for (const call of logger.error.mock.calls) expect(JSON.stringify(call)).not.toContain(KNOWN_GATE);
  });
});
