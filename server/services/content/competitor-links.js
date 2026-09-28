/**
 * competitor-links.js — owner ruling 2026-09-28: "I do not want to link to a
 * competitor's website, whatsoever." Nothing Waves publishes links a
 * competitor's own site — as a source, citation or CTA. Second ruling, same
 * day (#5191): refuse, don't rewrite. A draft carrying a competitor link goes
 * back to the writer (content-guardrails' COMPETITOR_LINK, in the writer's
 * in-loop self-lint), and a publish that still carries one is refused
 * (astro-publisher's competitorFreeMarkdown). Nothing rewrites a link, so
 * this module only DETECTS them. Deterministic string work, no LLM, no I/O.
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

// A destination as a browser reads it: HTML entities and Markdown
// backslash-escapes decoded ("orkin&#46;com", "orkin\\.com").
function readableUrl(url) {
  return unescapeMarkdown(decodeHTML(String(url || ''))).trim();
}

// Destinations are compared as a browser reads them: HTML entities decoded
// ("orkin&#46;com"), Markdown backslash-escapes decoded ("orkin\.com"), then
// the WHATWG URL rules: a scheme is parsed as written (for http(s) a
// backslash is a slash, so "https:\\orkin.com\\x" reaches orkin.com —
// Codex r4), "//host" or "\\host" is protocol-relative, anything else is a
// bare host.
function hostOf(url) {
  const raw = readableUrl(url);
  if (!raw) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^[\\/]{2}/.test(raw) ? `https:${raw}` : `https://${raw}`;
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

// Where a URL can start: an http(s) scheme (its slashes may be backslashes
// or absent: "https:\\orkin.com", "https:orkin.com"), a protocol-relative
// "//" or "\\" not glued to a preceding word or path, or a GFM "www."
// autolink. Nothing is assumed about what follows: hostOf's WHATWG parse
// decides the host a candidate reaches, userinfo included — "//user@orkin.com"
// reaches orkin.com (Codex r7 on #5191).
const URL_START_RE = /\bhttps?:|(?<![:\w/\\])[\\/]{2}|\bwww\./gi;
// A candidate ends where its surrounding syntax ends it: whitespace, quotes,
// angle brackets, a backtick. A bracket may belong to the URL
// ("//us(er@orkin.com/x") or close the Markdown around it
// ("[x](https://orkin.com)" — "orkin.com)" is a different host to a
// browser), so every candidate is read both ways.
const WIDE_END_RE = /[\s<>"'`]/;
const NARROW_END_RE = /[\s<>()[\]"'`]/;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
// A browser removes every ASCII tab and newline from a URL before parsing it
// (WHATWG URL), so "https://or\tkin.com" — or an href split across lines —
// still reaches orkin.com (Codex r6 on #5191).
const URL_IGNORED_RE = /[\t\n\r]/g;

// Each URL candidate in `text` as its [narrow, wide] readings. A start
// inside the previous candidate is part of it (an archived copy's embedded
// URL goes to archive.org).
function* urlCandidates(text) {
  let covered = 0;
  for (const m of text.matchAll(URL_START_RE)) {
    if (m.index < covered) continue;
    const rest = text.slice(m.index);
    const upTo = (re) => {
      const i = rest.search(re);
      return (i === -1 ? rest : rest.slice(0, i)).replace(TRAILING_PUNCT_RE, '');
    };
    const narrow = upTo(NARROW_END_RE);
    covered = m.index + narrow.length;
    yield [narrow, upTo(WIDE_END_RE)];
  }
}

// Every competitor URL in `text`, in any context — Markdown, HTML, JSX
// props, code, prose — read as a browser would: HTML entities decoded, and
// scanned both as written and with tabs/newlines removed. One URL per link.
function competitorLinkUrls(text, hosts = competitorHosts()) {
  const decoded = decodeHTML(String(text ?? ''));
  const out = new Set();
  for (const variant of [decoded, decoded.replace(URL_IGNORED_RE, '')]) {
    for (const readings of urlCandidates(variant)) {
      const hit = readings.find((u) => isCompetitorUrl(u, hosts));
      if (hit) out.add(hit);
    }
  }
  return [...out];
}

// A document's competitor URLs: the body plus every frontmatter string, at
// any depth, each scanned on its own. The parsed values, never the YAML
// text: a double-quoted scalar's escapes ("or\tkin.com") would hide the
// character the page actually renders.
function competitorLinkUrlsIn(frontmatter, body, hosts = competitorHosts()) {
  const out = new Set(competitorLinkUrls(body, hosts));
  const walk = (v) => {
    if (typeof v === 'string') competitorLinkUrls(v, hosts).forEach((u) => out.add(u));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && !(v instanceof Date)) Object.values(v).forEach(walk);
  };
  walk(frontmatter);
  return [...out];
}

module.exports = {
  readableUrl,
  URL_START_RE,
  competitorHosts,
  isCompetitorHost,
  competitorLinkUrls,
  competitorLinkUrlsIn,
};
