/**
 * competitor-links.js — owner ruling 2026-09-28: "I do not want to link to a
 * competitor's website, whatsoever." A blog post never links a competitor's
 * own site — as a source, citation or CTA. The wording stays; only the link
 * goes. Deterministic string work, no LLM, no I/O.
 *
 * ONE competitor-host matcher, the union of the competitor host lists this
 * portal already maintains (imported, never re-typed, so an addition to any
 * of them — e.g. a new curated competitor-facts record — flows in on the
 * next call):
 *   - competitor-facts.js COMPETITORS: each curated record's official hosts —
 *     the hosts its sourced attributes cite, plus any it declares in an
 *     optional `hosts` array (e.g. a brand's older domain no attribute
 *     cites). Hosts come ONLY from records: never a hand-typed guess from a
 *     brand name (aptive.com, for one, is an unrelated company);
 *   - ai-citation-classifier's competitorDomains(): competitor-discovery's
 *     NATIONAL_CHAINS + competitor-gap-miner's tracked local competitors
 *     (COMPETITOR_GAP_DOMAINS override honoured) + its extra competitor
 *     domains.
 * Hub and spoke hosts are never competitors.
 */

const { decodeHTML } = require('entities');
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

const OWN_HOSTS = new Set(['wavespestcontrol.com', ...SPOKE_SITE_KEYS].map((h) => normalizeHost(h)));

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^(?:www|m)\./, '');
}

// CommonMark backslash-escapes any ASCII punctuation character in a link
// destination ("https://orkin\.com/plans" renders as a link to orkin.com,
// the backslash never reaching the browser). Node's URL parser has no idea
// about Markdown syntax — it reads the raw backslash as a path separator —
// so destinations must be unescaped the same way a renderer would before
// the host is parsed out of them.
const MD_BACKSLASH_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g;
function unescapeMarkdown(s) {
  return String(s || '').replace(MD_BACKSLASH_ESCAPE_RE, '$1');
}

// Destinations are compared as a browser reads them: HTML entities decoded
// ("orkin&#46;com"), Markdown backslash-escapes decoded ("orkin\.com"),
// protocol-relative ("//orkin.com/x") resolved to https.
function hostOf(url) {
  const raw = unescapeMarkdown(decodeHTML(String(url || ''))).trim();
  if (!raw) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, '')}`;
  try {
    return normalizeHost(new URL(absolute).hostname);
  } catch {
    return null;
  }
}

// Computed per call (a few dozen hosts): env overrides and record additions
// are picked up without a restart. Lazy requires keep this module loadable
// from the publisher and the guardrails without pulling the SEO stack in at
// module load.
function competitorHosts() {
  const hosts = new Set();
  const add = (h) => {
    const n = normalizeHost(h);
    if (n && n.includes('.') && !OWN_HOSTS.has(n)) hosts.add(n);
  };
  const { COMPETITORS } = require('./competitor-facts');
  for (const c of COMPETITORS || []) {
    for (const attr of Object.values(c?.attributes || {})) {
      const h = hostOf(attr?.source);
      if (h) add(h);
    }
    for (const declared of Array.isArray(c?.hosts) ? c.hosts : []) {
      const h = hostOf(declared);
      if (h) add(h);
    }
  }
  const { _internals: classifier } = require('../seo/ai-citation-classifier');
  for (const d of classifier.competitorDomains()) add(d);
  return hosts;
}

function isCompetitorHost(host, hosts = competitorHosts()) {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const d of hosts) {
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

function isCompetitorUrl(url, hosts) {
  const h = hostOf(url);
  return !!h && isCompetitorHost(h, hosts);
}

// Absolute http(s) URLs, protocol-relative "//host.tld" destinations and GFM
// "www." autolinks, anywhere in the text.
const ANY_URL_RE = /(?:\bhttps?:\/\/|(?<![:\w/])\/\/(?=[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})|\bwww\.)[^\s<>()[\]"'`]+/gi;
// A bare URL in prose: not glued to a preceding path/word (so the embedded
// URL inside an archive.org link is left alone — its host is archive.org).
// Protocol-relative ("//orkin.com/plans") is included, gated on a
// dotted-TLD lookahead like ANY_URL_RE's — otherwise a plain path
// beginning "//" (there isn't one in Markdown prose, but belt-and-braces)
// could be mistaken for a host.
const BARE_URL_RE = /(?<![\w/@.=:])(?:https?:\/\/|www\.|\/\/(?=[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}))[^\s<>()[\]"'`]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

// Every competitor URL still present in `text` (any context), read with HTML
// entities decoded. Used by the guardrail and the publisher's post-unlink
// assertion.
function competitorLinkUrls(text, hosts = competitorHosts()) {
  const out = [];
  for (const m of decodeHTML(String(text || '')).matchAll(ANY_URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT_RE, '');
    if (isCompetitorUrl(url, hosts)) out.push(url);
  }
  return out;
}

const INLINE_LINK_RE = /(!?)\[((?:\\.|[^[\]\\]|\[(?:\\.|[^[\]\\])*\])*)\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const REF_DEF_RE = /^ {0,3}\[([^\]\n]+)\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*(?:\n|$)/gm;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
// A plain-quoted value, OR a JSX string-expression ({"…"} / {'…'} — MDX
// renders content-guardrails.js already treats this syntax as a rendered
// destination, e.g. <a href={"https://orkin.com/x"}>), structurally — never
// the bare fallback, which would capture the literal "{...}" text and never
// match a competitor host.
const HREF_ATTR_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|([^\s>]+))/i;
const COMPONENT_TAG_RE = /<([A-Z][\w.]*)\b([^<>]*?)(\/?)>/g;
const URL_ATTR_RE = /\s+([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/g;
// A component's visible label, when it has one ("Visit Orkin").
const LABEL_ATTR_RE = /(?:^|\s)(?:ctaLabel|label|text|title|alt|ariaLabel|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/i;
const IMG_TAG_RE = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const SRC_ATTR_RE = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|([^\s>]+))/i;
const ALT_ATTR_RE = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/i;
// Any remaining HTML / JSX tag, quote- and brace-aware.
const ANY_TAG_RE = /<\/?[A-Za-z][\w.:-]*(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*>/g;
const AUTOLINK_RE = /<((?:https?:\/\/|www\.)[^<>\s]+)>/gi;

const normLabel = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const stripAngles = (s) => String(s || '').replace(/^<|>$/g, '');

/**
 * unlinkCompetitorLinks(text) → { text, unlinked: [{ url, text }] }
 * Replaces every link whose destination is a competitor host with its anchor
 * text: Markdown inline links (an image becomes its alt text), reference
 * links (their definitions are dropped), HTML anchors, HTML images (their
 * alt text), a self-closing component with a competitor URL prop (its label,
 * else the plain domain — never the component minus the prop, which a CTA
 * would render with its default Waves link), autolinks and bare URLs in
 * prose (reduced to the plain, non-linking domain, e.g. "orkin.com").
 * Markup it cannot rewrite safely (a competitor URL in an iframe, a
 * component with children, a template-literal prop) is left exactly as
 * written, so the publisher's survivor check refuses the commit instead of
 * shipping a broken or re-pointed link (Codex r2).
 */
function unlinkCompetitorLinks(input, hosts = competitorHosts()) {
  let text = String(input ?? '');
  const unlinked = [];
  const record = (url, anchor) => unlinked.push({ url, text: anchor });
  const plainDomain = (url) => hostOf(url) || url;

  // Reference definitions first: remember competitor labels, drop the lines.
  // CommonMark resolves a duplicate label to its FIRST definition — a later
  // redefinition never wins resolution, whichever way the change runs (an
  // earlier legitimate source "shadowed" by a later competitor definition
  // stays legitimate; an earlier competitor definition stays authoritative
  // even past a later non-competitor "override"). Every definition line
  // that names a competitor host is still dropped either way, so a
  // shadowed one never survives as a raw URL for the leftover scan below.
  const definedLabels = new Set();
  const refLabels = new Map(); // normalized label → url (from its FIRST definition only)
  text = text.replace(REF_DEF_RE, (whole, label, dest) => {
    const key = normLabel(label);
    const isFirst = !definedLabels.has(key);
    definedLabels.add(key);
    const url = stripAngles(dest);
    if (!isCompetitorUrl(url, hosts)) return whole;
    if (isFirst) refLabels.set(key, url);
    return '';
  });

  text = text.replace(INLINE_LINK_RE, (whole, bang, anchor, dest) => {
    const url = stripAngles(dest);
    if (!isCompetitorUrl(url, hosts)) return whole;
    record(url, anchor);
    return anchor;
  });

  if (refLabels.size) {
    text = text.replace(/(!?)\[((?:\\.|[^[\]\\])*)\]\[((?:\\.|[^[\]\\])*)\]/g, (whole, bang, anchor, label) => {
      const key = normLabel(label || anchor);
      if (!refLabels.has(key)) return whole;
      record(refLabels.get(key), anchor);
      return anchor;
    });
    text = text.replace(/(!?)\[((?:\\.|[^[\]\\])*)\](?![[(:])/g, (whole, bang, anchor) => {
      if (!refLabels.has(normLabel(anchor))) return whole;
      record(refLabels.get(normLabel(anchor)), anchor);
      return anchor;
    });
  }

  text = text.replace(ANCHOR_RE, (whole, attrs, inner) => {
    const m = HREF_ATTR_RE.exec(attrs);
    const url = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) : '';
    if (!url || !isCompetitorUrl(url, hosts)) return whole;
    record(url, inner);
    return inner;
  });

  text = text.replace(IMG_TAG_RE, (whole, attrs) => {
    const m = SRC_ATTR_RE.exec(attrs);
    const url = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) : '';
    if (!url || !isCompetitorUrl(url, hosts)) return whole;
    const alt = ALT_ATTR_RE.exec(attrs);
    const label = alt ? (alt[1] ?? alt[2] ?? alt[3] ?? alt[4]) : '';
    record(url, label);
    return label;
  });

  text = text.replace(COMPONENT_TAG_RE, (whole, name, attrs, selfClose) => {
    let url = null;
    for (const m of attrs.matchAll(URL_ATTR_RE)) {
      const value = m[2] ?? m[3] ?? m[4] ?? m[5];
      // URL-valued props only (entities decoded) — a plain-text prop that
      // merely names a domain is wording, not a link.
      if (/^(?:https?:)?\/\/|^www\./i.test(decodeHTML(value).trim()) && isCompetitorUrl(value, hosts)) { url = value; break; }
    }
    // A component with children is left for the survivor check: its closing
    // tag and children sit outside this match.
    if (!url || !selfClose) return whole;
    const label = LABEL_ATTR_RE.exec(attrs);
    const textOut = label ? (label[1] ?? label[2] ?? label[3] ?? label[4]) : plainDomain(url);
    record(url, textOut);
    return textOut;
  });

  text = text.replace(AUTOLINK_RE, (whole, url) => {
    if (!isCompetitorUrl(url, hosts)) return whole;
    record(url, plainDomain(url));
    return plainDomain(url);
  });

  // Bare URLs in PROSE only: every remaining tag is set aside first, so an
  // attribute no pass above rewrote keeps its URL intact instead of becoming
  // a broken relative one (src="orkin.com").
  const tags = [];
  text = text.replace(ANY_TAG_RE, (tag) => { tags.push(tag); return `<\u0000${tags.length - 1}\u0000>`; });
  text = text.replace(BARE_URL_RE, (whole) => {
    const url = whole.replace(TRAILING_PUNCT_RE, '');
    if (!isCompetitorUrl(url, hosts)) return whole;
    record(url, plainDomain(url));
    return plainDomain(url) + whole.slice(url.length);
  });
  text = text.replace(/<\u0000(\d+)\u0000>/g, (whole, i) => tags[Number(i)]);

  return { text, unlinked };
}

// Frontmatter: every string value, at any depth, gets the same treatment.
function unlinkCompetitorLinksDeep(value, hosts = competitorHosts()) {
  const unlinked = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = unlinkCompetitorLinks(v, hosts);
      unlinked.push(...r.unlinked);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), unlinked };
}

module.exports = {
  competitorHosts,
  isCompetitorHost,
  competitorLinkUrls,
  unlinkCompetitorLinks,
  unlinkCompetitorLinksDeep,
};
