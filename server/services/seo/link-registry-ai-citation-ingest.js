/**
 * Backlink Manager v2 — weekly `ai_citation` discovery feeder (AEO brief
 * 2026-09-27). Follows link-registry-gap-ingest.js's shape: a service-only
 * dedupe through ensureDomain, never HTTP, never enrichment.
 *
 * Reads the last N days (default 30) of MEASURED seo_llm_mentions rows — v2,
 * answer_available, citations_complete (aeo-measurement.js's isMeasuredAnswer
 * contract) — and classifies every cited URL with ai-citation-classifier.js.
 * Only `listing` + `editorial` candidates are sent to the registry with
 * source 'ai_citation'; `owned` / `reference` / `competitor` /
 * `community_video` / `other` are counted in the run summary but NEVER
 * enqueued (community/video are human-only tracks; the rest simply aren't
 * link-discovery targets for this feeder).
 *
 * DISCOVERY NEVER GRANTS AUTHORITY (owner ruling 2026-09-27): a domain whose
 * first touch is `ai_citation` never earns AUTO_FREE / AUTO_ACCOUNT /
 * AUTO_OUTREACH / AUTO_PAID_WITHIN_POLICY — enforced in
 * link-authority-policy.js's decideAuthority (the bridge's decision) and
 * link-execution-authority.js's authorize() (the signup runner's claim), NOT
 * here; this module only ever writes the registry touch through the same
 * ensureDomain() every other feeder uses, so an existing domain's first-touch
 * source (discovered earlier by a real feeder) is never overwritten — the
 * ai_citation evidence lands as its own `seo_link_domain_sources` touch row
 * instead.
 *
 * citationDetail() (Codex P1 2026-09-28, third round) writes a NEW domain's
 * first-touch `source_detail` starting with link-authority-policy.js's own
 * `AI_CITATION_SOURCE_DETAIL_PREFIX` (`ai_citation:<category>[:<subtype>]
 * <sample cited urls>`) — imported, never re-typed, so the two modules can
 * never drift apart. That prefix is isDiscoveryOnlyDomain's PRIMARY durable
 * signal: unlike `source` (which a rollback migration can relabel) or
 * `enrichment` (which the weekly DataForSEO enrich job replaces wholesale),
 * NOTHING in this codebase ever rewrites an existing domain's source_detail
 * once ensureDomain sets it at INSERT time. The embedded sample URLs are
 * ALSO what link-path-investigator.js's provenance-hint extraction
 * (`touchUrls`, a plain `https?://…` regex over source_detail) reads, so an
 * investigation of one of these domains fetches the EXACT page an answer
 * engine cited, not just the homepage.
 *
 * Own hosts and never-target hosts are skipped (defense in depth — the
 * classifier already routes wavespestcontrol.com/the spoke fleet to `owned`,
 * this catches anything isNeverTargetHost also knows about). No credits
 * spent; the only I/O is reading seo_llm_mentions / seo_llm_mention_queries
 * and, live, writing seo_link_domains / seo_link_domain_sources.
 *
 * Gated by GATE_SEO_INTELLIGENCE, same convention as the neighboring Sunday
 * registry feeders (link-registry-enrich.js): off ⇒ zero reads, zero writes.
 */

const { isEnabled } = require('../../config/feature-gates');
const { ensureDomain, isNeverTargetHost, touchKey } = require('./link-registry');
const { classifyUrl, isLocallyRelevant, isProviderIntentQuestion, ENQUEUABLE_CATEGORIES } = require('./ai-citation-classifier');
const { AI_CITATION_SOURCE_DETAIL_PREFIX } = require('./link-authority-policy');
const { MEASUREMENT_VERSION, cleanUrls } = require('./aeo-measurement');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const benchmark = require('../../data/aeo-benchmark-v1.json');

const SOURCE = 'ai_citation';
const DEFAULT_LOOKBACK_DAYS = 30;
// The ONE bound on a touch's source_detail size: at most this many complete
// cited URLs per (host, category), deduped. Codex P1 2026-09-28 (round 5):
// the label is NEVER cut by character count — a character cap dropped every
// cited page (even a later short one) as soon as the first URL was long,
// losing exactly the exact-page hints link-path-investigator.js's
// `touchUrls` reads. The stored source_detail column is `text` on both
// seo_link_domains and seo_link_domain_sources (backlink_registry_step1
// migration; nothing alters it since), and link-registry.js's touchKey()
// already swaps an over-120-char detail for a fixed-length sha256 digest in
// the (domain_id, touch_key) btree, so a long label is bounded where it
// matters (the index entry) while the full detail is kept.
const MAX_SAMPLE_URLS = 5;

/**
 * sinceDate(now, lookbackDays) → 'YYYY-MM-DD', the OLDEST Eastern calendar
 * day in the window (inclusive). seo_llm_mentions.check_date is an ET
 * calendar DATE, so the cutoff is one too (Codex P1 2026-09-28, round 5): a
 * fixed 24h-multiple subtracted from `now` is a UTC instant, and between
 * 00:00 UTC and ET midnight (or across a DST change) the oldest ET day would
 * slide in or out of the window depending on the run time. Same convention
 * as llm-mention-prober.js's getDashboard — N ET days INCLUDING today, so
 * the default 30 reads today plus the 29 ET days before it. A non-positive
 * lookback still reads today.
 */
function sinceDate(now, lookbackDays) {
  const days = Math.max(1, Math.floor(Number(lookbackDays)) || 1);
  return etDateString(addETDays(now, -(days - 1)));
}

/**
 * aggregateCitations(rows, queryRows) → [{ host, category, rule, subtype,
 *   citationCount, sampleUrls, platforms, locallyRelevant,
 *   questions: [{id,query,city,service,intent}] }]
 * Pure — no I/O, no clock. `rows` are already-fetched seo_llm_mentions rows
 * (id, query, query_id, llm_platform, cited_urls); `queryRows` is the full
 * seo_llm_mention_queries table (id, query, city, service, active). Every
 * question a domain was cited under is attached, deduped by benchmark id (or
 * the raw query text when it isn't a benchmark question).
 *
 * Each citation's classification is passed `providerIntent` —
 * isProviderIntentQuestion() on THIS citation's own question — so
 * ai-citation-classifier.js's listicle heuristic (owner review 2026-09-28)
 * can promote an otherwise-`other` local/best-token URL to `editorial` with
 * `subtype: 'listicle_candidate'` when, and only when, it was cited
 * answering a provider ("who/best/top/company") question.
 *
 * Aggregated by (host, category) — NEVER by host alone (Codex P1
 * 2026-09-28): classifyUrl is deterministic per URL, but a single host CAN
 * legitimately carry citations under two different categories (a Forbes
 * `/sites/...` article beside a `/home-improvement/...` one; a Facebook
 * profile post beside its business Page). Grouping by host alone would make
 * the aggregate's category depend on which URL this run happened to see
 * first — order-dependent output from an input with no ordering guarantee,
 * and it would silently fold an ineligible URL's evidence into an eligible
 * category (or the reverse). Keeping (host, category) separate is exact
 * regardless of row order, and the one place that cares about "the same
 * host twice" (ensureDomain) is naturally idempotent about it.
 */
// Where each attached question field comes from, in precedence order: the
// managed query row (operator-edited city/service) before the benchmark
// entry; the query text is the mention row's own.
const QUESTION_FIELD_SOURCES = Object.freeze({
  id: ['benchmark'], query: ['row'], city: ['managed', 'benchmark'], service: ['managed', 'benchmark'], intent: ['benchmark'],
});

function aggregateCitations(rows, queryRows) {
  const queryById = new Map((queryRows || []).map((q) => [q.id, q]));
  const benchmarkByQuery = new Map(benchmark.questions.map((q) => [q.query, q]));
  const groups = new Map();
  for (const row of rows || []) {
    const from = { row, managed: queryById.get(row.query_id), benchmark: benchmarkByQuery.get(row.query) };
    const question = Object.fromEntries(Object.entries(QUESTION_FIELD_SOURCES)
      .map(([field, sources]) => [field, sources.map((src) => from[src]?.[field]).find(Boolean) || null]));
    const providerIntent = isProviderIntentQuestion(question);
    for (const url of cleanUrls(row.cited_urls)) {
      const c = classifyUrl(url, { providerIntent });
      if (!c) continue; // unparseable — never counted, never enqueued
      const key = `${c.host}::${c.category}`;
      // subtype is fixed per (host, category): only the listicle heuristic
      // sets one, and it only ever runs for a host no rule matched
      if (!groups.has(key)) {
        groups.set(key, {
          host: c.host, category: c.category, rule: c.rule, subtype: c.subtype || null, citationCount: 0,
          urlCounts: new Map(), platforms: new Set(), locallyRelevant: false, questions: new Map(),
        });
      }
      const agg = groups.get(key);
      agg.citationCount += 1;
      agg.urlCounts.set(url, (agg.urlCounts.get(url) || 0) + 1);
      agg.platforms.add(row.llm_platform || 'unknown');
      agg.locallyRelevant ||= isLocallyRelevant(url);
      const qKey = question.id || question.query || '-';
      if (!agg.questions.has(qKey)) agg.questions.set(qKey, question);
    }
  }
  // The sample is chosen AFTER aggregation — most-cited first, then URL
  // order — so the same evidence read in any row order yields the same
  // citationDetail and therefore the same touch_key; encounter order made
  // repeated runs insert duplicate touches (Codex P2 2026-09-28, round 6).
  return [...groups.values()].map(({ urlCounts, ...d }) => ({
    ...d,
    sampleUrls: [...urlCounts]
      .sort(([urlA, countA], [urlB, countB]) => countB - countA || (urlA < urlB ? -1 : urlA > urlB ? 1 : 0))
      .slice(0, MAX_SAMPLE_URLS)
      .map(([url]) => url),
    platforms: [...d.platforms].sort(),
    questions: [...d.questions.values()],
  }));
}

/**
 * readMeasuredMentions(db, { since }) → the measured rows this feeder
 * classifies. `since` is an ET 'YYYY-MM-DD' (sinceDate).
 *
 * Honors the managed-query admin toggle (Codex P2 2026-09-28, round 5),
 * mirroring gsc-opportunity-miner.js's mineAeoGaps: history from a managed
 * query an operator has DEACTIVATED is dropped (LLMMentionProber.getQueries
 * treats the managed list as authoritative, so a disabled query must stop
 * feeding the registry too), while unmanaged/legacy rows (null query_id)
 * have no toggle and are kept.
 */
async function readMeasuredMentions(db, { since }) {
  return db('seo_llm_mentions as m')
    .leftJoin('seo_llm_mention_queries as q', 'm.query_id', 'q.id')
    .where({ 'm.measurement_version': MEASUREMENT_VERSION, 'm.answer_available': true, 'm.citations_complete': true })
    .where('m.check_date', '>=', since)
    .whereNotNull('m.cited_urls')
    .where((b) => b.whereNull('m.query_id').orWhere('q.active', true))
    .select('m.id', 'm.query', 'm.query_id', 'm.llm_platform', 'm.check_date', 'm.cited_urls');
}

/**
 * The evidence label every ai_citation touch carries (never the domain's
 * identity): `ai_citation:<category>[:<subtype>] <sample cited urls…>`.
 * ALWAYS starts with AI_CITATION_SOURCE_DETAIL_PREFIX — that prefix is what
 * isDiscoveryOnlyDomain reads on a domain's FIRST-touch source_detail (set
 * once by ensureDomain, never rewritten) as its durable discovery-only
 * signal. Every sampled URL, complete and untruncated — the list is bounded
 * by COUNT (MAX_SAMPLE_URLS, in aggregateCitations), never by characters;
 * see MAX_SAMPLE_URLS for why the length is safe. A category+subtype alone
 * (none sampled) still starts with the prefix.
 */
function citationDetail(d) {
  const label = `${AI_CITATION_SOURCE_DETAIL_PREFIX}${d.category}${d.subtype ? `:${d.subtype}` : ''}`;
  const urls = (d.sampleUrls || []).slice(0, MAX_SAMPLE_URLS);
  return urls.length ? `${label} ${urls.join(' ')}` : label;
}

/**
 * runAiCitationFeeder(db, { dryRun, lookbackDays, now })
 *   → { gated, dryRun, scanned, domains, byCategory: {category: n}, enqueued,
 *       inserted, touched, existing, candidates: [{domain, category, rule, subtype,
 *       citationCount, platforms, sampleUrls, locallyRelevant, questions, existing?}] }
 * - scanned: measured seo_llm_mentions rows read.
 * - domains: distinct (host, category) pairs classified (every category, owned
 *   included — a host cited under two categories counts as two here).
 * - byCategory: a count per category — the run's classification summary.
 * - enqueued: how many (listing + editorial) candidates this run sends/would send.
 * - dryRun: reads seo_link_domains + seo_link_domain_sources to report the
 *   same inserted / existing / touched totals a live run would; no writes.
 * - Otherwise every candidate goes through ensureDomain in ONE transaction.
 */
async function runAiCitationFeeder(db, { dryRun = false, lookbackDays = DEFAULT_LOOKBACK_DAYS, now = new Date() } = {}) {
  const out = {
    gated: !isEnabled('seoIntelligence'), dryRun, scanned: 0, domains: 0, byCategory: {},
    enqueued: 0, inserted: 0, touched: 0, existing: 0, candidates: [],
  };
  if (out.gated) return out;

  const since = sinceDate(now, lookbackDays);
  const [rows, queryRows] = await Promise.all([
    readMeasuredMentions(db, { since }),
    db('seo_llm_mention_queries').select('id', 'query', 'city', 'service', 'active'),
  ]);
  out.scanned = rows.length;

  const aggregated = aggregateCitations(rows, queryRows);
  out.domains = aggregated.length;
  for (const d of aggregated) out.byCategory[d.category] = (out.byCategory[d.category] || 0) + 1;

  const enqueueable = aggregated.filter((d) => ENQUEUABLE_CATEGORIES.includes(d.category) && !isNeverTargetHost(d.host));
  out.enqueued = enqueueable.length;
  out.candidates = enqueueable.map((d) => ({
    domain: d.host, category: d.category, rule: d.rule, subtype: d.subtype || null, citationCount: d.citationCount,
    platforms: d.platforms, sampleUrls: d.sampleUrls, locallyRelevant: d.locallyRelevant, questions: d.questions,
  }));
  if (!enqueueable.length) return out;

  if (dryRun) {
    // Codex P2 2026-09-28: a host can legitimately appear in `enqueueable`
    // more than once (a domain cited under two different enqueueable
    // categories — e.g. facebook.com's own business Page vs. a provider-
    // intent-heuristic-promoted post — aggregateCitations groups by (host,
    // category), never by host alone, on purpose: see its own header). A
    // LIVE run's ensureDomain calls are sequential and see each other: the
    // first call on a brand-new host creates it, so a second call for the
    // SAME host within the same run finds it existing. Deciding each
    // candidate's `existing` flag independently off the pre-run `known` set
    // — as a naive whereIn + filter would — reports that same host as
    // "inserted" on EVERY occurrence, double- (or N-) counting it and
    // disagreeing with what a live run actually does. `countedThisRun`
    // reproduces the live sequencing: the first occurrence of a host decides
    // against the DB snapshot; every later occurrence of the SAME host in
    // this preview is always `existing` (the hypothetical insert from its
    // first occurrence would already have happened by then).
    //
    // Codex P2 2026-09-28 (round 8): `touched` mirrors the live count too.
    // A live ensureDomain on an EXISTING domain reports touched when its
    // (domain_id, touch_key) row is new — so each candidate's key is derived
    // with link-registry's own touchKey() (the exact function ensureDomain
    // uses, never a copy) and looked up in seo_link_domain_sources, plus
    // the keys this preview's earlier candidates would already have written.
    // Still read-only: two whereIn reads, no writes.
    const hosts = [...new Set(enqueueable.map((d) => d.host))];
    const known = await db('seo_link_domains').select('id', 'domain').whereIn('domain', hosts);
    const idByDomain = new Map(known.map((k) => [k.domain, k.id]));
    const keyOf = (d) => touchKey(SOURCE, null, citationDetail(d));
    const knownIds = [...idByDomain.values()];
    const existingTouches = knownIds.length
      ? await db('seo_link_domain_sources').select('domain_id', 'touch_key')
        .whereIn('domain_id', knownIds).whereIn('touch_key', [...new Set(enqueueable.map(keyOf))])
      : [];
    const domainById = new Map(known.map((k) => [k.id, k.domain]));
    const touchSeen = new Set(existingTouches.map((t) => `${domainById.get(t.domain_id)}\n${t.touch_key}`));
    const countedThisRun = new Set();
    enqueueable.forEach((d, i) => {
      const c = out.candidates[i];
      const touch = `${d.host}\n${keyOf(d)}`;
      c.existing = countedThisRun.has(d.host) || idByDomain.has(d.host);
      countedThisRun.add(d.host);
      if (!c.existing) out.inserted += 1;
      else {
        out.existing += 1;
        if (!touchSeen.has(touch)) out.touched += 1;
      }
      touchSeen.add(touch);
    });
    return out;
  }

  await db.transaction(async (trx) => {
    for (const d of enqueueable) {
      const r = await ensureDomain(trx, { domain: d.host, source: SOURCE, sourceDetail: citationDetail(d), sourceRef: null, seenAt: now });
      if (r.created) out.inserted += 1;
      else {
        out.existing += 1;
        if (r.touched) out.touched += 1;
      }
    }
  });
  return out;
}

module.exports = {
  runAiCitationFeeder, aggregateCitations, readMeasuredMentions, citationDetail, sinceDate,
  SOURCE, DEFAULT_LOOKBACK_DAYS,
};
