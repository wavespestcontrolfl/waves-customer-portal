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
 *   P0 HARDCODED_PRICE          — dollar figures in body (must link to calculator)
 *   P0 BRAND_TOKEN_LEAK         — literal "Waves Pest Control" on a multi-domain
 *                                 page instead of the {{brandName}} token
 *   P0 FAQ_BLOCKED_SERVICE      — an FAQ section on a service whose FAQs are
 *                                 policy-blocked (bed bug, cockroach, rodent, …)
 *   P0 DISALLOWED_EXTERNAL_LINK — a link/URL pointing off the hub/spoke fleet
 *                                 (spam/injection guard — drafts link internally)
 *   P2 KEYWORD_STUFFING         — primary keyword density above threshold
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

// Dollar amounts: "$95", "$9", "$1,200", "$12500", "95 dollars", "1,200 bucks".
// Comma-grouped thousands MUST be covered — a bare \d{2,5} stops at the comma,
// so "$1,200 per year" (exactly the fabricated-price shape for termite bonds /
// annual plans) produced no finding at all.
const PRICE_RE_SRC = '(^|[\\s(])\\$\\s?(?:\\d{1,3}(?:,\\d{3})+|\\d{1,5})\\b|\\b(?:\\d{1,3}(?:,\\d{3})+|\\d{1,5})\\s+(?:dollars|bucks)\\b';

/**
 * findHardcodedPrice(text) → the offending price string, or null. Applies the
 * calculator/quote-framing and regulatory-fine exemptions, so callers share
 * ONE price policy. Exported for seo-completion-gate (its previous private
 * copy had drifted: no comma support, no regulatory exemption).
 */
function findHardcodedPrice(text) {
  const s = String(text || '');
  const priceRe = new RegExp(PRICE_RE_SRC, 'gi');
  let match;
  while ((match = priceRe.exec(s)) !== null) {
    const window = s.slice(Math.max(0, match.index - 80), Math.min(s.length, match.index + 120));
    // Allowed when the surrounding copy points at the calculator / quote / a
    // "varies" framing rather than asserting a hard price.
    if (/\b(calculator|estimate|quote|pricing varies|depends|range)\b/i.test(window)) continue;
    // Regulatory fines are not Waves service pricing. Allow ordinance/citation
    // contexts while still blocking customer-facing service price claims.
    if (isRegulatoryPenaltyAmount(match[0].trim(), window)) continue;
    return match[0].trim();
  }
  return null;
}

function priceFinding(body) {
  const hit = findHardcodedPrice(body);
  if (!hit) return null;
  return finding('P0', 'HARDCODED_PRICE', `Body contains a hardcoded price ("${hit}") with no calculator/quote framing nearby — link to /pest-control-calculator/ instead.`);
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

// Markdown links whose href is the hub origin → their anchor TEXT may carry the
// literal hub brand. This is the one intentional brand surface on a spoke blog
// post: the contextual spoke→hub link uses a branded-local anchor like "Waves
// Pest Control in Sarasota" (per content-ops/anchor-and-content-playbook.md).
// Mirrors the Phase-1 Astro brand-isolation blog exemption. Returns the
// [start,end) character ranges of those anchor texts.
function hubLinkAnchorRanges(text) {
  const ranges = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    let host;
    try { host = new URL(m[2]).hostname.toLowerCase(); } catch { continue; }
    if (!HUB_DOMAINS.has(host) && !HUB_DOMAINS.has(host.replace(/^www\./, ''))) continue;
    const anchorStart = m.index + 1; // skip the opening '['
    ranges.push([anchorStart, anchorStart + m[1].length]);
  }
  return ranges;
}

// allowHubAnchor: the literal hub brand may appear ONLY as the anchor text of a
// hub-pointing markdown link — the intentional branded-local spoke→hub anchor.
// This exemption applies to BODY markdown only; editable meta (title/
// description) is not rendered as a link, so it is scanned with no exemption
// (any literal hub brand in a spoke's meta is a real leak).
function brandTokenFinding(text, domains, { allowHubAnchor = false } = {}) {
  const list = (Array.isArray(domains) ? domains : [])
    .map((d) => String(d || '').trim().toLowerCase())
    .filter((d) => d && !HUB_DOMAINS.has(d)); // only spoke domains make it multi-domain
  if (list.length === 0) return null; // hub-only page — literal brand is fine
  const body = String(text || '');
  // Case-insensitive: "WAVES PEST CONTROL" / "waves pest control" leak the
  // brand across spoke domains exactly like the canonical casing does.
  if (!/\bWaves\s+Pest\s+Control\b/i.test(body)) return null;
  const allowed = allowHubAnchor ? hubLinkAnchorRanges(body) : [];
  const brandRe = /\bWaves\s+Pest\s+Control\b/gi;
  let match;
  while ((match = brandRe.exec(body)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const insideHubAnchor = allowed.some(([a, b]) => a <= start && end <= b);
    if (!insideHubAnchor) {
      return finding('P0', 'BRAND_TOKEN_LEAK', 'Multi-domain page uses the literal "Waves Pest Control" outside a hub-link anchor instead of the {{brandName}} token — brand leaks across spoke domains.');
    }
  }
  return null;
}

// ── outbound-link gate ──────────────────────────────────────────────
// Generated drafts link INTERNALLY only: the writer prompts mandate "never
// invent URLs" / internal targets, and the audited live corpus is 100%
// relative links. Any absolute URL pointing off the hub/spoke fleet is
// therefore either a hallucinated citation or an injected spam/malicious
// backlink (untrusted SERP/PAA text reaches the writer prompt), so it fails
// CLOSED as a P0. If a citation domain is ever editorially approved, extend
// the allowlist via CONTENT_ALLOWED_LINK_DOMAINS (comma-separated hostnames)
// without a deploy.
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

// Curated citation hosts for OPERATOR-directed sourcing. Intercept-brief
// `source_notes` direct the writer to LOCATE sources of exactly these kinds
// ("UF/IFAS for agronomic claims", regulators, consumer-protection outlets,
// "Orkin published terms/plan pages") — their hosts can't be known per-URL at
// gate time, so this curated set (plus the curated competitors' own sites,
// below) is what "located source" may resolve to. Operator-provenance only:
// mined drafts never get these.
const OPERATOR_CITATION_HOSTS = [
  'ufl.edu', 'epa.gov', 'cdc.gov', 'fdacs.gov', 'myfloridalicense.com',
  'consumeraffairs.com', 'bbb.org', 'archive.org', 'web.archive.org',
];

// Hosts of the curated competitor-facts `source` URLs — the exact pages an
// operator directive like "Orkin published terms/plan pages" resolves to.
function curatedCompetitorSourceHosts() {
  const hosts = new Set();
  try {
    const { COMPETITORS } = require('./competitor-facts');
    for (const c of Array.isArray(COMPETITORS) ? COMPETITORS : []) {
      for (const attr of Object.values(c?.attributes || {})) {
        const src = attr?.source;
        if (!src) continue;
        try { hosts.add(normalizeHost(new URL(src).hostname)); } catch { /* not a URL */ }
      }
    }
  } catch { /* competitor-facts unavailable — fall through to the base allowlist */ }
  return hosts;
}

function allowedLinkHosts({ operatorCitations = false, requiredSourceUrls = [] } = {}) {
  const hosts = new Set();
  for (const d of HUB_DOMAINS) hosts.add(normalizeHost(d));
  for (const d of SPOKE_SITE_KEYS) hosts.add(normalizeHost(d));
  for (const d of String(process.env.CONTENT_ALLOWED_LINK_DOMAINS || '').split(',')) {
    const h = normalizeHost(d);
    if (h) hosts.add(h);
  }
  // Operator-mandated must-link citations: the brief's own required_sources
  // URLs are binding writer instructions ("every source below must be linked
  // in the body"), so their hosts are allowed for that draft.
  for (const u of Array.isArray(requiredSourceUrls) ? requiredSourceUrls : []) {
    try { hosts.add(normalizeHost(new URL(String(u)).hostname)); } catch { /* skip non-URLs */ }
  }
  if (operatorCitations) {
    for (const h of OPERATOR_CITATION_HOSTS) hosts.add(normalizeHost(h));
    for (const h of curatedCompetitorSourceHosts()) hosts.add(h);
  }
  return hosts;
}

// Exact host or subdomain of an allowed host ("entnemdept.ufl.edu" is allowed
// by "ufl.edu"; "evil-ufl.edu" is not — the dot prefix prevents suffix abuse).
function hostAllowed(host, allowed) {
  if (!host) return false;
  if (allowed.has(host)) return true;
  for (const a of allowed) {
    if (a && host.endsWith(`.${a}`)) return true;
  }
  return false;
}

// ANY absolute-scheme URL anywhere in the text — markdown links/images, raw
// HTML attributes, and bare prose URLs all contain this shape. Group 1 is the
// scheme: http(s) goes through the host allowlist; every other scheme
// (ftp:, gopher:, …) is rejected outright — the gate fails closed on any
// external reference, not just web links.
const ABSOLUTE_URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s<>()"'\]]+/gi;
// ANY scheme in a link DESTINATION — schemes without '://' (ftp:host,
// webcal:, tel:, javascript:) never match the URL scan above, so the
// destination positions must be scanned for arbitrary schemes, not just the
// executable set. Three destination shapes carry a scheme:
//   - Markdown/MDX links and images: `[x](scheme:…)`, incl. the angle-
//     bracketed form `[x](<scheme:…>)`,
//   - href/src attributes: `href="scheme:…"`,
//   - CommonMark autolinks: `<scheme:…>` (no whitespace inside by spec).
// Policy: http(s) must be a proper `scheme://` form (group 2) — a no-slash
// `[spam](http:evil.com)` still NAVIGATES externally in browsers but never
// reaches the `://` host-allowlist scan, so it is rejected here; mailto is
// recipient-validated below; tel is Waves-number-validated below (the
// writer prompt MANDATES tap-to-call [(941) 297-5749](tel:+19412975749)
// links, so tel can't be blanket-blocked). Everything else is P0.
const MD_DEST_SCHEME_RE = /\]\(\s*<?\s*([a-z][a-z0-9+.-]*):(\/\/)?/gi;
const ATTR_SCHEME_RE = /\b(?:href|src)\s*=\s*["']?\s*([a-z][a-z0-9+.-]*):(\/\/)?/gi;
const AUTOLINK_SCHEME_RE = /<([a-z][a-z0-9+.-]*):(\/\/)?[^>\s]*>/gi;
// Reference-style Markdown definitions — `[bad]: javascript:alert(1)` on
// its own line becomes the destination of every `[click][bad]` use, and
// none of the three inline shapes above see it.
const REF_DEF_SCHEME_RE = /^ {0,3}\[[^\]]+\]:\s*<?\s*([a-z][a-z0-9+.-]*):(\/\/)?/gim;
const ALLOWED_DEST_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
// Protocol-relative URL (//host/path) — scheme-less external reference that
// bypasses an https?:// scan. Requires a dotted host with a TLD so prose
// slashes ("and//or", path fragments) don't trip it.
const PROTOCOL_RELATIVE_RE = /(?:^|[\s("'[=])\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?=[/\s"')\]]|$)/i;
const MAILTO_RE = /\bmailto:([^\s"'<>)\]]+)/gi;
// tel: destinations — validated against the Waves phone allowlist, exactly
// like mailto recipients are validated against the business domain. The
// capture is deliberately CATCH-ALL (anything up to a delimiter, even
// empty): tel is whitelisted in the scheme pre-scan, so any tel: use whose
// number portion this didn't match would fall through UNVALIDATED —
// `tel:911` and `tel:abc` must reach isWavesPhone and fail there.
const TEL_RE = /\btel:([^\s"'<>)\]]*)/gi;

function externalLinkFinding(text, { operatorCitations = false, requiredSourceUrls = [] } = {}) {
  const body = String(text || '');
  if (!body) return null;
  for (const src of [MD_DEST_SCHEME_RE, ATTR_SCHEME_RE, AUTOLINK_SCHEME_RE, REF_DEF_SCHEME_RE]) {
    const destRe = new RegExp(src.source, src.flags);
    let dm;
    while ((dm = destRe.exec(body)) !== null) {
      const scheme = dm[1].toLowerCase();
      if (!ALLOWED_DEST_SCHEMES.has(scheme)) {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a link destination with the "${scheme}:" scheme ("${dm[0].slice(0, 60)}") — only http(s) links to allowlisted hosts, @wavespestcontrol.com mailto links, Waves tel: links, or relative internal paths are permitted.`);
      }
      if ((scheme === 'http' || scheme === 'https') && dm[2] !== '//') {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a no-slash "${scheme}:" destination ("${dm[0].slice(0, 60)}") — browsers still navigate these externally but the host can't be allowlist-checked. Use a full ${scheme}:// URL or a relative internal path.`);
      }
    }
  }
  const telRe = new RegExp(TEL_RE.source, 'gi');
  let t;
  while ((t = telRe.exec(body)) !== null) {
    const { isWavesPhone } = require('./waves-phones');
    if (!isWavesPhone(t[1])) {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a tel: link to "${t[1].trim() || '(empty)'}", which is not a Waves phone number — tap-to-call links may only dial the business's own lines.`);
    }
  }
  const allowed = allowedLinkHosts({ operatorCitations, requiredSourceUrls });
  const urlRe = new RegExp(ABSOLUTE_URL_RE.source, 'gi');
  let m;
  while ((m = urlRe.exec(body)) !== null) {
    // Trim trailing sentence punctuation: the bare-URL charset admits , ; .
    // ! ? so prose like "see https://wavespestcontrol.com, then call" would
    // otherwise parse hostname "wavespestcontrol.com," and P0 a legit link.
    const rawUrl = m[0].replace(/[.,;:!?]+$/, '');
    const scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a "${scheme}:" URL ("${rawUrl.slice(0, 60)}") — only http(s) links to allowlisted hosts (or relative internal paths) are permitted.`);
    }
    let host = null;
    try { host = new URL(rawUrl).hostname; } catch { host = null; }
    const norm = normalizeHost(host);
    if (!hostAllowed(norm, allowed)) {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft links to "${host || rawUrl.slice(0, 60)}", which is not the hub, a fleet spoke, or an allowlisted citation domain — external links are blocked (spam/injection guard). Use internal links, or add the domain to CONTENT_ALLOWED_LINK_DOMAINS if this citation is editorially approved.`);
    }
  }
  const mailtoRe = new RegExp(MAILTO_RE.source, 'gi');
  while ((m = mailtoRe.exec(body)) !== null) {
    // Validate only the RECIPIENT portion: headers/query after `?` must not
    // count ("mailto:attacker@x?subject=info@wavespestcontrol.com" would
    // otherwise pass an endsWith check), and every comma-separated recipient
    // must be on the company domain.
    const recipients = m[1].split('?')[0].split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
    if (recipients.length === 0 || recipients.some((r) => !r.endsWith('@wavespestcontrol.com'))) {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link to "${m[1].split('?')[0]}" — only @wavespestcontrol.com addresses are allowed.`);
    }
  }
  const proto = body.match(PROTOCOL_RELATIVE_RE);
  if (proto) {
    return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a protocol-relative URL ("${proto[0].trim()}") — use a relative internal path or an allowlisted absolute URL.`);
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
 * operatorFaqException: narrow opt-in skip of the FAQ-blocked-service P0 for
 *   operator-authored intercept briefs whose manifest mandates an FAQ (see
 *   the inline note at the call below). Default false — full enforcement.
 * requiredSourceUrls: operator-brief must-link citation URLs — their hosts are
 *   allowed for this draft (the brief BINDS the writer to link them in-body).
 * operatorCitations: operator brief carries source_notes directives (writer
 *   locates the sources itself) — additionally allow the curated citation +
 *   competitor-source hosts. Both default off: mined drafts stay internal-only.
 */
function evaluate(draft, { service = null, primaryKeyword = null, domains = null, operatorFaqException = false, requiredSourceUrls = [], operatorCitations = false } = {}) {
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
    // Price must cover everything that ships: body AND meta.
    priceFinding(publishableText),
    // Outbound links are scanned across body AND meta too — an injected spam
    // URL hiding in a meta description ships exactly like one in the body.
    externalLinkFinding(publishableText, { operatorCitations, requiredSourceUrls }),
    // Brand-token covers body AND meta too, but the hub-anchor exemption applies
    // ONLY to body markdown — editable meta is scanned strictly (a literal hub
    // brand in a spoke's title/description is a real leak, not an anchor).
    brandTokenFinding(body, effectiveDomains, { allowHubAnchor: true }),
    editableMeta ? brandTokenFinding(editableMeta, effectiveDomains, { allowHubAnchor: false }) : null,
    // FAQ + keyword density are body-section concerns only.
    // operatorFaqException is a NARROW, opt-in override of the FAQ-blocked
    // policy: only the autonomous runner sets it, and only for an
    // operator_intercept opportunity whose seeded manifest explicitly
    // requires an FAQ (operator_brief.faq_required — owner directive
    // 2026-06-11: FAQPage on every intercept post). Every other caller
    // (publishAstro, mined opportunities) keeps full enforcement.
    operatorFaqException ? null : faqBlockedFinding(body, service),
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
  // single source of truth for the hardcoded-price policy — consumed by
  // seo-completion-gate so the two price P0s can never drift again.
  findHardcodedPrice,
  _internals: { priceFinding, brandTokenFinding, faqBlockedFinding, keywordStuffingFinding, blockedServiceCandidates, BLOCKED_SERVICE_ALIASES, externalLinkFinding, allowedLinkHosts, hostAllowed, curatedCompetitorSourceHosts, OPERATOR_CITATION_HOSTS },
};
