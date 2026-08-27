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
  'tree-shrub': /\btree\b|\bshrub/i,
  'bed-bug': /\bbed[ -]?bug/i,
  cockroach: /\b(?:cock)?roach(?:es)?\b/i,
  ant: /\bants?\b/i,
  spider: /\bspider/i,
  flea: /\bfleas?\b/i,
  tick: /\bticks?\b/i,
  wasp: /\bwasps?\b|\bhornets?\b|\bbees?\b/i,
  wdo: /\bwdo\b|wood[- ]destroying/i,
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
const ACTION_VERB_RE = /\b(?:request|schedule|book|get|call|click|start|claim|arrange|visit|open|tap|reach|talk|see|view|learn)\b/i;
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
  return new Set([...Object.values(SERVICE_CONVERSION_LINK || {}), '/contact/', '/pest-control-calculator/', '/pest-control-quote/', '/quote/', '/estimate/']);
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
function renderedText(body) {
  const { blankNonRenderedMarkdown } = require('./content-guardrails');
  return blankNonRenderedMarkdown(body);
}

function extractLinks(body) {
  const s = renderedText(body);
  const links = [];
  // `(?<!!)` — a Markdown image `![alt](src)` is not a link.
  // (?<!(?<!\\)!) — an UNESCAPED "!" means image syntax; "\\![link]" is a
  // literal "!" followed by a real link.
  // Escape parity: "!" preceded by an EVEN run of backslashes (incl. zero)
  // is a live image marker; an odd run escapes it. Whitespace is allowed
  // inside the parentheses ("( /contact/ )").
  const md = /(?<!(?<!\\)(?:\\\\)*!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
  let m;
  // CommonMark allows angle-bracketed destinations: [x](</contact/>) and
  // [ref]: </contact/> — strip the brackets; and an absolute first-party
  // URL (hub or any spoke host, per the guardrails' hubHostSet) IS the
  // site-relative path spelled long-form.
  const { hubHostSet } = require('./content-guardrails');
  const firstParty = hubHostSet();
  const dest = (h) => {
    const raw = String(h || '').replace(/^<|>$/g, '');
    const abs = raw.match(/^https?:\/\/([^/\s]+)(\/[^\s]*)?$/i);
    if (abs && firstParty.has(abs[1].toLowerCase())) return abs[2] || '/';
    return raw;
  };
  while ((m = md.exec(s)) !== null) links.push({ anchor: m[1], href: dest(m[2]) });
  // Reference-style links: [text][ref] / [text][] with a [ref]: /url definition.
  // CommonMark label matching is case-insensitive with internal whitespace
  // collapsed — normalize both the definition and the reference the same way.
  const label = (l) => String(l || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const defs = new Map();
  const def = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/gm;
  while ((m = def.exec(s)) !== null) defs.set(label(m[1]), dest(m[2]));
  if (defs.size) {
    const ref = /(?<!(?<!\\)(?:\\\\)*!)\[([^\]]+)\]\[([^\]]*)\]/g;
    while ((m = ref.exec(s)) !== null) {
      const href = defs.get(label(m[2] || m[1]));
      if (href) links.push({ anchor: m[1], href });
    }
    // Shortcut references: a bare `[Label]` whose label has a definition and
    // that is not itself an inline/full reference or the definition line.
    // (?<![\]!]) — skip the label half of a full reference (`[text][label]`)
    // and image syntax; (?![\[(:]) — skip inline/full references and definitions.
    const shortcut = /(?<!\])(?<!(?<!\\)(?:\\\\)*!)\[([^\]]+)\](?![\[(:])/g;
    while ((m = shortcut.exec(s)) !== null) {
      const href = defs.get(label(m[1]));
      if (href) links.push({ anchor: m[1], href });
    }
  }
  // Quoted OR unquoted href (`<a href=/contact/>` is legal HTML).
  // Quoted, unquoted, or literal JSX string-expression href (`href={"/contact/"}`).
  const html = /<a\b[^>]*\bhref\s*=\s*(?:\{\s*["']([^"']+)["']\s*\}|"([^"]+)"|'([^']+)'|([^\s>"'{]+))[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = html.exec(s)) !== null) links.push({ anchor: m[5].replace(/<[^>]+>/g, ''), href: dest(m[1] || m[2] || m[3] || m[4]) });
  return links;
}

// Anchor text as RENDERED: HTML character references decoded (through the
// guardrails' fail-closed decoder), markdown decoration stripped,
// whitespace collapsed.
function plainAnchor(raw) {
  const { decodeEntitiesForScan } = require('./content-guardrails');
  return decodeEntitiesForScan(String(raw || ''))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n.toLowerCase()])
    .replace(/<[^>]+>/g, '')
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
      const after = anchor.slice(end).match(/^\s+(?:for|on)\s+((?:[a-z&-]+\s?){1,5})/i);
      if (after) {
        const phrase = after[1];
        const environmental = /^(?:your|my|our|the|a|an|this|that)\b/i.test(phrase);
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
      const parts = anchor.split(/\s*,\s*|\s+(?:and|&|or|\/)\s+/i);
      if (parts.length > 1) {
        // Filler + service DESCRIPTORS ("Control and Prevention Quote") are
        // not separate services; an unlisted noun ("Pool Cleaning") is.
        const filler = /^(?:(?:get|request|book|schedule|claim|start|see|view|a|an|my|your|our|the|free|fast|quick|instant|online|estimate|estimates|quote|quotes|pricing|price|control|prevention|treatment|treatments|removal|protection|management|service|services|plan|plans|program|programs|care|maintenance|exclusion|monitoring)\s*)+$/i;
        // A trailing "for/on …" context clause is not a coordinated part.
        const coordinated = parts.map((part) => part.replace(/\s+(?:for|on)\s+.*$/i, '').trim()).filter(Boolean);
        const keywordRe = /\b(?:estimates?|estimated|estimating|estimation|quotes?|quotation)\b/i;
        const requestVerbRe = /^(?:request|schedule|book|get|arrange|order|buy|start|claim)\b/i;
        // A part is a SERVICE-REQUEST clause when it carries the estimate/
        // quote keyword OR opens with a request verb ("Schedule Pool
        // Cleaning"); such a clause naming no known service is an unknown
        // service. Editorial clauses ("…and See Our Approach") are neither.
        const unknownPart = coordinated.some((part) => (keywordRe.test(part) || requestVerbRe.test(part)) && termsIn(part).length === 0 && !filler.test(part));
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
// verb + optional determiner + up to two qualifier words + "inspection":
// "Request an Inspection", "Get a Termite Inspection", "Schedule your free
// inspection", "Arrange an inspection" — but NOT "Get ready for your termite
// inspection" (four words between verb and noun).
const FORBIDDEN_CTA_ANCHOR_RE = /^(?:request|book|schedule|get|arrange)\s+(?:(?:a|an|your|my|the|our|free)\s+)?(?:[a-z&-]+\s+){0,2}inspection\b(?!\s+(?:checklist|guide|tips|report|article|faq|faqs|questions|cost|costs|process|prep|preparation|requirements|basics|overview|explained))/i;
function forbiddenCtaAnchor(body) {
  // Any link (markdown or HTML, any destination — the legacy pattern points
  // at service pages, not conversion paths) whose decoration-stripped anchor
  // is inspection-request wording.
  for (const link of extractLinks(body)) {
    const anchor = plainAnchor(link.anchor);
    if (FORBIDDEN_CTA_ANCHOR_RE.test(anchor)) return anchor;
  }
  return null;
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
