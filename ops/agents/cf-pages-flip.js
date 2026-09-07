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
// deployment, and checked AGAIN right after the env write so a build that
// started in between is caught while the rollback is still clean),
// PATCHes the production env (other keys untouched; the targets are
// re-read and re-validated — value AND type — immediately before the
// write), retries the LIVE production deployment (the canonical one — never
// the branch head, so an env flip can never ship unreleased code), follows
// it to a terminal state, and ROLLS THE ENV BACK to the previous values if
// the deployment cannot be created, lands on a different commit, or fails —
// a pending env change must not lie in wait for the next unrelated deploy; a
// key someone else changed meanwhile is never overwritten by the rollback.
// The env is only ever restored once every deployment this run created is
// SETTLED: deleted, or followed to a terminal state. A deployment that can be
// neither deleted nor observed leaves the env flipped and the error says so,
// because restoring under a build that may still go live with the flipped
// values would be the pending-change trap in reverse. A build that outlives
// the 60-minute hard ceiling is deleted before the rollback and the operator
// is told to verify in the dashboard.
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
// delete the deployment, roll the env back, and tell the operator to verify
// in the dashboard.
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const DEPLOY_HARD_CEILING_MS = 60 * 60 * 1000;
const POLL_MS = 20 * 1000;
const LIST_ATTEMPTS = 3;
const TERMINAL = new Set(['success', 'failure', 'canceled', 'skipped']);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function describe(dep) {
  return `${dep.id} (commit ${deployCommit(dep) || '?'}, ${dep.latest_stage && dep.latest_stage.name}/${dep.latest_stage && dep.latest_stage.status})`;
}

// Stop of a deployment that already snapshotted the flipped env. Cloudflare
// has no cancel call; a forced delete is the closest thing. Returns whether
// Cloudflare accepted it — a refused delete means the deployment can still
// go live, and every caller acts on that.
async function stopDeployment(cf, project, id, log) {
  try {
    await cf(`/${project}/deployments/${id}?force=true`, { method: 'DELETE' });
    log(`deleted deployment ${id}`);
    return true;
  } catch (e) {
    log(`could not delete deployment ${id}: ${e.message}`);
    return false;
  }
}

// A listing that backs a decision is retried; a listing that still fails
// throws — an unknown state is never read as "no deployments".
async function listWithRetry(fn, { attempts = LIST_ATTEMPTS, pollMs = POLL_MS, sleep = defaultSleep } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < attempts) await sleep(pollMs); }
  }
  throw new Error(`deployment list unavailable after ${attempts} attempts: ${last.message}`);
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

// Follows a deployment to a TERMINAL state and returns it on success. Throws
// err.terminal on failure/canceled/skipped, err.lost after three poll
// failures in a row, err.ceiling past the hard ceiling — in the last two the
// deployment may still finish. Never deletes anything.
async function followDeployment(cf, project, id, { timeoutMs = DEPLOY_TIMEOUT_MS, hardCeilingMs = DEPLOY_HARD_CEILING_MS, pollMs = POLL_MS, sleep = defaultSleep, log = console.log } = {}) {
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
        const err = new Error(`lost track of deployment ${id} (3 poll failures: ${e.message})`);
        err.lost = true;
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
      const err = new Error(`deployment ${id} still ${stage}/${status} after ${Math.round(hardCeilingMs / 60000)} min`);
      err.ceiling = true;
      throw err;
    }
    if (!warned && elapsed > timeoutMs) { warned = true; log(`deployment ${id} still ${stage}/${status} after ${Math.round(timeoutMs / 60000)} min — following it to a terminal state (hard ceiling ${Math.round(hardCeilingMs / 60000)} min)`); }
    await sleep(pollMs);
  }
}

// Follows OUR deployment; when it can no longer be followed (lost / over the
// ceiling) it is deleted so the env can be restored. err.stopped says the
// deployment is settled; err.unsettled says it is NOT — Cloudflare refused
// the delete and the deployment may still go live with the flipped env.
async function waitForDeployment(cf, project, id, opts = {}) {
  const log = opts.log || console.log;
  try {
    return await followDeployment(cf, project, id, opts);
  } catch (e) {
    if (e.terminal) throw e;
    if (await stopDeployment(cf, project, id, log)) {
      e.stopped = true;
      e.message += ' — deleted; VERIFY in the Cloudflare dashboard that it did not go live with the flipped env';
    } else {
      e.unsettled = true;
      e.message += ' — and it could NOT be deleted';
    }
    throw e;
  }
}

// Settles a deployment that snapshotted the flipped env before the env may
// be restored: delete it, or — when Cloudflare refuses — follow it to a
// terminal state so it can no longer go live afterwards. Returns whether it
// is settled; false means the env must NOT be restored.
async function settleDeployment(cf, project, id, log, followOpts) {
  if (await stopDeployment(cf, project, id, log)) return true;
  log(`following deployment ${id} to a terminal state before touching the env`);
  try {
    await followDeployment(cf, project, id, { ...followOpts, log });
    log(`WARNING: deployment ${id} went LIVE with the flipped env — verify or roll it back in the Cloudflare dashboard`);
    return true;
  } catch (e) {
    if (e.terminal) { log(`deployment ${id} ended: ${e.message}`); return true; }
    log(`could not settle deployment ${id}: ${e.message}`);
    return false;
  }
}

function prodEnvOf(p) {
  return (p.deployment_configs && p.deployment_configs.production && p.deployment_configs.production.env_vars) || {};
}

// What this run expects to find for its keys right before writing: type AND
// value (a secret's hidden value would otherwise compare equal to "absent"),
// undefined = absent.
function snapshotOf(vars, env) {
  const out = {};
  for (const k of Object.keys(vars)) out[k] = env[k] ? `${env[k].type || 'plain_text'}:${env[k].value}` : undefined;
  return out;
}

// Phase 1 — read, refuse, plan. No writes.
async function planFlip(cf, project, vars, poll) {
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
  const inflight = await listWithRetry(() => activeProductionDeployments(cf, project, live.id), poll);
  if (inflight.length) throw new Error(`refused: ${inflight.length} production deployment(s) still building (${describe(inflight[0])}) — wait for them, then re-run`);
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

// Phase 2 — re-read, re-validate (type and value) immediately before
// writing, then PATCH. A PATCH whose answer is lost may still have been
// applied, so it is undone the same conditional way before the error
// surfaces.
async function writeEnv(cf, project, vars, planned, log) {
  const env = prodEnvOf(await cf(`/${project}`));
  const refusal = refusalReason(vars, env);
  if (refusal) throw new Error(`refused: ${refusal} (changed since planning)`);
  const now = snapshotOf(vars, env);
  const drift = Object.keys(vars).filter((k) => now[k] !== planned[k]);
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
// one: reconcile from the production list (retried; an unknown list is
// err.unsettled, never "nothing was created") and settle anything in flight.
async function redeployLive(cf, project, live, liveCommit, log, poll) {
  let dep;
  try {
    dep = await cf(`/${project}/deployments/${live.id}/retry`, { method: 'POST' });
  } catch (e) {
    let strays;
    try {
      strays = await listWithRetry(() => activeProductionDeployments(cf, project, live.id), poll);
    } catch (listErr) {
      const err = new Error(`retry failed ambiguously (${e.message}) and the deployment list could not be read to reconcile it (${listErr.message})`);
      err.unsettled = true;
      throw err;
    }
    let settled = true;
    for (const d of strays) settled = (await settleDeployment(cf, project, d.id, log, poll)) && settled;
    const err = new Error(`retry failed ambiguously (${e.message}); ${strays.length} in-flight production deployment(s) ${settled ? 'settled' : 'NOT settled'} — VERIFY in the Cloudflare dashboard`);
    if (settled) err.stopped = true; else err.unsettled = true;
    throw err;
  }
  if (liveCommit && deployCommit(dep) && deployCommit(dep) !== liveCommit) {
    const err = new Error(`new deployment ${dep.id} is on commit ${deployCommit(dep)}, not the live ${liveCommit}`);
    if (await settleDeployment(cf, project, dep.id, log, poll)) err.stopped = true; else err.unsettled = true;
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
// failure once every deployment this run created is settled. Returns the
// finished deployment. `poll` = { pollMs, sleep } for the listing retries and
// the settle follow (tests shorten it).
async function applyAndDeploy(cf, project, vars, { log = console.log, wait = waitForDeployment, poll = {} } = {}) {
  const plan = await planFlip(cf, project, vars, poll);
  const { previous, patchedAt } = await writeEnv(cf, project, vars, plan.planned, log);
  let created = null;
  try {
    // A build that started between the planning check and the PATCH holds
    // the OLD env and would publish it after ours: re-check now, while the
    // rollback is still clean (nothing of ours has been created).
    const inflight = await listWithRetry(() => activeProductionDeployments(cf, project, plan.live.id), poll);
    if (inflight.length) throw new Error(`refused: ${inflight.length} production deployment(s) started while the env was being written (${describe(inflight[0])}) — wait for them, then re-run`);
    const dep = await redeployLive(cf, project, plan.live, plan.liveCommit, log, poll);
    created = dep.id;
    const done = await wait(cf, project, dep.id, { log, ...poll });
    log('deployment finished:', done.id, done.latest_stage && done.latest_stage.status, 'url=', done.url);
    // Last look before reporting success: a build that started before the env
    // change and is still running would replace ours with the old values.
    let stale = null;
    try { stale = (await listWithRetry(() => activeProductionDeployments(cf, project, plan.live.id), poll)).filter((d) => d.id !== created && d.created_on && d.created_on < patchedAt); } catch (e) { log(`WARNING: could not re-check the deployment list after success (${e.message}) — verify in the Cloudflare dashboard that no older build is still running`); }
    for (const d of stale || []) log(`WARNING: production deployment ${describe(d)} started BEFORE the env change and is still building — if it goes live it carries the OLD values; re-run this flip once it finishes`);
    return done;
  } catch (e) {
    // Never restore the env while a deployment could still finish with the
    // flipped values snapshotted: a terminal one is done, the wait loop and
    // redeployLive settled theirs (or say they could not), anything else of
    // ours is settled here.
    let settled = !e.unsettled;
    if (created && !e.terminal && !e.stopped && !e.unsettled) settled = await settleDeployment(cf, project, created, log, poll);
    let others = [];
    try {
      others = await listWithRetry(() => deploymentsSince(cf, project, patchedAt, [created, plan.live.id]), poll);
    } catch (listErr) {
      log(`WARNING: could not list deployments started after the env change (${listErr.message}) — verify in the Cloudflare dashboard`);
      e.message += ' — deployments started after the env change could not be listed; VERIFY in the Cloudflare dashboard';
    }
    for (const d of others) log(`WARNING: production deployment ${describe(d)} started after the env change and carries the flipped values — verify or roll it back in the Cloudflare dashboard`);
    if (others.length) e.message += ` — and ${others.length} other production deployment(s) started after the env change carry the flipped values (see log)`;
    if (!settled) {
      log('env NOT rolled back: a deployment that snapshotted the flipped values could be neither deleted nor followed to a terminal state — restore by hand once it settles');
      e.message += ' — env NOT rolled back; VERIFY in the Cloudflare dashboard and restore by hand once the deployment settles';
      throw e;
    }
    await restoreOurs(cf, project, vars, previous, log, e.message);
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

module.exports = { makeClient, refusalReason, rollbackFragment, followDeployment, waitForDeployment, settleDeployment, applyAndDeploy, deployCommit, isInProgress, stopDeployment, activeProductionDeployments, listWithRetry, planFlip, writeEnv, redeployLive, restoreOurs, deploymentsSince };

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}
