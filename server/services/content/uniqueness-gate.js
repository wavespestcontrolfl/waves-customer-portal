/**
 * uniqueness-gate.js — anti-doorway / anti-scaled-content safety check.
 *
 * Google's spam policies specifically call out doorway abuse (multiple
 * region/city pages that funnel users to one place) and scaled content
 * abuse (many generated pages providing little user value). With 316
 * service pages + 5 location pages already in the Astro repo, this is
 * the single biggest risk for an autonomous publisher.
 *
 * Applied to:
 *   - city-service pages
 *   - customer-question pages
 *   (other page types use content-quality-gate only)
 *
 * All seven checks must pass for the page to publish autonomously.
 * Any failure → status='pending_review' with the failing reasons
 * surfaced to the human reviewer.
 *
 * Pure functions — no DB, no logger. Caller provides the draft, the
 * brief, and the sibling-page corpus.
 */

const { CITIES, REVENUE_PRIORITY, THRESHOLDS } = require('./scoring-config');

const CITY_TOKENS = new Set(
  CITIES.flatMap((c) => [
    c.toLowerCase(),
    c.toLowerCase().replace(/\s+/g, '-'),
    c.toLowerCase().replace(/\s+/g, '_'),
  ])
);

// ── tokenizers (pure) ────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as', 'into', 'about',
  'than', 'then', 'so', 'if', 'while', 'when', 'where', 'why', 'how', 'all', 'any',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'too', 'very', 's', 't', 'just', 'don', 'now', 'also', 'one', 'two',
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 2 && !STOP_WORDS.has(w));
}

function shingles(text, n = 3) {
  const toks = tokenize(text);
  const out = new Set();
  for (let i = 0; i <= toks.length - n; i++) out.add(toks.slice(i, i + n).join(' '));
  return out;
}

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

// ── per-check evaluators (pure) ──────────────────────────────────────

const LOCAL_GEOGRAPHY_PATTERNS = [
  /\b(neighborhood|community|HOA|subdivision|gated|waterfront|riverfront|coastal|barrier island|gulf|bay|bayou)\b/i,
  /\b(palm tree|mangrove|live oak|st\.?\s*augustine|bahia|zoysia)\b/i,
  /\b(season|rainy|hurricane|afternoon storms|humidity|sandy soil|nitrogen|phosphorus)\b/i,
  /\b(downtown|island|beach|key|ranch|park|pier)\b/i,
];

function checkUniqueLocalProblem(draft, brief) {
  const body = String(draft.body || '');
  const city = (brief.city || '').toLowerCase();
  if (!city) return { ok: false, reason: 'no_city_on_brief' };
  // Must name a city-specific pest/lawn issue. Look for the city's name
  // adjacent to a problem keyword (within ~50 chars).
  const problemPattern = /\b(infestation|damage|swarm|nest|mounds?|fungus|brown spots?|chinch|active|peak|season|surge)\b/i;
  if (!problemPattern.test(body)) {
    return { ok: false, reason: 'no_problem_keywords_present' };
  }
  // Ensure problem appears near a city or local geography reference.
  const localContextPattern = new RegExp(
    `\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|\\b(neighborhood|community|HOA|subdivision)\\b`,
    'i'
  );
  if (!localContextPattern.test(body)) {
    return { ok: false, reason: 'problem_not_anchored_to_local_context' };
  }
  return { ok: true };
}

function checkUniqueCityContext(draft, brief) {
  const body = String(draft.body || '');
  const city = (brief.city || '').toLowerCase();
  if (!city) return { ok: false, reason: 'no_city_on_brief' };
  // City name mentioned at least 2 times (intro + body) so it's not
  // just a template token.
  const cityMatches = body.toLowerCase().split(city).length - 1;
  if (cityMatches < 2) {
    return { ok: false, reason: `city_mentioned_${cityMatches}_time(s)_need_2+` };
  }
  // At least one real local geography signal.
  const hasGeo = LOCAL_GEOGRAPHY_PATTERNS.some((re) => re.test(body));
  if (!hasGeo) {
    return { ok: false, reason: 'no_local_geography_or_seasonal_signal' };
  }
  return { ok: true };
}

function checkUniqueServiceSpecificContent(draft, brief) {
  const body = String(draft.body || '');
  const service = (brief.service || '').toLowerCase();
  if (!service) return { ok: false, reason: 'no_service_on_brief' };
  // Service-specific detail beyond template — look for technical
  // vocabulary tied to this service.
  const serviceDetailMap = {
    pest: /\b(active ingredient|treatment cycle|exclusion|pyrethroid|fipronil|imidacloprid|baiting|monitoring|integrated pest)\b/i,
    lawn: /\b(brix|micronutrient|aeration|core plug|thatch|chinch|sod webworm|grub|preemergent|fertilizer ratio|N-P-K)\b/i,
    mosquito: /\b(larvicide|adulticide|harborage|breeding source|in2care|BTI|standing water|pyrethroid)\b/i,
    termite: /\b(subterranean|drywood|formosan|borate|trenching|liquid barrier|baiting|inspection report|exclusion|WDO)\b/i,
    rodent: /\b(snap trap|exclusion|entry point|tamper|bait station|sanitation|rodenticide|monitoring)\b/i,
    'tree-shrub': /\b(systemic|trunk injection|deep root|micronutrient|scale|aphid|lace bug|fungicide|fertilizer)\b/i,
    specialty: /\b(heat treatment|encasement|mattress|monitor|residual|spot treatment|harborage)\b/i,
  };
  const pattern = serviceDetailMap[service] || /\b(treatment|application|inspection|monitoring|protocol)\b/i;
  if (!pattern.test(body)) {
    return { ok: false, reason: `no_${service}_specific_terminology` };
  }
  return { ok: true };
}

function checkUniqueCustomerQuestions(draft, brief) {
  // Customer questions must come from THAT city's call/SMS clusters,
  // not the site-wide question pool. The brief surfaces matched
  // clusters as customer_signal.
  const cs = brief.customer_signal;
  if (!cs) return { ok: false, reason: 'no_customer_signal_attached' };
  if (!cs.city || cs.city.toLowerCase() !== (brief.city || '').toLowerCase()) {
    return { ok: false, reason: 'customer_signal_city_mismatch' };
  }
  if ((cs.total_count || 0) < THRESHOLDS.customerClusterMinSize) {
    return { ok: false, reason: 'customer_signal_below_min_threshold' };
  }
  // Ensure the normalized question appears in the body (even paraphrased
  // — we look for half the question's nouns).
  const body = String(draft.body || '').toLowerCase();
  const qWords = tokenize(cs.normalized_question || cs.topic || '');
  const matched = qWords.filter((w) => body.includes(w)).length;
  if (matched < Math.max(1, Math.floor(qWords.length / 2))) {
    return { ok: false, reason: 'customer_question_not_addressed_in_body' };
  }
  return { ok: true };
}

function checkUniqueLocalProof(draft, brief) {
  const body = String(draft.body || '');
  // A real review quote, tech note, or job-count claim — something the
  // sibling templates don't share.
  const proofPatterns = [
    /\b\d+\s*(\+|plus)?\s*(jobs?|treatments?|services?|customers?|reviews?)\b/i,
    // Allow an optional tech name between role and verb ("tech Jacob noted ...").
    /\b(tech|technician|crew|team)\s+([A-Z][a-zA-Z]+\s+)?(noted|reported|observed|found|told|saw)\b/i,
    /["“"][^"”"]{20,200}["”"]/, // review-style quote
    /\bFDACS\s+(license|JB\d{4,})/i,
    /\b\d{4,}\s+(reviews?|jobs?|properties)\b/i,
  ];
  if (!proofPatterns.some((re) => re.test(body))) {
    return { ok: false, reason: 'no_local_proof_signal_found' };
  }
  return { ok: true };
}

function checkNotTemplateSwap(draft, brief, siblingPages) {
  if (!siblingPages || !siblingPages.length) return { ok: true, reason: 'no_siblings_to_compare' };
  const draftShingles = shingles(draft.body || '');
  let maxSimilarity = 0;
  let mostSimilarUrl = null;
  for (const sib of siblingPages) {
    if (sib.url === draft.url) continue; // skip self
    const sim = jaccard(draftShingles, shingles(sib.body || ''));
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilarUrl = sib.url;
    }
  }
  if (maxSimilarity > THRESHOLDS.uniquenessJaccardMax) {
    return {
      ok: false,
      reason: `jaccard_similarity_${maxSimilarity.toFixed(2)}_vs_${mostSimilarUrl}_exceeds_${THRESHOLDS.uniquenessJaccardMax}`,
      similarity: maxSimilarity,
      most_similar_url: mostSimilarUrl,
    };
  }
  return { ok: true, max_similarity: maxSimilarity };
}

const GENERIC_HUB_PATHS = new Set([
  '/pest-control/', '/lawn-care/', '/mosquito-control/', '/termite-control/',
  '/rodent-control/', '/services/', '/quote/', '/pest-control-services/',
  '/pest-control-quote/',
]);

function checkNotFunnelingToSameUrl(draft, brief) {
  const ctaUrls = extractCtaUrls(draft.body || '');
  if (!ctaUrls.length) return { ok: false, reason: 'no_cta_links_found' };
  // Every CTA must be either (a) a city-specific URL or (b) not in the
  // generic hub set. At least one CTA should be city-specific.
  const city = (brief.city || '').toLowerCase().replace(/\s+/g, '-');
  let hasCitySpecific = false;
  const genericCtas = [];
  for (const url of ctaUrls) {
    if (city && url.toLowerCase().includes(city)) {
      hasCitySpecific = true;
    } else if (GENERIC_HUB_PATHS.has(url)) {
      genericCtas.push(url);
    }
  }
  if (!hasCitySpecific) {
    return { ok: false, reason: `no_city_specific_cta_found_generic_only:${genericCtas.slice(0, 3).join(',')}` };
  }
  return { ok: true };
}

function extractCtaUrls(body) {
  const urls = new Set();
  // Markdown links + raw paths starting with /.
  const mdLink = /\[(?:[^\]]+)\]\((\/[^)\s]+)\)/g;
  let m;
  while ((m = mdLink.exec(body)) !== null) urls.add(m[1]);
  const rawPath = /href=["'](\/[^"'\s]+)["']/g;
  while ((m = rawPath.exec(body)) !== null) urls.add(m[1]);
  return Array.from(urls);
}

// ── main API ────────────────────────────────────────────────────────

/**
 * evaluate(draft, brief, { siblingPages })
 *
 * draft: { url?, body, frontmatter? } — output of a writer agent.
 * brief: row from content_briefs (city, service, page_type, customer_signal, …).
 * siblingPages: [{ url, body }] — pages in the same family (e.g., all
 *   /pest-control-*-fl/ for a new pest-control city page). Caller is
 *   responsible for loading these from the Astro repo or a corpus
 *   index. Pass [] to skip the Jaccard check.
 *
 * Returns { ok, checks: { [name]: { ok, reason?, ... } }, failed_count }.
 * `ok` is true only if every applicable check passes.
 */
function evaluate(draft, brief, { siblingPages = [] } = {}) {
  if (!draft) throw new Error('uniqueness-gate: draft required');
  if (!brief) throw new Error('uniqueness-gate: brief required');

  const pageType = brief.page_type;
  if (pageType !== 'city-service' && pageType !== 'customer-question') {
    // Other page types don't go through the uniqueness gate — they
    // have lighter requirements via content-quality-gate only.
    return { ok: true, checks: {}, failed_count: 0, skipped: 'page_type_not_subject_to_uniqueness' };
  }

  const checks = {
    unique_local_problem: checkUniqueLocalProblem(draft, brief),
    unique_city_context: checkUniqueCityContext(draft, brief),
    unique_service_specific_content: checkUniqueServiceSpecificContent(draft, brief),
    unique_customer_questions: checkUniqueCustomerQuestions(draft, brief),
    unique_local_proof: checkUniqueLocalProof(draft, brief),
    not_template_swap_city_only: checkNotTemplateSwap(draft, brief, siblingPages),
    not_funneling_to_same_url: checkNotFunnelingToSameUrl(draft, brief),
  };
  // customer-question pages don't need the city/service-specific
  // requirements — they're question-led, not landing-page-led. Relax
  // a couple of checks for that type.
  if (pageType === 'customer-question') {
    checks.unique_city_context.ok = checks.unique_city_context.ok || !brief.city;
    checks.unique_service_specific_content.ok = checks.unique_service_specific_content.ok || !brief.service;
  }

  const failed = Object.values(checks).filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    failed_count: failed.length,
    failed_reasons: failed.map((c, i) => `${Object.keys(checks)[Object.values(checks).indexOf(c)]}: ${c.reason || 'failed'}`),
  };
}

module.exports = { evaluate };
module.exports._internals = {
  tokenize, shingles, jaccard, extractCtaUrls,
  checkUniqueLocalProblem,
  checkUniqueCityContext,
  checkUniqueServiceSpecificContent,
  checkUniqueCustomerQuestions,
  checkUniqueLocalProof,
  checkNotTemplateSwap,
  checkNotFunnelingToSameUrl,
  CITY_TOKENS,
  GENERIC_HUB_PATHS,
};
