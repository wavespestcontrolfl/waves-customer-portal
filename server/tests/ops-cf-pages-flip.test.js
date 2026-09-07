/**
 * ops/agents/cf-pages-flip.js — the env-flip safety contract (Codex r1 on
 * #4038): only { PUBLIC_*: string } maps, never a secret_text target, the
 * redeploy is a RETRY of the live production deployment (never the branch
 * head), and the env change is rolled back when the deployment cannot be
 * created, lands on another commit, or fails. Cloudflare is a fake fetch.
 */
const path = require('path');
const flip = require(path.resolve(__dirname, '../../ops/agents/cf-pages-flip.js'));

function fakeCloudflare({ liveCommit = 'abc123', retryCommit = 'abc123', retryFails = false, finalStatus = 'success' } = {}) {
  const calls = [];
  const project = {
    name: 'hub', production_branch: 'main',
    deployment_configs: { production: { env_vars: { PUBLIC_EXISTING: { type: 'plain_text', value: 'old' }, PUBLIC_SECRETISH: { type: 'secret_text', value: 'x' } } } },
    canonical_deployment: { id: 'dep_live', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: liveCommit } } },
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const p = url.replace(/^.*\/pages\/projects/, '');
    calls.push({ method, p, body: init.body ? JSON.parse(init.body) : undefined });
    const ok = (result) => ({ json: async () => ({ success: true, result }) });
    if (method === 'GET' && p === '/hub') return ok(project);
    if (method === 'PATCH' && p === '/hub') return ok(project);
    if (method === 'POST' && p === '/hub/deployments/dep_live/retry') {
      if (retryFails) return { json: async () => ({ success: false, errors: [{ message: 'retry refused' }] }) };
      return ok({ id: 'dep_new', deployment_trigger: { metadata: { commit_hash: retryCommit } } });
    }
    if (method === 'GET' && p === '/hub/deployments/dep_new') return ok({ id: 'dep_new', url: 'https://x', latest_stage: { name: 'deploy', status: finalStatus } });
    return { json: async () => ({ success: false, errors: [{ message: 'unexpected ' + method + ' ' + p }] }) };
  };
  const cf = flip.makeClient({ token: 't', account: 'a', fetchImpl });
  return { cf, calls };
}
const quiet = { log: () => {} };
const patches = (calls) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body.deployment_configs.production.env_vars);

describe('refusalReason', () => {
  const prod = { PUBLIC_A: { type: 'plain_text', value: '1' }, PUBLIC_S: { type: 'secret_text', value: 'x' } };
  test('accepts a PUBLIC_* string map', () => expect(flip.refusalReason({ PUBLIC_A: 'true', PUBLIC_NEW: 'x' }, prod)).toBeNull());
  test('refuses non-PUBLIC keys and non-string values', () => {
    expect(flip.refusalReason({ SERVICE_TOKEN: 'x' }, prod)).toMatch(/SERVICE_TOKEN/);
    expect(flip.refusalReason({ PUBLIC_A: 1 }, prod)).toMatch(/PUBLIC_A/);
  });
  test('refuses a secret_text target', () => expect(flip.refusalReason({ PUBLIC_S: 'x' }, prod)).toMatch(/PUBLIC_S/));
});

describe('applyAndDeploy', () => {
  test('happy path: PATCH, retry the LIVE deployment (not the branch), wait, no rollback', async () => {
    const { cf, calls } = fakeCloudflare();
    const dep = await flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v', PUBLIC_EXISTING: 'new' }, { ...quiet, wait: (c, p, id) => c(`/${p}/deployments/${id}`) });
    expect(dep.id).toBe('dep_new');
    expect(calls.some((c) => c.method === 'POST' && c.p === '/hub/deployments/dep_live/retry')).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.p === '/hub/deployments')).toBe(false);
    expect(patches(calls)).toEqual([{ PUBLIC_NEW: { type: 'plain_text', value: 'v' }, PUBLIC_EXISTING: { type: 'plain_text', value: 'new' } }]);
  });

  test('retry refused → env rolled back (new key deleted, existing key restored)', async () => {
    const { cf, calls } = fakeCloudflare({ retryFails: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v', PUBLIC_EXISTING: 'new' }, quiet)).rejects.toThrow(/retry refused/);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null, PUBLIC_EXISTING: { type: 'plain_text', value: 'old' } });
  });

  test('deployment on a different commit than live → rolled back', async () => {
    const { cf, calls } = fakeCloudflare({ retryCommit: 'def456' });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/not the live abc123/);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('deployment fails → rolled back', async () => {
    const { cf, calls } = fakeCloudflare({ finalStatus: 'failure' });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id) => flip.waitForDeployment(c, p, id, { timeoutMs: 1000, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/failure/);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('deployment never finishes → timeout → rolled back', async () => {
    const { cf, calls } = fakeCloudflare({ finalStatus: 'active' });
    let now = 0;
    const realNow = Date.now; Date.now = () => (now += 500);
    try {
      await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id) => flip.waitForDeployment(c, p, id, { timeoutMs: 1000, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/after 0 min/);
    } finally { Date.now = realNow; }
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('refusal happens before any write', async () => {
    const { cf, calls } = fakeCloudflare();
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_SECRETISH: 'x' }, quiet)).rejects.toThrow(/refused/);
    expect(patches(calls)).toEqual([]);
  });
});
