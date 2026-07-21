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
// Prefix admits quotes (straight and curly) — generated copy routinely
// QUOTES the amount ("$1,200"), and a start/whitespace/paren-only prefix
// let exactly the fabricated-price shapes this covers slip both gates.
const PRICE_RE_SRC = '(^|[\\s("\'“‘])\\$\\s?(?:\\d{1,3}(?:,\\d{3})+|\\d{1,5})\\b|\\b(?:\\d{1,3}(?:,\\d{3})+|\\d{1,5})\\s+(?:dollars|bucks)\\b';

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
// `\{?\s*` after `=`: these posts publish as MDX, so a JSX string-
// expression prop (href={"javascript:alert(1)"}) is a real link
// destination React will render — the quote-anchored form alone missed it.
// Backtick included: href={`javascript:...`} template literals render the
// same way and were invisible to the single/double-quote class.
const ATTR_SCHEME_RE = /\b(?:href|src)\s*=\s*\{?\s*["'`]?\s*([a-z][a-z0-9+.-]*):(\/\/)?/gi;
// A JSX expression prop whose value is NOT a plain string literal —
// template interpolation (`...${x}...`), concatenation ('java'+'script:'),
// an identifier — is a DYNAMIC link destination this static gate cannot
// verify at all, so it fails closed rather than hoping the scheme regexes
// see a contiguous literal. The literal test's backtick arm excludes `$`
// entirely: a template with no interpolation is a plain string; one with
// `${` is dynamic (and `[^}]*` cutting at the interpolation's inner `}`
// also fails the literal test — closed either way).
const ATTR_EXPR_PROP_RE = /\b(?:href|src)\s*=\s*\{([^}]*)\}/gi;
const PLAIN_STRING_LITERAL_RE = /^\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)\s*$/;
// A JSX SPREAD attribute (<a {...{href:'javascript:...'}}>) delivers props
// without a literal `href=` token, so EVERY href/src scanner above and
// below is blind to it while React renders whatever destination it
// smuggles. Generated drafts have no legitimate use for spread syntax —
// the writer emits markdown links and plain-prop JSX — so ANY `{...` in
// publishable text fails closed rather than trying to statically evaluate
// the spread expression. Not anchored to a detectable tag context: a `>`
// inside a quoted prop defeats "inside a tag" matching, and a stray
// `{...` in prose costs only a parked draft.
const JSX_SPREAD_RE = /\{\s*\.\.\./;
const AUTOLINK_SCHEME_RE = /<([a-z][a-z0-9+.-]*):(\/\/)?[^>\s]*>/gi;
// Reference-style Markdown definitions — `[bad]: javascript:alert(1)` on
// its own line becomes the destination of every `[click][bad]` use, and
// none of the three inline shapes above see it.
const REF_DEF_SCHEME_RE = /^ {0,3}\[[^\]]+\]:\s*<?\s*([a-z][a-z0-9+.-]*):(\/\/)?/gim;
const ALLOWED_DEST_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
// Protocol-relative URL (//host/path) — scheme-less external reference that
// bypasses an https?:// scan. Host shapes: dotted-TLD name, IPv4 literal,
// bracketed IPv6 literal, or localhost — an IP/single-label host is just as
// browser-navigable as a named one, so requiring an alphabetic TLD alone
// left `//127.0.0.1/x` and `//localhost/x` clean. The dotted-TLD arm keeps
// prose slashes ("and//or", path fragments) from tripping; `<` in the
// prefix class covers Markdown's angle-bracketed destination form and `>`
// in the terminator lookahead closes it.
const PROTOCOL_RELATIVE_RE = /(?:^|[\s("'[=<])\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|localhost\b|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?=[/:\s"')\]>]|$)/i;
const MAILTO_RE = /\bmailto:([^\s"'<>)\]]+)/gi;
// tel: destinations — validated against the Waves phone allowlist, exactly
// like mailto recipients are validated against the business domain. The
// capture is deliberately CATCH-ALL (anything up to a delimiter, even
// empty): tel is whitelisted in the scheme pre-scan, so any tel: use whose
// number portion this didn't match would fall through UNVALIDATED —
// `tel:911` and `tel:abc` must reach isWavesPhone and fail there.
const TEL_RE = /\btel:([^\s"'<>)\]]*)/gi;

// Single-pass HTML-entity decode (ASCII range) for the link scan: a browser
// decodes `href="javascript&#58;alert(1)"` (or &colon;/&#x3a;) into a live
// javascript: link, so the scanner must see what the browser sees. &amp; is
// decoded LAST, mirroring a single browser decode — `&amp;#58;` renders as
// literal "&#58;" text, not a colon, and must stay that way here too.
// Scanning a decoded COPY can only find more, never less (fail-closed).
// Sentinel standing in for an ENTITY-DECODED tab/LF/CR (see the decoder
// below). \u0001 is itself a C0 control, so range checks like the mailto
// recipient scan treat it exactly like the control it stands for; a
// LITERAL \u0001 in a draft matches the same fail-closed arms, which is
// the right direction. The regex arms below hardcode \u0001 — keep them
// in sync with this constant.
const CTRL_SENTINEL = '\u0001';
function decodeEntitiesForScan(s) {
  // The `;` is OPTIONAL on the numeric forms: HTML treats a semicolonless
  // numeric character reference as a parse error but still decodes it in
  // attribute values, so `href="javascript&#58alert(1)"` is a live
  // javascript: link and the scanner must decode it identically. Named
  // references keep the mandatory `;` (they are NOT legacy-decoded without
  // it when followed by alphanumerics).
  // Entity-produced CONTROL characters (tab/LF/CR — the three browsers
  // strip while parsing URLs) decode to the CTRL_SENTINEL instead of the
  // real control. This preserves the distinction the tokenizer makes and a
  // plain decode erases: a char-reference control is PART of an attribute
  // value (href=java&#9;script: is a live javascript: link), while a
  // literal control in the source TERMINATES an unquoted value (a newline
  // between props is just formatting).
  const ctl = (c) => (c === 9 || c === 10 || c === 13 ? CTRL_SENTINEL : String.fromCharCode(c));
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});?/gi, (m0, h) => {
      const c = parseInt(h, 16);
      return c > 0 && c < 128 ? ctl(c) : m0;
    })
    .replace(/&#(\d{1,7});?/g, (m0, d) => {
      const c = parseInt(d, 10);
      return c > 0 && c < 128 ? ctl(c) : m0;
    })
    // Browser-recognized NAMED control references — &Tab;/&NewLine; decode
    // in attribute values just like the numeric forms (there is no named CR).
    .replace(/&Tab;/gi, CTRL_SENTINEL)
    .replace(/&NewLine;/gi, CTRL_SENTINEL)
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

// A link DESTINATION carrying embedded tab/CR/newline: browsers STRIP these
// while parsing hrefs, so "java&#x09;script:" is a live javascript: link
// whose scheme no regex sees contiguously. Entity-produced controls arrive
// as CTRL_SENTINEL (see decodeEntitiesForScan); LITERAL controls typed in
// the source only count where the tokenizer keeps them in the value —
// inside QUOTED/template/markdown destinations. In an UNQUOTED value a
// literal control is a terminator (plain formatting between props), so that
// arm matches the sentinel alone: any entity-decoded control in or adjacent
// to the value (including a LEADING one — href=&#9;javascript: keeps its
// tab and URL parsing strips it) fails closed, while a real newline before
// the next prop — even one whose value happens to contain a colon, like
// aria-label="Pest: control" — never can.
const DEST_CONTROL_RE = new RegExp([
  /\]\(\s*<?[^)]*[\t\r\n\u0001][^)]*\)/.source,
  /\b(?:href|src)\s*=\s*\{?\s*"[^"]*[\t\r\n\u0001][^"]*"/.source,
  /\b(?:href|src)\s*=\s*\{?\s*'[^']*[\t\r\n\u0001][^']*'/.source,
  /\b(?:href|src)\s*=\s*\{?\s*`[^`]*[\t\r\n\u0001][^`]*`/.source,
  /\b(?:href|src)\s*=\s*[^\s>]*\u0001/.source,
  // 'i': browsers treat attribute names case-insensitively, so HREF=/Src=
  // must hit every arm above — the sibling scheme regexes already carry it.
].join('|'), 'i');

function externalLinkFinding(text, { operatorCitations = false, requiredSourceUrls = [] } = {}) {
  const body = decodeEntitiesForScan(String(text || ''));
  if (!body) return null;
  if (DEST_CONTROL_RE.test(body)) {
    return finding('P0', 'DISALLOWED_EXTERNAL_LINK', 'Draft contains a link destination with embedded control characters (tab/newline) — browsers strip these while parsing, which can smuggle an executable scheme. Remove them.');
  }
  if (JSX_SPREAD_RE.test(body)) {
    return finding('P0', 'DISALLOWED_EXTERNAL_LINK', 'Draft contains a JSX spread attribute ("{...") — spread props deliver link destinations no href/src scanner can see and cannot be statically validated. Write explicit literal props.');
  }
  const exprPropRe = new RegExp(ATTR_EXPR_PROP_RE.source, ATTR_EXPR_PROP_RE.flags);
  let ep;
  while ((ep = exprPropRe.exec(body)) !== null) {
    if (!PLAIN_STRING_LITERAL_RE.test(ep[1])) {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a link/image prop with a dynamic (non-literal) JSX expression ("${ep[0].slice(0, 60)}") — a computed destination cannot be statically validated. Use a plain quoted string.`);
    }
  }
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
    // The dialer places the WHOLE digit string, so length is validated
    // BEFORE the allowlist: isWavesPhone keys on the last 10 digits (right
    // for finding a Waves number inside prose), but a padded
    // tel:9999412975749 would dial a non-Waves number that merely ENDS in
    // an owned line. Exactly 10 digits, or 11 with a leading 1, only.
    const digits = String(t[1] || '').replace(/\D/g, '');
    const dialableShape = digits.length === 10 || (digits.length === 11 && digits[0] === '1');
    const { isWavesPhone } = require('./waves-phones');
    if (!dialableShape || !isWavesPhone(digits)) {
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
    // The address portion before `?` never inherits trust from the query
    // ("mailto:attacker@x?subject=info@wavespestcontrol.com" must fail an
    // endsWith check), and every comma-separated recipient must be on the
    // company domain. Percent-DECODE before splitting: the mail client
    // decodes "attacker@gmail.com%2Cinfo@wavespestcontrol.com" into two
    // recipients, so the guard must split on what the client sees; an
    // undecodable address fails closed.
    const [rawAddressPart, queryPart] = m[1].split('?');
    let addressPart;
    try { addressPart = decodeURIComponent(String(rawAddressPart || '')); } catch {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link with an undecodable address ("${String(rawAddressPart || '').slice(0, 60)}") — remove it.`);
    }
    // Decoded control characters (%0A/%0D) act as separators/header breaks
    // in mail clients — an address that contains any is smuggling, and no
    // legitimate recipient carries one. Fail closed before splitting.
    if (/[\u0000-\u001F]/.test(addressPart)) {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', 'Draft contains a mailto link whose address decodes to control characters — remove it.');
    }
    // Split on semicolons as well as commas — common mail clients accept
    // both as recipient separators, so "attacker@x;info@waves…" must not
    // pass as one string that happens to END on the company domain.
    const recipients = addressPart.split(/[,;]/).map((r) => r.trim().toLowerCase()).filter(Boolean);
    if (recipients.length === 0 || recipients.some((r) => !r.endsWith('@wavespestcontrol.com'))) {
      return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link to "${addressPart.slice(0, 80)}" — only @wavespestcontrol.com addresses are allowed.`);
    }
    // Query headers can ADD recipients (to/cc/bcc) — those are subject to
    // the same allowlist; a malformed/undecodable value fails closed.
    for (const kv of String(queryPart || '').split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      // Decode the header NAME like the value below — mail clients decode
      // "?b%63c=" to bcc, so a raw-key compare would skip the recipient
      // check entirely. Undecodable fails closed.
      let key = (eq === -1 ? kv : kv.slice(0, eq)).trim();
      try { key = decodeURIComponent(key); } catch {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link with an undecodable query header ("${key.slice(0, 40)}") — remove it.`);
      }
      key = key.trim().toLowerCase();
      let value = eq === -1 ? '' : kv.slice(eq + 1);
      try { value = decodeURIComponent(value); } catch {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link with an undecodable "${key}" header — remove it.`);
      }
      // EVERY header value is decoded and control-checked BEFORE the
      // recipient-key filter below: mail clients can treat decoded CR/LF
      // as header separators, so ?subject=Hi%0Abcc:attacker@... smuggles a
      // recipient through a "harmless" field the old order never decoded.
      if (/[\u0000-\u001F]/.test(value)) {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link whose "${key}" header decodes to control characters — remove it.`);
      }
      if (key !== 'to' && key !== 'cc' && key !== 'bcc') continue; // subject/body etc. add no recipients (control-clean ones are fine)
      const extra = value.split(/[,;]/).map((r) => r.trim().toLowerCase()).filter(Boolean);
      if (extra.length === 0 || extra.some((r) => !r.endsWith('@wavespestcontrol.com'))) {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a mailto link whose "${key}" header adds a non-Waves recipient — only @wavespestcontrol.com addresses are allowed.`);
      }
    }
  }
  const proto = body.match(PROTOCOL_RELATIVE_RE);
  if (proto) {
    return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains a protocol-relative URL ("${proto[0].trim()}") — use a relative internal path or an allowlisted absolute URL.`);
  }
  return null;
}

// ── MDX component gate ──────────────────────────────────────────────
// SAFE_MDX_COMPONENTS mirrors the RECONCILED Astro component contract
// (wavespestcontrol-astro PR #342): the set where
//   1. packages/blog-schema/schema.ts COMPONENT_NAMES (the publish-gate
//      catalog — an uncataloged name rejects the PR) and
//   2. src/layouts/BlogPostLayout.astro mdxComponents (the renderer registry
//      — a cataloged-but-unregistered name crashes the MDX build with
//      "Expected component X to be defined")
// agree on an implemented component. Before #342 the two had drifted: the
// writer's favorite <SeasonalPressureChart>/<HomeZoneMap> were registered but
// uncataloged, so every post embedding them parked at the Astro gate after a
// full generation spend, while 14 phantom catalog names (WhyTrustUs, TLDR,
// DataCallout, ProTip, …) had no renderer at all. Any PascalCase JSX tag
// outside this set is a P0 — the draft routes to review exactly like the
// other body-policy P0s. If the astro catalog changes again, update this
// list to the new catalog∩renderer intersection.
const SAFE_MDX_COMPONENTS = Object.freeze([
  'AppPhone',
  'BottomLineBox',
  'ComparisonTable',
  'HomeZoneMap',
  'HonestRejection',
  'PestEvidenceGrid',
  'SeasonalPressureChart',
]);

const SAFE_MDX_COMPONENT_SET = new Set(SAFE_MDX_COMPONENTS);
// A PascalCase JSX opening tag — the shape MDX treats as a component
// invocation. Closing tags (</X>) reuse the same name and need no extra scan.
const JSX_COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9]*)\b/g;

function uncatalogedComponentFinding(body) {
  const text = String(body || '');
  const re = new RegExp(JSX_COMPONENT_TAG_RE.source, JSX_COMPONENT_TAG_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!SAFE_MDX_COMPONENT_SET.has(m[1])) {
      return finding('P0', 'UNCATALOGED_COMPONENT', `Draft embeds <${m[1]}>, which is not in the safe MDX component set (${SAFE_MDX_COMPONENTS.join(', ')}) — uncataloged components are rejected by the Astro publish gate or crash the build. Remove it or express the content in markdown.`);
    }
  }
  return null;
}

// ── citation-token residue gate ─────────────────────────────────────
// A model-side citation apparatus (<cite index="12">…</cite>, bare
// index="N" tokens, or markdown footnotes [^1] / [^1]: …) leaking into
// publishable copy — one live draft shipped 12 of them. There is no
// legitimate use for this markup in a draft: real sourcing is prose
// attribution plus an allowlisted link.
const CITATION_RESIDUE_RE = /<\/?cite\b|\bindex\s*=\s*["']\d+["']|\[\^[^\]]{1,30}\]/i;

function citationResidueFinding(text) {
  const m = String(text || '').match(CITATION_RESIDUE_RE);
  if (!m) return null;
  return finding('P0', 'CITATION_TOKEN_RESIDUE', `Draft contains raw citation markup ("${m[0]}") — model citation tokens must never ship. Attribute sources in prose instead.`);
}

// ── off-footprint service-claim gate ────────────────────────────────
// Regional SWFL cities Waves does NOT serve. The canonical footprint is
// config/locations CITY_TO_LOCATION; this candidate list is filtered against
// it at scan time so a city added to the real footprint automatically drops
// out of the blocklist. A blocked city is only a P0 inside a SERVICE-CLAIM
// context (we serve / your home / call-schedule-book / our technicians /
// same-day within ~90 chars) — bare educational mentions ("tegu lizards
// spread from Fort Myers") must pass.
const OUT_OF_AREA_CITY_CANDIDATES = Object.freeze([
  'Fort Myers', 'Cape Coral', 'Naples', 'Bonita Springs', 'Marco Island',
  'Estero', 'Lehigh Acres', 'St. Petersburg', 'Tampa', 'Winter Haven',
  'Plant City',
]);

function outOfAreaCities() {
  let footprint = null;
  try {
    ({ CITY_TO_LOCATION: footprint } = require('../../config/locations'));
  } catch { footprint = null; }
  if (!footprint) return [...OUT_OF_AREA_CITY_CANDIDATES]; // fail closed: full blocklist
  return OUT_OF_AREA_CITY_CANDIDATES.filter((c) => !footprint[c.toLowerCase()]);
}

// "our techs/team/technicians" needs an OPERATION VERB within two words — a
// bare team mention ("our team reviewed Miami termite research") is a
// factual reference, not a service claim.
const SERVICE_CLAIM_CONTEXT_RE = /\b(we(?:'re| are)? serv\w*|serving|proudly serv\w*|service areas?|your (?:\w+\s+){0,2}(?:home|house|lawn|yard|property)|call|schedule|book(?:ing)?|our (?:technicians?|techs?|team)(?:\s+\w+){0,2}\s+(?:treats?|serves?|services?|covers?|visits?|inspects?|handles?|sprays?|works? in|operates? in)|same.day|we treat|we cover|we offer|free (?:quote|estimate|inspection))\b/i;

// A clause that honestly LIMITS the footprint is not a claim — "Naples is
// outside our service area", "we don't serve Tampa". Tested per CLAUSE, not
// per sentence, so a disclaimer cannot shield an affirmative claim in the
// next clause ("…, but we cover Tampa" still flags). Apostrophes are
// normalized first so typographic "doesn't" matches.
const FOOTPRINT_DISCLAIMER_RE = /\b(outside (?:of )?(?:our|the) service (?:area|footprint)|(?:do not|don'?t|does not|doesn'?t) (?:currently |yet )?(?:include|cover|serve|service|extend|reach)|not (?:currently )?(?:in|within|part of) our (?:service )?(?:area|footprint)|beyond our (?:service )?(?:area|footprint)|no longer (?:serve|service|cover))\b/i;

// Sentence split preserves dotted place abbreviations (St. Petersburg); a
// rare genuine "St."-final sentence merges with the next, which only widens
// the claim scope — fails closed. Clause split mirrors the astro-side gate.
const FOOTPRINT_SENTENCE_SPLIT_RE = /(?<=[.!?])(?<!\bSt\.)(?<!\bFt\.)(?<!\bMt\.)\s+/;
// Bare adversatives and "and we/our …" split too — the joints where a
// disclaimer half hides an affirmative half. Noun-phrase "and" ("lawns and
// shrubs") does not split, so a claim verb keeps its full object list.
const FOOTPRINT_CLAUSE_SPLIT_RE = /;\s*|,\s*(?:but|and|yet|however|though|while)\s+|\s+(?:but|however|yet|though)\s+|\s+and\s+(?=(?:we|our)\b)/i;

function offFootprintCityFinding(text) {
  const s = String(text || '');
  if (!s) return null;
  const cities = outOfAreaCities();
  const cityRes = cities.map((city) => ({
    city,
    // "St." may be written without the period; multi-word cities may wrap.
    re: new RegExp(`\\b${escapeRegExp(city).replace(/\\\./g, '\\.?').replace(/^Fort/, '(?:Fort|Ft\\.?)').replace(/\s+/g, '\\s+')}\\b`, 'i'),
  }));
  // Newline block boundaries split FIRST — an unpunctuated heading, list
  // item, or joined meta line must never merge with the next block into one
  // pseudo-sentence.
  const sentences = s.split(/\n+/).flatMap((line) => line.split(FOOTPRINT_SENTENCE_SPLIT_RE));
  for (const sentence of sentences) {
    for (const clause of sentence.split(FOOTPRINT_CLAUSE_SPLIT_RE)) {
      const normalized = clause.replace(/[‘’]/g, "'");
      if (!SERVICE_CLAIM_CONTEXT_RE.test(normalized)) continue;
      if (FOOTPRINT_DISCLAIMER_RE.test(normalized)) continue;
      for (const { city, re } of cityRes) {
        if (re.test(normalized)) {
          return finding('P0', 'OFF_FOOTPRINT_CITY_CLAIM', `Draft makes a service claim naming "${city}", which is outside the Waves service footprint (config/locations CITY_TO_LOCATION). Educational mentions and honest out-of-area disclaimers are fine; service/CTA framing is not.`);
        }
      }
    }
  }
  return null;
}

// ── internal-route gate ─────────────────────────────────────────────
// Site-relative link destinations must resolve to routes that actually
// exist — one live draft linked a dead /pest-library/fleas/. The allowlist
// is deliberately CONSERVATIVE: the conversion pages, the hub service pages
// (kept in sync with content-brief-builder's SERVICE_HUB_LINKS — a unit test
// asserts the superset), and the city-service URL patterns the briefs/prompts
// mandate. Everything else parks the draft for review. Brief-mandated links
// (internal_links_to_add, curated operator hub_link) are threaded in per-draft
// via the allowedInternalLinks option — they are binding writer instructions,
// exactly like requiredSourceUrls on the external gate.
const ALLOWED_INTERNAL_LINKS = Object.freeze([
  '/',
  '/book/',
  '/contact/',
  '/pest-control-quote/',
  '/pest-control-calculator/',
  // hub service pages (superset of content-brief-builder SERVICE_HUB_LINKS)
  '/pest-control-services/',
  '/waveguard-memberships/',
  '/pest-library/',
  '/lawn-care/',
  '/lawn-care/fertilizer-blackout-manatee-county/',
  '/mosquito-control/',
  '/termite-inspection/',
  '/rodent-control/',
  '/tree-shrub-care/',
  // hub pages the legacy writer prompts already reference
  '/service-areas/',
  '/pest-control-deals/',
  '/pest-inspection/',
  '/waves-guarantee/',
  '/faqs/',
]);

// /{service}-{city}-fl/ city-service pages (incl. the city quote pages the
// city-service prompt mandates for CTAs and the Bradenton-only specialty
// slugs the legacy optimizer prompt lists). Alternation is LONGEST-FIRST so
// the captured city slug never swallows a service suffix
// ("pest-control-quote-sarasota" must capture "sarasota", not
// "quote-sarasota"). The city capture is validated against the real
// footprint below — "/pest-control-fort-myers-fl/" is a dead out-of-area
// link, not a pass.
const CITY_SERVICE_LINK_RE = /^\/(?:commercial-pest-control|pest-control-services|pest-control-quote|tree-and-shrub-care|palm-tree-injections|termite-inspection|termite-control|mosquito-control|bed-bug-control|rodent-control|lawn-aeration|pest-control|lawn-care)-([a-z][a-z-]*)-fl\/$/;

// City slugs a generated city-service link may target — the same canonical
// footprint the off-footprint text gate uses. Fail-closed fallback: the
// staffed-market slugs.
function footprintCitySlugs() {
  let footprint = null;
  try {
    ({ CITY_TO_LOCATION: footprint } = require('../../config/locations'));
  } catch { footprint = null; }
  if (!footprint) {
    return new Set(['bradenton', 'lakewood-ranch', 'sarasota', 'venice', 'north-port', 'palmetto', 'parrish', 'port-charlotte']);
  }
  return new Set(Object.keys(footprint).map((c) => c.replace(/\s+/g, '-')));
}

function normalizeInternalPath(dest) {
  let p = String(dest || '').trim().toLowerCase().split('#')[0].split('?')[0];
  if (!p.startsWith('/')) return null;
  if (p !== '/' && !p.endsWith('/') && !/\.[a-z0-9]{2,5}$/.test(p)) p += '/';
  return p;
}

// Every site-relative destination in the body: markdown links/images,
// href/src attributes, AND reference-style definitions ("[flea]: /path/") —
// reference links render exactly like inline ones and shipped a dead
// destination would be just as dead. (Absolute URLs are the external gate's
// job.)
const RELATIVE_DEST_RE = /\]\(\s*<?\s*(\/[^)\s>]*)|\b(?:href|src)\s*=\s*\{?\s*["'`](\/[^"'`]*)|^[ \t]*\[[^\]^][^\]]*\]:[ \t]+<?(\/\S*)/gim;

function internalRouteFinding(body, allowedInternalLinks = []) {
  const text = String(body || '');
  if (!text) return null;
  const allowed = new Set(ALLOWED_INTERNAL_LINKS);
  for (const link of Array.isArray(allowedInternalLinks) ? allowedInternalLinks : []) {
    const norm = normalizeInternalPath(link);
    if (norm) allowed.add(norm);
  }
  const re = new RegExp(RELATIVE_DEST_RE.source, RELATIVE_DEST_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    const dest = m[1] || m[2] || m[3];
    // Anchor-only and in-repo image references are not routes.
    if (dest.startsWith('/images/')) continue;
    const norm = normalizeInternalPath(dest);
    if (!norm) continue;
    if (allowed.has(norm)) continue;
    const citySlug = CITY_SERVICE_LINK_RE.exec(norm)?.[1];
    if (citySlug && footprintCitySlugs().has(citySlug)) continue;
    return finding('P0', 'UNKNOWN_INTERNAL_ROUTE', `Draft links to "${dest}", which is not on the internal-route allowlist, a brief-mandated link, or a known city-service URL pattern — invented internal routes ship as dead links. Use the allowlisted targets or the brief's internal_links_to_add.`);
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

// ── Product / inventory claims (P1 PRODUCT_CLAIM) ─────────────────────────
// Autonomous drafts have repeatedly asserted professional product names,
// active-ingredient mechanisms, and "what our techs carry" inventory claims
// that nothing in content-ops/facts-bank/ supports (Codex flagged Advion/
// indoxacarb + "which is what our techs carry" on astro PR #383). Product
// facts are never in the brief facts_pack, so in this lane they are
// UNVERIFIABLE by construction: block them all. Consumer-brand "don't spray
// Raid/Ortho" warnings stay legal — the lists below cover professional
// products and active ingredients only.
const PRO_PRODUCT_TERMS = [
  'advion', 'termidor', 'taurus sc', 'alpine wsg', 'temprid',
  'demand cs', 'suspend sc', 'suspend polyzone', 'talstar', 'maxforce',
  'optigard', 'arilon', 'intice',
  'essentria', 'sentricon', 'trelona', 'altriset', 'terro pro',
];
// Brand names that are ALSO ordinary English words ("use these steps in
// tandem", "phantom ants", "on the premises", "a vendetta against roaches").
// Bare word matching P1'd valid prose, so these only count as products when
// adjacent to a product noun/formulation.
const AMBIGUOUS_PRODUCT_TERMS = ['phantom', 'premise', 'tandem', 'vendetta'];
const PRODUCT_NOUN_TERMS = ['insecticide', 'termiticide', 'pesticide', 'aerosol', 'foam', 'gel', 'bait', 'granules?', 'spray', 'dust', 'label', 'sc', 'wsg', 'wg', 'xt'];
const PRODUCT_NOUN_SRC = `(?:${PRODUCT_NOUN_TERMS.join('|')})`;
// Round-9 (Codex P2): reading/following the LABEL is the compliance
// language the writer prompt REQUIRES ("our technicians use the product
// label to choose safe placement") — never an inventory claim. 'label'
// stays in PRODUCT_NOUN_SRC for brand adjacency ("the Premise label"),
// but the inventory branch excludes it, and an inventory noun that is
// itself modifying "label(s)" ("the product label", "the bait label") is
// a label reference, not carried inventory.
const INVENTORY_PRODUCT_NOUN_SRC = `(?:${PRODUCT_NOUN_TERMS.filter((t) => t !== 'label').join('|')})`;
const ACTIVE_INGREDIENT_TERMS = [
  'indoxacarb', 'fipronil', 'dinotefuran', 'imidacloprid', 'bifenthrin',
  'hydramethylnon', 'abamectin', 'avermectin', 'thiamethoxam', 'clothianidin',
  'cyfluthrin', 'deltamethrin', 'lambda-cyhalothrin', 'cyhalothrin',
  'permethrin', 'cypermethrin', 'esfenvalerate', 'chlorfenapyr', 'novaluron',
  'pyriproxyfen', 'methoprene', 'hexaflumuron', 'noviflumuron', 'sulfluramid',
  'chlorantraniliprole',
];
const INVENTORY_CLAIM_RES = [
  // "our techs carry/use/rely on … <some product/formulation>" — the verb
  // alone is NOT a violation ("our technicians use moisture meters", "our
  // team uses inspection notes"); it must be about a pesticide product.
  // Named brands/ingredients after these verbs are caught by the brand and
  // ingredient branches regardless.
  // The product noun must be the OBJECT of the verb (a few determiner/
  // adjective words at most) — "carry more than one bait" blocks, while
  // "use inspection notes to decide where bait should go" stays legal.
  new RegExp(`\\b(?:our|waves(?:'s?)?)\\s+(?:techs?|technicians?|team|pros?|crews?)\\s+(?:carry|carries|use|uses|apply|applies|stock|stocks|lean\\s+on|rely|relies|prefer|prefers|spray|sprays|trust|trusts)\\b(?:\\s+on)?(?:\\s+[\\w'’-]+){0,3}?\\s+(?:${INVENTORY_PRODUCT_NOUN_SRC}|baits?|gels?|products?|formulations?|chemicals?)\\b(?!\\s+labels?\\b)`, 'i'),
  // Anaphoric inventory claims — "what our techs carry", "which is what our
  // techs use" — always refer back to a just-named product; keep unconditional.
  /\bwhat\s+(?:our|the)\s+(?:techs?|technicians?|team|pros?)\s+(?:carry|carries|use|uses)\b/i,
  /\bwhich\s+is\s+what\s+(?:our\s+(?:techs?|technicians?|team)|we)\s+(?:carry|carries|use|uses)\b/i,
];

// A professional product named as a TOPIC ("Sentricon in Southwest Florida")
// is legitimate informational content; the violation is naming it in a
// recommendation / usage / inventory context ("the gel pros reach for is
// Advion", "grab some Advion", "which is what our techs carry"). Active
// ingredients get no such carve-out — mechanism-level specifics are never in
// the facts bank and homeowners don't search them.
// choose/select forms (round 9): "Choose Advion for ants" / "select
// Termidor along the slab" are recommendations by different wording.
const PRODUCT_CONTEXT_VERBS_SRC = "(?:use[sd]?|using|appl(?:y|ies|ied|ying)|plac(?:e[sd]?|ing)|put(?:s|ting)?\\s+(?:out|down)|grabs?|bu(?:y|ys|ying)|pick(?:s|ing)?\\s+up|recommend\\w*|carr(?:y|ies|ying)|reach(?:es)?\\s+for|lean[s]?\\s+on|trusts?|sprays?|spraying|treats?\\s+with|choos(?:e|es|ing)|chose(?:n)?|select(?:s|ed|ing)?)";

function productClaimFinding(text) {
  const s = String(text || '');
  for (const term of ACTIVE_INGREDIENT_TERMS) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    if (re.test(s)) {
      return finding('P1', 'PRODUCT_CLAIM', `Names the active ingredient "${term}" — mechanism-level product facts are not in the facts bank and cannot ship in autonomous content. Describe the product class generically (e.g. "a slow-acting sugar-based bait gel labeled for indoor use") and defer specifics to the label.`);
    }
  }
  const brandAlt = PRO_PRODUCT_TERMS.map(escapeRegExp).join('|');
  // Context that turns a brand TOPIC into a recommendation/endorsement/usage
  // claim: usage verbs before the brand; endorsement, EFFICACY ("works best",
  // "kills ants quickly"), or PASSIVE-USAGE ("is applied in pea-sized dabs")
  // phrasing after it. A bare brand mention with none of these stays legal
  // (informational topic).
  const POST_BRAND_CLAIM_SRC = [
    'is\\s+what', 'which\\s+is\\s+what', 'pro\\s+choice', 'go-?to', 'top\\s+pick', 'favorite',
    'best\\s+(?:bait|gel|product|option|choice)',
    // efficacy claims. 'works' is EFFICACY-QUALIFIED (round-10, Codex P2):
    // bare "How Sentricon works in Southwest Florida" / "Sentricon works by
    // intercepting foragers" is the product-as-TOPIC informational copy the
    // carve-out above explicitly allows (and evaluate() scans title/meta, so
    // an unqualified 'works' blocked legitimate topic pages before a PR ever
    // opened). It only counts as a claim with efficacy/comparative/guarantee
    // wording ("works better/best/guaranteed/wonders/every time") or an
    // endorsing intensifier before it ("really/actually works").
    'works?\\s+(?:best|better|faster|great|wonders|guaranteed|perfectly|flawlessly|reliably|so\\s+well|every\\s+time|like\\s+a\\s+charm|instantly|overnight|on\\s+contact)',
    '(?:really|actually|truly|always|just|simply)\\s+works?\\b',
    'kills?\\b', 'knocks?\\s+(?:out|down)', 'wipes?\\s+out', 'eliminates?', 'eradicates?', 'outperforms?',
    'is\\s+(?:the\\s+)?(?:best|most\\s+effective|effective|strongest|stronger)',
    // passive usage — present AND past tense
    '(?:is|are|was|were|gets?|got)\\s+(?:applied|used|placed|sprayed|injected|installed|put\\s+(?:down|out))',
  ].join('|');
  const brandInRecommendation = new RegExp(`\\b(?:${PRODUCT_CONTEXT_VERBS_SRC}|rel(?:y|ies|ying)\\s+on)\\b[^.!?\\n]{0,120}\\b(?:${brandAlt})\\b|\\b(?:${brandAlt})\\b[^.!?\\n]{0,120}\\b(?:${POST_BRAND_CLAIM_SRC})`, 'i');
  const brandMatch = s.match(brandInRecommendation);
  if (brandMatch) {
    return finding('P1', 'PRODUCT_CLAIM', `Recommends the professional product in "${brandMatch[0].trim().slice(0, 120)}" — unsupported by the facts bank. Name the product class generically and defer specifics to the label; product names are only legal as an informational topic, never as a usage/efficacy claim.`);
  }
  // Ambiguous brand words only count when adjacent to a product noun
  // ("Phantom aerosol", "Premise granules") — bare "in tandem"/"phantom ants"
  // is ordinary prose.
  const ambiguousAlt = AMBIGUOUS_PRODUCT_TERMS.map(escapeRegExp).join('|');
  const ambiguousProduct = new RegExp(`\\b(?:${ambiguousAlt})\\s+${PRODUCT_NOUN_SRC}\\b`, 'i');
  const ambiguousMatch = s.match(ambiguousProduct);
  if (ambiguousMatch) {
    return finding('P1', 'PRODUCT_CLAIM', `Names the professional product "${ambiguousMatch[0].trim()}" — unsupported by the facts bank. Name the product class generically instead.`);
  }
  for (const re of INVENTORY_CLAIM_RES) {
    const m = s.match(re);
    if (m) {
      return finding('P1', 'PRODUCT_CLAIM', `Inventory claim "${m[0]}" asserts what Waves technicians carry/use — unverifiable from the facts bank and goes stale. Remove the claim; describe what a licensed professional would do instead.`);
    }
  }
  return null;
}

// ── Prevention / elimination promises (P1 PREVENTION_PROMISE) ─────────────
// The facts bank prohibits guaranteed-extermination / 100%-elimination
// claims, and drafts keep emitting softer variants ("prevents next month's
// trail", "keeps them from coming back") that Codex then flags round after
// round. The documented offer is reduced recurrence + free re-treatment —
// never prevention. Patterns are pest-anchored to avoid the bare-'never'
// false-positive class that got the old signal removed (PR #2776).
const PEST_OBJ_SRC = "(?:ants?|pests?|bugs?|roaches|cockroaches|termites?|rodents?|mice|rats?|mosquito(?:es)?|spiders?|fleas?|ticks?|infestations?|colon(?:y|ies)|trails?|them|they)";
// Round-8 (Codex P1): the filler words between a service subject and the
// promise verb must never absorb a negation that governs the verb —
// "This treatment does not eliminate ants" / "won't eliminate ants" are
// exactly the honest disclaimers this gate exists to ENCOURAGE. Every
// filler word is lookahead-guarded against these forms; two-word
// negations resolve too ("does not" = allowed "does" + blocked "not", so
// the verb position lands on "not" and the match dies). "not" heading a
// "not only/just/merely" construction stays allowed because "This
// treatment not only prevents ants…" is an AFFIRMATIVE claim.
const NEGATION_WORD_SRC = "(?:not(?!\\s+(?:only|just|merely)\\b)|no|never|won['’]?t|cannot|can['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|couldn['’]?t|shouldn['’]?t|wouldn['’]?t|mustn['’]?t)";
const NON_NEGATED_FILLER_SRC = `(?:(?!${NEGATION_WORD_SRC}\\b)[\\w'’]+\\s+){0,2}?`;
// Every pattern is pest-anchored — the OBJECT (or the promised state) must be
// a pest term, so "prevents next month's water bill" / "prevents moisture
// buildup" stay legal. Source strings (not RegExp literals) so the finding
// scanner can run each with the global flag and inspect EVERY match — a
// single negated-disclaimer match must not exempt later matches of the same
// pattern.
const PREVENTION_PROMISE_SRCS = [
  // "prevents/keeps/stops <pest> from coming back / returning / getting in"
  `\\b(?:prevents?|keeps?|stops?)\\s+(?:[\\w'’]+\\s+){0,3}?${PEST_OBJ_SRC}\\s+from\\s+(?:coming\\s+back|returning|re-?infest\\w*|ever\\s+\\w+|getting\\s+(?:back\\s+)?in(?:side)?\\b)`,
  // "<pest> won't / will not / will never come back or return"
  `\\b${PEST_OBJ_SRC}\\s+(?:won['’]?t|will\\s+not|will\\s+never|never)\\s+(?:come\\s+back|return|be\\s+back)`,
  // "never see/deal with another <pest>"
  `\\bnever\\s+(?:see|have|deal\\s+with|worry\\s+about)\\s+(?:another\\s+)?${PEST_OBJ_SRC}`,
  // guaranteed / promised elimination or 100% anything
  "\\b(?:guarantees?d?|promises?d?)\\s+(?:[\\w'’]+\\s+){0,3}?(?:eliminat\\w+|exterminat\\w+|eradicat\\w+|pest[-\\s]?free|100\\s?%)",
  "\\b100\\s?%\\s+(?:effective|eliminat\\w+|eradicat\\w+|pest[-\\s]?free|guaranteed?|success)",
  // "eliminates/gets rid of <pest> for good / permanently / forever"
  `\\b(?:eliminates?|gets?\\s+rid\\s+of|removes?|clears?\\s+out)\\s+(?:[\\w'’]+\\s+){0,3}?${PEST_OBJ_SRC}\\s+(?:for\\s+good|permanently|forever|once\\s+and\\s+for\\s+all)`,
  // "prevents next month's/season's <pest>" (the PR #383 shape). Pest object
  // REQUIRED — optional matching blocked "prevents next month's water bill".
  `\\bprevents?\\s+(?:the\\s+)?(?:next|future)\\s+(?:month|year|season|week)[\\w'’]*\\s+(?:[\\w'’]+\\s+){0,2}?${PEST_OBJ_SRC}`,
  // BARE unconditional promises with a service/treatment subject:
  // "This quarterly treatment prevents infestations", "Our treatment
  // eliminates ants in your home", "A professional application eradicates
  // cockroaches". The subject anchor keeps question headings and homeowner
  // how-to framing ("How do I get rid of ants?") legal, and the
  // negation-guarded filler (round 8) keeps directly negated disclaimers
  // ("This treatment does not eliminate ants") legal.
  `\\b(?:treatments?|applications?|services?|programs?|plans?|visits?|products?|this|it)\\s+${NON_NEGATED_FILLER_SRC}(?:prevents?|eliminates?|eradicates?|exterminates?|wipes?\\s+out)\\s+(?:all\\s+|any\\s+|future\\s+|the\\s+|your\\s+)?${PEST_OBJ_SRC}`,
  // Qualifier promises with no subject needed: "prevents future infestations",
  // "prevents all ants" — incl. comparison-table row labels.
  `\\bprevents?\\s+(?:all|any|every|future)\\s+${PEST_OBJ_SRC}`,
  // "keeps your home/kitchen/yard pest-free" as an unconditional state
  "\\bkeeps?\\s+(?:your\\s+)?(?:home|house|kitchen|yard|lawn|property)\\s+(?:pest|ant|roach|termite|rodent|bug)[-\\s]?free\\b",
];
const PREVENTION_PROMISE_RES = PREVENTION_PROMISE_SRCS.map((src) => new RegExp(src, 'i'));

// Honest-disclaimer context: "no honest company will promise you'll never
// see another ant" is the phrasing we WANT — a match preceded by a negated
// promise is a disclaimer, not a claim.
// Apostrophes match BOTH straight and typographic forms — generated copy
// routinely ships curly quotes (the pest-practices matcher was burned by
// exactly this).
const NEGATED_PROMISE_CONTEXT_RE = /(?:no\s+(?:honest\s+)?(?:company|one|body|pro)|won['’]?t|will\s+not|cannot|can['’]?t|nobody\s+can|don['’]?t|do\s+not|doesn['’]?t|does\s+not|never)\s+(?:[\w'’]+\s+){0,3}?(?:promise|guarantee|tell\s+you)/i;

// Round-8 (Codex P1): a negation IMMEDIATELY before the matched claim
// directly negates its promise verb — "…doesn't stop ants from coming
// back", "cannot prevent every ant", "no guaranteed elimination" are
// disclaimers, not promises. The verb-anchored patterns start AT the verb,
// so a governing negation sits just before the match start; the
// subject-anchored pattern is covered by NON_NEGATED_FILLER_SRC instead
// (there the negation sits INSIDE the match). Anchored to the match start
// so "not only prevents ants…" (affirmative) and "Nothing stops ants like
// us" (hype, "Nothing" deliberately absent) still flag.
const DIRECT_NEGATION_BEFORE_RE = /(?:\bnot|\bnever|\bno|\bcannot|\bwon['’]?t|\bcan['’]?t|\bdon['’]?t|\bdoesn['’]?t|\bdidn['’]?t|\bisn['’]?t|\baren['’]?t|\bwasn['’]?t|\bweren['’]?t|\bcouldn['’]?t|\bwouldn['’]?t|\bshouldn['’]?t|\bmustn['’]?t)\s+$/i;

// Round-9 (Codex P2): subject-level negation — "No service prevents all
// ants", "No treatment eliminates ants forever" — is the same honest-
// disclaimer class: a negated SUBJECT ("no" + up to three subject words)
// governing a verb-anchored match that starts right at the promise verb.
// The word chain must be CONTIGUOUS, so punctuation breaks government
// ("With no contract, our treatment eliminates ants for good" still
// flags), "no matter …" is excluded ("No matter what our treatment
// prevents…" is a promise), and "Nothing stops ants like us" promotional
// inversions stay flaggable ("Nothing" is deliberately not "no <subject>").
const NEGATED_SUBJECT_BEFORE_RE = /\bno\s+(?!matter\b)(?:[\w'’]+\s+){1,3}$/i;

// Round-10 (Codex P2): educational question/how-to framing makes prevention
// the TOPIC, not a promise — "How to prevent ants from coming back",
// "Can pest control prevent ants from coming back?" are exactly the
// search-intent titles the writer is supposed to produce. Two narrow
// shapes, and BOTH additionally require the matched verb to be BARE
// (uninflected): infinitives and fronted auxiliaries govern a bare verb,
// while embedded declarative promises stay inflected ("Did you know our
// treatment prevents ants…" keeps flagging) or carry a long subject.
//  - how-to / advice-noun infinitives: "how to (…) prevent", "steps to
//    keep", "ways to stop", plus a sentence-INITIAL bare "To prevent …".
//    Mid-sentence infinitives get NO exemption — "designed/guaranteed to
//    prevent ants from coming back" are capability promises and still flag.
//  - fronted-question inversion: optional wh-word + auxiliary + a SHORT
//    subject (1-3 words) directly before the verb — "Can pest control
//    prevent…", "Will a quarterly treatment stop…". Affirmative subjects
//    never match (no fronted auxiliary), so "Our service prevents…" /
//    "We prevent…" keep flagging, and "Nothing stops ants…" hype is
//    untouched (no auxiliary at all).
const HOWTO_INFINITIVE_BEFORE_RE = /(?:\bhow\s+to|\b(?:ways?|steps?|tips?|tricks?|methods?|habits?|strategies)\s+to)\s+(?:[\w'’]+\s+){0,2}$|^[^\w]*to\s+$/i;
const QUESTION_INVERSION_BEFORE_RE = /^[^\w]*(?:(?:how|what|why|where|when|who)\s+)?(?:can|could|will|would|do|does|did|should|shall|may|might)\s+(?:[\w'’]+\s+){1,3}$/i;
// The bare (uninflected) leading verbs of the verb-anchored promise
// patterns — the only forms an infinitive or fronted auxiliary can govern.
// Inflected matches ("prevents", "keeps", "gets rid of") never qualify:
// \b fails inside the trailing "s".
const BARE_LEADING_VERB_RE = /^(?:prevent|keep|stop|eliminate|eradicate|exterminate|remove|clear|get|wipe)\b/i;

function preventionPromiseFinding(text) {
  const s = String(text || '');
  for (const src of PREVENTION_PROMISE_SRCS) {
    // Global scan: every match is judged individually. A negated-disclaimer
    // FIRST match must not exempt a genuine promise later in the same text
    // ("No honest company will promise you'll never see another ant. Our
    // service means you will never see another ant." — the second flags).
    const re = new RegExp(src, 'gi');
    let m;
    while ((m = re.exec(s)) !== null) {
      // The negation must GOVERN the matched claim: same sentence AND no
      // clause boundary between the negated "promise/guarantee" verb and the
      // match. A disclaimer must shield neither the next sentence ("… can
      // promise permanent prevention. Our treatment eliminates ants.") nor a
      // coordinated clause in the same sentence ("… you'll never see another
      // ant, but our service eliminates ants.").
      const before = s.slice(Math.max(0, m.index - 80), m.index);
      const sentenceBreak = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
      const sameSentence = sentenceBreak >= 0 ? before.slice(sentenceBreak + 1) : before;
      // Directly negated claim ("will not prevent ants from returning",
      // "cannot prevent every ant" — round 8) or negated-subject disclaimer
      // ("No service prevents all ants" — round 9): exempt.
      if (DIRECT_NEGATION_BEFORE_RE.test(sameSentence) || NEGATED_SUBJECT_BEFORE_RE.test(sameSentence)) {
        if (m.index === re.lastIndex) re.lastIndex += 1; // zero-width safety
        continue;
      }
      // Question / how-to framing (round 10): only when the governing
      // context sits in the same sentence AND the matched verb is bare —
      // see the RE definitions above for the shapes and their limits.
      if ((HOWTO_INFINITIVE_BEFORE_RE.test(sameSentence) || QUESTION_INVERSION_BEFORE_RE.test(sameSentence)) && BARE_LEADING_VERB_RE.test(m[0])) {
        if (m.index === re.lastIndex) re.lastIndex += 1; // zero-width safety
        continue;
      }
      const negation = NEGATED_PROMISE_CONTEXT_RE.exec(sameSentence);
      if (negation) {
        const between = sameSentence.slice(negation.index + negation[0].length);
        const clauseBreak = /[;:—–]|,\s*(?:but|and|yet|so|however|while)\b|\b(?:but|however)\b/i.test(between);
        if (!clauseBreak) {
          if (m.index === re.lastIndex) re.lastIndex += 1; // zero-width safety
          continue;
        }
      }
      return finding('P1', 'PREVENTION_PROMISE', `Prevention/elimination promise "${m[0].trim()}" — the facts bank prohibits guaranteed-outcome claims. Describe reduced recurrence and the free re-treatment (callback) guarantee instead.`);
    }
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
 * allowedInternalLinks: brief-mandated internal link targets
 *   (internal_links_to_add, curated operator hub_link) — allowed for this
 *   draft on top of the static ALLOWED_INTERNAL_LINKS set.
 * isRefresh: the draft rewrites the body of an EXISTING live page. The
 *   structure-of-new-content checks (component allowlist, internal-route
 *   allowlist) are skipped — legacy live bodies predate both policies and a
 *   refresh must not park on links/components it merely preserved. The
 *   citation-residue and off-footprint checks still apply in full (those are
 *   never legitimate, new or old).
 */
function evaluate(draft, { service = null, primaryKeyword = null, domains = null, operatorFaqException = false, requiredSourceUrls = [], operatorCitations = false, allowedInternalLinks = [], isRefresh = false } = {}) {
  const body = draft?.body || draft?.content || '';
  const frontmatter = draft?.frontmatter || {};
  const kw = primaryKeyword || frontmatter.primary_keyword || frontmatter.primaryKeyword || null;
  const effectiveDomains = Array.isArray(domains) ? domains : (Array.isArray(frontmatter.domains) ? frontmatter.domains : []);

  // Editable meta strings that publishRefresh / publishOrUpdatePage write onto
  // the (possibly multi-domain) live page. A hardcoded price or literal-brand
  // leak hiding only in metaTitle/metaDescription would otherwise slip past the
  // body-only P0 guards. Mirror astro-publisher's REFRESH_EDITABLE_META_FIELDS.
  const editableMeta = ['title', 'metaTitle', 'meta_description', 'metaDescription', 'hero_image_alt']
    .map((f) => frontmatter[f])
    .concat([frontmatter.hero_image?.alt])
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
    // Product/mechanism/inventory claims and prevention promises ship in meta
    // just like in body — scan the full publishable text for both.
    productClaimFinding(publishableText),
    preventionPromiseFinding(publishableText),
    // Citation residue + off-footprint service claims cover everything that
    // ships (body AND meta) on every lane — neither has a legitimate form.
    citationResidueFinding(publishableText),
    offFootprintCityFinding(publishableText),
    // Component + internal-route allowlists are body-structure policies for
    // NEW content; refresh drafts of legacy live pages are exempt (see the
    // isRefresh option doc above).
    isRefresh ? null : uncatalogedComponentFinding(body),
    isRefresh ? null : internalRouteFinding(body, allowedInternalLinks),
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
  // single source of truth for the product-claim + prevention-promise
  // policies — consumed by the writer prompts so instruction and enforcement
  // can never drift (same pattern as FAQ_BLOCKED_SERVICES above).
  PRO_PRODUCT_TERMS,
  ACTIVE_INGREDIENT_TERMS,
  // single source of truth for the MDX component vocabulary, the internal
  // link allowlist, and the out-of-footprint city blocklist — consumed by
  // writer-agent-config so the writer's instructions can never drift from
  // what these gates enforce at publish.
  SAFE_MDX_COMPONENTS,
  ALLOWED_INTERNAL_LINKS,
  OUT_OF_AREA_CITY_CANDIDATES,
  outOfAreaCities,
  _internals: { priceFinding, brandTokenFinding, faqBlockedFinding, keywordStuffingFinding, blockedServiceCandidates, BLOCKED_SERVICE_ALIASES, externalLinkFinding, allowedLinkHosts, hostAllowed, curatedCompetitorSourceHosts, OPERATOR_CITATION_HOSTS, productClaimFinding, preventionPromiseFinding, uncatalogedComponentFinding, citationResidueFinding, offFootprintCityFinding, internalRouteFinding, normalizeInternalPath, CITY_SERVICE_LINK_RE },
};
