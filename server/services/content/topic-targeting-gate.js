'use strict';

/**
 * Topic-targeting gate — deterministic, pre-draft, no LLM.
 *
 * Owner rulings 2026-08-27 (Adam), after three engine PRs landed in one
 * morning that each targeted the wrong thing:
 *
 *   - astro #476 "WDO Inspection Near Tampa" — Tampa is outside the service
 *     footprint. An educational post CAN mention Tampa (the footprint-claim
 *     guardrail already allows that); a post may not be BUILT AROUND an
 *     out-of-area geo in its keyword/title/slug.
 *   - astro #491 "New-Construction Pest Control in Florida" — statewide
 *     framing is too broad. A new blog's targeting must anchor to a footprint
 *     city, the SWFL region, or carry no geo at all (the writer localizes).
 *     A bare "Florida"/"FL" as the only geo qualifier is a block.
 *   - astro #490 "Your New Lakewood Ranch Home Came With Taexx" — spins a new
 *     post off an entity ("Taexx") that one of the most-visited live posts
 *     (/pest-control/in-wall-pest-control/) already owns in GSC. One
 *     entity → one post; growth on an owned entity is a REFRESH of the owner,
 *     never a sibling post that splits the query set.
 *
 * Scope: NEW supporting blogs only (action new_supporting_blog / page_type
 * supporting-blog). Refreshes are exempt by construction — a refresh of the
 * entity owner is exactly the sanctioned move.
 *
 * Entity ownership is corpus-adaptive rather than a hand-curated list: a
 * token from the candidate's primary keyword/title that appears in the
 * targeting fields (title / slug / primary_keyword / secondary_keywords /
 * meta_description / H2-H3 headings) of at most RARE_ENTITY_DF_MAX live
 * posts is a rare entity, and those posts own it. Generic vocabulary
 * ("termite", "drywood", "inspection") has a high document frequency and
 * never trips it; a brand/product/species name that exactly one or two
 * posts are built around does.
 *
 * Consumers:
 *   - autonomous-runner step 2d (skip before any writer spend; corpus
 *     unavailable = engine fault → review, never fail open)
 *   - autonomous-runner post-draft (evaluateDraftFraming on the writer's own
 *     title/slug/keyword → one feedback redraft, then skip)
 *   - gsc-opportunity-miner actionForOpportunity (out-of-area blog demand is
 *     demoted to do_not_publish before it ever enters the queue)
 *   - blog-writer idea generation (geo-blocked ideas are rejected)
 */

const { CITIES } = require('./scoring-config');

// Own tokenizer (not uniqueness-gate._internals — that module is mocked in
// runner tests and a failed load here would hold every new blog for review).
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our',
  'out', 'has', 'have', 'had', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way',
  'who', 'why', 'did', 'get', 'got', 'let', 'say', 'she', 'too', 'use', 'this', 'that', 'with',
  'from', 'they', 'will', 'your', 'what', 'when', 'were', 'been', 'more', 'some', 'them', 'than',
  'then', 'into', 'over', 'such', 'only', 'other', 'also', 'here', 'there', 'their', 'about',
  'after', 'before', 'does', 'each', 'just', 'like', 'make', 'most', 'much', 'need', 'should',
  'these', 'those', 'through', 'under', 'very', 'while', 'would', 'could', 'which', 'where',
]);
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 2 && !STOP_WORDS.has(w));
}

const RARE_ENTITY_DF_MAX = 3;
// An owner must be BUILT AROUND the entity — it appears at least this many
// times across the owner's targeting fields (title / slug / keywords / meta /
// headings). Calibrated 2026-08-27 against the live 255-post corpus: the
// in-wall post names Taexx 9x, /termite/termite-bond/ names "bond" 12x, the
// fertilizer-blackout posts 22x — while a lizard-droppings guide that names
// "lizards" twice does NOT own every future lizard topic.
const OWNER_MIN_OCCURRENCES = 3;

const CODES = Object.freeze({
  GEO_OUT_OF_AREA: 'TOPIC_GEO_OUT_OF_AREA',
  GEO_STATEWIDE: 'TOPIC_GEO_STATEWIDE',
  CANNIBALIZES_EXISTING: 'TOPIC_CANNIBALIZES_EXISTING',
});

// Regional phrasings that anchor a topic to the footprint without naming a
// city. County names are the footprint counties only — out-of-area counties
// live in the guardrails blocklist and classify as out_of_area.
const REGIONAL_RE = /\b(southwest florida|sw florida|swfl|gulf coast|suncoast|sun coast|manatee county|sarasota county|charlotte county)\b/i;
const STATEWIDE_RE = /\bflorida\b|\bfl\b/i;

// Tokens that are geo qualifiers, not topic entities — excluded from the
// entity-ownership scan regardless of document frequency.
const GEO_TOKENS = new Set(['florida', 'swfl', 'southwest', 'county', 'gulf', 'coast', 'suncoast']);

// Structural/intent words that are never a topic entity even in a tiny
// corpus. Document frequency handles the pest/service vocabulary; this list
// only covers words a small category could otherwise make look rare.
const GENERIC_TOKENS = new Set([
  'pest', 'pests', 'control', 'service', 'services', 'company', 'companies',
  'home', 'homes', 'house', 'houses', 'owner', 'owners', 'homeowner', 'homeowners',
  'cost', 'costs', 'price', 'prices', 'pricing', 'guide', 'guides', 'tips', 'best',
  'near', 'review', 'reviews', 'treatment', 'treatments', 'plan', 'plans', 'year',
  'first', 'need', 'needs', 'know', 'what', 'when', 'where', 'which', 'should',
  'does', 'really', 'actually', 'worth', 'enough', 'another', 'other', 'came',
  'with', 'your', 'from', 'about', 'into', 'without', 'versus', 'explained',
  'checklist', 'questions', 'answers', 'signs', 'ways', 'things', 'mistakes',
  'cancel', 'cancellation', 'contract', 'contracts', 'claim', 'claims', 'read',
  'sign', 'local', 'national', 'money', 'smart', 'means', 'build', 'builds',
  'programs', 'program', 'dates', 'season', 'seasons', 'work', 'works',
]);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "St. Petersburg" must match "St Petersburg" / "St. Petersburg"; word
// boundaries on both ends so "Tampa" never matches inside another word.
function cityRe(names) {
  const alts = names
    .map((n) => escapeRe(String(n).trim()).replace(/\\\./g, '\\.?').replace(/\s+/g, '\\s+'))
    .filter(Boolean);
  return alts.length ? new RegExp(`\\b(${alts.join('|')})\\b`, 'i') : null;
}

let footprintCache = null;
function footprintCities() {
  if (footprintCache) return footprintCache;
  const names = new Set((CITIES || []).map((c) => String(c)));
  try {
    const { CITY_TO_LOCATION } = require('../../config/locations');
    for (const key of Object.keys(CITY_TO_LOCATION || {})) {
      names.add(key.replace(/\b\w/g, (ch) => ch.toUpperCase()));
    }
  } catch { /* scoring-config CITIES is the floor */ }
  footprintCache = [...names];
  return footprintCache;
}

function outOfAreaCityList() {
  try {
    const { outOfAreaCities } = require('./content-guardrails');
    const list = outOfAreaCities();
    if (Array.isArray(list) && list.length) return list;
  } catch { /* fall through to fail-closed default */ }
  // Fail closed: if the guardrails module can't load, the geo classifier
  // still blocks the metros a SWFL writer is most likely to drift into.
  return ['Tampa', 'St. Petersburg', 'Clearwater', 'Fort Myers', 'Cape Coral', 'Naples', 'Orlando', 'Miami', 'Jacksonville', 'Lakeland'];
}

function findAll(re, text) {
  if (!re) return [];
  const out = new Set();
  const g = new RegExp(re.source, 'gi');
  let m;
  while ((m = g.exec(text)) !== null) out.add(m[1] || m[0]);
  return [...out];
}

/**
 * classifyGeoScope(text) → { scope, out_of_area, footprint, regional, statewide }
 * scope precedence: out_of_area > footprint > regional > statewide > none.
 * A footprint anchor next to "Florida" is fine ("Sarasota, Florida"); an
 * out-of-area city anywhere in the targeting text is a block even when a
 * footprint city is also present ("Tampa vs Sarasota" is still built around
 * Tampa demand).
 */
function classifyGeoScope(text) {
  const t = String(text || '');
  const out_of_area = findAll(cityRe(outOfAreaCityList()), t);
  const footprint = findAll(cityRe(footprintCities()), t);
  const regional = findAll(REGIONAL_RE, t);
  const statewide = STATEWIDE_RE.test(t);
  let scope = 'none';
  if (out_of_area.length) scope = 'out_of_area';
  else if (footprint.length) scope = 'footprint';
  else if (regional.length) scope = 'regional';
  else if (statewide) scope = 'statewide';
  return { scope, out_of_area, footprint, regional, statewide };
}

/**
 * geoBlockReason(text, { allowStatewide }) → CODES.GEO_* or null. Shared by
 * the miner and the idea lane so every producer applies one definition.
 * Statewide is a FRAMING problem, not a demand problem: a GSC query like
 * "kinds of ants in florida" is legitimate demand the writer localizes, so
 * the miner passes allowStatewide:true and the draft's own title/slug is
 * judged post-draft (evaluateDraftFraming). A pinned title or an idea (which
 * IS a title) is framing and is judged strictly.
 */
function geoBlockReason(text, { allowStatewide = false } = {}) {
  const geo = classifyGeoScope(text);
  if (geo.scope === 'out_of_area') return CODES.GEO_OUT_OF_AREA;
  if (geo.scope === 'statewide' && !allowStatewide) return CODES.GEO_STATEWIDE;
  return null;
}

function geoFindings(geo, { allowStatewide = false, where = 'targeting' } = {}) {
  if (geo.scope === 'out_of_area') {
    return [{ severity: 'P0', code: CODES.GEO_OUT_OF_AREA, cities: geo.out_of_area, message: `${where} is built around out-of-footprint geo (${geo.out_of_area.join(', ')}). Educational mentions are fine; a post may not target demand Waves cannot serve.` }];
  }
  if (geo.scope === 'statewide' && !allowStatewide) {
    return [{ severity: 'P0', code: CODES.GEO_STATEWIDE, message: `${where} is statewide ("Florida"/"FL") with no served city or Southwest Florida anchor — too broad. Anchor the title/keyword to a served city or SWFL, or drop the geo qualifier.` }];
  }
  return [];
}

/**
 * evaluateDraftFraming(draft) — POST-draft framing check on the writer's own
 * title / slug / primary_keyword (emit_draft frontmatter, with top-level
 * title as the metadata-shape fallback). Statewide-only or out-of-area
 * framing here is a P0 the runner feeds back into the one-redraft loop.
 */
function evaluateDraftFraming(draft = {}) {
  const fm = draft?.frontmatter || {};
  const title = String(fm.title || draft?.title || '').trim();
  const slug = String(fm.slug || draft?.url || '').replace(/^https?:\/\/[^/]+/, '').trim();
  const keyword = String(fm.primary_keyword || '').trim();
  const text = [title, keyword, slug.replace(/[-/]+/g, ' ')].filter(Boolean).join(' ');
  const geo = classifyGeoScope(text);
  const findings = geoFindings(geo, { where: 'Draft title/slug/keyword framing' });
  return { ok: findings.length === 0, findings, geo, checked: { title, slug, primary_keyword: keyword } };
}

function isApplicable({ actionType = null, pageType = null } = {}) {
  if (actionType === 'refresh_existing_page') return false;
  return actionType === 'new_supporting_blog' || (!actionType && pageType === 'supporting-blog');
}

// ── corpus parsing (targeting fields only — never the body prose) ──────

function unquote(v) {
  const s = String(v || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

const TARGETING_SCALARS = new Set(['title', 'slug', 'primary_keyword', 'meta_description', 'category']);
const TARGETING_LISTS = new Set(['secondary_keywords']);

function parseTargetingFields(body) {
  const src = String(body || '');
  const out = { title: '', slug: '', primary_keyword: '', meta_description: '', category: '', secondary_keywords: [], headings: [] };
  let fm = '';
  let rest = src;
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) { fm = m[1]; rest = src.slice(m[0].length); }
  let listKey = null;
  for (const rawLine of fm.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { out[listKey].push(unquote(item[1])); continue; }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) { if (!/^\s/.test(line)) listKey = null; continue; }
    listKey = null;
    const [, key, value] = kv;
    if (TARGETING_SCALARS.has(key)) out[key] = unquote(value);
    else if (TARGETING_LISTS.has(key)) listKey = value.trim() === '' ? key : null;
  }
  const headingRe = /^#{2,3}\s+(.+?)\s*#*\s*$/gm;
  let h;
  while ((h = headingRe.exec(rest)) !== null) out.headings.push(h[1].replace(/[*_`]/g, ''));
  return out;
}

function targetingText(fields) {
  return [
    fields.title, fields.slug.replace(/[-/]+/g, ' '), fields.primary_keyword,
    fields.meta_description, ...fields.secondary_keywords, ...fields.headings,
  ].filter(Boolean).join(' ');
}

function normalizeSlug(s) {
  const raw = String(s || '').replace(/^https?:\/\/[^/]+/, '').trim().toLowerCase();
  if (!raw) return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
}

// Blog URLs are /{category}/{leaf}/ — the category is the first segment.
function categoryFromSlug(slug) {
  const m = normalizeSlug(slug).match(/^\/([a-z0-9-]+)\/[a-z0-9-]+\/$/);
  return m ? m[1] : null;
}

// Engine service keys → blog categories (mirrors intercept-brief-seeder's
// slug-prefix labeling). Unknown → null → compare against every category.
const SERVICE_TO_CATEGORY = Object.freeze({
  termite: 'termite', lawn: 'lawn-care', mosquito: 'mosquito', pest: 'pest-control',
  rodent: 'pest-control', 'tree-shrub': 'lawn-care', irrigation: 'lawn-care',
});

let cityTokenCache = null;
// Served-city name words ("lakewood", "ranch", "sarasota", "port") are geo
// qualifiers too — a city is never the entity a post owns.
function cityTokens() {
  if (cityTokenCache) return cityTokenCache;
  cityTokenCache = new Set(footprintCities().flatMap((c) => tokenize(c)));
  return cityTokenCache;
}

function entityTokens(text) {
  const cities = cityTokens();
  return [...new Set(tokenize(text))].filter((w) => w.length >= 4 && !GEO_TOKENS.has(w) && !GENERIC_TOKENS.has(w) && !cities.has(w));
}

/**
 * indexCorpus(corpus) — corpus items are { path, body, url } as produced by
 * internal-link-planner.loadAstroCorpus*. Returns per-post token sets plus
 * document frequency, so a caller evaluating many candidates pays for the
 * parse once.
 */
function indexCorpus(corpus = []) {
  const posts = [];
  const df = new Map();
  for (const item of corpus) {
    if (!item || typeof item.body !== 'string') continue;
    const fields = parseTargetingFields(item.body);
    const counts = new Map();
    for (const tok of tokenize(targetingText(fields))) counts.set(tok, (counts.get(tok) || 0) + 1);
    const url = normalizeSlug(item.url || fields.slug);
    const category = String(fields.category || categoryFromSlug(url) || '').toLowerCase() || null;
    posts.push({ url, title: fields.title, path: item.path || null, category, counts });
    for (const tok of counts.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  }
  return { posts, df };
}

/**
 * evaluate(candidate, { corpus | index, requireCorpus })
 *   candidate: { query, title, slug, secondaryKeywords, actionType, pageType }
 * → { ok, applicable, findings, geo, entity_owners, corpus_size }
 * Throws only when a corpus is required for an applicable candidate and none
 * was supplied — the runner maps that to an engine fault, never a pass.
 */
function evaluate(candidate = {}, { corpus = null, index = null, requireCorpus = true } = {}) {
  const applicable = isApplicable(candidate);
  const base = { ok: true, applicable, findings: [], geo: null, entity_owners: [], corpus_size: 0 };
  if (!applicable) return { ...base, skipped: 'not_a_new_blog' };

  const query = String(candidate.query || '').trim();
  const title = String(candidate.title || '').trim();
  const slug = String(candidate.slug || '').trim();
  const targeting = [query, title, slug.replace(/[-/]+/g, ' ')].filter(Boolean).join(' ');
  const geo = classifyGeoScope(targeting);
  // Pre-draft, statewide is only judged when the brief PINS framing (an
  // operator working title or slug). A bare query is demand — the writer
  // localizes it and evaluateDraftFraming judges the result.
  const pinnedFraming = Boolean(title || slug);
  const findings = geoFindings(geo, { allowStatewide: !pinnedFraming, where: pinnedFraming ? 'Pinned title/slug targeting' : 'Targeting' });
  if (findings.length) return { ...base, ok: false, findings, geo };

  const idx = index || (corpus ? indexCorpus(corpus) : null);
  if (!idx) {
    if (requireCorpus) throw new Error('topic-targeting-gate: blog corpus required for entity-ownership check');
    return { ...base, geo, skipped: 'no_corpus' };
  }
  const selfUrl = normalizeSlug(slug);
  // Ownership is judged WITHIN a category: a chemical or species name can
  // legitimately anchor a termite post and a mosquito post. Unknown category
  // → compare against all (conservative).
  const category = String(candidate.category || categoryFromSlug(slug) || SERVICE_TO_CATEGORY[String(candidate.service || '').toLowerCase()] || '').toLowerCase() || null;
  const owners = new Map();
  // Entities come from the PRIMARY keyword only — titles carry framing words
  // ("actual", "fail", "explained") that are not what the post targets.
  const tokens = entityTokens(query);
  for (const tok of tokens) {
    const n = idx.df.get(tok) || 0;
    if (n < 1 || n > RARE_ENTITY_DF_MAX) continue;
    for (const post of idx.posts) {
      if ((post.counts.get(tok) || 0) < OWNER_MIN_OCCURRENCES) continue;
      if (selfUrl && post.url === selfUrl) continue;
      if (category && post.category && post.category !== category) continue;
      const key = post.url || post.path || post.title;
      const entry = owners.get(key) || { url: post.url, title: post.title, entities: [] };
      entry.entities.push(tok);
      owners.set(key, entry);
    }
  }
  const entity_owners = [...owners.values()];
  if (entity_owners.length) {
    const ents = [...new Set(entity_owners.flatMap((o) => o.entities))];
    findings.push({
      severity: 'P0',
      code: CODES.CANNIBALIZES_EXISTING,
      entities: ents,
      owners: entity_owners.map((o) => o.url || o.title),
      message: `Entity "${ents.join('", "')}" is already owned by a live post (${entity_owners.map((o) => o.url || o.title).join(', ')}). One entity → one post: grow it as a refresh of the owner, not a sibling post.`,
    });
  }
  return { ...base, ok: findings.length === 0, findings, geo, entity_owners, category, corpus_size: idx.posts.length };
}

module.exports = {
  evaluate,
  evaluateDraftFraming,
  isApplicable,
  classifyGeoScope,
  geoBlockReason,
  indexCorpus,
  CODES,
  RARE_ENTITY_DF_MAX,
  OWNER_MIN_OCCURRENCES,
};
module.exports._internals = { parseTargetingFields, targetingText, entityTokens, normalizeSlug, categoryFromSlug, footprintCities, outOfAreaCityList, SERVICE_TO_CATEGORY };
