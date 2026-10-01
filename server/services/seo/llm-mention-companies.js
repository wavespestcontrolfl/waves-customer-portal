/**
 * Who an answer engine named, in the order it named them (AEO tracker).
 *
 * The tracker used to rank Waves only against a short hard-coded list of
 * nationals, so "rank 1" often meant third to fifth among every company the
 * answer actually named. `buildCompaniesNamed` returns the whole ordered list
 * and `rankAmong` reads Waves' 1-based place in it. Rows written this way are
 * tagged RANK_METHOD_ALL_NAMED; rows from before carry the known-list meaning
 * (RANK_METHOD_KNOWN_LIST, also what a NULL rank_method reads as).
 *
 * Pure functions, no I/O: everything here is unit-testable on plain text.
 */

const { asJsonArray } = require('./aeo-measurement');

// 'all_named_v2': Waves' place among the companies a provider listed as brand
// entities. 'all_named_text_v2': its place among names READ from the answer
// text, which can miss a company, so it is its own cohort (and carries no rank
// when no other company was found at all).
const RANK_METHOD_ALL_NAMED = 'all_named_v2';
const RANK_METHOD_ALL_NAMED_TEXT = 'all_named_text_v2';
const RANK_METHOD_KNOWN_LIST = 'known_list_v1';

// A source URL alone is not a brand mention in the answer.
const WAVES_RE = /\bwaves\s+(?:pest\s+control|lawn(?:\s+care)?)\b/i;
const WAVES_NAME = 'Waves Pest Control';
const URL_RE = /https?:\/\/[^\s)<>\]"']+/gi;

// Known rivals, matched by text position. The first nine are the original
// list (kept verbatim: stored competitors_mentioned names are these strings);
// the rest are the local independents that actually beat Waves in the
// 2026-09-30 app-vs-tracker check. Matching is word-start only ("westfall"
// matches "Westfall's"), never mid-word. Names that are also plain English
// ("good news", "prodigy", "paragon") carry "pest" so ordinary prose
// ("the good news is...") is not read as a company.
const COMPETITORS = [
  'turner pest', 'hoskins', 'orkin', 'terminix', 'truly nolen',
  'hometeam', 'arrow environmental', 'nozzle nolen', 'massey services',
  'all u need', 'prodigy pest', 'paragon pest', 'farrow', 'good news pest', 'acme',
  'westfall', 'keller',
];

// Display name for a known rival, so "Turner Pest Control" from a brand
// entity, "turner pest" from the list and a bold "Turner Pest" in prose all
// count as one company on the dashboard.
const COMPETITOR_DISPLAY = {
  'turner pest': 'Turner Pest Control',
  'arrow environmental': 'Arrow Environmental Services',
  'massey services': 'Massey Services',
  'truly nolen': 'Truly Nolen',
  'nozzle nolen': 'Nozzle Nolen',
  hometeam: 'HomeTeam',
  'all u need': 'All U Need',
  'good news pest': 'Good News Pest Solutions',
  'prodigy pest': 'Prodigy Pest Solutions',
  acme: 'ACME',
  westfall: "Westfall's",
  keller: "Keller's",
};

function titleCase(value) {
  return value.replace(/\b[a-z]/g, c => c.toUpperCase());
}

function competitorDisplay(key) {
  return COMPETITOR_DISPLAY[key] || titleCase(key);
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPETITOR_RES = COMPETITORS.map(key => ({ key, re: new RegExp(`(?<![a-z0-9])${escapeRe(key)}`) }));

/** Blank URLs so a link target is never read as prose; keeps string offsets. */
function proseOf(text) {
  return String(text || '').replace(URL_RE, url => ' '.repeat(url.length));
}

/** Known rivals present in lower-cased prose, [{ key, idx }] in list order. */
function knownCompetitorHits(lowerProse) {
  return COMPETITOR_RES
    .map(({ key, re }) => ({ key, idx: lowerProse.search(re) }))
    .filter(hit => hit.idx >= 0);
}

/** The known rival a name belongs to (lower-cased list key) or null. */
function knownCompetitorKey(name) {
  const lower = String(name || '').toLowerCase();
  const hit = COMPETITOR_RES.find(({ re }) => re.test(lower));
  return hit ? hit.key : null;
}

/** Waves-aware canonical display: Waves and known rivals collapse, others keep their name. */
function canonicalCompany(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (WAVES_RE.test(clean) || /^waves\b/i.test(clean)) return WAVES_NAME;
  const key = knownCompetitorKey(clean);
  return key ? competitorDisplay(key) : clean;
}

// ── Conservative "looks like a pest/lawn company" filter ────────────────────

// Words that, on their own, are a service or a label rather than a business
// name. A candidate needs at least one capitalised word outside this set.
const GENERIC_WORDS = new Set([
  'pest', 'pests', 'control', 'termite', 'termites', 'lawn', 'lawns', 'care', 'mosquito', 'mosquitoes',
  'rodent', 'rodents', 'wildlife', 'service', 'services', 'solutions', 'solution', 'company', 'companies',
  'inc', 'llc', 'co', 'corp', 'the', 'and', 'of', 'for', 'in', 'to', 'with', 'near', 'a', 'an', 'on', 'or',
  'plan', 'plans', 'treatment', 'treatments', 'inspection', 'inspections', 'guarantee', 'guarantees',
  'program', 'programs', 'pricing', 'price', 'prices', 'cost', 'costs', 'option', 'options', 'tips',
  'tip', 'review', 'reviews', 'rating', 'ratings', 'quote', 'quotes', 'pros', 'cons', 'offerings',
  'expertise', 'reputation', 'highlights', 'summary', 'bottom', 'line', 'florida', 'fl', 'local',
  'regional', 'national', 'best', 'top', 'general', 'residential', 'commercial', 'free',
  'protection', 'prevention', 'management', 'integrated', 'targeted', 'identify', 'your', 'safe',
  'natural', 'organic', 'eco-friendly', 'maintenance', 'exterminator', 'exterminators', 'bug', 'bugs',
  'insect', 'insects', 'ants', 'roaches', 'full-service', 'premium', 'professional', 'affordable', 'quality',
  'reliable', 'trusted', 'expert', 'experts', 'complete', 'provided', 'specialized', 'specialty', 'outdoor', 'yard', 'name', 'primary', 'offered', 'specialization',
  'fertilization', 'spraying', 'weed', 'mowing', 'irrigation', 'aeration', 'trimming',
]);
const STOP_START = new Set([
  'best', 'top', 'how', 'why', 'what', 'when', 'where', 'which', 'who', 'for', 'get', 'ask', 'call', 'check',
  'compare', 'consider', 'choose', 'look', 'tip', 'note', 'pros', 'cons', 'key', 'bottom', 'summary',
  'overall', 'quick', 'final', 'more', 'other', 'also', 'next', 'step', 'if', 'with', 'our', 'your', 'my',
  'is', 'are', 'a', 'an', 'the', 'these', 'this', 'that', 'there', 'some', 'many', 'most', 'all', 'any',
  'avoid', 'keep', 'make', 'use', 'see', 'find', 'want', 'need', 'try', 'ask', 'verify', 'read',
]);
const CONNECTORS = new Set(['of', 'and', 'the', 'in', 'for', 'to', 'a', 'an', 'or', 'on', 'at', 'by', 'de']);
const LEGAL_SUFFIX_RE = /,?\s*\b(?:inc|llc|co|corp)\.?$/i;
const BUSINESS_RE = /pest|termite|lawn|mosquito|rodent|exterminat|\bbug|wildlife|environmental|fumigat|turf|insect|critter|\b(?:inc|llc|co|corp|company)\b\.?/i;

// A sentence, a trailing-period phrase ("Provides mosquito treatments."), or a
// comma list of names is not one company name.
const NOT_A_NAME_RE = /\b(?:listings?|rankings?|directory|reviews?|companies|providers|top-rated)\b/i;

function isSentenceOrList(name) {
  if (NOT_A_NAME_RE.test(name)) return true; // a directory page title, not a business
  if (/[!?]/.test(name) || /\.\s+[A-Za-z]/.test(name)) return true;
  if (/\.$/.test(name) && !LEGAL_SUFFIX_RE.test(name)) return true;
  return /,\s*(?!(?:inc|llc|co|corp)\b)/i.test(name);
}

// `strong` = the span is a business card (name followed by a star rating and
// review count), so it needs no pest/lawn keyword.
function looksLikeCompany(rawName, { strong = false, prose = false } = {}) {
  let name = String(rawName || '').replace(/[*_`#]+/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[\s\-–—:;,.]+|[\s\-–—:;,]+$/g, '').replace(/^the\s+/i, '');
  if (name.length < 3 || name.length > 70) return false;
  if (isSentenceOrList(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 8) return false;
  if (!/^[A-Z0-9]/.test(name)) return false;
  // A name is capitalised; a phrase has plain lower-case words in it.
  const plain = words.filter(w => /^[a-z]/.test(w) && !CONNECTORS.has(w));
  if (plain.length > 1) return false;
  if (knownCompetitorKey(name)) return true;
  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (STOP_START.has(first)) return false;
  const tokens = name.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  const proper = tokens.filter(t => /^[A-Z]/.test(t) && !GENERIC_WORDS.has(t.toLowerCase().replace(/['’]s$/, '')));
  if (!proper.length) return false;
  // "Pest Control in Sarasota": a service phrase wearing a city, not a company.
  if (GENERIC_WORDS.has(first) && /\b(?:in|for|near)\b/i.test(name)) return false;
  return strong || hasBusinessWord(name, prose && words.length >= 2);
}

// In running prose a "Services"/"Solutions" name needs a second word to be a company.
function hasBusinessWord(name, allowServices) {
  return BUSINESS_RE.test(name) || (allowServices && /\b(?:services|solutions)\b/i.test(name));
}

// Gemini glues a Maps card's domain onto the name: "**Name[name.com](url)**".
const DOMAIN_LINK_RE = /\[(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\]\s]*)?\]\([^)]*\)/gi;

// ── Business names in running prose ─────────────────────────────────────────
// "Example Bug Control is first. Waves Pest Control is second." has no list
// syntax; a company still shows as a run of Capitalised words, so read those.
const SENTENCE_STARTERS = new Set([
  'then', 'however', 'plus', 'both', 'but', 'so', 'while', 'after', 'before', 'once', 'another', 'try',
  'call', 'consider', 'choose', 'also', 'and', 'or', 'in', 'on', 'at', 'as', 'we', 'they', 'it', 'he', 'she',
  'you', 'i', 'many', 'several', 'overall', 'finally', 'first', 'second', 'third', 'next', 'lastly', 'ask',
]);
const CAPITALISED_TOKEN_RE = /^(?:[A-Z][A-Za-z0-9'’&-]*|(?=.*[A-Z])[A-Z0-9]{2,})$/;
// Business-card chrome (Google Maps cards in AI Mode / Overview text).
const CARD_CHROME = new Set(['call', 'directions', 'website', 'closed', 'open', 'hours', 'menu', 'reviews', 'review']);
const RUN_CONNECTORS = new Set(['&', 'and', 'of', 'the']);
const SUFFIX_TOKENS = new Set(['inc', 'llc', 'co', 'corp', 'ltd']);

const MARKDOWN_EDGE_RE = /^[*_`#>[(]+|[*_`\])]+$/g;

function proseNameSpans(prose) {
  const spans = [];
  const text = String(prose || '');
  // A run never crosses a line break, a table cell edge or a heading, and
  // markdown marks are peeled off each token (offsets stay true).
  const tokens = [...text.matchAll(/[^\s|]+/g)].map(m => {
    const lead = (m[0].match(/^[*_`#>[(]+/) || [''])[0].length;
    return { raw: m[0].replace(MARKDOWN_EDGE_RE, ''), idx: m.index + lead, end: m.index + m[0].length };
  }).filter(t => t.raw);
  let run = [];
  const flush = () => {
    while (run.length && RUN_CONNECTORS.has(run[run.length - 1].word.toLowerCase())) run.pop();
    const whole = run.map(t => t.word).join(' ');
    // A known rival keeps its leading word ("All U Need Pest Control").
    if (!knownCompetitorKey(whole)) {
      while (run.length && (SENTENCE_STARTERS.has(run[0].word.toLowerCase()) || STOP_START.has(run[0].word.toLowerCase().replace(/[^a-z]/g, '')))) run.shift();
    }
    if (run.length) spans.push({ name: run.map(t => t.word).join(' '), idx: run[0].idx });
    run = [];
  };
  tokens.forEach((token, i) => {
    if (i > 0 && /[\n|]/.test(text.slice(tokens[i - 1].end, token.idx))) flush();
    const stripped = token.raw.replace(/[.,;:!?]+$/, '');
    const ended = stripped.length !== token.raw.length;
    const keepsPeriod = ended && SUFFIX_TOKENS.has(stripped.toLowerCase()) && token.raw.slice(stripped.length) === '.';
    const word = keepsPeriod ? token.raw : stripped;
    const next = tokens[i + 1] && tokens[i + 1].raw.replace(/[.,;:!?]+$/, '');
    const sameLine = tokens[i + 1] && !/[\n|]/.test(text.slice(token.end, tokens[i + 1].idx));
    if (CARD_CHROME.has(stripped.toLowerCase())) {
      flush();
      return;
    }
    if (CAPITALISED_TOKEN_RE.test(stripped)) {
      run.push({ word, idx: token.idx });
    } else if (RUN_CONNECTORS.has(word.toLowerCase()) && run.length && sameLine && next && CAPITALISED_TOKEN_RE.test(next)) {
      run.push({ word, idx: token.idx });
    } else {
      flush();
      return;
    }
    if (ended) flush();
  });
  flush();
  return spans;
}

// Google's AI Mode and Overview list businesses as cards:
// "Example Bug Control 4.8 (1.4K)" then a category line.
const RATING_CARD_RE = /^\s*([^\n|]{3,70}?)\s+\d\.\d\s+\(\d[\d.,]*K?\)/gm;

function ratingCardNames(text) {
  const out = [];
  for (const m of String(text || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').matchAll(RATING_CARD_RE)) out.push(m[1]);
  return out;
}

function cleanCandidate(raw) {
  return String(raw || '')
    .replace(DOMAIN_LINK_RE, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+Website$/i, '') // a Maps card's "<name> Website" link
    .replace(/^[\s\-–—:;,.]+|[\s\-–—:;,]+$/g, '')
    .trim();
}

/**
 * Candidate company spans in answer markdown: the leading name of numbered or
 * bulleted items, headings, **bold** spans and [link text]. Order is not
 * meaningful here; buildCompaniesNamed sorts by position in the text.
 */
function candidateNames(text) {
  const out = [];
  const body = String(text || '').replace(DOMAIN_LINK_RE, '');
  for (const line of body.split(/\r?\n/)) {
    const item = line.match(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+(.+)$/) || line.match(/^\s*#{1,4}\s*(?:\d{1,2}[.)]\s*)?(.+)$/);
    if (!item) continue;
    let rest = item[1].trim();
    const bold = rest.match(/^\*\*([^*]{2,80})\*\*/) || rest.match(/^__([^_]{2,80})__/);
    const link = rest.match(/^\[([^\]]{2,80})\]\(/);
    if (bold) out.push(bold[1]);
    else if (link) out.push(link[1]);
    else {
      rest = rest.replace(/\*\*|__/g, '');
      const lead = rest.split(/\s[–—-]\s|:\s|\s\(/)[0];
      out.push(lead);
    }
  }
  for (const m of body.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) out.push(m[1]);
  for (const m of body.matchAll(/(?<!!)\[([^\]\n]{2,80})\]\(/g)) out.push(m[1]);
  return out;
}

// "Terminix & Orkin" or "Example Bug Control and Sample Pest Solutions" are two
// companies, but "Rick Ricker Termite & Pest Control" is one: split only when
// every part would stand as a company on its own.
function splitJoinedRivals(name) {
  const parts = name.split(/\s*(?:&|\band\b|\/)\s*/i).filter(Boolean);
  if (parts.length < 2) return [name];
  return parts.every(part => looksLikeCompany(part)) ? parts : [name];
}

function positionOf(lowerProse, name) {
  const lower = String(name).toLowerCase();
  const attempts = [lower, lower.replace(/,?\s*(?:inc|llc|co|corp)\.?$/i, '').trim()];
  const key = knownCompetitorKey(name);
  for (const attempt of attempts) {
    if (!attempt) continue;
    const idx = lowerProse.indexOf(attempt);
    if (idx >= 0) return idx;
  }
  if (key) {
    const hit = COMPETITOR_RES.find(c => c.key === key);
    const idx = lowerProse.search(hit.re);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Ordered, de-duplicated companies an answer names, with Waves included at
 * its text position. `entities` are provider brand entities when the scraper
 * supplies them ([{ title, category }]); otherwise names come from the text.
 * Known rivals found in the text are always added. Returns [{ name }] in
 * order of first mention.
 */
// "Mosquito Joe" beside "Mosquito Joe of Tampa Bay": one company named twice,
// so the shorter (two or more words) form is dropped.
function dropWordPrefixes(companies) {
  const words = companies.map(c => c.name.toLowerCase().split(/\s+/));
  const isPrefix = (a, b) => a.length >= 2 && a.length < b.length && a.every((w, i) => b[i] === w);
  return companies.filter((_, i) => !words.some((other, j) => j !== i && isPrefix(words[i], other)));
}

// Names read from answer text: list items / bold / links, business cards, and
// (when there are no cards) capitalised business-name spans in plain sentences.
function addTextCompanies(text, prose, lowerProse, add) {
  for (const raw of candidateNames(text)) {
    for (const part of splitJoinedRivals(cleanCandidate(raw))) {
      if (looksLikeCompany(part)) add(part, positionOf(lowerProse, cleanCandidate(part)));
    }
  }
  const cards = ratingCardNames(text).map(cleanCandidate).filter(name => looksLikeCompany(name, { strong: true }));
  for (const name of cards) add(name, positionOf(lowerProse, name));
  // Business cards are structured evidence; reading the prose around them as
  // well only adds card chrome and headers, so prose is read when there are none.
  if (cards.length) return;
  for (const span of proseNameSpans(prose)) {
    for (const part of splitJoinedRivals(cleanCandidate(span.name))) {
      if (looksLikeCompany(part, { prose: true })) add(part, span.idx);
    }
  }
}

function buildCompaniesNamedDetailed(text, { entities = null } = {}) {
  const prose = proseOf(text);
  const lowerProse = prose.toLowerCase();
  const found = []; // { name, idx, order }
  let order = 0;
  const add = (name, idx) => {
    const canonical = canonicalCompany(name);
    if (!canonical) return;
    found.push({ name: canonical, idx: idx >= 0 ? idx : Number.MAX_SAFE_INTEGER, order: order++ });
  };

  const usableEntities = (Array.isArray(entities) ? entities : [])
    .filter(e => e && typeof e.title === 'string' && e.title.trim()
      && (!e.category || ['local_business', 'business', 'company', 'organization'].includes(String(e.category).toLowerCase())));
  const source = usableEntities.length ? 'entities' : 'text';

  if (usableEntities.length) {
    for (const e of usableEntities) add(e.title, positionOf(lowerProse, e.title));
  } else {
    addTextCompanies(text, prose, lowerProse, add);
  }
  for (const { key, re } of COMPETITOR_RES) {
    const idx = lowerProse.search(re);
    if (idx >= 0) add(key, idx);
  }
  const wavesIdx = prose.search(WAVES_RE);
  if (wavesIdx >= 0) add(WAVES_NAME, wavesIdx);

  found.sort((a, b) => a.idx - b.idx || a.order - b.order);
  const seen = new Set();
  const companies = [];
  for (const entry of found) {
    const key = entry.name.toLowerCase().replace(LEGAL_SUFFIX_RE, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    companies.push({ name: entry.name });
  }
  return { companies: dropWordPrefixes(companies), source };
}

/** Ordered, de-duplicated companies an answer names (see buildCompaniesNamedDetailed). */
function buildCompaniesNamed(text, options) {
  return buildCompaniesNamedDetailed(text, options).companies;
}

/**
 * Waves' rank and the method that produced it. Provider brand entities give
 * 'all_named_v2'. Names read from text give 'all_named_text_v2', and when the
 * text yields no company besides Waves the list cannot be shown complete (a
 * missed name would make Waves look first), so there is no rank.
 */
function rankFor(text, { entities = null } = {}) {
  const { companies, source } = buildCompaniesNamedDetailed(text, { entities });
  const waves = rankAmong(companies);
  const othersFound = companies.some(c => c.name !== WAVES_NAME);
  const rankMethod = source === 'entities' ? RANK_METHOD_ALL_NAMED : RANK_METHOD_ALL_NAMED_TEXT;
  const rankPosition = source === 'text' && !othersFound ? null : waves;
  return { companies, rankMethod, rankPosition };
}

/** Waves' 1-based position among the named companies; null when not named. */
function rankAmong(companiesNamed) {
  const idx = (Array.isArray(companiesNamed) ? companiesNamed : [])
    .findIndex(c => (c?.name || c) === WAVES_NAME);
  return idx >= 0 ? idx + 1 : null;
}

// The other companies an observation says it named, canonicalised, Waves
// excluded. New rows carry the full ordered list (companies_named); rows from
// before fall back to the known-list hits (competitors_mentioned, whose stored
// meaning is unchanged). "turner pest" (old rows) and "Turner Pest Control"
// (new) collapse to one company. Every reader of the competitor columns goes
// through here so the dashboard and the gap tools see the same rivals.
function rivalEntries(row) {
  const legacy = asJsonArray(row?.competitors_mentioned);
  const named = row?.companies_named == null ? null : asJsonArray(row.companies_named);
  const seen = new Map();
  for (const entry of (named || legacy)) {
    const name = canonicalCompany(entry?.name);
    if (!name || name === WAVES_NAME || seen.has(name)) continue;
    seen.set(name, entry?.context ?? null);
  }
  if (named) { // keep the known-list context a rival's stored hit carries
    for (const entry of legacy) {
      const name = canonicalCompany(entry?.name);
      if (seen.has(name) && seen.get(name) == null && entry?.context) seen.set(name, entry.context);
    }
  }
  return [...seen].map(([name, context]) => ({ name, context }));
}

function rivalsOf(row) {
  return rivalEntries(row).map(entry => entry.name);
}

module.exports = {
  rivalsOf, rivalEntries,
  RANK_METHOD_ALL_NAMED, RANK_METHOD_ALL_NAMED_TEXT, RANK_METHOD_KNOWN_LIST, WAVES_RE, WAVES_NAME, URL_RE, COMPETITORS,
  proseOf, knownCompetitorHits, knownCompetitorKey, canonicalCompany, looksLikeCompany, candidateNames,
  buildCompaniesNamed, buildCompaniesNamedDetailed, rankAmong, rankFor, proseNameSpans,
};
