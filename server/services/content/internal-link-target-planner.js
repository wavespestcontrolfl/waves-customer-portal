/**
 * Weekly Search Console target selection for internal links.
 *
 * The runner only plans links to pages the miner flagged for a title rewrite
 * or refresh, and post-merge planning only to brand-new posts. Neither aims
 * at the pages where an extra internal link moves rankings most: pages
 * already sitting just off page one. This picks the hub pages averaging
 * position 8–20 over the last 28 days with real impressions, plans links to
 * each from the whole corpus (loaded once), stamps target_priority with the
 * page's impressions so the daily candidate sweep ships the biggest
 * opportunities first, and dry-runs the new tasks to patch_candidate.
 *
 * GSC queries only choose and rank targets. Anchor phrases come from the
 * target page itself (its keyword, or the service + city its title names),
 * because top queries are "... near me" phrasings no sibling page contains.
 *
 * Kill switch: AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS=false.
 */

const db = require('../../models/db');
const logger = require('../logger');
const frontmatter = require('../content-astro/frontmatter');
const planner = require('./internal-link-planner');

const TABLE = 'content_internal_link_tasks';
const HUB_ORIGIN = 'https://www.wavespestcontrol.com/';

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS || '').trim());
}

// Hub pages averaging position 8–20 (impression-weighted) over 28 days.
async function strikingDistancePages({ limit, minImpressions }) {
  const rows = await db('gsc_pages')
    .where('date', '>=', db.raw("now() - interval '28 days'"))
    .where('page_url', 'like', `${HUB_ORIGIN}%`)
    .whereNot('page_url', HUB_ORIGIN)
    .groupBy('page_url')
    .havingRaw('sum(impressions) >= ?', [minImpressions])
    .havingRaw('sum(position * impressions) / nullif(sum(impressions), 0) between 8 and 20')
    .orderByRaw('sum(impressions) desc')
    .limit(limit)
    .select('page_url', db.raw('sum(impressions)::int as impressions'),
      db.raw('sum(position * impressions) / nullif(sum(impressions), 0) as position'));
  return rows.map((r) => ({ url: r.page_url, impressions: Number(r.impressions) || 0, position: Number(r.position) || null }));
}

// Anchor facts from the target page's own frontmatter. City-service titles
// ("Termite Control in Bradenton, FL") yield service + city, which the
// planner turns into "termite control in Bradenton" / "Bradenton termite control".
function targetFacts(url, corpus) {
  const path = new URL(url).pathname;
  const page = corpus.find((p) => {
    const pUrl = String(p.url || '').replace(/^https?:\/\/[^/]+/, '');
    return pUrl === path || `${pUrl}/` === path || pUrl === `${path}/`;
  });
  if (!page) return null;
  const data = frontmatter.parse(String(page.body || '')).data || {};
  const title = String(data.title || '').trim();
  const cityService = title.match(/^(.+?) in ([A-Za-z .'-]+?),\s*(?:FL|Florida)$/i);
  const keyword = data.primary_keyword || data.target_keyword
    || (cityService ? `${cityService[1]} in ${cityService[2]}` : title.replace(/,\s*(?:FL|Florida)\b.*$/i, ''));
  return {
    url: path,
    title: title || undefined,
    keyword: keyword ? String(keyword).toLowerCase() : undefined,
    service: cityService ? cityService[1].toLowerCase() : undefined,
    city: cityService ? cityService[2] : undefined,
  };
}

async function loadCorpus() {
  if (process.env.ASTRO_REPO_DIR && planner.loadAstroCorpus) return planner.loadAstroCorpus(process.env.ASTRO_REPO_DIR, {});
  if (planner.loadAstroCorpusFromGitHub) return planner.loadAstroCorpusFromGitHub({});
  return [];
}

async function planGscTargets({
  limit = envInt('AUTONOMOUS_INTERNAL_LINK_GSC_TARGET_LIMIT', 10),
  minImpressions = envInt('AUTONOMOUS_INTERNAL_LINK_GSC_MIN_IMPRESSIONS', 100),
} = {}) {
  if (!enabled()) return { status: 'disabled' };
  const pages = await strikingDistancePages({ limit, minImpressions });
  if (!pages.length) return { status: 'no_targets', targets: 0, queued: 0, candidates: 0 };
  const corpus = await loadCorpus();
  if (!corpus.length) return { status: 'no_corpus', targets: pages.length, queued: 0, candidates: 0 };

  const { queueInternalLinkTaskForDryRun } = require('./autonomous-runner')._internals;
  const excludeSource = await require('./protected-pages').protectedSourcePredicate({ db });
  const taskIds = [];
  const summary = [];
  for (const page of pages) {
    const target = targetFacts(page.url, corpus);
    if (!target) {
      summary.push({ url: page.url, queued: 0, reason: 'not_in_corpus' });
      continue;
    }
    const tasks = planner.planForTarget(target, { corpus, excludeSource });
    const ids = [];
    for (const task of tasks) {
      const queued = await queueInternalLinkTaskForDryRun({ ...task, target_priority: page.impressions }, null);
      if (queued?.id) ids.push(queued.id);
    }
    // The refresh path of queueInternalLinkTaskForDryRun keeps the row's old
    // priority; restamp so this week's GSC ranking decides sweep order.
    if (ids.length) await db(TABLE).whereIn('id', ids).update({ target_priority: page.impressions });
    taskIds.push(...ids);
    summary.push({ url: target.url, impressions: page.impressions, position: page.position, queued: ids.length });
  }

  let candidates = 0;
  if (taskIds.length) {
    const executor = require('./internal-link-pr-executor');
    const dryRun = await executor.runDryRun({ taskIds, limit: taskIds.length });
    candidates = (dryRun?.results || []).filter((r) => r.status === 'patch_candidate').length;
  }
  logger.info(`[internal-link-target-planner] ${pages.length} GSC target(s): queued=${taskIds.length} candidates=${candidates}`);
  return { status: 'ok', targets: pages.length, queued: taskIds.length, candidates, summary };
}

module.exports = { planGscTargets, strikingDistancePages, targetFacts };
