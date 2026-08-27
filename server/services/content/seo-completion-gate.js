/**
 * SEO completion gate for generated supporting-blog drafts.
 *
 * This complements content-quality-gate.js instead of replacing it.
 * P0 findings block Astro PR creation. P1/P2 findings are persisted
 * and surfaced for admin/Codex review, but they do not prevent a PR
 * from being opened while the engine remains review-assisted.
 */

const {
  buildBlogSeoContract,
  buildSeoRequirements,
  extractVisibleFaqs,
  pestPracticesComplete,
  hublessService,
  normalizeService,
  CITY_SERVICE_SLUG,
  cityServiceRoute,
} = require('./blog-seo-contract');
const { isFaqBlockedService, findHardcodedPrice } = require('./content-guardrails');

const P0_CODES = new Set([
  'P0_MISSING_TITLE',
  'P0_MISSING_BODY',
  'P0_SCHEMA_DESCRIBES_HIDDEN_CONTENT',
  'P0_FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ',
  'P0_PII_DETECTED',
  'P0_HARDCODED_PRICE_NOT_APPROVED',
  'P0_DUPLICATE_INTENT_OVER_CAP',
]);

const P1_CODES = new Set([
  'P1_MISSING_BREADCRUMBS',
  'P1_MISSING_BREADCRUMB_SCHEMA',
  'P1_MISSING_ARTICLE_SCHEMA',
  'P1_MISSING_SERVICE_LINK',
  'P1_MISSING_CITY_LINK_WHEN_CITY_TOPIC',
  'P1_MISSING_CONVERSION_CTA',
  'P1_FORBIDDEN_CTA_WORDING',
  'P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ',
  'P1_MISSING_PEST_PRACTICES',
]);

const P2_CODES = new Set([
  'P2_TOO_FEW_INTERNAL_LINKS',
  'P2_GENERIC_ANCHOR_TEXT',
  'P2_WEAK_LOCALIZATION',
  'P2_NO_IMAGE',
  'P2_FAQ_ANSWERS_TOO_THIN',
  'P2_META_DESCRIPTION_TOO_LONG',
]);

function evaluate(input = {}) {
  const {
    draft = {},
    brief = {},
    uniquenessResult = {},
    renderedHtml = null,
    shadowMode = true,
  } = input;

  const actionType = brief.action_type || input.actionType;
  const pageType = brief.page_type || input.pageType;
  if (actionType !== 'new_supporting_blog' && pageType !== 'supporting-blog') {
    return {
      passed: true,
      skipped: 'not_supporting_blog',
      score: 100,
      findings: [],
      contract: null,
      summary: summarizeFindings([]),
    };
  }

  const { contract, validation } = buildBlogSeoContract({ draft, brief, shadowMode });
  const body = String(draft.body || '');
  const findings = [];
  const requirements = buildSeoRequirements(brief);

  if (!contract.title) findings.push(finding('P0', 'P0_MISSING_TITLE', 'Draft is missing a title.', 'Add a specific visible H1/frontmatter title before publishing.'));
  if (!body.trim()) findings.push(finding('P0', 'P0_MISSING_BODY', 'Draft body is empty.', 'Generate a complete supporting blog body before publishing.'));
  if (contract.schema?.faqPage === true && !contract.faq.length) {
    findings.push(finding('P0', 'P0_FAQ_SCHEMA_WITHOUT_VISIBLE_FAQ', 'FAQPage schema is requested but no visible FAQ items were found.', 'Remove FAQPage schema or add a visible Frequently Asked Questions section with H3 questions and answers.'));
  }
  if (schemaMentionsHiddenFaq(draft, renderedHtml) && !contract.faq.length) {
    findings.push(finding('P0', 'P0_SCHEMA_DESCRIBES_HIDDEN_CONTENT', 'Structured data describes FAQ content that is not visible in the draft.', 'Keep structured data limited to visible page content.'));
  }
  if (detectPii(body)) {
    findings.push(finding('P0', 'P0_PII_DETECTED', 'Draft appears to contain customer PII.', 'Remove customer phone numbers, emails, and verbatim customer details before publishing.'));
  }
  if (detectHardcodedPrice(body, brief)) {
    findings.push(finding('P0', 'P0_HARDCODED_PRICE_NOT_APPROVED', 'Draft appears to hardcode unapproved pricing.', 'Use estimate/calculator language and link to the calculator instead of publishing fixed prices.'));
  }
  if (uniquenessResult?.ok === false && hasDuplicateIntentFailure(uniquenessResult)) {
    findings.push(finding('P0', 'P0_DUPLICATE_INTENT_OVER_CAP', 'Uniqueness gate found duplicate intent over the cap.', 'Change the angle or merge with the existing page instead of publishing a near-duplicate.'));
  }

  if (requirements.breadcrumbsRequired && contract.breadcrumbs.length < 3) {
    findings.push(finding('P1', 'P1_MISSING_BREADCRUMBS', 'Visible blog breadcrumb contract is incomplete.', 'Ensure the rendered post has Home > Waves Blog > Current Post breadcrumbs.'));
  }
  if (requirements.breadcrumbsRequired && contract.schema?.breadcrumb !== true) {
    findings.push(finding('P1', 'P1_MISSING_BREADCRUMB_SCHEMA', 'BreadcrumbList schema is not requested.', 'Include BreadcrumbList in schema_types and verify Astro renders matching JSON-LD.'));
  }
  if (requirements.articleSchemaRequired && contract.schema?.article !== true) {
    findings.push(finding('P1', 'P1_MISSING_ARTICLE_SCHEMA', 'Article or BlogPosting schema is not requested.', 'Include Article or BlogPosting structured data for the blog post.'));
  }
  // Lawn and tree & shrub have no hub-level service page, so their city-service
  // page is the most specific real page they have and satisfies BOTH requirements.
  // Without this a fully compliant draft raises P1_MISSING_SERVICE_LINK forever,
  // and with AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0 it can never publish.
  //
  // The link must be THIS service's city page, not any city-shaped URL:
  // hasIncludedLinkReason only classifies by shape, so a lawn draft linking
  // /pest-control-sarasota-fl/ would otherwise satisfy the lawn service
  // requirement while containing no lawn link at all. Same specificity
  // checkHubLinkPresent applies.
  const serviceSatisfiedByCity = hublessService(normalizeService(brief.service))
    && hasServiceCityLink(contract, brief);
  if (brief.service && !hasIncludedLinkReason(contract, 'service') && !serviceSatisfiedByCity) {
    findings.push(finding('P1', 'P1_MISSING_SERVICE_LINK', 'Required service link is not included in the draft body.', 'Add one relevant service/hub link using descriptive anchor text.'));
  }
  if (brief.city && !hasIncludedLinkReason(contract, 'city')) {
    findings.push(finding('P1', 'P1_MISSING_CITY_LINK_WHEN_CITY_TOPIC', 'City-focused blog draft is missing a city page link in the body.', 'Add the matching local service page link.'));
  }
  // Judged on the RENDERED link set (inline + reference-style + HTML anchors)
  // — the contract's inline-only parser must not park a compliant
  // reference-style CTA.
  if (!hasConversionCta(body, brief)) {
    findings.push(finding('P1', 'P1_MISSING_CONVERSION_CTA', 'Draft is missing a clear conversion CTA.', 'Add an early and final CTA with estimate/quote wording linking to contact, quote, or estimate paths.'));
  }
  {
    // Every CTA anchor must comply — one valid CTA does not excuse a
    // forbidden one elsewhere in the body.
    const badAnchor = forbiddenCtaAnchor(body);
    if (badAnchor) {
      findings.push(finding('P1', 'P1_FORBIDDEN_CTA_WORDING', `CTA link anchor "${badAnchor}" uses inspection-request wording — owner rule 2026-08-27: CTA anchors use estimate/quote wording tied to the post's service.`, 'Reword the CTA anchor to estimate/quote wording, e.g. "Get My Free Termite Estimate".'));
    }
    // Skip when it is the SAME anchor the inspection check already flagged —
    // one anchor, one finding (a duplicate would double-count toward
    // AUTONOMOUS_CONTENT_MAX_P1_FINDINGS).
    const badCta = badCtaAnchor(body, brief);
    if (badCta && badCta !== badAnchor) {
      findings.push(finding('P1', 'P1_FORBIDDEN_CTA_WORDING', `CTA link anchor "${badCta}" violates the CTA-wording rule — owner rule 2026-08-27: every conversion CTA anchor uses estimate/quote wording tied to the post's service.`, 'Reword the CTA anchor to estimate/quote wording for this post\'s service, e.g. "Get My Free Termite Estimate" on a termite post.'));
    }
  }
  if (faqRequired(brief) && !contract.faq.length) {
    findings.push(finding('P1', 'P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ', 'Brief requires a visible FAQ section, but none was found.', 'Add a Frequently Asked Questions section with question-style H3 headings.'));
  }
  if (requirements.pestPracticesRequired && !pestPracticesComplete(contract.pestPractices)) {
    findings.push(finding('P1', 'P1_MISSING_PEST_PRACTICES', 'Draft is missing one or more pest-practices requirements.', 'Include identification, SWFL context, safe homeowner checks, what not to do, when to call a pro, and Waves approach.'));
  }

  if (contract.internalLinks.length < requiredInternalLinkCount(brief)) {
    findings.push(finding('P2', 'P2_TOO_FEW_INTERNAL_LINKS', 'Draft has fewer internal-link recommendations than expected.', 'Recommend city, service, conversion, and related-blog links before review.'));
  }
  if ([...(contract.includedInternalLinks || []), ...(contract.internalLinks || [])].some((link) => isGenericAnchor(link.anchorText))) {
    findings.push(finding('P2', 'P2_GENERIC_ANCHOR_TEXT', 'One or more internal links use generic anchor text.', 'Use descriptive anchors instead of click here, learn more, or this page.'));
  }
  // Spoke seeds carry city=null (to keep the facts gate "not applicable") but
  // still target one city — fall back to the operator brief's city so the
  // localization check verifies the real target, not nothing.
  const localizationCity = brief.city || brief?.voice_constraints?.operator_brief?.city || null;
  if (localizationCity && countCityMentions(body, localizationCity) < 1) {
    findings.push(finding('P2', 'P2_WEAK_LOCALIZATION', 'Draft has weak city/SWFL localization.', 'Add natural local context tied to the target city or Southwest Florida conditions.'));
  }
  if (!draft.frontmatter?.hero_image && !draft.frontmatter?.og_image) {
    findings.push(finding('P2', 'P2_NO_IMAGE', 'Draft does not include a crawlable blog image reference.', 'Add a relevant hero image if one is available; omit fake or irrelevant imagery.'));
  }
  for (const faq of contract.faq) {
    if (faq.answer.length < 45) {
      findings.push(finding('P2', 'P2_FAQ_ANSWERS_TOO_THIN', 'One or more FAQ answers are too thin.', 'Expand FAQ answers enough to answer the homeowner question directly.'));
      break;
    }
  }
  if (contract.description && contract.description.length > 160) {
    findings.push(finding('P2', 'P2_META_DESCRIPTION_TOO_LONG', 'Meta description is longer than 160 characters.', 'Tighten the description to fit the expected SERP snippet range.'));
  }

  for (const err of validation.errors || []) {
    if (err.code === 'missing_title' && hasCode(findings, 'P0_MISSING_TITLE')) continue;
    findings.push(finding('P2', `P2_CONTRACT_${err.code.toUpperCase()}`, err.message, 'Complete the shared BlogSeoContract before review.'));
  }

  const p0Count = findings.filter((item) => item.severity === 'P0').length;
  const score = scoreFindings(findings);
  return {
    passed: p0Count === 0,
    score,
    findings,
    contract,
    reviewFlags: contract.reviewFlags || [],
    summary: summarizeFindings(findings),
  };
}

function summarizeFindings(findings = []) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of findings) {
    if (counts[item.severity] != null) counts[item.severity] += 1;
  }
  return {
    passed: counts.P0 === 0,
    p0: counts.P0,
    p1: counts.P1,
    p2: counts.P2,
    p3: counts.P3,
    needs_review: counts.P1 > 0 || counts.P2 > 0,
  };
}

function scoreFindings(findings = []) {
  let score = 100;
  for (const item of findings) {
    if (item.severity === 'P0') score -= 35;
    else if (item.severity === 'P1') score -= 12;
    else if (item.severity === 'P2') score -= 4;
    else score -= 1;
  }
  return Math.max(0, score);
}

function finding(severity, code, message, recommendation) {
  return { severity, code, message, recommendation };
}

function hasCode(findings, code) {
  return findings.some((item) => item.code === code);
}

function hasLinkReason(contract, reason) {
  return Array.isArray(contract.internalLinks)
    && contract.internalLinks.some((link) => link.reason === reason);
}

/**
 * Is one of the draft's links THIS brief's own city-service page?
 *
 * Stricter than hasIncludedLinkReason(contract, 'city'), which classifies purely by
 * URL shape — so /pest-control-sarasota-fl/ counts as "a city link" in a lawn
 * draft. Used where the city page has to stand in for the service link, which is
 * only true when it is the right service's page.
 */
function hasServiceCityLink(contract, brief) {
  if (!Array.isArray(contract.includedInternalLinks)) return false;
  const service = normalizeService(brief.service);
  // Prefer the exact service+city route. Matching the service prefix alone let a
  // Sarasota lawn brief pass on /lawn-care-venice-fl/ — right service, wrong town.
  const exact = cityServiceRoute(service, brief.city);
  if (exact) {
    const want = exact.replace(/\/$/, '');
    return contract.includedInternalLinks
      .some((link) => String(link.url || '').replace(/\/$/, '') === want);
  }
  // No city on the brief: nothing to match against, so any of this service's city
  // pages is as specific as the brief itself is.
  const slug = CITY_SERVICE_SLUG[service];
  if (!slug) return false;
  const anyCity = new RegExp(`^/${slug}-[a-z][a-z0-9-]*-fl/?$`);
  return contract.includedInternalLinks.some((link) => anyCity.test(String(link.url || '')));
}

function hasIncludedLinkReason(contract, reason) {
  return Array.isArray(contract.includedInternalLinks)
    && contract.includedInternalLinks.some((link) => link.reason === reason);
}

// Request-action verbs, shared by the coordinated-clause classifier and
// the forbidden inspection-anchor gate (single source — partial verb lists
// drifted apart across rounds).
const REQUEST_VERB_SOURCE = 'request|schedule|book|get|arrange|order|buy|start|claim|reserve|secure';

// Which service a CTA anchor names, if any — used to reject a wrong-service
// CTA ("Get a Lawn Care Quote" on a termite post, "Get a Cockroach Quote"
// on a bed-bug post). Broad-service keys match normalizeService's output;
// specialty keys match the raw brief topics the engine briefs carry.
const CTA_ANCHOR_SERVICE_TERMS = {
  pest: /\bpest\b/i,
  lawn: /\blawn\b/i,
  termite: /\btermite/i,
  mosquito: /\bmosquito/i,
  rodent: /\brodent|\brats?\b|\bmice\b|\bmouse\b/i,
  // "Deep Root Fertilization" is the established tree & shrub treatment
  // name (the lawn-fertilization entry already excludes "root fertiliz").
  'tree-shrub': /\btree\b|\bshrub|\bpalms?\b|\bornamentals?\b|\bdeep[ -]?root/i,
  'bed-bug': /\bbed[ -]?bug/i,
  // "Palmetto bug" is the established Florida roach alias (blog-writer's
  // TAG_ALIASES uses the same equivalence).
  cockroach: /\b(?:cock)?roach(?:es)?\b|\bpalmetto[ -]?bugs?\b/i,
  ant: /\bants?\b/i,
  // Whole word only — "spiderwort" is a lawn WEED, not the spider service.
  spider: /\bspiders?\b/i,
  flea: /\bfleas?\b/i,
  tick: /\bticks?\b/i,
  wasp: /\bwasps?\b|\bhornets?\b|\bbees?\b/i,
  // WDI (wood-destroying insect) is the established inspection-report
  // acronym alongside WDO — both name this service in CTA wording.
  wdo: /\bwd[oi]\b|wood[- ]destroying/i,
  // Lawn specialties (established brief service IDs) — their own terms name
  // the lawn family. Fertilization is lawn wording only when not the
  // tree/shrub/palm treatment ("Deep Root Fertilization").
  'lawn-fertilization': /\b(?<!tree[ -])(?<!shrub[ -])(?<!palm[ -])(?<!root[ -])(?<!ornamental[ -])fertiliz/i,
  'lawn-aeration': /\baerat/i,
  'lawn-weed-control': /\bweed/i,
};

// Specialty → the broad service whose conversion path it books through. A
// bed-bug post's CTA may say "bed bug" OR "pest" ("Get My Free Pest Control
// Estimate" is that post's real conversion page); it may NOT say
// "cockroach" or "lawn".
const CTA_SERVICE_FAMILY = {
  'bed-bug': 'pest',
  cockroach: 'pest',
  ant: 'pest',
  spider: 'pest',
  flea: 'pest',
  tick: 'pest',
  wasp: 'pest',
  wdo: 'termite',
  // Commercial variants convert with their residential family's wording
  // ("Request a Commercial Lawn Quote") — CTA vocabulary only; the
  // brief-builder's conversion-path aliases are untouched.
  'commercial-lawn': 'lawn',
  'commercial-pest': 'pest',
  'lawn-fertilization': 'lawn',
  'lawn-aeration': 'lawn',
  'lawn-weed-control': 'lawn',
  // The catch-all specialty lane converts through the pest paths.
  specialty: 'pest',
};

function allowedAnchorServices(briefService) {
  const allowed = new Set([briefService]);
  if (CTA_SERVICE_FAMILY[briefService]) allowed.add(CTA_SERVICE_FAMILY[briefService]);
  // A broad-service brief accepts its own specialties ("Get an Ant Control
  // Quote" on a pest post).
  for (const [svc, fam] of Object.entries(CTA_SERVICE_FAMILY)) {
    if (fam === briefService) allowed.add(svc);
  }
  return allowed;
}

// A conversion-path link is an actionable CTA unless its anchor is
// POSITIVELY prose-shaped — a noun phrase with an article/possessive
// lead-in ("our contact page", "the pest control calculator"). Every
// actionable CTA ("Contact Waves", "Talk to Us", "View Options", "Schedule
// Service", "Click here") must carry estimate/quote wording; prose
// references stay out of scope (P2_GENERIC_ANCHOR_TEXT nudges those).
const PROSE_REFERENCE_LEADIN_RE = /^(?:our|the|this|these|that|a|an|its|their|waves'?s?)\b/i;
// Derived from the SHARED request-verb set (plus contact/navigation verbs)
// — parallel partial verb lists drifted apart across rounds. An anchor is
// ACTIONABLE when the verb leads it (imperative, with optional
// please/click-to lead-in) or appears as an INFINITIVE invitation
// ("…page to reserve service"); a subordinate verb with its own subject
// ("…customers get after an inspection") is still prose.
const ACTION_VERB_SET = `(?:${REQUEST_VERB_SOURCE}|call|click|visit|open|tap|reach|talk|see|view|learn)`;
const ACTION_VERB_RE = new RegExp(`^(?:please\\s+)?(?:(?:click|tap)\\s+(?:here\\s+)?to\\s+)?${ACTION_VERB_SET}\\b|\\bto\\s+${ACTION_VERB_SET}\\b`, 'i');
function isProseReferenceAnchor(anchor) {
  return PROSE_REFERENCE_LEADIN_RE.test(anchor) && !ACTION_VERB_RE.test(anchor);
}

// Canonicalize a brief's service for CTA-anchor validation. Specialty
// topics with their own anchor vocabulary (bed-bug, cockroach, …) stay
// themselves — the family map above already grants them their real
// conversion wording — while compound service IDs canonicalize through the
// SAME alias table the brief builder uses (termite-inspection → termite,
// lawn-fertilization → lawn), so an established brief service can never be
// parked by a partial local normalization.
function ctaBriefService(rawService) {
  if (!rawService) return null;
  const base = String(rawService).toLowerCase().trim().replace(/\s+/g, '-');
  // Try the id itself, then plural-stripped and "-control"/"-care"/
  // "-treatment"-stripped forms against the anchor vocabulary first, so
  // every supported service id (rodent-control, bed-bug-control, bed-bugs,
  // cockroaches, …) lands on its own key before any broad-service aliasing.
  // Plural stripping is tried as CANDIDATES only — never applied blindly
  // (that turned "termite" into "termit").
  const stripped = base.replace(/-(?:control|care|treatment)s?$/, '');
  const candidates = [base, stripped]
    .flatMap((v) => [v, v.replace(/es$/, ''), v.replace(/s$/, '')]);
  for (const c of candidates) {
    if (CTA_ANCHOR_SERVICE_TERMS[c] || CTA_SERVICE_FAMILY[c]) return c;
    // Brief values spell cockroaches as "roach"/"roaches" too.
    if (c === 'roach') return 'cockroach';
  }
  const { SERVICE_ID_ALIASES } = require('./content-brief-builder')._internals;
  const aliased = SERVICE_ID_ALIASES[base] || SERVICE_ID_ALIASES[stripped] || rawService;
  // normalizeService output is already canonical (pest/lawn/termite/…).
  return normalizeService(aliased).replace(/\s+/g, '-');
}

// All conversion-path links in the body, with anchor + estimate/quote flag
// + the services the anchor names.
// Canonical conversion ENDPOINTS only — the SERVICE_CONVERSION_LINK routes
// (/pest-control-calculator/, /contact/) plus the quote/estimate entry
// pages the writer is steered to (/pest-control-quote/, the city
// /pest-control-quote-{city}-fl/ pages, /quote/, /estimate/). An
// informational path that merely CONTAINS "estimate" (/blog/how-estimates-
// work/) is not a conversion link.
function conversionEndpoints() {
  const { SERVICE_CONVERSION_LINK } = require('./content-brief-builder')._internals;
  return new Set([...Object.values(SERVICE_CONVERSION_LINK || {}), '/contact/', '/book/', '/pest-control-calculator/', '/pest-control-quote/', '/quote/', '/estimate/']);
}
function isConversionPath(href) {
  const path = String(href || '').replace(/[?#].*$/, '').replace(/\/?$/, '/').toLowerCase();
  if (!path.startsWith('/')) return false;
  if (conversionEndpoints().has(path)) return true;
  return /^\/pest-control-quote-[a-z0-9-]+-fl\/$/.test(path);
}

// Markdown links AND literal HTML anchors (the passive-HTML allowlist admits
// <a>, so a forbidden CTA could otherwise hide in one).
// Non-rendered regions never reach a reader — reuse the guardrails'
// fence/comment-aware stripper (single Markdown scanner, no parallel parser)
// so the gate judges rendered CTAs only.
function renderedTextWithDepths(body) {
  const g = require('./content-guardrails');
  // Rendered text plus each line's original QUOTE DEPTH — the markers are
  // stripped, but depth still separates paragraphs (a deeper quote line
  // interrupts, so a link label cannot continue across it). A test double
  // without the depth-aware variant degrades to depthless text (the
  // quote-boundary checks become inert, everything else holds).
  if (typeof g.blankNonRenderedMarkdownWithDepths === 'function') return g.blankNonRenderedMarkdownWithDepths(body);
  return { text: g.blankNonRenderedMarkdown(body), depths: null };
}

function extractLinks(body) {
  const { text: s, depths: lineDepths } = renderedTextWithDepths(body);
  const links = [];
  const lineStarts = [0];
  for (let p = s.indexOf('\n'); p !== -1; p = s.indexOf('\n', p + 1)) lineStarts.push(p + 1);
  const lineIndexAt = (pos) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const depthAtPos = (pos) => (lineDepths ? (lineDepths[lineIndexAt(pos)] || 0) : 0);
  let m;
  // CommonMark allows angle-bracketed destinations: [x](</contact/>) and
  // [ref]: </contact/> — strip the brackets; and an absolute first-party
  // URL (hub or any spoke host, per the guardrails' hubHostSet) IS the
  // site-relative path spelled long-form.
  const { hubHostSet, decodeEntitiesForScan } = require('./content-guardrails');
  const firstParty = hubHostSet();
  // Destinations are judged as RENDERED: character references decoded
  // ("/&#99;ontact/" is /contact/) and dot segments resolved
  // ("/x/../contact/" is /contact/) before classification.
  const dest = (h) => {
    let raw = decodeEntitiesForScan(String(h || '')).replace(/^<|>$/g, '');
    // CommonMark backslash escapes render in destinations too —
    // "(\/contact/)" is /contact/ in the browser.
    raw = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    // Authority parsed with URL — default ports (":443") drop and hostnames
    // lowercase, exactly as the browser resolves them.
    if (/^https?:\/\//i.test(raw)) {
      let parsed = null;
      try { parsed = new URL(raw); } catch (err) { parsed = null; }
      if (parsed && firstParty.has(parsed.hostname.toLowerCase())) raw = `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`;
    }
    // Site-relative paths resolve dot segments through WHATWG URL — the
    // same normalization the internal-route scanner uses — so ENCODED
    // segments resolve exactly as the browser does ("/x/%2e%2e/contact/"
    // is /contact/), not just literal "." and "..". Protocol-relative
    // destinations ("//host/x") are a different authority, not a path.
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      try {
        const u = new URL(raw, 'https://resolve.invalid');
        raw = `${u.pathname || '/'}${u.search}${u.hash}`;
      } catch (err) { /* malformed — judged as written */ }
    }
    return raw;
  };
  // Quoted ATTRIBUTE VALUES do not render Markdown — link syntax inside
  // `<span title="[x](/contact/)">` is tooltip text, not a clickable link —
  // so a LENGTH-PRESERVING copy with those values blanked (newlines kept)
  // feeds the definition parse and the Markdown walk. The HTML-anchor and
  // autolink passes keep the original: href values live in quotes.
  let sMd = s;
  {
    const tagScan = /<\/?[a-zA-Z][\w-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
    let tm;
    while ((tm = tagScan.exec(s)) !== null) {
      const local = tm[0].replace(/"[^"]*"|'[^']*'/g, (q) => q[0] + q.slice(1, -1).replace(/[^\n]/g, ' ') + q[q.length - 1]);
      if (local !== tm[0]) sMd = sMd.slice(0, tm.index) + local + sMd.slice(tm.index + tm[0].length);
    }
  }
  // Regions the Markdown passes CONSUME (definition lines, whole inline
  // links) — the autolink pass must not re-read an angle-bracketed
  // destination inside them as a separate bare-URL link.
  const consumed = [];
  // Reference definitions are registered FIRST so the single link walk
  // below can resolve full and shortcut references as it goes.
  // CommonMark label matching is case-insensitive with internal whitespace
  // collapsed — normalize both the definition and the reference the same way.
  const label = (l) => String(l || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Duplicate definitions: CommonMark resolves references against the FIRST
  // definition of a label; later repeats are inert.
  const defs = new Map();
  // A definition may be a LIST ITEM's content ("- [cta]: /contact/") —
  // CommonMark registers it document-wide after removing the marker.
  // The destination may sit on the NEXT line but never across a blank
  // line ("[cta]:\n\n/contact/" registers nothing).
  // Labels may contain backslash-ESCAPED brackets ("[cta\]]: /contact/") —
  // CommonMark accepts them; matching is on the raw label text, identical
  // on the definition and reference sides, so no unescaping is needed.
  // The WHOLE definition must be valid: after the destination, only
  // whitespace or a valid title may follow — "[cta]: /contact/ garbage"
  // is ordinary text, not a definition (CommonMark).
  const def = /^[ \t]{0,3}(?:(?:[-*+]|\d+[.)])\s+)?\[((?:\\[\s\S]|[^\]\\])+)\]:[ \t]*(?:\r?\n[ \t]*)?(\S+)([^\n]*)/gm;
  const defTail = /^[ \t]*$|^[ \t]+(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\))[ \t]*$/;
  while ((m = def.exec(sMd)) !== null) {
    if (!defTail.test(m[3])) continue;
    const key = label(m[1]);
    if (!defs.has(key)) defs.set(key, dest(m[2]));
    consumed.push([m.index, m.index + m[0].length]);
  }
  // Markdown links — inline, full-reference, and shortcut-reference — in one
  // procedural walk. Link TEXT is matched with a balanced-bracket scan, so
  // it supports the renderer's FULL nesting depth ("[Schedule [Our
  // [Trusted] Service]]"), which no fixed-depth regex can. Escape parity
  // carries over from the regex forms: an odd backslash run before "[" (or
  // before the "!" of image syntax) makes it literal; "\\[text](url)" (even
  // run) is a live link.
  const oddEscaped = (str, i) => {
    let n = 0;
    while (i - 1 - n >= 0 && str[i - 1 - n] === '\\') n += 1;
    return n % 2 === 1;
  };
  // A label cannot cross a PARAGRAPH boundary — a blank line (a blank
  // quote line included), an ATX heading, a thematic break, a list-item
  // opener (bullet, or ordered numbered 1), or a line that DEEPENS the
  // blockquote context (the quote interrupts the paragraph) ends the
  // paragraph, so "[Get a Termite" + blank line (or "> Estimate](…)")
  // renders no link and must not satisfy CTA presence. Same-depth quoted
  // continuation and lazy continuation still soft-wrap.
  const labelBoundaryLine = (line, openQuoteDepth, lineQuoteDepth) => {
    if (lineQuoteDepth > openQuoteDepth) return true;
    if (!line.trim()) return true;
    return /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:[-*+]|1[.)])[ \t]+\S)/.test(line);
  };
  const balancedLabelEnd = (str, open, openQuoteDepth, depthAt) => {
    let depth = 0;
    for (let i = open; i < str.length; i += 1) {
      const ch = str[i];
      if (ch === '\\') { i += 1; continue; }
      if (ch === '\n') {
        const le = str.indexOf('\n', i + 1);
        if (labelBoundaryLine(str.slice(i + 1, le === -1 ? undefined : le), openQuoteDepth, depthAt(i + 1))) return -1;
        continue;
      }
      if (ch === '[') depth += 1;
      else if (ch === ']') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  };
  // The inline DESTINATION may contain balanced parentheses at ANY depth
  // ("/x(a(b(c)))/../contact/" — CommonMark accepts them; the browser
  // resolves the full path), so it is parsed procedurally: an
  // angle-bracketed form, or a bare run tracking paren depth, ending at
  // whitespace (an optional title may follow) or the link's closing ")".
  // Whitespace is allowed inside the parentheses ("( /contact/ )"); an
  // UNBALANCED destination is not a link.
  // Whitespace INSIDE the link syntax may include single newlines but
  // never a BLANK line — that ends the paragraph, so "(\n\n/contact/)"
  // renders no link.
  const skipInlineWs = (str, from) => {
    let k = from;
    let nl = 0;
    while (k < str.length && /[ \t\n]/.test(str[k])) {
      if (str[k] === '\n') { nl += 1; if (nl > 1) return -1; }
      k += 1;
    }
    return k;
  };
  const parseInlineDest = (str) => {
    if (str[0] !== '(') return null;
    let i = skipInlineWs(str, 1);
    if (i === -1) return null;
    let destRaw;
    if (str[i] === '<') {
      const close = str.indexOf('>', i + 1);
      const nl = str.indexOf('\n', i + 1);
      if (close === -1 || (nl !== -1 && nl < close)) return null;
      destRaw = str.slice(i, close + 1);
      i = close + 1;
    } else {
      let depth = 0;
      const from = i;
      while (i < str.length) {
        const ch = str[i];
        if (ch === '\\' && i + 1 < str.length) { i += 2; continue; }
        if (/\s/.test(ch)) break;
        if (ch === '(') depth += 1;
        else if (ch === ')') { if (depth === 0) break; depth -= 1; }
        i += 1;
      }
      if (depth > 0 || i === from) return null;
      destRaw = str.slice(from, i);
    }
    // Only whitespace, then an optional VALID title ('"…"', "'…'", "(…)"),
    // then whitespace and the closing ")" may follow the destination —
    // "(/contact/ garbage)" renders no link.
    let j = skipInlineWs(str, i);
    if (j === -1) return null;
    if (str[j] === '"' || str[j] === "'" || str[j] === '(') {
      const closeCh = str[j] === '(' ? ')' : str[j];
      const parenTitle = str[j] === '(';
      j += 1;
      while (j < str.length && str[j] !== closeCh) {
        if (str[j] === '\\') { j += 1; }
        else if (parenTitle && str[j] === '(') return null;
        j += 1;
      }
      if (j >= str.length) return null;
      j = skipInlineWs(str, j + 1);
      if (j === -1) return null;
    }
    if (str[j] !== ')') return null;
    return { destRaw, end: j };
  };
  const refLabel = /^\[((?:\\[\s\S]|[^\]\\])*)\]/;
  // CommonMark forbids a link INSIDE a link: when an outer bracket pair's
  // label itself contains a live link (inline, full-reference, or
  // shortcut), the INNER link wins and the outer brackets render as
  // literal text — so an outer candidate whose label carries one is
  // rejected without advancing, letting the walk find the inner link.
  const labelContainsLink = (text, openQuoteDepth) => {
    for (let j = 0; j < text.length; j += 1) {
      if (text[j] !== '[' || oddEscaped(text, j)) continue;
      if (text[j - 1] === '!' && !oddEscaped(text, j - 1)) continue; // images MAY nest in links
      const lEnd = balancedLabelEnd(text, j, openQuoteDepth, () => openQuoteDepth);
      if (lEnd === -1) continue;
      const after = text.slice(lEnd + 1);
      if (parseInlineDest(after)) return true;
      const fullRef = after.match(refLabel);
      if (fullRef && defs.get(label(fullRef[1] || text.slice(j + 1, lEnd)))) return true;
      if (after[0] !== '(' && after[0] !== ':' && after[0] !== '[' && defs.get(label(text.slice(j + 1, lEnd)))) return true;
      j = lEnd;
    }
    return false;
  };
  for (let i = 0; i < sMd.length; i += 1) {
    if (sMd[i] !== '[' || oddEscaped(sMd, i)) continue;
    // An UNESCAPED "!" directly before means image syntax `![alt](src)` —
    // not a link; "\\![link]" is a literal "!" followed by a real link.
    if (sMd[i - 1] === '!' && !oddEscaped(sMd, i - 1)) continue;
    const openQuoteDepth = depthAtPos(i);
    const end = balancedLabelEnd(sMd, i, openQuoteDepth, depthAtPos);
    if (end === -1) continue;
    const text = sMd.slice(i + 1, end);
    if (!text) { i = end; continue; }
    if (labelContainsLink(text, openQuoteDepth)) continue;
    const rest = sMd.slice(end + 1);
    const inline = parseInlineDest(rest);
    if (inline) {
      links.push({ anchor: text, href: dest(inline.destRaw) });
      consumed.push([i, end + 2 + inline.end]);
      i = end + 1 + inline.end;
      continue;
    }
    // A following "(" without a parseable destination, or a ":" (this is a
    // definition line, registered above), is never a shortcut reference.
    if (rest[0] === '(' || rest[0] === ':') { i = end; continue; }
    const full = rest.match(refLabel);
    if (full) {
      // Full reference `[text][label]` (an empty label collapses to text).
      const href = defs.get(label(full[1] || text));
      if (href) links.push({ anchor: text, href });
      i = end + full[0].length;
      continue;
    }
    if (rest[0] === '[') { i = end; continue; }
    // Shortcut reference: a bare `[Label]` whose label has a definition.
    const href = defs.get(label(text));
    if (href) links.push({ anchor: text, href });
    i = end;
  }
  // Quoted OR unquoted href (`<a href=/contact/>` is legal HTML).
  // Quoted, unquoted, or literal JSX string-expression href — quote OR
  // non-interpolated template literal (`href={"/contact/"}`,
  // href={`/contact/`}). The backtick arm mirrors the guardrails'
  // PLAIN_STRING_LITERAL_RE: `$` excluded, so an interpolated template
  // (a dynamic destination) never reads as a static one.
  // The attribute region is QUOTE-AWARE — a quoted value may contain ">"
  // (`title="1 > 0"`), so quoted strings are consumed atomically and never
  // char-by-char (the bare class excludes quotes to prevent that).
  // (?<![\w-])href — the ATTRIBUTE named href, never the suffix of another
  // attribute (`data-href="…"`).
  const html = /<a\b(?:"[^"]*"|'[^']*'|[^>"'])*?(?<![\w-])href\s*=\s*(?:\{\s*["']([^"']+)["']\s*\}|\{\s*`([^`$]+)`\s*\}|"([^"]+)"|'([^']+)'|([^\s>"'{]+))(?:"[^"]*"|'[^']*'|[^>"'])*>([\s\S]*?)<\/a\s*>/gi;
  // Nested-tag stripping is quote-aware too — an inner tag's quoted
  // attribute may contain ">" (`<span title="1 > 0">`).
  while ((m = html.exec(s)) !== null) links.push({ anchor: m[6].replace(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g, ''), href: dest(m[1] || m[2] || m[3] || m[4] || m[5]) });
  // CommonMark AUTOLINKS (`<https://…>`) render as live links whose anchor
  // is the bare URL — first-party ones canonicalize through dest(). A
  // bracketed URL already CONSUMED as an inline-link destination or a
  // reference definition is not a separate autolink.
  const auto = /<(https?:\/\/[^<>\s]+)>/gi;
  while ((m = auto.exec(s)) !== null) {
    const at = m.index;
    if (consumed.some(([a, b]) => at >= a && at < b)) continue;
    links.push({ anchor: m[1], href: dest(m[1]) });
  }
  return links;
}

// Anchor text as RENDERED: HTML character references decoded (through the
// guardrails' fail-closed decoder), markdown decoration stripped,
// whitespace collapsed.
function plainAnchor(raw) {
  const { decodeEntitiesForScan } = require('./content-guardrails');
  return decodeEntitiesForScan(String(raw || ''))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n.toLowerCase()])
    .replace(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function conversionCtaLinks(body) {
  const out = [];
  for (const link of extractLinks(body)) {
    if (!isConversionPath(link.href)) continue;
    // Classify on the DECORATION-STRIPPED anchor — `[**Request a Quote**]`
    // must be read as "Request a Quote", not evade the gate on a leading
    // asterisk.
    const anchor = plainAnchor(link.anchor);
    // Service names count only in the estimate/quote SUBJECT — the words up
    // to and including the estimate/quote keyword. Trailing context ("…for
    // Your Lawn", "…on your property") is not a service declaration.
    const kw = anchor.match(/\b(?:estimates?|estimated|estimating|estimation|quotes?|quotation)\b/i);
    const termsIn = (text) => Object.entries(CTA_ANCHOR_SERVICE_TERMS)
      .filter(([, re]) => re.test(text))
      .map(([svc]) => svc);
    let subject = anchor;
    let named;
    const contextNamed = [];
    if (kw) {
      const end = kw.index + kw[0].length;
      subject = anchor.slice(0, end);
      named = termsIn(subject);
      // A "for/on <phrase>" suffix can NAME the service ("…for Termite
      // Control", "…for Your Termite Problem") — count service terms in it.
      // Property-context nouns after a determiner/possessive ("for your
      // lawn", "on the trees") describe WHERE, not a service, so the
      // place-shaped services (lawn, tree-shrub) are dropped in that form.
      const after = anchor.slice(end).match(/^\s+(?:for|on|to|against)\s+((?:[a-z0-9&.'-]+\s?){1,5})/i);
      if (after) {
        const phrase = after[1];
        // Place-shaped when a determiner sits directly before the place
        // noun anywhere in the phrase ("for your lawn", "to protect your
        // lawn") — "to Control Termites" names the service.
        const environmental = /\b(?:your|my|our|the|a|an|this|that)\s+(?:[a-z&-]+\s+)?(?:lawn|tree|shrub)/i.test(phrase);
        for (const svc of termsIn(phrase)) {
          // "…for your lawn" names a PLACE unless lawn is this post's own
          // service — recorded separately; the brief-aware checks below
          // count it only when allowed.
          if (environmental && (svc === 'lawn' || svc === 'tree-shrub')) contextNamed.push(svc);
          else if (!named.includes(svc)) named.push(svc);
        }
      }
      // Coordinated subjects ("Termite and Pool Cleaning Quote") must be
      // service-bearing in EVERY part — a part naming no known service is an
      // unrecognized service, not harmless filler.
      // Coordination is judged across the FULL anchor ("Get a Termite Quote
      // and Pool Cleaning Estimate"), not just the text before the first
      // keyword.
      const parts = anchor.split(/\s*,\s*|\s*\+\s*|\s+(?:and|&|or|\/|plus)\s+/i);
      if (parts.length > 1) {
        // Filler + service DESCRIPTORS ("Control and Prevention Quote") are
        // not separate services; an unlisted noun ("Pool Cleaning") is.
        const filler = /^(?:(?:get|request|book|schedule|claim|start|see|view|a|an|my|your|our|the|free|fast|quick|instant|online|estimate|estimates|quote|quotes|pricing|price|control|prevention|treatment|treatments|removal|protection|management|service|services|plan|plans|program|programs|care|maintenance|exclusion|monitoring)\s*)+$/i;
        // A trailing "for/on …" context clause is not a coordinated part.
        const coordinated = parts.map((part) => part.replace(/\s+(?:for|on)\s+.*$/i, '').trim()).filter(Boolean);
        const keywordRe = /\b(?:estimates?|estimated|estimating|estimation|quotes?|quotation)\b/i;
        const requestVerbRe = new RegExp(`^(?:${REQUEST_VERB_SOURCE})\\b`, 'i');
        // A part is a SERVICE-REQUEST clause when it carries the estimate/
        // quote keyword OR opens with a request verb ("Schedule Pool
        // Cleaning") — such a clause naming no known service is an unknown
        // service. A bare NOUN PHRASE part ("…Quote and Pool Cleaning")
        // shares the anchor's request/quote context — the CTA is requesting
        // that service too — so it is judged the same way. Only editorial
        // clauses led by a non-request verb ("…and See Our Approach") are
        // exempt.
        const editorialLeadRe = /^(?:see|view|learn|read|explore|discover|compare|browse|check|watch|meet|find|download|visit|contact|call|why|how|what)\b/i;
        const unknownPart = coordinated.some((part) => {
          if (termsIn(part).length > 0 || filler.test(part)) return false;
          if (keywordRe.test(part) || requestVerbRe.test(part)) return true;
          return !editorialLeadRe.test(part);
        });
        if (unknownPart) named = [...named, 'unknown'];
        for (const part of coordinated) for (const svc of termsIn(part)) if (!named.includes(svc)) named.push(svc);
      }
    } else {
      named = termsIn(subject);
    }
    // "Lawn pest control" is ONE service (lawn-pest-control → lawn), not
    // lawn + pest — don't let the compound phrase read as a wrong-service mix.
    if (/\blawn[- ]pest/i.test(subject)) named = named.filter((svc) => svc !== 'pest');
    out.push({
      anchor,
      hasEstimateWording: Boolean(kw),
      named,
      contextNamed,
    });
  }
  return out;
}

// "Pest" is an umbrella word ("Get a Termite Pest Control Quote"): when the
// anchor ALSO positively names the brief's own service (or family), the
// umbrella term is dropped from the named set. A pest-only anchor on a
// non-pest-family brief still does not qualify.
function effectiveNamed(link, allowed) {
  // Place-shaped nouns ("…for your lawn") count as the service only when
  // they ARE this post's allowed service.
  const named = [...link.named, ...(allowed ? link.contextNamed.filter((svc) => allowed.has(svc)) : [])];
  if (!allowed || !named.includes('pest')) return named;
  const own = named.some((svc) => svc !== 'pest' && allowed.has(svc));
  return own ? named.filter((svc) => svc !== 'pest') : named;
}

function hasConversionCta(body, brief = {}) {
  // Owner rule 2026-08-27: the conversion CTA is judged on the LINK ANCHOR,
  // not loose body wording — at least one link to a conversion path whose
  // anchor carries estimate/quote wording ("Get My Free Termite Estimate",
  // "Request a Quote"), and if the anchor names a service it must be the
  // brief's own service (or its family). Discussion text stays independent:
  // a termite post may talk about inspections all it wants;
  // `[Schedule Service](/contact/)`, "Get an estimate. [Click here](/contact/)",
  // and a lawn-care quote anchor on a termite post all fail to qualify.
  const briefService = ctaBriefService(brief.service);
  const allowed = briefService ? allowedAnchorServices(briefService) : null;
  // With a known brief service the qualifying CTA must POSITIVELY name it
  // (or its family) — a generic "Request a Quote" or an unrecognized phrase
  // can ride along as an extra CTA but does not satisfy "tied to the
  // post's service" on its own.
  return conversionCtaLinks(body).some((link) => {
    if (!link.hasEstimateWording) return false;
    // Presence requires an ACTIONABLE anchor — a request verb leading it or
    // an infinitive invitation. A prose reference ("our termite estimate
    // process") AND a bare noun phrase ("Termite Estimate Process") are
    // descriptions, not CTAs — neither can satisfy presence.
    if (!ACTION_VERB_RE.test(link.anchor)) return false;
    if (!allowed) return true;
    const named = effectiveNamed(link, allowed);
    return named.length > 0 && named.every((svc) => allowed.has(svc));
  });
}

// EVERY conversion CTA anchor must comply — violations are flagged even
// when a valid CTA exists elsewhere in the body:
//   - an estimate/quote anchor naming ANY service outside the brief's own
//     (+ family + generic pest) — "Get a Termite and Lawn Quote" on a
//     termite post is mixed wording, not a pass;
//   - an imperative CTA-shaped anchor with no estimate/quote wording at
//     all ("Schedule Service", "Click here").
function badCtaAnchor(body, brief = {}) {
  const briefService = ctaBriefService(brief.service);
  const allowed = briefService ? allowedAnchorServices(briefService) : null;
  const bad = conversionCtaLinks(body).find((link) => {
    if (link.hasEstimateWording) {
      // With a known brief service, EVERY estimate/quote anchor must name it
      // (or its family) — a generic "Request a Quote" is not tied to the post.
      if (!allowed) return false;
      const named = effectiveNamed(link, allowed);
      return named.length === 0 || !named.every((svc) => allowed.has(svc));
    }
    return !isProseReferenceAnchor(link.anchor);
  });
  return bad ? bad.anchor : null;
}

// Deterministic backstop to the writer prompt's CTA-wording rule (owner
// 2026-08-27): a markdown link whose ANCHOR TEXT is inspection-request
// wording is the forbidden CTA shape, wherever it points.
// Inspection-REQUEST phrasing only ("Request an Inspection", "Book a Termite
// Inspection", "Schedule your inspection") — editorial anchors like "Get
// ready for your termite inspection" are not CTAs and must not be flagged.
// optional CTA lead-in ("Click to", "Tap here to") + verb + optional
// determiner + up to four qualifier words + "inspection":
// "Request an Inspection", "Get a Termite Inspection", "Schedule a Free
// Professional Termite Inspection", "Click to Schedule a Termite
// Inspection". Qualifiers exclude the function words that mark EDITORIAL
// phrasing ("Get ready for your termite inspection" — "ready"/"for" break
// the request shape), so those anchors still pass.
const FORBIDDEN_CTA_ANCHOR_RE = new RegExp(`^(?:please\\s+)?(?:(?:click|tap)\\s+(?:here\\s+)?to\\s+|(?:get\\s+)?ready\\s+to\\s+)?(?:please\\s+)?(?:${REQUEST_VERB_SOURCE})\\s+(?:(?:a|an|your|my|the|our|free)\\s+)?(?:(?!(?:for|to|of|with|about|before|after|during|from|by|on|in|at|ready|prepared|set)\\b)[a-z0-9&-]+\\s+){0,4}inspections?\\b(?!\\s+(?:checklist|guide|tips|report|article|faq|faqs|questions|cost|costs|process|prep|preparation|requirements|basics|overview|explained))`, 'i');
// A REQUEST-VERB-LED anchor on a SERVICE or CITY page destination is a
// conversion CTA in disguise ("Schedule Termite Service" →
// /termite-control/) — the estimate/quote wording rule covers it too.
// Descriptive service links (bare noun phrases, prose references,
// editorial "Get ready …" shapes) stay exempt.
const REQUEST_LED_RE = new RegExp(`^(?:please\\s+)?(?:(?:click|tap)\\s+(?:here\\s+)?to\\s+|(?:get\\s+)?ready\\s+to\\s+)?(?:please\\s+)?(?:${REQUEST_VERB_SOURCE}|call|contact|text)\\s+(?!(?:ready|prepared|set)\\b)`, 'i');
const ESTIMATE_KW_RE = /\b(?:estimates?|estimated|estimating|estimation|quotes?|quotation)\b/i;
function isServicePageRequestCta(href, anchor) {
  if (!String(href || '').startsWith('/') || isConversionPath(href)) return false;
  const { inferLinkReason } = require('./blog-seo-contract')._internals;
  if (!['service', 'city'].includes(inferLinkReason(href))) return false;
  return REQUEST_LED_RE.test(anchor) && !ESTIMATE_KW_RE.test(anchor);
}

function forbiddenCtaAnchor(body) {
  // Any link (markdown or HTML, any destination — the legacy pattern points
  // at service pages, not conversion paths) whose decoration-stripped anchor
  // is inspection-request wording, or a request-led service-page CTA
  // without estimate/quote wording.
  for (const link of extractLinks(body)) {
    const anchor = plainAnchor(link.anchor);
    if (FORBIDDEN_CTA_ANCHOR_RE.test(anchor)) return anchor;
    if (isServicePageRequestCta(link.href, anchor)) return anchor;
  }
  return null;
}

// CTA violations shared with content-guardrails so EVERY blog publish lane
// (manual publish-astro, legacy BlogWriter, refresh) enforces the owner
// rule 2026-08-27: the brief-INDEPENDENT half (inspection-request anchors
// and wording-free actionable conversion anchors) always runs; the
// SERVICE-TYING half runs whenever the caller knows the post's service —
// refresh and legacy lanes hold it on the post row, not a brief, so a
// termite refresh adding "[Request a Lawn Care Quote]" parks there too.
// Legacy rows may carry the topic on several fields (category + tag). The
// MOST SPECIFIC resolvable candidates win: a specialty (it rides a
// family's conversion path) over a broad service, and any of those over
// the "pest" umbrella — the family target of every pest specialty — so a
// coarse legacy category ("pest-control") never authorizes sibling
// specialties when a more specific tag resolves too ("Termites" must not
// admit a cockroach quote). Equally specific candidates still union.
// The canonical BLOG_TAGS taxonomy (blog-writer.js) includes tags that
// name MULTIPLE services or don't reduce to a vocabulary key by
// suffix-stripping — resolve them explicitly so a legacy row carrying one
// still arms the service-aware check.
const CANONICAL_TAG_SERVICES = {
  'fleas & ticks': ['flea', 'tick'],
  'fleas and ticks': ['flea', 'tick'],
  'stinging insects': ['wasp'],
  'lawn disease': ['lawn'],
  'lawn pests': ['lawn'],
  'lawn pest': ['lawn'],
};

function collectForbiddenCtaAnchors(body, { service = null } = {}) {
  const out = [];
  let allowed = null;
  const resolvedCandidates = [];
  const addResolved = (resolved) => {
    resolvedCandidates.push({ resolved, rank: CTA_SERVICE_FAMILY[resolved] ? 2 : (resolved === 'pest' ? 0 : 1) });
  };
  for (const candidate of [].concat(service ?? []).filter(Boolean)) {
    const canonical = CANONICAL_TAG_SERVICES[String(candidate).toLowerCase().trim()];
    if (canonical) { canonical.forEach(addResolved); continue; }
    let resolved = null;
    try { resolved = ctaBriefService(candidate); } catch (err) { resolved = null; }
    // Unresolvable candidates (a non-service category like "seasonal")
    // carry no CTA vocabulary — they contribute nothing.
    if (!resolved || !(CTA_ANCHOR_SERVICE_TERMS[resolved] || CTA_SERVICE_FAMILY[resolved])) continue;
    addResolved(resolved);
  }
  if (resolvedCandidates.length) {
    const top = Math.max(...resolvedCandidates.map((c) => c.rank));
    allowed = new Set();
    for (const c of resolvedCandidates) {
      if (c.rank !== top) continue;
      for (const svc of allowedAnchorServices(c.resolved)) allowed.add(svc);
    }
  }
  for (const link of extractLinks(body)) {
    const anchor = plainAnchor(link.anchor);
    if (FORBIDDEN_CTA_ANCHOR_RE.test(anchor)) { out.push(anchor); continue; }
    if (!isConversionPath(link.href)) {
      // Request-led service/city-page CTAs (see isServicePageRequestCta).
      if (isServicePageRequestCta(link.href, anchor)) out.push(anchor);
      continue;
    }
    if (!ESTIMATE_KW_RE.test(anchor) && !isProseReferenceAnchor(anchor)) out.push(anchor);
  }
  if (allowed) {
    // Same posture as badCtaAnchor: EVERY estimate/quote conversion anchor
    // must positively name an allowed service — a wrong-service or fully
    // generic anchor is flagged even when a valid CTA exists elsewhere.
    for (const link of conversionCtaLinks(body)) {
      if (!link.hasEstimateWording) continue;
      const named = effectiveNamed(link, allowed);
      if (named.length === 0 || !named.every((svc) => allowed.has(svc))) out.push(link.anchor);
    }
  }
  return out;
}

function faqRequired(brief = {}) {
  // NO-FAQ policy override: a FAQ-blocked topic (content-guardrails.
  // isFaqBlockedService — the same single-sourced module the publish-time P0
  // enforces) can never require an FAQ, even if a legacy/stale brief still
  // carries an "FAQ section (…)" required_section. Without this, a compliant
  // no-FAQ draft raises P1_MISSING_FAQ_WHEN_BRIEF_REQUIRED_FAQ and — at the
  // live AUTONOMOUS_CONTENT_MAX_P1_FINDINGS=0 canary config — gets routed out
  // of publish as a failure. Belt-and-braces with content-brief-builder, which
  // now omits the FAQ required_section for blocked topics at compose time.
  //
  // EXCEPTION (narrow): an operator-authored intercept brief whose seeded
  // manifest mandates an FAQ (voice_constraints.operator_brief.faq_required
  // — set by intercept-brief-seeder from the manifest payload; owner
  // directive 2026-06-11) keeps the FAQ requirement even on a blocked
  // service id, so a draft that omits the operator's FAQ still P1s. Mirrors
  // content-guardrails' operatorFaqException + content-quality-gate's
  // operatorFaqMandate.
  if (!operatorFaqMandate(brief) && isFaqBlockedService([
    brief.service,
    brief.tag,
    brief.customer_signal?.service,
    brief.customer_signal?.topic,
  ])) return false;
  const required = Array.isArray(brief.required_sections) ? brief.required_sections : safeParseArray(brief.required_sections);
  return required.some((section) => /\bfaq|frequently asked|common questions\b/i.test(String(section || '')));
}

function operatorFaqMandate(brief = {}) {
  let voice = brief.voice_constraints;
  if (typeof voice === 'string') {
    try { voice = JSON.parse(voice); } catch { voice = null; }
  }
  return !!(voice && typeof voice === 'object' && voice.operator_brief?.faq_required === true);
}

function requiredInternalLinkCount(brief = {}) {
  let count = 1; // conversion
  if (brief.service) count += 1;
  if (brief.city) count += 1;
  return count;
}

function isGenericAnchor(anchor = '') {
  return /^(click here|learn more|read more|this page|here)$/i.test(String(anchor || '').trim());
}

function countCityMentions(body, city) {
  const target = String(city || '').toLowerCase();
  if (!target) return 0;
  return (String(body || '').toLowerCase().match(new RegExp(`\\b${escapeRegExp(target)}\\b`, 'g')) || []).length;
}

function schemaMentionsHiddenFaq(draft = {}, renderedHtml = null) {
  const body = String(draft.body || renderedHtml || '');
  const schemaText = JSON.stringify(draft.schema || draft.frontmatter?.schema || draft.frontmatter?.schema_types || '');
  return /FAQPage/i.test(schemaText) && extractVisibleFaqs(body).length === 0;
}

// Single-sourced from waves-phones.js (shared with content-quality-gate and
// content-guardrails' tel: destination check) — the per-file copies had
// already drifted once (last-7 vs full-10 keys). isWavesPhone covers every
// owned line incl. spoke/GBP tracking numbers, which legitimately appear in
// refresh/spoke copy.
const { isWavesPhone } = require('./waves-phones');

function detectPii(body = '') {
  const text = String(body || '');
  // Same E.164-capable pattern as content-quality-gate's redaction check
  // (compact +1/11-digit forms had no interior word boundary to match on),
  // including its optional attached-extension arm: without it the trailing
  // \b cannot sit between the last digit and an `x` (both word chars), so
  // `212-555-1234x99` matched nothing here — and supporting blogs don't run
  // redaction_passed, making this the only phone guard on that path. The
  // CORE number is captured separately so extension digits never pollute
  // the last-10 compare against the Waves allowlist.
  const phoneRe = /(?<!\d)(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?\b/gi;
  let pm;
  while ((pm = phoneRe.exec(text)) !== null) {
    const digits = pm[1].replace(/\D/g, '');
    const last10 = digits.length >= 10 ? digits.slice(-10) : null;
    if (!last10) return true;
    if (!isWavesPhone(last10)) return true;
  }
  return /[\w._%+-]+@[\w-]+\.[A-Za-z]{2,}/.test(text);
}

// Single-sourced from content-guardrails (comma-grouped amounts, single-digit
// prices, calculator-framing AND regulatory-fine exemptions) — this gate's
// previous private copy had drifted on all four.
// Mirrors the runner's briefForbidsCompetitorPrices: a brief may forbid
// dollar amounts even though it is an intercept ("NO TruGreen dollar amounts
// anywhere in the post"). Tight on purpose — "no" must directly negate the
// noun, or unrelated prose like "no-cost retreatments; large price" matches.
const BRIEF_PRICE_PROHIBITION_RE = /\bno\s+(?:[\w-]+\s+){0,3}(?:dollar amounts?|prices|pricing)\b/i;
function briefForbidsPrices(...sources) {
  let forbids = false;
  const walk = (v) => {
    if (forbids) return;
    if (typeof v === 'string') { if (BRIEF_PRICE_PROHIBITION_RE.test(v)) forbids = true; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try { sources.forEach(walk); } catch { return true; }
  return forbids;
}

function detectHardcodedPrice(body = '', brief = null) {
  // Competitor-price provenance = the persisted TRUE-intercept marker, not
  // the bucket alone: category/spoke seeds share the operator_intercept
  // bucket and must keep the full price guard (Codex P0). Mined drafts and
  // legacy briefs without the marker fail closed.
  const isOperatorIntercept = brief?.gsc_signal?.bucket === 'operator_intercept';
  const thirdPartyCitations = isOperatorIntercept && brief?.gsc_signal?.intercept === true;
  // The source-and-date requirement means the price check also needs the
  // CITATION context, or a properly sourced intercept parks here even though
  // the run-context guardrail passed it — the same drift that put a private
  // copy of this check out of step before (Codex). Sources come off the
  // persisted brief so this stays usable from remediation.
  const operatorBrief = brief?.voice_constraints?.operator_brief || null;
  const requiredSourceUrls = [
    ...(Array.isArray(operatorBrief?.required_sources) ? operatorBrief.required_sources : []),
    ...(Array.isArray(operatorBrief?.sources) ? operatorBrief.sources : []),
  ];
  // A brief-level ban outranks every exemption here too (Codex).
  const forbidAllPrices = briefForbidsPrices(operatorBrief, brief?.gsc_signal);
  return findHardcodedPrice(body, {
    thirdPartyCitations,
    operatorCitations: isOperatorIntercept,
    requiredSourceUrls,
    forbidAllPrices,
  }) !== null;
}

function hasDuplicateIntentFailure(result = {}) {
  const text = JSON.stringify(result || {});
  return /\b(duplicate|jaccard|cannibal|intent)\b/i.test(text);
}

function safeParseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  evaluate,
  collectForbiddenCtaAnchors,
  summarizeFindings,
  P0_CODES,
  P1_CODES,
  P2_CODES,
  _internals: {
    scoreFindings,
    finding,
    hasConversionCta,
    faqRequired,
    detectPii,
    detectHardcodedPrice,
    hasDuplicateIntentFailure,
    requiredInternalLinkCount,
    isGenericAnchor,
  },
};
