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
 * The fixed AI-search benchmark's target pages are planned through the same
 * machinery. Search Console can't pick them: the guides it cares about are
 * pages Google barely shows, so no impression count ever qualifies them, and
 * that thin visibility is the thing extra internal links are meant to fix.
 * They are stamped ahead of every impressions-ranked target, so the sweep
 * ships their links first. A week plans one link each for at most
 * AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGET_LIMIT (default 5) benchmark
 * pages, rotating through them week by week, so the source takes a small,
 * fixed share of the sweep and the impressions-ranked targets keep the rest.
 * A benchmark path Search Console already chose keeps its impressions
 * ranking; a path with no corpus page (tool and resource pages rendered by
 * Astro, not from a content file) has no body to anchor from or link-check,
 * so it is not planned.
 *
 * Kill switches: AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS=false and
 * AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGETS=false, one per source.
 */

const db = require('../../models/db');
const logger = require('../logger');
const frontmatter = require('../content-astro/frontmatter');
const planner = require('./internal-link-planner');
const benchmark = require('../../data/aeo-benchmark-v1.json');

const TABLE = 'content_internal_link_tasks';
const HUB_ORIGIN = 'https://www.wavespestcontrol.com/';

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function enabled(name) {
  return !/^(0|false|no|off)$/i.test(String(process.env[name] || '').trim());
}

// Above any page's 28-day impression total, so every benchmark task outranks
// every impressions-stamped one in the sweep's target_priority DESC order.
const BENCHMARK_TARGET_PRIORITY = 1_000_000;
const BENCHMARK_PATHS = [...new Set(benchmark.questions.map((q) => q.target_path))];
// Outranking everything, the benchmark source must stay small or it starves
// the impressions-ranked targets: the daily sweep ships at most one link PR
// (three links), and the weekly run would otherwise queue up to five links
// for every benchmark page. So a week plans one link (the planner's best) for
// each of a few benchmark pages, and the starting page rotates by week so
// every page gets its turn.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Hub pages averaging position 8–20 (impression-weighted) over 28 days.
// Grouped by the canonical route (query string dropped — the same
// split_part(page_url, chr(63), 1) the GSC opportunity miner uses), so
// ?variants of one page pool their impressions instead of splitting them
// below the threshold or taking several target slots.
const CANONICAL_URL = 'split_part(page_url, chr(63), 1)';

async function strikingDistancePages({ limit, minImpressions, offset = 0 }) {
  const rows = await db('gsc_pages')
    .where('date', '>=', db.raw("now() - interval '28 days'"))
    .where('page_url', 'like', `${HUB_ORIGIN}%`)
    .whereRaw(`${CANONICAL_URL} <> ?`, [HUB_ORIGIN])
    .groupByRaw(CANONICAL_URL)
    .havingRaw('sum(impressions) >= ?', [minImpressions])
    .havingRaw('sum(position * impressions) / nullif(sum(impressions), 0) between 8 and 20')
    .orderByRaw(`sum(impressions) desc, ${CANONICAL_URL}`)
    .limit(limit)
    .offset(offset)
    .select(db.raw(`${CANONICAL_URL} as page_url`), db.raw('sum(impressions)::int as impressions'),
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
  benchmarkLimit = envInt('AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGET_LIMIT', 5),
  now = Date.now(),
} = {}) {
  const gscOn = enabled('AUTONOMOUS_INTERNAL_LINK_GSC_TARGETS');
  const benchmarkOn = enabled('AUTONOMOUS_INTERNAL_LINK_BENCHMARK_TARGETS');
  if (!gscOn && !benchmarkOn) return { status: 'disabled' };
  // Search Console keeps impressions for deleted/renamed URLs, so pages
  // are fetched in batches and the cap applies AFTER dropping pages no
  // longer in the corpus — fetching continues until the cap is filled or
  // the qualifying rows run out.
  const corpus = await loadCorpus();
  if (!corpus.length) return { status: 'no_corpus', targets: 0, queued: 0, candidates: 0 };
  const batchSize = Math.max(limit * 3, 30);
  const pages = [];
  if (gscOn) {
    for (let offset = 0; ; offset += batchSize) {
      const batch = await strikingDistancePages({ limit: batchSize, minImpressions, offset });
      for (const page of batch) {
        if (targetFacts(page.url, corpus)) pages.push({ ...page, priority: page.impressions });
        if (pages.length >= limit) break;
      }
      if (pages.length >= limit || batch.length < batchSize) break;
    }
  }
  if (benchmarkOn) {
    const chosen = new Set(pages.map((p) => new URL(p.url).pathname.replace(/\/?$/, '/')));
    const eligible = BENCHMARK_PATHS.filter((path) => !chosen.has(path) && targetFacts(new URL(path, HUB_ORIGIN).href, corpus));
    const start = eligible.length ? Math.floor(now / WEEK_MS) % eligible.length : 0;
    const rotated = [...eligible.slice(start), ...eligible.slice(0, start)].slice(0, benchmarkLimit);
    for (const path of rotated) {
      pages.push({ url: new URL(path, HUB_ORIGIN).href, impressions: null, position: null, priority: BENCHMARK_TARGET_PRIORITY, cap: 1 });
    }
  }
  if (!pages.length) return { status: 'no_targets', targets: 0, queued: 0, candidates: 0 };

  const { queueInternalLinkTaskForDryRun } = require('./autonomous-runner')._internals;
  const excludeSource = await require('./protected-pages').protectedSourcePredicate({ db });
  const taskIds = [];
  const summary = [];
  for (const page of pages) {
    const target = targetFacts(page.url, corpus);
    const tasks = planner.planForTarget(target, { corpus, excludeSource, ...(page.cap ? { cap: page.cap } : {}) });
    const ids = [];
    for (const task of tasks) {
      const queued = await queueInternalLinkTaskForDryRun({ ...task, target_priority: page.priority }, null);
      if (queued?.id) ids.push(queued.id);
    }
    // The refresh path of queueInternalLinkTaskForDryRun keeps the row's old
    // priority; restamp so this week's ranking decides sweep order.
    if (ids.length) await db(TABLE).whereIn('id', ids).update({ target_priority: page.priority });
    taskIds.push(...ids);
    summary.push({ url: target.url, priority: page.priority, impressions: page.impressions, position: page.position, queued: ids.length });
  }

  let candidates = 0;
  if (taskIds.length) {
    const executor = require('./internal-link-pr-executor');
    const dryRun = await executor.runDryRun({ taskIds, limit: taskIds.length });
    candidates = (dryRun?.results || []).filter((r) => r.status === 'patch_candidate').length;
    candidates += await executor.requeueTransientDryRunFailures(dryRun?.results);
  }
  logger.info(`[internal-link-target-planner] ${pages.length} link target(s): queued=${taskIds.length} candidates=${candidates}`);
  return { status: 'ok', targets: pages.length, queued: taskIds.length, candidates, summary };
}

module.exports = { planGscTargets, strikingDistancePages, targetFacts };
