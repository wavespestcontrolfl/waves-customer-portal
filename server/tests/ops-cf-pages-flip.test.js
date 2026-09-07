/**
 * ops/agents/cf-pages-flip.js — the env-flip safety contract (Codex r1 on
 * #4038): only { PUBLIC_*: string } maps, never a secret_text target, the
 * redeploy is a RETRY of the live production deployment (never the branch
 * head), a newer in-flight production build is refused, the deployment is
 * followed to a TERMINAL state (soft timeout only warns; hard ceiling deletes
 * best-effort + tells the operator to verify), and the env change is rolled
 * back when the deployment cannot be created, lands on another commit, or
 * fails — never while it is still running. Cloudflare is a fake fetch.
 */
const path = require('path');
const flip = require(path.resolve(__dirname, '../../ops/agents/cf-pages-flip.js'));

function fakeCloudflare({ liveCommit = 'abc123', retryCommit = 'abc123', retryFails = false, finalStatus = 'success', statuses = null, newerBuilding = false, newerSkipped = false } = {}) {
  const calls = [];
  const project = {
    name: 'hub', production_branch: 'main',
    deployment_configs: { production: { env_vars: { PUBLIC_EXISTING: { type: 'plain_text', value: 'old' }, PUBLIC_SECRETISH: { type: 'secret_text', value: 'x' } } } },
    canonical_deployment: { id: 'dep_live', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: liveCommit } } },
    latest_deployment: newerBuilding
      ? { id: 'dep_newer', environment: 'production', latest_stage: { name: 'build', status: 'active' }, deployment_trigger: { metadata: { commit_hash: 'fff999' } } }
      : newerSkipped
        ? { id: 'dep_skipped', environment: 'production', latest_stage: { name: 'build', status: 'skipped' }, deployment_trigger: { metadata: { commit_hash: 'eee888' } } }
        : { id: 'dep_live', environment: 'production', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: liveCommit } } },
  };
  let polls = 0;
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
    if (method === 'GET' && p === '/hub/deployments/dep_new') {
      const st = statuses ? statuses[Math.min(polls, statuses.length - 1)] : finalStatus;
      polls += 1;
      return ok({ id: 'dep_new', url: 'https://x', latest_stage: { name: 'deploy', status: st } });
    }
    if (method === 'DELETE' && p.startsWith('/hub/deployments/dep_new')) return ok({});
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

  test('deployment on a different commit than live → that deployment is stopped BEFORE the env rolls back', async () => {
    const { cf, calls } = fakeCloudflare({ retryCommit: 'def456' });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/not the live abc123/);
    const del = calls.findIndex((c) => c.method === 'DELETE' && c.p.startsWith('/hub/deployments/dep_new'));
    const rb = calls.findIndex((c, i) => c.method === 'PATCH' && i > calls.findIndex((x) => x.method === 'PATCH'));
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(rb);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('a skipped deployment is terminal: prompt rollback, no ceiling wait; a skipped latest deployment does not block a flip', async () => {
    const { cf, calls } = fakeCloudflare({ finalStatus: 'skipped' });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/skipped/);
    expect(calls.filter((c) => c.method === 'GET' && c.p === '/hub/deployments/dep_new')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
    const ok = fakeCloudflare({ newerSkipped: true });
    const dep = await flip.applyAndDeploy(ok.cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id) => c(`/${p}/deployments/${id}`) });
    expect(dep.id).toBe('dep_new');
  });

  test('deployment fails → rolled back', async () => {
    const { cf, calls } = fakeCloudflare({ finalStatus: 'failure' });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id) => flip.waitForDeployment(c, p, id, { timeoutMs: 1000, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/failure/);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('soft timeout only warns — the deployment is followed to its terminal state (success = keep env, no rollback)', async () => {
    // active for 4 polls (past the soft timeout), then success.
    const { cf, calls } = fakeCloudflare({ statuses: ['active', 'active', 'active', 'active', 'success'] });
    let now = 0;
    const realNow = Date.now; Date.now = () => (now += 400);
    const logs = [];
    try {
      const dep = await flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { log: (...a) => logs.push(a.join(' ')), wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, timeoutMs: 1000, hardCeilingMs: 100000, pollMs: 1, sleep: async () => {} }) });
      expect(dep.id).toBe('dep_new');
    } finally { Date.now = realNow; }
    expect(patches(calls)).toHaveLength(1);
    expect(logs.some((l) => /following it to a terminal state/.test(l))).toBe(true);
  });

  test('soft timeout then failure → rolled back (never before the terminal state)', async () => {
    const { cf, calls } = fakeCloudflare({ statuses: ['active', 'active', 'active', 'failure'] });
    let now = 0;
    const realNow = Date.now; Date.now = () => (now += 400);
    try {
      await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, timeoutMs: 1000, hardCeilingMs: 100000, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/failure/);
    } finally { Date.now = realNow; }
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('hard ceiling → deployment deleted best-effort, env rolled back, operator told to verify', async () => {
    const { cf, calls } = fakeCloudflare({ finalStatus: 'active' });
    let now = 0;
    const realNow = Date.now; Date.now = () => (now += 500);
    try {
      await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, timeoutMs: 500, hardCeilingMs: 2000, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/VERIFY in the Cloudflare dashboard/);
    } finally { Date.now = realNow; }
    expect(calls.filter((c) => c.method === 'DELETE' && c.p.startsWith('/hub/deployments/dep_new'))).toHaveLength(1);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('a newer production deployment still building → refused before any write', async () => {
    const { cf, calls } = fakeCloudflare({ newerBuilding: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/newer production deployment \(dep_newer/);
    expect(patches(calls)).toEqual([]);
  });

  test('transient poll errors are retried, three in a row give up with a verify message', async () => {
    const { cf, calls } = fakeCloudflare();
    let failing = 0;
    const flaky = async (path, init) => { if (!init && path.includes('/deployments/dep_new')) { failing += 1; throw new Error('ETIMEDOUT'); } return cf(path, init); };
    await expect(flip.applyAndDeploy(flaky, 'hub', { PUBLIC_NEW: 'v' }, { ...quiet, wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/lost track of deployment dep_new \(3 poll failures/);
    expect(failing).toBe(3);
    // Stopped (DELETE) before the env was restored — exactly once.
    const dels = calls.filter((c) => c.method === 'DELETE' && c.p.startsWith('/hub/deployments/dep_new'));
    expect(dels).toHaveLength(1);
    expect(calls.indexOf(dels[0])).toBeLessThan(calls.findIndex((c, i) => c.method === 'PATCH' && i > calls.findIndex((x) => x.method === 'PATCH')));
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('refusal happens before any write', async () => {
    const { cf, calls } = fakeCloudflare();
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_SECRETISH: 'x' }, quiet)).rejects.toThrow(/refused/);
    expect(patches(calls)).toEqual([]);
  });
});
