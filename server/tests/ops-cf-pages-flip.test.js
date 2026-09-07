/**
 * ops/agents/cf-pages-flip.js — the env-flip safety contract (Codex r1 on
 * #4038): only { PUBLIC_*: string } maps, never a secret_text target, the
 * redeploy is a RETRY of the live production deployment (never the branch
 * head), a newer in-flight production build is refused, the deployment is
 * followed to a TERMINAL state (soft timeout only warns; hard ceiling deletes
 * best-effort + tells the operator to verify), and the env change is rolled
 * back when the deployment cannot be created, lands on another commit, or
 * fails — never while it is still running; a lost PATCH or retry answer is
 * reconciled (conditional undo / stray deployment stopped), the env is
 * revalidated (type and value) right before the write, deployments that
 * start during the wait are named in the failure, a refused delete is never
 * swallowed (the deployment is followed to a terminal state before any
 * restore, and the env stays flipped when that is impossible), a listing that
 * fails is never read as "no deployments", and a build that starts between the
 * planning check and the PATCH is caught after the write. Cloudflare is a fake
 * fetch.
 */
const path = require('path');
const flip = require(path.resolve(__dirname, '../../ops/agents/cf-pages-flip.js'));

function fakeCloudflare({ liveCommit = 'abc123', retryCommit = 'abc123', retryFails = false, retryThrows = false, patchThrows = false, driftBeforeWrite = null, lateDeployment = false, finalStatus = 'success', statuses = null, newerBuilding = false, newerSkipped = false, hiddenProdBuild = false, concurrentEdit = null, deleteFails = false, listFailures = 0, buildAfterPlan = false, staleAfterSuccess = false } = {}) {
  const calls = [];
  // Live env state: PATCH merges into it (null deletes), exactly like Pages.
  const env = { PUBLIC_EXISTING: { type: 'plain_text', value: 'old' }, PUBLIC_SECRETISH: { type: 'secret_text', value: 'x' } };
  const project = () => ({
    name: 'hub', production_branch: 'main',
    deployment_configs: { production: { env_vars: JSON.parse(JSON.stringify(env)) } },
    canonical_deployment: { id: 'dep_live', created_on: '2026-09-01T00:00:00Z', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: liveCommit } } },
    latest_deployment: newerBuilding
      ? { id: 'dep_newer', environment: 'production', created_on: '2026-09-07T00:00:00Z', latest_stage: { name: 'build', status: 'active' }, deployment_trigger: { metadata: { commit_hash: 'fff999' } } }
      : newerSkipped
        ? { id: 'dep_skipped', environment: 'production', created_on: '2026-09-07T00:00:00Z', latest_stage: { name: 'build', status: 'skipped' }, deployment_trigger: { metadata: { commit_hash: 'eee888' } } }
        : { id: 'dep_live', environment: 'production', created_on: '2026-09-01T00:00:00Z', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: liveCommit } } },
  });
  let polls = 0;
  let gets = 0;
  let patched = 0;
  let retried = false;
  let listCalls = 0;
  let listFailed = 0;
  const listRows = () => {
    const p = project();
    const rows = [];
    if (hiddenProdBuild) rows.push({ id: 'dep_preview', environment: 'preview', created_on: '2026-09-07T00:00:00Z', latest_stage: { name: 'deploy', status: 'success' } }, { id: 'dep_hidden', environment: 'production', created_on: '2026-09-07T00:00:00Z', latest_stage: { name: 'build', status: 'active' }, deployment_trigger: { metadata: { commit_hash: 'ddd777' } } });
    if (newerBuilding || newerSkipped) rows.push(p.latest_deployment);
    // An ambiguous retry (response lost) still created a deployment; a late
    // unrelated deployment appears once our env is in place.
    if (retryThrows && retried) rows.push({ id: 'dep_stray', environment: 'production', created_on: new Date(Date.now() + 1000).toISOString(), latest_stage: { name: 'build', status: 'active' }, deployment_trigger: { metadata: { commit_hash: liveCommit } } });
    // A build that started between the planning check and the PATCH (it holds
    // the OLD env): visible only once the env has been written; on the
    // success-path variant only once our deployment has been polled.
    if ((buildAfterPlan && patched) || (staleAfterSuccess && polls)) rows.push({ id: 'dep_between', environment: 'production', created_on: '2026-09-07T00:00:00Z', latest_stage: { name: 'build', status: 'active' }, deployment_trigger: { metadata: { commit_hash: 'bbb555' } } });
    if (lateDeployment && patched) rows.push({ id: 'dep_late', environment: 'production', created_on: new Date(Date.now() + 60000).toISOString(), latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: 'ccc666' } } });
    rows.push(p.canonical_deployment);
    return rows;
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const p = url.replace(/^.*\/pages\/projects/, '');
    calls.push({ method, p, body: init.body ? JSON.parse(init.body) : undefined });
    const ok = (result) => ({ json: async () => ({ success: true, result }) });
    if (method === 'GET' && p === '/hub') {
      gets += 1;
      // Drift: someone edits a key between the planning read and the write-time read.
      if (driftBeforeWrite && gets === 2) Object.assign(env, driftBeforeWrite);
      // A concurrent edit lands after our PATCH, before the rollback read.
      if (concurrentEdit && patched && gets >= 3) Object.assign(env, concurrentEdit);
      return ok(project());
    }
    if (method === 'GET' && p.startsWith('/hub/deployments?env=production')) {
      listCalls += 1;
      // The reconciliation list after an ambiguous retry fails N times.
      if (retried && listFailed < listFailures) { listFailed += 1; throw new Error('list unavailable'); }
      return ok(listRows());
    }
    if (method === 'PATCH' && p === '/hub') {
      patched += 1;
      for (const [k, v] of Object.entries(init.body ? JSON.parse(init.body).deployment_configs.production.env_vars : {})) { if (v === null) delete env[k]; else env[k] = v; }
      if (patchThrows && patched === 1) throw new Error('socket hang up');
      return ok(project());
    }
    if (method === 'POST' && p === '/hub/deployments/dep_live/retry') {
      retried = true;
      if (retryThrows) throw new Error('response lost');
      if (retryFails) return { json: async () => ({ success: false, errors: [{ message: 'retry refused' }] }) };
      return ok({ id: 'dep_new', created_on: new Date().toISOString(), deployment_trigger: { metadata: { commit_hash: retryCommit } } });
    }
    if (method === 'GET' && p === '/hub/deployments/dep_new') {
      const st = statuses ? statuses[Math.min(polls, statuses.length - 1)] : finalStatus;
      polls += 1;
      return ok({ id: 'dep_new', url: 'https://x', latest_stage: { name: 'deploy', status: st } });
    }
    if (method === 'DELETE' && p.startsWith('/hub/deployments/')) return deleteFails ? { json: async () => ({ success: false, errors: [{ message: 'cannot delete an active deployment' }] }) } : ok({});
    return { json: async () => ({ success: false, errors: [{ message: 'unexpected ' + method + ' ' + p }] }) };
  };
  const cf = flip.makeClient({ token: 't', account: 'a', fetchImpl });
  return { cf, calls, env, counts: () => ({ listCalls, polls }) };
}
const fastPoll = { pollMs: 1, sleep: async () => {} };
const quiet = { log: () => {}, poll: fastPoll };
const capture = (logs) => ({ log: (...a) => logs.push(a.join(' ')), poll: fastPoll });
const rollbackIndex = (calls) => calls.findIndex((c, i) => c.method === 'PATCH' && i > calls.findIndex((x) => x.method === 'PATCH'));
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
      const dep = await flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...capture(logs), wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, timeoutMs: 1000, hardCeilingMs: 100000, pollMs: 1, sleep: async () => {} }) });
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
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/production deployment\(s\) still building \(dep_newer/);
    expect(patches(calls)).toEqual([]);
  });

  test('an in-flight production build hidden behind a newer preview deployment is still refused', async () => {
    const { cf, calls } = fakeCloudflare({ hiddenProdBuild: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/still building \(dep_hidden/);
    expect(patches(calls)).toEqual([]);
  });

  test('rollback restores only keys that still hold this run\'s value; a concurrent edit is left alone and reported', async () => {
    const logs = [];
    const { cf, calls } = fakeCloudflare({ retryFails: true, concurrentEdit: { PUBLIC_EXISTING: { type: 'plain_text', value: 'emergency' } } });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v', PUBLIC_EXISTING: 'new' }, capture(logs))).rejects.toThrow(/retry refused/);
    // PUBLIC_NEW still ours → deleted; PUBLIC_EXISTING changed meanwhile → untouched.
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
    expect(logs.some((l) => /NOT restored .*PUBLIC_EXISTING \(now changed by someone else\)/.test(l))).toBe(true);
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

  test('env drifts between planning and the write → refused, no PATCH', async () => {
    const { cf, calls } = fakeCloudflare({ driftBeforeWrite: { PUBLIC_EXISTING: { type: 'plain_text', value: 'someone-else' } } });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_EXISTING: 'new' }, quiet)).rejects.toThrow(/PUBLIC_EXISTING changed since planning/);
    expect(patches(calls)).toEqual([]);
  });

  test('ambiguous env PATCH (answer lost but applied) → conditionally undone, error surfaces', async () => {
    const { cf, calls, env } = fakeCloudflare({ patchThrows: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v', PUBLIC_EXISTING: 'new' }, quiet)).rejects.toThrow(/socket hang up/);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null, PUBLIC_EXISTING: { type: 'plain_text', value: 'old' } });
    expect(env.PUBLIC_NEW).toBeUndefined();
    expect(env.PUBLIC_EXISTING.value).toBe('old');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('ambiguous retry (answer lost but a deployment was created) → the stray in-flight deployment is stopped, env rolled back, operator told to verify', async () => {
    const { cf, calls } = fakeCloudflare({ retryThrows: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/retry failed ambiguously .*1 in-flight production deployment\(s\) settled/);
    const del = calls.findIndex((c) => c.method === 'DELETE' && c.p.startsWith('/hub/deployments/dep_stray'));
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(calls.findIndex((c, i) => c.method === 'PATCH' && i > calls.findIndex((x) => x.method === 'PATCH')));
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('a production deployment that started during the wait is named in the failure — it carries the flipped values', async () => {
    const logs = [];
    const { cf, calls } = fakeCloudflare({ finalStatus: 'failure', lateDeployment: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...capture(logs), wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/1 other production deployment\(s\) started after the env change/);
    expect(logs.some((l) => /WARNING: production deployment dep_late .*carries the flipped values/.test(l))).toBe(true);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('a refused delete after a commit mismatch is not swallowed: the deployment is followed to its terminal state BEFORE the env rolls back', async () => {
    const logs = [];
    const { cf, calls } = fakeCloudflare({ retryCommit: 'def456', deleteFails: true, statuses: ['active', 'failure'] });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, capture(logs))).rejects.toThrow(/not the live abc123/);
    const lastPoll = calls.map((c, i) => (c.method === 'GET' && c.p === '/hub/deployments/dep_new' ? i : -1)).filter((i) => i >= 0).pop();
    expect(calls.filter((c) => c.method === 'GET' && c.p === '/hub/deployments/dep_new')).toHaveLength(2);
    expect(lastPoll).toBeLessThan(rollbackIndex(calls));
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
    expect(logs.some((l) => /could not delete deployment dep_new/.test(l))).toBe(true);
    // The same deployment going LIVE instead is named as such — the flipped env is out.
    const live = fakeCloudflare({ retryCommit: 'def456', deleteFails: true, statuses: ['active', 'success'] });
    const liveLogs = [];
    await expect(flip.applyAndDeploy(live.cf, 'hub', { PUBLIC_NEW: 'v' }, capture(liveLogs))).rejects.toThrow(/not the live abc123/);
    expect(liveLogs.some((l) => /deployment dep_new went LIVE with the flipped env/.test(l))).toBe(true);
    expect(patches(live.calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('past the hard ceiling with a refused delete → env is NOT rolled back, the error says so', async () => {
    const logs = [];
    const { cf, calls } = fakeCloudflare({ finalStatus: 'active', deleteFails: true });
    let now = 0;
    const realNow = Date.now; Date.now = () => (now += 500);
    try {
      await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...capture(logs), wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, timeoutMs: 500, hardCeilingMs: 2000, pollMs: 1, sleep: async () => {} }) })).rejects.toThrow(/could NOT be deleted.*env NOT rolled back/);
    } finally { Date.now = realNow; }
    expect(patches(calls)).toHaveLength(1);
    expect(logs.some((l) => /env NOT rolled back/.test(l))).toBe(true);
  });

  test('ambiguous retry: a reconciliation list that fails once is retried; one that keeps failing leaves the env flipped instead of reading as "no deployments"', async () => {
    const once = fakeCloudflare({ retryThrows: true, listFailures: 1 });
    await expect(flip.applyAndDeploy(once.cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/1 in-flight production deployment\(s\) settled/);
    expect(once.calls.some((c) => c.method === 'DELETE' && c.p.startsWith('/hub/deployments/dep_stray'))).toBe(true);
    expect(patches(once.calls)[1]).toEqual({ PUBLIC_NEW: null });
    const always = fakeCloudflare({ retryThrows: true, listFailures: 99 });
    await expect(flip.applyAndDeploy(always.cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/deployment list could not be read to reconcile.*env NOT rolled back/);
    expect(patches(always.calls)).toHaveLength(1);
    expect(always.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('a target created as secret_text (or retyped) between planning and the write → refused, no PATCH', async () => {
    const created = fakeCloudflare({ driftBeforeWrite: { PUBLIC_NEW: { type: 'secret_text' } } });
    await expect(flip.applyAndDeploy(created.cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/refused: existing non-plain_text targets: PUBLIC_NEW \(changed since planning\)/);
    expect(patches(created.calls)).toEqual([]);
    const retyped = fakeCloudflare({ driftBeforeWrite: { PUBLIC_EXISTING: { type: 'secret_text', value: 'old' } } });
    await expect(flip.applyAndDeploy(retyped.cf, 'hub', { PUBLIC_EXISTING: 'new' }, quiet)).rejects.toThrow(/refused: existing non-plain_text targets: PUBLIC_EXISTING/);
    expect(patches(retyped.calls)).toEqual([]);
  });

  test('a build that started between the planning check and the PATCH is caught after the write: no retry, env rolled back', async () => {
    const { cf, calls } = fakeCloudflare({ buildAfterPlan: true });
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, quiet)).rejects.toThrow(/started while the env was being written \(dep_between/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(patches(calls)[1]).toEqual({ PUBLIC_NEW: null });
  });

  test('success still re-checks the list: an older build still running is named as carrying the OLD values', async () => {
    const logs = [];
    const { cf } = fakeCloudflare({ staleAfterSuccess: true });
    const dep = await flip.applyAndDeploy(cf, 'hub', { PUBLIC_NEW: 'v' }, { ...capture(logs), wait: (c, p, id, o) => flip.waitForDeployment(c, p, id, { ...o, pollMs: 1, sleep: async () => {} }) });
    expect(dep.id).toBe('dep_new');
    expect(logs.some((l) => /dep_between .*started BEFORE the env change .*OLD values/.test(l))).toBe(true);
  });

  test('refusal happens before any write', async () => {
    const { cf, calls } = fakeCloudflare();
    await expect(flip.applyAndDeploy(cf, 'hub', { PUBLIC_SECRETISH: 'x' }, quiet)).rejects.toThrow(/refused/);
    expect(patches(calls)).toEqual([]);
  });
});
