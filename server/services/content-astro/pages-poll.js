/**
 * pages-poll.js — polls the Cloudflare Pages API for preview deployment
 * status on open blog-publish PRs.
 *
 * For every blog_posts row in `astro_status='pr_open'`, look up the most
 * recent deployment for its branch and update:
 *   success  → astro_preview_url (resolves the pages.dev short URL)
 *   failure  → astro_status='build_failed' + error captured
 *
 * This is the "preview" half of the pipeline. After merge, a separate
 * check resolves the live URL on the hub (and relevant spokes) and
 * flips astro_status → 'live'.
 *
 * Env: CF_API_TOKEN, CF_ACCOUNT_ID, CF_PAGES_PROJECT
 * Intended caller: scheduler cron (every 1–2 min) or manual refresh from
 * the admin UI.
 */

const db = require('../../models/db');
const logger = require('../logger');

function cfEnv() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const project = process.env.CF_PAGES_PROJECT || 'wavespestcontrol-astro';
  if (!token || !account) throw new Error('CF_API_TOKEN / CF_ACCOUNT_ID not configured');
  return { token, account, project };
}

async function cfFetch(path) {
  const { token, account } = cfEnv();
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloudflare ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function latestDeploymentForBranch(branch) {
  const { project } = cfEnv();
  // CF API paginates but default is newest-first; for a freshly pushed
  // feature branch there are only ever 1–3 deployments. Grab page 1.
  const res = await cfFetch(`/pages/projects/${encodeURIComponent(project)}/deployments?env=preview&per_page=25`);
  const list = Array.isArray(res?.result) ? res.result : [];
  return list.find((d) => d?.deployment_trigger?.metadata?.branch === branch) || null;
}

function extractStatus(deploy) {
  // CF Pages deployments have a list of stages (queued → initialize →
  // clone_repo → build → deploy). The last stage's `status` tells us
  // what happened. Values: active | success | failure | canceled | skipped.
  const stages = Array.isArray(deploy?.stages) ? deploy.stages : [];
  const last = stages[stages.length - 1];
  return {
    stage: last?.name || null,
    status: last?.status || null,
    url: deploy?.url || null,
    error: deploy?.latest_stage?.status === 'failure' ? (deploy?.latest_stage?.name || 'build failed') : null,
  };
}

async function pollPost(post) {
  if (!post.astro_branch_name) return { skipped: true, reason: 'no branch' };
  try {
    const deploy = await latestDeploymentForBranch(post.astro_branch_name);
    if (!deploy) return { pending: true };

    const { status, url, error } = extractStatus(deploy);

    if (status === 'success' && url) {
      await db('blog_posts').where({ id: post.id }).update({
        astro_preview_url: url,
        updated_at: new Date(),
      });
      return { ok: true, url };
    }

    if (status === 'failure') {
      await db('blog_posts').where({ id: post.id }).update({
        astro_status: 'build_failed',
        astro_publish_error: error || 'Cloudflare Pages build failed',
        updated_at: new Date(),
      });
      return { failed: true, error };
    }

    return { pending: true, status };
  } catch (err) {
    logger.warn(`[pages-poll] ${post.astro_branch_name} failed: ${err.message}`);
    return { error: err.message };
  }
}

async function pollPending() {
  try {
    cfEnv(); // throws early if unconfigured
  } catch (err) {
    logger.warn(`[pages-poll] skipped: ${err.message}`);
    return { skipped: true, reason: err.message };
  }

  const pending = await db('blog_posts')
    .whereIn('astro_status', ['pr_open', 'build_failed'])
    .whereNotNull('astro_branch_name')
    .select('id', 'astro_branch_name', 'astro_preview_url', 'astro_status');

  const results = [];
  for (const post of pending) {
    results.push({ id: post.id, branch: post.astro_branch_name, ...(await pollPost(post)) });
  }
  logger.info(`[pages-poll] polled ${results.length} open builds`);
  return { count: results.length, results };
}

module.exports = { pollPost, pollPending };
