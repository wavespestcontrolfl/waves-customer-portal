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
} = require('./blog-seo-contract');
const { isFaqBlockedService, faqPolicyTopicFields } = require('./content-guardrails');

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
  if (detectHardcodedPrice(body)) {
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
  if (brief.service && !hasIncludedLinkReason(contract, 'service')) {
    findings.push(finding('P1', 'P1_MISSING_SERVICE_LINK', 'Required service link is not included in the draft body.', 'Add one relevant service/hub link using descriptive anchor text.'));
  }
  if (brief.city && !hasIncludedLinkReason(contract, 'city')) {
    findings.push(finding('P1', 'P1_MISSING_CITY_LINK_WHEN_CITY_TOPIC', 'City-focused blog draft is missing a city page link in the body.', 'Add the matching local service page link.'));
  }
  if (!hasLinkReason(contract, 'conversion') || !hasConversionCta(body)) {
    findings.push(finding('P1', 'P1_MISSING_CONVERSION_CTA', 'Draft is missing a clear conversion CTA.', 'Add an early and final CTA linking to contact, quote, inspection, or estimate paths.'));
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
  if (brief.city && countCityMentions(body, brief.city) < 1) {
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

function hasIncludedLinkReason(contract, reason) {
  return Array.isArray(contract.includedInternalLinks)
    && contract.includedInternalLinks.some((link) => link.reason === reason);
}

function hasConversionCta(body) {
  return /\b(request a quote|schedule|contact waves|call waves|free inspection|estimate|book|inspection)\b/i.test(String(body || ''))
    && /\]\(\/(?:contact|[^)]*quote|[^)]*estimate|pest-control-calculator)[^)]*\)/i.test(String(body || ''));
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
  // faqPolicyTopicFields = the single-sourced topic-field list shared with
  // content-quality-gate and the runner's publish-path guardrail call.
  if (isFaqBlockedService(faqPolicyTopicFields({}, brief))) return false;
  const required = Array.isArray(brief.required_sections) ? brief.required_sections : safeParseArray(brief.required_sections);
  return required.some((section) => /\bfaq|frequently asked|common questions\b/i.test(String(section || '')));
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

const WAVES_PHONE_LAST_SEVEN = new Set([
  '3187612', '2972817', '2972606', '2973337', '2402066', '2975749',
]);

function detectPii(body = '') {
  const text = String(body || '');
  const phoneRe = /\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
  const phoneMatches = text.match(phoneRe) || [];
  for (const raw of phoneMatches) {
    const digits = raw.replace(/\D/g, '');
    const last10 = digits.length >= 10 ? digits.slice(-10) : null;
    if (!last10) return true;
    if (!WAVES_PHONE_LAST_SEVEN.has(last10.slice(-7))) return true;
  }
  return /[\w._%+-]+@[\w-]+\.[A-Za-z]{2,}/.test(text);
}

function detectHardcodedPrice(body = '') {
  const text = String(body || '');
  const priceRe = /(^|[\s(])\$\s?\d{2,5}\b|\b\d{2,5}\s+(?:dollars|bucks)\b/gi;
  let match;
  while ((match = priceRe.exec(text)) !== null) {
    const window = text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + 120));
    if (/\b(calculator|estimate|quote|pricing varies|depends|range)\b/i.test(window)) continue;
    return true;
  }
  return false;
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
