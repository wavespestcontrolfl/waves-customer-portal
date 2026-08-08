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

// Blank every span the renderer drops, with spaces — LENGTH- and
// NEWLINE-PRESERVING so callers keep using the original indices and sentence
// boundaries still split.
//
// PROSE attribution must read what a READER SEES, so it blanks comments AND
// tag markup: `class="other companies charge"` is not attribution any
// customer can see (Codex r7), and neither is a comment (r6). TABLE
// attribution deliberately reads the JSX structure (columns/rows props), so
// it gets the comment-blanked text only — blanking tags there would erase the
// very structure it resolves against.
const COMMENT_SPAN_RE = /\{\s*\/\*[\s\S]*?\*\/\s*\}|<!--[\s\S]*?-->/g;
const blankSpan = (span) => span.replace(/[^\n]/g, ' ');
function blankComments(s) {
  return String(s || '').replace(COMMENT_SPAN_RE, blankSpan);
}

// Tag stripping must be QUOTE-AWARE: a `>` inside an attribute value does not
// end the tag, and a naive /<[^>]*>/ left the remainder of that invisible
// attribute in the text — `<span title="x > Orkin charges a"> $89` then read
// as attribution (pre-push Codex P0, r7). An unterminated tag is left alone.
// Tags that START A NEW RENDERED BLOCK — attribution cannot cross one.
const BLOCK_TAG_RE = /^<\/?(?:p|div|section|article|aside|main|header|footer|nav|figure|figcaption|blockquote|pre|hr|br|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|h[1-6])\b/i;

// Enumerate HTML/JSX tags. Quote-aware AND brace-aware: a ">" inside an
// attribute value or a JSX expression prop — title={"x" > "y"} — is not the
// end of the tag, and treating it as one left the rest of the prop in the
// rendered text (Codex r9 P0). ONE scanner serves every consumer below.
function* eachTag(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '<') continue;
    const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(text.slice(i, i + 64));
    if (!m) continue;
    // "<https://…>" is a Markdown AUTOLINK, not a tag named "https" —-
    // treating it as markup cost a legitimate citation its allowance
    // (Codex).
    if (text[i + m[0].length] === ':') continue;
    let j = i + m[0].length;
    let braceDepth = 0;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        j += 1;
        while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
        continue;
      }
      if (ch === '{') { braceDepth += 1; continue; }
      if (ch === '}') { braceDepth -= 1; continue; }
      if (ch === '>' && braceDepth === 0) break;
    }
    if (j >= text.length) return;
    yield {
      start: i, end: j, name: m[2].toLowerCase(), isClose: m[1] === '/',
      attrs: text.slice(i + m[0].length, j),
      selfClosing: text[j - 1] === '/',
    };
    i = j;
  }
}

// An element whose CONTENT a reader may never see. Conservative by design:
// what cannot be proven visible must not supply attribution.
// NATIVELY hidden containers render nothing without any hidden/style/class
// attribute: a <dialog> is closed unless it carries `open`, and <datalist>
// content is never prose (Codex).
const HIDDEN_TAGS = new Set(['template', 'script', 'style', 'noscript', 'datalist']);

// Visibility is decided by what can be PROVEN from the source, and anything
// unprovable counts as hidden. Chasing literal forms lost three rounds in a
// row — `display:none`, then style={{display:"none"}}, then
// aria-hidden={1===1} and {"no"+"ne"} — because a static reader cannot
// evaluate expressions at all. So: a visibility-affecting prop whose value is
// an EXPRESSION is treated as hidden outright, no evaluation attempted
// (Codex r9 P0 ×3). The cost is only a lost EXEMPTION — the price is still
// flagged, which is the safe direction.
// DEFINITELY not rendered — used by the VETO, which must err toward KEEPING
// text. The broad "any styling is unprovable" rule below is right for
// ATTRIBUTION (excluding text costs an exemption) but backwards here:
// erasing styled copy would delete a first-party marker and GRANT the
// exemption. Only certainties qualify (Codex).
function opensDefinitelyHidden(tag) {
  if (HIDDEN_TAGS.has(tag.name)) return true;
  const a = tag.attrs || '';
  if ((tag.name === 'dialog' || tag.name === 'details') && !/(?:^|\s)open(?=[\s=>/]|$)/i.test(a)) return true;
  if (/(?:^|\s)hidden(?=[\s=>/]|$)/i.test(a)) return true;
  const ariaM = /aria-hidden\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*'|[^\s>]+)/i.exec(a);
  if (ariaM) {
    const v = ariaM[1].replace(/^[{"']|["'}]$/g, '').trim().toLowerCase();
    if (v !== 'false') return true;
  }
  return /style\s*=\s*(?:["'`{])[^"'`]*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a);
}

function opensHiddenContent(tag) {
  if (HIDDEN_TAGS.has(tag.name)) return true;
  const a = tag.attrs || '';
  if ((tag.name === 'dialog' || tag.name === 'details') && !/(?:^|\s)open(?=[\s=>/]|$)/i.test(a)) return true;
  if (/(?:^|\s)hidden(?=[\s=>/]|$)/i.test(a)) return true;
  // aria-hidden in ANY form except a literal false.
  const ariaM = /aria-hidden\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*'|[^\s>]+)/i.exec(a);
  if (ariaM) {
    const v = ariaM[1].replace(/^[{"']|["'}]$/g, '').trim().toLowerCase();
    if (v !== 'false') return true;
  }
  // ANY styling or class makes visibility unprovable from source. Enumerating
  // hidden CSS is a losing game — display:none, visibility:hidden, opacity:0,
  // clip, font-size:0, transparent color, a `.hidden` utility class — so for
  // ATTRIBUTION ELIGIBILITY the rule is inverted: only unstyled, unclassed
  // markup counts as proven-visible (Codex r9 P0 ×4). The cost is a lost
  // EXEMPTION on styled attribution, which parks the draft for review — the
  // safe direction. Detection is unaffected.
  if (/(?:^|\s)(?:style|class|className)\s*=/i.test(a)) return true;
  return false;
}

// NESTING-AWARE: a regex stopping at the first </span> left the tail of a
// hidden block visible (Codex r9 P0). Walk to the MATCHING close tag.
function blankHiddenContent(str) {
  const text = String(str || '');
  const out = text.split('');
  const tags = [...eachTag(text)];
  for (let t = 0; t < tags.length; t += 1) {
    const tag = tags[t];
    if (tag.isClose || tag.selfClosing || !opensHiddenContent(tag)) continue;
    let depth = 1;
    let endIdx = -1;
    for (let u = t + 1; u < tags.length; u += 1) {
      const other = tags[u];
      if (other.name !== tag.name || other.selfClosing) continue;
      if (other.isClose) { depth -= 1; if (depth === 0) { endIdx = other.end; break; } }
      else depth += 1;
    }
    // Never closed → blank to end: unterminated hidden content cannot be
    // proven visible either.
    const stop = endIdx === -1 ? text.length - 1 : endIdx;
    for (let k = tag.start; k <= stop; k += 1) if (out[k] !== '\n') out[k] = ' ';
  }
  return out.join('');
}

function blankTags(s) {
  const text = String(s || '');
  const out = text.split('');
  for (const tag of eachTag(text)) {
    const isBlock = BLOCK_TAG_RE.test(text.slice(tag.start, tag.end + 1));
    for (let k = tag.start; k <= tag.end; k += 1) if (out[k] !== '\n') out[k] = ' ';
    // A BLOCK-level tag is a rendered boundary; a newline keeps the blanking
    // length-preserving while still splitting the sentence (Codex r8).
    if (isBlock && out[tag.start] !== '\n') out[tag.start] = '\n';
  }
  return out.join('');
}

// MDX EXPRESSION containers render conditionally and their value cannot be
// proven statically, so `{show && "Orkin charges a"}` never counts as
// visible attribution (Codex r9 P0). Quote-aware and balanced.
function blankExpressions(str) {
  const text = String(str || '');
  const out = text.split('');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        j += 1;
        while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) break; }
    }
    if (j >= text.length) break; // unbalanced — leave the rest alone
    for (let k = i; k <= j; k += 1) if (out[k] !== '\n') out[k] = ' ';
    i = j;
  }
  return out.join('');
}

// A Markdown link's DESTINATION is not rendered text — readers see only the
// anchor. Leaving the URL in place let an invisible "…/Orkin" supply the
// attribution for a visible local price (Codex r9 P0). Blank the brackets and
// the destination, keep the anchor where it is, length-preservingly.
// A Markdown link's DESTINATION is not rendered text — readers see only the
// anchor. Leaving the URL in place let an invisible ".../Orkin" attribute a
// visible local price (Codex r9 P0). A regex could not do this: labels nest
// brackets and destinations carry balanced parens, and a partial match left
// the tail of the URL behind as attributable text. This is a balanced,
// escape-aware scanner; anything malformed blanks WHOLE so no fragment of it
// can attribute.
function blankMarkdownLinkDestinations(str) {
  // REFERENCE links render only their label: "[Local plan][1]" plus a
  // "[1]: https://…/Orkin" definition showed readers a local price while the
  // invisible definition supplied the attribution (Codex r10). Blank the
  // definition lines and the "[ref]" tails; labels stay where they are.
  const text = String(str || '')
    .replace(/^[ \t]*\[[^\]\n]+\]:[^\n]*/gm, blankSpan)
    .replace(/\]\s*\[[^\]\n]*\]/g, blankSpan);
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k <= to && k < text.length; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '[') continue;
    const isImage = i > 0 && text[i - 1] === '!';
    // Balanced label scan.
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '\\') { j += 1; continue; }
      if (ch === '[') depth += 1;
      else if (ch === ']') { depth -= 1; if (depth === 0) break; }
      else if (ch === '\n' && text[j + 1] === '\n') break; // paragraph end
    }
    if (j >= text.length || text[j] !== ']' || text[j + 1] !== '(') continue;
    const labelStart = i;
    const labelEnd = j;
    // Balanced destination scan.
    let k = j + 1;
    let pdepth = 0;
    for (; k < text.length; k += 1) {
      const ch = text[k];
      if (ch === '\\') { k += 1; continue; }
      if (ch === '(') pdepth += 1;
      else if (ch === ')') { pdepth -= 1; if (pdepth === 0) break; }
      else if (ch === '\n' && text[k + 1] === '\n') break;
    }
    if (k >= text.length || text[k] !== ')') {
      // Malformed: blank everything we scanned so no fragment attributes.
      blank(isImage ? labelStart - 1 : labelStart, Math.min(k, text.length - 1));
      i = Math.min(k, text.length - 1);
      continue;
    }
    if (isImage) {
      blank(labelStart - 1, k); // an image renders no text at all
    } else {
      blank(labelStart, labelStart);       // "["
      blank(labelEnd, k);                  // "](destination)"
    }
    i = k;
  }
  return out.join('');
}

function blankToRenderedText(s) {
  return blankExpressions(blankMarkdownLinkDestinations(blankTags(blankHiddenContent(blankComments(s)))));
}

// A cited competitor price must actually BE cited. The grammar alone —
// party plus pricing verb — let "Other companies charge a $199 cancellation
// fee" through with no source and no date, which is an invented figure as
// far as the reader is concerned (Codex). The manifest's global rule is
// "all dollar figures re-verified at publish + dated in-post ('as of
// [date]')", so the amount's paragraph must carry BOTH a citation link and a
// date. Absent either, the draft parks for review.
// The date must be GOVERNED by "as of" — a bare "June 2026 was rainy" is not
// a verification date, and accepting one let a stale price publish (Codex).
const AS_OF_DATE_RE = /\bas of\b[^.\n]{0,40}?\b(?:19|20)\d{2}\b/i;
// Hosts that can EVIDENCE a claim: the curated citation list, curated
// competitor-fact sources, and editorially-approved external domains. Our own
// hub and spoke domains are deliberately absent.
function citationOnlyHosts({ operatorCitations = false } = {}) {
  const hosts = new Set();
  for (const d of String(process.env.CONTENT_ALLOWED_LINK_DOMAINS || '').split(',')) {
    const h = normalizeHost(d);
    if (h) hosts.add(h);
  }
  if (operatorCitations) {
    for (const h of OPERATOR_CITATION_HOSTS) hosts.add(normalizeHost(h));
    for (const h of curatedCompetitorSourceHosts()) hosts.add(h);
  }
  return hosts;
}

// URLs a READER can actually follow from this paragraph. An image
// destination and an UNUSED reference definition are both stripped from the
// rendered page, so neither is a citation — accepting them let an unrelated
// "![image](…)" or a dangling "[unused]: …" stand in for the source (Codex).
function visibleCitationUrls(citationParaRaw, renderedPara, citationDoc) {
  // A code span renders literal text, not a link, and "\[" is an escaped
  // bracket — neither produces something a reader can click, so neither is a
  // citation (Codex). Blanked length-preservingly so offsets are unaffected.
  const citationPara = String(citationParaRaw || '')
    .replace(/(`+)(?:[^`]|(?!\1)`)*\1/g, blankSpan)
    .replace(/\\[[\]()]/g, '  ');
  const out = [];
  const push = (u) => { if (u) out.push(String(u).replace(/[).,;:!?]+$/, '')); };
  // Inline links — NOT images.
  const inline = /(!)?\[[^\]\n]*\]\(\s*<?\s*(https?:\/\/[^)\s>]+)/g;
  let m;
  while ((m = inline.exec(citationPara)) !== null) { if (!m[1]) push(m[2]); }
  // Autolinks and bare URLs the reader sees in the rendered text.
  const bare = /https?:\/\/[^\s<>()"'\]]+/gi;
  while ((m = bare.exec(renderedPara)) !== null) push(m[0]);
  // Reference LINKS resolve to their definition; reference IMAGES do not.
  // Full "[text][ref]", COLLAPSED "[ref][]" and SHORTCUT "[ref]" — the last
  // two carry the label in the FIRST bracket, so reading only the second one
  // parked compliant intercepts on formatting alone (Codex).
  const refUse = /(!)?\[([^\]\n]*)\](?:\[([^\]\n]*)\])?/g;
  const usedRefs = new Set();
  while ((m = refUse.exec(citationPara)) !== null) {
    if (m[1]) continue; // image
    if (citationPara[m.index + m[0].length] === '(') continue; // inline link
    // A DEFINITION line ("[label]: https://…") is not a use of itself —
    // counting it made a dangling definition self-referencing (Codex).
    if (citationPara[m.index + m[0].length] === ':') continue;
    const label = ((m[3] || '').trim() || (m[2] || '').trim());
    if (label) usedRefs.add(label.toLowerCase());
  }
  if (usedRefs.size) {
    // Definitions are conventionally collected at the END of the document,
    // so they are looked up DOC-WIDE — only the reference USE has to sit in
    // the price's paragraph (Codex).
    const defs = /^[ \t]*\[([^\]\n]+)\]:[ \t]*(https?:\/\/\S+)/gm;
    while ((m = defs.exec(citationDoc)) !== null) {
      if (usedRefs.has(m[1].trim().toLowerCase())) push(m[2]);
    }
  }
  return out;
}

// Reads RENDERED text: a date or URL parked in a comment or a reference
// definition is invisible to the customer and cannot satisfy a sourcing
// rule that exists for their benefit (Codex).
function priceParagraphIsSourced(citationText, renderedText, index, opts = {}) {
  // SENTENCE scope, not paragraph. A citation anywhere in the paragraph let
  // an unrelated link — a chinch-bug study next to a competitor fee —
  // authorize the price (Codex). The briefs' own mandated shape puts the
  // source in the sentence: "Aptive charges a $199 fee as of July 2026
  // ([source](…))." Reference DEFINITIONS are still resolved doc-wide.
  const para = (text) => sentenceAround(String(text || ''), index).text;
  // The URL comes from text with link DESTINATIONS intact — rendered text
  // blanks them, so an ordinary "[ConsumerAffairs](https://…)" citation
  // could never qualify (Codex). Hidden content is still blanked there, so
  // a URL buried in a comment does not count. The DATE must be rendered.
  // The URL must be a CITATION the gate would actually accept — an
  // allowlisted host or a source this brief named. Any-URL-will-do let an
  // unrelated link stand in for the source (Codex).
  // CITATION hosts only. allowedLinkHosts also carries every hub and spoke
  // domain — navigation destinations, not third-party evidence — so a link
  // to our own calculator was standing in as the source for a competitor's
  // price (Codex).
  const allowedHosts = citationOnlyHosts(opts);
  const exact = allowedExactSourceUrls(opts.requiredSourceUrls);
  const urls = visibleCitationUrls(para(citationText), para(renderedText), String(citationText || ''));
  const cited = urls.some((u) => {
    const raw = u.replace(/[).,;:!?]+$/, '');
    if (exact.has(normalizeSourceUrl(raw) || '\u0000')) return true;
    try { return hostAllowed(normalizeHost(new URL(raw).hostname), allowedHosts); } catch { return false; }
  });
  if (!cited) return false;
  return AS_OF_DATE_RE.test(para(renderedText));
}

// Any markup in the amount's paragraph disqualifies the prose exemption.
// Blunt by design: "<" opens a tag or comment, "{" an MDX expression, "&"
// an entity. Over-matching costs an exemption; under-matching publishes a
// first-party price.
function paragraphHasMarkup(text, index) {
  const s = String(text || '');
  const start = (() => { const i = s.lastIndexOf('\n\n', index); return i === -1 ? 0 : i + 2; })();
  const rawEnd = s.indexOf('\n\n', index);
  const paragraph = s.slice(start, rawEnd === -1 ? s.length : rawEnd);
  // Deletion markup is not an affirmative statement: "~~Other companies
  // charge~~ $89 per visit" leaves the price as the operative claim (Codex).
  // The semantic ELEMENTS say the same thing and carry no attributes, so the
  // attribute-free allowance below would otherwise wave them through.
  if (/~~/.test(paragraph)) return true;
  if (/<\s*(?:del|s|strike)\b/i.test(paragraph)) return true;
  if (/\{|&[#A-Za-z]|<!/.test(paragraph)) return true; // expression, entity, comment
  // A tag with NO attributes cannot hide anything — it carries no hidden,
  // style, class or aria-hidden — so plain wrappers like <p> and <strong>
  // still allow the exemption. ANY attribute makes visibility unprovable
  // and disqualifies the paragraph.
  for (const tag of eachTag(paragraph)) {
    if ((tag.attrs || '').replace(/\/\s*$/, '').trim()) return true;
  }
  return false;
}

// True when the amount sits on a Markdown table row. Deliberately blunt: a
// pipe anywhere on the line disqualifies the line from the PROSE exemption.
// Over-matching only costs an exemption (the draft parks); under-matching
// would publish a first-party price.
function isMarkdownTableRow(text, index) {
  const s = String(text || '');
  const start = s.lastIndexOf('\n', index - 1) + 1;
  let end = s.indexOf('\n', index);
  if (end === -1) end = s.length;
  return s.slice(start, end).includes('|');
}

// …and the same for HTML/JSX table markup, which carries no pipes:
// "<table><tr><td>Orkin charges a $199 fee.</td></tr></table>" is a table,
// and the ruling is that EVERY table price fails closed. Walks the tag
// stream and reports whether a table element is still open at the amount.
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'comparisontable']);
function isInsideTableMarkup(text, index) {
  let depth = 0;
  // Comment-blanked: a comment containing "</td></tr></table>" is not a set
  // of real closures, and counting it dropped the depth to zero while the
  // browser kept the price inside the table (Codex).
  for (const tag of eachTag(blankComments(String(text || '')))) {
    // Inside a table tag's OWN span — the props of a self-closing
    // <ComparisonTable … /> hold its cells, so an amount there is in a table
    // even though no element is open around it (Codex).
    if (TABLE_TAGS.has(tag.name) && index >= tag.start && index <= tag.end) return true;
    if (tag.start >= index) break;
    if (!TABLE_TAGS.has(tag.name) || tag.selfClosing) continue;
    if (tag.isClose) depth = Math.max(0, depth - 1);
    else depth += 1;
  }
  return depth > 0;
}

/**
 * findHardcodedPrice(text) → the offending price string, or null. Applies the
 * calculator/quote-framing and regulatory-fine exemptions, so callers share
 * ONE price policy. Exported for seo-completion-gate (its previous private
 * copy had drifted: no comma support, no regulatory exemption).
 */
function findHardcodedPrice(text, { thirdPartyCitations = false, forbidAllPrices = false, operatorCitations = false, requiredSourceUrls = [] } = {}) {
  const s = String(text || '');
  // Attribution is decided against what READERS SEE. Comments and tag
  // attributes are stripped at render, so "{/* other companies charge */} $89
  // per visit" and `<span class="other companies charge">$89 …</span>` both
  // showed the customer a bare first-party price while the guardrail read an
  // exemption (Codex r6/r7). Detection still runs on the original text — a
  // price hidden in markup stays flagged (conservative in both directions).
  const proseText = blankToRenderedText(s);
  // Link destinations intact, hidden content still gone — used only to look
  // for the citation URL behind the price.
  const citationText = blankTags(blankHiddenContent(blankComments(s)));
  const priceRe = new RegExp(PRICE_RE_SRC, 'gi');
  let match;
  while ((match = priceRe.exec(s)) !== null) {
    const window = s.slice(Math.max(0, match.index - 80), Math.min(s.length, match.index + 120));
    // Allowed when the surrounding copy points at the calculator / quote / a
    // "varies" framing rather than asserting a hard price.
    // A brief-level BAN outranks every exemption below. B2/D1 say "NO
    // TruGreen dollar amounts ANYWHERE in the post", and the seeder's own
    // global instruction tells writers to add "though pricing varies by
    // contract" — which landed exactly on this generic-framing exemption and
    // made the ban a no-op (Codex). Nothing is exempt under a ban.
    if (forbidAllPrices) return match[0].trim();
    // Allowed when the surrounding copy points at the calculator / quote / a
    // "varies" framing rather than asserting a hard price. NOT on an
    // intercept draft: those are exactly the posts that quote competitor
    // figures, and the framing words let one through unsourced, straight
    // past the source-and-date requirement (Codex).
    if (!thirdPartyCitations
      && /\b(calculator|estimate|quote|pricing varies|depends|range)\b/i.test(window)) continue;
    // Regulatory fines are not Waves service pricing. Allow ordinance/citation
    // contexts while still blocking customer-facing service price claims.
    if (isRegulatoryPenaltyAmount(match[0].trim(), window)) continue;
    // A price ATTRIBUTED to a named competitor is reporting, not our price
    // list (owner ruling 2026-08-01) — "cancel your pest control contract"
    // posts have to name the other company's cancellation fee to be useful.
    //
    // PROSE ONLY. A table-cell exemption was built and then REMOVED (owner
    // ruling 2026-08-01, second): deciding ownership inside Markdown/JSX
    // tables meant re-implementing a renderer here, and ~20 review rounds
    // each found another construct that could launder a first-party price
    // through it (entities, emphasis, inline tags, comments, reference
    // links, hidden/styled/computed-visibility markup, spoofed props,
    // code-span pipes). A price in a table now fails closed exactly as it
    // does on main. The cost is small: a named-competitor post routes to
    // human review anyway while GATE_NAMED_COMPETITOR_COMPARISON is off, so
    // the table path was buying a parked draft a second look it already got.
    // Scoped to the amount's OWN SENTENCE, not the surrounding window: a
    // competitor named in a neighbouring sentence must never launder our
    // price ("Orkin is expensive. Quarterly pest control is $129.").
    // OPERATOR-PROVENANCE ONLY (same boundary as the .gov/.edu citation
    // allowance): mined drafts compose from untrusted SERP/PAA text, and an
    // injected "other companies charge $X" attribution must not publish an
    // arbitrary price — the exemption exists for operator-directed
    // competitor-intercept briefs, so only they get it.
    // match.index sits on the captured LEADING character (possibly a
    // newline/quote) — the token index must point at the amount itself or
    // a boundary at that exact position is skipped by the >= scan
    // ("## Other companies charge\n$89 …" read as one sentence, Codex r4).
    const tokenIndex = match.index + (match[1] ? match[1].length : 0);
    // PROSE ONLY, enforced here: a pipe on the amount's line means a Markdown
    // table row, and the prose scanner would otherwise read the cell
    // boundaries as ordinary spacing and exempt "| Aptive charges a | $199 |"
    // (Codex). JSX tables already fail closed because blankToRenderedText
    // blanks the whole <ComparisonTable …> tag out of the attribution text.
    // The exemption requires PLAIN PROSE. Any markup in the amount's
    // paragraph — a tag, an MDX expression, a comment, an entity —
    // disqualifies it outright.
    //
    // This replaces a normalization approach that tried to compute what a
    // reader sees. That direction does not terminate: every construct is
    // two bugs, one where invisible text ATTRIBUTES a price and one where
    // it SPLITS the first-party marker that should block it, and the two
    // want opposite handling. Requiring plain prose closes both at once.
    // The cost is only a lost exemption — a sourced competitor price in a
    // marked-up paragraph parks for review, and sourced price sentences are
    // plain prose in practice.
    if (thirdPartyCitations
      && !isMarkdownTableRow(s, tokenIndex)
      && !isInsideTableMarkup(s, tokenIndex)
      && !paragraphHasMarkup(s, tokenIndex)
      && priceParagraphIsSourced(citationText, proseText, tokenIndex, { operatorCitations, requiredSourceUrls })
      && isThirdPartyPriceCitation(proseText, tokenIndex, s)) continue;
    return match[0].trim();
  }
  return null;
}

function priceFinding(body, opts = {}) {
  const hit = findHardcodedPrice(body, opts);
  if (!hit) return null;
  return finding('P0', 'HARDCODED_PRICE', `Body contains a hardcoded price ("${hit}") with no calculator/quote framing nearby — link to /pest-control-calculator/ instead.`);
}

// Third-party price attribution (owner ruling 2026-08-01). A dollar figure
// is reporting — not a Waves price claim — when the surrounding copy names
// WHOSE price it is and that party isn't us. Two ways to qualify:
//   1. a curated competitor brand name / alias sits in the window, or
//   2. a generic third-party framing ("other companies charge…", "the
//      previous provider's fee").
// First-person framing anywhere in the window disqualifies it outright, so
// "we charge $199" can never ride in on a competitor mention elsewhere in
// the sentence. Waves prices stay banned everywhere — link the calculator.
// ANY first-person / Waves marker in the price's sentence disqualifies the
// exemption outright — no verb list to keep in sync (the earlier
// charge|price|fee list missed "is", "starts at", "bill", "offers"), and a
// sentence that mentions us AND a dollar figure is a Waves price claim
// regardless of phrasing: "Our quarterly service is $89, unlike Orkin."
// Brand TEMPLATE TOKENS count as first-party: spoke-shared copy never
// writes "Waves" literally, it writes {{brandName}} (pre-push Codex P0 —
// "Unlike Orkin, {{brandName}} charges $89" must stay blocked).
// "us" is CASE-SENSITIVE lowercase: "US" is the country ("In the US, Aptive
// charges…") and must not read as first-person (Codex r2 P2). Everything
// else stays caseless.
const FIRST_PARTY_CI_RE = /\b(we|we're|our|ours|i|i'm|i've|my|mine|myself|waves|waveguard)\b|\{\{\s*(?:brand|site|company)[a-zA-Z]*\s*\}\}/i;
const FIRST_PARTY_US_RE = /\bus\b/;
function hasFirstPartyMarker(sentence) {
  return FIRST_PARTY_CI_RE.test(sentence) || FIRST_PARTY_US_RE.test(sentence);
}

// Clause boundaries INSIDE a sentence: punctuation plus contrast/coordination
// conjunctions. A competitor named in a DIFFERENT clause does not own the
// amount (pre-push Codex P0 — "Orkin charges too much, but quarterly pest
// control is $129 per application").
// COORDINATING conjunctions (and/or/plus) split too: they introduce a new
// subject, and "Orkin charges too much and quarterly pest control costs
// $129" must not let the Orkin predicate own the second amount (pre-push
// Codex P0). Splitting here only ever NARROWS the exemption.
const CLAUSE_SPLIT_RE = /[,;:—–]|\b(?:but|while|whereas|however|though|although|yet|meanwhile|and|or|plus)\b/gi;
// Explicit third-party SUBJECTS only. Deliberately excludes vague nouns like
// "the industry" or "a typical charge" — those describe a market, not a party
// that owns a price, and they let ordinary marketing copy through
// ("The industry-leading quarterly plan costs $129" — pre-push Codex P0).
const GENERIC_THIRD_PARTY_RE = /\b(competitors?|other (?:companies|providers|firms)|national (?:chains?|companies|brands?)|big(?:-| )box (?:companies|chains?|providers?)|another company|(?:previous|current|prior|former|existing) (?:provider|company|contractor|exterminator)|most (?:companies|providers)|many (?:companies|providers)|industry average)\b/i;

// A third party OWNS the amount only in an explicit pricing construction —
// naming them earlier in the clause is not enough ("Avoid Orkin by choosing
// quarterly pest control for $129" — pre-push Codex P0). Two shapes, both
// requiring the third party to be the SUBJECT:
//   (A) <party> …short filler… <pricing verb> … $amount
//       "Orkin charges a $199 fee", "other companies typically charge $25"
//   (B) <party>'s <price noun> is/was/starts at … $amount
//       "Orkin's cancellation fee is $199"
// Bare copulas ("is"/"are") are NOT accepted in shape A: "Orkin is expensive
// and quarterly pest control is $129" must stay blocked.
const PRICING_VERB_RE = /^(?:charges?|charged|bills?|billed|lists?|listed|quotes?|quoted|asks?|wants?|sets?|advertises?|prices?|priced|costs?|runs?|reports?|collects?|adds?)$/i;
// WHITELIST, not a blocklist: every token between the third-party subject
// and the amount must be either the pricing verb (once) or an innocuous
// determiner/quantifier/price noun. Anything unexpected — a subordinating
// conjunction, a second subject, another verb — rejects the exemption by
// construction, which is what ends the "one more conjunction" arms race
// ("Orkin charges too much because the standard rate is $129" — pre-push
// Codex P0).
// NOTE: no price NOUNS here (price/cost/charge/rate/pricing). They double as
// verbs, which let a SECOND predicate ride through as filler — "Orkin reports
// the quarterly plan costs $129" (pre-push Codex P0). Only the amount's own
// trailing noun ("fee") and neutral determiners/quantifiers qualify.
const PRICE_FILLER_WORD_RE = /^(?:a|an|the|about|around|approximately|roughly|nearly|almost|up|to|as|only|just|its|their|his|her|your|new|typical|typically|usual|usually|generally|often|standard|average|annual|monthly|quarterly|yearly|initial|first|one-time|onetime|early|cancellation|termination|contract|treatment|visit|plan|plans|fee|fees|minimum|customer|customers|client|clients|homeowner|homeowners|may|might|can|could|will|would|still|reportedly|both|per|of|from|at|near|flat|extra|additional)$/i;
const MAX_ATTRIBUTION_TOKENS = 8;

// RIGID TEMPLATE, deliberately small: the pricing verb must be the FIRST
// token after the party (one optional modal/adverb), and only determiners or
// hedges may sit between that verb and the amount. Eight adversarial review
// rounds established that anything looser leaves room for a second subject
// or predicate to slip in and launder a Waves price — so the accepted
// language is a closed set ("Orkin charges a $199 fee", "other companies may
// bill up to $25"), not "a pricing verb somewhere nearby". Sentences the
// template rejects are still publishable, just rephrased into this shape.
const PRE_VERB_MODIFIER_RE = /^(?:may|might|can|could|will|would|often|typically|usually|generally|reportedly|also|still|now|both|each|all|generally)$/i;
const POST_VERB_MODIFIER_RE = /^(?:a|an|the|its|their|your|about|around|approximately|roughly|nearly|almost|up|to|as|much|as-much-as|only|just|from|over|under|another|one|each|per|flat|extra|additional|new|standard|typical|average|annual|monthly|quarterly|yearly|initial|first|one-time|onetime|early|cancellation|termination|contract|treatment|visit|plan|service)$/i;

function attributionBindsToAmount(between) {
  const tokens = String(between || '').replace(/^(?:'s|’s)/, ' ').split(/\s+/)
    .map((t) => t.replace(/[^\w'-]/g, ''))
    .filter(Boolean);
  if (!tokens.length || tokens.length > MAX_ATTRIBUTION_TOKENS) return false;
  let i = 0;
  // At most two pre-verb modifiers ("may", "typically").
  let modifiers = 0;
  while (i < tokens.length && PRE_VERB_MODIFIER_RE.test(tokens[i])) {
    if (++modifiers > 2) return false;
    i += 1;
  }
  if (i >= tokens.length || !PRICING_VERB_RE.test(tokens[i])) return false;
  i += 1;
  // Everything remaining must be a determiner/hedge or an earlier amount in
  // a range ("from $49 to $99", "between $49 and $99" — Codex r2 P1) — no
  // second verb, no second subject.
  for (; i < tokens.length; i += 1) {
    if (POST_VERB_MODIFIER_RE.test(tokens[i])) continue;
    if (/^\$?[\d,.]+$/.test(tokens[i])) continue;
    if (/^(?:between|and)$/i.test(tokens[i])) continue;
    return false;
  }
  return true;
}
// The price noun must be DIRECTLY governed by the possessive (at most two
// modifiers) and the copula must land immediately before the amount — no
// intervening subject or predicate. Rejects "Orkin's website notes the local
// plan price is $129" (pre-push Codex P0) while keeping "Orkin's cancellation
// fee is $199".
const POSSESSIVE_PRICE_RE = /^(?:'s|’s)\s+(?:[A-Za-z-]+\s+){0,2}(?:fee|fees|price|prices|pricing|rate|rates|charge|charges|cost|costs|quote|quotes|minimum)\s+(?:is|was|are|were|starts?\s+at|runs?|comes?\s+to)\s*$/i;
//   (C) benchmark subject + copula: "the industry average is $145". The
//       phrase names a market statistic, so it can never denote a Waves
//       price — a bare copula is safe here (it is not in shape A).
const BENCHMARK_SUBJECT_RE = /^(?:industry average)$/i;
const BENCHMARK_COPULA_RE = /^[^.!?]{0,20}?\b(?:is|was|are|were|runs?|comes? to|sits? at|hovers? around)\b[^.!?]{0,15}?$/i;

function buildNameAlternation(names) {
  // Longest-first so "Truly Nolen of America" wins over "Truly Nolen".
  const alts = names
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((n) => escapeRegExp(n).replace(/\s+/g, '\\s+'));
  return alts.length ? `\\b(?:${alts.join('|')})\\b` : null;
}

function competitorNamePatterns() {
  if (competitorNamePatterns._res !== undefined) return competitorNamePatterns._res;
  const names = [];
  const csNames = [];
  try {
    const { COMPETITORS, COMPETITOR_BRAND_SIGNALS } = require('./competitor-facts');
    for (const c of Array.isArray(COMPETITORS) ? COMPETITORS : []) {
      if (c?.name) names.push(String(c.name));
      for (const a of Array.isArray(c?.aliases) ? c.aliases : []) names.push(String(a));
      // aliasesCS are deliberately CASE-SENSITIVE elsewhere ("Rodent
      // Solutions" the company vs "rodent solutions" the phrase) — same
      // sensitivity here (Codex r2 P2).
      for (const a of Array.isArray(c?.aliasesCS) ? c.aliasesCS : []) csNames.push(String(a));
    }
    // Detection-only brands (Aptive, Hawx, …) attribute prices too — the
    // B1/B3 intercept briefs mandate Aptive's cancellation fee, and the
    // comparison gate separately polices whether NAMING them is authorized.
    // This pattern only decides who can OWN a dollar figure.
    for (const s of Array.isArray(COMPETITOR_BRAND_SIGNALS) ? COMPETITOR_BRAND_SIGNALS : []) names.push(String(s));
  } catch { /* competitor-facts unavailable — generic framing still applies */ }
  const res = [];
  const ci = buildNameAlternation(names);
  if (ci) res.push(new RegExp(ci, 'i'));
  const cs = buildNameAlternation(csNames);
  if (cs) res.push(new RegExp(cs));
  competitorNamePatterns._res = res;
  return res;
}

// The sentence containing `index`. Boundaries = . ! ? followed by whitespace
// or end-of-string (so decimal amounts like "$49.99" never split), PLUS any
// line break: an unpunctuated Markdown heading otherwise merges with the
// block below it and "## Orkin\nQuarterly plan costs $129" would read as
// attribution (pre-push Codex P0).
function sentenceAround(text, index) {
  const s = String(text || '');
  // Trailing quotes/markdown markers after the punctuation are part of the
  // boundary — 'Orkin charges $199.” $89 locally.' must split after the
  // closing quote or the second amount inherits the attribution (pre-push
  // Codex P0).
  const boundaryRe = /[.!?]["”'’)\]*_]*(?=\s|$)|\r?\n/g;
  let start = 0;
  let m;
  while ((m = boundaryRe.exec(s)) !== null) {
    if (m.index >= index) break;
    start = m.index + m[0].length;
  }
  boundaryRe.lastIndex = index;
  const endMatch = boundaryRe.exec(s);
  const end = endMatch ? endMatch.index + 1 : s.length;
  return { text: s.slice(start, end), offset: start };
}







const unescapeStr = (v) => String(v ?? '').replace(/\\(.)/g, '$1');



// What a READER sees in a table cell, for OWNERSHIP decisions only (never
// for offsets). Three transforms, each a real bypass found in review:
//   - entities: "O&#117;r quarterly service" renders as "Our …" but the raw
//     text hides the first-party marker (Codex r9);
//   - Markdown links: the B1/B3 briefs REQUIRE linked attribution, so
//     "[Aptive](https://…)" must identify Aptive, not fail the exact-name
//     test on its brackets and URL (Codex r9);
//   - backslash escapes, as elsewhere in this file.
// Remove tag markup entirely (no space inserted, so "O<span>u</span>r"
// becomes "Our"), using the quote-aware scanner rather than a regex.
function stripTags(text) {
  const str = String(text || '');
  const tags = [...eachTag(str)];
  if (!tags.length) return str;
  let out = '';
  let cursor = 0;
  for (const tag of tags) {
    out += str.slice(cursor, tag.start);
    cursor = tag.end + 1;
  }
  return out + str.slice(cursor);
}

// Delete (never blank) the spans a reader never sees: hidden element
// content and MDX expression containers. Used only for IDENTITY decisions,
// where introducing a word boundary would itself be the bug.
function removeNonRendered(text) {
  // Comments FIRST: an MDX comment is an expression container, so the
  // expression pass below would otherwise unwrap "{/*x*/}" to "/*x*/" and
  // splice that between the letters it was hiding (Codex).
  let out = String(text || '').replace(COMMENT_SPAN_RE, '');
  // Hidden elements, innermost-safe: repeat until stable.
  for (let pass = 0; pass < 4; pass += 1) {
    const tags = [...eachTag(blankComments(out))];
    let cut = null;
    for (let t = 0; t < tags.length && !cut; t += 1) {
      const tag = tags[t];
      if (tag.isClose || tag.selfClosing || !opensDefinitelyHidden(tag)) continue;
      let depth = 1;
      for (let u = t + 1; u < tags.length; u += 1) {
        const other = tags[u];
        if (other.name !== tag.name || other.selfClosing) continue;
        if (other.isClose) { depth -= 1; if (depth === 0) { cut = [tag.start, other.end]; break; } }
        else depth += 1;
      }
      if (!cut) cut = [tag.start, out.length - 1];
    }
    if (!cut) break;
    out = out.slice(0, cut[0]) + out.slice(cut[1] + 1);
  }
  // Balanced MDX expressions.
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== '{') continue;
    let depth = 0;
    let j = i;
    for (; j < out.length; j += 1) {
      const ch = out[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch; j += 1;
        while (j < out.length && out[j] !== q) j += out[j] === '\\' ? 2 : 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) break; }
    }
    if (j >= out.length) break;
    // An expression that RENDERS must keep its value: `O{"ur"} service`
    // displays as "Our service", so deleting it would erase the marker and
    // GRANT the exemption. Only provably-empty values are dropped; anything
    // unreadable keeps its inner text, which errs toward blocking (Codex).
    const inner = out.slice(i + 1, j).trim();
    const lit = /^(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)$/.exec(inner);
    let replacement;
    if (lit) replacement = lit[1] ?? lit[2] ?? lit[3] ?? '';
    else if (/^(?:null|undefined|false|''|""|``)$/.test(inner)) replacement = '';
    else replacement = inner;
    out = out.slice(0, i) + replacement + out.slice(j + 1);
    i += replacement.length - 1;
  }
  return out;
}

function cellIdentity(v) {
  // Hidden DESCENDANTS and MDX expressions render nothing, so they must be
  // REMOVED (not blanked) before the veto — "O<span hidden>x</span>ur" and
  // "O{null}ur" both display as "Our", and leaving the inner text or the
  // expression in place split the marker into "Oxur" (Codex).
  const seed = removeNonRendered(String(v ?? ''));
  return decodeEntitiesForScan(unescapeStr(seed))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Reference, collapsed and shortcut links render as their label too:
    // "O[ur][brand] service" displays as "Our service" (Codex). Definitions
    // are dropped outright; leftover brackets are removed so no boundary is
    // introduced.
    .replace(/^[ \t]*\[[^\]\n]+\]:[^\n]*$/gm, '')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]/g, '$1')
    // Inline emphasis renders away: "O**ur** quarterly service" reads as
    // "Our quarterly service", and splitting on the asterisks hid the
    // first-party marker (Codex r10). Inline TAGS do the same —
    // "O<span>u</span>r" renders as "Our" — and must be removed WITHOUT
    // inserting a space, or the marker stays split (Codex r10).
    // COMMENTS render away with no boundary too: "O<!--x-->ur" displays as
    // "Our" (Codex r10). Removed BEFORE emphasis stripping, or the "*" in an
    // MDX comment is eaten first and the comment no longer matches.
    .replace(COMMENT_SPAN_RE, '')
    .replace(/[*_`~]+/g, '')
    // Quote-aware: a ">" inside an attribute value does not end the tag, and
    // a naive regex left the tail behind, re-splitting the marker
    // (Codex r10). stripTags removes markup WITHOUT inserting a boundary.
    .replace(/[\s\S]*/, (t) => stripTags(t));
}


// The clause containing `localIndex` within a sentence.
// A conjunction continues a RANGE only when an explicit range marker
// anchors it: "between $49 and $99" / "from $49 or $59". A bare
// "charges $199 and $89 is the local rate" is TWO clauses — the second
// amount must not inherit the attribution (pre-push Codex P0), so
// amount-after-conjunction alone is NOT enough.
// The anchor must also PAIR with its conjunction ("between … and", "from …
// to") and what follows must be the range's ENDPOINT, not a fresh predicate:
// "Aptive charges from $49 and $89 is the local quarterly rate" is two
// claims, and reading it as one range laundered the second, first-party
// amount (pre-push Codex P0, r6). Unrecognized range grammar fails closed —
// the amount is simply scanned as its own clause.
const RANGE_ANCHOR_RE = /\b(between|from)\s+\$[\d,.]*\s*$/i;
const RANGE_PAIRS = { between: /^and$/i, from: /^to$/i };
const PREDICATE_AFTER_ENDPOINT_RE = /^\s*\$[\d,.]+(?:\s+(?:per|a|an|each)\s+[\w-]+)?\s+(?:is|are|was|were|costs?|starts?|runs?|remains?|covers?|includes?|buys?|gets?)\b/i;
function isRangeConjunction(s, m) {
  const conj = m[0].trim();
  if (!/^(?:and|or|to)$/i.test(conj)) return false;
  const after = s.slice(m.index + m[0].length);
  if (!/^\s*\$\d/.test(after)) return false;
  const anchor = RANGE_ANCHOR_RE.exec(s.slice(0, m.index));
  if (!anchor) return false;
  const pair = RANGE_PAIRS[anchor[1].toLowerCase()];
  if (!pair || !pair.test(conj)) return false;
  return !PREDICATE_AFTER_ENDPOINT_RE.test(after);
}

function clauseAround(sentence, localIndex) {
  const s = String(sentence || '');
  const splitRe = new RegExp(CLAUSE_SPLIT_RE.source, CLAUSE_SPLIT_RE.flags);
  let start = 0;
  let m;
  while ((m = splitRe.exec(s)) !== null) {
    if (m.index >= localIndex) break;
    if (isRangeConjunction(s, m)) continue;
    start = m.index + m[0].length;
  }
  splitRe.lastIndex = localIndex;
  let end = s.length;
  while ((m = splitRe.exec(s)) !== null) {
    if (isRangeConjunction(s, m)) continue;
    end = m.index;
    break;
  }
  return { text: s.slice(start, end), offset: start };
}

// True only when the amount's OWN CLAUSE attributes the price to someone who
// isn't us, with the attribution standing BEFORE the amount (subject
// position) — "Orkin charges a $199 cancellation fee", not "$199 … Orkin"
// and not "Orkin charges too much, but our rate is $129". The first-party
// disqualifier is SENTENCE-wide (deliberately broader than the attribution
// scope): any mention of us anywhere in the sentence blocks the exemption.
function isThirdPartyPriceCitation(text, amountIndex, vetoText) {
  const { text: sentence, offset: sentenceOffset } = sentenceAround(text, amountIndex);
  if (!sentence) return false;
  // The first-party VETO reads the sentence DECODED — "O&#117;r service is
  // different; Orkin charges $89" renders as "Our service…" and the raw text
  // hid the marker (Codex r9 P0). Decoding is safe here because the sentence
  // is only pattern-tested, never used for offsets; the clause scan below
  // deliberately stays on the RAW text, since decoding there would only ever
  // ADD third-party matches — the permissive direction.
  // The veto reads the whole PARAGRAPH, not just the sentence. Sentence
  // splitting cannot be made abbreviation-proof — "Our U.S. service differs;
  // Orkin charges $89" split at "U.S." and lost the marker (Codex r10) — and
  // enumerating abbreviations is the same losing game. A paragraph-scoped
  // veto closes the class outright; it only ever blocks MORE, and the
  // attribution side below stays sentence- and clause-scoped.
  // The veto reads the RAW paragraph through cellIdentity, which strips
  // emphasis and tag markup WITHOUT inserting a boundary. proseText blanks
  // tags to spaces, so "O<span>u</span>r" and "O**ur**" arrived pre-split and
  // the marker was missed — the same bypass already closed for table cells
  // (Codex r10). Reading raw text here only ever blocks MORE.
  const vt = typeof vetoText === 'string' ? vetoText : text;
  const paraStart = (() => { const i = vt.lastIndexOf('\n\n', amountIndex); return i === -1 ? 0 : i + 2; })();
  const paraEndRaw = vt.indexOf('\n\n', amountIndex);
  const paragraph = vt.slice(paraStart, paraEndRaw === -1 ? vt.length : paraEndRaw);
  if (hasFirstPartyMarker(cellIdentity(paragraph))) return false;
  const localAmountIndex = amountIndex - sentenceOffset;
  const { text: clause, offset: clauseOffset } = clauseAround(sentence, localAmountIndex);
  if (!clause) return false;
  const clauseAmountIndex = localAmountIndex - clauseOffset;
  for (const re of [GENERIC_THIRD_PARTY_RE, ...competitorNamePatterns()]) {
    if (!re) continue;
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = scan.exec(clause)) !== null) {
      if (m.index >= clauseAmountIndex) break;
      const between = clause.slice(m.index + m[0].length, clauseAmountIndex);
      // (A) the party is the subject of a pricing predicate that owns THIS
      // amount — every linking token whitelisted (see attributionBindsToAmount).
      if (attributionBindsToAmount(between)) return true;
      // (B) possessive price noun: "Orkin's cancellation fee is $199".
      if (POSSESSIVE_PRICE_RE.test(between)) return true;
      // (C) benchmark subject + copula: "the industry average is $145".
      if (BENCHMARK_SUBJECT_RE.test(m[0].trim()) && BENCHMARK_COPULA_RE.test(between)) return true;
    }
  }
  return false;
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

// Scheme and host are case-INSENSITIVE; the PATH is not. Lowercasing the
// whole URL made "/Payload.js" and "/payload.js" the same resource, so a
// named citation could authorize a different file on the same host
// (Codex).
function normalizeSourceUrl(u) {
  // Only sentence punctuation that CANNOT be part of a URL path is trimmed.
  // Stripping ")" and "." conflated distinct resources — ".../a." and
  // ".../a" are different paths (Codex).
  const raw = String(u || '').trim().replace(/[,;:!?]+$/, '');
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    const path = `${url.pathname}${url.search}${url.hash}`.replace(/\/+$/, '');
    // url.host keeps a non-default PORT — dropping it let a named source
    // match the same path on a different port (Codex).
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  } catch { return null; }
}

// The EXACT URLs a brief named. Compared whole, so naming a citation page
// never widens to its host — an operator asking for one document does not
// authorize everything that domain can serve.
function allowedExactSourceUrls(requiredSourceUrls = []) {
  const urls = new Set();
  for (const u of Array.isArray(requiredSourceUrls) ? requiredSourceUrls : []) {
    const norm = normalizeSourceUrl(u);
    if (norm) urls.add(norm);
  }
  return urls;
}

function allowedLinkHosts({ operatorCitations = false, requiredSourceUrls = [] } = {}) {
  const hosts = new Set();
  for (const d of HUB_DOMAINS) hosts.add(normalizeHost(d));
  for (const d of SPOKE_SITE_KEYS) hosts.add(normalizeHost(d));
  for (const d of String(process.env.CONTENT_ALLOWED_LINK_DOMAINS || '').split(',')) {
    const h = normalizeHost(d);
    if (h) hosts.add(h);
  }
  // NOTE: brief-named sources are NOT host-allowlisted — see
  // allowedExactSourceUrls. Allowing the HOST would let a named citation
  // domain also serve "<script src=…/evil.js>", which is the executable-MDX
  // hole the TLD rule had (Codex).

  if (operatorCitations) {
    for (const h of OPERATOR_CITATION_HOSTS) hosts.add(normalizeHost(h));
    for (const h of curatedCompetitorSourceHosts()) hosts.add(h);
  }
  // NO broad .gov/.edu TLD allowance (owner ruling 2026-08-01, third).
  // A host-wide rule has to be defended at every position a URL can appear —
  // src=, script bodies, form action, a ping, MDX expressions, Markdown
  // images and their reference/collapsed/shortcut forms — and each one was a
  // separate bypass into executable .mdx. The brief NAMES its sources, and
  // those flow in above as requiredSourceUrls, so a statute or extension
  // citation the operator asked for is allowed wherever it appears while an
  // unnamed host never is. Position stops mattering.
  return hosts;
}


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


// Generated posts publish as executable .mdx, and nothing in a blog post
// needs to ship code. Banning these tags outright is what finally ends the
// "is this URL in an executable position?" question: there IS no executable
// position, so a named citation URL cannot be turned into one (Codex).
// A CLOSED ALLOWLIST of raw HTML permitted in generated posts. A blacklist
// kept missing actives — script/iframe/object/embed, then meta, base, link,
// style — and each miss was executable in MDX (redirects, URL rebasing,
// injected CSS). Anything not listed here is rejected, so the next active
// element nobody thought of is rejected by default (Codex).
//
// Uppercase names are MDX COMPONENTS (<ComparisonTable>), which are the
// writer contract and are validated by their own gates — not raw HTML.
const PASSIVE_HTML_TAGS = new Set([
  'p', 'br', 'hr', 'span', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'blockquote', 'time', 'address',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'figure', 'figcaption', 'picture', 'details', 'summary',
]);

// Is this MDX expression a pure DATA LITERAL? Decided by tokenizing rather
// than sniffing for "(" or "=>": character heuristics kept admitting other
// executable shapes ("{globalThis.x}", "{a.b}", tagged templates). The only
// tokens allowed are string / number / boolean / null literals, the array and
// object punctuation, and identifiers in KEY position. Anything else — an
// identifier that is not a key, an operator, a call — makes it executable.
function isLiteralExpression(expr) {
  const body = String(expr || '').replace(/^\{/, '').replace(/\}$/, '');
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      let interpolated = false;
      while (i < n && body[i] !== quote) {
        if (quote === '`' && body[i] === '$' && body[i + 1] === '{') interpolated = true;
        i += body[i] === '\\' ? 2 : 1;
      }
      if (i >= n) return false;
      // A backtick string is a plain literal only WITHOUT interpolation —
      // "${…}" executes.
      if (interpolated) return false;
      i += 1;
      continue;
    }
    if ('[]{},:'.includes(ch)) { i += 1; continue; }
    if (/[-+]/.test(ch) && /\d/.test(body[i + 1] || '')) { i += 1; continue; }
    if (/\d/.test(ch)) { while (i < n && /[\d._eE+-]/.test(body[i])) i += 1; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(body[j])) j += 1;
      const word = body.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(body[k])) k += 1;
      // A bare identifier is only data when it is an object KEY.
      if (!['true', 'false', 'null', 'undefined'].includes(word) && body[k] !== ':') return false;
      i = j;
      continue;
    }
    return false; // operators, calls, backticks, anything else
  }
  return true;
}

function externalLinkFinding(text, { operatorCitations = false, requiredSourceUrls = [] } = {}) {
  const body = decodeEntitiesForScan(String(text || ''));
  if (!body) return null;
  // MDX ESM: an "import"/"export" statement at the start of a line is
  // executable module code, not prose, and no tag or expression scan sees it
  // (Codex). Generated posts have no reason to carry either.
  // No whitespace is required after the keyword — "import{x}from'y'" is
  // valid — and the line may be indented with any Unicode space or a
  // blockquote marker (Codex).
  // Comment-blanked: "{/* … */}import x from 'y'" kept the line from
  // starting with the keyword (Codex).
  const esm = /^[\s>]*(import|export)(?=[\s{*'"(])/m.exec(blankComments(body));
  if (esm) {
    return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains an MDX "${esm[1]}" statement — generated posts publish as .mdx and must never declare modules. Remove it.`);
  }
  // ANY MDX expression is executable at render, INCLUDING a component prop —
  // "<Comp onClick={fetch('https://named-source')} />" is as live as a
  // top-level one, and excluding tag interiors left exactly that hole
  // (Codex). Real component props carry data, not URLs; links are Markdown.
  {
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== '{') continue;
      let depth = 0;
      let j = i;
      for (; j < body.length; j += 1) {
        const ch = body[j];
        if (ch === '"' || ch === "'" || ch === '`') {
          const q = ch; j += 1;
          while (j < body.length && body[j] !== q) j += body[j] === '\\' ? 2 : 1;
          continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') { depth -= 1; if (depth === 0) break; }
      }
      if (j >= body.length) break;
      const expr = body.slice(i, j + 1);
      // A closed rule, not a URL sniff: an expression may only be a COMMENT
      // or a LITERAL prop value. Calls, arrows and template interpolation
      // execute, and an executable expression needs no literal URL to reach
      // the network — "{fetch(atob('…'))}" has none (Codex).
      const isComment = /^\{\s*\/\*[\s\S]*\*\/\s*\}$/.test(expr);
      const isLiteral = isLiteralExpression(expr);
      if (!isComment && !isLiteral) {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', 'Draft contains an executable MDX expression — generated posts may carry only literal component props and comments. Write content as Markdown.');
      }
      if (/:\/\//.test(expr)) {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', 'Draft contains a URL inside an MDX expression — expressions execute at render and are never citations. Write the link as Markdown.');
      }
      i = j;
    }
  }
  for (const tag of eachTag(body)) {
    if (/^[A-Z]/.test(tag.name.charAt(0)) || /^[A-Z]/.test((/^<\/?([A-Za-z][\w-]*)/.exec(body.slice(tag.start, tag.end + 1)) || [])[1] || '')) continue;
    if (PASSIVE_HTML_TAGS.has(tag.name)) {
      // A passive ELEMENT can still carry an active ATTRIBUTE: any "on*"
      // handler is inline JavaScript regardless of which tag holds it
      // (Codex). Allowlisting the tag is not allowlisting its attributes.
      const handler = /(?:^|\s)(on[a-z]+)\s*=/i.exec(tag.attrs || '');
      if (handler) {
        return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains the inline event handler "${handler[1]}" — generated posts must never ship JavaScript. Remove it.`);
      }
      continue;
    }
    return finding('P0', 'DISALLOWED_EXTERNAL_LINK', `Draft contains the raw HTML tag "<${tag.name}", which is not on the passive-content allowlist — generated posts publish as .mdx and must never ship code, redirects, rebased URLs or injected styles. Use Markdown or an approved component.`);
  }
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
  const exactUrls = allowedExactSourceUrls(requiredSourceUrls);
  // The broad .gov/.edu allowance is for CITATIONS — passive hyperlink
  // destinations. It must not extend to ACTIVE resource positions: posts are
  // published as executable .mdx, so a "<script src=…edu/payload.js>" would
  // turn control of any delegated subdomain into live third-party code on the
  // customer site (Codex). Those spans lose the TLD leniency and fall back to
  // the explicit host allowlist.
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
    if (exactUrls.has(normalizeSourceUrl(rawUrl) || '\u0000')) continue;
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

// ── citation-residue strip (deterministic pre-gate repair) ──────────
// Since 2026-07-27 the managed-agent writer emits <cite> wrappers on most
// FIRST drafts with no portal change (upstream model behavior), so the
// gate above was spending the run's single autonomous redraft on markup
// this comment block already declares has "no legitimate published form"
// — and the redraft then died on a DIFFERENT finding (3 straight zero-post
// days, 08-02→08-04). emit_draft strips the UNAMBIGUOUS artifacts at
// capture instead: <cite>…</cite> wrappers keep their inner text (the
// prose attribution IS the content) and the pure tokens delete outright.
// The AMBIGUOUS forms stay with the gate — bare index=N also appears in
// legitimate component props, and deleting a markdown footnote silently
// drops content a human should look at. Kept adjacent to
// CITATION_RESIDUE_RE so detector and stripper can never drift.
// Attribute matcher tolerates '>' inside quoted attribute values
// (<cite title="UF > IFAS">) — same reason the tag scanner below is
// quote-aware; a naive [^>]* would cut the tag short and leave residue.
const CITE_ATTRS_SRC = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';
const CITE_WRAPPER_RE = new RegExp(`<cite\\b${CITE_ATTRS_SRC}>([\\s\\S]*?)<\\/cite\\s*>`, 'gi');
const CITE_STRAY_TAG_RE = new RegExp(`<\\/?cite\\b${CITE_ATTRS_SRC}>`, 'gi');
// Case-insensitive + bare-`oaicite` coverage keeps the stripper in sync
// with CITATION_RESIDUE_RE above (which is /i and matches \\boaicite\\b) —
// the full :contentReference[...]{...} alternative sits FIRST so the
// complete form wins over the bare-word delete.
const CITE_TOKEN_RE = /:contentReference\[[^\]]{0,60}\](\{[^}]{0,80}\})?|\bciteturn\w+|\boaicite\b|【[^】\n]{0,40}】|[\uE000-\uF8FF]/gi;

function stripCitationResidue(text) {
  const original = String(text || '');
  const stripped = original
    .replace(CITE_WRAPPER_RE, '$1')
    .replace(CITE_STRAY_TAG_RE, '')
    .replace(CITE_TOKEN_RE, '');
  return { text: stripped, changed: stripped !== original };
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
  "(?:calls?|questions?|requests?)\\b[^.!?]{0,40}\\bwe (?:get|see|receive)\\b(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|we (?:get|see|receive)\\b[^.!?]{0,40}\\b(?:calls?|questions?|requests?|customers?)\\b(?:\\s+about\\s+(?:[\\w-]+\\s+){0,4}?(?=(?:from|in|across|throughout)\\s))?(?:\\s*(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:calls?|requests?|questions?|inquiries)\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b)[\\w.']+\\s*){1,3}(?![^.!?]{0,30}\\babout\\b)(?![^.!?]{0,30}\\b(?:trends?|data|research|records?|stud(?:y|ies)|reports?|surveys?|forums?|threads?)\\b)(?=[^.!?]{0,40}\\b(?:waves\\w*|we\\b|our\\b)\\b)|our (?:calls?|requests?|questions?|inquiries)\\b(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:(?!(?:serv|treat|cover|visit|spray|inspect|protect|handl|help|offer|provid)\\w*\\s)[\\w.'-]+\\s+){0,3}?(?:customers?|homeowners?|residents?|neighbors?)\\s+(?:\\w+\\s+){0,3}?(?:call|text|contact|ask)s?\\s+(?:us\\b|waves\\w*\\b|our\\s+(?:team|office|techs?|technicians?)\\b)(?:\\s+(?:from|in|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|(?:waves(?: pest control)?(?:'s|')?)\\s+(?:\\w+\\s+){0,2}?customers\\b(?:\\s+(?:in|from|across|throughout)\\s+(?:(?!about\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?|our\\s+(?:(?!(?:serv|treat|cover|visit|spray|inspect|protect|handl|help|offer|provid)\\w*\\s)[\\w.']+\\s+){0,3}?customers\\b(?:\\s+(?:in|from|across|throughout)\\s+(?:(?!about\\b|regarding\\b|concerning\\b|whether\\b|if\\b|ask\\w*\\b|compar\\w*\\b|call\\w*\\b|text\\w*\\b|contact\\w*\\b|wonder\\w*\\b|says?\\b|tells?\\b|report\\w*\\b|complain\\w*\\b|mention\\w*\\b|discuss\\w*\\b|debat\\w*\\b|research\\b|records?\\b|data\\b|studies\\b|forums?\\b|threads?\\b)[\\w.']+\\s*){1,3}(?!\\s*(?:research|records?|data|studies|forums?|threads?|reports?)\\b))?";

const SERVICE_CLAIM_CONTEXT_RE = new RegExp(
  "\\b(we(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still| \\w+ly)? (?:serv(?:e|es|ed|ing)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+|treat\\w*(?![^.!?]{0,20}\\b(?:data|research|information|statistics|figures|reports?)\\b(?!\\s*(?:in|near)\\b))|cover\\w*|inspect\\w*|handl\\w+|protect\\w*|visit\\w*|spray\\w*|exterminat\\w+|remov(?:e|es|ed|ing)\\b|eliminat\\w+|get(?:s|ting)? rid of\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|bring(?:s|ing)?\\b|brought\\b|send(?:s|ing)?\\b|sent\\b|dispatch(?:es|ed|ing)?\\b|fertiliz(?:e|es|ed|ing)\\b|maintain(?:s|ed|ing)?\\b|mow(?:s|ed|ing)?\\b|aerat\\w+\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|manag(?:e|es|ed|ing)\\b(?!\\s+to\\b))"
  + "|we(?:'re| are)? proud to (?:serve|service|treat|cover|protect)\\b"
  + `|${SERVICE_KEYWORD_SOURCE}\\s+(?:is\\s+|are\\s+)?now\\s+available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from|through|via|with)\\s+(?:(?:only\\s+)?an?\\s+)?(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|now offering\\b[^.!?]{0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?!\\s+(?:info\\w*|tips?|advice|research|guides?|facts?|resources?|articles?|content|news)\\b)|${SERVICE_KEYWORD_SOURCE}\\s+available\\?[\\s\\S]{0,60}?\\byes\\b`
  + `|${SERVICE_KEYWORD_SOURCE}\\b(?!\\s+(?:tips?|advice|research|guides?|facts?|articles?|content|news)\\b)[^.!?]{0,60}?\\b(?:waves\\s+(?:does|do)\\s+(?:too|the same)|so does waves|as does waves|including waves)\\b|no (?:need|reason) to (?:go without|skip|miss|forgo|forego|risk)\\b(?:(?!\\b(?:diy|do.?it.?yourself|unlicensed|yourself)\\b)[^.!?]){0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?!\\s+(?:guides?|tips?|advice|research|facts?|info\\w*|articles?|checklists?|newsletters?)\\b)(?![^.!?]{0,30}\\b(?:without\\s+a\\s+licen\\w*|without\\s+training|yourself|diy)\\b)`
  + `|(?:services?|plans?|programs?|treatments?)\\s*:\\s*available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from|through|via|with)\\s+(?:(?:only\\s+)?an?\\s+)?(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|^\\s*available\\s+(?:in|to|for|near|throughout|across)\\b(?![^.!?]{0,40}\\b(?:by|from|through|via|with)\\s+(?:(?:only\\s+)?an?\\s+)?(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)`
  + "|(?:we(?:'ve| have)?|waves(?: pest control)?(?:'s|')?(?: has| have)?)\\s+got\\s+(?:you|your\\s+\\w+)\\s+covered\\b|(?:waves(?: pest control)?(?:'s|')?|we)\\s+(?:has|have)\\s+you\\s+covered\\b"
  + "|(?:we(?:'re| are)?|waves(?: pest control)?(?:'s|')?(?: is| are)?|our (?:team|techs?|technicians?|crews?)(?: is| are)?)\\s*here to help\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)"
  + "|we(?:'re| are|'ll| will|'ve| have)?(?: been)?(?: also| now| currently| proudly| still)? (?:work(?:s|ed|ing)?|operat(?:e|es|ed|ing)) (?:in|throughout|across|around)\\b(?!\\s+(?:\\w+\\s+){0,2}?(?:records?|data|datasets?|research|studies|regulations?|rules|ordinances?|history|archives?|reports?|statistics|literature|documents?|weather|climate|conditions|seasons?|trends?|patterns?)\\b)|\\b(?:and|or)\\s+(?:now\\s+|currently\\s+|also\\s+|still\\s+|\\w+ly\\s+)?(?:work(?:s|ing)?|operat(?:e|es|ing)) (?:in|throughout|across|around)\\b|\\b(?:and|or|but)\\s+(?:now\\s+|currently\\s+|also\\s+|still\\s+|\\w+ly\\s+)?(?:visit|visits|spray|sprays|treat|treats|cover|covers|protect|protects|inspect|inspects|handle|handles|serve|serves|service|services|include|includes|extend|extends|reach|reaches)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))(?!\\s+(?:\\w+\\s+){0,2}?(?:records?|data|datasets?|research|studies|regulations?|rules|ordinances?|history|archives?|reports?|statistics|literature|documents?|weather|climate|conditions|seasons?|trends?|patterns?)\\b)"
  + '|(?:^|,)\\s*(?:now\\s+|currently\\s+|still\\s+|proudly\\s+|also\\s+)?serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|(?<!\\bnot\\s)(?<!\\bnever\\s)(?<!\\bstopped\\s)(?:now|currently|still|also) serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|proudly serv\\w*\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|our (?:[\\w-]+\\s+){0,3}?(?:(?:service|coverage)\\s+)?(?:areas?|footprints?)(?:\\s*(?=:)|\\s+(?:now\\s+|still\\s+|currently\\s+|also\\s+|proudly\\s+)?(?:includes?|covers?|extends?|reaches?|adds?|added|gained|grew|grows|growing)\\b)|(?:part of|one of|includ(?:ed|ing) in|joins?|joined|joining|added to|adding to|expands? (?:to|into)|expanding (?:to|into)|within|inside)\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|our (?:[\\w-]+\\s+){0,3}?coverage\\s+(?:now\\s+)?(?:includes?|covers?|extends?|reaches?|adds?|added|grew|grows|growing)\\b(?![^.!?]{0,30}\\b(?:research|data|studies|statistics|reports?|records?|information|info|topics?)\\b)|(?:is|are)\\s+not\\s+(?:excluded|omitted|left out)\\s+from\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:is|are|lies?|sits?|falls?|remains?|stays?)\\s+(?:now\\s+|currently\\s+|proudly\\s+|still\\s+)?in\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:is|are)\\s+(?:now\\s+|also\\s+|officially\\s+|currently\\s+|still\\s+|proudly\\s+)?(?:(?:a|our|one of our|among our)\\s+)?(?:newest\\s+)?(?:service|coverage)\\s+(?:areas?|footprints?)\\b|your (?:\\w+\\s+){0,2}(?:home|house|lawn|yard|property)'
  + '|call (?:us\\b|waves\\b|now\\b|today\\b|ahead\\b|for (?:a |your )?(?:free )?(?:quote|estimate|inspection))(?![^.!?]{0,40}\\b(?:tips?|advice|research|guides?|facts?|resources?|articles?|content|news)\\b)|give us a call|(?:schedule|book(?:ing)?)\\b(?![^.!?]{0,50}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\s+(?:do not|don\'?t|does not|doesn\'?t|cannot|can\'?t|won\'?t)\\b)'
  + "|(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding|contracts?|obligations?|hassle|costs?|fees?|catch|just)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:(?!(?:just|only)\\s)[\\w']+\\s+){0,2})(?:our|waves(?: pest control)?(?:'s|')?) (?:[\\w-]+ ){0,3}?(?:technicians?|techs?|team|routes?|trucks?|vans?|crews?|offices?|branch(?:es)?|plans?|programs?|memberships?|pros?|specialists?|experts?|applicators?|staff|inspectors?)(?:\\s+(?!not\\b|never\\b)\\w+){0,4}\\s+(?:open(?:s|ed|ing)?\\b(?!\\s+(?:the|a|an)\\b)|operational\\b|offer(?:s|ed|ing)?\\b|provid(?:e|es|ed|ing)\\b|deliver(?:s|ed|ing)?\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|available (?:in|throughout|across|to|for|near)\\b|includ(?:e|es|ed|ing)\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|get(?:s|ting)? rid of\\b|extend(?:s|ed|ing)? (?:to|into)\\b|reach(?:es|ed|ing)?\\b|exterminat\\w+\\b|remov(?:e|es|ed|ing)\\b|eliminat\\w+\\b|proud to (?:serve|service|treat|cover|protect)\\b|treat(?:s|ing|ed)?\\b|serv(?:e|es|ed)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+|cover(?:s|ing|ed)?\\b|visit(?:s|ing|ed)?\\b|inspect(?:s|ing|ed)?\\b|handl(?:e|es|ing|ed)\\b|spray(?:s|ing|ed)?\\b|run(?:s|ning)?\\b|protect(?:s|ing|ed)?\\b|work(?:s|ing|ed)? (?:in|throughout|across|around)|operat(?:e|es|ing|ed)? (?:in|throughout|across|around))"
  + '|same.day|we offer|free (?:quote|estimate|inspection)|' + DEMAND_CONTEXT_SOURCE + '|^\\s*(?:and |but |yet )?(?:also |now |still |currently )?(?:includes?|covers?|extends? (?:to|into)|reaches?|serves?|services?|treats?|visits?|sprays?|inspects?|protects?|handles?|helps?|works? (?:in|throughout|across|around)|operates? (?:in|throughout|across|around))\\b(?!\\s*:)(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))(?![^.!?]{0,30}\\b(?:data|research|weather|statistics|figures|information|charts?|tables?|topics?|sources?|studies)\\b)'
  + "|(?:we|waves(?: pest control)?|waveguard)(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still)? (?:offer|provid|deliver)\\w*\\s+(?:(?!(?:research|information|info|advice|guidance|tips|insights?|education|educational|resources?|articles?|guides?|content|news|about|on|regarding|of|for|to)\\b)[a-z-]+\\s+){0,2}?(?:(?:pest|mosquito|termite|rodent|lawn|tree|shrub|bed.?bugs?|wdo)\\s+)?(?:control|care|treatment|service|plan|program|inspection|removal|exterminat|waveguard)\\w*\\b(?!\\s+(?:(?!(?:and|or|nor|plus|as)\\b)[\\w-]+\\s+){0,4}?(?:research|information|info|advice|guidance|tips|insights?|education|educational|resources?|articles?|guides?|content|news|facts?|myths?|history|reviews?|explainers?|breakdowns?|roundups?|comparisons?|checklists?|overviews?|overviews?|checklists?|comparisons?|roundups?|director(?:y|ies)|summar(?:y|ies)|glossar(?:y|ies)|calendars?|faqs?)\\b)"
  // Editorial-FIRST mixed objects ("we provide pest control advice and
  // services in Naples") — an in/near-anchored "…services in <place>" after
  // a first-person/brand offer verb is an operating claim no matter what
  // editorial noun sits between.
  + "|(?:we|waves(?: pest control)?|waveguard)(?:'re| are|'ll| will| can| could| do| does|'ve| have| has| had)?(?: been)?(?: currently| now| proudly| also| still)? (?:offer|provid|deliver)\\w*\\b(?:(?!\\b(?:about|regarding|concerning|on|for|director(?:y|ies)|lists?|overview|roundup|comparison|index|map)\\b)[^.!?;]){0,40}?\\bservices?\\s+(?:in|near|throughout|across)\\b(?![^.!?]{0,30}\\bguides?\\b)"
  + `|(?<!\\b(?:can't|cannot|can not|won't|will not|don't|do not|doesn't|does not|couldn't|could not|shouldn't|should not|never|unable to|no way to|no)\\s+)(?:need|get|find|book|schedule|call|text|contact|looking for|searching for)\\b(?!\\s+(?:the|your|their|a|an)?\\s*(?:county|city|state|municipalit\\w+|extension|health\\s+departments?)\\b)(?!\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\b[^.!?]{0,30}?\\b(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?:(?!\\babout\\b)[^.!?]){0,30}?\\b${SERVICE_KEYWORD_SOURCE}\\b(?!\\s+(?:tips?|advice|research|guides?|facts?|resources?|articles?|content|news)\\b)(?![^.!?]{0,40}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\b[^.!?]{0,20}?\\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|won'?t)\\b)`
  // A short punctuation-free segment built around the keyword is a bare
  // packaging TITLE/META ("Cape Coral pest control services") — prose
  // sentences carry terminal punctuation and never match the anchored form.
  + `|^(?:(?!\\b(?:not|no|never|unavailable|unserved|isn|aren|without|guides?|compar\\w+|vs)\\b)(?:[^.!?]|(?<=\\bSt)\\.|(?<=\\bFt)\\.|(?<=\\bMt)\\.)){0,25}${SERVICE_KEYWORD_SOURCE}(?!(?:\\s+(?:service|plan|program)s?)?\\s+(?:guides?|research|information|info|advice|tips|insights?|education|resources?|articles?|content|news|myths?|history|checklists?|facts?|overviews?|comparisons?|roundups?|reviews?|breakdowns?|explainers?|faqs?)\\b)(?:(?!\\b(?:not|no|never|unavailable|unserved|isn|aren|research|guides?|tips?|facts?|advice|studies|myths?|history|checklists?|overviews?|faqs?)\\b)[^.!?]){0,25}$`
  + `|\\b(?<!\\b(?:about|regarding|concerning|on)\\b[^.!?]{0,20})(?<!\\bcompar\\w+\\b[^.!?]{0,25})(?<!\\b(?:director(?:y|ies)|lists?|overview|roundup|comparison|index|map)\\s+of\\b[^.!?]{0,20})(?<!\\bguides?\\s+to\\b[^.!?]{0,20})(?<!\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b[^.!?]{0,25})(?<!\\b(?:provid|offer|deliver)\\w*\\b[^.!?]{0,30}\\bfor\\b[^.!?]{0,20})(?<!\\b(?:competitors?|other\\s+(?:compan|provider|firm)\\w*|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*|the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+)\\b[^.!?]{0,25})(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding|contracts?|obligations?|hassle|costs?|fees?|catch|just)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:(?!(?:just|only)\\s)[\\w']+\\s+){0,2})(?<!\\bnever\\s)(?<!\\bwithout\\s)(?<!\\blocal\\s)(?<!\\bnearby\\s)(?<!\\bdiy\\s)${SERVICE_KEYWORD_SOURCE}\\s+(?:in|near|for|quotes?|plans?|company|companies|available)\\b(?![^.!?]{0,40}\\b(?:includ\\w+\\s+(?:national|local|regional|many|several|other)|national\\s+chains?)\\b)(?![^.!?]{0,40}\\b(?:without\\s+a\\s+licen\\w*|without\\s+training|yourself|diy)\\b)(?![^.!?]{0,40}\\bwith\\s+(?:another|other|a different|any|that|your current)\\s+(?:compan|provider|firm|exterminator)\\w*)(?![^.!?]{0,60}\\b(?:contact|call|hire|choose|find|use)\\s+(?:a\\s+|an\\s+|your\\s+)?(?:local|nearby|area|another|different|licensed)\\s+(?:provider|compan(?:y|ies)|firm|exterminator|pro(?:fessional)?)s?\\b)(?![^.!?]{0,60}\\b(?:we|waves\\w*)\\b[^.!?]{0,20}?\\b(?:do not|don'?t|does not|doesn'?t|cannot|can'?t|won'?t)\\b)(?![^.!?]{0,30}\\b(?:is|are|was|were|has|have|be|may|might|can|could|will|would|should|must|costs?|varies|vary|differs?|depends?|remains?|tends?|requires?|use[sd]?|using|rel(?:y|ies|ied)|charge[sd]?|charging|follow(?:s|ed)?|recommend(?:s|ed)?|report(?:s|ed)?|typically|often|usually|commonly|generally|research|guides?|tips?|advice|facts?|studies|myths?|history|checklists?|overviews?|faqs?)\\b(?!(?:\\s+(?!(?:not|no|never|rarely|hardly)\\b)[a-z]+){0,2}?\\s+(?:(?:available|offered|provided|book(?:ed|able)?|scheduled|requested|reserved)\\b(?!\\s+(?:around|during|before|after|when|while)\\b)(?![^.!?]{0,40}\\b(?:by|from|through|via|with)\\s+(?:(?:only\\s+)?an?\\s+)?(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)|(?:handled|performed|managed|covered|treated|serviced|delivered|done)\\s+by\\s+(?:waves|us|our)\\b|(?:where|how|why)\\s+(?:we|waves\\w*|our\\s+(?:team|techs?|crews?))\\s+(?:operat|work|serv|treat|cover|spray)\\w*\\b|(?:where|how|why)\\s+(?:we|waves\\w*)\\s+are\\s+(?:available|active|operational)\\b)))`
  // "Our pest control services guide explains…" is editorial packaging of
  // CONTENT, not of service — the guide-compound lookahead mirrors the
  // keyword suffix's own guard.
  + `|(?:your|our)\\s+(?:(?!(?:guides?|about|regarding|lists?|overview|roundup|comparisons?|reviews?)\\b)\\w+\\s+){0,2}?${SERVICE_KEYWORD_SOURCE}\\b(?!(?:\\s+(?:service|plan|program)s?)?\\s+(?:guides?|advice|research|information|info|tips|insights?|education|resources?|articles?|content|news|facts?|myths?|history|overviews?|checklists?|comparisons?|roundups?|reviews?|explainers?|breakdowns?|faqs?)\\b)(?![^.!?]{0,30}\\b(?:depends?|varies|vary|differs?|costs?|requires?|tends?|remains?)\\b)`
  + "|(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding|contracts?|obligations?|hassle|costs?|fees?|catch|just)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:(?!(?:just|only)\\s)[\\w']+\\s+){0,2})\\b(?:waves\\w*|waveguard|(?:our|this|the)\\s+(?:\\w+\\s+){0,2}?(?:service|plan|program|membership|treatment)s?)\\b[^.!?]{0,20}?\\b(?:is|are)\\s+(?:now\\s+)?available\\s+(?:in|throughout|across|to|for|near)\\b"
  + "|(?:we|waves(?: pest control)?(?:'s|')?)\\s+(?:run|runs|running|have|has|had|operate|operates)\\s+(?:\\w+\\s+){0,4}?(?:routes?|offices?|branch(?:es)?|locations?|storefronts?)\\b"
  + "|(?:add(?:s|ed|ing)?|welcom(?:e|es|ed|ing))\\b[^.!?]{0,30}?\\bto our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\b|(?:expand(?:s|ed|ing)?|extend(?:s|ed|ing)?|grew|grow(?:s|ing)?)\\s+our (?:(?:service|coverage)\\s+)?(?:areas?|footprints?)\\s+(?:to|into)\\b"
  + "|(?:waves(?: pest control)?|waveguard)\\s+(?:is |are |can |could |will |do |does |has |have |had )?(?:been )?(?:now |proudly |also |currently |still )?(?:serv(?:e|es|ed)\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|serving\\b(?!\\s+up\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:pest|mosquito|termite|rodent|lawn|tree|shrub)\\s+(?:control|care|treatment|service)s?\\b(?!\\s+(?:tips?|advice|research|info\\w*|guides?|facts?|insights?|news|myths?)\\b)))|servic\\w+|treat(?:s|ed|ing)?|cover(?:s|ed|ing)?|exterminat\\w+|remov(?:e|es|ed|ing)\\b|eliminat\\w+|visit(?:s|ed|ing)?\\b|spray(?:s|ed|ing)?\\b|inspect\\w*|handl\\w+|protect\\w*|get(?:s|ting)? rid of\\b|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|bring(?:s|ing)?\\b|brought\\b|send(?:s|ing)?\\b|sent\\b|dispatch(?:es|ed|ing)?\\b|fertiliz(?:e|es|ed|ing)\\b|maintain(?:s|ed|ing)?\\b|mow(?:s|ed|ing)?\\b|aerat\\w+\\b|help(?:s|ing|ed)?\\b(?!\\s+(?:[\\w.-]+\\s+){0,2}?(?:you|readers?|homeowners?|residents?)\\s+(?:understand|identify|learn|compare|decide|research|choose|spot)\\b)|manag(?:e|es|ed|ing)\\b(?!\\s+to\\b)|control(?:s|led|ling)?\\b(?!\\s+(?:panels?|groups?|measures?)\\b)(?!\\s+for\\b(?!\\s+(?:[\\w-]+\\s+){0,2}?(?:termites?|ants?|pests?|mosquito(?:es)?|roach\\w*|cockroach\\w*|rodents?|fleas?|ticks?|weeds?|grubs?|bed.?bugs?|spiders?|wasps?|hornets?|bees?|scorpions?|silverfish|earwigs?|crickets?|mice|rats?|chinch.?bugs?|fire.?ants?|wildlife)\\b))|includ(?:e|es|ed|ing)\\b(?![^.!?]{0,30}\\b(?:data|research|weather|statistics|figures|information|charts?|tables?|topics?|sources?|studies)\\b)|proud to (?:serve|service|treat|cover|protect)\\b|work(?:s|ed|ing)? (?:in|throughout|across|around)|operat(?:es|ed|ing)? (?:in|throughout|across|around))"
  + "|(?:is|are|has been|have been) (?:proudly |now |regularly )?(?:covered|served|serviced|treated|protected|inspected|sprayed|visited|handled|controlled|maintained) by (?:our (?:team|techs?|technicians?|crews?)|waves(?: pest control)?(?:'s|')?)"
  + "|we(?:'re| are) (?:now |also |still |currently )?available (?:in|throughout|across|to|for|near)\\b"
  + `|(?<!\\bno\\s+(?:(?!(?:wonder|one|doubt|matter|surprise|question|denying|kidding|contracts?|obligations?|hassle|costs?|fees?|catch|just)\\s)[\\w']+\\s+){0,2})(?<!\\bnot\\s+(?:(?!(?:just|only)\\s)[\\w']+\\s+){0,2})${SERVICE_KEYWORD_SOURCE}\\s+(?:is|are|can be|may be)\\s+(?:now\\s+)?(?:available|offered|provided|booked|bookable|scheduled|requested|reserved)\\b(?:\\s*(?:to|for|in|near|throughout|across)\\b)?(?![^.!?]{0,40}\\b(?:by|from|through|via|with)\\s+(?:(?:only\\s+)?an?\\s+)?(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b)(?![^.!?]{0,40}\\b(?:by|from|through|via|with)\\s+(?:(?:only\\s+)?an?\\s+)?(?:the\\s+county|the\\s+city|the\\s+state|counties|municipalit\\w+|other\\s+(?:compan|provider|firm)\\w*|competitors?|national\\s+chains?|local\\s+(?:compan|provider|firm)\\w*)\\b))\\b`,
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
    `(?:(?:do not|don'?t|does not|doesn'?t|no longer|won'?t|will not|cannot|can'?t|is not|isn'?t|are not|aren'?t|was not|wasn'?t|were not|weren'?t) (?:currently |yet |now |just )?(?:includ(?:e|ing)|cover(?:ing)?|serv(?:e|ing)|servic(?:e|ing)|extend(?:ing)?(?: to| into)?|reach(?:ing)?|treat(?:ing)?|visit(?:ing)?|book(?:ing)?|schedul(?:e|ing)|offer(?:ing)?|provid(?:e|ing)|deliver(?:ing)?)|excludes?|stops? (?:short of|before|at)|(?:is|are|was|were)?\\s*(?:not|never|no longer)\\s+(?:currently\\s+)?(?:available|offered|provided)\\s+(?:in|to|for|near|throughout|across)|unavailable\\s+(?:in|to|for|near|throughout|across)|,\\s*(?:but\\s+)?(?:not|excluding|except)\\b[^.!?;]{0,25}?(?=[^.!?;]{0,5}${citySource})|no (?:need|reason) (?:for\\b(?!(?:\\s+[\\w.-]+){0,4}\\s+to\\s+(?:wait|delay|hesitate|skip|miss|forgo|forego|go without|risk)\\b)|to (?!(?:wait|delay|hesitate|put off|hold off|postpone|rush|skip|miss|forgo|forego|go without|risk|call around|shop around|hunt)\\b)\\w+)(?![^.!?]{0,60}[;,—–-]\\s*(?:just\\s+)?(?:book|schedule|call|order|text)\\b))(?:(?!,\\s*(?:we|our|waves|waveguard|you)\\b|\\s(?:and|but)\\s+(?:you\\s+)?(?:also\\s+)?(?:can\\s+|could\\s+|will\\s+|would\\s+|may\\s+|might\\s+|do\\s+|does\\s+|now\\s+|still\\s+|also\\s+|\\w+ly\\s+){0,2}(?:offer|provid|deliver|serv|treat|cover|exterminat|remov|eliminat|manag|work|operat|book|schedul|visit|spray|inspect|handl|protect|includ|extend|reach|help)|\\s(?:and|but|yet)\\s+(?:is|are|was|were)\\b|\\bto\\s+(?:book|schedul|call|order|get|claim|redeem|start|begin|launch)\\w*\\b|,\\s*(?:book|schedul|call|order|get)\\w*\\b|[:(]\\s*(?:just\\s+)?(?:book|schedul|call|order|text|start)\\w*\\b|[\\s(]but\\s+(?:call|text|contact)\\s+(?:us|waves)\\b|,\\s*(?:now\\s+|currently\\s+|also\\s+|still\\s+)?(?:serving|offering|covering|treating)\\b|,\\s*(?=[^.!?]{0,40}\\b(?:is|are)\\s+(?:now\\s+|currently\\s+)?(?:in|part of|one of|available)\\b)|\\b(?:before|when|while|after|if|whenever)\\s+(?:book|schedul|call|order)\\w*\\b|\\sand\\s+[^.!?;]{0,30}?\\b(?:is|are)\\s+(?:now\\s+)?(?:available|offered|provided)\\b|\\sand\\s+(?=[^.!?]{0,30}\\b(?:is|are)\\s+(?:now\\s+|currently\\s+)?(?:in|part of|one of)\\b)|\\b(?:we|our|waves|waveguard)\\s+(?:\\w+\\s+){0,2}?(?:provid|offer|deliver|serv|treat|cover|exterminat|remov|eliminat|manag|work|operat|book|schedul|visit|spray|inspect|handl|protect|get)\\w*\\b)[^.!?;–—]){0,60}?\\b${citySource}|${citySource}\\b[^.!?;|]{0,10}\\|?\\s*not\\s+(?:currently\\s+)?(?:available|offered|served)\\b(?![^|]{0,60}\\b(?:schedul|book)\\w*\\s+(?:(?:your|a|an)\\s+)?(?:pest|mosquito|termite|lawn|service|treatment|visit|appointment|online|now|today)\\b)(?![^|]{0,60}\\b(?:call|text|contact)\\s+(?:waves|us)\\b)|(?<!\\b(?:serv(?:e|es|ing|ice|ices|icing)|treat(?:s|ing)?|cover(?:s|ing)?|visit(?:s|ing)?|spray(?:s|ing)?|inspect(?:s|ing)?|protect(?:s|ing)?|handl(?:e|es|ing)|exterminat\\w+|in|throughout|across)\\s+)${citySource}(?:(?!\\b(?:we|our|waves|waveguard)\\b\\s+(?:\\w+\\s+){0,2}?(?:serv|treat|cover|visit|spray|inspect|protect|handl|exterminat|book|schedul|offer|provid|deliver|get)\\w*)[^.!?]){0,40}\\b(?:is|sits|falls|lies) (?:just )?(?:outside|beyond|out of|past|(?:south|north|east|west) of\\b(?=[^.!?]{0,30}\\b(?:our|the)\\s+(?:service\\s+)?(?:area|footprint)\\b))\\b`,
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
const FOOTPRINT_CLAUSE_SPLIT_RE = /;(?!\s*(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)(?!\s*(?:[Ww]aves\s+(?:does|do)\s+(?:too|the same)|so does [Ww]aves|as does [Ww]aves|including [Ww]aves)\b)\s*|\s*[–—]\s*(?=(?:we|our|waves|waveguard)\b|[^.!?]{0,80}\b(?:is|are|was|were|has|have|lies?|sits?|falls?|remains?)\b)|,\s*(?:but(?!\s+also\b(?!\s+(?:we|our|waves|waveguard)\b))(?!\s+(?:we|waves\w*|our\s+\w+)\b[^.!?]{0,40}\b(?:(?:by|on|upon)\s+request|(?:if|when|as|where)\s+needed|as\s+necessary|on\s+demand)\b)(?!\s+(?:just\s+)?(?:book|schedul|call|order|text|contact)\w*\b)|yet|however|though|although|whereas|so(?=\s+(?:we|our|waves|waveguard)\b)|while(?!\s+(?:we|our|waves|waveguard)\b))\s+|\s+(?:but(?!\s+also\b(?!\s+(?:we|our|waves|waveguard)\b))(?!\s+(?:we|waves\w*|our\s+\w+)\b[^.!?]{0,40}\b(?:(?:by|on|upon)\s+request|(?:if|when|as|where)\s+needed|as\s+necessary|on\s+demand)\b)(?!\s+(?:just\s+)?(?:book|schedul|call|order|text|contact)\w*\b)|however|yet|though|although|whereas|while(?!\s+(?:we|our|waves|waveguard)\b)|whether(?<=\b(?:ask|asks|asked|asking|wonder|wonders|wondered|wondering|question|questions|questioned|questioning|debate|debates|debated|debating|unsure|know|knows|knew|check|checks|checked|checking|confirm|confirms|confirmed|confirming|decide|decides|decided|deciding|sure)\s+whether))\s+|(?<!\b(?:is|are|was|were))(?<!,)\s+(?:how|when|where|why)\s+(?=(?:we|our|waves|waveguard)\b)|(?<=^\s*(?:because|since|due to|given that)\b[^,;]{1,80}),\s*(?=(?:we|our|waves|waveguard)\b)|,?\s+and\s+(?=(?:we|our|waves|waveguard)\b)/i;

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
  for (const part of String(sentence || '').split(/;(?!\s*(?:just\s+)?(?:book|schedul|call|order|text)\w*\b)(?!\s*(?:[Ww]aves\s+(?:does|do)\s+(?:too|the same)|so does [Ww]aves|as does [Ww]aves|including [Ww]aves)\b)\s*/)) {
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
    .replace(/((?:(?:(?<!\bas\s)a|(?<!\bas\s)an|another|one|some|that|this|(?<!\bwaves\s+is\s)(?<!\bwe\s+are\s)the)\s+(?:competitor|compan(?:y|ies)|provider|firm)s?|competitors\b|providers\b|(?<!\bour )(?<!\bwe )(?:phrase|wording|term|example)s?)\b[^.!?"\u201c]{0,25}["\u201c])([^"\u201d]{0,120})(["\u201d])(?![^.!?]{0,40}\b(?:and so do we|so do we|we do too|as do we|including us|including waves|same here|so does waves|as does waves|waves (?:does|do) (?:too|the same))\b)/gi, '$1…$3')
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
  const consumedRows = new Set();
  const allSegments = markdownSegments(s);
  for (let segIndex = 0; segIndex < allSegments.length; segIndex += 1) {
    if (consumedRows.has(segIndex)) continue;
    const segment = allSegments[segIndex];
    const trimmed = segment.trim();
    const nextTrimmed = (allSegments[segIndex + 1] || '').trim();
    const sepLike = (t) => /^[\s:|-]+$/.test(t) && t.includes('-');
    if (/^\|.+/.test(trimmed) || (trimmed.includes('|') && (sepLike(nextTrimmed) || sepLike(trimmed) || (tableIntro && (/^\|/.test(trimmed) || (trimmed.match(/\|/g) || []).length >= 2 || (!/[.!?]/.test(trimmed) || trimmed.length < 140)))))) {
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
          const strip = (row) => { const cs = row.split('|').map((c) => c.trim()); if (cs.length && cs[0] === '') cs.shift(); if (cs.length && cs[cs.length - 1] === '') cs.pop(); return cs; };
          const qCells = strip(trimmed);
          const aCells = strip(answerRow);
          if (/\?/.test(trimmed) && qCells.length > 1 && qCells.length === aCells.length
            && qCells.some((c) => /\?/.test(c))) {
            for (let ci = 0; ci < qCells.length; ci += 1) {
              if (/\b(?:local|another|different)\b[^|?]{0,30}\b(?:provider|compan\w*|firm|exterminator)/i.test(qCells[ci] || '')) continue;
              if (/no,?\s+but\b[^|]{0,40}\b(?:(?:by|on|upon)\s+request|(?:if|when|as|where)\s+needed|as\s+necessary|on\s+demand)\b/i.test(aCells[ci] || '')) {
                scanUnits.push(`${qCells[ci].replace(/\b(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\s+/i, 'our team ').replace(/\?/g, '')} ${aCells[ci]}`);
                continue;
              }
              if (/^(?:\*\*)?(?:yes|sure|definitely|certainly|yeah|indeed|you bet)\b(?!\s*,?\s*(?:but\s+)?not\b)(?![^.!?]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator)\w*\b)(?![^.!?]{0,40}\b(?:but\s+not\s+(?:from|by|through|with|us|waves)|not\s+from\s+(?:waves|us)|(?:choose|contact|call|try)\s+a\s+local)\b)/i.test(aCells[ci])) {
                scanUnits.push(`${answerRow} ` + qCells[ci]
                  .replace(/\b(?:do|does|can|could|will|would)\s+(?:you|your\s+\w+|waves\w*)\s+(?:have|carry)\s+/i, 'we offer ')
                  .replace(/\b(?:do|does|can|could|will|would|is|are)\s+(?:you|your\s+\w+|waves\w*)\s+/i, 'our team ')
                  .replace(/\?/g, ''));
              }
            }
            scanUnits.push(answerRow);
            consumedRows.add(segIndex + 2);
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
          && !/\b(?:local|another|different)\b[^|?]{0,30}\b(?:provider|compan\w*|firm|exterminator)/i.test(trimmed)
          && /(?:^|\|)\s*(?:\*\*)?(?:yes|sure|definitely|certainly|yeah|indeed|you bet)\b(?!\s*,?\s*(?:but\s+)?not\b)(?![^.!?]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator)\w*\b)(?![^|]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator|option)s?\b)(?![^|]{0,40}\bnot from (?:waves|us)\b)/i.test((allSegments[segIndex + 2] || '').trim())) {
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
      } else if (/\|\s*(?:\*\*)?(?:yes,?\s+but\s+not\s+(?:from|by|through|with|us|waves)\b[^|]{0,60}|yes[^|]{0,40}\bnot from (?:waves|us)\b[^|]{0,20}|no\s*[,.!;:—–][^|]{0,60}|no|not (?:served|available|covered|yet|included|offered)\b(?:(?!(?:schedul|book)\w*\s+(?:(?:your|a|an)\s+)?(?:pest|mosquito|termite|lawn|service|treatment|visit|appointment|online|now|today)|call\s+(?:waves|us|now|today))[^|]){0,40}|not (?:in|within|currently|part of)\b(?:(?!(?:schedul|book)\w*\s+(?:(?:your|a|an)\s+)?(?:pest|mosquito|termite|lawn|service|treatment|visit|appointment|online|now|today)|call\s+(?:waves|us|now|today))[^|]){0,40}|not a (?:service|coverage) area[^|]{0,20}|unavailable[^|]{0,60}|outside\s+(?:our|the)\b[^|]{0,40}|outside\s+(?:service\s+|coverage\s+)?(?:areas?|footprints?)\b[^|]{0,20}|✗|✕)(?:\*\*)?\s*(?:\||$)/i.test(trimmed)
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
  // Every offending (city, rendered clause) pair — not just the first —
  // feeds the async LLM refinement pass (footprint-claim-classifier), which
  // may dismiss the finding only if EVERY pair classifies as a non-claim.
  const offenders = [];
  const offenderKeys = new Set();
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
      && /^\s*(?:(?:yes|sure|definitely|certainly|yeah|indeed|you bet)\b(?!\s*,?\s*(?:but\s+)?not\b)(?![^.!?]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator)\w*\b)|absolutely\b|of course\b|yep\b|we (?:do|are|can|sure do|sure can)\b|no,?\s+but\s+(?:we|waves\w*)\s+(?:can|do|will|might)\s+(?:help|assist|try)\b(?![^.!?]{0,30}\b(?:in|near|around|throughout)\s+\w)(?![^.!?]{0,40}\b(?:local|another|different)\s+(?:provider|compan\w*|firm|exterminator|pro(?:fessional)?|option)s?\b)(?![^.!?]{0,40}\breferrals?\b)(?![^.!?]{0,40}\b(?:someone|somebody)\b)(?![^.!?]{0,40}\b(?:find|choose|pick|select)\s+(?:you\s+)?a\s+(?:provider|compan\w*|pro(?:fessional)?)\b)(?![^.!?]{0,40}\b(?:understand|learn|compare|decide|research|identify|explain|review)\b)|no,?\s+but\s+(?:we|waves\w*)\b[^.!?]{0,40}?\b(?:by request|on request|upon request|if needed|when needed|as needed|case by case)\b|no (?:problem|worries|sweat)\b|no (?:appointment|contract|subscription)s?\s+(?:needed|required|necessary)\b|they (?:do|are)\b)/i.test((sentences[sentenceIndex + 1] || '').replace(/[‘’]/g, "'").replace(/<[^>]+>/g, ' ').replace(/^[\s*_~`>#-]+/, ''))) {
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
      && /^\s*(?:no\s*[.,!;:—–-](?!\s*but\b)|no\s+(?:we|unfortunately|sorry|not)\b|no,?\s+but\b(?![^.!?]{0,30}\b(?:can|do|will|might)\s+(?:help|assist|try)\b)(?![^.!?]{0,40}\b(?:by|on|upon)\s+request\b)(?![^.!?]{0,40}\b(?:if|when|as)\s+needed\b)|yes[^.!?]{0,50}\b(?:but\s+not\s+(?:from|by|through|with)\b|but\s+not\s+(?:us|waves)\b|not\s+from\s+(?:waves|us)|(?:but\s+)?(?:choose|contact|call|try)\s+a\s+local)\b|not\b|nope\b|unfortunately\b|sadly\b|we (?:do not|don'?t|cannot|can'?t)|(?:contact|call|try|choose|find|use)\s+(?:a|an|your)?\s*(?:local|nearby|another|different|licensed))/i.test((sentences[sentenceIndex + 1] || '').replace(/[‘’]/g, "'").replace(/<[^>]+>/g, ' ').replace(/^[\s*_~`>#-]+/, ''))) {
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
        .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)+([\s\S]*?)[.!?]?\s*$/, '$1')
        .replace(/<[^>]{1,60}>/g, ' ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/\b_([^_\n]+)_\b/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
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
          if (/ County$/.test(city)
            && !/\b(?:serv\w*|treat\w*|cover\w*|visit\w*|protect\w*|handl\w+)\s+(?:[\w.-]+\s+){0,2}$|\b(?:provid|offer|deliver)\w*\s+(?:[\w.-]+\s+){0,3}$/i.test(normalized.slice(0, cityStart))
            && (/\b(?:county-run|government|municipal|state-run|public\s+(?:program|service)|extension|county\s+(?:\w+\s+)?(?:control|programs?|districts?|services?))\b[^.!?]{0,40}$/i.test(normalized.slice(0, cityStart))
              || /^[^.!?]{0,40}\b(?:county-run|government|municipal|state-run|county\s+(?:\w+\s+)?(?:control|programs?|districts?|services?))\b/i.test(normalized.slice(cityEnd)))) {
            continue;
          }
          if (demandOnly && /\b(?:about|regarding)\s+(?:[\w.-]+\s+){0,2}$/i.test(normalized.slice(0, cityStart))) continue;
          // "drains toward Tampa Bay" names the water body, not the city —
          // exempt only "toward(s)" or a motion/orientation verb governing
          // the preposition. Coverage phrasings keep flagging: "treat homes
          // around Tampa Bay" and "From Tampa Bay to Sarasota, our techs
          // treat…" are operating claims on the Tampa Bay area, and so is
          // bare "We treat Tampa Bay".
          if (/^\s+bay\s+(?:humidity|weather|water|winds?|climate|watershed|estuar\w+|tides?|temperatures?|rainfall|storms?)\b(?!-)(?!\s+(?:prone|homes?|properties|lawns?|yards?))/i.test(normalized.slice(cityEnd))) {
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
              {
                const prefix = blankDisclaimers(normalized, disclaimerRanges).slice(0, cityStart);
                if (SERVICE_CLAIM_CONTEXT_RE.test(prefix)
                  && !(/\b(?:sarasota|bradenton|venice|parrish|palmetto|lakewood ranch|north port|port charlotte|osprey|nokomis|ellenton|myakka)\b/i.test(prefix)
                    && /(?:\band|&)\s+(?:[A-Z][\w'.&-]*[\s,]*)*$/.test(prefix)
                    && PRE_DISCLAIMER_GLUE_RE.test(normalized.slice(cityEnd, dStart)))) return false;
              }
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
          // Collect instead of returning — every offending (city, clause)
          // pair feeds the LLM refinement pass (see offenders above).
          const offenderKey = `${city}|${normalized}`;
          if (!offenderKeys.has(offenderKey)) {
            offenderKeys.add(offenderKey);
            offenders.push({ city, clause: normalized });
          }
        }
      }
    }
    }
  }
  if (!offenders.length) return null;
  return {
    ...finding('P0', 'OFF_FOOTPRINT_CITY_CLAIM', `Draft makes a service claim naming "${offenders[0].city}", which is outside the Waves service footprint (config/locations CITY_TO_LOCATION). Educational mentions and honest out-of-area disclaimers are fine; service/CTA framing is not.`),
    evidence: offenders,
  };
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
// GROUND TRUTH: every entry below was fetched against the live hub on
// 2026-07-29 and returned 200. Four entries were REMOVED in that sweep
// because they 404 — '/lawn-care/', '/mosquito-control/', '/rodent-control/'
// and '/tree-shrub-care/' have no bare hub page (only city-scoped ones, which
// CITY_SERVICE_LINK_RE below already covers). Allowlisting a dead route is
// strictly worse than omitting a live one: it inverts the gate, waving the
// exact dead links it exists to catch straight through to publish. Re-verify
// with a live fetch before adding an entry — never from memory of the astro
// tree, and never to silence a finding.
const ALLOWED_INTERNAL_LINKS = Object.freeze([
  '/',
  '/book/',
  '/contact/',
  '/quote/',
  '/pest-control-quote/',
  '/pest-control-calculator/',
  // hub service pages (superset of content-brief-builder SERVICE_HUB_LINKS)
  '/pest-control-services/',
  '/waveguard-memberships/',
  '/pest-library/',
  '/lawn-care/fertilizer-blackout-manatee-county/',
  '/termite-inspection/',
  // Real page (200, verified 2026-07-29) that was missing here, so a draft
  // linking it was P0'd as an invented route — the same false positive that
  // stalled astro #409 on /quote/. Found by live-auditing every route the seed
  // manifest mandates, not by reading code.
  '/termite-control/',
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

/**
 * isKnownGoodInternalRoute(dest) → boolean
 *
 * True when a site-relative destination is a route this repo can PROVE exists:
 * an allowlist entry, or a city-service URL whose city actually has a
 * published page. This is the same test internalRouteFinding applies below —
 * exported so the brief builder can refuse to MANDATE a route the gate would
 * reject, instead of handing the writer a dead link plus an exemption for it.
 *
 * Absolute hub URLs and dot segments normalize first, matching the body scan.
 */
function isKnownGoodInternalRoute(dest) {
  let candidate = String(dest || '');
  if (!candidate) return false;
  try {
    const u = new URL(candidate);
    if (!hubHostSet().has(u.hostname.toLowerCase())) return false; // off-site: not ours to vouch for
    candidate = u.pathname || '/';
  } catch { /* not absolute — use as-is */ }
  let resolved = candidate;
  try { resolved = new URL(candidate, 'https://resolve.invalid').pathname || candidate; } catch { /* keep raw */ }
  const norm = normalizeInternalPath(resolved);
  if (!norm) return false;
  if (new Set(ALLOWED_INTERNAL_LINKS).has(norm)) return true;
  const citySlug = CITY_SERVICE_LINK_RE.exec(norm)?.[1];
  return Boolean(citySlug && PAGE_CITY_SLUGS.has(citySlug));
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

// ── Re-entry / safety compliance language (P0 REENTRY_SAFETY_CLAIM) ────────
// Compliance hard rule (AGENTS.md "Compliance language on any customer
// surface"): no pesticide is ever "safe" (incl. pet-safe/family-safe
// compounds); "EPA-registered"/"EPA-exempt" is the REQUIRED wording and
// "EPA-approved" is banned; never a fixed re-entry/drying minute figure.
// The sanctioned meta token — required by the 2026-07-29 contract in
// non-blog meta descriptions; renders via the domains pipeline, never MDX.
// evaluate() scrubs it from META fields before any scan (body unscrubbed).
const SANCTIONED_META_TOKEN_RE = /\{\{\s*cityPhone\s*\}\}/g;

// The APPROVED idiom is CONDITIONAL: "safe once dry" + technician confirms
// timing — so a "safe" match governed by a once/when/after-dry condition in
// the same sentence stays legal, as do negated disclaimers ("no product is
// completely safe…"), via the prevention section's negation guards.
// A "figure" is a digit, a range (hyphen/en-dash or worded: "30 to 60",
// "between 30 and 60", "one to two"), ANY spelled number with its unit, or
// a fractional/article form ("half an hour", "an hour").
const REENTRY_RANGE_CONNECTOR_SRC = "(?:\\s*[-–—]\\s*|\\s+(?:to|or|and)\\s+)";
// Full spelled-number grammar 1–99 (Codex PR r2: "six hours" and "twelve
// minutes" are figures too, not just the round values).
const REENTRY_SPELLED_NUM_SRC = "(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|ten|one|two|three|four|five|six|seven|eight|nine)";
// Digits include decimals ("1.5 hours"); spelled numbers include the
// "two and a half" compound form. BOTH range endpoints use the full
// spelled-number grammar (Codex PR r5): "twenty-one to twenty-four hours"
// is a figure — a single-word endpoint would drop the compound half.
// Seconds/days/weeks are figures too (Codex PR r8 audit): "do not
// re-enter for 90 seconds", "keep pets off for one day".
const REENTRY_DURATION_SRC = `(?:(?:\\d+(?:\\.\\d+)?(?:${REENTRY_RANGE_CONNECTOR_SRC}\\d+(?:\\.\\d+)?)?|${REENTRY_SPELLED_NUM_SRC}(?:\\s+and\\s+a\\s+half)?(?:${REENTRY_RANGE_CONNECTOR_SRC}(?:${REENTRY_SPELLED_NUM_SRC}(?:\\s+and\\s+a\\s+half)?|\\w+))?)\\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?)|half\\s+an?\\s+hour|an?\\s+hour(?:\\s+and\\s+a\\s+half)?|a\\s+half[-\\s]hour|a\\s+(?:day|week)\\b)`;
// Copular/modal predicate grammar shared by the safety-subject patterns
// (Codex PR r8 audit): "will be safe", "becomes safe", "should be safe"
// are the same unconditional claim as "is safe". Bounded NON-NEGATING
// adverbs may sit between the modal and the linking verb (Codex PR r9:
// "will eventually be safe") — negation stays outside so "will not be
// safe" remains a disclaimer.
const REENTRY_LINKING_VERB_SRC = `(?:is|are|remains?|stays?|becomes?|appears?|seems?|looks?|(?:will|can|could|should|would|may|might|must)\\s+(?:(?!${NEGATION_WORD_SRC}\\b)\\w+\\s+){0,2}?(?:be|remain|stay|become|appear|seem|look))`;
// Bounded qualifiers accepted wherever a duration is parsed (Codex PR
// r9): "in just 30 minutes", "wait only 30 minutes".
const REENTRY_QUALIFIER_SRC = "(?:(?:about|around|roughly|approximately|between|just|only|at\\s+least|up\\s+to|under|over|less\\s+than|more\\s+than|no\\s+more\\s+than|fewer\\s+than|as\\s+little\\s+as)\\s+){0,2}?";
// Drying-duration forms with no intrinsic re-entry word require PESTICIDE
// context in the sentence (Codex PR r5): "Paint drying takes 30 minutes"
// and "the caulk needs 30 minutes to dry" are home-maintenance advice —
// the policy bans drying figures about TREATMENTS. Entries flagged
// needsTreatmentContext are skipped when the sentence lacks this context;
// needsTreatmentAntecedent entries (pronoun subjects) instead require it
// in the bounded PRECEDING window.
const REENTRY_TREATMENT_CONTEXT_RE = /\b(?:treat(?:ed|ments?|ing)?|pre-?treat\w*|applications?|appl(?:y|ies|ied|ying)|products?|pesticides?|insecticides?|herbicides?|sprays?|sprayed|spraying|granules?|granular|baits?|chemicals?|solutions?|formulas?|pest[-\s]?control|lawn\s+care|mosquito\s+control)\b/i;
const REENTRY_SAFETY_SRCS = [
  // "safe to re-enter / return / go back inside", "re-entry is safe",
  // "safe for kids and pets to return"
  "\\bsafe\\s+(?:for\\s+(?:kids?|children|pets?|dogs?|cats?|famil(?:y|ies))\\s+(?:and\\s+(?:kids?|children|pets?|dogs?|cats?)\\s+)?)?to\\s+(?:re-?enter|return|go\\s+back|come\\s+back|walk\\s+on|play\\s+on|be\\s+(?:in|on|inside|around))\\b",
  // Adverbial form: "you can safely re-enter/return/walk" — same claim,
  // same conditional-idiom exemption path (contains "safe").
  "\\bsafely\\s+(?:re-?enter\\w*|return\\w*|go\\s+back|walk\\w*|play\\w*|be\\s+(?:in|on|inside|around))\\b",
  "\\bre-?entry\\s+(?:is|becomes?|will\\s+be)\\s+(?:completely\\s+|totally\\s+|perfectly\\s+)?(?:safe|harmless|risk[-\\s]?free)\\b",
  "\\bsafe\\s+(?:for\\s+)?re-?entry\\b",
  // "the treatment/product/pesticide/lawn is safe (for kids/pets/around …)"
  // — any non-negating qualifier(s) before "safe" ("completely safe",
  // "environmentally safe", "perfectly pet safe") count as the same claim;
  // the qualifier gap is negation-guarded so "is not safe" stays a
  // disclaimer handled by the polarity guards.
  // Service-noun subjects are the same claim (Codex PR r5 audit): "our
  // pest control is safe for pets", "our pest-control program is safe".
  // "safe FROM <hazard>" is protection-from-harm phrasing, never the
  // pesticide-safety claim (Codex PR r6: "the home is safe from termite
  // damage after repairs" is legal educational copy).
  // A bounded parenthetical may separate the subject from its predicate
  // (Codex PR r11: "The pesticide, when used as directed, is safe" is
  // label-style wording of the same claim).
  `\\b(?:treated\\s+)?(?:treatments?|products?|pesticides?|insecticides?|herbicides?|sprays?|applications?|granules?|baits?|chemicals?|materials?|solutions?|lawns?|yards?|areas?|surfaces?|rooms?|turf|grass|homes?|houses?|pest[-\\s]?control|lawn\\s+care|mosquito\\s+control)(?:,\\s*[^,.!?\\n]{0,40},)?\\s+(?:\\w+\\s+){0,2}?${REENTRY_LINKING_VERB_SRC}\\s+(?:(?!${NEGATION_WORD_SRC}\\b)[\\w-]+\\s+){0,2}?(?:safe|harmless|risk[-\\s]?free)\\b(?!\\s+from\\b)`,
  // Abstract service nouns (service/program/plan) only count as pesticide
  // subjects with treatment context in the sentence (Codex PR r6: "your
  // service plan is safe from price increases" is not a pesticide claim;
  // "our pest-control program is safe" stays caught by the direct
  // subjects above).
  { src: `\\b(?:services?|programs?|plans?)(?:,\\s*[^,.!?\\n]{0,40},)?\\s+(?:\\w+\\s+){0,2}?${REENTRY_LINKING_VERB_SRC}\\s+(?:(?!${NEGATION_WORD_SRC}\\b)[\\w-]+\\s+){0,2}?(?:safe|harmless|risk[-\\s]?free)\\b(?!\\s+from\\b)`, needsTreatmentContext: true },
  // Pronoun subjects with a treatment ANTECEDENT (Codex PR r5): "We apply
  // a granular treatment. It is safe once dry." is the same claim with the
  // noun one sentence back. Only it/they — never that/this, which appear as
  // relative pronouns in legal copy ("plants that are safe for
  // pollinators"). "safe to say/assume/bet" idioms are not safety claims.
  { src: `\\b(?:it|they)\\s+${REENTRY_LINKING_VERB_SRC}\\s+(?:(?!${NEGATION_WORD_SRC}\\b)[\\w-]+\\s+){0,2}?(?:safe\\b(?!\\s+to\\s+(?:say|assume|bet|call))|harmless|risk[-\\s]?free)\\b(?!\\s+from\\b)`, needsTreatmentAntecedent: true },
  // "safe for/around kids, pets, pollinators…" — PESTICIDE context
  // required (Codex PR r2): "the repaired screen is safe for pets" and
  // "plants that are safe for pollinators" are legal educational copy; the
  // rule bans safety claims about TREATMENTS. Context may precede the
  // claim, or follow it as an application/drying clause.
  "\\b(?:treatments?|products?|pesticides?|insecticides?|herbicides?|sprays?|applications?|granules?|baits?|chemicals?|solutions?|formulas?|treated)\\b[^.!?\\n]{0,60}?\\bsafe\\s+(?:for|around)\\s+(?:your\\s+)?(?:kids?|children|pets?|dogs?|cats?|famil(?:y|ies)|pollinators?|bees?|wildlife)\\b",
  "\\bsafe\\s+(?:for|around)\\s+(?:your\\s+)?(?:kids?|children|pets?|dogs?|cats?|famil(?:y|ies)|pollinators?|bees?|wildlife)\\b[^.!?\\n]{0,60}?\\b(?:once|after|when|while)\\b[^.!?\\n]{0,30}?\\b(?:treat\\w+|appl\\w+|spray\\w+|water\\w+\\s+in|dr(?:y|ies|ied))",
  // "pet-safe" / "child-safe" / "kid-safe" / "family-safe" compounds
  "\\b(?:pet|child|kid|family)[-\\s]safe\\b",
  // Adjective-before-product forms: "safe pesticides", "our safe treatment
  // options" — the unconditional claim in attributive position.
  "\\bsafe\\s+(?:pesticides?|insecticides?|herbicides?|products?|treatments?|sprays?|applications?|chemicals?|materials?|solutions?|options?|granules?|baits?|formulas?|pest[-\\s]?control|lawn\\s+care|mosquito\\s+control)\\b",
  // ONLY EPA *approval* claims are banned — "EPA-registered"/"EPA-exempt"
  // is the wording AGENTS.md requires. All word orders count (Codex PR r1):
  // hyphenated, passive ("approved by the EPA"), active ("the EPA has
  // approved"), and noun form ("carries EPA approval").
  "\\bEPA[-\\s]?approved\\b",
  // Bounded qualification between the verb and the agency (Codex PR r6):
  // "approved for residential use by (the) EPA". The gap refuses
  // denial/negation words (Codex PR r7): "approval was denied by the EPA"
  // is accurate negated copy, not an approval claim.
  "\\bapprov\\w+\\b(?:(?!\\b(?:denied|denies|deny|refused|refuses|rejected|rejects|revoked|revokes|withdrawn|withdrew|withheld|not|never)\\b)[^.!?\\n]){0,40}?\\bby\\s+(?:the\\s+)?EPA\\b",
  // approv\w+ also matches the bare noun ("EPA approval …"), so this
  // matcher carries the same postpositive-denial guard (Codex PR r8).
  "\\b(?:the\\s+)?EPA\\s+(?:has\\s+|have\\s+|had\\s+)?(?:approv\\w+|grant\\w+\\s+(?:its\\s+)?approval)\\b(?!(?:[^.!?\\n]){0,30}?\\b(?:not|never|denied|denies|refused|rejected|revoked|revokes|withdrawn|withdrew|withheld|isn['’]?t|wasn['’]?t|aren['’]?t)\\b)",
  // The noun forms honor POSTPOSITIVE denials too (Codex PR r8): "EPA
  // approval was not granted / was later revoked" is accurate negated
  // copy — the loop's negation guard only looks BEFORE the match.
  "\\bEPA(?:['’]s)?\\s+approvals?\\b(?!(?:[^.!?\\n]){0,30}?\\b(?:not|never|denied|denies|refused|rejected|revoked|revokes|withdrawn|withdrew|withheld|isn['’]?t|wasn['’]?t|aren['’]?t)\\b)",
  // "received/carries approval from the EPA" (Codex PR r6).
  "\\bapprovals?\\s+(?:from|by)\\s+(?:the\\s+)?EPA\\b(?!(?:[^.!?\\n]){0,30}?\\b(?:not|never|denied|denies|refused|rejected|revoked|revokes|withdrawn|withdrew|withheld|isn['’]?t|wasn['’]?t|aren['’]?t)\\b)",
  // Fixed re-entry/drying figures — the approved idiom carries NO number;
  // the technician confirms timing. Ranges (30–60), spelled numbers, and
  // BOTH word orders count: action-then-duration ("re-enter after 30
  // minutes"), duration-then-action ("wait 30 minutes before re-entering",
  // "allow 30 minutes of drying time"), and keep-off forms ("keep pets off
  // the lawn for 30 minutes").
  `\\b(?:re-?enter|re-?entry|re-?occup\\w+|return\\w*|walk\\s+on|go\\s+back)\\b[^.!?\\n]{0,40}?\\b(?:in|within|after)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  // A bounded qualifier may sit between the drying verb and the
  // preposition (Codex PR r8: "dries completely within 45 minutes").
  { src: `\\bdr(?:y|ies|ied)\\s+(?:\\w+\\s+){0,2}?(?:in|within|after)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // "avoid the treated area for 30 minutes"
  `\\bavoid\\s+(?:the\\s+)?(?:treated\\s+)?(?:areas?|lawns?|yards?|rooms?|surfaces?)\\b[^.!?\\n]{0,30}?\\b(?:for|until)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  // Duration-then-action: the intrinsically-re-entry tails (re-enter,
  // re-entry, dry) match bare; the AMBIGUOUS tails (return, go back, walk,
  // play) require treated/application context in the same sentence — "wait
  // 30 minutes before returning to check whether ants took the bait" is
  // timing advice, not a re-entry figure (Codex PR r1).
  // The intrinsically-re-entry tails stay bare; the DRY tail needs
  // treatment context (Codex PR r5: "the caulk needs 30 minutes to dry
  // before inspection" is maintenance advice, not a pesticide figure).
  `\\b(?:wait|allow|give\\s+it|requires?|needs?|takes?)\\s+(?:for\\s+)?${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b[^.!?\\n]{0,50}?\\b(?:re-?enter\\w*|re-?entry)`,
  { src: `\\b(?:wait|allow|give\\s+it|requires?|needs?|takes?)\\s+(?:for\\s+)?${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b[^.!?\\n]{0,50}?\\bdry\\w*`, needsTreatmentContext: true },
  `\\b(?:wait|allow|give\\s+it|requires?|needs?|takes?)\\s+(?:for\\s+)?${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b[^.!?\\n]{0,50}?\\b(?:enter\\w*|return\\w*|go(?:ing)?\\s+(?:back|outside|inside|out|indoors|outdoors)|walk\\w*|play\\w*)\\b[^.!?\\n]{0,50}?\\b(?:treated|treatment|application|sprayed|lawn|yard|turf|grass|inside|indoors|home|house)\\b`,
  // Treatment context may PRECEDE the action instead of following it
  // (Codex PR r11 audit: "wait 30 minutes after treatment before going
  // outside") — the NARROW treated/treatment/application/sprayed anchor
  // keeps the r1 bait-timing exemption intact ("returning to check
  // whether ants took the bait" has none of these words).
  `\\b(?:wait|allow|give\\s+it|requires?|needs?|takes?)\\s+(?:for\\s+)?${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b[^.!?\\n]{0,50}?\\b(?:treated|treatment|application|sprayed)\\b[^.!?\\n]{0,50}?\\b(?:enter\\w*|return\\w*|go(?:ing)?\\s+(?:back|outside|inside|out|indoors|outdoors)|walk\\w*|play\\w*|leav\\w+)`,
  // Object-first drying: "allow the spray to dry for 30 minutes" — a
  // TREATMENT noun is required in the clause (Codex PR r4: "allow the caulk
  // to dry" is home-maintenance advice, not a pesticide figure).
  `\\b(?:treatments?|products?|pesticides?|insecticides?|herbicides?|sprays?|applications?|granules?|baits?|chemicals?)\\b[^.!?\\n]{0,40}?\\b(?:to\\s+dry|dry(?:ing)?)\\s+for\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  // Plain ENTER with treatment context anywhere in the sentence — before
  // or after the duration (Codex PR r4, widened PR r6: "you can enter
  // after 30 minutes once treatment is complete"), plus the passive
  // "the room can be entered 30 minutes after treatment" order.
  { src: `\\benter\\w*\\b[^.!?\\n]{0,40}?\\b(?:in|within|after)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  { src: `\\bbe\\s+(?:entered|re-?occupied)\\b[^.!?\\n]{0,20}?${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // Affirmative go-inside/go-into with treatment context (Codex PR r8:
  // "you may go inside after 30 minutes once treatment is complete") —
  // the do-not branch covers the prohibitive forms.
  { src: `\\bgo\\s+(?:back\\s+)?(?:inside|into|in)\\b[^.!?\\n]{0,40}?\\b(?:in|within|after)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // Articles/possessives before the subject and indoors/outdoors
  // locations count too (Codex PR r11 audit: "keep the family indoors
  // for 30 minutes after treatment"). Keep-off-the-LAWN is intrinsically
  // an application instruction; every other location needs treatment
  // context (Codex PR r12: "keep the family indoors during a
  // thunderstorm" and "keep pets off the couch" are not re-entry).
  `\\bkeep\\s+(?:the\\s+|your\\s+)?(?:pets?|kids?|children|dogs?|cats?|everyone|people|famil(?:y|ies))\\b[^.!?\\n]{0,40}?\\b(?:off|out\\s+of|away\\s+from)\\b[^.!?\\n]{0,30}?\\b(?:lawns?|yards?|turf|grass|gardens?|soil|beds?)\\b[^.!?\\n]{0,40}?\\b(?:for|until)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  { src: `\\bkeep\\s+(?:the\\s+|your\\s+)?(?:pets?|kids?|children|dogs?|cats?|everyone|people|famil(?:y|ies))\\b[^.!?\\n]{0,40}?\\b(?:off|out|away|inside|indoors|outdoors|outside)\\b[^.!?\\n]{0,40}?\\b(?:for|until)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // "stay off the lawn for 30 minutes", "do not re-enter for 30 minutes"
  // off/out-of/away-from are intrinsically keep-off-the-surface; the
  // inside/outside/outdoors locations need treatment context (Codex PR
  // r10 + r11: "remain outside the treated room" is a re-entry figure,
  // "stay outdoors for 30 minutes each morning to inspect your yard"
  // is activity advice).
  `\\b(?:stay|remain)\\s+(?:off|out\\s+of|away\\s+from)\\b[^.!?\\n]{0,40}?\\b(?:for|until)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  { src: `\\b(?:stay|remain)\\s+(?:inside|outside|outdoors)\\b[^.!?\\n]{0,40}?\\b(?:for|until)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // Noun-first re-entry figures (Codex PR r11): "the recommended
  // re-entry interval is 30 minutes", "the re-entry period lasts 30
  // minutes".
  `\\bre-?(?:entry|occupation)\\s+(?:intervals?|periods?|windows?|times?|waits?)\\s+(?:\\w+\\s+){0,2}?(?:is|are|lasts?|runs?|takes?|equals?)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  // go-inside/go-into count as the entry action too (Codex PR r7: "Do not
  // go inside the treated home for 30 minutes").
  `\\b(?:do\\s+not|don['’]?t|avoid)\\s+(?:re-?enter\\w*|enter\\w*|return\\w*|walk\\w*|play\\w*|go\\s+(?:back|inside|into|in)\\b)[^.!?\\n]{0,30}?\\b(?:for|until|after)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`,
  // "needs 30 minutes to dry", "30 minutes of drying" — treatment context
  // required (Codex PR r5).
  { src: `\\b${REENTRY_DURATION_SRC}\\s+(?:to\\s+dry|of\\s+drying)\\b`, needsTreatmentContext: true },
  // Noun-first drying figures: "drying takes 30 minutes", "the drying time
  // is 30 minutes" — treatment context required (Codex PR r5: "Paint
  // drying takes 30 minutes" is maintenance advice). The treatment may sit
  // BETWEEN drying and its verb (Codex PR r6: "Drying the treatment takes
  // 30 minutes"), and "has a drying time of 30 minutes" is the same figure.
  { src: `\\bdry(?:ing)?(?:\\s+time|\\s+period|\\s+window)?\\b[^.!?\\n]{0,40}?\\b(?:takes?|is|runs?|lasts?)\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // "dry time" is the same noun as "drying time" (Codex PR r9: "has a
  // dry time of 30 minutes").
  { src: `\\bdry(?:ing)?\\s+time\\s+of\\s+${REENTRY_QUALIFIER_SRC}${REENTRY_DURATION_SRC}\\b`, needsTreatmentContext: true },
  // Attributive figures, hyphenated or not: "a 30 minute re-entry
  // interval", "a 45-minute re-entry window" — the re-entry/wait tails are
  // intrinsic; the drying tail needs treatment context (Codex PR r5).
  // The full spelled-number grammar applies attributively too (Codex PR
  // r11 audit: "a twelve-minute dry time").
  `\\b(?:\\d+|${REENTRY_SPELLED_NUM_SRC})[-‑\\s]\\s?(?:minute|min|hour|hr|second|sec|day|week)\\s+(?:re-?entry|wait(?:ing)?)\\b`,
  { src: `\\b(?:\\d+|${REENTRY_SPELLED_NUM_SRC})[-‑\\s]\\s?(?:minute|min|hour|hr|second|sec|day|week)\\s+dry(?:ing)?\\b`, needsTreatmentContext: true },
];

// The APPROVED conditional idiom has TWO required parts (AGENTS.md): the
// dry condition ("safe once dry" — condition before or after the claim,
// same sentence) AND the technician-confirms-timing clause, which may sit
// in a neighboring sentence.
// The condition must be an actual DRY-STATE condition: "when wet or dry"
// (a claim of safety in EVERY state) is not a condition at all — the window
// rejects "wet" and the alternation suffix ("dry or wet") likewise.
const DRY_CONDITION_RE = /\b(?:once|when|after|until)\b(?:(?!\bwet\b)[^.!?\n]){0,40}?\b(?:fully\s+|completely\s+)?dr(?:y|ies|ied)\b(?!\s*(?:or|and)\s+wet\b)/i;
// The confirmation must CONCERN re-entry timing — "your technician
// confirms the appointment address" is not the idiom's second part, and
// neither is "confirms the appointment TIME" (Codex PR r6): bare
// time/when are scheduling words, so only "timing", explicit
// re-entry/dry/safe objects, or a when-clause that itself concerns
// safety/re-entry count.
const TECH_CONFIRMS_RE = /\b(?:technicians?|techs?|applicators?|pros?)\b[^.!?\n]{0,60}?\b(?:confirms?|will\s+confirm|advises?(?:\s+on)?|verif(?:y|ies)|lets?\s+you\s+know)\b[^.!?\n]{0,30}?\b(?:timing|re-?entry|dry\w*|safe\b|all[-\s]clear|when\s+[^.!?\n]{0,25}?\b(?:safe|re-?ent\w+|dry\w*|return\w*|go\s+back)\b)|\b(?:technicians?|techs?|applicators?|pros?)\b[^.!?\n]{0,60}?\bgives?\s+you\s+the\s+all[-\s]clear\b|\bconfirms?\s+(?:the\s+)?(?:timing|re-?entry)\b/i;

// The two hard-copy classifiers scan RENDERED text (Codex PR r12):
// "We offer **wildlife removal**" and "[wildlife removal](/x/)" carry
// the same prohibited claim once the Markdown delimiters render away.
function normalizeHardCopyText(text) {
  return String(text || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|[*`])/g, '');
}

function reentrySafetyClaimFinding(text) {
  const s = normalizeHardCopyText(text);
  for (const entry of REENTRY_SAFETY_SRCS) {
    const src = typeof entry === 'string' ? entry : entry.src;
    const re = new RegExp(src, 'gi');
    let m;
    while ((m = re.exec(s)) !== null) {
      const before = s.slice(Math.max(0, m.index - 80), m.index);
      const sentenceBreak = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
      const sameSentence = sentenceBreak >= 0 ? before.slice(sentenceBreak + 1) : before;
      const afterMatch = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const afterSameSentence = afterMatch.split(/[.!?\n]/)[0];
      // The dry condition may sit before, inside, or after the matched
      // span (context-anchored patterns can swallow "once the application
      // dries" into the match) — test the FULL sentence.
      const fullSentence = `${sameSentence}${m[0]}${afterSameSentence}`;
      // Drying forms with no intrinsic re-entry word only count as the
      // banned figure in pesticide context (Codex PR r5) — "Paint drying
      // takes 30 minutes" stays legal maintenance advice.
      if (typeof entry === 'object' && entry.needsTreatmentContext && !REENTRY_TREATMENT_CONTEXT_RE.test(fullSentence)) {
        if (m.index === re.lastIndex) re.lastIndex += 1;
        continue;
      }
      // Pronoun subjects need an unambiguous treatment antecedent in the
      // GOVERNING window — the current sentence plus the one immediately
      // before it, not just any treatment word within 220 chars (Codex PR
      // r5, scoped PR r6): "The pesticide is applied outdoors. The
      // repaired screen prevents entry. It is safe for pets." keeps the
      // screen as the antecedent and stays legal.
      if (typeof entry === 'object' && entry.needsTreatmentAntecedent) {
        const before220 = s.slice(Math.max(0, m.index - 220), m.index);
        const governing = before220.split(/[.!?\n]/).slice(-2).join(' ');
        if (!REENTRY_TREATMENT_CONTEXT_RE.test(governing)) {
          if (m.index === re.lastIndex) re.lastIndex += 1;
          continue;
        }
      }
      // A DURATION finding is prohibited in EVERY polarity — "Do not
      // re-enter after 30 minutes" IS the banned fixed figure, so the
      // disclaimer exemptions below must not shield it (Codex audit).
      const isDurationFinding = /\b(?:minutes?|mins?|hours?|hrs?|hour|seconds?|secs?|days?|weeks?|day|week)\b/i.test(m[0]);
      // "no product is completely safe", "we never call a treatment safe",
      // "isn't safe to re-enter until dry" — honest disclaimers, keep.
      if (!isDurationFinding
        && (DIRECT_NEGATION_BEFORE_RE.test(sameSentence) || NEGATED_SUBJECT_BEFORE_RE.test(sameSentence))) {
        if (m.index === re.lastIndex) re.lastIndex += 1;
        continue;
      }
      // The approved CONDITIONAL idiom — only for "safe"/"safely" phrasing
      // (a fixed minute figure is banned even when a dry-condition is
      // nearby, and the AGENTS.md idiom is literally "safe once dry" —
      // "harmless"/"risk-free" claims stay blocking even with both idiom
      // parts, Codex PR r5 audit). BOTH parts are required (Codex audit):
      // the dry condition in the same sentence AND the
      // technician-confirms-timing clause, which may sit in a neighboring
      // sentence (±240 chars).
      const isSafeClaim = /safe/i.test(m[0]);
      if (isSafeClaim) {
        const neighborhood = s.slice(Math.max(0, m.index - 240), m.index + m[0].length + 240);
        if (DRY_CONDITION_RE.test(fullSentence) && TECH_CONFIRMS_RE.test(neighborhood)) {
          if (m.index === re.lastIndex) re.lastIndex += 1;
          continue;
        }
      }
      return finding('P0', 'REENTRY_SAFETY_CLAIM', `Safety/re-entry compliance violation "${m[0].trim()}" — no pesticide or treated area is ever unconditionally "safe", "EPA-approved" is never used (say EPA-registered/EPA-exempt), and re-entry/drying never carries a fixed minute figure. The approved idiom is CONDITIONAL: "safe once dry" with the technician confirming timing.`);
    }
  }
  return null;
}

// ── Banned service topics (P0 BANNED_TOPIC) ────────────────────────────────
// Waves does NOT offer door-to-door sales, structural fumigation/tenting,
// insulation work, or wildlife/animal trapping. A draft presenting any of
// these as OUR services misrepresents the company. INFORMATIONAL mentions
// stay legal by construction (same idiom as the comparison gate's
// require-lookahead: "severe drywood infestations may call for tent
// fumigation" carries no first-person service anchor). The first-person
// filler is negation-guarded, so the wanted disclaimer ("we do not offer
// fumigation — we refer you to…") stays legal too.
// CORE topics are service-unambiguous in ANY first-person frame.
// INSULATION is deliberately excluded from the broad-verb ownership pattern
// (Codex PR r1): "our technicians handle attic insulation carefully while
// checking for rodent entry points" is accurate INSPECTION copy — insulation
// only flags with installation/sale/service context (the install pattern,
// the possessive-service pattern, and the CTA/sales patterns, which are
// service-context by construction).
// Generic relocation/exclusion/eviction NOUN forms are the same offering
// as trapping/removal (Codex PR r5: "our wildlife relocation service",
// "we offer wildlife exclusion"). "animal control" stays out — it names
// the county agency in legal referral copy ("contact animal control").
const BANNED_TOPIC_CORE_SRC = "(?:structural\\s+)?(?:fumigat\\w+|tent(?:ing)?\\b|wildlife\\s+(?:trapping|removal|control|relocation|exclusion|eviction)|animal\\s+(?:trapping|removal|relocation|exclusion|eviction)|(?:raccoons?|squirrels?|opossums?|armadillos?|bats?|snakes?|birds?)\\s+(?:removal|trapping|eviction|exclusion|control|relocation)|door[-\\s]?to[-\\s]?door)";
const BANNED_TOPIC_SRC = `(?:${BANNED_TOPIC_CORE_SRC}|insulation)`;
// The object gap between the service verb and the topic must be
// negation-guarded exactly like the pre-verb filler — otherwise "We do NOT
// offer fumigation" matches through the bare "do" verb with "not offer"
// absorbed by the gap. Hyphens allowed ("whole-structure fumigation").
const BANNED_TOPIC_GAP_SRC = `(?:(?!${NEGATION_WORD_SRC}\\b)[\\w'’-]+\\s+){0,3}?`;
// Content nouns that make a possessive INFORMATIONAL rather than a
// service claim (Codex PR r5, extended r6): "our guide to wildlife
// removal explains…", "our report on wildlife removal…".
const BANNED_TOPIC_INFO_NOUN_SRC = "(?:guides?|articles?|posts?|pages?|blogs?|overviews?|explainers?|resources?|advice|primers?|faqs?|breakdowns?|comparisons?|information|reports?|research|glossar(?:y|ies)|summar(?:y|ies)|explanations?|reviews?|coverage|discussions?|checklists?|handbooks?|manuals?|playbooks?|worksheets?|walkthroughs?|tutorials?)";
// Action-verb patterns must not absorb a THIRD-PARTY subject in their
// filler (Codex PR r6): "we help specialists remove wildlife" and "we
// have partners trap wildlife" attribute the work to someone else — the
// wanted referral copy, same exemption the possessive branch carries.
const BANNED_TOPIC_ACTION_FILLER_SRC = `(?:(?!${NEGATION_WORD_SRC}\\b|partners?\\b|specialists?\\b|professionals?\\b|contractors?\\b|trappers?\\b|experts?\\b)[\\w'’]+\\s+){0,2}?`;
// The insulation object gap must not match THROUGH inspection artifacts
// (Codex PR r6): "we can provide photos of attic insulation during the
// inspection" is rodent-inspection copy, not an insulation offering.
// Nor through installable OBJECTS or location prepositions (Codex PR r7):
// "our technicians install traps above attic insulation" installs traps —
// insulation is merely the location.
const BANNED_TOPIC_INSULATION_GAP_SRC = `(?:(?!${NEGATION_WORD_SRC}\\b|${BANNED_TOPIC_INFO_NOUN_SRC}\\b|photos?\\b|pictures?\\b|images?\\b|records?\\b|observations?\\b|documentation\\b|videos?\\b|footage\\b|notes?\\b|evidence\\b|traps?\\b|stations?\\b|monitors?\\b|baits?\\b|barriers?\\b|above\\b|below\\b|under\\b|underneath\\b|beneath\\b|behind\\b|over\\b|near\\b|around\\b|beside\\b|atop\\b|inside\\b|into\\b|onto\\b|within\\b)[\\w'’-]+\\s+){0,3}?`;
const BANNED_TOPIC_SRCS = [
  // "we/Waves/our team|services offer(s)/include(s)/help(s) with … <topic>"
  // — CORE topics only for the BROAD verbs (see BANNED_TOPIC_CORE_SRC).
  // The object gap refuses informational framing nouns too (Codex PR r9):
  // "we provide information about wildlife removal" / "Waves provides a
  // guide to wildlife removal" offer CONTENT about the topic, not the
  // service — the same exemption the possessive branch carries.
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?|services?|programs?|plans?|offerings?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${NON_NEGATED_FILLER_SRC}(?:(?:proud|pleased|happy|excited|glad|ready)\\s+to\\s+)?(?:offers?|provides?|performs?|do(?:es)?\\b|handles?|includes?|specializ\\w+\\s+in|delivers?|helps?\\s+with|assists?\\s+with|takes?\\s+care\\s+of|covers?|conducts?|manag(?:es?|ing)|carr(?:y|ies|ied)\\s+out)\\s+(?:(?!${NEGATION_WORD_SRC}\\b|${BANNED_TOPIC_INFO_NOUN_SRC}\\b|referrals?\\b|partners?\\b|specialists?\\b)[\\w'’-]+\\s+){0,3}?${BANNED_TOPIC_CORE_SRC}\\b(?!\\s+(?:referrals?|partners?|specialists?|${BANNED_TOPIC_INFO_NOUN_SRC}\\b))`,
  // Insulation with SERVICE-UNAMBIGUOUS verbs only.
  // The insulation branch carries the full offering-verb set (Codex PR
  // r11 audit: "we specialize in attic insulation", "we can help with
  // attic insulation") — handle/tackle stay OUT so the r1 inspection
  // exemption ("handle attic insulation carefully") holds.
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?|services?|programs?|plans?|offerings?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${NON_NEGATED_FILLER_SRC}(?:(?:proud|pleased|happy|excited|glad|ready)\\s+to\\s+)?(?:offers?|provides?|sells?|installs?|replaces?|specializ\\w+\\s+in|helps?\\s+with|assists?\\s+with|takes?\\s+care\\s+of|delivers?|conducts?|manag(?:es?|ing)|carr(?:y|ies|ied)\\s+out)\\s+${BANNED_TOPIC_INSULATION_GAP_SRC}insulation\\b`,
  // Work/project phrasing is an unambiguous insulation OFFERING even with
  // the broad verbs the bare-noun branch excludes (Codex PR r6): "we
  // perform attic insulation work" — the trailing work-noun is what
  // separates it from the legal "handle attic insulation carefully"
  // inspection copy.
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${NON_NEGATED_FILLER_SRC}(?:do(?:es)?\\b|perform\\w*|complet\\w*|handles?|tackles?)\\s+${BANNED_TOPIC_GAP_SRC}insulation\\s+(?:work|projects?|jobs?|installs?|installations?|services?|upgrades?)\\b`,
  // Bare POSSESSIVE ownership — "our fumigation treatment", "our wildlife
  // removal keeps your attic quiet", with or without a service noun (Codex
  // PR r1) and with bounded, negation-guarded modifiers ("our professional
  // wildlife removal", "our humane raccoon removal" — Codex PR r2);
  // referral/partner attributions stay legal.
  // Referral framing is exempt on EITHER side of the topic (Codex PR r3):
  // "our referral for wildlife removal goes to licensed partners" is the
  // wanted language — the modifier gap must not absorb referral nouns.
  // Content nouns are exempt the same way (Codex PR r5): "our guide to
  // wildlife removal" / "our wildlife removal guide" introduce the TOPIC,
  // not an offered service — exactly the informational treatment the
  // policy permits. Company-name possessives count as ownership (Codex
  // PR r5): "Waves' fumigation service" is the same claim as "our
  // fumigation service" — apostrophe REQUIRED so "Waves Pest Control
  // fumigation alternatives" prose stays out of this anchor.
  `\\b(?:our|waves(?:\\s+pest\\s+control)?['’]s?)\\s+(?:(?!${NEGATION_WORD_SRC}\\b|referrals?\\b|partners?\\b|specialists?\\b|${BANNED_TOPIC_INFO_NOUN_SRC}\\b)[\\w-]+\\s+){0,2}?${BANNED_TOPIC_SRC}\\b(?!\\s+(?:referrals?|partners?|specialists?|${BANNED_TOPIC_INFO_NOUN_SRC}\\b))`,
  // Topic-specific ownership verbs: "we install attic insulation", "our
  // technicians trap wildlife", "we remove raccoons", "we sell
  // door-to-door" — ownership expressed through the ACTION verb rather
  // than offer/provide.
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${NON_NEGATED_FILLER_SRC}installs?\\s+${BANNED_TOPIC_INSULATION_GAP_SRC}insulation\\b`,
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${BANNED_TOPIC_ACTION_FILLER_SRC}(?:traps?|trapping|removes?|relocates?|catch(?:es)?|evicts?)\\s+${BANNED_TOPIC_GAP_SRC}(?:wildlife|animals?|raccoons?|squirrels?|opossums?|armadillos?|bats?|snakes?|birds?)\\b`,
  // EXCLUDE also means "omit" (Codex PR r6): only a physical
  // location/entry-point tail makes it the wildlife-exclusion service —
  // "we exclude wildlife examples from this comparison" stays legal.
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${BANNED_TOPIC_ACTION_FILLER_SRC}exclud(?:es?|ing)\\s+${BANNED_TOPIC_GAP_SRC}(?:wildlife|animals?|raccoons?|squirrels?|opossums?|armadillos?|bats?|snakes?|birds?)\\b[^.!?\\n]{0,30}?\\b(?:from\\b[^.!?\\n]{0,20}?\\b(?:attics?|homes?|houses?|structures?|buildings?|crawl\\s?spaces?|soffits?|roofs?|eaves|walls?|properties|property|gara?ges?|sheds?|yards?|chimneys?|vents?)|entry\\s+points?)\\b`,
  // Get-out paraphrase of wildlife removal: "we get raccoons out of your
  // attic", "our team gets squirrels out" (Codex PR r3).
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${BANNED_TOPIC_ACTION_FILLER_SRC}(?:get(?:s|ting)?|took|take(?:s|n|ing)?)\\s+${BANNED_TOPIC_GAP_SRC}(?:wildlife|animals?|raccoons?|squirrels?|opossums?|armadillos?|bats?|snakes?|birds?)\\b[^.!?\\n]{0,20}?\\bout\\b`,
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${NON_NEGATED_FILLER_SRC}(?:sell|market|canvass)\\w*\\s+${BANNED_TOPIC_GAP_SRC}door[-\\s]?to[-\\s]?door\\b`,
  // Direct banned-service verbs: "we fumigate homes", "our technicians
  // tent homes across Sarasota" — ownership expressed as the action itself.
  // The trailing guard keeps noun usage reached through the filler out
  // ("we offer fumigation REFERRALS" — Codex PR r11 audit); the \b stops
  // \w+ backtracking around the lookahead.
  `\\b(?:we|waves(?:\\s+pest\\s+control)?|our\\s+(?:team|techs?|technicians?|company|crews?)|let\\s+(?:us|our\\s+(?:team|techs?|technicians?|company|crews?)))\\s+${NON_NEGATED_FILLER_SRC}(?:fumigat\\w+|tents?\\b)\\b(?!\\s+(?:referrals?|partners?|specialists?|${BANNED_TOPIC_INFO_NOUN_SRC}\\b))`,
  // "schedule/book (your) fumigation …" — on OUR pages a bare CTA presents
  // the topic as our service even without "with us" (Codex audit). A
  // THIRD-PARTY referral stays legal via the negative lookahead: "schedule
  // tenting with a licensed structural fumigator" directs elsewhere.
  `\\b(?:schedule|book)\\s+(?:your\\s+|a\\s+|an\\s+)?${BANNED_TOPIC_GAP_SRC}${BANNED_TOPIC_SRC}(?:\\s+(?:services?|treatments?|appointments?|visits?|consultations?|quotes?|estimates?))?\\b(?!\\s+(?:with|through)\\s+(?!us\\b|waves\\b))`,
  `\\b(?:call|contact|text|email|ask)\\s+(?:us|waves(?:\\s+pest\\s+control)?)\\s+(?:today\\s+)?(?:for|about)\\s+${BANNED_TOPIC_GAP_SRC}${BANNED_TOPIC_SRC}`,
  // Sales framings: "request a fumigation quote from Waves", "get attic
  // insulation from Waves", "choose Waves for wildlife trapping".
  `\\b(?:request|order|get|book)\\s+(?:a\\s+|an\\s+|your\\s+)?${BANNED_TOPIC_GAP_SRC}${BANNED_TOPIC_SRC}(?:\\s+(?:quotes?|estimates?|services?|appointments?))?\\s+(?:from|with|through)\\s+(?:us|waves(?:\\s+pest\\s+control)?)\\b`,
  `\\b(?:choose|pick|hire|trust)\\s+(?:us|waves(?:\\s+pest\\s+control)?)\\s+for\\s+${BANNED_TOPIC_GAP_SRC}${BANNED_TOPIC_SRC}`,
];

function bannedTopicFinding(text) {
  const s = normalizeHardCopyText(text);
  for (const src of BANNED_TOPIC_SRCS) {
    const re = new RegExp(src, 'gi');
    let m;
    while ((m = re.exec(s)) !== null) {
      const before = s.slice(Math.max(0, m.index - 80), m.index);
      const sentenceBreak = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
      const sameSentence = sentenceBreak >= 0 ? before.slice(sentenceBreak + 1) : before;
      // "we do not offer fumigation", "no, our team doesn't do tenting" —
      // the wanted referral phrasing.
      if (DIRECT_NEGATION_BEFORE_RE.test(sameSentence) || NEGATED_SUBJECT_BEFORE_RE.test(sameSentence)) {
        if (m.index === re.lastIndex) re.lastIndex += 1;
        continue;
      }
      return finding('P0', 'BANNED_TOPIC', `Draft presents a service Waves does not offer: "${m[0].trim()}" — door-to-door sales, structural fumigation/tenting, insulation, and wildlife/animal trapping are never our services. Keep any mention purely informational (what it is, when a specialist is needed) with no we/our/schedule/call framing.`);
    }
  }
  return null;
}

// Owner hard rule (2026-07-16): service/location metaTitles are never edited
// by automation. Fires only on refresh drafts AND only when the caller
// supplied the live metaTitle to compare against — a null liveMetaTitle means
// either a non-service target (blog pages don't carry the protected field
// contract) or a caller without the live page, where publishRefresh's field
// freeze is the remaining backstop.
function metaTitleRewriteFinding(frontmatter, { isRefresh = false, liveMetaTitle = null } = {}) {
  if (!isRefresh || liveMetaTitle == null || !String(liveMetaTitle).trim()) return null;
  const draftTitle = frontmatter?.metaTitle;
  if (draftTitle === undefined || !String(draftTitle).trim()) return null; // absent → publisher keeps the live value
  if (String(draftTitle).trim() === String(liveMetaTitle).trim()) return null;
  return finding('P0', 'PROTECTED_META_TITLE_REWRITE',
    `Refresh draft proposes a different metaTitle ("${String(draftTitle).trim().slice(0, 80)}") than the live page's ${String(liveMetaTitle).length}-char metaTitle — service/location metaTitles are never edited (owner rule 2026-07-16). Carry the live metaTitle unchanged or omit the field.`);
}

// Owner rule 2026-07-29: NON-BLOG meta descriptions carry the page's phone as
// the {{cityPhone}} TOKEN (pages render on many domains with different
// tracking numbers — a typed-out number shows the wrong phone); BLOG metas
// carry NO phone and nothing salesy (informational summary + a soft CTA like
// "Learn more on the Waves blog"); every meta caps at 160 rendered chars.
// Enforced here for REFRESH drafts that CHANGE the meta (an unchanged
// carried-over meta is grandfathered — most legacy blog metas predate the
// rule, and parking a body-only refresh on an untouched meta would block the
// whole refresh lane). The metadata-rewrite lane gets the same contract from
// the quality gate's meta_phone_token_present + meta_length_in_bounds.
const LITERAL_PHONE_IN_META_RE = /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/;
function metaDescriptionContractFinding(frontmatter, { isRefresh = false, liveMetaDescription = null, targetIsBlog = false } = {}) {
  // SALESY/SOFT-CTA/token definitions shared with the quality gate (single
  // source in title-meta-spam-gate) so the enforcement points can't drift.
  // PHONE_TOKEN_RE covers the publisher's full substitution grammar —
  // whitespace-tolerant, and the phone/tel aliases render a phone too.
  const { SALESY_META_RE, PHONE_TOKEN_RE, CITY_PHONE_TOKEN_RE, endsWithSoftCta, metaHasSalesCopy, BARE_PHONE_DIGITS_RE } = require('./title-meta-spam-gate');
  // Runs on refresh drafts (both contracts, changed metas only) AND on any
  // caller that declares a blog target — the legacy BlogWriter/admin/
  // calendar publishAstro path runs ONLY guardrails (no supporting-blog
  // quality bundle), so gating on isRefresh alone let a scheduled blog meta
  // ship "{{cityPhone}}" or sales copy untouched. A NEW blog meta is always
  // "changed", so the grandfather clause simply never matches there.
  if (!isRefresh && !targetIsBlog) return null;
  const draftMeta = frontmatter?.metaDescription ?? frontmatter?.meta_description;
  if (draftMeta === undefined || !String(draftMeta).trim()) return null; // absent → publisher keeps the live value
  const draftTrim = String(draftMeta).trim();
  // Unchanged vs the caller-supplied live/original value → grandfathered.
  // Refresh passes the live page's meta; remediation passes the pre-fix
  // file's meta; publishAstro (new posts) passes NONE — a new meta is always
  // graded in full.
  if (liveMetaDescription != null && draftTrim === String(liveMetaDescription).trim()) return null;
  if (targetIsBlog) {
    // BARE_PHONE_DIGITS_RE: separator-less "9412972606" slips the shaped
    // regex and the PII scan (known business number) — Codex r4.
    if (PHONE_TOKEN_RE.test(draftTrim) || LITERAL_PHONE_IN_META_RE.test(draftTrim) || BARE_PHONE_DIGITS_RE.test(draftTrim)) {
      return finding('P1', 'BLOG_META_CARRIES_PHONE', 'Blog meta descriptions never carry a phone number (owner rule 2026-07-29: informational summary + soft CTA only).');
    }
    if (SALESY_META_RE.test(draftTrim) || metaHasSalesCopy(draftTrim)) {
      return finding('P1', 'BLOG_META_SALESY', 'Blog meta descriptions stay informational — no sales CTAs or money/deal terms in the final sentence (owner rule 2026-07-29).');
    }
  } else {
    // {{cityPhone}} SPECIFICALLY — phone/tel aliases render the generic line.
    if (!CITY_PHONE_TOKEN_RE.test(draftTrim)) {
      return finding('P1', 'META_MISSING_PHONE_TOKEN', 'Rewritten meta description must contain the {{cityPhone}} token (owner rule 2026-07-29: every non-blog meta carries the page\'s own phone number — phone/tel aliases render the generic line).');
    }
    if (LITERAL_PHONE_IN_META_RE.test(draftTrim)) {
      return finding('P1', 'LITERAL_PHONE_IN_META', 'Meta description contains a typed-out phone number — use the {{cityPhone}} token so each domain renders its own tracking number.');
    }
  }
  const { renderMetaTokens } = require('./title-meta-spam-gate');
  const rendered = renderMetaTokens(draftTrim).trim();
  if (rendered.length > 160) {
    return finding('P1', 'META_OVER_160_RENDERED', `Rewritten meta description renders at ${rendered.length} characters — the cap is 160 (owner rule 2026-07-29).`);
  }
  // LAST, after every P1: the soft-CTA ending is a nudge, never a blocker
  // (owner ruling 2026-07-30) — P2 warns without parking, and the legacy
  // BlogWriter/admin/calendar publishAstro lanes (which run ONLY guardrails,
  // no supporting-blog quality bundle) keep the signal. Ordered here so this
  // single-finding return can never mask a blocking P1 like
  // META_OVER_160_RENDERED (Codex r2 P1).
  if (targetIsBlog && !endsWithSoftCta(draftTrim)) {
    return finding('P2', 'BLOG_META_MISSING_SOFT_CTA', 'Blog meta descriptions should END with a soft CTA like "Learn more on the Waves blog." (nudge only — owner ruling 2026-07-30: never a publish blocker).');
  }
  return null;
}

// A typed-out phone in a draft TITLE ships the wrong tracking number on every
// other domain (titles are multi-domain like metas). Applies to every
// body-content lane — no grandfathering: no live title legitimately carries a
// literal number.
function literalPhoneInTitleFinding(frontmatter) {
  for (const field of ['title', 'metaTitle']) {
    const v = frontmatter?.[field];
    if (v !== undefined && LITERAL_PHONE_IN_META_RE.test(String(v))) {
      return finding('P1', 'LITERAL_PHONE_IN_TITLE', `Draft ${field} contains a typed-out phone number — titles never carry literal numbers (pages render on many domains with different tracking numbers).`);
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
function evaluate(draft, { service = null, primaryKeyword = null, domains = null, operatorFaqException = false, requiredSourceUrls = [], operatorCitations = false, competitorPriceCitations = false, forbidAllPrices = false, allowedInternalLinks = [], isRefresh = false, priorBody = null, liveMetaTitle = null, liveMetaDescription = null, targetIsBlog = false } = {}) {
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
  // The 2026-07-29 meta contract REQUIRES {{cityPhone}} in non-blog meta
  // DESCRIPTIONS; it renders through the domains pipeline, not MDX, so the
  // executable-expression P0 must not see it there (it exists for .mdx
  // BODIES, which are scanned unscrubbed). Scrubbed HERE so every caller —
  // gate 3c, the in-loop self-lints, the metadata handler — inherits one
  // behavior. DESCRIPTION FIELDS ONLY: a {{cityPhone}} in a title,
  // metaTitle, or hero alt has no sanctioned use and stays fully validated.
  const editableMeta = ['title', 'metaTitle', 'meta_description', 'metaDescription']
    .concat(isRefresh ? [] : ['hero_image_alt'])
    .map((f) => {
      const v = frontmatter[f];
      if (!v) return v;
      return (f === 'meta_description' || f === 'metaDescription')
        ? String(v).replace(SANCTIONED_META_TOKEN_RE, '')
        : v;
    })
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
    // Price must cover everything that ships: body AND meta. Third-party
    // price citations carry their OWN flag, stricter than operatorCitations:
    // category/spoke seeds share the operator_intercept bucket and DO get
    // citation hosts, but only true competitor-intercept briefs may cite
    // competitor prices (Codex: seed lanes auto-publish informational posts
    // and must keep the full price guard).
    priceFinding(publishableText, { thirdPartyCitations: competitorPriceCitations, forbidAllPrices, operatorCitations, requiredSourceUrls }),
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
    // Compliance language + banned service topics ship in meta just like in
    // body — full publishable text, every lane, no exemptions (W2: the
    // rules were prompt-only until this deterministic backstop).
    reentrySafetyClaimFinding(publishableText),
    bannedTopicFinding(publishableText),
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
    // Owner hard rule (2026-07-16): service/location metaTitles — the
    // intentional long near-me titles — are NEVER edited by automation. A
    // refresh draft that proposes a DIFFERENT metaTitle than the live page is
    // parked for review rather than published (found live in three parked
    // 2026-07 drafts that would have replaced ~2,000-char metaTitles with
    // short generic ones). Only enforceable when the caller supplied the live
    // value (the runner's fail-closed liveFm load does); publishRefresh
    // independently freezes the field as the last-resort backstop. An ABSENT
    // or identical draft metaTitle is fine — the publisher keeps the live one.
    metaTitleRewriteFinding(frontmatter, { isRefresh, liveMetaTitle }),
    // Owner rule 2026-07-29: a refresh that CHANGES the meta description must
    // carry {{cityPhone}}, never a literal number, and stay ≤160 rendered.
    metaDescriptionContractFinding(frontmatter, { isRefresh, liveMetaDescription, targetIsBlog }),
    // Typed-out phone in a draft title — wrong number on every other domain.
    literalPhoneInTitleFinding(frontmatter),
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
  isThirdPartyPriceCitation,
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
  isKnownGoodInternalRoute,
  // deterministic pre-gate repair for unambiguous citation artifacts —
  // consumed by brief-driven-tools emit_draft; kept here beside
  // CITATION_RESIDUE_RE so stripper and detector can never drift.
  stripCitationResidue,
  PAGE_CITY_SLUGS,
  OUT_OF_AREA_CITY_CANDIDATES,
  // Exported for tests; evaluate() scrubs it from META fields internally,
  // so callers need no pre-scrub of their own.
  SANCTIONED_META_TOKEN_RE,
  outOfAreaCities,
  _internals: { priceFinding, brandTokenFinding, faqBlockedFinding, keywordStuffingFinding, blockedServiceCandidates, BLOCKED_SERVICE_ALIASES, externalLinkFinding, allowedLinkHosts, hostAllowed, curatedCompetitorSourceHosts, OPERATOR_CITATION_HOSTS, productClaimFinding, preventionPromiseFinding, uncatalogedComponentFinding, citationResidueFinding, tenureClaimFinding, offFootprintCityFinding, internalRouteFinding, normalizeInternalPath, CITY_SERVICE_LINK_RE },
};
