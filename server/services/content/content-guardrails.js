/**
 * content-guardrails.js — severity-graded content-policy checks that run on
 * every drafted body (any content action), complementing the existing gates:
 *   - claims-ledger-validator: local claims trace to facts (facts-gated only)
 *   - uniqueness-gate: sibling similarity
 *   - content-quality-gate: redaction (phone/email), schema, structure
 *   - seo-completion-gate: P0/P1/P2 SEO findings (supporting-blog)
 *
 * This module covers the page-policy gaps the audit found ABSENT or
 * blog-only:
 *   P0 HARDCODED_PRICE      — dollar figures in body (must link to calculator)
 *   P0 BRAND_TOKEN_LEAK     — literal "Waves Pest Control" on a multi-domain
 *                             page instead of the {{brandName}} token
 *   P0 FAQ_BLOCKED_SERVICE  — an FAQ section on a service whose FAQs are
 *                             policy-blocked (bed bug, cockroach, rodent, …)
 *   P2 KEYWORD_STUFFING     — primary keyword density above threshold
 *
 * Phone-number injection is NOT re-checked here — content-quality-gate's
 * redaction hard check already rejects any non-Waves phone in the body.
 *
 * Pure (no I/O). Returns { pass, findings:[{severity,code,message}] }.
 * P0/P1 block; P2 warns.
 */

// Services whose FAQ sections are policy-blocked (per project rule). Matched
// against the opportunity/brief service id or category — both coarse
// categories and full facts-bank ids are covered.
const FAQ_BLOCKED_SERVICES = new Set([
  'bed-bug', 'cockroach', 'rodent', 'spider', 'wasp',
  'termite', 'termite-control', 'drywood',
  'palm', 'tree-shrub', 'tree-shrub-care',
  'lawn-pest', 'lawn-pest-control', 'aeration', 'lawn-aeration',
  'plugging', 'commercial', 'commercial-pest', 'commercial-lawn',
]);

const KEYWORD_DENSITY_MAX = 0.03; // 3% of body words

function finding(severity, code, message) {
  return { severity, code, message };
}

function priceFinding(body) {
  const text = String(body || '');
  const priceRe = /(^|[\s(])\$\s?\d{2,5}\b|\b\d{2,5}\s+(?:dollars|bucks)\b/gi;
  let match;
  while ((match = priceRe.exec(text)) !== null) {
    const window = text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + 120));
    // Allowed when the surrounding copy points at the calculator / quote / a
    // "varies" framing rather than asserting a hard price.
    if (/\b(calculator|estimate|quote|pricing varies|depends|range)\b/i.test(window)) continue;
    return finding('P0', 'HARDCODED_PRICE', `Body contains a hardcoded price ("${match[0].trim()}") with no calculator/quote framing nearby — link to /pest-control-calculator/ instead.`);
  }
  return null;
}

// The hub canonical domain(s). Literal "Waves Pest Control" branding is fine on
// hub-only pages — the brand-token leak only matters when content also targets a
// SPOKE domain. A target_sites of just the hub (the legacy/default for blogs)
// must therefore count as hub-only, not multi-domain.
const HUB_DOMAINS = new Set(['wavespestcontrol.com', 'www.wavespestcontrol.com']);

function brandTokenFinding(body, domains) {
  const list = (Array.isArray(domains) ? domains : [])
    .map((d) => String(d || '').trim().toLowerCase())
    .filter((d) => d && !HUB_DOMAINS.has(d)); // only spoke domains make it multi-domain
  if (list.length === 0) return null; // hub-only page — literal brand is fine
  if (/\bWaves\s+Pest\s+Control\b/.test(String(body || ''))) {
    return finding('P0', 'BRAND_TOKEN_LEAK', 'Multi-domain page uses the literal "Waves Pest Control" instead of the {{brandName}} token — brand leaks across spoke domains.');
  }
  return null;
}

// Normalize a service/topic string to candidate FAQ_BLOCKED_SERVICES ids. The
// ids are lowercase/singular/hyphenated ('rodent', 'bed-bug'), but legacy blog
// `tag` values are display-cased plurals ("Rodents", "Bed Bugs", "Cockroaches").
// Lowercase, hyphenate spaces, and try de-pluralized forms so those match.
function blockedServiceCandidates(service) {
  const base = String(service || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!base) return [];
  const out = new Set([base]);
  if (base.endsWith('es')) out.add(base.slice(0, -2)); // Cockroaches → cockroach
  if (base.endsWith('s')) out.add(base.slice(0, -1)); // Rodents → rodent, Bed Bugs → bed-bug
  return [...out];
}

function faqBlockedFinding(body, service) {
  const isBlocked = blockedServiceCandidates(service).some((c) => FAQ_BLOCKED_SERVICES.has(c));
  if (!isBlocked) return null;
  if (/\b(faq|frequently asked|common questions)\b/i.test(String(body || ''))) {
    return finding('P0', 'FAQ_BLOCKED_SERVICE', `Service "${service}" is on the FAQ-blocked list — remove the FAQ section.`);
  }
  return null;
}

function keywordStuffingFinding(body, primaryKeyword) {
  const kw = String(primaryKeyword || '').trim().toLowerCase();
  if (!kw) return null;
  const text = String(body || '').toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 50) return null; // too short to judge density
  // Count keyword occurrences (phrase match).
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = (text.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
  const kwWordCount = kw.split(/\s+/).length;
  const density = (occurrences * kwWordCount) / words.length;
  if (density > KEYWORD_DENSITY_MAX) {
    return finding('P2', 'KEYWORD_STUFFING', `Primary keyword density ${(density * 100).toFixed(1)}% exceeds ${(KEYWORD_DENSITY_MAX * 100)}% (${occurrences} occurrences in ${words.length} words).`);
  }
  return null;
}

/**
 * evaluate(draft, { service, primaryKeyword, domains }) → { pass, findings }
 *
 * draft: { body, frontmatter } (the captured agent draft)
 * service: opportunity/brief service id or category
 * primaryKeyword: from the brief/frontmatter (optional)
 * domains: the multi-domain list to enforce the brand-token check against.
 *   For NEW pages this is the draft's own frontmatter.domains; for REFRESH the
 *   caller MUST pass the LIVE page's domains, because the refresh draft carries
 *   only editable meta and publishRefresh freezes domains from the live page.
 */
function evaluate(draft, { service = null, primaryKeyword = null, domains = null } = {}) {
  const body = draft?.body || draft?.content || '';
  const frontmatter = draft?.frontmatter || {};
  const kw = primaryKeyword || frontmatter.primary_keyword || frontmatter.primaryKeyword || null;
  const effectiveDomains = Array.isArray(domains) ? domains : (Array.isArray(frontmatter.domains) ? frontmatter.domains : []);

  // Editable meta strings that publishRefresh / publishOrUpdatePage write onto
  // the (possibly multi-domain) live page. A hardcoded price or literal-brand
  // leak hiding only in metaTitle/metaDescription would otherwise slip past the
  // body-only P0 guards. Mirror astro-publisher's REFRESH_EDITABLE_META_FIELDS.
  const editableMeta = ['title', 'metaTitle', 'meta_description', 'metaDescription']
    .map((f) => frontmatter[f])
    .filter(Boolean)
    .map(String)
    .join('\n');
  const publishableText = editableMeta ? `${body}\n${editableMeta}` : body;

  const findings = [
    // Price + brand-token must cover everything that ships: body AND meta.
    priceFinding(publishableText),
    brandTokenFinding(publishableText, effectiveDomains),
    // FAQ + keyword density are body-section concerns only.
    faqBlockedFinding(body, service),
    keywordStuffingFinding(body, kw),
  ].filter(Boolean);

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings };
}

module.exports = {
  evaluate,
  // exposed for tests
  FAQ_BLOCKED_SERVICES,
  KEYWORD_DENSITY_MAX,
  _internals: { priceFinding, brandTokenFinding, faqBlockedFinding, keywordStuffingFinding },
};
