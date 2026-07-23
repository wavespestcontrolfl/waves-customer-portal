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
// invocation. Member expressions (<ComparisonTable.Row>) are captured WHOLE
// so an invented subcomponent of a safe root can never slip through — the
// dotted name is not in the closed set. Underscores are legal JSX identifier
// characters (<Pro_Tip> is a component, and an undefined one). Closing tags
// (</X>) reuse the same name and need no extra scan.
const JSX_COMPONENT_TAG_RE = /<([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\b/g;

function collectComponentCounts(text) {
  const counts = new Map();
  const re = new RegExp(JSX_COMPONENT_TAG_RE.source, JSX_COMPONENT_TAG_RE.flags);
  let m;
  while ((m = re.exec(String(text || ''))) !== null) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  return counts;
}

// exemptComponentCounts: refresh grandfathering, by OCCURRENCE COUNT — a
// refresh that preserves one legacy <Callout> must not thereby earn a free
// pass to ADD more of them; only up to the prior body's count of each
// uncataloged name is preserved-legacy, every occurrence past that is a
// writer addition and gates like new content.
function uncatalogedComponentFinding(body, exemptComponentCounts = null) {
  for (const [name, count] of collectComponentCounts(body)) {
    if (SAFE_MDX_COMPONENT_SET.has(name)) continue;
    const grandfathered = exemptComponentCounts ? (exemptComponentCounts.get(name) || 0) : 0;
    if (count <= grandfathered) continue;
    return finding('P0', 'UNCATALOGED_COMPONENT', `Draft embeds <${name}>, which is not in the safe MDX component set (${SAFE_MDX_COMPONENTS.join(', ')})${grandfathered ? ` — the draft carries ${count} occurrence(s) but the live page only had ${grandfathered}, so the surplus is a writer addition` : ''} — uncataloged components are rejected by the Astro publish gate or crash the build. Remove it or express the content in markdown.`);
  }
  return null;
}

// ── citation-token residue gate ─────────────────────────────────────
// A model-side citation apparatus (<cite index="12">…</cite>, bare
// index="N" tokens, or markdown footnotes [^1] / [^1]: …) leaking into
// publishable copy — one live draft shipped 12 of them. There is no
// legitimate use for this markup in a draft: real sourcing is prose
// attribution plus an allowlisted link.
// Covers HTML cite tags, quoted AND unquoted index=N props, markdown
// footnotes, and the raw model-tooling artifacts (citeturn…, 【N†source】,
// :contentReference[oaicite:N]) — none has a legitimate published form.
// The Unicode private-use range covers the OpenAI citation GLYPHS
// themselves (citeturn0search0 wraps its token in U+E200-block
// characters) — the glyphs are invisible in rendered copy but ship as
// garbage bytes, and no legitimate draft contains PUA characters.
const CITATION_RESIDUE_RE = /<\/?cite\b|\bindex\s*=\s*["']?\d+|\[\^[^\]]{1,30}\]|\bciteturn\w+|【[^】\n]{0,40}】|:contentReference\[|\boaicite\b|[\uE000-\uF8FF]/i;

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
// Regional SWFL leak candidates plus the major FL metros a "Southwest
// Florida" writer plausibly names. Deliberate EXCLUSIONS: "St. Augustine"
// (the grass — "your St. Augustine lawn" is core footprint copy) and
// person-name cities like "Brandon" — both would false-positive constantly.
const OUT_OF_AREA_CITY_CANDIDATES = Object.freeze([
  'Fort Myers', 'Cape Coral', 'Naples', 'Bonita Springs', 'Marco Island',
  'Estero', 'Lehigh Acres', 'St. Petersburg', 'Tampa', 'Winter Haven',
  'Plant City', 'Clearwater', 'Orlando', 'Miami', 'Jacksonville',
  'Fort Lauderdale', 'Tallahassee', 'Gainesville', 'Lakeland', 'Kissimmee',
  'Ocala', 'Port St. Lucie', 'West Palm Beach', 'Hialeah', 'Boca Raton',
  // Broader FL metros (curated — full-state coverage stays a curated list
  // by design).
  'Daytona Beach', 'Melbourne', 'Palm Bay', 'Vero Beach', 'Fort Pierce',
  'Pensacola', 'Panama City', 'Spring Hill', 'Brooksville',
  // Nearby SWFL towns/islands a regional writer plausibly names.
  'Sanibel', 'Captiva', 'Arcadia', 'Sebring', 'Immokalee', 'LaBelle',
  // County-level phrasings of the same out-of-area markets. Footprint
  // counties (Manatee/Sarasota/Charlotte + served south Hillsborough) are
  // deliberately absent.
  'Lee County', 'Collier County', 'Pinellas County', 'Hendry County',
  'DeSoto County', 'Polk County', 'Miami-Dade County', 'Broward County',
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
// Third-person brand claims ("Waves Pest Control is now serving …") assert
// operation exactly like "we serve".
// "call" alone is NOT claim context — "Researchers call Fort Myers an
// early tegu hotspot" is attribution, not a CTA. Only CTA usage counts
// (call us / call Waves / call now|today / call for a quote / give us a
// call).
// The final arm catches SERVICE-KEYWORD framing with no explicit verb —
// "Need mosquito control in Cape Coral?", "Naples pest control guide" —
// SEO/service packaging of an out-of-footprint city is a claim even
// without "we serve". Bare pest words without a service noun ("Miami
// termite research") stay factual and pass.
// Lead nouns chain through conjunctions — "tree and shrub care", "lawn &
// pest control" are single service phrases, not two failed half-matches.
const SERVICE_NOUN_SOURCE = '(?:pest|mosquito|termite|rodent|lawn|tree|shrub|bed.?bugs?|wdo|ants?|fire.?ants?|cockroach(?:es)?|roach(?:es)?|fleas?|ticks?|spiders?|wasps?|hornets?|bees?|rats?|mice|mouse|scorpions?|silverfish|earwigs?|crickets?|wildlife|weeds?|grubs?|chinch.?bugs?)';
// The optional trailing "services/plans/programs" keeps compound phrasings
// like "pest control services in Naples" inside one keyword match — the
// in/near/for context arm anchors right after the keyword.
// Standalone agent/process nouns ("an exterminator in Naples",
// "extermination in Tampa") are packaging keywords on their own — no
// leading service noun required. \b closes both alternatives so the
// keyword can never end mid-word.
const SERVICE_KEYWORD_SOURCE = `(?:${SERVICE_NOUN_SOURCE}(?:\\s*(?:,|and|&|\\/|\\+)\\s*${SERVICE_NOUN_SOURCE})*\\s+(?:control|care|removal|treatment|exterminat\\w+|inspection|service|fertiliz\\w+|maintenance|mowing|aeration|seeding)s?(?:\\s+(?:service|plan|program)s?\\b(?!\\s+guides?\\b))?|exterminat(?:ors?|ions?)\\b|waveguard(?:\\s+(?:membership|plan|program|tier)s?)?\\b)`;
// "serve up"/"serving up" is the editorial idiom ("serving up a
// Naples-vs-Sarasota comparison") — guarded on every serve-form arm.
// offer/provide/deliver assert operation like serve/treat, but ONLY when a
// service-shaped noun is the verb's OBJECT (≤2 modifier words between) —
// "we provide this checklist for Naples homeowners" and "we deliver pest
// research" are editorial; "we provide service in Tampa" is a claim.
// Customer-demand arms ("Our Tampa customers…", "customers in Tampa call
// us…") are claim context, but the demand signal binds to ITS OWN city —
// "Our customers ask about Naples termite research" is an educational topic
// mention, not Naples demand. The city loop treats a clause whose ONLY
// claim context is a demand arm as city-scoped: the blocked city must sit
// inside the demand span itself. Kept as a named source so the loop can
// match spans with the same pattern the claim regex embeds.
const DEMAND_CONTEXT_SOURCE =
  "(?:calls?|questions?|requests?)\\b[^.!?]{0,40}\\bwe (?:get|see|receive)\\b(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|we (?:get|see|receive)\\b[^.!?]{0,40}\\b(?:calls?|questions?|requests?|customers?)\\b(?:\\s+about\\s+(?:[\\w-]+\\s+){0,4}?(?=(?:from|in|across|throughout)\\s))?(?:\\s*(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|our calls?\\b(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:[\\w.'-]+\\s+){0,3}?(?:customers?|homeowners?|residents?|neighbors?)\\s+(?:\\w+\\s+){0,3}?(?:call|text|contact|ask)s?\\s+(?:us\\b|waves\\w*\\b|our\\s+(?:team|office|techs?|technicians?)\\b)(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:waves(?: pest control)?(?:'s|')?)\\s+(?:\\w+\\s+){0,2}?customers\\b(?:\\s+(?:in|from|across|throughout)\\s+(?:(?!about\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|our\\s+(?:[\\w.']+\\s+){0,3}?customers\\b(?:\\s+(?:in|from|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?";

const SERVICE_CLAIM_CONTEXT_RE = new RegExp(
  "\\b(we(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still| \\w+ly)? (?:serv(?:e|es|ed|ing)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+|treat\\w*(?![^.!?]{0,20}\\b(?:data|research|information|statistics|figures|reports?)\\b(?!\\s*(?:in|near)\\b))|cover\\w*|inspect\\w*|handl\\w+|protect\\w*|visit\\w*|spray\\w*|exterminat\\w+|remov(?:e|es|ed|ing)\\b|eliminat\\w+|get(?:s|ting)? rid of\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|bring(?:s|ing)?\\b|brought\\b|send(?:s|ing)?\\b|sent\\b|dispatch(?:es|ed|ing)?\\b|fertiliz(?:e|es|ed|ing)\\b|maintain(?:s|ed|ing)?\\b|mow(?:s|ed|ing)?\\b|aerat\\w+\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|manag(?:e|es|ed|ing)\\b(?!\\s+to\\b))"
  + "|we(?:'re| are)? proud to (?:serve|service|treat|cover|protect)\\b"
  + `|${SERVICE_KEYWORD_SOURCE}\\s+(?:is\\s+|are\\s+)?now\\s+available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|now offering\\b[^.!?]{0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?!\\s+(?:info\\w*|tips?|advice|research|guides?|facts?|resources?|articles?|content|news)\\b)|${SERVICE_KEYWORD_SOURCE}\\s+available\\?[\\s\\S]{0,60}?\\byes\\b`
  + `|no (?:need|reason) to (?:go without|skip|miss|forgo|forego|risk)\\b[^.!?]{0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?!\\s+(?:guides?|tips?|advice|research|facts?|info\\w*|articles?|checklists?|newsletters?)\\b)(?![^.!?]{0,30}\\b(?:without\\s+a\\s+licen\\w*|without\\s+training|yourself|diy)\\b)`
  + `|(?:services?|plans?|programs?|treatments?)\\s*:\\s*available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|^\\s*available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)`
  + "|(?:we(?:'ve| have)?|waves(?: pest control)?(?:'s|')?(?: has| have)?)\\s+got\\s+(?:you|your\\s+\\w+)\\s+covered\\b|(?:waves(?: pest control)?(?:'s|')?|we)\\s+(?:has|have)\\s+you\\s+covered\\b"
  + "|(?:we(?:'re| are)?|waves(?: pest control)?(?:'s|')?(?: is| are)?|our (?:team|techs?|technicians?|crews?)(?: is| are)?)\\s*here to help\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)"
  + "|we(?:'re| are|'ll| will|'ve| have)?(?: been)?(?: also| now| currently| proudly| still)? (?:work(?:s|ed|ing)?|operat(?:e|es|ed|ing)) (?:in|throughout|across|around)\\b(?!\\s+(?:\\w+\\s+){0,2}?(?:records?|data|datasets?|research|studies|regulations?|rules|ordinances?|history|archives?|reports?|statistics|literature|documents?|weather|climate|conditions|seasons?|trends?|patterns?)\\b)|\\b(?:and|or)\\s+(?:now\\s+|currently\\s+|also\\s+|still\\s+|\\w+ly\\s+)?(?:work(?:s|ing)?|operat(?:e|es|ing)) (?:in|throughout|across|around)\\b|\\b(?:and|or|but)\\s+(?:now\\s+|currently\\s+|also\\s+|still\\s+|\\w+ly\\s+)?(?:visit|visits|spray|sprays|treat|treats|cover|covers|protect|protects|inspect|inspects|handle|handles|serve|serves|service|services|include|includes|extend|extends|reach|reaches)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))(?!\\s+(?:\\w+\\s+){0,2}?(?:records?|data|datasets?|research|studies|regulations?|rules|ordinances?|history|archives?|reports?|statistics|literature|documents?|weather|climate|conditions|seasons?|trends?|patterns?)\\b)"
  + '|(?:^|,)\\s*(?:now\\s+|currently\\s+|still\\s+|proudly\\s+|also\\s+)?serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|(?<!\\bnot\\s)(?<!\\bnever\\s)(?<!\\bstopped\\s)(?:now|currently|still|also) serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|proudly serv\\w*\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|our (?:[\\w-]+\\s+){0,3}?(?:(?:service|coverage)\\s+)?(?:areas?|footprints?)(?:\\s*(?=:)|\\s+(?:now\\s+|still\\s+|currently\\s+|also\\s+|proudly\\s+)?(?:includes?|covers?|extends?|reaches?|adds?|added|gained|grew|grows|growing)\\b)|(?:part of|one of|includ(?:ed|ing) in|joins?|joined|joining|added to|adding to|expands? (?:to|into)|expanding (?:to|into)|within|inside)\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|our (?:[\\w-]+\\s+){0,3}?coverage\\s+(?:now\\s+)?(?:includes?|covers?|extends?|reaches?|adds?|added|grew|grows|growing)\\b(?![^.!?]{0,30}\\b(?:research|data|studies|statistics|reports?|records?|information|info|topics?)\\b)|(?:is|are|lies?|sits?|falls?|remains?|stays?)\\s+(?:now\\s+|currently\\s+|proudly\\s+|still\\s+)?in\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:is|are)\\s+(?:now\\s+|also\\s+|officially\\s+|currently\\s+|still\\s+|proudly\\s+)?(?:(?:a|our|one of our|among our)\\s+)?(?:newest\\s+)?(?:service|coverage)\\s+(?:areas?|footprints?)\\b|your (?:\\w+\\s+){0,2}(?:home|house|lawn|yard|property)'
  + '|call (?:us\\b|waves\\b|now\\b|today\\b|ahead\\b|for (?:a |your )?(?:free )?(?:quote|estimate|inspection))|give us a call|(?:schedule|book(?:ing)?)\\b(?![^.!?]{0,50}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\s+(?:do not|don\'?t|does not|doesn\'?t|cannot|can\'?t|won\'?t)\\b)'
  + "|(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:[\\w']+\\s+){0,2})(?:our|waves(?: pest control)?(?:'s|')?) (?:[\\w-]+ ){0,3}?(?:technicians?|techs?|team|routes?|trucks?|vans?|crews?|offices?|branch(?:es)?|plans?|programs?|memberships?|pros?|specialists?|experts?|applicators?|staff|inspectors?)(?:\\s+\\w+){0,4}\\s+(?:open(?:s|ed|ing)?\\b(?!\\s+(?:the|a|an)\\b)|operational\\b|offer(?:s|ed|ing)?\\b|provid(?:e|es|ed|ing)\\b|deliver(?:s|ed|ing)?\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|available (?:in|throughout|across|to|for|near)\\b|includ(?:e|es|ed|ing)\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|get(?:s|ting)? rid of\\b|extend(?:s|ed|ing)? (?:to|into)\\b|reach(?:es|ed|ing)?\\b|exterminat\\w+\\b|remov(?:e|es|ed|ing)\\b|eliminat\\w+\\b|proud to (?:serve|service|treat|cover|protect)\\b|treat(?:s|ing|ed)?\\b|serv(?:e|es|ed)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+|cover(?:s|ing|ed)?\\b|visit(?:s|ing|ed)?\\b|inspect(?:s|ing|ed)?\\b|handl(?:e|es|ing|ed)\\b|spray(?:s|ing|ed)?\\b|run(?:s|ning)?\\b|protect(?:s|ing|ed)?\\b|work(?:s|ing|ed)? (?:in|throughout|across|around)|operat(?:e|es|ing|ed)? (?:in|throughout|across|around))"
  + '|same.day|we offer|free (?:quote|estimate|inspection)|' + DEMAND_CONTEXT_SOURCE + '|^\\s*(?:and |but |yet )?(?:also |now |still |currently )?(?:includes?|covers?|extends? (?:to|into)|reaches?|serves?|services?|treats?|visits?|sprays?|inspects?|protects?|handles?|helps?)\\b(?!\\s*:)(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))(?![^.!?]{0,30}\\b(?:data|research|weather|statistics|figures|information|charts?|tables?|topics?|sources?|studies)\\b)'
  + "|(?:we|waves(?: pest control)?|waveguard)(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still)? (?:offer|provid|deliver)\\w*\\s+(?:(?!(?:research|information|info|advice|guidance|tips|insights?|education|educational|resources?|articles?|guides?|content|news|about|on|regarding|of|for|to)\\b)[a-z-]+\\s+){0,2}?(?:(?:pest|mosquito|termite|rodent|lawn|tree|shrub|bed.?bugs?|wdo)\\s+)?(?:control|care|treatment|service|plan|program|inspection|removal|exterminat|waveguard)\\w*\\b(?!\\s+(?:(?!(?:and|or|nor|plus|as)\\b)[a-z-]+\\s+){0,2}?(?:research|information|info|advice|guidance|tips|insights?|education|educational|resources?|articles?|guides?|content|news|facts?|myths?|history|overviews?|checklists?|comparisons?|roundups?|director(?:y|ies)|summar(?:y|ies)|glossar(?:y|ies)|calendars?|faqs?)\\b)"
  // Editorial-FIRST mixed objects ("we provide pest control advice and
  // services in Naples") — an in/near-anchored "…services in <place>" after
  // a first-person/brand offer verb is an operating claim no matter what
  // editorial noun sits between.
  + "|(?:we|waves(?: pest control)?|waveguard)(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still)? (?:offer|provid|deliver)\\w*\\b(?:(?!\\b(?:about|regarding|concerning|on|for|director(?:y|ies)|lists?|overview|roundup|comparison|index|map)\\b)[^.!?;]){0,40}?\\bservices?\\s+(?:in|near|throughout|across)\\b"
  + `|(?<!\\b(?:can't|cannot|can not|won't|will not|don't|do not|doesn't|does not|couldn't|could not|shouldn't|should not|never|unable to|no way to|no)\\s+)(?:need|get|find|book|schedule|call|text|contact|looking for|searching for)\\b(?!\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\b[^.!?]{0,30}?\\b(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?:(?!\\babout\\b)[^.!?]){0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?![^.!?]{0,40}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\b[^.!?]{0,20}?\\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|won'?t)\\b)`
  // A short punctuation-free segment built around the keyword is a bare
  // packaging TITLE/META ("Cape Coral pest control services") — prose
  // sentences carry terminal punctuation and never match the anchored form.
  + `|^(?:(?!\\b(?:not|no|never|unavailable|unserved|isn|aren|without|guides?|compar\\w+|vs)\\b)[^.!?]){0,25}${SERVICE_KEYWORD_SOURCE}(?!(?:\\s+(?:service|plan|program)s?)?\\s+(?:guides?|research|information|info|advice|tips|insights?|education|resources?|articles?|content|news|myths?|history|checklists?|facts?|overviews?|comparisons?|roundups?|reviews?|breakdowns?|explainers?|faqs?)\\b)(?:(?!\\b(?:not|no|never|unavailable|unserved|isn|aren)\\b)[^.!?]){0,25}$`
  + `|\\b(?<!\\b(?:about|regarding|concerning|on)\\b[^.!?]{0,20})(?<!\\bcompar\\w+\\b[^.!?]{0,25})(?<!\\b(?:director(?:y|ies)|lists?|overview|roundup|comparison|index|map)\\s+of\\b[^.!?]{0,20})(?<!\\bguides?\\s+to\\b[^.!?]{0,20})(?<!\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b[^.!?]{0,25})(?<!\\b(?:provid|offer|deliver)\\w*\\b[^.!?]{0,30}\\bfor\\b[^.!?]{0,20})(?<!\\b(?:competitors?|other\\s+(?:compan|provider|firm)\\w*|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*|the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+)\\b[^.!?]{0,25})(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:[\\w']+\\s+){0,2})(?<!\\bnever\\s)(?<!\\bwithout\\s)(?<!\\blocal\\s)(?<!\\bnearby\\s)${SERVICE_KEYWORD_SOURCE}\\s+(?:in|near|for|quotes?|plans?|company|companies|available)\\b(?![^.!?]{0,40}\\b(?:without\\s+a\\s+licen\\w*|without\\s+training|yourself|diy)\\b)(?![^.!?]{0,40}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\b[^.!?]{0,20}?\\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|won'?t)\\b)(?![^.!?]{0,30}\\b(?:is|are|was|were|has|have|be|may|might|can|could|will|would|should|must|costs?|varies|vary|differs?|depends?|remains?|tends?|requires?|use[sd]?|using|rel(?:y|ies|ied)|charge[sd]?|charging|follow(?:s|ed)?|recommend(?:s|ed)?|report(?:s|ed)?|typically|often|usually|commonly|generally)\\b(?!(?:\\s+(?!(?:not|no|never|rarely|hardly)\\b)[a-z]+){0,2}?\\s+(?:(?:available|offered|provided|book(?:ed|able)?|scheduled|requested|reserved)\\b(?!\\s+(?:around|during|before|after|when|while)\\b)(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|(?:handled|performed|managed|covered|treated|serviced|delivered|done)\\s+by\\s+(?:waves|us|our)\\b)))`
  // "Our pest control services guide explains…" is editorial packaging of
  // CONTENT, not of service — the guide-compound lookahead mirrors the
  // keyword suffix's own guard.
  + `|(?:your|our)\\s+(?:(?!(?:guides?|about|regarding|lists?|overview|roundup|comparisons?|reviews?)\\b)\\w+\\s+){0,2}?${SERVICE_KEYWORD_SOURCE}\\b(?!(?:\\s+(?:service|plan|program)s?)?\\s+(?:guides?|advice|research|information|info|tips|insights?|education|resources?|articles?|content|news|facts?|myths?|history|overviews?|checklists?|comparisons?|roundups?|reviews?|explainers?|breakdowns?|faqs?)\\b)(?![^.!?]{0,30}\\b(?:depends?|varies|vary|differs?|costs?|requires?|tends?|remains?)\\b)`
  + "|(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:[\\w']+\\s+){0,2})\\b(?:waves\\w*|waveguard|(?:our|this|the)\\s+(?:\\w+\\s+){0,2}?(?:service|plan|program|membership|treatment)s?)\\b[^.!?]{0,20}?\\b(?:is|are)\\s+(?:now\\s+)?available\\s+(?:in|throughout|across|to|for|near)\\b"
  + "|(?:we|waves(?: pest control)?(?:'s|')?)\\s+(?:run|runs|running|have|has|had|operate|operates)\\s+(?:\\w+\\s+){0,4}?(?:routes?|offices?|branch(?:es)?|locations?|storefronts?)\\b"
  + "|(?:add(?:s|ed|ing)?|welcom(?:e|es|ed|ing))\\b[^.!?]{0,30}?\\bto our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:expand(?:s|ed|ing)?|extend(?:s|ed|ing)?|grew|grow(?:s|ing)?)\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\s+(?:to|into)\\b"
  + "|(?:waves(?: pest control)?|waveguard)\\s+(?:is |are |can |could |will |do |does |has |have |had )?(?:been )?(?:now |proudly |also |currently |still )?(?:serv(?:e|es|ed)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+|treat(?:s|ed|ing)?|cover(?:s|ed|ing)?|exterminat\\w+|remov(?:e|es|ed|ing)\\b|eliminat\\w+|visit(?:s|ed|ing)?\\b|spray(?:s|ed|ing)?\\b|inspect\\w*|handl\\w+|protect\\w*|get(?:s|ting)? rid of\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|bring(?:s|ing)?\\b|brought\\b|send(?:s|ing)?\\b|sent\\b|dispatch(?:es|ed|ing)?\\b|fertiliz(?:e|es|ed|ing)\\b|maintain(?:s|ed|ing)?\\b|mow(?:s|ed|ing)?\\b|aerat\\w+\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|manag(?:e|es|ed|ing)\\b(?!\\s+to\\b)|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|includ(?:e|es|ed|ing)\\b(?![^.!?]{0,30}\\b(?:data|research|weather|statistics|figures|information|charts?|tables?|topics?|sources?|studies)\\b)|proud to (?:serve|service|treat|cover|protect)\\b|work(?:s|ed|ing)? (?:in|throughout|across|around)|operat(?:es|ed|ing)? (?:in|throughout|across|around))"
  + "|(?:is|are|has been|have been) (?:proudly |now |regularly )?(?:covered|served|serviced|treated|protected|inspected|sprayed|visited|handled|controlled|maintained) by (?:our (?:team|techs?|technicians?|crews?)|waves(?: pest control)?(?:'s|')?)"
  + "|we(?:'re| are) (?:now |also |still |currently )?available (?:in|throughout|across|to|for|near)\\b"
  + `|(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:[\\w']+\\s+){0,2})${SERVICE_KEYWORD_SOURCE}\\s+(?:is|are|can be|may be)\\s+(?:now\\s+)?(?:available|offered|provided|booked|bookable|scheduled|requested|reserved)\\s*(?:to|for|in|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from)\\s+(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b))\\b`,
  'i',
);

// Fabricated-tenure hard gate (owner brand rule — founded 2024): any
// years/decades-of-experience phrasing is a false claim regardless of the
// number. Deterministic backstop to the prompt's BRAND FACTS ban.
const TENURE_CLAIM_RE = /\b(?:over |more than |nearly |almost )?(?:\d{1,2}\+?\s+years?|(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty-five|thirty)\s+years?|a decade|decades?)\s+(?:of\s+)?(?:\w+\s+){0,4}?(?:experience|expertise|know-?how|in business|in the industry|serving\b)/i;
// Company-history fabrications: "serving Sarasota since 2012", "founded in
// 2010", "family-owned since 1998". Scoped to COMPANY context so factual
// regulatory/history copy ("since 2019, Florida has required…") passes.
// Every year EXCEPT 2024 blocks: pre-2024 inflates tenure, post-2024
// ("founded in 2025") is a false company history in the other direction.
// 2024 — the truthful founding year — stays allowed so honest copy
// ("family-owned since 2024") never parks.
const TENURE_SINCE_RE = /\b(?:serving\b[^.!?]{0,40}?|in business\b[^.!?]{0,20}?|family[- ]owned\b[^.!?]{0,20}?|trusted\b[^.!?]{0,30}?|established\b[^.!?]{0,15}?|founded\b[^.!?]{0,15}?)since (?:19\d\d|20[01]\d|202[0-35-9])\b|\b(?:founded|established) in (?:19\d\d|20[01]\d|202[0-35-9])\b/i;

function tenureClaimFinding(text) {
  const s = String(text || '');
  const m = s.match(TENURE_CLAIM_RE) || s.match(TENURE_SINCE_RE);
  if (!m) return null;
  return finding('P0', 'TENURE_CLAIM', `Draft contains a tenure/company-history claim ("${m[0].trim()}") — Waves was founded in 2024; any earlier tenure or founding figure is fabricated (owner hard rule).`);
}

// Disclaimer exemptions come in two scopes. FOOTPRINT-scoped phrases name
// the service area itself and safely exempt a whole clause ("Naples is
// outside our service area"). Bare negated verbs ("don't include") are NOT
// clause-level exemptions — "plans that don't include termite coverage"
// negates a service line, not the footprint — so negation exempts a city
// only when the city itself is the OBJECT of the negated verb (see
// cityNegationRe). Tested on apostrophe-normalized text.
const FOOTPRINT_DISCLAIMER_RE = /\b(outside (?:of )?(?:our|the) (?:(?:service|coverage) )?(?:areas?|footprints?)|(?:not|isn'?t|aren'?t) (?:currently )?(?:in|within|inside|(?:a )?part of|included in|covered by) our (?:(?:service|coverage) )?(?:areas?|footprints?)|(?:not|isn'?t|aren'?t) (?:currently )?(?:a (?:waves(?: pest control)?(?:'s|')? )?(?:service|coverage) area|one of (?:our|waves(?:'s|')?) (?:service|coverage) areas)\b|beyond our (?:(?:service|coverage) )?(?:areas?|footprints?)|our (?:(?:service|coverage) )?(?:areas?|footprints?) (?:excludes?|does not (?:include|extend|reach)|doesn'?t (?:include|extend|reach))\b)\b/i;

// "…does not include Tampa", "we no longer serve Naples" — the negated
// verb's object (within a few words) is this specific city.
// The gap after the negated verb tolerates list separators so every city in
// "we don't serve Naples, Tampa, or Miami" is exempt, not just the first.
// "excludes Naples" and "stops short of Naples" deny service in POSITIVE
// verb form — same honest boundary copy as the do-not forms.
// The gap after the negated verb tolerates comma-separated city lists
// ("we don't serve Naples, Tampa, or Miami") but must NOT cross into a new
// affirmative clause — "We do not serve Naples, we serve Tampa" restates
// service, so the gap refuses a comma followed by a claim subject and
// refuses dashes entirely (a dash splice is a new clause, not a list).
// Replace disclaimer spans with spaces so claim-context tests on a prefix
// never match the disclaimer's own wording (offsets are preserved).
function blankDisclaimers(text, ranges) {
  let out = text;
  for (const [s, e] of ranges) out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
  return out;
}

function cityNegationRe(citySource) {
  return new RegExp(
    `(?:(?:do not|don'?t|does not|doesn'?t|no longer|won'?t|will not|cannot|can'?t|is not|isn'?t|are not|aren'?t|was not|wasn'?t|were not|weren'?t) (?:currently |yet |now |just )?(?:includ(?:e|ing)|cover(?:ing)?|serv(?:e|ing)|servic(?:e|ing)|extend(?:ing)?(?: to| into)?|reach(?:ing)?|treat(?:ing)?|visit(?:ing)?|book(?:ing)?|schedul(?:e|ing)|offer(?:ing)?|provid(?:e|ing)|deliver(?:ing)?)|excludes?|stops? (?:short of|before|at)|(?:is|are|was|were)?\\s*(?:not|never|no longer)\\s+(?:currently\\s+)?(?:available|offered|provided)\\s+(?:in|to|for|near|throughout|across)|unavailable\\s+(?:in|to|for|near|throughout|across)|,\\s*(?:but\\s+)?(?:not|excluding|except)\\b[^.!?;]{0,25}?(?=[^.!?;]{0,5}${citySource})|no (?:need|reason) (?:for\\b(?!(?:\\s+[\\w.-]+){0,4}\\s+to\\s+(?:wait|delay|hesitate|skip|miss|forgo|forego|go without|risk)\\b)|to (?!(?:wait|delay|hesitate|put off|hold off|postpone|rush|skip|miss|forgo|forego|go without|risk|call around|shop around|hunt)\\b)\\w+)(?![^.!?]{0,60}[;,]\\s*(?:just\\s+)?(?:book|schedule|call|order|text)\\b))(?:(?!,\\s*(?:we|our|waves|waveguard|you)\\b|\\s(?:and|but)\\s+(?:you\\s+)?(?:also\\s+)?(?:can\\s+|could\\s+|will\\s+|would\\s+|may\\s+|might\\s+|do\\s+|does\\s+|now\\s+|still\\s+|also\\s+|\\w+ly\\s+){0,2}(?:offer|provid|deliver|serv|treat|cover|exterminat|remov|eliminat|manag|work|operat|book|schedul|visit|spray|inspect|handl|protect|includ|extend|reach|help)|\\s(?:and|but|yet)\\s+(?:is|are|was|were)\\b|\\bto\\s+(?:book|schedul|call|order|get|claim|redeem)\\w*\\b|,\\s*(?:book|schedul|call|order|get)\\w*\\b|,\\s*(?:now\\s+|currently\\s+|also\\s+|still\\s+)?(?:serving|offering|covering|treating)\\b|,\\s*(?=[^.!?]{0,40}\\b(?:is|are)\\s+(?:now\\s+|currently\\s+)?(?:in|part of|one of|available)\\b)|\\b(?:before|when|while|after|if|whenever)\\s+(?:book|schedul|call|order)\\w*\\b|\\sand\\s+[^.!?;]{0,30}?\\b(?:is|are)\\s+(?:now\\s+)?(?:available|offered|provided)\\b|\\b(?:we|our|waves|waveguard)\\s+(?:\\w+\\s+){0,2}?(?:provid|offer|deliver|serv|treat|cover|exterminat|remov|eliminat|manag|work|operat|book|schedul|visit|spray|inspect|handl|protect|get)\\w*\\b)[^.!?;–—]){0,60}?\\b${citySource}|${citySource}\\b[^.!?;|]{0,10}\\|?\\s*not\\s+(?:currently\\s+)?(?:available|offered|served)\\b(?![^|]{0,60}\\b(?:schedul|book)\\w*\\s+(?:(?:your|a|an)\\s+)?(?:pest|mosquito|termite|lawn|service|treatment|visit|appointment|online|now|today)\\b)|(?<!\\b(?:serv(?:e|es|ing|ice|ices|icing)|treat(?:s|ing)?|cover(?:s|ing)?|visit(?:s|ing)?|spray(?:s|ing)?|inspect(?:s|ing)?|protect(?:s|ing)?|handl(?:e|es|ing)|exterminat\\w+|in|throughout|across)\\s+)${citySource}(?:(?!\\b(?:we|our|waves|waveguard)\\b\\s+(?:\\w+\\s+){0,2}?(?:serv|treat|cover|visit|spray|inspect|protect|handl|exterminat|book|schedul|offer|provid|deliver|get)\\w*)[^.!?]){0,40}\\b(?:is|sits|falls|lies) (?:just )?(?:outside|beyond|out of|past|(?:south|north|east|west) of\\b(?=[^.!?]{0,30}\\b(?:our|the)\\s+(?:service\\s+)?(?:area|footprint)\\b))\\b`,
    'i',
  );
}

// Markdown-aware segmentation: blank lines split blocks; marker lines
// (headings, list items, quotes, tables, JSX) are their own segments; and
// consecutive PROSE lines re-join with a space — a soft-wrapped paragraph
// renders as one sentence and must be scanned as one.
// SELF-CLOSING marker lines (headings, JSX tags) are their own segments;
// CONTINUABLE markers (list items, quotes, tables) start a segment that
// absorbs following soft-wrapped lines — markdown renders a wrapped list
// item as one item, and consecutive `>` lines as one quoted paragraph.
const MARKDOWN_SELF_CLOSING_LINE_RE = /^\s*(?:#{1,6}\s|<\/?[A-Za-z])/;
const MARKDOWN_CONTINUABLE_MARKER_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|>\s?|\|)/;

function markdownSegments(body) {
  const segments = [];
  for (const block of String(body || '').split(/\n{2,}/)) {
    let current = '';
    const lines = block.split('\n');
    let inTable = false;
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      const pipeCount = (line.match(/\|/g) || []).length;
      const tableish = (inTable && pipeCount >= 1) || /^\s*\|/.test(line) || pipeCount >= 2
        || (pipeCount === 1 && (/^[\s:|-]+$/.test(line) && line.includes('-')
          || /^[\s:|-]+$/.test(lines[li + 1] || '') && (lines[li + 1] || '').includes('-')
          || /^[\s:|-]+$/.test(lines[li - 1] || '') && (lines[li - 1] || '').includes('-')));
      inTable = tableish;
      if (MARKDOWN_SELF_CLOSING_LINE_RE.test(line) || tableish) {
        if (current) { segments.push(current); current = ''; }
        segments.push(line);
      } else if (MARKDOWN_CONTINUABLE_MARKER_RE.test(line)) {
        if (/^\s*>/.test(line) && /^\s*>/.test(current)) {
          current = `${current} ${line.replace(/^\s*>\s?/, '').trim()}`;
        } else {
          if (current) segments.push(current);
          current = line;
        }
      } else {
        current = current ? `${current} ${line.trim()}` : line;
      }
    }
    if (current) segments.push(current);
  }
  return segments;
}

// Sentence split preserves dotted place abbreviations (St. Petersburg); a
// rare genuine "St."-final sentence merges with the next, which only widens
// the claim scope — fails closed. Clause split mirrors the astro-side gate.
const FOOTPRINT_SENTENCE_SPLIT_RE = /(?<=[.!?])(?<!\bSt\.)(?<!\bFt\.)(?<!\bMt\.)(?<!\b[eE]\.[gG]\.)(?<!\b[iI]\.[eE]\.)(?<!\bvs\.)\s+/;
// Bare adversatives and "and we/our …" split too — the joints where a
// disclaimer half hides an affirmative half. "and" splits ONLY before a
// new we/our subject: a bare ", and" boundary would sever the tail of an
// Oxford-comma object list ("We serve Sarasota, Venice, and Naples").
// "while" splits ONLY before a third-party subject (adversative "…while
// Tampa faces different rules"); temporal "while we treat the lawn" keeps
// the city and the service verb in one clause — splitting there severed
// the exact context the gate evaluates.
// "whether" opens a subordinate question clause — "our customers ask
// whether Naples termites behave differently" carries the demand signal in
// one clause and a factual comparison in the other; splitting keeps the
// blocked city bound to its own (claim-free) clause.
// "whether" splits ONLY after a question/reporting verb ("ask whether…") —
// a trailing scope clause ("we treat your home whether you live in Naples")
// keeps the city bound to its claim verb.
const FOOTPRINT_CLAUSE_SPLIT_RE = /;(?!\s*(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)\s*|\s*[–—]\s*(?=(?:we|our|waves|waveguard)\b|[^.!?]{0,80}\b(?:is|are|was|were|has|have|lies?|sits?|falls?|remains?)\b)|,\s*(?:but(?!\s+also\b(?!\s+(?:we|our|waves|waveguard)\b))(?!\s+(?:we|waves\w*|our\s+\w+)\b[^.!?]{0,40}\b(?:by|on|upon)\s+request\b)(?!\s+(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)|yet|however|though|although|whereas|so(?=\s+(?:we|our|waves|waveguard)\b)|while(?!\s+(?:we|our|waves|waveguard)\b))\s+|\s+(?:but(?!\s+also\b(?!\s+(?:we|our|waves|waveguard)\b))(?!\s+(?:we|waves\w*|our\s+\w+)\b[^.!?]{0,40}\b(?:by|on|upon)\s+request\b)(?!\s+(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)|however|yet|though|although|whereas|while(?!\s+(?:we|our|waves|waveguard)\b)|whether(?<=\b(?:ask|asks|asked|asking|wonder|wonders|wondered|wondering|question|questions|questioned|questioning|debate|debates|debated|debating|unsure|know|knows|knew|check|checks|checked|checking|confirm|confirms|confirmed|confirming|decide|decides|decided|deciding|sure)\s+whether))\s+|(?<!\b(?:is|are|was|were))(?<!,)\s+(?:how|when|where|why)\s+(?=(?:we|our|waves|waveguard)\b)|(?<=^\s*(?:because|since|due to|given that)\b[^,;]{1,80}),\s*(?=(?:we|our|waves|waveguard)\b)|,?\s+and\s+(?=(?:we|our|waves|waveguard)\b)/i;

// "We serve Sarasota; Venice; and Naples." renders as ONE claim list — a
// semicolon before a capitalized continuation (optionally "and"/"or") is a
// list separator, not a clause boundary, so the claim verb must carry across
// it. A semicolon before a new claim subject ("…; We also serve Tampa") or
// lowercase prose still splits. Case-sensitive on purpose: the capital is
// the list-item signal.
// A semicolon whose following fragment is NOTHING BUT list glue (optionally
// "and"/"or" plus capitalized place words and separators) is a list
// separator (a short trailing qualifier like "year-round" is tolerated); a
// fragment with real lowercase prose is a clause and stays split — "We serve Sarasota; Tampa mosquito season starts earlier" must
// NOT glue Tampa onto the claim.
const LIST_FRAGMENT_RE = /^\s*(?!(?:We|Our|Waves|WaveGuard)\b)(?:(?:and|or|nor)\s+|[&/+]\s*|(?!(?:We|Our|Waves|WaveGuard)\b)[A-Z][A-Za-z'’.&-]*[\s,–—-]*(?:(?:[a-z-]+\s+){0,2}?(?:homeowners?|homes?|property owners?|properties|lawns?|yards?|businesses?|neighborhoods?|residents?|customers?|families|areas?|communit(?:y|ies)|markets?|suburbs?|districts?|corridors?|condos?|condominiums?|apartments?|restaurants?|hotels?|offices?|schools?|storefronts?|warehouses?|facilities|clinics?|shops?|stores?|marinas?|resorts?)[\s,]*)*)+(?:(?:year[- ]round|weekly|monthly|quarterly|seasonally|daily|annually|too|as well|and more|included?|covered|every(?:\s+\w+){1,2}|each(?:\s+\w+){1,2}|during(?:\s+\w+){1,2}|in(?:\s+\w+){1,2}|from(?:\s+\w+){1,3}|for(?:\s+\w+){1,3})[\s,]*){0,2}\.?\s*$/;

function rejoinListSemicolons(sentence) {
  const out = [];
  for (const part of String(sentence || '').split(/;(?!\s*(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)\s*/)) {
    if (out.length && LIST_FRAGMENT_RE.test(part)) out[out.length - 1] += `, ${part}`;
    else out.push(part);
  }
  return out;
}

// Glue allowed between a footprint disclaimer and a city it exempts when the
// disclaimer comes FIRST ("Outside our service area: Naples, Fort Myers, and
// Cape Coral."): separators, list connectors, and capitalized place words
// only. Any lowercase verb ("…: Naples, our techs treat Tampa") breaks the
// glue and the trailing city flags. Case-sensitive on purpose.
const DISCLAIMER_LIST_GLUE_RE = /^[\s:;,–—-]*(?:(?:and|or|nor|plus|including|include\b|such as|as well as|as well|too|of|the|is|are|count(?:y|ies)|for now|for the moment|today|currently|at this time|right now|yet|so far|at present)[\s,;:]*|[A-Z][A-Za-z'.&-]*[\s,;:–—-]*)*\.?\s*$/;

// City list BEFORE the disclaimer: "Naples, Fort Myers, Cape Coral, Bonita
// Springs, Estero, and Marco Island are outside our service area." — the
// first city sits far past any fixed window, so the pre-disclaimer
// exemption also accepts an arbitrarily long run of pure list glue plus the
// linking verb between the city and the disclaimer phrase.
const PRE_DISCLAIMER_GLUE_RE = /^[\s,;:]*(?:(?:and|or|nor|all|both|are|is|sit|sits|fall|falls|lie|lies|remain|remains|of|the)\s+|[A-Z][A-Za-z'.&-]*[\s,;:]*)*$/;

// A markdown list item ("- Naples", "2) Venice") — used to re-attach a
// colon-terminated claim intro ("We serve these cities:") to each item.
const LIST_ITEM_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

function offFootprintCityFinding(text) {
  // Link DESTINATIONS are invisible to readers — a blocked city inside a
  // URL is not a rendered claim. Blank them (keeping anchor text) first.
  const s = String(text || '')
    // MDX/HTML comments never render — commented-out copy is not a claim.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Wrapper chars trailing sentence punctuation ("?*" / ".**") hide the
    // sentence end from the splitter — drop them; rendering is unchanged.
    .replace(/([.!?])[*_`]+(\s|$)/g, '$1$2')
    // Same-line HTML FAQ pairs ("…?</h3><p>Yes.") — closing block tags
    // end their segment so question and answer split.
    .replace(/<\/(?:h\d|p|li|blockquote|td|th|tr|div)>/gi, '$&\n')
    // A quoted phrase attributed to a third party (or discussed AS a
    // phrase) is not Waves' own claim — blank the quote content.
    .replace(/((?:(?:(?<!\bas\s)a|(?<!\bas\s)an|another|one|some|that|this|(?<!\bwaves\s+is\s)(?<!\bwe\s+are\s)the)\s+(?:competitor|compan(?:y|ies)|provider|firm)s?|competitors\b|providers\b|(?<!\bour )(?<!\bwe )(?:phrase|wording|term|example)s?)\b[^.!?"\u201c]{0,25}["\u201c])([^"\u201d]{0,120})(["\u201d])(?![^.!?]{0,40}\b(?:and so do we|so do we|we do too|as do we|including us|same here|so does waves)\b)/gi, '$1…$3')
    .replace(/\s(?:href|src)\s*=\s*\"[^\"]*\"/gi, ' ')
    .replace(/\s(?:href|src)\s*=\s*'[^']*'/gi, ' ')
    .replace(/\]\(\s*[^)]*\)/g, '](#)')
    .replace(/https?:\/\/[^\s)\]>"'`]+/gi, '');
  if (!s) return null;
  const cities = outOfAreaCities();
  const cityRes = cities.map((city) => {
    // "St." may be written without the period; multi-word cities may wrap;
    // St. Petersburg matches its local "St. Pete" abbreviation. No "Bay"
    // exemption — "we service Tampa Bay" targets an out-of-footprint region
    // and must flag; factual water-body mentions pass because they carry no
    // claim context (the claim gate does that discrimination).
    // "<Name> County" entries also match the plural-list shorthand "Lee and
    // Collier counties": the bare name counts when a "counties" head
    // follows the (possibly multi-name) list it sits in.
    const countyBase = city.match(/^(.+) County$/);
    const source = city === 'St. Petersburg'
      ? '(?:St\\.?|Saint)\\s+Pete(?:rsburg)?'
      : countyBase
        ? `${escapeRegExp(countyBase[1]).replace(/\\\./g, '\\.?')}(?:\\s+Count(?:y|ies)\\b|(?=(?:(?:\\s*(?:,|and|&|or))+\\s*[A-Z][\\w.-]+)*\\s+count(?:y|ies)\\b))`
        : escapeRegExp(city).replace(/\\\./g, '\\.?').replace(/^Fort/, '(?:Fort|Ft\\.?)').replace(/\s+/g, '\\s+');
    return { city, re: new RegExp(`\\b${source}\\b`, 'gi'), negationRe: cityNegationRe(source) };
  });
  // Markdown segmentation first — blocks/marker lines split, soft-wrapped
  // prose re-joins so a hard-wrapped paragraph is scanned as the one
  // sentence it renders as (the joined meta lines stay separate segments).
  // "We serve these cities:" followed by "- Naples" bullets is ONE rendered
  // claim — the intro carries the service verb, each item carries a city, and
  // neither alone would flag. Re-attach a colon-terminated intro to every
  // following list item; the intro persists across the whole list (blank
  // lines included) and clears at the next non-list prose segment.
  const scanUnits = [];
  let listIntro = '';
  // A table header row carries claim context for every row beneath it
  // ("| Areas we serve |" / "| Naples |") — attach the header to each data
  // row so the claim text and the city are scanned together.
  let tableIntro = '';
  let lastTableRow = '';
  const allSegments = markdownSegments(s);
  for (let segIndex = 0; segIndex < allSegments.length; segIndex += 1) {
    const segment = allSegments[segIndex];
    const trimmed = segment.trim();
    const nextTrimmed = (allSegments[segIndex + 1] || '').trim();
    const sepLike = (t) => /^[\s:|-]+$/.test(t) && t.includes('-');
    if (/^\|.+/.test(trimmed) || (trimmed.includes('|') && (sepLike(nextTrimmed) || sepLike(trimmed) || (tableIntro && (/^\|/.test(trimmed) || (trimmed.match(/\|/g) || []).length >= 2 || !/[.!?]/.test(trimmed)))))) {
      listIntro = '';
      // A row directly above a separator row is the NEXT table's header —
      // never carry a previous table's claim context onto it.
      if (sepLike(nextTrimmed)) {
        tableIntro = '';
        // Multi-question headers pair with their answer row CELL BY CELL —
        // "| Do you serve Naples? | Do you serve Tampa? |" over
        // "| No | Yes |" denies Naples and affirms Tampa.
        {
          const answerRow = (allSegments[segIndex + 2] || '').trim();
          const qCells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
          const aCells = answerRow.split('|').map((c) => c.trim()).filter(Boolean);
          if (/\?/.test(trimmed) && qCells.length > 1 && qCells.length === aCells.length
            && qCells.some((c) => /\?/.test(c))) {
            for (let ci = 0; ci < qCells.length; ci += 1) {
              if (/^(?:\*\*)?(?:yes|sure|definitely|certainly|yeah|indeed|you bet)\b(?![^.!?]{0,40}\b(?:but\s+not\s+(?:from|by|through|with|us|waves)|not\s+from\s+waves|(?:choose|contact|call|try)\s+a\s+local)\b)/i.test(aCells[ci])) {
                scanUnits.push(qCells[ci]
                  .replace(/\b(?:do|does|can|could|will|would)\s+(?:you|your\s+\w+|waves\w*)\s+(?:have|carry)\s+/i, 'we offer ')
                  .replace(/\b(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\s+/i, 'our team ')
                  .replace(/\?/g, ''));
              }
            }
            lastTableRow = trimmed.replace(/\?/g, '');
            continue;
          }
        }
        // A question header over a denial row is a boundary FAQ table —
        // don't scan the question as a standalone claim. Over a YES row it
        // is an affirmative FAQ: rewrite to first person and scan.
        if (/\?/.test(trimmed)
          && /(?:^|\|)\s*(?:\*\*)?(?:no|not (?:served|available|covered|yet)|unavailable|✗|✕)(?:\*\*)?\s*(?:\||$)/i.test((allSegments[segIndex + 2] || '').trim())) {
          lastTableRow = trimmed.replace(/\?/g, '');
          continue;
        }
        if (/\?/.test(trimmed)
          && /(?:^|\|)\s*(?:\*\*)?(?:yes|sure|definitely|certainly|yeah|indeed|you bet)\b(?![^|]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator|option)s?\b)(?![^|]{0,40}\bnot from waves\b)/i.test((allSegments[segIndex + 2] || '').trim())) {
          scanUnits.push(`${trimmed
            .replace(/\b(?:do|does|can|could|will|would)\s+(?:you|your\s+\w+|waves\w*)\s+(?:have|carry)\s+/i, 'we offer ')
            .replace(/\b(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\s+/i, 'our team ')
            .replace(/\b(?:do|does)\s+(?:you|waves\w*)\s+serve\?*\s*/i, 'our team serves ')
            .replace(/\bserved\?*/i, 'our team serves')
            .replace(/\?/g, '')} ${(allSegments[segIndex + 2] || '').trim()}`);
          lastTableRow = trimmed.replace(/\?/g, '');
          continue;
        }
      }
      // A separator row marks the row above it as THIS table's header —
      // that also resets a stale header carried over from a previous
      // table separated only by a blank line.
      if (sepLike(trimmed)) {
        tableIntro = lastTableRow.replace(/\?/g, '');
        continue;
      }
      lastTableRow = trimmed;
      if (!tableIntro) {
        scanUnits.push(segment);
      } else if (/\|\s*(?:\*\*)?(?:yes,?\s+but\s+not\s+(?:from|by|through|with|us|waves)\b[^|]{0,60}|yes[^|]{0,40}\bnot from waves\b[^|]{0,20}|no\s*[,.!;:—–][^|]{0,60}|no|not (?:served|available|covered|yet|included|offered)\b(?:(?!(?:schedul|book)\w*\s+(?:(?:your|a|an)\s+)?(?:pest|mosquito|termite|lawn|service|treatment|visit|appointment|online|now|today)|call\s+(?:waves|us|now|today))[^|]){0,40}|not (?:in|within|currently|part of)\b(?:(?!(?:schedul|book)\w*\s+(?:(?:your|a|an)\s+)?(?:pest|mosquito|termite|lawn|service|treatment|visit|appointment|online|now|today)|call\s+(?:waves|us|now|today))[^|]){0,40}|not a (?:service|coverage) area[^|]{0,20}|unavailable[^|]{0,60}|outside\s+(?:our|the)\b[^|]{0,40}|outside\s+(?:service\s+|coverage\s+)?(?:areas?|footprints?)\b[^|]{0,20}|✗|✕)(?:\*\*)?\s*(?:\||$)/i.test(trimmed)
        || FOOTPRINT_DISCLAIMER_RE.test(trimmed)) {
        // A denial cell ("| Naples | No |") marks the row as boundary
        // status, not a claim — scan the row without the header's claim
        // context.
        // A denial cell only exempts a row with no claim of its own —
        // "| Naples | No, but we visit by request |" keeps its header.
        if (SERVICE_CLAIM_CONTEXT_RE.test(trimmed.replace(/[‘’]/g, "'"))) {
          scanUnits.push(`${tableIntro} ${trimmed}`);
        } else scanUnits.push(trimmed);
      } else {
        scanUnits.push(`${tableIntro} ${trimmed}`);
      }
      continue;
    }
    tableIntro = '';
    if (LIST_ITEM_MARKER_RE.test(segment)) {
      const item = segment.replace(LIST_ITEM_MARKER_RE, '');
      // A bullet that is itself a boundary disclaimer must not inherit the
      // claim intro ("Our service areas:" / "- Naples — outside our
      // service area").
      if (FOOTPRINT_DISCLAIMER_RE.test(item)) {
        scanUnits.push(item);
      } else scanUnits.push(listIntro ? `${listIntro} ${item}` : segment);
    } else {
      listIntro = /:\s*$/.test(segment.trim()) ? segment.trim() : '';
      scanUnits.push(segment);
    }
  }
  const sentences = scanUnits.flatMap((segment) => segment.split(FOOTPRINT_SENTENCE_SPLIT_RE));
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    let sentence = sentences[sentenceIndex];
    // Inline wrappers (bold/italic/code/links) render as plain text — strip
    // them up front so the FAQ question checks see the rendered words.
    const faqProbe = sentence
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_`]+/g, '');
    // A second-person service question answered "Yes" is a rendered claim
    // ("### Do you serve Naples?" / "Yes.") — rewrite the subject to
    // first person so the claim arms see it. DIY questions ("Can you treat
    // your lawn yourself?") stay reader-directed.
    if (/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+|\*\*)?(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\b(?:\b(?:St|Ft|Mt)\.|[^.!?])*\b(?:serv|treat|cover|visit|spray|inspect|protect|handl|exterminat|work|operat|available|run|have|has|carry|offer|provid)\w*(?:\b(?:St|Ft|Mt)\.|[^.!?])*\?\**\s*$/i.test(faqProbe)
      && !/\b(?:yourself|your own|diy)\b/i.test(faqProbe)
      && /^\s*(?:(?:yes|sure|definitely|certainly|yeah|indeed|you bet)\b|absolutely\b|of course\b|yep\b|we (?:do|are|can|sure do|sure can)\b|no,?\s+but\s+(?:we|waves\w*)\s+(?:can|do|will|might)\s+(?:help|assist|try)\b(?![^.!?]{0,30}\b(?:in|near|around|throughout)\s+\w)(?![^.!?]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator|pro(?:fessional)?|option)s?\b)(?![^.!?]{0,40}\breferrals?\b)(?![^.!?]{0,40}\b(?:someone|somebody)\b)(?![^.!?]{0,40}\b(?:find|choose|pick|select)\s+(?:you\s+)?a\s+(?:provider|compan\w*|pro(?:fessional)?)\b)(?![^.!?]{0,40}\b(?:understand|learn|compare|decide|research|identify)\b)|no,?\s+but\s+(?:we|waves\w*)\b[^.!?]{0,40}?\b(?:by request|on request|upon request|if needed|when needed|as needed|case by case)\b|no (?:problem|worries|sweat)\b|no (?:appointment|contract|subscription)s?\s+(?:needed|required|necessary)\b|they (?:do|are)\b)/i.test((sentences[sentenceIndex + 1] || '').replace(/[‘’]/g, "'").replace(/<[^>]+>/g, ' ').replace(/^[\s*_~`>#-]+/, ''))) {
      sentence = faqProbe
        .replace(/\b(?:do|does|can|could|will|would)\s+(?:you|your\s+\w+|waves\w*)\s+(?:have|carry)\s+/i, 'we offer ')
        .replace(/\b(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\s+/i, 'our team ');
    }
    // A boundary FAQ asks about service and then denies it ("Do we serve
    // Naples? No.") — the interrogative sentence is a question, not a
    // claim, when the next sentence opens with a denial.
    // The "No" must be a standalone denial answer ("No." / "No, we…") —
    // affirmative no-prefixed CTAs ("No problem—call today", "No
    // appointment needed") are not denials.
    if (/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+|\*\*)?(?:do|does|did|can|could|will|would|should|is|are|was|were|need|want|looking)\b(?:\b(?:St|Ft|Mt)\.|[^.!?])*\?\**\s*$/i.test(faqProbe)
      && /^\s*(?:no\s*[.,!;:—–-](?!\s*but\b)|no\s+(?:we|unfortunately|sorry|not)\b|no,?\s+but\b(?![^.!?]{0,30}\b(?:can|do|will|might)\s+(?:help|assist|try)\b)(?![^.!?]{0,40}\b(?:by|on|upon)\s+request\b)(?![^.!?]{0,40}\b(?:if|when|as)\s+needed\b)|yes[^.!?]{0,50}\b(?:but\s+not\s+(?:from|by|through|with)\b|but\s+not\s+(?:us|waves)\b|not\s+from\s+waves|(?:but\s+)?(?:choose|contact|call|try)\s+a\s+local)\b|not\b|nope\b|unfortunately\b|sadly\b|we (?:do not|don'?t|cannot|can'?t)|(?:contact|call|try|choose|find|use)\s+(?:a|an|your)?\s*(?:local|nearby|another|different|licensed))/i.test((sentences[sentenceIndex + 1] || '').replace(/[‘’]/g, "'").replace(/<[^>]+>/g, ' ').replace(/^[\s*_~`>#-]+/, ''))) {
      continue;
    }
    // Semicolon list fragments are rejoined first so "We serve Sarasota;
    // Venice; and Naples" scans as one claim clause, while a semicolon
    // followed by real prose stays a clause boundary (rejoinListSemicolons).
    for (const semiUnit of rejoinListSemicolons(sentence)) {
    for (const clause of semiUnit.split(FOOTPRINT_CLAUSE_SPLIT_RE)) {
      // Leading Markdown markers are stripped before the claim test — the
      // claim regex opens with \b, which can never sit before "#", so a
      // heading like "## Naples pest control services" would otherwise
      // bypass the bare-title arm entirely.
      // Inline wrappers (bold/italics/link syntax) render as plain text —
      // unwrap them so "## **Naples pest control services**" and linked
      // titles hit the claim arms like their bare forms.
      const normalized = clause.replace(/[‘’]/g, "'")
        .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/\b_([^_\n]+)_\b/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      if (!SERVICE_CLAIM_CONTEXT_RE.test(normalized)) continue;
      // Footprint disclaimers exempt PER CITY, not per clause: in "Naples is
      // outside our service area, Waves serves Tampa" only Naples (the
      // disclaimer's subject, sitting just before the phrase) is exempt —
      // Tampa still flags.
      // ALL disclaimer occurrences, not just the first — "Naples is outside
      // our service area, and Naples remains outside our service area."
      // repeats the honest disclaimer, and each city occurrence must be
      // evaluated against the disclaimer it belongs to.
      const disclaimerRanges = [...normalized.matchAll(new RegExp(FOOTPRINT_DISCLAIMER_RE.source, 'gi'))]
        .map((m) => [m.index, m.index + m[0].length]);
      // Demand arms bind to their own city. When the clause's ONLY claim
      // context is a demand arm (no core claim once demand spans are
      // blanked), a blocked city must sit INSIDE a demand span — "Our
      // Tampa customers ask…" flags, "Our customers ask about Naples
      // termite research" is a topic mention and does not.
      const demandRanges = [...normalized.matchAll(new RegExp(DEMAND_CONTEXT_SOURCE, 'gi'))]
        .map((m) => [m.index, m.index + m[0].length]);
      const demandOnly = demandRanges.length > 0
        && !SERVICE_CLAIM_CONTEXT_RE.test(blankDisclaimers(normalized, demandRanges));
      // A leading geographic range ("From Sarasota down through Naples, the
      // call is one of the most common we get") attaches to the demand
      // phrase — cities inside that leading range count as demand-bound.
      const leadingRange = demandOnly ? normalized.match(/^\s*(?:from\b[^,;.!?]{0,40}?\b(?:to|through|down to|up to|down through|across to)\b[^,;.!?]{0,20}|between\b[^,;.!?]{0,60}|(?:across|throughout)\b[^,;.!?]{0,60}),/i) : null;
      const leadingRangeEnd = leadingRange ? leadingRange[0].length : 0;
      for (const { city, re, negationRe } of cityRes) {
        // EVERY occurrence of the city is examined, not just the first —
        // "Naples is outside our service area — our techs service Naples
        // homes" repeats the city in an affirmative claim after the honest
        // disclaimer. Negation exemptions are occurrence-scoped the same
        // way: only a city INSIDE the negation match's span is the denial's
        // object; a repeat elsewhere in the clause is its own claim.
        const negationRanges = [...normalized.matchAll(new RegExp(negationRe.source, 'gi'))]
          .map((m) => [m.index, m.index + m[0].length]);
        for (const cityMatch of normalized.matchAll(re)) {
          const cityStart = cityMatch.index;
          const cityEnd = cityStart + cityMatch[0].length;
          if (negationRanges.some(([ns, ne]) => cityStart >= ns && cityEnd <= ne)) continue;
          if (demandOnly && cityEnd > leadingRangeEnd
            && !demandRanges.some(([ds, de]) => cityStart >= ds && cityEnd <= de)) continue;
          if (demandOnly && /\b(?:about|regarding)\s+(?:[\w.-]+\s+){0,2}$/i.test(normalized.slice(0, cityStart))) continue;
          // "drains toward Tampa Bay" names the water body, not the city —
          // exempt only "toward(s)" or a motion/orientation verb governing
          // the preposition. Coverage phrasings keep flagging: "treat homes
          // around Tampa Bay" and "From Tampa Bay to Sarasota, our techs
          // treat…" are operating claims on the Tampa Bay area, and so is
          // bare "We treat Tampa Bay".
          if (/^\s+bay\s+(?:humidity|weather|water|winds?|climate|watershed|estuar\w+|tides?|temperatures?|rainfall|storms?)\b/i.test(normalized.slice(cityEnd))) {
            continue;
          }
          if (/^\s+bay\b/i.test(normalized.slice(cityEnd))
            && /(?:\b(?:toward|towards)\s*$|\b(?:drains?|draining|flows?|flowing|runs?|running|slopes?|sloping|leads?|leading|empties|emptying|points?|pointing|looks?|looking|faces?|facing|overlooks?|overlooking)\s+(?:toward|towards|into|to|at|over|across|near|along|around|off|on|from|of)\s*$)/i.test(normalized.slice(0, cityStart))) {
            continue;
          }
          // City BEFORE a disclaimer: exempt within the close window, or
          // across an arbitrarily long pure-list run ("Naples, Fort Myers,
          // …, and Marco Island are outside our service area."). The
          // long-list glue path additionally requires NO claim context
          // BEFORE the city — in "We serve Naples, and Fort Myers, …, are
          // outside our service area." Naples is the claim verb's object,
          // not part of the disclaimer's subject list.
          // City AFTER a disclaimer (disclaimer-FIRST list form): exempt
          // only while the ENTIRE clause tail after that disclaimer is pure
          // list glue — a lowercase claim continuation re-arms the gate.
          const disclaimed = disclaimerRanges.some(([dStart, dEnd]) => {
            if (cityStart < dStart) {
              // Both pre-disclaimer paths require NO claim context before
              // the city — "We serve Naples, even though Naples is outside
              // our service area" contradicts itself, and the nearby
              // disclaimer must not erase the affirmative claim. The prefix
              // is tested with disclaimer spans blanked so an EARLIER
              // disclaimer's own wording ("…service area…") never reads as
              // claim context ("Naples is outside our service area, and
              // Naples remains outside our service area." stays honest).
              if (SERVICE_CLAIM_CONTEXT_RE.test(blankDisclaimers(normalized, disclaimerRanges).slice(0, cityStart))) return false;
              // The stretch BETWEEN the city and the disclaimer must also
              // be claim-free — "Naples customers use our quarterly pest
              // control, an area outside our service area" carries the
              // claim in that gap and the distance alone must not exempt.
              if (SERVICE_CLAIM_CONTEXT_RE.test(normalized.slice(cityEnd, dStart))) return false;
              // A claim AFTER the disclaimer in the same clause re-arms
              // the city ("— outside our service area, but our techs visit
              // by request").
              {
                const tail = blankDisclaimers(normalized, disclaimerRanges).slice(dEnd);
                if (SERVICE_CLAIM_CONTEXT_RE.test(tail)
                  && !/\b(?:sarasota|bradenton|venice|parrish|palmetto|lakewood ranch|north port|port charlotte|osprey|nokomis|ellenton|myakka)\b/i.test(tail)) return false;
              }
              return dStart - cityEnd <= 60
                || PRE_DISCLAIMER_GLUE_RE.test(normalized.slice(cityEnd, dStart));
            }
            return cityStart >= dEnd && DISCLAIMER_LIST_GLUE_RE.test(normalized.slice(dEnd));
          });
          if (disclaimed) continue;
          return finding('P0', 'OFF_FOOTPRINT_CITY_CLAIM', `Draft makes a service claim naming "${city}", which is outside the Waves service footprint (config/locations CITY_TO_LOCATION). Educational mentions and honest out-of-area disclaimers are fine; service/CTA framing is not.`);
        }
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
// GROUND TRUTH (verified against wavespestcontrol-astro src/content/services
// on 2026-07-22): every service family below has a page for ALL EIGHT
// published cities — including pest-control-services-{city}-fl and every
// specialty slug. Alternation is LONGEST-FIRST so the captured city slug
// never swallows a service suffix. The capture is validated against
// PAGE_CITY_SLUGS below.
const CITY_SERVICE_LINK_RE = /^\/(?:commercial-pest-control|pest-control-services|pest-control-quote|tree-and-shrub-care|palm-tree-injections|termite-inspection|termite-control|mosquito-control|bed-bug-control|rodent-control|lawn-aeration|pest-control|lawn-care)-([a-z][a-z-]*)-fl\/$/;

// City slugs a generated city-service link may target — the cities that
// actually HAVE published city-service pages (astro-publisher SERVICE_AREAS),
// NOT the broader CITY_TO_LOCATION dispatch footprint: service-area towns
// like Oneco or Gibsonton route to an office but have no /pest-control-*-fl/
// page, so a link there is dead even though the town is served.
const PAGE_CITY_SLUGS = new Set([
  'bradenton', 'lakewood-ranch', 'sarasota', 'venice',
  'north-port', 'palmetto', 'parrish', 'port-charlotte',
]);

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
// Arms: markdown destinations, QUOTED href/src, reference definitions, and
// UNQUOTED href/src (legal in HTML — `<a href=/pest-library/fleas/>`).
const RELATIVE_DEST_RE = /\]\(\s*<?\s*(\/[^)\s>]*)|\b(?:href|src)\s*=\s*\{?\s*["'`](\/[^"'`]*)|^[ \t]*\[[^\]^][^\]]*\]:[ \t]+<?(\/[^\s>]*)|\b(?:href|src)\s*=\s*(\/[^\s>"'`]+)/gim;

// EVERY absolute URL in the text — markdown destinations, href/src,
// reference definitions, CommonMark autolinks (<https://…>), and bare GFM
// URLs. Hub-host matches are the dead-route class spelled long-form
// ("https://www.wavespestcontrol.com/pest-library/fleas/" must be policed
// as "/pest-library/fleas/", not waved through by the external gate's host
// allowlist). Other hosts stay the external gate's job.
const HUB_URL_CANDIDATE_RE = /https?:\/\/[^\s)\]>"'`]+/gi;

// Hub PLUS the whole spoke fleet: an absolute URL on any Waves-owned host
// is the dead-route class spelled long-form, and the external gate's host
// allowlist would otherwise wave it through unchecked.
function hubHostSet() {
  const hosts = new Set(['wavespestcontrol.com', 'www.wavespestcontrol.com']);
  try {
    const h = new URL(process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').hostname.toLowerCase();
    const bare = h.replace(/^www\./, '');
    hosts.add(bare); hosts.add(`www.${bare}`);
  } catch { /* defaults above */ }
  for (const key of SPOKE_SITE_KEYS || []) {
    const bare = String(key).toLowerCase().replace(/^www\./, '');
    hosts.add(bare); hosts.add(`www.${bare}`);
  }
  return hosts;
}

// Every internal-route candidate in the text, normalized. Shared by the
// gate and by the refresh grandfathering pass over the prior live body.
function collectInternalDestinations(text) {
  const s = String(text || '');
  const dests = [];
  let m;
  const rel = new RegExp(RELATIVE_DEST_RE.source, RELATIVE_DEST_RE.flags);
  while ((m = rel.exec(s)) !== null) dests.push(m[1] || m[2] || m[3] || m[4]);
  const abs = new RegExp(HUB_URL_CANDIDATE_RE.source, HUB_URL_CANDIDATE_RE.flags);
  const hubHosts = hubHostSet();
  while ((m = abs.exec(s)) !== null) {
    // Bare URLs in prose drag trailing punctuation into the match
    // ("…/contact/, then…") — trim it so a valid allowlisted route never
    // normalizes to "/contact/," and false-parks the draft.
    const raw = m[0].replace(/[),.;:!?'"\]]+$/, '');
    try {
      const u = new URL(raw);
      if (hubHosts.has(u.hostname.toLowerCase())) dests.push(u.pathname || '/');
    } catch { /* malformed URL — the external gate owns it */ }
  }
  const normalized = [];
  for (const dest of dests) {
    // Resolve dot segments FIRST — browsers resolve "/images/../x/" to
    // "/x/", so the /images/ exemption must see the resolved path or a
    // dot-segment link reopens the dead-route class.
    let resolved = dest;
    try { resolved = new URL(dest, 'https://resolve.invalid').pathname || dest; } catch { /* keep raw */ }
    // Anchor-only and in-repo image references are not routes.
    if (resolved.startsWith('/images/')) continue;
    const norm = normalizeInternalPath(resolved);
    if (norm) normalized.push({ dest, norm });
  }
  return normalized;
}

// exemptRouteCounts: refresh grandfathering, by OCCURRENCE COUNT — a refresh
// that preserves one legacy /old/ link must not thereby earn a free pass to
// ADD more links to that dead route; only up to the prior body's count of
// each route is preserved-legacy (see uncatalogedComponentFinding).
function internalRouteFinding(body, allowedInternalLinks = [], exemptRouteCounts = null) {
  const text = String(body || '');
  if (!text) return null;
  const allowed = new Set(ALLOWED_INTERNAL_LINKS);
  for (const link of Array.isArray(allowedInternalLinks) ? allowedInternalLinks : []) {
    // Briefs may mandate a link as an ABSOLUTE hub URL; body occurrences
    // normalize to pathnames, so the allowance must too or it silently
    // never matches.
    let candidate = String(link || '');
    try {
      const u = new URL(candidate);
      if (hubHostSet().has(u.hostname.toLowerCase())) candidate = u.pathname || '/';
    } catch { /* not absolute — use as-is */ }
    const norm = normalizeInternalPath(candidate);
    if (!norm) continue;
    // A brief-supplied CITY-SERVICE link still has to be a real page — a
    // brief bug ("/pest-control-oneco-fl/" for a served town with no page)
    // must not become an allowance for a dead link.
    const allowanceCity = CITY_SERVICE_LINK_RE.exec(norm)?.[1];
    if (allowanceCity && !PAGE_CITY_SLUGS.has(allowanceCity)) continue;
    allowed.add(norm);
  }
  const seenCounts = new Map();
  for (const { dest, norm } of collectInternalDestinations(text)) {
    if (allowed.has(norm)) continue;
    const seen = (seenCounts.get(norm) || 0) + 1;
    seenCounts.set(norm, seen);
    if (exemptRouteCounts && seen <= (exemptRouteCounts.get(norm) || 0)) continue;
    const citySlug = CITY_SERVICE_LINK_RE.exec(norm)?.[1];
    if (citySlug && PAGE_CITY_SLUGS.has(citySlug)) continue;
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
function evaluate(draft, { service = null, primaryKeyword = null, domains = null, operatorFaqException = false, requiredSourceUrls = [], operatorCitations = false, allowedInternalLinks = [], isRefresh = false, priorBody = null } = {}) {
  const body = draft?.body || draft?.content || '';
  const frontmatter = draft?.frontmatter || {};
  const kw = primaryKeyword || frontmatter.primary_keyword || frontmatter.primaryKeyword || null;
  const effectiveDomains = Array.isArray(domains) ? domains : (Array.isArray(frontmatter.domains) ? frontmatter.domains : []);

  // Editable meta strings that publishRefresh / publishOrUpdatePage write onto
  // the (possibly multi-domain) live page. A hardcoded price or literal-brand
  // leak hiding only in metaTitle/metaDescription would otherwise slip past the
  // body-only P0 guards. Mirror astro-publisher's REFRESH_EDITABLE_META_FIELDS.
  // Joined as BLOCKS (blank lines): the markdown-aware scanners re-join
  // consecutive prose lines, so single-newline joins would merge the body's
  // last sentence with the title into one pseudo-sentence.
  // Hero-alt is scanned ONLY on lanes that write it: publishRefresh freezes
  // frontmatter and applies just the title/meta fields, so a refresh draft's
  // hero_image_alt (often a copied or hallucinated echo of the live page)
  // never ships — parking a refresh on findings in it would gate text that
  // will not be committed.
  const editableMeta = ['title', 'metaTitle', 'meta_description', 'metaDescription']
    .concat(isRefresh ? [] : ['hero_image_alt'])
    .map((f) => frontmatter[f])
    .concat(isRefresh ? [] : [frontmatter.hero_image?.alt])
    .filter(Boolean)
    .map(String)
    .join('\n\n');
  const publishableText = editableMeta ? `${body}\n\n${editableMeta}` : body;

  // Refresh grandfathering surface: what the live prior body already
  // carried, by occurrence COUNT — preserving a legacy link/component must
  // not license adding more of it. Built once here; consumed by the two
  // structure gates below.
  const refreshPriorBody = isRefresh && typeof priorBody === 'string' && priorBody.trim() ? priorBody : null;
  const refreshExemptComponents = refreshPriorBody ? collectComponentCounts(refreshPriorBody) : null;
  let refreshExemptRoutes = null;
  if (refreshPriorBody) {
    refreshExemptRoutes = new Map();
    for (const { norm } of collectInternalDestinations(refreshPriorBody)) {
      refreshExemptRoutes.set(norm, (refreshExemptRoutes.get(norm) || 0) + 1);
    }
  }

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
    // Fabricated tenure is a brand hard rule (founded 2024) — deterministic
    // backstop to the writer prompt's BRAND FACTS ban, body AND meta.
    tenureClaimFinding(publishableText),
    // Component + internal-route allowlists are body-structure policies.
    // Refresh drafts GRANDFATHER what the live prior body already carried
    // (legacy links/components the refresh merely preserves must not park
    // it) but writer ADDITIONS are gated exactly like new content. Without
    // a prior body the gates skip — the quality gate's improvement_over_
    // prior check independently refuses to publish such a refresh. Routes
    // surfaced by check_existing_content ride on the draft payload
    // (checked_existing_routes) so the stored-draft revalidation grants the
    // same allowance the original run did.
    // A refresh with NO prior body cannot separate preserved-legacy from
    // writer additions — fail CLOSED (park for review) rather than skipping
    // the structure gates; a transient load failure here must not become a
    // publish window for dead routes or uncataloged components.
    (isRefresh && !refreshPriorBody)
      ? finding('P1', 'REFRESH_PRIOR_BODY_UNAVAILABLE', 'Refresh draft arrived without the live prior body, so the component/internal-route gates cannot grandfather preserved-legacy content — routed to review (fail closed).')
      : uncatalogedComponentFinding(body, refreshExemptComponents),
    (isRefresh && !refreshPriorBody) ? null : internalRouteFinding(body, [
      ...(Array.isArray(allowedInternalLinks) ? allowedInternalLinks : []),
      ...(Array.isArray(draft?.checked_existing_routes) ? draft.checked_existing_routes : []),
    ], refreshExemptRoutes),
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
  PAGE_CITY_SLUGS,
  OUT_OF_AREA_CITY_CANDIDATES,
  outOfAreaCities,
  _internals: { priceFinding, brandTokenFinding, faqBlockedFinding, keywordStuffingFinding, blockedServiceCandidates, BLOCKED_SERVICE_ALIASES, externalLinkFinding, allowedLinkHosts, hostAllowed, curatedCompetitorSourceHosts, OPERATOR_CITATION_HOSTS, productClaimFinding, preventionPromiseFinding, uncatalogedComponentFinding, citationResidueFinding, tenureClaimFinding, offFootprintCityFinding, internalRouteFinding, normalizeInternalPath, CITY_SERVICE_LINK_RE },
};
