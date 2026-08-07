/**
 * content-brief-builder.js — orchestrator that takes one opportunity
 * off the queue, gathers SERP + customer + conversion signals, runs
 * the decision router, composes the full brief, and persists it.
 *
 * This is the seam where the four miners (GSC opp, SERP profiler,
 * customer insights, conversion feedback) become one engine. The
 * writer agents (later phases) consume content_briefs rows as their
 * single source of truth.
 *
 * compose() is read-only-friendly when persist=false — used by the
 * preview CLI so Adam can see "if we ran the engine right now, here's
 * what brief #1 would look like" without writing anything.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { THRESHOLDS } = require('./scoring-config');
const { buildSeoRequirements } = require('./blog-seo-contract');
const {
  isFaqBlockedService, PAGE_CITY_SLUGS, ALLOWED_INTERNAL_LINKS, isKnownGoodInternalRoute,
} = require('./content-guardrails');
// "List-shaped" detection is shared with the miner's listicle_family bucket
// (single grammar — a mined listicle opportunity must actually receive the
// overlay). Never fork a private copy of the regexes here.
const { isListicleQuery } = require('./listicle-query');
const { isEnabled } = require('../../config/feature-gates');

const queue = require('./opportunity-queue');
const router = require('./decision-router');
const factsSufficiency = require('./facts-sufficiency');
const factsLoader = require('../content-astro/facts-bank-loader');
const interceptSeeder = require('./intercept-brief-seeder');
const spokeSeeder = require('./spoke-seed-seeder');
const categorySeeder = require('./category-seed-seeder');

// ── keyword overlap helpers for customer-cluster topic match ────────

const KEYWORD_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with',
  'of', 'is', 'are', 'do', 'does', 'how', 'what', 'why', 'when', 'where',
  'my', 'your', 'our', 'this', 'that', 'near', 'me', 'us', 'pest',
  // 'pest' is too generic to be a useful topic-match anchor — it's
  // already the dominant service in the brief; topic match should pull
  // on more specific words.
]);

function extractKeywords(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !KEYWORD_STOP_WORDS.has(w))
  );
}

function sharesKeyword(clusterText, opportunityKeywords) {
  if (!opportunityKeywords.size) return false;
  const clusterWords = extractKeywords(clusterText);
  for (const w of clusterWords) {
    if (opportunityKeywords.has(w)) return true;
  }
  return false;
}

// Lazily-loaded dependencies — these may not all exist on every
// branch in the stack, so we defer until first use.
function lazy(name, path) {
  let mod;
  return () => {
    if (mod === undefined) {
      try { mod = require(path); }
      catch (err) { logger.warn(`[brief-builder] ${name} unavailable: ${err.message}`); mod = null; }
    }
    return mod;
  };
}
const getSerpProfiler = lazy('serp-profiler', '../seo/serp-profiler');
const getConversionMiner = lazy('conversion-feedback-miner', '../seo/conversion-feedback-miner');

// ── required-sections matrix (per page-type, per v3.1 brief schema) ─

const REQUIRED_SECTIONS = {
  'city-service': [
    'local intro',
    'services offered',
    'common pests in this city',
    'same-day / free inspection CTA',
    'what to expect',
    'pricing / estimate language',
    'reviews or trust proof',
    'FAQ from customer calls',
    'internal links',
  ],
  'customer-question': [
    'answer in first paragraph',
    'short explanation with local context',
    'when to call a pro',
    'related questions',
    'source / internal link',
  ],
  'supporting-blog': [
    'hub link in intro',
    'one city mention (or generic SWFL framing)',
    'early CTA within first 25% of article',
    '2+ H2 sections',
    'pro-tip callout',
    'pest-practices homeowner guidance',
    'FAQ section (2–3 questions)',
    'final CTA to relevant city/service page',
  ],
  refresh: [
    'preserve existing slug',
    'add 1+ new section reflecting current data',
    'update dateModified',
    'refresh CTAs to current promo',
  ],
  metadata: [
    'rewrite title (60 char target)',
    'rewrite meta_description (155 char target)',
    'no body changes',
  ],
  links: ['add internal links from sibling pages to the target URL'],
  gbp: ['short post body', 'CTA link', 'optional image'],
  none: [],
};

const SCHEMA_TYPES = {
  'city-service': ['LocalBusiness', 'Service', 'BreadcrumbList'],
  'customer-question': ['WebPage', 'Article', 'BreadcrumbList'],
  'supporting-blog': ['Article', 'BreadcrumbList'],
  refresh: [], // preserve existing
  metadata: [],
  links: [],
  gbp: [],
  none: [],
};

const WORD_COUNT_TARGET = {
  'city-service': '900-1500',
  'customer-question': '600-900',
  'supporting-blog': '900-1500',
  refresh: 'intent-complete (delta-only)',
  metadata: 'n/a',
  links: 'n/a',
  gbp: '150-300 chars',
  none: 'n/a',
};

const VOICE_CONSTRAINTS = {
  tone: 'casual, technically knowledgeable, slightly snarky SWFL neighbor',
  forbidden: [
    'corporate boilerplate',
    'hardcoded prices (link to /pest-control-calculator/ instead)',
    'verbatim customer quotes from SMS/call sources',
    '"nitrogen blackout" without mentioning phosphorus restriction',
  ],
  required_phrases: [
    'reference SWFL conditions (sandy soil, afternoon storms, St. Augustine)',
    'use "you" and "your" naturally',
  ],
};

// Answer-engine (AEO) treatment. When a brief originates from an aeo_gap
// opportunity — a city×service that answer engines (ChatGPT/Gemini/Claude/AI
// Overview) are NOT citing Waves for — overlay extractability requirements so
// the page can actually be quoted: a self-contained direct-answer block up top,
// an explicit FAQ section, and FAQPage schema. The seo-completion-gate then
// enforces that requesting FAQPage means a visible FAQ exists, so this is
// self-reinforcing. Inert outside aeo_gap (gated upstream by GATE_AEO_GAP_MINING).
//
// customer-question is intentionally EXCLUDED: that contract already answers
// the question in the first paragraph (direct answer is built in) and forbids
// FAQPage schema (deprecated May 2026, per writer-agent-config + quality-gate).
const AEO_TREATED_PAGE_TYPES = new Set([
  'city-service', 'supporting-blog', 'refresh',
]);

function applyAeoTreatment({ isAeoGap, pageType, requiredSections, schemaTypes, voiceConstraints }) {
  if (!isAeoGap || !AEO_TREATED_PAGE_TYPES.has(pageType)) {
    return { requiredSections, schemaTypes, voiceConstraints };
  }
  const sections = [...requiredSections];
  if (!sections.some((s) => /direct-answer/i.test(s))) {
    sections.unshift(
      'direct-answer block (40–60 words, self-contained, answers the core query in the opening — written to be quoted verbatim by an answer engine)'
    );
  }
  if (!sections.some((s) => /\bFAQ\b/i.test(s))) {
    sections.push('FAQ section (3–5 Q/A pairs phrased exactly how a SWFL homeowner would ask an AI assistant)');
  }
  const schema = Array.from(new Set([...schemaTypes, 'FAQPage']));
  const voice = {
    ...voiceConstraints,
    aeo_notes: [
      'Name Waves Pest Control in one unambiguous sentence near the top (licensed/insured SWFL pest & lawn company) so the entity is clear to an answer engine.',
      'Answer the core question in the first 1–2 sentences — direct answer before context.',
      'Write self-contained, factual sentences (no "as mentioned above") so any paragraph stands alone when extracted.',
    ],
  };
  return { requiredSections: sections, schemaTypes: schema, voiceConstraints: voice };
}

// Listicle overlay (GATE_LISTICLE_BRIEFS, opt-in every env). When a
// supporting-blog brief's target query is list-shaped ("signs of…", "10
// natural…"), layer the citable-listicle architecture on top of the normal
// supporting-blog contract: exact count in the title, one numbered H2 per
// item, a quick-answer summary in the first 60 words, a sourced "how we put
// this together" note, a visible dated line, FAQPage schema (the visible FAQ
// is already in the supporting-blog contract), a per-item concrete-figure
// note, and — for question-shaped queries — question-form item headings.
// List-format pages are the most-cited content class in answer engines
// (Ahrefs 2026 citation study), and the same structural rules lift
// informational lists. Deliberately
// INFORMATIONAL-ONLY: ranked vendor roundups stay out of the blog lane
// (operator directive — the router's terminal near-me guard already parks
// transactional queries), so "best company" intent never reaches this
// overlay, and the voice notes forbid ranking companies outright.
const LISTICLE_ELIGIBLE_PAGE_TYPES = new Set(['supporting-blog']);

// Question-shaped list queries ("what are the signs of termites") get a
// question-header variant: each numbered H2 is phrased as the exact
// sub-question that item answers, so the heading itself matches how the
// query was asked. Interrogative-lead only — a bare noun query ("signs of
// termites") keeps declarative headings.
const LISTICLE_QUESTION_RE = /^\s*(what|why|which|how|when|where|is|are|can|do|does|should)\b/i;

function applyListicleTreatment({ enabled, actionType, pageType, query, operatorPinned = false, requiredSections, schemaTypes, voiceConstraints }) {
  // New MINED drafts only:
  // - a refresh whose SERP type normalizes to supporting-blog must never
  //   receive restructure-the-title/H2 mandates (preserve slug + structure);
  // - operator-pinned briefs (intercept / spoke-seed) inject a human-authored
  //   outline VERBATIM — a list-shaped keyword must not force that outline
  //   into a numbered-list structure the operator didn't write.
  if (!enabled || operatorPinned || actionType !== 'new_supporting_blog' || !LISTICLE_ELIGIBLE_PAGE_TYPES.has(pageType) || !isListicleQuery(query)) {
    return { requiredSections, schemaTypes, voiceConstraints, listicle: false };
  }
  // required_sections is an ORDERED plan for the writer — the above-the-fold
  // constraints (title structure, 60-word quick answer, dated line) go FIRST
  // so they can't be buried under the body/FAQ/CTA sections; the sourced
  // methodology note reads naturally after the list body, so it appends.
  const questionShaped = LISTICLE_QUESTION_RE.test(String(query));
  const sections = [
    'listicle structure: exact item count in the title (e.g. "7 Signs of Termite Damage in Bradenton Homes"), one numbered H2 per item, and the same internal shape for every item (what it is → why it matters in SWFL → what to do)',
    ...(questionShaped ? [
      'question-form item headings: the query is question-shaped, so phrase each numbered H2 as the exact sub-question that item answers, the way a SWFL homeowner would ask it (e.g. "3. Are Mud Tubes on the Foundation a Termite Sign?") — keep the leading number, and the first sentence under each heading answers its question directly',
    ] : []),
    'quick-answer summary inside the first 60 words that names every list item in one scannable sentence or tight list',
    'visible "Last updated: [Month Year]" line under the title — use the current month and year (the publisher stamps frontmatter `updated` to the PR-open date, so month+year granularity stays consistent with it; never an older or invented date)',
    ...requiredSections,
    '"how we put this list together" note (2–3 sentences grounded in the brief\'s facts pack, naming sources in PLAIN TEXT only — no external links (off-fleet links are rejected by the publish guardrail), and never an invented methodology)',
  ];
  const voice = {
    ...voiceConstraints,
    listicle_notes: [
      'The item count in the title MUST equal the number of numbered H2 sections — recount before finishing.',
      "Each item's first sentence is self-contained and declarative so it can be quoted standalone by an answer engine.",
      'No filler between an item heading and its answer — the payoff sentence comes first, color commentary after.',
      'Anchor each item with one concrete figure from the brief\'s facts pack or a brief-named source (a measurement, timeframe, temperature, count) where one exists — answer engines cite numbers over vague claims. NEVER invent a figure, and never a dollar amount (cost questions link /pest-control-calculator/ instead).',
      'This is an informational list, never a ranked vendor roundup — do not rank or compare companies.',
    ],
  };
  // The supporting-blog contract already requires a visible FAQ section, so
  // requesting FAQPage schema here keeps seo-completion-gate's
  // FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ invariant satisfied; answer engines parse
  // FAQPage regardless of Google's rich-result deprecation (same reasoning as
  // the AEO overlay, which may have added it already — the Set dedupes).
  // FAQ-blocked services are handled downstream: _composeBrief runs
  // stripFaqRequirements AFTER this overlay, removing both the section and
  // the schema type.
  const schema = Array.from(new Set([...schemaTypes, 'FAQPage']));
  return { requiredSections: sections, schemaTypes: schema, voiceConstraints: voice, listicle: true };
}

// NO-FAQ policy at the BRIEF level. FAQ-blocked topics (content-guardrails.
// isFaqBlockedService — the same single-sourced policy module the publish-time
// P0 enforces and the generators condition on) must not receive a brief that
// requires an FAQ section or FAQPage schema: the generators now correctly omit
// the FAQ, so a leftover "FAQ section (…)" required_section would trip
// seo-completion-gate's P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ (and at the
// live AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0 canary config route a compliant
// no-FAQ draft out of publish), and a leftover FAQPage schema_type would P0
// as FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ. Applied AFTER the AEO overlay so the
// aeo_gap FAQ/FAQPage additions are stripped too.
const FAQ_SECTION_RE = /\bfaq\b|frequently asked|common questions/i;

// A prior draft of this opportunity was rejected by a HARD content gate and
// the runner deferred it for exactly one feedback-informed redraft
// (autonomous-runner._gateFailRetryOrSkip). Translate the recorded findings
// into binding writer directives; known codes get a corrective instruction,
// unknown ones fall back to the gate's own finding text. Rides in
// voice_constraints.retry_directives (persisted jsonb → returned intact by
// the writer agent's get_content_brief tool).
const GATE_RETRY_INSTRUCTIONS = {
  HARDCODED_PRICE: 'Do NOT write any specific dollar amount or price anywhere in the draft — link /pest-control-calculator/ wherever cost comes up.',
  FAQ_BLOCKED_SERVICE: 'Do NOT include an FAQ section or FAQ-style Q&A for this service — FAQ treatment is policy-blocked for it. Cover the material as normal prose sections instead.',
  DISALLOWED_EXTERNAL_LINK: 'Only link external domains from the approved source list already cited in the brief/facts pack; remove every other external link.',
  COMPARISON_DISPARAGEMENT: 'Remove all negative or disparaging language about named businesses; comparisons must be neutral and factual.',
  COMPARISON_UNCLASSIFIED_OPTION: 'Every comparison-table option must be either a generic category (no business names) or a competitor from the curated allowlist — replace unlisted names with generic categories.',
};

function buildRetryDirectives(gateRetry) {
  const findings = Array.isArray(gateRetry?.findings) ? gateRetry.findings : [];
  const directives = findings.map((f) => GATE_RETRY_INSTRUCTIONS[f.code]
    || `Previous draft failed ${f.severity || 'P0'} ${f.code || 'gate check'}${f.message ? `: ${f.message}` : ''} — do not repeat it.`);
  return [
    'PREVIOUS ATTEMPT REJECTED by hard content gates. This is the final attempt — the draft is discarded (never published, never reviewed) if any of these repeat:',
    ...Array.from(new Set(directives)),
  ];
}

function stripFaqRequirements({ requiredSections, schemaTypes }) {
  return {
    requiredSections: requiredSections.filter((s) => !FAQ_SECTION_RE.test(String(s || ''))),
    schemaTypes: schemaTypes.filter((t) => !/^faqpage$/i.test(String(t || '').trim())),
  };
}

// Canonical URL slug component per service for city-service pages.
// pest → "pest-control" (so URL is /pest-control-bradenton-fl/)
// lawn → "lawn-care" (NOT lawn-control — that's not a real page)
const SERVICE_CITY_SLUG = {
  pest: 'pest-control',
  lawn: 'lawn-care',
  mosquito: 'mosquito-control',
  termite: 'termite-control',
  rodent: 'rodent-control',
  // tree-shrub DOES ship city pages — as `tree-and-shrub-care-{city}-fl`, not
  // the `tree-shrub-care` spelling this map keys on, which is why it read as
  // "no city-service slug" for so long. All eight PAGE_CITY_SLUGS cities
  // return 200 (verified 2026-07-29), and the slug is already in
  // CITY_SERVICE_LINK_RE, so these links pass the route gate. This is the real
  // tree-shrub target now that the dead /tree-shrub-care/ hub route is gone.
  'tree-shrub': 'tree-and-shrub-care',
  // specialty: no canonical city-service slug pattern; hub link only.
};

// Every route here must be a REAL page. A brief's internal_links_to_add is a
// binding writer instruction that content-guardrails threads in as a per-draft
// route allowance, so a dead entry doesn't just slip past the dead-link gate —
// it INSTRUCTS the writer to add the dead link and then exempts it. The city
// links below have been validated against PAGE_CITY_SLUGS since the start for
// exactly this reason ("a served town without a page would make the brief
// mandate a dead link"); the hub links were not, and carried four 404s
// (/lawn-care/, /mosquito-control/, /rodent-control/, /tree-shrub-care/ —
// bare hub pages that do not exist; only city-scoped ones do). Verified
// against the live hub 2026-07-29, and now enforced by the assertion below
// plus a unit test rather than by comment.
const SERVICE_HUB_LINKS = {
  pest: ['/pest-control-services/', '/waveguard-memberships/', '/pest-library/'],
  // Hubless, like tree-shrub: there is no lawn-wide hub page. The Manatee-county
  // fertilizer-blackout guide used to stand in here, but once checkHubLinkPresent
  // became service-specific that made a county-specific blog post the ONE accepted
  // hub link for every lawn topic — irrelevant for most Sarasota/Venice and
  // non-fertilizer subjects, and an active nudge toward putting Manatee blackout
  // dates in the wrong locale (Sarasota county's differ). It stays on the
  // guardrail allowlist, so a Manatee fertilizer post can still link it; it is
  // just no longer mandated. Lawn city pages are real for all eight cities
  // (/lawn-care-{city}-fl/, verified 200 on 2026-07-29) and satisfy the gate via
  // the hubless carve-out.
  lawn: [],
  mosquito: ['/pest-control-services/'],
  termite: ['/termite-inspection/'],
  rodent: ['/pest-control-services/', '/pest-library/'],
  // No hub-level tree & shrub page exists — and this must stay EMPTY rather
  // than borrow a conversion route. checkHubLinkPresent builds ONE accepted set
  // from every value in this map, so putting /contact/ here would let a
  // supporting blog for ANY service satisfy the relevant-hub hard check with a
  // generic contact CTA (caught by the pre-push Codex audit on this change).
  // Conversion routes belong in SERVICE_CONVERSION_LINK only. Tree & shrub gets
  // its real local page via SERVICE_CITY_SLUG above; a city-less tree-shrub
  // supporting blog therefore has no hub link and will park on
  // hub_link_present — fail-closed and visible, which is the right outcome
  // until there's a real hub page to point at (owner call, not this change's).
  'tree-shrub': [],
  specialty: ['/pest-control-services/'],
};

// Fail LOUD at require time if a hub link is not on the guardrail allowlist.
// The allowlist is the single source of route truth (same posture as
// PAGE_CITY_SLUGS for city links), so drift can only mean one of the two
// lists is wrong — and a dead mandated link is invisible until a published
// post 404s. A boot crash is the cheap failure; a silent dead link is not.
{
  const allowed = new Set(ALLOWED_INTERNAL_LINKS);
  const dead = [...new Set(Object.values(SERVICE_HUB_LINKS).flat())].filter((l) => !allowed.has(l));
  if (dead.length) {
    throw new Error(`SERVICE_HUB_LINKS contains route(s) missing from the content-guardrails allowlist: ${dead.join(', ')} — add the real route to ALLOWED_INTERNAL_LINKS (after verifying it returns 200) or point the vertical at a page that exists.`);
  }
}

// The SEO completion gate P1s a supporting-blog draft whose body has no
// conversion link (/contact | *quote* | *estimate* | calculator), but the
// checklist below never carried one — the writer only passed when it
// improvised. Lawn/tree-shrub have no calculator flow, so they use /contact/.
const SERVICE_CONVERSION_LINK = {
  pest: '/pest-control-calculator/',
  termite: '/pest-control-calculator/',
  mosquito: '/pest-control-calculator/',
  rodent: '/pest-control-calculator/',
  specialty: '/pest-control-calculator/',
  lawn: '/contact/',
  'tree-shrub': '/contact/',
};

// Verbatim facts-bank service ids the miner may emit unmapped
// (facts-sufficiency KNOWN_SERVICE_IDS). Normalized ONCE in
// _internalLinksFor so ALL three link maps (hubs, city slug, conversion)
// resolve — aliasing only the conversion map left those opportunities
// missing their mandatory service/city checklist links.
// commercial-lawn / commercial-pest are DELIBERATELY absent: commercial is
// a different funnel (no residential calculator, its own pricing rules) —
// mapping it to residential hubs needs an owner call, not a default.
const SERVICE_ID_ALIASES = {
  'pest-control': 'pest',
  'lawn-care': 'lawn',
  'tree-shrub-care': 'tree-shrub',
  'bed-bug': 'pest',
  'cockroach': 'pest',
  'pest-inspection': 'pest',
  'termite-inspection': 'termite',
  'lawn-aeration': 'lawn',
  'lawn-fertilization': 'lawn',
  'lawn-weed-control': 'lawn',
  'lawn-pest-control': 'lawn',
};

// ── main API ────────────────────────────────────────────────────────

class ContentBriefBuilder {
  /**
   * Compose a brief for a specific opportunity (does not claim).
   * persist=true writes to content_briefs as a new version.
   */
  async compose(opportunityId, { persist = true, skipSerp = false } = {}) {
    const opp = await queue.getById(opportunityId);
    if (!opp) throw new Error(`opportunity ${opportunityId} not found`);

    // Operator-pinned intercept briefs skip signal gathering entirely: the
    // operator manifest IS the signal (decision-router pins the action
    // regardless), SERP profiling competitor-brand keywords burns API spend
    // for data the router must ignore, and a stray customer-cluster topic
    // match could misclassify the FAQ policy for a consumer-protection post.
    const operatorPinned = interceptSeeder.isOperatorIntercept(opp);
    const signals = operatorPinned
      ? { serp_profile: null, customer_signal: null, conversion_feedback: null }
      : await this._gatherSignals(opp, { skipSerp });
    const existingBriefVersions = await this._countExistingBriefs(opp.id);

    const decision = router.route(opp, { ...signals, existing_brief_versions: existingBriefVersions });

    // Facts pack — the verified facts-bank facts the writer agent may cite.
    // Only assembled for facts-gated content actions with a city × service.
    const factsPack = await this._loadFactsPack(opp, decision).catch((err) => {
      logger.warn(`[brief-builder] facts pack load failed: ${err.message}`);
      return null;
    });

    const brief = this._composeBrief({ opportunity: opp, signals, decision, existingBriefVersions, factsPack });
    if (persist) brief.id = await this._persist(brief);
    return brief;
  }

  /**
   * Compose briefs for the top-N pending opportunities. Inspection
   * only — uses peek() instead of claim().
   */
  async previewTop({ limit = 5, minScore = null, persist = false, skipSerp = true } = {}) {
    const opps = await queue.peek({ limit, minScore });
    const out = [];
    for (const o of opps) {
      try {
        const brief = await this.compose(o.id, { persist, skipSerp });
        out.push({ ...brief, _opportunity: o });
      } catch (err) {
        out.push({ _opportunity: o, error: err.message });
      }
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────

  async _gatherSignals(opportunity, { skipSerp }) {
    const out = { serp_profile: null, customer_signal: null, conversion_feedback: null };

    // SERP profile — keyword-driven. Skip when no query (page-only
    // buckets like decay_refresh don't need SERP profile).
    if (!skipSerp && opportunity.query) {
      const serpProfiler = getSerpProfiler();
      if (serpProfiler) {
        try {
          out.serp_profile = await serpProfiler.profile({
            query: opportunity.query,
            city: opportunity.city || null,
            device: 'mobile',
            persist: false,
          });
        } catch (err) {
          logger.warn(`[brief-builder] SERP profile failed for "${opportunity.query}": ${err.message}`);
        }
      }
    }

    // Customer-insight cluster — match topic-ish keywords against
    // the opportunity's query / service / city.
    out.customer_signal = await this._matchCustomerCluster(opportunity).catch((err) => {
      logger.warn(`[brief-builder] customer cluster lookup failed: ${err.message}`);
      return null;
    });

    // Conversion feedback for this (city, service).
    if (opportunity.service || opportunity.city) {
      const conv = getConversionMiner();
      if (conv?.lookup) {
        try {
          out.conversion_feedback = await conv.lookup({
            city: opportunity.city || null,
            service: opportunity.service || null,
            windowDays: 90,
            maxAgeDays: 14,
          });
        } catch (err) {
          logger.warn(`[brief-builder] conversion lookup failed: ${err.message}`);
        }
      }
    }
    return out;
  }

  async _matchCustomerCluster(opportunity) {
    if (!opportunity.service && !opportunity.city) return null;
    // Recency filter: stale clusters can hold a misleading high
    // total_count long past their useful window. customerClusterRecencyDays
    // is the cap that customer-insights-miner uses on the read side too.
    const sinceLastSeen = new Date(
      Date.now() - THRESHOLDS.customerClusterRecencyDays * 86400_000
    );
    let q = db('customer_insight_clusters').orderBy('total_count', 'desc');
    if (opportunity.city) q = q.where('city', opportunity.city);
    if (opportunity.service) q = q.where('service', opportunity.service);
    q = q.where('last_seen', '>=', sinceLastSeen);

    // Topic match: when the opportunity has a query/keyword, prefer
    // clusters whose topic / normalized_question shares a content word
    // with it. Without this, the highest-total cluster for the (city,
    // service) pair gets attached even if the topic is unrelated —
    // can incorrectly boost customerDemand and reroute new_supporting_blog
    // → create_customer_question_page on a mismatched question.
    const rows = await q.limit(20).select('*');
    if (!rows.length) return null;
    const opportunityKeywords = extractKeywords(opportunity.query || opportunity.target_keyword || '');

    let chosen = null;
    if (opportunityKeywords.size > 0) {
      for (const r of rows) {
        const clusterText = `${r.topic || ''} ${r.normalized_question || ''}`;
        if (sharesKeyword(clusterText, opportunityKeywords)) { chosen = r; break; }
      }
    }
    // If nothing topic-matched, fall back to the highest-count cluster
    // for this (city, service) pair — only when the opportunity itself
    // doesn't carry a discernible topic (e.g. local_gap or refresh of
    // a generic page).
    if (!chosen && opportunityKeywords.size === 0) chosen = rows[0];
    if (!chosen) return null;

    return {
      ...chosen,
      source_counts: typeof chosen.source_counts === 'string'
        ? JSON.parse(chosen.source_counts)
        : (chosen.source_counts || {}),
    };
  }

  async _countExistingBriefs(opportunityId) {
    try {
      const r = await db('content_briefs').where('opportunity_id', opportunityId).count('* as c').first();
      return parseInt(r?.c || 0, 10);
    } catch {
      return 0;
    }
  }

  /**
   * Assemble the facts pack for a facts-gated city × service action. Returns
   * null when the action isn't facts-gated or the city/service can't be
   * mapped.
   *
   * The pack contains ONLY copy-usable facts (public, public_copy_allowed,
   * copy-safe evidence, in-TTL). This MUST match what claims-ledger-validator
   * indexes (also `purpose: 'copy'`): the agent is told it may cite only
   * facts_pack ids, so handing it prompt-only / internal facts would invite
   * citations the validator then rejects, and risk non-public facts reaching
   * body copy. Prompt-only context facts are intentionally excluded.
   */
  async _loadFactsPack(opportunity, decision) {
    const actionType = decision?.action_type || opportunity.action_type;
    if (!factsSufficiency.FACTS_GATED_ACTIONS.has(actionType)) return null;

    const cityId = factsSufficiency.normalizeCityId(opportunity.city);
    const serviceId = factsSufficiency.normalizeServiceId(opportunity.service);
    if (!cityId || !serviceId) return null;

    const cityFile = await factsLoader.loadCity(cityId);
    const serviceFile = await factsLoader.loadService(serviceId);
    const countyId = cityFile?.county || null;
    const countyFile = countyId ? await factsLoader.loadCounty(countyId) : null;

    const pack = (file, id) => {
      if (!file || file.ok === false) return { id, facts: [] };
      // purpose:'copy' + PAGE_COPY_CONTEXTS — citeable, publishable facts
      // scoped to contexts a city/service page covers (aligns exactly with the
      // claims-ledger validator's index, via the shared constant).
      const facts = factsLoader.usableFacts(file, { purpose: 'copy', contexts: factsLoader.PAGE_COPY_CONTEXTS })
        .map((f) => ({ id: f.id, type: f.type, value: f.value, evidence_strength: f.evidence_strength, allowed_contexts: f.allowed_contexts || [] }));
      return { id, facts, internal_links: file.internal_links || {} };
    };

    const allowed = [];
    const disallowed = [];
    for (const file of [cityFile, serviceFile, countyFile]) {
      if (!file || file.ok === false) continue;
      for (const p of file.allowed_claim_patterns || []) allowed.push(p);
      for (const p of file.disallowed_claim_patterns || []) disallowed.push(p);
    }

    return {
      city: pack(cityFile, cityId),
      service: pack(serviceFile, serviceId),
      county: countyFile ? pack(countyFile, countyId) : null,
      allowed_claim_patterns: allowed,
      disallowed_claim_patterns: disallowed,
    };
  }

  _composeBrief({ opportunity, signals, decision, existingBriefVersions, factsPack = null }) {
    const pageType = decision.page_type;

    // Overlay answer-engine extractability requirements for aeo_gap briefs.
    const aeo = applyAeoTreatment({
      isAeoGap: opportunity.bucket === 'aeo_gap',
      pageType,
      requiredSections: REQUIRED_SECTIONS[pageType] || [],
      schemaTypes: SCHEMA_TYPES[pageType] || [],
      voiceConstraints: VOICE_CONSTRAINTS,
    });

    // Overlay the citable-listicle architecture on list-shaped supporting-blog
    // queries (gated; applied on top of the AEO overlay so both can coexist).
    const layered = applyListicleTreatment({
      // listicle_family rows exist ONLY to produce listicle-shaped posts,
      // and the queue's claim fence (listicleFamilyLaneOpen in
      // opportunity-queue.js) means one can only be claimed while BOTH lane
      // gates are on — turning either gate off makes queued rows
      // unclaimable until they expire. The bucket key here covers the one
      // remaining window: a row claimed while the gates were on whose brief
      // composes after a mid-flight gate flip still keeps the listicle
      // architecture instead of leaking through as an ordinary blog.
      enabled: isEnabled('listicleBriefs') || opportunity.bucket === 'listicle_family',
      actionType: decision.action_type,
      pageType,
      query: opportunity.query,
      operatorPinned: spokeSeeder.isSpokeSeed(opportunity) || interceptSeeder.isOperatorIntercept(opportunity),
      requiredSections: aeo.requiredSections,
      schemaTypes: aeo.schemaTypes,
      voiceConstraints: aeo.voiceConstraints,
    });

    // FAQ-blocked topic? Match on the same fields the downstream gates use:
    // the opportunity's service plus the customer-signal service/topic (a
    // city-service brief can carry broad service 'pest' with the real topic
    // on customer_signal — e.g. 'rodent'/'termite').
    const faqBlocked = isFaqBlockedService([
      opportunity.service,
      // The specific topic behind specialty→pest canonicalization — 'wasp'
      // is individually FAQ-blocked while broad 'pest' is not, so the
      // collapsed service alone would let a blocked topic keep its FAQ
      // mandate (Codex r24).
      opportunity.signal_metadata?.specialty_topic,
      signals.customer_signal?.service,
      signals.customer_signal?.topic,
    ]);
    let { requiredSections, schemaTypes } = faqBlocked
      ? stripFaqRequirements({ requiredSections: layered.requiredSections, schemaTypes: layered.schemaTypes })
      : { requiredSections: layered.requiredSections, schemaTypes: layered.schemaTypes };

    // Family-refresh actionability (Codex r21): merged families ride in
    // gsc_signal, but the refresh agent's contract has no family mode —
    // without a BINDING section per retained variant, secondary families
    // would be silently dropped while the frozen page-key blocks them from
    // ever queueing separately. Mirrors the answer-gap pattern: the data
    // in gsc_signal, the requirement in required_sections.
    const familyQueries = Array.isArray(opportunity.signal_metadata?.family_queries)
      ? opportunity.signal_metadata.family_queries
      : (opportunity.signal_metadata?.family_variants || []).map((v) => v.query).filter(Boolean);
    if (decision.action_type === 'refresh_existing_page'
      && opportunity.signal_metadata?.source === 'listicle_family'
      && familyQueries.length) {
      // FAQ phrasing is conditional: the refresh agent never sees the
      // blocked-service list, so on FAQ-blocked topics the section must
      // steer AWAY from the format the publish guard would reject
      // (FAQ_BLOCKED_SERVICE) instead of offering it (Codex r22).
      const coverageHow = faqBlocked
        ? 'extend an existing section or add a NON-FAQ section (this topic forbids FAQ formats)'
        : 'extend an existing section or add one (FAQ acceptable)';
      requiredSections = [
        ...requiredSections,
        `family coverage: the refreshed page must directly address EVERY fragmented phrasing of this intent — ${familyQueries.map((q) => `"${q}"`).join(', ')} — ${coverageHow} for any phrasing the page does not already answer`,
      ];
    }

    // Operator-authored intercept brief: the seeded payload is injected
    // VERBATIM — the operator's outline becomes the content plan, sources
    // become required in-post citations, internal links become required
    // anchors, and the full binding instruction block rides in
    // voice_constraints.operator_brief (a persisted jsonb column, so the
    // writer agent's get_content_brief tool returns it intact).
    // Curated spoke-seed briefs (spoke-seed-seeder) take precedence: they share
    // the operator_intercept bucket (so isOperatorIntercept is also true), but
    // get a spoke-LOCAL overlay (city-local binding rules + branded-local hub
    // link + target_sites) instead of the competitor-comparison overlay.
    const spokeOverlay = spokeSeeder.isSpokeSeed(opportunity)
      ? spokeSeeder.buildSpokeOverlay({ opportunity, pageType, requiredSections, schemaTypes })
      : null;
    // Curated category seeds (category-seed-seeder) also share the
    // operator_intercept bucket but are plain informational HUB posts — they
    // get their own overlay, never the competitor-comparison framing.
    const categoryOverlay = !spokeOverlay && categorySeeder.isCategorySeed(opportunity)
      ? categorySeeder.buildCategoryOverlay({ opportunity, pageType, requiredSections, schemaTypes })
      : null;
    const interceptOverlay = !spokeOverlay && !categoryOverlay && interceptSeeder.isOperatorIntercept(opportunity)
      ? interceptSeeder.buildOperatorOverlay({ opportunity, pageType, requiredSections, schemaTypes })
      : null;
    const operatorOverlay = spokeOverlay || categoryOverlay || interceptOverlay;

    return {
      facts_pack: factsPack,
      opportunity_id: opportunity.id,
      version: existingBriefVersions + 1,
      action_type: decision.action_type,
      target_url: opportunity.page_url || null,
      target_keyword: opportunity.query || null,
      city: opportunity.city || null,
      service: opportunity.service || null,
      page_type: pageType,
      // Spoke targeting: the spoke domain(s) this post renders on (empty for
      // hub posts). Sourced from the seeded signal_metadata so it survives a
      // content_briefs round-trip; the Astro publisher reads it to stamp
      // frontmatter.domains + a self-canonical spoke URL.
      target_sites: spokeSeeder.targetSitesFor(opportunity),

      final_score: decision.final_score,
      score_breakdown: decision.score_breakdown,

      serp_signal: signals.serp_profile
        ? {
            dominant_intent: signals.serp_profile.dominant_intent,
            dominant_page_type: signals.serp_profile.dominant_page_type,
            local_pack_present: signals.serp_profile.local_pack_present,
            ai_overview_present: signals.serp_profile.ai_overview_present,
            directory_saturation: signals.serp_profile.directory_saturation,
            confidence: signals.serp_profile.confidence,
            competitor_cta_patterns: signals.serp_profile.payload?.competitor_cta_patterns || [],
            competitor_proof_patterns: signals.serp_profile.payload?.competitor_proof_patterns || [],
            paa_questions: signals.serp_profile.payload?.paa_questions || [],
            serp_gap: signals.serp_profile.payload?.serp_gap || null,
          }
        : {},
      gsc_signal: {
        bucket: opportunity.bucket,
        // True competitor-intercept marker: category/spoke seeds share the
        // operator_intercept bucket, so downstream price policy needs this
        // to tell them apart after the content_briefs round-trip.
        intercept: Boolean(opportunity.signal_metadata?.intercept_brief),
        // Fallback covers rows mined BEFORE seasonal_rising started writing
        // the canonical key — without it those queued rows keep failing
        // gsc_signal_attached until they are re-mined.
        // `||`, NOT `??`: ZERO impressions means NO usable GSC signal, and
        // the gate only rejects null — a `??` chain preserved 0 and let an
        // evidence-free refresh through, reversing the fail-closed contract
        // documented at refresh-audit.js:387-412 (Codex r2).
        impressions: opportunity.signal_metadata?.impressions
          || opportunity.signal_metadata?.impressions_recent_14d
          || null,
        avg_position: opportunity.signal_metadata?.avg_position || null,
        ctr: opportunity.signal_metadata?.ctr || null,
        decay_pct: opportunity.signal_metadata?.decay_pct || null,
        growth_pct: opportunity.signal_metadata?.growth_pct || null,
        // competitor_gap rows have zero GSC footprint by construction —
        // their provenance is the competitor's ranking. Carried here so the
        // quality gate's evidence check can verify it after the
        // content_briefs round-trip (see checkGscSignalAttached).
        search_volume: opportunity.signal_metadata?.search_volume ?? null,
        competitor_domain: opportunity.signal_metadata?.competitor_domain || null,
        competitor_position: opportunity.signal_metadata?.competitor_position ?? null,
        // answer_gap rows: the mined per-query gap list ([{query, impressions,
        // position, heading_coverage, body_term_coverage}, …]) rides the brief
        // so the refresh agent writes self-contained answer blocks without
        // re-deriving the gaps (refresh-agent-config ANSWER-GAP MODE).
        unanswered_queries: opportunity.signal_metadata?.unanswered_queries || null,
        // listicle_family rows: `impressions` above is the FAMILY SUM, not
        // the representative query's own volume — carry the provenance so
        // the writer and reviewers see the aggregation instead of reading
        // 450 impressions as a single-query metric.
        family_size: opportunity.signal_metadata?.family_size ?? null,
        family_variants: opportunity.signal_metadata?.family_variants || null,
        family_queries: opportunity.signal_metadata?.family_queries || null,
        specialty_topic: opportunity.signal_metadata?.specialty_topic || null,
        family_avg_position: opportunity.signal_metadata?.family_avg_position ?? null,
      },
      customer_signal: signals.customer_signal
        ? {
            city: signals.customer_signal.city || opportunity.city || null,
            service: signals.customer_signal.service || opportunity.service || null,
            topic: signals.customer_signal.topic,
            normalized_question: signals.customer_signal.normalized_question,
            total_count: signals.customer_signal.total_count,
            source_counts: signals.customer_signal.source_counts,
            funnel_stage: signals.customer_signal.funnel_stage,
            urgency: signals.customer_signal.urgency,
            example_phrasing_anonymized: signals.customer_signal.example_phrasing_anonymized,
          }
        : null,
      conversion_signal: signals.conversion_feedback
        ? {
            window_days: signals.conversion_feedback.window_days,
            leads_total: signals.conversion_feedback.leads_total,
            close_rate: signals.conversion_feedback.close_rate,
            avg_ticket: signals.conversion_feedback.avg_ticket,
            estimated_revenue: signals.conversion_feedback.estimated_revenue,
          }
        : null,

      required_sections: operatorOverlay ? operatorOverlay.required_sections : requiredSections,
      schema_types: operatorOverlay ? operatorOverlay.schema_types : schemaTypes,
      // For operator/spoke supporting blogs the curated links are REQUIRED and
      // lead the list, but the standard service-hub links are merged in too —
      // a curated hub link may be a CITY page (not in SERVICE_HUB_LINKS), so
      // merging the house service links keeps the quality gate's
      // hub_link_present check satisfied without the writer inventing one.
      // Refresh briefs keep the operator list verbatim (the editable surface is
      // the existing page).
      internal_links_to_add: operatorOverlay
        ? (pageType === 'supporting-blog'
          ? Array.from(new Set([
            ...operatorOverlay.internal_links,
            ...this._internalLinksFor(opportunity, pageType),
          ]))
          : operatorOverlay.internal_links)
        : this._internalLinksFor(opportunity, pageType),
      seo_requirements: buildSeoRequirements({
        page_type: pageType,
        action_type: decision.action_type,
        city: opportunity.city || null,
        service: opportunity.service || null,
      }),
      word_count_target: WORD_COUNT_TARGET[pageType] || 'intent-complete',
      voice_constraints: (() => {
        const base = operatorOverlay
          ? { ...layered.voiceConstraints, operator_brief: operatorOverlay.operator_brief }
          : layered.voiceConstraints;
        const gateRetry = opportunity.signal_metadata?.gate_retry;
        return gateRetry ? { ...base, retry_directives: buildRetryDirectives(gateRetry) } : base;
      })(),

      publish_window: nextWeekday9amET().toISOString(),
      human_review_required: decision.human_review_required,
      human_review_reason: decision.human_review_reason,
      router_notes: decision.router_notes,

      composed_at: new Date(),
    };
  }

  _internalLinksFor(opportunity, pageType) {
    if (['metadata', 'links', 'gbp', 'none'].includes(pageType)) return [];
    // One normalization for ALL three maps below — a verbatim facts-bank id
    // ('pest-control') previously missed the hub AND city links too, and the
    // gate P1s drafts on exactly those mandatory checklist links.
    const service = SERVICE_ID_ALIASES[opportunity.service] || opportunity.service;
    const links = new Set();
    const hubs = SERVICE_HUB_LINKS[service] || [];
    for (const h of hubs) links.add(h);
    // City-service link uses the canonical service slug, NOT
    // `${service}-control-` (lawn would produce /lawn-control-…-fl/
    // which isn't a real page; the real slug is /lawn-care-…-fl/).
    // Services without a canonical city-service slug pattern (e.g.
    // tree-shrub, specialty) get only the hub link.
    if (opportunity.city && service) {
      const slug = SERVICE_CITY_SLUG[service];
      if (slug) {
        const citySlug = opportunity.city.toLowerCase().replace(/\s+/g, '-');
        // Only cities with PUBLISHED city-service pages get a city link —
        // served towns without pages (Oneco, Gibsonton, …) would make the
        // brief mandate a dead link, which the writer would dutifully add
        // and the route gate would (rightly) refuse to allow.
        if (PAGE_CITY_SLUGS.has(citySlug)) links.add(`/${slug}-${citySlug}-fl/`);
      }
    }
    // Only supporting-blog carries the conversion-CTA gate requirement;
    // other page types (customer-question's "one internal link" contract,
    // city pages' own CTA rules) keep their existing link shape.
    if (pageType === 'supporting-blog') {
      const conversion = SERVICE_CONVERSION_LINK[service];
      if (conversion) links.add(conversion);
    }
    // Only the maps in THIS file are vetted here. Operator/seed overlay links
    // are deliberately NOT filtered: they legitimately point at the ~198
    // published blog posts (/{category}/{slug}/) and city-service slug variants
    // that no static allowlist enumerates, so filtering them silently discards
    // real curated links. Overlay route hygiene belongs in the overlay's own
    // source data — see the seed manifest fix in this change.
    return this._vetInternalLinks(Array.from(links), { service, city: opportunity.city }).slice(0, 5);
  }

  /**
   * Drop a mandated internal link this file's own maps cannot prove resolves.
   *
   * Scoped to house-generated links (SERVICE_HUB_LINKS / SERVICE_CITY_SLUG /
   * SERVICE_CONVERSION_LINK), where every value IS expected to be on the
   * guardrail allowlist or a published city-service route — the module-load
   * assertion above enforces exactly that, so this is the runtime backstop for
   * the city-slug branch and for future map edits.
   *
   * Dropping beats keeping for these: content-guardrails threads
   * internal_links_to_add in as a per-draft route ALLOWANCE, so a dead
   * mandated link doesn't merely evade the dead-link gate — it instructs the
   * writer to add the link and then suppresses the P0 that would have caught
   * it. Warn rather than throw: a brief with one fewer link still publishes.
   */
  _vetInternalLinks(links, ctx = {}) {
    const vetted = [];
    for (const link of Array.isArray(links) ? links : []) {
      if (isKnownGoodInternalRoute(link)) { vetted.push(link); continue; }
      logger.warn(`[content-brief-builder] dropped unverifiable internal link "${link}" (service=${ctx.service || 'n/a'} city=${ctx.city || 'n/a'}) — not on the guardrail allowlist and not a published city-service route`);
    }
    return vetted;
  }

  /**
   * Persist the brief. Throws on failure — earlier iteration swallowed
   * insert errors and returned null, so compose() resolved as if the
   * brief was saved when content_briefs was missing / mis-migrated or
   * an (opportunity_id, version) conflict fired. That silently dropped
   * the brief from the audit trail and let the pipeline continue
   * state transitions against a phantom brief. Now any persistence
   * failure rejects compose() so the runner can act on it.
   */
  async _persist(brief) {
    try {
      const [row] = await db('content_briefs')
        .insert({
          opportunity_id: brief.opportunity_id,
          version: brief.version,
          action_type: brief.action_type,
          target_url: brief.target_url,
          target_keyword: brief.target_keyword,
          city: brief.city,
          service: brief.service,
          page_type: brief.page_type,
          final_score: brief.final_score,
          score_breakdown: JSON.stringify(brief.score_breakdown),
          serp_signal: JSON.stringify(brief.serp_signal),
          gsc_signal: JSON.stringify(brief.gsc_signal),
          customer_signal: brief.customer_signal ? JSON.stringify(brief.customer_signal) : null,
          conversion_signal: brief.conversion_signal ? JSON.stringify(brief.conversion_signal) : null,
          required_sections: JSON.stringify(brief.required_sections),
          schema_types: JSON.stringify(brief.schema_types),
          internal_links_to_add: JSON.stringify(brief.internal_links_to_add),
          facts_pack: brief.facts_pack ? JSON.stringify(brief.facts_pack) : null,
          word_count_target: brief.word_count_target,
          voice_constraints: JSON.stringify(brief.voice_constraints),
          publish_window: brief.publish_window,
          human_review_required: brief.human_review_required,
          human_review_reason: brief.human_review_reason,
          router_notes: brief.router_notes,
          composed_at: brief.composed_at,
        })
        .returning('id');
      return row?.id || row;
    } catch (err) {
      // Log + rethrow. compose() bubbles this up; the runner records
      // a failed brief outcome and the queue row gets released for
      // retry instead of silently advancing to publish.
      logger.warn(`[brief-builder] persist failed for opp ${brief.opportunity_id}: ${err.message}`);
      throw new Error(`content_briefs persist failed: ${err.message}`);
    }
  }
}

// ── publish-window picker ───────────────────────────────────────────

function nextWeekday9amET() {
  // 9am ET on the next Monday–Friday that's at least 6 hours away.
  // Earlier iteration hardcoded UTC 13:00 as "9am ET" which is only
  // true during EDT; in EST it scheduled at 8am ET — wrong for half
  // the year. parseETDateTime("YYYY-MM-DDT09:00") anchors to actual
  // 9am ET regardless of DST.
  // Crude — the autonomous-runner (later phase) will replace with a
  // calendar-aware slot picker that avoids already-scheduled days.
  const now = new Date();
  for (let offset = 0; offset < 14; offset++) {
    const etDay = etDateString(addETDays(now, offset));
    const target = parseETDateTime(`${etDay}T09:00`);
    if (target - now < 6 * 3600 * 1000) continue;
    // Skip weekends in ET.
    const etWeekday = target.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    if (etWeekday === 'Sat' || etWeekday === 'Sun') continue;
    return target;
  }
  // Fallback (shouldn't hit — 14 days always contains a weekday).
  return parseETDateTime(`${etDateString(addETDays(now, 1))}T09:00`);
}

module.exports = new ContentBriefBuilder();
module.exports.ContentBriefBuilder = ContentBriefBuilder;
module.exports._internals = {
  REQUIRED_SECTIONS,
  SCHEMA_TYPES,
  WORD_COUNT_TARGET,
  SERVICE_HUB_LINKS,
  SERVICE_CITY_SLUG,
  SERVICE_ID_ALIASES,
  buildSeoRequirements,
  nextWeekday9amET,
  applyAeoTreatment,
  applyListicleTreatment,
  isListicleQuery,
  stripFaqRequirements,
  buildRetryDirectives,
};
