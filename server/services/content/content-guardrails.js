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
    // Regulatory fines are not Waves service pricing. Allow ordinance/citation
    // contexts while still blocking customer-facing service price claims.
    if (isRegulatoryPenaltyAmount(match[0].trim(), window)) continue;
    return finding('P0', 'HARDCODED_PRICE', `Body contains a hardcoded price ("${match[0].trim()}") with no calculator/quote framing nearby — link to /pest-control-calculator/ instead.`);
  }
  return null;
}

function isRegulatoryPenaltyAmount(amount, context) {
  const escapedAmount = escapeRegExp(String(amount || '').trim()).replace(/\s+/g, '\\s+');
  if (!escapedAmount) return false;
  if (/\b(cancellation|customer|service|plan|treatment|visit|appointment|per month|monthly|recurring|subscription|fee)\b/i.test(context)) return false;
  if (!/\b(county|city|municipal|ordinance|regulat(?:ion|ory)|statute|law|civil|citation|violation|infraction|misdemeanor|enforcement)\b/i.test(context)) return false;
  const fineAmountPrefix = '\\b(?:fine|fines|penalt(?:y|ies)|civil infractions?|citations?)\\b(?:\\s+(?:of|up|to|not|exceed|exceeds|exceeding|as|high|maximum|max|can|may|could|carry|carries|be|is|are)){0,10}\\s+';
  const afterAmountPenalty = '\\s*(?:per\\s+(?:violation|infraction)|(?:fine|fines|penalt(?:y|ies)|civil infraction|citation|misdemeanor)\\b)';
  return new RegExp(`${fineAmountPrefix}${escapedAmount}`, 'i').test(context)
    || new RegExp(`${escapedAmount}${afterAmountPenalty}`, 'i').test(context);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// Normalize service/topic value(s) to candidate FAQ_BLOCKED_SERVICES ids. The
// ids are lowercase/singular/hyphenated ('rodent', 'bed-bug'), but legacy blog
// `tag` values are display-cased plurals ("Rodents", "Bed Bugs", "Cockroaches").
// Accepts a string OR an array of fields (e.g. [category, tag]) so a row whose
// `category` is the broad Astro value ("pest-control") but whose real topic is
// on `tag` ("Rodents") is still covered. Lowercase, hyphenate spaces, and try
// de-pluralized forms so those match.

// Canonical-tag → blocked-service aliases. blog-writer's normalizeTag()
// collapses raw topics into a closed canonical tag set ("Roaches",
// "Stinging Insects", …); two of those canonical forms do NOT reduce to a
// blocklist id via lowercase/de-pluralize alone, so without these aliases a
// cockroach or wasp post tagged with its canonical tag would get the
// FAQ-required prompt AND bypass the publish-time FAQ_BLOCKED_SERVICE guard.
// (Rodents/Termites/Spiders/Bed Bugs/Lawn Pests reduce to their blocked ids
// already.) Data-driven here — the single-sourced module — so every consumer
// of isFaqBlockedService/blockedServiceCandidates inherits the mapping.
const BLOCKED_SERVICE_ALIASES = new Map([
  ['roaches', 'cockroach'], // canonical blog tag "Roaches"
  ['roach', 'cockroach'],
  ['roache', 'cockroach'], // defensive: 'roaches' de-'s' form
  ['palmetto-bug', 'cockroach'],
  ['stinging-insects', 'wasp'], // canonical blog tag "Stinging Insects"
  ['stinging-insect', 'wasp'],
]);

function blockedServiceCandidates(service) {
  const raw = Array.isArray(service) ? service : [service];
  const out = new Set();
  for (const s of raw) {
    const base = String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!base) continue;
    out.add(base);
    if (base.endsWith('es')) out.add(base.slice(0, -2)); // Cockroaches → cockroach
    if (base.endsWith('s')) out.add(base.slice(0, -1)); // Rodents → rodent, Bed Bugs → bed-bug
  }
  // Map canonical-tag forms onto their blocked service id (Roaches→cockroach,
  // Stinging Insects→wasp) AFTER normalization so any input casing/plurality
  // that reduces to an alias key picks up the alias target too.
  for (const candidate of [...out]) {
    const alias = BLOCKED_SERVICE_ALIASES.get(candidate);
    if (alias) out.add(alias);
  }
  return [...out];
}

/**
 * isFaqBlockedService(service) → bool — single source of truth for "this
 * topic must NOT get an FAQ section". Accepts the same string-or-array input
 * as the publish-time guard (e.g. [post.category, post.tag]) and applies the
 * same normalization (lowercase, hyphenate, de-pluralize). Exported so the
 * GENERATOR side (blog-writer prompt, writer-agent-config) and the quality
 * gate condition on the exact blocklist this module enforces at publish —
 * the two sides can never drift.
 */
function isFaqBlockedService(service) {
  return blockedServiceCandidates(service).some((c) => FAQ_BLOCKED_SERVICES.has(c));
}

function faqBlockedFinding(body, service) {
  if (!isFaqBlockedService(service)) return null;
  if (/\b(faq|frequently asked|common questions)\b/i.test(String(body || ''))) {
    const label = Array.isArray(service) ? service.filter(Boolean).join('/') : service;
    return finding('P0', 'FAQ_BLOCKED_SERVICE', `Service "${label}" is on the FAQ-blocked list — remove the FAQ section.`);
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
  // single source of truth for the FAQ-section policy — consumed by
  // blog-writer, writer-agent-config, and content-quality-gate so the
  // generators/gates can never contradict the publish-time guard.
  isFaqBlockedService,
  FAQ_BLOCKED_SERVICES,
  KEYWORD_DENSITY_MAX,
  _internals: { priceFinding, brandTokenFinding, faqBlockedFinding, keywordStuffingFinding, blockedServiceCandidates, BLOCKED_SERVICE_ALIASES },
};
