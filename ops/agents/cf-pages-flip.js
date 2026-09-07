#!/usr/bin/env node
// MUTATES (dry-run default): sets PUBLIC_* build variables on ONE Cloudflare
// Pages project (the astro hub or a spoke) and triggers a fresh production
// deploy, so a hub dark-ship flag can be flipped without the Cloudflare
// dashboard. Pages snapshots env vars at deploy CREATION, which is why the
// script always creates a new deployment after the PATCH.
//
// Dry run (no --execute): lists every Pages project on the account, prints
// the target project's current production env KEYS (values never printed —
// GrowthBook keys show a 4-char prefix + length only), the latest production
// deploy, and exactly which keys the vars file would add or overwrite.
// --execute PATCHes the production env (other keys untouched) and creates
// the deployment.
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
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const projectArg = (args.find(a => a.startsWith('--project=')) || '').slice(10);
const varsFile = (args.find(a => a.startsWith('--vars=')) || '').slice(7);
const TOKEN = process.env.CF_API_TOKEN, ACCOUNT = process.env.CF_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) { console.error('missing CF_API_TOKEN / CF_ACCOUNT_ID'); process.exit(2); }
const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects`;
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
async function cf(path, init) {
  const r = await fetch(base + path, { headers: H, ...init });
  const j = await r.json();
  if (!j.success) throw new Error(`${init?.method || 'GET'} ${path} → ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.result;
}
(async () => {
  const projects = []; for (let pg = 1; pg <= 5; pg++) { const r = await cf(`?page=${pg}`) || []; projects.push(...r); if (r.length < 10) break; }
  console.log('projects:', projects.map(p => `${p.name} [${(p.domains || []).join(',')}] branch=${p.production_branch}`).join('\n  '));
  if (!projectArg) return;
  const p = await cf(`/${projectArg}`);
  const prod = p.deployment_configs?.production?.env_vars || {};
  console.log(`\n${p.name} production env keys:`, Object.keys(prod).sort().join(', '));
  for (const k of Object.keys(prod)) if (k.includes('GROWTHBOOK')) console.log('existing', k, 'type=', prod[k].type, 'value prefix=', String(prod[k].value||'').slice(0,8), 'len=', String(prod[k].value||'').length);
  console.log('latest prod deploy:', p.latest_deployment?.id, p.latest_deployment?.latest_stage?.status, p.latest_deployment?.deployment_trigger?.metadata?.commit_hash);
  if (!varsFile) return;
  const vars = JSON.parse(fs.readFileSync(varsFile, 'utf8'));
  for (const [k, v] of Object.entries(vars)) console.log(`  set ${k} = ${k.includes('KEY') ? v.slice(0, 6) + '…' : v}${k in prod ? ' (overwrites existing)' : ' (new)'}`);
  if (!execute) { console.log('\nDRY RUN — pass --execute to write + deploy'); return; }
  const env_vars = {};
  for (const [k, v] of Object.entries(vars)) env_vars[k] = { type: 'plain_text', value: v };
  await cf(`/${projectArg}`, { method: 'PATCH', body: JSON.stringify({ deployment_configs: { production: { env_vars } } }) });
  const after = await cf(`/${projectArg}`);
  console.log('after PATCH production keys:', Object.keys(after.deployment_configs.production.env_vars || {}).sort().join(', '));
  const dep = await cf(`/${projectArg}/deployments`, { method: 'POST', body: JSON.stringify({ branch: p.production_branch }) });
  console.log('deployment created:', dep.id, 'env=', dep.environment, 'commit=', dep.deployment_trigger?.metadata?.commit_hash);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
