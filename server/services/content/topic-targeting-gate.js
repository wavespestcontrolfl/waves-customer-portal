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

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
// Entity IDENTITY (uncapped audit 2026-08-27, measured on the live corpus):
// token rarity alone made "december", "yellow", "crazy", "mites" owned
// entities and would have blocked ~15% of the live posts as new candidates.
// A brand/product/system name is written as a proper noun in body prose —
// Taexx / Termidor / Sentricon / Advion / Pestie score 1.00 capitalized
// mid-sentence across the corpus; every ordinary word scored ≤ 0.40. Species
// and chemicals are lowercase and are the uniqueness gate's concern, not this
// one's. Months/days are capitalized too and are excluded by name.
const PROPER_NOUN_MIN_RATIO = 0.8;
const PROPER_NOUN_MIN_MENTIONS = 2;
const CALENDAR_TOKENS = new Set([
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);
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
  SLUG_COLLIDES_LIVE: 'TOPIC_SLUG_COLLIDES_LIVE',
});

// Regional phrasings that anchor a topic to the footprint without naming a
// city. County names are the footprint counties only — out-of-area counties
// live in the guardrails blocklist and classify as out_of_area.
const REGIONAL_RE = /\b(southwest florida|sw florida|swfl|gulf coast|suncoast|sun coast|manatee county|sarasota county|charlotte county)\b/i;
const STATEWIDE_RE = /\bflorida\b|\bfl\b/i;
// Any other US state (or territory) named in targeting text is
// out-of-footprint by construction. "Virginia" and "Washington" are left
// out — both are common person names (Virginia runs the Waves office).
// Postal abbreviations. "Safe" ones are not English words and count after
// any word ("plano tx", "fresno, ca"); ambiguous ones (in, or, me, ok, va —
// "wdo inspection va loan" is a real termite topic) count only after a comma.
const STATE_ABBR_SAFE = 'ak|az|ca|ct|dc|ga|ia|il|ks|ky|mn|nc|nd|nh|nj|nm|nv|ny|ri|sc|sd|tn|tx|ut|vt|wa|wi|wv|wy';
const STATE_ABBR_AMBIGUOUS = 'al|ar|co|de|hi|id|in|la|ma|md|me|mi|mo|ms|ne|oh|ok|or|pa|va';
const STATE_ABBR_RE = new RegExp(`\\b[a-z]+,?\\s+(${STATE_ABBR_SAFE})\\b(?![a-z])|,\\s*(${STATE_ABBR_SAFE}|${STATE_ABBR_AMBIGUOUS})\\b(?![a-z])`, 'i');
// Place names that are also ordinary words or person names. Deliberately
// NOT in the shared content-guardrails blocklist (which scans body prose);
// here they count only with geographic context — "in/near <Name>" or
// "<Name>, <state>" — where they can only mean the place.
const CONTEXT_PLACE_NAMES = Object.freeze([
  'Homestead', 'Weston', 'Jupiter', 'Wellington', 'Hollywood', 'Kendall', 'Davie',
  'Largo', 'Destin', 'Navarre', 'Inverness', 'Clermont', 'Austin', 'Phoenix',
  'Savannah', 'Boston', 'Houston', 'Dallas', 'Cleveland', 'Richmond', 'Charleston',
  // The guardrails' own documented exclusions (person names / common nouns).
  'Brandon', 'Sunrise', 'Plantation', 'Cocoa', 'Mobile', 'Stuart', 'Sebastian',
  'Orlando', 'Lakeland',
]);
// Washington and Virginia are common person names (Virginia runs the Waves
// office), so they count only with state context: "in/near Washington",
// "Washington state", or as the trailing geo of a query ("spokane
// washington") when the word before them is not a person-name cue.
const NAME_STATE_RE = /\b(?:in|near|around|across|serving)\s+(washington|virginia)\b|\b(washington|virginia)\s+state\b|\b(?!(?:ask|meet|with|from|by|and|contact|call|text|email|thanks|thank|our|the|hi|hello|dear)\b)[a-z]+,?\s+(washington|virginia)\s*$/i;
const OUT_OF_STATE_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|west virginia|wisconsin|wyoming|puerto rico)\b/i;

// Tokens that are geo qualifiers, not topic entities — excluded from the
// entity-ownership scan regardless of document frequency.
const STATE_NAME_SOURCE = OUT_OF_STATE_RE.source.slice(2, -2); // "(alabama|…)" → alternatives
// "in/near <Name>" counts only at a phrase boundary — end of text, a comma,
// colon, dash, or a state suffix — so "pest control in mobile homes" and
// "pests in cocoa mulch" stay topics, while "pest control in Brandon" and
// "Ants in Cocoa: What to Do" are places.
const CONTEXT_PLACE_RE = new RegExp(
  `\\b(?:in|near|around|serving|across)\\s+(${CONTEXT_PLACE_NAMES.map(escapeRe).join('|')})(?=\\s*(?:$|[,:;|–—-]|\\?|\\s+(?:fl|florida|${STATE_ABBR_SAFE}|${STATE_ABBR_AMBIGUOUS}|${STATE_NAME_SOURCE})\\b))`
  + `|\\b(${CONTEXT_PLACE_NAMES.map(escapeRe).join('|')}),?\\s+(?:fl|florida|${STATE_ABBR_SAFE}|${STATE_ABBR_AMBIGUOUS}|${STATE_NAME_SOURCE})\\b(?![a-z])`,
  'i'
);

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

// Coverage is the canonical content-guardrails blocklist (curated FL
// cities/counties + major US metros) plus OUT_OF_STATE_RE. Unlisted small
// towns are not detectable deterministically without a gazetteer; the
// blocklist is the single place to grow.
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
  while ((m = g.exec(text)) !== null) out.add(m.slice(1).find(Boolean) || m[0]);
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
  const out_of_area = [
    ...findAll(cityRe(outOfAreaCityList()), t),
    ...findAll(OUT_OF_STATE_RE, t),
    ...findAll(NAME_STATE_RE, t),
    ...findAll(CONTEXT_PLACE_RE, t),
    ...findAll(STATE_ABBR_RE, t).map((s) => s.toUpperCase()),
  ];
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

/**
 * geoFindingsForParts(parts) — each targeting part is classified ON ITS OWN:
 * a served city in the keyword must never rescue a statewide title ("Pest
 * Control in Florida" + "pest control sarasota" is still a statewide title).
 *   parts: [{ text, where, framing }] — framing parts (title, slug) are
 *   judged for statewide-only scope; a keyword/query is demand and only ever
 *   blocks on an out-of-footprint geo (the writer localizes statewide demand).
 * Returns at most one finding: out-of-area anywhere wins, then statewide.
 */
function geoFindingsForParts(parts) {
  const scoped = parts.filter((p) => p.text).map((p) => ({ ...p, geo: classifyGeoScope(p.text) }));
  const outOfArea = scoped.filter((p) => p.geo.scope === 'out_of_area');
  if (outOfArea.length) {
    const cities = [...new Set(outOfArea.flatMap((p) => p.geo.out_of_area))];
    return [{ severity: 'P0', code: CODES.GEO_OUT_OF_AREA, cities, message: `${outOfArea.map((p) => p.where).join(' + ')} built around out-of-footprint geo (${cities.join(', ')}). Educational mentions are fine; a post may not target demand Waves cannot serve.` }];
  }
  const statewide = scoped.filter((p) => p.framing && p.geo.scope === 'statewide');
  if (statewide.length) {
    return [{ severity: 'P0', code: CODES.GEO_STATEWIDE, message: `${statewide.map((p) => p.where).join(' + ')} is statewide ("Florida"/"FL") with no served city or Southwest Florida anchor — too broad. Anchor it to a served city or SWFL, or drop the geo qualifier.` }];
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
  const findings = geoFindingsForParts([
    { text: title, where: 'Draft title', framing: true },
    { text: slug.replace(/[-/]+/g, ' '), where: 'Draft slug', framing: true },
    { text: keyword, where: 'Draft primary_keyword', framing: false },
  ]);
  const geo = classifyGeoScope([title, keyword, slug.replace(/[-/]+/g, ' ')].filter(Boolean).join(' '));
  return { ok: findings.length === 0, findings, geo, checked: { title, slug, primary_keyword: keyword } };
}

/**
 * evaluateDraftTargeting(draft, { index, category, service }) — the full
 * post-draft check: framing on the writer's own title/slug, THEN entity
 * ownership on the writer's own primary_keyword (emit_draft does not require
 * it to equal the brief keyword, so a clean brief can still emit an owned
 * entity). `stage` tells the caller which check failed.
 */
function evaluateDraftTargeting(draft = {}, { index, category = null, service = null } = {}) {
  const framing = evaluateDraftFraming(draft);
  if (!framing.ok) return { ...framing, stage: 'framing' };
  const fm = draft?.frontmatter || {};
  // The EMITTED category is authoritative (the publisher writes it); the
  // slug and the coarse service are fallbacks inside evaluate().
  const emittedCategory = category || canonicalCategory(fm.category) || null;
  const own = evaluate(
    { actionType: 'new_supporting_blog', query: String(fm.primary_keyword || '').trim(), title: framing.checked.title, slug: framing.checked.slug, category: emittedCategory, service },
    { index, requireCorpus: true }
  );
  return { ...own, checked: framing.checked, stage: own.ok ? 'ok' : 'ownership' };
}

/**
 * loadLiveIndex() — the live hub blog corpus (GitHub), indexed. Throws when
 * the corpus is unavailable or empty; every caller treats that as fail
 * closed (no draft, no idea, no publish) rather than skipping the check.
 */
async function loadLiveIndex() {
  const planner = require('./internal-link-planner');
  const corpus = await planner.loadAstroCorpusFromGitHub({ collections: ['blog'] });
  if (!Array.isArray(corpus) || corpus.length === 0) throw new Error('empty_blog_corpus');
  return indexCorpus(corpus);
}

function isLiveRow(post = {}) {
  return post.astro_status === 'live' || post.astro_status === 'merged' || Boolean(post.astro_live_url);
}

/**
 * evaluateBlogPostRow(post, { index | loadIndex, category }) — a legacy
 * `blog_posts` row (idea lane, 5 a.m. generator, admin generator, calendar
 * publish). A row already live on the hub is a refresh and is exempt — decided
 * BEFORE the corpus is loaded, so a corpus outage never blocks a refresh.
 */
async function evaluateBlogPostRow(post = {}, { index = null, loadIndex = loadLiveIndex, category = null } = {}) {
  if (isLiveRow(post)) return { ok: true, applicable: false, findings: [], skipped: 'already_live' };
  const slug = String(post.slug || '').trim();
  return evaluate(
    { actionType: 'new_supporting_blog', query: post.keyword || '', title: post.title || '', slug: slug ? `/${slug.replace(/^\/+|\/+$/g, '')}/` : '', category },
    { index: index || await loadIndex(), requireCorpus: true }
  );
}

function isApplicable({ actionType = null, pageType = null } = {}) {
  if (actionType === 'refresh_existing_page') return false;
  return actionType === 'new_supporting_blog' || (!actionType && pageType === 'supporting-blog');
}

// ── corpus parsing (targeting fields only — never the body prose) ──────

const { parse: parseFrontmatter } = require('../content-astro/frontmatter');

const TARGETING_SCALARS = ['title', 'slug', 'primary_keyword', 'meta_description', 'category'];

function asStringList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

// Frontmatter via the canonical js-yaml parser (content-astro/frontmatter),
// so inline arrays and folded/multiline scalars count toward ownership.
// Unparseable frontmatter yields empty targeting fields — such a post could
// not have built on the live site either.
function parseTargetingFields(body) {
  const src = String(body || '');
  let data = {};
  let rest = src;
  try {
    ({ data, content: rest } = parseFrontmatter(src));
  } catch { data = {}; rest = ''; }
  const out = { secondary_keywords: asStringList(data.secondary_keywords), headings: [] };
  for (const key of TARGETING_SCALARS) out[key] = data[key] == null ? '' : String(data[key]).trim();
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
  rodent: 'pest-control', 'tree-shrub': 'tree-shrub', irrigation: 'lawn-care',
});

// The publisher owns the canonical category vocabulary (frontmatter
// `category`). Lazy — the publisher requires this module.
function canonicalCategory(category, tag = null) {
  if (!category && !tag) return null;
  try {
    const { normalizeCategory } = require('../content-astro/astro-publisher');
    return normalizeCategory(category, tag) || null;
  } catch {
    return String(category || '').trim().toLowerCase() || null;
  }
}

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
// Body prose only (no frontmatter, headings, code, link targets, or markup),
// for the proper-noun measurement — headings are Title Case and would count
// every word as capitalized.
function proseOf(body) {
  let rest = String(body || '');
  try { ({ content: rest } = parseFrontmatter(rest)); } catch { rest = ''; }
  return rest
    .replace(/^#.*$/gm, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, ' ');
}

// tok → { cap, low }: how often the token appears capitalized vs lowercase
// mid-sentence (sentence starts and list bullets are skipped) across the
// whole corpus' prose.
const PROSE_WORD_RE = /(^|[.!?]\s+|\n\s*|[^\w'’-])([A-Za-z][A-Za-z0-9'’-]{2,})/g;
function accumulateProperNounStats(prose, stats) {
  const re = new RegExp(PROSE_WORD_RE.source, 'g');
  let m;
  while ((m = re.exec(prose)) !== null) {
    const pre = m[1];
    const word = m[2];
    const sentenceStart = pre === '' || /[.!?]\s+$/.test(pre) || /\n\s*$/.test(pre) || /[-*]\s$/.test(pre);
    if (sentenceStart) continue;
    const tok = word.toLowerCase().replace(/[’']/g, '');
    const s = stats.get(tok) || { cap: 0, low: 0 };
    if (/^[A-Z]/.test(word)) s.cap++; else s.low++;
    stats.set(tok, s);
  }
}

function properNounsFrom(stats) {
  const out = new Set();
  for (const [tok, s] of stats) {
    const n = s.cap + s.low;
    if (n >= PROPER_NOUN_MIN_MENTIONS && s.cap / n >= PROPER_NOUN_MIN_RATIO && !CALENDAR_TOKENS.has(tok)) out.add(tok);
  }
  return out;
}

function indexCorpus(corpus = []) {
  const posts = [];
  const nounStats = new Map();
  for (const item of corpus) {
    if (!item || typeof item.body !== 'string') continue;
    const fields = parseTargetingFields(item.body);
    const counts = new Map();
    for (const tok of tokenize(targetingText(fields))) counts.set(tok, (counts.get(tok) || 0) + 1);
    const url = normalizeSlug(item.url || fields.slug);
    const category = String(fields.category || categoryFromSlug(url) || '').toLowerCase() || null;
    posts.push({ url, title: fields.title, path: item.path || item.file || null, category, counts });
    accumulateProperNounStats(proseOf(item.body), nounStats);
  }
  return { posts, df: documentFrequency(posts), dfByCategory: new Map(), properNouns: properNounsFrom(nounStats) };
}

function documentFrequency(posts) {
  const df = new Map();
  for (const post of posts) for (const tok of post.counts.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  return df;
}

// Posts a candidate in `category` is compared against: same category, plus
// posts whose category is unknown (conservative). Unknown candidate category
// → every post.
function compatiblePosts(idx, category) {
  return category ? idx.posts.filter((p) => !p.category || p.category === category) : idx.posts;
}

// Rarity is judged over the SAME post set ownership is judged over. A global
// count would let a token common across categories ("bait" in termite AND
// pest posts) hide the one same-category post that owns it.
function dfForCategory(idx, category) {
  if (!category) return idx.df;
  if (!idx.dfByCategory) idx.dfByCategory = new Map();
  if (!idx.dfByCategory.has(category)) idx.dfByCategory.set(category, documentFrequency(compatiblePosts(idx, category)));
  return idx.dfByCategory.get(category);
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
  const geo = classifyGeoScope([query, title, slug.replace(/[-/]+/g, ' ')].filter(Boolean).join(' '));
  // Pre-draft, statewide is judged only on PINNED framing (an operator
  // working title or slug), each on its own. A bare query is demand — the
  // writer localizes it and evaluateDraftFraming judges the result.
  const findings = geoFindingsForParts([
    { text: query, where: 'Primary keyword', framing: false },
    { text: title, where: 'Pinned title', framing: true },
    { text: slug.replace(/[-/]+/g, ' '), where: 'Pinned slug', framing: true },
  ]);
  if (findings.length) return { ...base, ok: false, findings, geo };

  const idx = index || (corpus ? indexCorpus(corpus) : null);
  if (!idx) {
    if (requireCorpus) throw new Error('topic-targeting-gate: blog corpus required for entity-ownership check');
    return { ...base, geo, skipped: 'no_corpus' };
  }
  const selfUrl = normalizeSlug(slug);
  // A NEW blog may not reuse a live post's URL: that would reach the
  // publisher's update-in-place path without the refresh safeguards. (Rows
  // already live are exempted upstream by isLiveRow / refresh_existing_page;
  // nothing that enters evaluate() legitimately owns an existing URL.)
  if (selfUrl && idx.posts.some((post) => post.url === selfUrl)) {
    findings.push({ severity: 'P0', code: CODES.SLUG_COLLIDES_LIVE, url: selfUrl, message: `Slug ${selfUrl} is a LIVE post. A new blog may not reuse a live URL — grow the existing post as a refresh instead.` });
  }
  // Ownership is judged WITHIN a category: a chemical or species name can
  // legitimately anchor a termite post and a mosquito post. Unknown category
  // → compare against all (conservative).
  const category = String(candidate.category || categoryFromSlug(slug) || SERVICE_TO_CATEGORY[String(candidate.service || '').toLowerCase()] || '').toLowerCase() || null;
  const owners = new Map();
  const pool = compatiblePosts(idx, category);
  const df = dfForCategory(idx, category);
  // Entities come from every targeting field (keyword + title + slug): an
  // idea may carry a generic or empty keyword with the owned entity only in
  // its title ("Your New Home Came With Taexx"). Framing words in titles
  // ("actual", "explained") never trip it — an owner must be BUILT AROUND
  // the token (≥ OWNER_MIN_OCCURRENCES across its own targeting fields).
  const properNouns = idx.properNouns || new Set();
  const tokens = entityTokens([query, title, slug.replace(/[-/]+/g, ' ')].filter(Boolean).join(' ')).filter((tok) => properNouns.has(tok));
  for (const tok of tokens) {
    const n = df.get(tok) || 0;
    if (n < 1 || n > RARE_ENTITY_DF_MAX) continue;
    for (const post of pool) {
      if ((post.counts.get(tok) || 0) < OWNER_MIN_OCCURRENCES) continue;
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
  evaluateDraftTargeting,
  evaluateBlogPostRow,
  isLiveRow,
  loadLiveIndex,
  isApplicable,
  classifyGeoScope,
  geoBlockReason,
  indexCorpus,
  CODES,
  RARE_ENTITY_DF_MAX,
  OWNER_MIN_OCCURRENCES,
  PROPER_NOUN_MIN_RATIO,
};
module.exports._internals = { CONTEXT_PLACE_NAMES, proseOf, parseTargetingFields, targetingText, entityTokens, dfForCategory, compatiblePosts, normalizeSlug, categoryFromSlug, footprintCities, outOfAreaCityList, SERVICE_TO_CATEGORY };
