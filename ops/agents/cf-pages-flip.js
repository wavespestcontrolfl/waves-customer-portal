#!/usr/bin/env node
// MUTATES (dry-run default): sets PUBLIC_* build variables on ONE Cloudflare
// Pages project (the astro hub or a spoke) and re-deploys the LIVE production
// commit with them, so a hub dark-ship flag can be flipped without the
// Cloudflare dashboard. Pages snapshots env vars at deploy creation, which is
// why the script always creates a new deployment after the PATCH.
//
// Dry run (no --execute): lists every Pages project on the account, prints
// the target project's current production env KEYS (values never printed —
// KEY/TOKEN-named values show a prefix only), the live deploy, and exactly
// which keys the vars file would add or overwrite.
// --execute refuses while ANY production build is still in flight (it would
// race the flip; the deployment list is checked, not just the latest
// deployment), PATCHes the production env (other keys untouched),
// retries the LIVE production deployment (the canonical one — never the
// branch head, so an env flip can never ship unreleased code), follows it to
// a terminal state, and ROLLS THE ENV BACK to the previous values if the
// deployment cannot be created, lands on a different commit, or fails — a
// pending env change must not lie in wait for the next unrelated deploy; a
// key someone else changed meanwhile is never overwritten by the rollback. A
// build that outlives the 60-minute hard ceiling is deleted best-effort
// before the rollback and the operator is told to verify in the dashboard.
//
// Scope guard: only a { PUBLIC_*: string } map is accepted, and a target that
// already exists as a non-plain_text variable is refused before anything is
// printed or written.
//
// Credentials: CF_API_TOKEN + CF_ACCOUNT_ID come from the environment —
// run through `railway run --service waves-customer-portal`, which holds
// them; nothing is printed. Preview env is never touched.
//
// Usage (repo root):
//   railway run --service waves-customer-portal node ops/agents/cf-pages-flip.js                                   # list projects
//   railway run --service waves-customer-portal node ops/agents/cf-pages-flip.js --project=wavespestcontrol-astro  # show env keys
//   echo '{"PUBLIC_TEXT_US":"true"}' > /tmp/vars.json
//   railway run --service waves-customer-portal node ops/agents/cf-pages-flip.js --project=wavespestcontrol-astro --vars=/tmp/vars.json            # dry run
//   railway run --service waves-customer-portal node ops/agents/cf-pages-flip.js --project=wavespestcontrol-astro --vars=/tmp/vars.json --execute  # write + deploy
//
// History: session scratchpad script used for the conversion-stack lane flips
// (2026-09-03, 2026-09-06) and the PostHog ingest-proxy host flip (2026-09-07)
// — promoted here on its third use (README promotion rule).
const fs = require('fs');

// Soft timeout: after this we say so, but keep following the deployment —
// it has already snapshotted the new env, so abandoning it would let it
// activate the flip AFTER we reported a rollback. Hard ceiling: give up,
// try to delete the deployment, roll the env back, and tell the operator to
// verify in the dashboard.
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const DEPLOY_HARD_CEILING_MS = 60 * 60 * 1000;
const POLL_MS = 20 * 1000;
const TERMINAL = new Set(['success', 'failure', 'canceled', 'skipped']);

function makeClient({ token, account, fetchImpl = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return async function cf(path, init) {
    const r = await fetchImpl(base + path, { headers, ...init });
    const j = await r.json();
    if (!j.success) throw new Error(`${(init && init.method) || 'GET'} ${path} → ${JSON.stringify(j.errors).slice(0, 300)}`);
    return j.result;
  };
}

function maskedValue(key, value) {
  return key.includes('KEY') || key.includes('TOKEN') ? `${String(value).slice(0, 6)}…` : value;
}

// Returns null when the vars are acceptable, otherwise the refusal reason.
function refusalReason(vars, prodEnv) {
  const bad = Object.entries(vars).filter(([k, v]) => !/^PUBLIC_[A-Z0-9_]+$/.test(k) || typeof v !== 'string');
  if (bad.length) return `vars must be a { PUBLIC_*: string } map; offending keys: ${bad.map(([k]) => k).join(', ')}`;
  const secret = Object.keys(vars).filter((k) => prodEnv[k] && prodEnv[k].type && prodEnv[k].type !== 'plain_text');
  if (secret.length) return `existing non-plain_text targets: ${secret.join(', ')}`;
  return null;
}

// The exact env fragment that undoes `vars`: previous value where one existed,
// `null` (= delete) where the key was new.
function rollbackFragment(vars, prodEnv) {
  const out = {};
  for (const k of Object.keys(vars)) out[k] = prodEnv[k] ? { type: 'plain_text', value: prodEnv[k].value } : null;
  return out;
}

function deployCommit(dep) {
  return dep && dep.deployment_trigger && dep.deployment_trigger.metadata && dep.deployment_trigger.metadata.commit_hash;
}

// Best-effort stop of a deployment that already snapshotted the flipped env.
// Cloudflare has no cancel call; a forced delete is the closest thing, and the
// operator is always told to verify.
async function stopDeployment(cf, project, id, log) {
  try {
    await cf(`/${project}/deployments/${id}?force=true`, { method: 'DELETE' });
    log(`deleted deployment ${id} (best effort)`);
  } catch (e) {
    log(`could not delete deployment ${id}: ${e.message}`);
  }
}

// Non-terminal PRODUCTION deployments other than the live one, from the
// project's deployment list (first pages, newest first — an in-flight build
// is always recent).
async function activeProductionDeployments(cf, project, liveId) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const rows = (await cf(`/${project}/deployments?env=production&page=${page}&per_page=25`)) || [];
    for (const d of rows) if (d.id !== liveId && (d.environment || 'production') === 'production' && isInProgress(d)) out.push(d);
    if (rows.length < 25) break;
  }
  return out;
}

function isInProgress(dep) {
  const status = dep && dep.latest_stage && dep.latest_stage.status;
  return Boolean(dep && dep.id) && !TERMINAL.has(status);
}

// Follows a deployment to a TERMINAL state. A transient poll error is retried
// (three in a row is a failure); the soft timeout only logs. Past the hard
// ceiling the deployment is deleted best-effort and the error says the
// operator must verify in the dashboard, because it may still complete.
async function waitForDeployment(cf, project, id, { timeoutMs = DEPLOY_TIMEOUT_MS, hardCeilingMs = DEPLOY_HARD_CEILING_MS, pollMs = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  const start = Date.now();
  let warned = false;
  let pollErrors = 0;
  for (;;) {
    let dep;
    try {
      dep = await cf(`/${project}/deployments/${id}`);
      pollErrors = 0;
    } catch (e) {
      pollErrors += 1;
      if (pollErrors >= 3) {
        // The deployment is still out there with the flipped env snapshotted:
        // stop it before the caller rolls the env back.
        await stopDeployment(cf, project, id, log);
        const err = new Error(`lost track of deployment ${id} (3 poll failures: ${e.message}) — deleted best-effort; VERIFY in the Cloudflare dashboard`);
        err.stopped = true;
        throw err;
      }
      await sleep(pollMs);
      continue;
    }
    const status = dep.latest_stage && dep.latest_stage.status;
    const stage = dep.latest_stage && dep.latest_stage.name;
    if (stage === 'deploy' && status === 'success') return dep;
    if (status === 'failure' || status === 'canceled' || status === 'skipped') {
      const err = new Error(`deployment ${id} ${status} at stage ${stage}`);
      err.terminal = true;
      throw err;
    }
    const elapsed = Date.now() - start;
    if (elapsed > hardCeilingMs) {
      await stopDeployment(cf, project, id, log);
      const err = new Error(`deployment ${id} still ${stage}/${status} after ${Math.round(hardCeilingMs / 60000)} min — deleted best-effort; VERIFY in the Cloudflare dashboard that it did not go live with the flipped env`);
      err.stopped = true;
      throw err;
    }
    if (!warned && elapsed > timeoutMs) { warned = true; log(`deployment ${id} still ${stage}/${status} after ${Math.round(timeoutMs / 60000)} min — following it to a terminal state (hard ceiling ${Math.round(hardCeilingMs / 60000)} min)`); }
    await sleep(pollMs);
  }
}

function prodEnvOf(p) {
  return (p.deployment_configs && p.deployment_configs.production && p.deployment_configs.production.env_vars) || {};
}

// The values this run expects to find for its keys (undefined = absent).
function snapshotOf(vars, env) {
  const out = {};
  for (const k of Object.keys(vars)) out[k] = env[k] ? env[k].value : undefined;
  return out;
}

// Phase 1 — read, refuse, plan. No writes.
async function planFlip(cf, project, vars) {
  const p = await cf(`/${project}`);
  const env = prodEnvOf(p);
  const refusal = refusalReason(vars, env);
  if (refusal) throw new Error(`refused: ${refusal}`);
  const live = p.canonical_deployment;
  if (!live || !live.id) throw new Error('refused: project has no live production deployment to redeploy');
  // Any production build still in flight would race the retry: it could end
  // up replacing the flip with its older env snapshot, or the retry could
  // roll production back under it. latest_deployment alone can be a preview
  // that hides one, so the production deployment LIST is checked.
  const inflight = await activeProductionDeployments(cf, project, live.id);
  if (inflight.length) {
    const d = inflight[0];
    throw new Error(`refused: ${inflight.length} production deployment(s) still building (${d.id}, commit ${deployCommit(d) || '?'}, ${d.latest_stage && d.latest_stage.name}/${d.latest_stage && d.latest_stage.status}) — wait for them, then re-run`);
  }
  return { live, liveCommit: deployCommit(live), planned: snapshotOf(vars, env) };
}

// Restore only what this run wrote and that still holds our value — a key
// someone changed meanwhile (an emergency revoke, say) is left alone and
// reported, never overwritten with a stale snapshot.
async function restoreOurs(cf, project, vars, previous, log, why) {
  log(`ROLLING BACK env (${why})`);
  const current = prodEnvOf(await cf(`/${project}`));
  const restore = {};
  const conflicts = [];
  for (const [k, v] of Object.entries(vars)) {
    const cur = current[k] ? current[k].value : undefined;
    if (cur === v) restore[k] = previous[k];
    else if (cur === previous[k]?.value || (cur === undefined && previous[k] === null)) log(`${k} already at its previous value — nothing to restore`);
    else conflicts.push(`${k} (now ${cur === undefined ? 'absent' : 'changed by someone else'})`);
  }
  if (Object.keys(restore).length) {
    await cf(`/${project}`, { method: 'PATCH', body: JSON.stringify({ deployment_configs: { production: { env_vars: restore } } }) });
    log('env restored to previous values for:', Object.keys(restore).join(', '));
  }
  if (conflicts.length) log('NOT restored (changed concurrently — check by hand):', conflicts.join('; '));
}

// Phase 2 — revalidate immediately before writing, then PATCH. A PATCH whose
// answer is lost may still have been applied, so it is undone the same
// conditional way before the error surfaces.
async function writeEnv(cf, project, vars, planned, log) {
  const env = prodEnvOf(await cf(`/${project}`));
  const drift = Object.keys(vars).filter((k) => (env[k] ? env[k].value : undefined) !== planned[k]);
  if (drift.length) throw new Error(`refused: ${drift.join(', ')} changed since planning — re-run`);
  const previous = rollbackFragment(vars, env);
  const env_vars = {};
  for (const [k, v] of Object.entries(vars)) env_vars[k] = { type: 'plain_text', value: v };
  const patchedAt = new Date().toISOString();
  try {
    await cf(`/${project}`, { method: 'PATCH', body: JSON.stringify({ deployment_configs: { production: { env_vars } } }) });
  } catch (e) {
    await restoreOurs(cf, project, vars, previous, log, `env PATCH failed ambiguously: ${e.message}`);
    throw e;
  }
  log('env PATCHed');
  return { previous, patchedAt };
}

// Phase 3 — retry the LIVE deployment. A lost answer may still have created
// one: reconcile from the production list and stop anything in flight.
async function redeployLive(cf, project, live, liveCommit, log) {
  let dep;
  try {
    dep = await cf(`/${project}/deployments/${live.id}/retry`, { method: 'POST' });
  } catch (e) {
    const strays = await activeProductionDeployments(cf, project, live.id).catch(() => []);
    for (const d of strays) await stopDeployment(cf, project, d.id, log);
    throw new Error(`retry failed ambiguously (${e.message}); stopped ${strays.length} in-flight production deployment(s) best-effort — VERIFY in the Cloudflare dashboard`);
  }
  if (liveCommit && deployCommit(dep) && deployCommit(dep) !== liveCommit) {
    await stopDeployment(cf, project, dep.id, log);
    const err = new Error(`new deployment ${dep.id} is on commit ${deployCommit(dep)}, not the live ${liveCommit}`);
    err.stopped = true;
    throw err;
  }
  log('deployment created:', dep.id, 'commit=', deployCommit(dep), 'from live', live.id);
  return dep;
}

// Production deployments other than ours created after the env change: they
// snapshotted the flipped values and a rollback cannot undo that.
async function deploymentsSince(cf, project, sinceIso, excludeIds) {
  const rows = (await cf(`/${project}/deployments?env=production&page=1&per_page=25`)) || [];
  return rows.filter((d) => !excludeIds.includes(d.id) && (d.environment || 'production') === 'production' && d.created_on && d.created_on >= sinceIso);
}

// Apply vars, redeploy the live commit, and undo the env change on any
// failure. Returns the finished deployment.
async function applyAndDeploy(cf, project, vars, { log = console.log, wait = waitForDeployment } = {}) {
  const plan = await planFlip(cf, project, vars);
  const { previous, patchedAt } = await writeEnv(cf, project, vars, plan.planned, log);
  let created = null;
  try {
    const dep = await redeployLive(cf, project, plan.live, plan.liveCommit, log);
    created = dep.id;
    const done = await wait(cf, project, dep.id, { log });
    log('deployment finished:', done.id, done.latest_stage && done.latest_stage.status, 'url=', done.url);
    return done;
  } catch (e) {
    // Never restore the env while a deployment could still finish with the
    // flipped values snapshotted: a terminal one is done, the wait loop already
    // stopped a lost/over-ceiling one, redeployLive stopped its own strays.
    if (created && !e.terminal && !e.stopped) await stopDeployment(cf, project, created, log);
    const others = await deploymentsSince(cf, project, patchedAt, [created, plan.live.id]).catch(() => []);
    for (const d of others) {
      log(`WARNING: production deployment ${d.id} (commit ${deployCommit(d) || '?'}, ${d.latest_stage && d.latest_stage.name}/${d.latest_stage && d.latest_stage.status}) started after the env change and carries the flipped values — verify or roll it back in the Cloudflare dashboard`);
    }
    await restoreOurs(cf, project, vars, previous, log, e.message);
    if (others.length) e.message += ` — and ${others.length} other production deployment(s) started after the env change carry the flipped values (see log)`;
    throw e;
  }
}

async function main(argv, env) {
  const execute = argv.includes('--execute');
  const project = (argv.find((a) => a.startsWith('--project=')) || '').slice(10);
  const varsFile = (argv.find((a) => a.startsWith('--vars=')) || '').slice(7);
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) { console.error('missing CF_API_TOKEN / CF_ACCOUNT_ID'); process.exit(2); }
  const cf = makeClient({ token: env.CF_API_TOKEN, account: env.CF_ACCOUNT_ID });

  const projects = [];
  for (let pg = 1; pg <= 5; pg++) { const r = (await cf(`?page=${pg}`)) || []; projects.push(...r); if (r.length < 10) break; }
  console.log('projects:', projects.map((p) => `${p.name} [${(p.domains || []).join(',')}] branch=${p.production_branch}`).join('\n  '));
  if (!project) return;

  const p = await cf(`/${project}`);
  const prodEnv = prodEnvOf(p);
  console.log(`\n${p.name} production env keys:`, Object.keys(prodEnv).sort().join(', '));
  const live = p.canonical_deployment || p.latest_deployment;
  console.log('live prod deploy:', live && live.id, live && live.latest_stage && live.latest_stage.status, deployCommit(live));
  if (!varsFile) return;

  const vars = JSON.parse(fs.readFileSync(varsFile, 'utf8'));
  const refusal = refusalReason(vars, prodEnv);
  if (refusal) { console.error('refused:', refusal); process.exit(2); }
  for (const [k, v] of Object.entries(vars)) console.log(`  set ${k} = ${maskedValue(k, v)}${k in prodEnv ? ' (overwrites existing)' : ' (new)'}`);
  if (!execute) { console.log('\nDRY RUN — pass --execute to write + redeploy the live commit'); return; }
  await applyAndDeploy(cf, project, vars);
}

module.exports = { makeClient, refusalReason, rollbackFragment, waitForDeployment, applyAndDeploy, deployCommit, isInProgress, stopDeployment, activeProductionDeployments, planFlip, writeEnv, redeployLive, restoreOurs, deploymentsSince };

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}
