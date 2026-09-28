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
 * (source_detail carries the category/count/platforms/question), which is
 * exactly the "add evidence without overwriting provenance" the brief asks
 * for (ensureDomain's own contract, link-registry.js).
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
const { ensureDomain, isNeverTargetHost } = require('./link-registry');
const { classifyUrl, isLocallyRelevant, ENQUEUABLE_CATEGORIES } = require('./ai-citation-classifier');
const { MEASUREMENT_VERSION, cleanUrls } = require('./aeo-measurement');
const benchmark = require('../../data/aeo-benchmark-v1.json');

const SOURCE = 'ai_citation';
const SOURCE_DETAIL = 'ai_citation_feeder';
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_SAMPLE_URLS = 5;
// The touch's source_detail sits in link-registry.js's TOUCH_DETAIL_MAX (120
// chars) bounded btree entry — kept well under it so it never gets replaced
// by the sha256 digest fallback (that fallback is for a pasted URL, not a
// short evidence label).
const TOUCH_DETAIL_MAX = 120;

function sinceDate(now, lookbackDays) {
  return new Date(now.getTime() - Math.max(1, lookbackDays) * 24 * 60 * 60e3);
}

/**
 * aggregateCitations(rows, queryRows) → [{ host, category, rule, citationCount,
 *   sampleUrls, platforms, locallyRelevant, questions: [{id,query,city,service,intent}] }]
 * Pure — no I/O, no clock. `rows` are already-fetched seo_llm_mentions rows
 * (id, query, query_id, llm_platform, cited_urls); `queryRows` is the full
 * seo_llm_mention_queries table (id, query, city, service, active). Every
 * question a domain was cited under is attached, deduped by benchmark id (or
 * the raw query text when it isn't a benchmark question).
 */
function aggregateCitations(rows, queryRows) {
  const queryById = new Map((queryRows || []).map((q) => [q.id, q]));
  const benchmarkByQuery = new Map(benchmark.questions.map((q) => [q.query, q]));
  const domains = new Map();
  for (const row of rows || []) {
    const urls = cleanUrls(row.cited_urls);
    if (!urls.length) continue;
    const managed = row.query_id ? queryById.get(row.query_id) : null;
    const bm = benchmarkByQuery.get(row.query);
    const question = {
      id: (bm && bm.id) || null,
      query: row.query || null,
      city: (managed && managed.city) || (bm && bm.city) || null,
      service: (managed && managed.service) || (bm && bm.service) || null,
      intent: (bm && bm.intent) || null,
    };
    for (const url of urls) {
      const c = classifyUrl(url);
      if (!c) continue; // unparseable — never counted, never enqueued
      if (!domains.has(c.host)) {
        domains.set(c.host, {
          host: c.host, category: c.category, rule: c.rule, citationCount: 0,
          sampleUrls: [], platforms: new Set(), locallyRelevant: false, questions: new Map(),
        });
      }
      const agg = domains.get(c.host);
      agg.citationCount += 1;
      if (agg.sampleUrls.length < MAX_SAMPLE_URLS && !agg.sampleUrls.includes(url)) agg.sampleUrls.push(url);
      agg.platforms.add(row.llm_platform || 'unknown');
      if (!agg.locallyRelevant && isLocallyRelevant(url)) agg.locallyRelevant = true;
      const qKey = question.id || question.query || '-';
      if (!agg.questions.has(qKey)) agg.questions.set(qKey, question);
    }
  }
  return [...domains.values()].map((d) => ({ ...d, platforms: [...d.platforms].sort(), questions: [...d.questions.values()] }));
}

/** readMeasuredMentions(db, { since }) → the measured rows this feeder classifies. */
async function readMeasuredMentions(db, { since }) {
  return db('seo_llm_mentions')
    .where({ measurement_version: MEASUREMENT_VERSION, answer_available: true, citations_complete: true })
    .where('check_date', '>=', since)
    .whereNotNull('cited_urls')
    .select('id', 'query', 'query_id', 'llm_platform', 'check_date', 'cited_urls');
}

/** The bounded evidence label every ai_citation touch carries (never the domain's identity). */
function citationDetail(d) {
  const q = d.questions[0];
  const qLabel = q ? String(q.id || q.query || '').slice(0, 40) : '';
  const local = d.locallyRelevant ? ' · local' : '';
  const label = `${SOURCE_DETAIL} · ${d.category} · ${d.citationCount}x · ${d.platforms.join('/')}${qLabel ? ` · ${qLabel}` : ''}${local}`;
  return label.slice(0, TOUCH_DETAIL_MAX);
}

/**
 * runAiCitationFeeder(db, { dryRun, lookbackDays, now })
 *   → { gated, dryRun, scanned, domains, byCategory: {category: n}, enqueued,
 *       inserted, touched, existing, candidates: [{domain, category, rule,
 *       citationCount, platforms, sampleUrls, locallyRelevant, questions, existing?}] }
 * - scanned: measured seo_llm_mentions rows read.
 * - domains: distinct cited hosts classified (every category, owned included).
 * - byCategory: a count per category — the run's classification summary.
 * - enqueued: how many (listing + editorial) candidates this run sends/would send.
 * - dryRun: one whereIn on seo_link_domains to split would-insert vs existing; no writes.
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
    domain: d.host, category: d.category, rule: d.rule, citationCount: d.citationCount,
    platforms: d.platforms, sampleUrls: d.sampleUrls, locallyRelevant: d.locallyRelevant, questions: d.questions,
  }));
  if (!enqueueable.length) return out;

  if (dryRun) {
    const known = await db('seo_link_domains').select('domain').whereIn('domain', enqueueable.map((d) => d.host));
    const knownSet = new Set(known.map((k) => k.domain));
    out.inserted = enqueueable.filter((d) => !knownSet.has(d.host)).length;
    out.existing = enqueueable.length - out.inserted;
    for (const c of out.candidates) c.existing = knownSet.has(c.domain);
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
  SOURCE, SOURCE_DETAIL, DEFAULT_LOOKBACK_DAYS,
};
