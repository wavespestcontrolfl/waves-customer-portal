/**
 * Cited pages — the third-party PAGES answer engines cite, ranked page by page
 * (owner 2026-10-01: "rank cited pages, not websites"). The weekly
 * `ai_citation` feeder (link-registry-ai-citation-ingest.js) rolls citations up
 * to a website for the registry; this module keeps the page as the unit, so the
 * outreach drafter and the admin panel can name the exact article an engine
 * leans on and the questions it answers with it.
 *
 * Read-only: it reads seo_llm_mentions + seo_llm_mention_queries and writes
 * nothing. No HTTP, no model calls. Only `listing` and `editorial` pages are
 * ranked (ai-citation-classifier.js's ENQUEUABLE_CATEGORIES, the same set the
 * feeder sends to the registry); owned, competitor, reference and community
 * pages never are.
 *
 * Order (rankCitedPages):
 *   tier 1 — cited in a CURRENT provider answer ("who should I hire") that does
 *            not name Waves. Current = the dashboard's headline row: the newest
 *            answer per question and engine on the engine's current surface.
 *   tier 2 — cited in a current provider answer that does name Waves.
 *   tier 3 — everything else cited in the window.
 * Within a tier: more current misses first, then a priority city (owner O2
 * 2026-09-27: Sarasota, Bradenton, Venice, Parrish), then more current
 * citations, then more citations in the window, then the page key.
 */

const { classifyUrl, isProviderIntentQuestion, hasBestToken, ENQUEUABLE_CATEGORIES } = require('./ai-citation-classifier');
const { cleanUrls, isMeasuredAnswer } = require('./aeo-measurement');
const { LIVE_STATUSES } = require('./link-authority-selection');
const { isNeverTargetHost } = require('./link-registry');
const { canonicalProspectDomain } = require('./prospect-domain-lock');
const appScraper = require('./llm-app-scraper');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const benchmark = require('../../data/aeo-benchmark-v1.json');

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_LIMIT = 50;
// Owner O2 (2026-09-27): the cities that get service-page proof first.
const PRIORITY_CITIES = Object.freeze(['sarasota', 'bradenton', 'venice', 'parrish']);
// Tracking parameters engines and publishers append to the same article
// (ChatGPT adds ?utm_source=chatgpt.com): dropped from the page key so one
// article is one page.
const TRACKING_PARAM_RE = /^(utm_.*|srsltid|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src)$/i;

/**
 * pageKey(url) → 'host/path[?query]' | null. Canonical host (the registry's
 * canonicalProspectDomain, so www/mail. drop), lowercased
 * path without a trailing slash, tracking parameters and the fragment
 * dropped, remaining parameters sorted. Two URLs with the same key are the
 * same page.
 */
function pageKey(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const host = canonicalProspectDomain(u.hostname);
  const path = u.pathname.toLowerCase().replace(/\/+$/, '') || '';
  const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM_RE.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${path}${query}`;
}

// The URL to show for a page: the most-cited spelling, tracking parameters
// stripped, so a pitch or the panel never carries ?utm_source=chatgpt.com.
function displayUrl(urlString) {
  try {
    const u = new URL(urlString);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.href;
  } catch { return urlString; }
}

// A roundup of service providers, by its own path: companies, exterminators,
// pros, or a service Waves offers named as a service.
const PROVIDER_LIST_PATH_RE = /\b(compan(y|ies)|exterminators?|pros|contractors|providers?|services?|pest control|lawn care|mosquito control|termite control|rodent control)\b/;
// …and never a product roundup, even one naming a service ("best lawn care
// products", "top pest control sprays").
const PRODUCT_PATH_RE = /\b(products?|killers?|sprays?|repellents?|traps?|baits?|granules|fertilizers?|herbicides?|insecticides?|pesticides?|seeds?|mowers?|spreaders?|tools|equipment|devices?|gear|kits?|brands?|reviews?)\b/;
// …and never a how-to, cost or identification article ("pest control cost",
// "how to choose a pest control company", "signs of termites").
const ARTICLE_PATH_RE = /\b(costs?|prices?|pricing|how|what|why|when|diy|signs|identify|tips|vs|versus)\b/;
function isProviderListPath(words) {
  return PROVIDER_LIST_PATH_RE.test(words) && !PRODUCT_PATH_RE.test(words) && !ARTICLE_PATH_RE.test(words);
}

/**
 * isListPage(page, url) → whether the cited-page pitch fits this page. An
 * editorial page whose path is about service providers (not products, not a
 * cost or how-to article), read with tracking parameters stripped. A known
 * editorial site (the classifier's editorial domains: smarfle, floridist,
 * Today's Homeowner, local news) qualifies on that alone — owner 2026-10-01
 * "loosen the rule" (smarfle.com/fl/bradenton/pest-control was left out). An
 * unknown site the listicle heuristic promoted still needs a best / top /
 * rated / near-me word: a company's own service-area page
 * (greenteampest.com/service-areas/parrish) looks the same otherwise. Never a
 * directory: a /biz/ profile is one company, and a directory is joined by
 * signing up, not by a pitch.
 */
function isListPage(page, url) {
  if (page.category !== 'editorial' || !isProviderListPath(pathWords(url))) return false;
  return page.subtype !== 'listicle_candidate' || hasBestToken(displayUrl(url));
}
function pathWords(urlString) {
  try {
    const u = new URL(urlString);
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
    return path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  } catch { return ''; }
}

function isPriorityCity(city) {
  return PRIORITY_CITIES.includes(String(city || '').toLowerCase().replace(/,.*$/, '').trim());
}

/**
 * currentRowIds(rows, currentSurfaces) → Set of row ids that are headline
 * rows: newest per (query, platform, model) — rows are newest first — and,
 * for a two-surface platform, only its current surface's newest row per
 * question. The same selection llm-mention-prober.js's buildDashboard makes,
 * so "current" here means what the dashboard counts.
 */
function currentRowIds(rows, currentSurfaces) {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.query}::${row.llm_platform}::${row.model_version}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const seen = new Set();
  const ids = new Set();
  for (const row of latest.values()) {
    if (currentSurfaces && currentSurfaces[row.llm_platform]) {
      if (!appScraper.onCurrentSurface(row, currentSurfaces)) continue;
      const key = `${row.query}::${row.llm_platform}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    ids.add(row.id);
  }
  return ids;
}

// Question fields: the managed query row (operator-edited city/service) before
// the benchmark entry, as the feeder does.
function questionOf(row, queryById, benchmarkByQuery) {
  const managed = queryById.get(row.query_id);
  const bench = benchmarkByQuery.get(row.query);
  return {
    id: bench?.id || null,
    query: row.query,
    city: managed?.city || bench?.city || null,
    service: managed?.service || bench?.service || null,
    intent: bench?.intent || null,
  };
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function newPage(key, c) {
  return {
    key, host: c.host, category: c.category, subtype: c.subtype || null,
    urlCounts: new Map(), citations: 0, currentCitations: 0, currentMisses: 0, namedIn: 0,
    engines: new Set(), missEngines: new Set(), currentProviderNamed: 0, questions: new Map(),
  };
}

// One answer's citation of a page: `a` is { url, question, provider, isCurrent, named, engine }.
function addCitation(p, a) {
  p.citations += 1;
  p.urlCounts.set(a.url, (p.urlCounts.get(a.url) || 0) + 1);
  p.engines.add(a.engine);
  if (a.named) p.namedIn += 1;
  const qKey = a.question.id || a.question.query || '-';
  if (!p.questions.has(qKey)) p.questions.set(qKey, { ...a.question, provider: a.provider, current: false, miss: false, engines: new Set() });
  const q = p.questions.get(qKey);
  q.engines.add(a.engine);
  if (!a.isCurrent) return;
  p.currentCitations += 1;
  q.current = true;
  if (!a.provider) return;
  if (a.named) { p.currentProviderNamed += 1; return; }
  p.currentMisses += 1;
  p.missEngines.add(a.engine);
  q.miss = true;
}

function finalizePage({ urlCounts, currentProviderNamed, ...p }) {
  const [topUrl] = [...urlCounts].sort(([a, n], [b, m]) => m - n || compareStrings(a, b))[0];
  const questions = [...p.questions.values()]
    .map((q) => ({ ...q, engines: [...q.engines].sort() }))
    .sort((a, b) => Number(b.miss) - Number(a.miss) || Number(b.current) - Number(a.current) || compareStrings(a.id || a.query, b.id || b.query));
  return {
    ...p,
    url: displayUrl(topUrl),
    // evidence about the PAGE, not the question that cited it — a provider
    // roundup an editor can add Waves to (isListPage)
    listPage: isListPage(p, topUrl),
    tier: p.currentMisses > 0 ? 1 : currentProviderNamed > 0 ? 2 : 3,
    priorityCity: questions.some((q) => isPriorityCity(q.city)),
    engines: [...p.engines].sort(),
    missEngines: [...p.missEngines].sort(),
    questions,
  };
}

function comparePages(a, b) {
  return a.tier - b.tier
    || b.currentMisses - a.currentMisses
    || Number(b.priorityCity) - Number(a.priorityCity)
    || b.currentCitations - a.currentCitations
    || b.citations - a.citations
    || compareStrings(a.key, b.key);
}

/**
 * rankCitedPages(rows, queryRows, { currentSurfaces, limit }) → ranked pages.
 * Pure. `rows` are seo_llm_mentions rows, NEWEST FIRST (id, query, query_id,
 * llm_platform, model_version, check_date, cited_urls, waves_mentioned and
 * the measurement columns). Every row takes part in choosing the current
 * observation; only measured ones (isMeasuredAnswer) count as citations, so
 * a current answer that failed or could not resolve its sources is neither a
 * miss nor a citation. Each page:
 *   { key, url, host, category, subtype, listPage, tier, rank,
 *     citations, currentCitations, currentMisses, namedIn,
 *     engines, missEngines, priorityCity,
 *     questions: [{ id, query, city, service, intent, provider, current, miss, engines }] }
 * citations counts answers (one per question, engine and day) that cite the
 * page; currentMisses counts current provider answers citing it that do not
 * name Waves; namedIn counts citing answers in the window that name Waves.
 */
function rankCitedPages(rows, queryRows, { currentSurfaces = null, limit = DEFAULT_LIMIT } = {}) {
  const queryById = new Map((queryRows || []).map((q) => [q.id, q]));
  const benchmarkByQuery = new Map(benchmark.questions.map((q) => [q.query, q]));
  const current = currentRowIds(rows || [], currentSurfaces);
  // only measured rows are citations (every row still decides what is current)
  const answers = (rows || []).filter(isMeasuredAnswer).map((row) => {
    const question = questionOf(row, queryById, benchmarkByQuery);
    return { row, question, provider: isProviderIntentQuestion(question), urls: cleanUrls(row.cited_urls) };
  });
  // pass 1 — which pages are eligible: classified listing/editorial by ANY
  // citing answer (the listicle heuristic needs a provider question), once
  const eligible = new Map();
  for (const a of answers) {
    for (const url of a.urls) {
      const key = pageKey(url);
      if (!key || eligible.has(key)) continue;
      const c = classifyUrl(url, { providerIntent: a.provider });
      if (c && ENQUEUABLE_CATEGORIES.includes(c.category) && !isNeverTargetHost(c.host)) eligible.set(key, c);
    }
  }
  // pass 2 — every measured citation of an eligible page counts, whatever
  // question it answered; only a provider miss is intent-restricted (addCitation)
  const pages = new Map();
  for (const a of answers) {
    const answer = { question: a.question, provider: a.provider, isCurrent: current.has(a.row.id), named: a.row.waves_mentioned === true, engine: a.row.llm_platform || 'unknown' };
    // one answer citing the same page twice (with and without a tracking
    // parameter) is one citation
    const seenThisRow = new Set();
    for (const url of a.urls) {
      const key = pageKey(url);
      if (!eligible.has(key) || seenThisRow.has(key)) continue;
      seenThisRow.add(key);
      if (!pages.has(key)) pages.set(key, newPage(key, eligible.get(key)));
      addCitation(pages.get(key), { ...answer, url });
    }
  }
  return [...pages.values()].map(finalizePage).sort(comparePages)
    .slice(0, Math.max(0, limit)).map((p, i) => ({ ...p, rank: i + 1 }));
}

/**
 * readCitedPageRows(db, { since }) → EVERY mention row newest first (measured
 * or not), from active managed queries (or unmanaged legacy rows), since the
 * ET date. Unmeasured rows are kept so a failed newest probe stays the
 * current observation (as on the dashboard) instead of promoting an older
 * answer; only measured rows ever count as citations.
 */
async function readCitedPageRows(db, { since }) {
  return db('seo_llm_mentions as m')
    .leftJoin('seo_llm_mention_queries as q', 'm.query_id', 'q.id')
    .where('m.check_date', '>=', since)
    // a managed observation counts only while its query is active AND still
    // asks this prompt: an edited query's old answers are another question
    // (the dashboard matches on the current prompt text the same way)
    .where((b) => b.whereNull('m.query_id').orWhere((c) => c.where('q.active', true).whereRaw('q.query = m.query')))
    .orderBy('m.check_date', 'desc')
    .orderBy('m.created_at', 'desc')
    .select('m.id', 'm.query', 'm.query_id', 'm.llm_platform', 'm.model_version', 'm.check_date', 'm.cited_urls', 'm.waves_mentioned',
      'm.measurement_version', 'm.answer_available', 'm.citations_complete');
}

/**
 * loadCitedPages(db, { lookbackDays, limit, now, currentSurfaces })
 *   → { since, lookbackDays, scanned, pages }
 * `currentSurfaces` defaults to the prober's switch (LLM_MENTIONS_APP_SCRAPER).
 */
async function loadCitedPages(db, { lookbackDays = DEFAULT_LOOKBACK_DAYS, limit = DEFAULT_LIMIT, now = new Date(), currentSurfaces } = {}) {
  const days = Math.max(1, Math.floor(Number(lookbackDays)) || DEFAULT_LOOKBACK_DAYS);
  const since = etDateString(addETDays(now, -(days - 1)));
  const surfaces = currentSurfaces !== undefined ? currentSurfaces : require('./llm-mention-prober').currentSurfaces;
  const [rows, queryRows] = await Promise.all([
    readCitedPageRows(db, { since }),
    db('seo_llm_mention_queries').select('id', 'query', 'city', 'service', 'active'),
  ]);
  return { since, lookbackDays: days, scanned: rows.length, pages: rankCitedPages(rows, queryRows, { currentSurfaces: surfaces, limit }) };
}

// ---------------------------------------------------------------------------
// Placement recheck (owner 2026-10-01): once a placement on a cited page goes
// live, re-read the questions that cited that page. The prober already asks
// every benchmark question on every engine daily, so this reads what it
// stored — before vs. after the day the link was first seen live.
// ---------------------------------------------------------------------------

const RECHECK_BEFORE_DAYS = 30;
const RECHECK_SETTLE_DAYS = 14;
const RECHECK_MAX_PLACEMENT_AGE_DAYS = 120;

function emptyTally() {
  return { answers: 0, named: 0, citingPage: 0, namedWhenCiting: 0 };
}

// first_live_at's ET calendar day. A value at exactly UTC midnight is a
// date-only day (link-registry-baseline.js copies seo_backlinks.first_seen, a
// DATE, into it): that calendar day as written, never shifted to the ET day
// before.
function liveDateOf(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().endsWith('T00:00:00.000Z') ? d.toISOString().slice(0, 10) : etDateString(d);
}

function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);
}

/**
 * recheckPlacements(placements, rows, { now, currentSurfaces }) → [{ prospectId, host, liveOn,
 *   daysLive, pages, questions, before, after, verdict }]
 * Pure. `placements` are seo_link_prospects rows with first_live_at
 * (id, target_domain, live_url, first_live_at); `rows` are mention rows (any
 * order; only measured ones are read) covering RECHECK_BEFORE_DAYS before the oldest placement.
 * The page is the placement's own live_url; the questions are those whose
 * answers cited that exact page in the RECHECK_BEFORE_DAYS before the link
 * went live. before = those questions' answers in the
 * RECHECK_BEFORE_DAYS before; after = their answers from that day on.
 * verdict, in order, from `current` (the newest answer per question and
 * engine since): too_early (under RECHECK_SETTLE_DAYS live, or no answer
 * since) | named_when_cited (a newest answer cites the page and names Waves) |
 * page_not_cited_now | not_named_yet. A placement with no live_url, or on a
 * page no engine cited before that day, is not returned.
 */
// The placement's own page on its own host and the ET day it went live, or
// null when it cannot be rechecked: another page on the same site (a Yelp
// listing beside a cited Yelp search) is not this one.
function placementTarget(pl) {
  const host = canonicalProspectDomain(pl.target_domain);
  const liveOn = pl.first_live_at ? liveDateOf(pl.first_live_at) : null;
  const liveKey = pl.live_url ? pageKey(pl.live_url) : null;
  const onHost = liveKey && (liveKey === host || liveKey.startsWith(`${host}/`) || liveKey.startsWith(`${host}?`));
  return host && liveOn && onHost ? { host, liveOn, liveKey } : null;
}

// One tally over measured answers: how many, how many name Waves, how many
// cite the page, and how many do both.
function tallyAnswers(rows, cites) {
  const t = emptyTally();
  for (const r of rows) {
    const named = r.waves_mentioned === true;
    const cited = cites(r);
    t.answers += 1;
    t.named += Number(named);
    t.citingPage += Number(cited);
    t.namedWhenCiting += Number(named && cited);
  }
  return t;
}

// Settle first: one early answer is not a result. First match wins.
const RECHECK_VERDICTS = Object.freeze([
  ['too_early', ({ daysLive, current }) => daysLive < RECHECK_SETTLE_DAYS || current.answers === 0],
  ['named_when_cited', ({ current }) => current.namedWhenCiting > 0],
  // only when every engine that cited the page has a measured current answer:
  // an unresolved one may still cite it, so loss is never declared over it
  ['page_not_cited_now', ({ current, unresolved }) => current.citingPage === 0 && unresolved === 0],
  ['not_named_yet', () => true],
]);

function recheckPlacements(placements, rows, { now = new Date(), currentSurfaces = null } = {}) {
  const today = etDateString(now);
  const currentFrom = etDateString(addETDays(now, -(DEFAULT_LOOKBACK_DAYS - 1)));
  // every row, measured or not: a failed newest probe must stay the newest
  // answer for its question and engine; only measured rows are tallied
  const dated = (rows || []).map((r) => {
    const measured = isMeasuredAnswer(r);
    const date = String(r.check_date instanceof Date ? r.check_date.toISOString() : r.check_date).slice(0, 10);
    return { ...r, measured, date, keys: new Set(measured ? cleanUrls(r.cited_urls).map(pageKey).filter(Boolean) : []) };
  });
  const out = [];
  for (const pl of placements || []) {
    const target = placementTarget(pl);
    if (!target) continue;
    const { host, liveOn, liveKey } = target;
    // every placement gets its OWN window: the rows span the oldest
    // placement's, so a newer one must not take questions from before its own
    const windowStart = etDateString(addETDays(new Date(`${liveOn}T12:00:00Z`), -RECHECK_BEFORE_DAYS));
    const cites = (r) => r.keys.has(liveKey);
    const pairOf = (r) => `${r.query}::${r.llm_platform}`;
    const questions = new Set(dated.filter((r) => r.date >= windowStart && r.date < liveOn && cites(r)).map((r) => r.query));
    if (!questions.size) continue; // engines did not cite this page in the window before the link went live
    const asked = dated.filter((r) => questions.has(r.query) && r.date >= windowStart);
    // before/after are cumulative, for context; the verdict reads `current`:
    // the dashboard's own selection over the answers since (newest per
    // question, engine and model, current surface only). A current answer that
    // failed or could not resolve its sources says nothing either way: it is
    // left out, never replaced by an older one.
    const since = asked.filter((r) => r.date >= liveOn).sort((x, y) => compareStrings(y.date, x.date));
    // current = the dashboard's window too: a retired model's answer from
    // months ago is history, not the engine's answer now
    const currentIds = currentRowIds(since.filter((r) => r.date >= currentFrom), currentSurfaces);
    // …then ONE answer per question and engine, the newest: a retired model's
    // older answer never stands beside its replacement's (since is newest first)
    const newestPerPair = new Map();
    for (const r of since) if (currentIds.has(r.id) && !newestPerPair.has(pairOf(r))) newestPerPair.set(pairOf(r), r);
    const newest = [...newestPerPair.values()];
    const tallies = {
      before: tallyAnswers(asked.filter((r) => r.measured && r.date < liveOn), cites),
      after: tallyAnswers(since.filter((r) => r.measured), cites),
      current: tallyAnswers(newest.filter((r) => r.measured), cites),
    };
    // every question and engine that cited the page before the link went live
    // must have a measured current answer before loss can be declared: a
    // failed newest probe, or no answer at all in the window, is unresolved
    const expected = new Set(asked.filter((r) => r.measured && r.date < liveOn && cites(r)).map(pairOf));
    const answered = new Set(newest.filter((r) => r.measured).map(pairOf));
    const unresolved = [...expected].filter((k) => !answered.has(k)).length;
    const daysLive = daysBetween(liveOn, today);
    const [verdict] = RECHECK_VERDICTS.find(([, test]) => test({ daysLive, current: tallies.current, unresolved }));
    out.push({ prospectId: pl.id, host, liveOn, daysLive, page: liveKey, questions: [...questions].sort(), ...tallies, unresolved, verdict });
  }
  return out.sort((a, b) => compareStrings(b.liveOn, a.liveOn) || compareStrings(a.host, b.host));
}

/**
 * loadPlacementRechecks(db, { now }) → recheckPlacements over every placement
 * still live (live / indexed) and first seen live in the last
 * RECHECK_MAX_PLACEMENT_AGE_DAYS.
 */
async function loadPlacementRechecks(db, { now = new Date(), currentSurfaces } = {}) {
  const oldest = addETDays(now, -RECHECK_MAX_PLACEMENT_AGE_DAYS);
  const placements = await db('seo_link_prospects')
    .whereIn('status', LIVE_STATUSES) // a lost placement keeps first_live_at; it is no longer live
    .whereNotNull('first_live_at').where('first_live_at', '>=', oldest)
    .select('id', 'target_domain', 'live_url', 'first_live_at');
  if (!placements.length) return [];
  const earliest = placements.reduce((m, p) => (new Date(p.first_live_at) < m ? new Date(p.first_live_at) : m), now);
  const since = etDateString(addETDays(earliest, -RECHECK_BEFORE_DAYS));
  const rows = await readCitedPageRows(db, { since });
  const surfaces = currentSurfaces !== undefined ? currentSurfaces : require('./llm-mention-prober').currentSurfaces;
  return recheckPlacements(placements, rows, { now, currentSurfaces: surfaces });
}

module.exports = {
  rankCitedPages, loadCitedPages, readCitedPageRows, pageKey, displayUrl, currentRowIds, isPriorityCity,
  recheckPlacements, loadPlacementRechecks,
  PRIORITY_CITIES, DEFAULT_LOOKBACK_DAYS, DEFAULT_LIMIT, RECHECK_BEFORE_DAYS, RECHECK_SETTLE_DAYS,
};
