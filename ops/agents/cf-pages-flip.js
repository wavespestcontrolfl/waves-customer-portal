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
// --execute PATCHes the production env (other keys untouched), retries the
// LIVE production deployment (the canonical one — never the branch head, so
// an env flip can never ship unreleased code), waits for it to finish, and
// ROLLS THE ENV BACK to the previous values if the deployment cannot be
// created, lands on a different commit, fails, or times out — a pending env
// change must not lie in wait for the next unrelated deploy.
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

const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 20 * 1000;

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

async function waitForDeployment(cf, project, id, { timeoutMs = DEPLOY_TIMEOUT_MS, pollMs = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dep = await cf(`/${project}/deployments/${id}`);
    const status = dep.latest_stage && dep.latest_stage.status;
    const stage = dep.latest_stage && dep.latest_stage.name;
    if (stage === 'deploy' && status === 'success') return dep;
    if (status === 'failure' || status === 'canceled') throw new Error(`deployment ${id} ${status} at stage ${stage}`);
    if (Date.now() > deadline) throw new Error(`deployment ${id} still ${stage}/${status} after ${Math.round(timeoutMs / 60000)} min`);
    await sleep(pollMs);
  }
}

// Apply vars, redeploy the live commit, and undo the env change on any
// failure. Returns the finished deployment.
async function applyAndDeploy(cf, project, vars, { log = console.log, wait = waitForDeployment } = {}) {
  const p = await cf(`/${project}`);
  const prodEnv = (p.deployment_configs && p.deployment_configs.production && p.deployment_configs.production.env_vars) || {};
  const refusal = refusalReason(vars, prodEnv);
  if (refusal) throw new Error(`refused: ${refusal}`);
  const live = p.canonical_deployment;
  if (!live || !live.id) throw new Error('refused: project has no live production deployment to redeploy');
  const liveCommit = deployCommit(live);
  const previous = rollbackFragment(vars, prodEnv);
  const env_vars = {};
  for (const [k, v] of Object.entries(vars)) env_vars[k] = { type: 'plain_text', value: v };
  await cf(`/${project}`, { method: 'PATCH', body: JSON.stringify({ deployment_configs: { production: { env_vars } } }) });
  log('env PATCHed; redeploying live commit', liveCommit, 'from deployment', live.id);
  const rollback = async (why) => {
    log(`ROLLING BACK env (${why})`);
    await cf(`/${project}`, { method: 'PATCH', body: JSON.stringify({ deployment_configs: { production: { env_vars: previous } } }) });
    log('env restored to previous values');
  };
  let dep;
  try {
    dep = await cf(`/${project}/deployments/${live.id}/retry`, { method: 'POST' });
    if (liveCommit && deployCommit(dep) && deployCommit(dep) !== liveCommit) {
      throw new Error(`new deployment ${dep.id} is on commit ${deployCommit(dep)}, not the live ${liveCommit}`);
    }
    log('deployment created:', dep.id, 'commit=', deployCommit(dep));
    dep = await wait(cf, project, dep.id);
  } catch (e) {
    await rollback(e.message);
    throw e;
  }
  log('deployment finished:', dep.id, dep.latest_stage && dep.latest_stage.status, 'url=', dep.url);
  return dep;
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
  const prodEnv = (p.deployment_configs && p.deployment_configs.production && p.deployment_configs.production.env_vars) || {};
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

module.exports = { makeClient, refusalReason, rollbackFragment, waitForDeployment, applyAndDeploy, deployCommit };

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}
