/**
 * AI visibility gate for published/supporting content.
 *
 * This is deliberately not an "AI SEO" shortcut. It checks whether a
 * page can be crawled, indexed, internally discovered, and extracted as
 * an answer by search systems that rely on the normal web index.
 */

const BOT_AGENTS = ['Googlebot', 'Bingbot', 'OAI-SearchBot'];

function evaluate(input = {}) {
  const {
    url,
    html = '',
    body = '',
    canonicalUrl = null,
    robotsTxt = '',
    internalInboundLinks = 0,
    duplicateIntentRisk = false,
    schemaMatchesVisibleContent = true,
  } = input;

  const findings = [];
  const text = visibleText(html || body);
  const canonical = canonicalUrl || extractCanonical(html);
  const robotsMeta = extractRobotsMeta(html);
  const blockedBots = BOT_AGENTS.filter((agent) => isBlockedByRobotsTxt(robotsTxt, url, agent));

  if (!url) {
    findings.push(finding('P0', 'P0_MISSING_URL', 'Published page URL is missing.', 'Provide the final live URL before visibility checks run.'));
  }
  if (robotsMeta.noindex) {
    findings.push(finding('P0', 'P0_PAGE_NOINDEX', 'Page has a noindex robots directive.', 'Remove noindex before publishing or keep the page out of the autonomous publish lane.'));
  }
  if (blockedBots.length) {
    findings.push(finding('P0', 'P0_BOT_BLOCKED_BY_ROBOTS', `robots.txt blocks ${blockedBots.join(', ')}.`, 'Allow Googlebot, Bingbot, and OAI-SearchBot to crawl public content.'));
  }
  if (!text || text.length < 300) {
    findings.push(finding('P0', 'P0_MAIN_CONTENT_NOT_RENDERED', 'Main answer content is not present in rendered/static HTML.', 'Ensure the answer body is server-rendered or statically generated.'));
  }
  if (canonical && url && !canonicalsMatch(canonical, url)) {
    findings.push(finding('P0', 'P0_CANONICAL_POINTS_ELSEWHERE', 'Canonical points away from the published URL.', 'Set canonical to the live URL unless intentional consolidation is documented.'));
  }
  if (schemaMatchesVisibleContent === false) {
    findings.push(finding('P0', 'P0_SCHEMA_DESCRIBES_HIDDEN_CONTENT', 'Structured data describes hidden or absent content.', 'Keep schema aligned with visible page text.'));
  }
  if (Number(internalInboundLinks || 0) < 1) {
    findings.push(finding('P0', 'P0_NO_CRAWLABLE_INBOUND_INTERNAL_LINK', 'No crawlable inbound internal link is recorded for this page.', 'Add at least one inbound link from a hub, service, city, or related article page.'));
  }
  if (duplicateIntentRisk) {
    findings.push(finding('P0', 'P0_DUPLICATE_INTENT_RISK', 'Duplicate intent risk is above threshold.', 'Refresh, consolidate, or change the angle before publishing another page.'));
  }

  if (!hasAnswerFirstSummary(text)) {
    findings.push(finding('P1', 'P1_NO_ANSWER_FIRST_SUMMARY', 'No concise answer-first summary appears near the top of the page.', 'Open with a direct 2-4 sentence answer before expanding.'));
  }
  if (!/\b(when to call|call waves|contact waves|schedule|inspection|quote|estimate)\b/i.test(text)) {
    findings.push(finding('P1', 'P1_NO_CONVERSION_DECISION_SECTION', 'No clear conversion decision section was found.', 'Add a "when to call a pro" or similar decision threshold.'));
  }
  if (!/\b(florida|southwest florida|swfl|bradenton|sarasota|venice|parrish|lakewood ranch|palmetto|north port|port charlotte|technician|locally)\b/i.test(text)) {
    findings.push(finding('P1', 'P1_NO_LOCAL_PROOF', 'Page lacks clear local proof or service-area context.', 'Add aggregated local observations, seasonality, city context, or technician insight.'));
  }
  if (!/\b(author|reviewed by|last reviewed|last updated)\b/i.test(text + ' ' + html)) {
    findings.push(finding('P1', 'P1_NO_REVIEW_METADATA', 'Author/reviewer/last-reviewed metadata was not detected.', 'Add visible or structured author/reviewer metadata where the template supports it.'));
  }
  if (!/Article|BlogPosting|Service|LocalBusiness|Organization/i.test(html)) {
    findings.push(finding('P1', 'P1_WEAK_ENTITY_GRAPH', 'Structured entity graph was not detected in HTML.', 'Tie Article or BlogPosting to Waves, relevant service, and LocalBusiness/Organization entities.'));
  }
  if (isQuestionLed(input) && !/\b(faq|frequently asked|questions)\b/i.test(text)) {
    findings.push(finding('P1', 'P1_NO_QA_SECTION_FOR_QUESTION_INTENT', 'Question-led intent has no concise Q&A section.', 'Add visible, useful Q&A when the query intent is question-led.'));
  }

  if ((text.match(/\n#{2,3}\s+|<h[23]\b/gi) || []).length < 3) {
    findings.push(finding('P2', 'P2_WEAK_HEADING_STRUCTURE', 'Heading structure may be too thin for extraction.', 'Use descriptive H2/H3 sections for diagnosis, actions, local context, and next steps.'));
  }
  if (/\b(click here|learn more|read more|this page)\b/i.test(text)) {
    findings.push(finding('P2', 'P2_GENERIC_ANCHOR_TEXT', 'Generic anchor text was detected.', 'Use descriptive anchors that name the service, city, or answer topic.'));
  }
  if (/\bFAQ\b/i.test(text) && hasThinFaqAnswers(text)) {
    findings.push(finding('P2', 'P2_THIN_FAQ_ANSWERS', 'One or more FAQ answers appear thin.', 'Answer FAQs directly enough to be useful without requiring another click.'));
  }
  if (/<img\b(?![^>]*\balt=)/i.test(html)) {
    findings.push(finding('P2', 'P2_MISSING_IMAGE_ALT_TEXT', 'At least one image is missing alt text.', 'Add concise alt text for crawlable content images.'));
  }
  if (!/\b(key takeaways|quick answer|what to know)\b/i.test(text)) {
    findings.push(finding('P2', 'P2_NO_KEY_TAKEAWAYS', 'No short key-takeaways block was detected.', 'Add 3-5 concise takeaways when it fits the page intent.'));
  }

  const summary = summarize(findings);
  return {
    passed: summary.p0 === 0,
    findings,
    summary,
    canonical_url: canonical || null,
    robots_meta: robotsMeta.raw || null,
    blocked_bots: blockedBots,
  };
}

/**
 * Pre-publish subset of evaluate(): runs ONLY the P0 checks derivable from the
 * generated HTML/markdown, with no live-site dependency. It deliberately omits
 * the checks that require the published page — robots.txt fetch
 * (P0_BOT_BLOCKED_BY_ROBOTS) and inbound-link count
 * (P0_NO_CRAWLABLE_INBOUND_INTERNAL_LINK) — so it can't false-block a draft
 * that simply isn't live yet. Those live-only checks stay in the post-publish
 * visibility worker. Used to stop a refresh from ever opening a PR when the
 * draft itself is unindexable (noindex, canonical pointing elsewhere, empty
 * body, or schema describing hidden content).
 */
function evaluateStatic(input = {}) {
  const {
    url,
    html = '',
    body = '',
    canonicalUrl = null,
    schemaMatchesVisibleContent = true,
  } = input;

  const findings = [];
  const text = visibleText(html || body);
  const canonical = canonicalUrl || extractCanonical(html);
  const robotsMeta = extractRobotsMeta(html);

  if (robotsMeta.noindex) {
    findings.push(finding('P0', 'P0_PAGE_NOINDEX', 'Page has a noindex robots directive.', 'Remove noindex before publishing or keep the page out of the autonomous publish lane.'));
  }
  if (!text || text.length < 300) {
    findings.push(finding('P0', 'P0_MAIN_CONTENT_NOT_RENDERED', 'Main answer content is not present in rendered/static HTML.', 'Ensure the answer body is server-rendered or statically generated.'));
  }
  if (canonical && url && !canonicalsMatch(canonical, url)) {
    findings.push(finding('P0', 'P0_CANONICAL_POINTS_ELSEWHERE', 'Canonical points away from the published URL.', 'Set canonical to the live URL unless intentional consolidation is documented.'));
  }
  if (schemaMatchesVisibleContent === false) {
    findings.push(finding('P0', 'P0_SCHEMA_DESCRIBES_HIDDEN_CONTENT', 'Structured data describes hidden or absent content.', 'Keep schema aligned with visible page text.'));
  }

  const summary = summarize(findings);
  return {
    passed: summary.p0 === 0,
    findings,
    summary,
    canonical_url: canonical || null,
    robots_meta: robotsMeta.raw || null,
  };
}

function finding(severity, code, message, recommendation) {
  return { severity, code, message, recommendation };
}

function summarize(findings = []) {
  const out = { p0: 0, p1: 0, p2: 0, p3: 0, needs_review: false };
  for (const item of findings) {
    if (item.severity === 'P0') out.p0 += 1;
    else if (item.severity === 'P1') out.p1 += 1;
    else if (item.severity === 'P2') out.p2 += 1;
    else out.p3 += 1;
  }
  out.needs_review = out.p0 > 0 || out.p1 > 0 || out.p2 > 0;
  return out;
}

function extractCanonical(html = '') {
  const match = String(html).match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || String(html).match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  return match ? match[1] : null;
}

function extractRobotsMeta(html = '') {
  const match = String(html).match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i)
    || String(html).match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']robots["']/i);
  const raw = match ? match[1] : '';
  return { raw, noindex: /\bnoindex\b/i.test(raw) };
}

function visibleText(html = '') {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalsMatch(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
    .replace(/^https?:\/\/(www\.)?/, '');
}

function hasAnswerFirstSummary(text = '') {
  const first = String(text || '').slice(0, 1200);
  const sentences = first.split(/[.!?]\s+/).filter((s) => s.trim().length > 20);
  return sentences.length >= 2 && sentences.slice(0, 4).join(' ').length <= 900;
}

function isQuestionLed(input = {}) {
  const q = `${input.targetKeyword || ''} ${input.title || ''}`;
  return /\b(what|why|how|when|where|should|can|do|does|are|is)\b/i.test(q) || /\?/.test(q);
}

function hasThinFaqAnswers(text = '') {
  const parts = String(text).split(/\b(?:Q:|FAQ|Frequently Asked Questions)\b/i).slice(1).join(' ');
  if (!parts) return false;
  return /\?\s+[A-Z][^.?!]{0,80}[.?!](?:\s|$)/.test(parts);
}

function isBlockedByRobotsTxt(robotsTxt = '', targetUrl = '/', userAgent = '*') {
  const path = pathFromUrl(targetUrl);
  const groups = parseRobotsGroups(robotsTxt);
  const relevant = groups.filter((group) => group.agents.some((agent) => agent === '*' || agent.toLowerCase() === userAgent.toLowerCase()));
  let longest = null;
  for (const group of relevant) {
    for (const rule of group.rules) {
      if (rule.type !== 'disallow') continue;
      if (!rule.path) continue;
      if (!path.startsWith(rule.path)) continue;
      if (!longest || rule.path.length > longest.path.length) longest = rule;
    }
  }
  return !!longest;
}

function parseRobotsGroups(robotsTxt = '') {
  const groups = [];
  let current = null;
  for (const rawLine of String(robotsTxt || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
    } else if ((key === 'disallow' || key === 'allow') && current) {
      current.rules.push({ type: key, path: value });
    }
  }
  return groups;
}

function pathFromUrl(value) {
  try { return new URL(value).pathname || '/'; }
  catch { return String(value || '/').replace(/^[^/]+/, '') || '/'; }
}

module.exports = {
  BOT_AGENTS,
  evaluate,
  evaluateStatic,
  _internals: {
    canonicalsMatch,
    extractCanonical,
    extractRobotsMeta,
    hasAnswerFirstSummary,
    isBlockedByRobotsTxt,
    normalizeUrl,
    visibleText,
  },
};
