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
    .replace(/[’']s\b/g, '') // possessive: "Taexx's" → taexx, never taexxs
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
// Compounds where "Florida"/"fl" is not geography: the Florida room (a
// lanai-style sunroom), the fluid ounce, and the governed pest / weed names
// that carry the word (service-pricing + the live corpus: Florida woods
// cockroach, carpenter/harvester ant, dampwood termite, predatory stink bug,
// pusley, betony, wax/red scale). A title built around one of these is a
// species topic the writer localizes, not statewide framing.
const STATEWIDE_EXEMPT_RE = /\bflorida\s+rooms?\b|\bfl\.?\s*oz\b|\bflorida\s+(?:woods?\s+(?:cock)?roach(?:es)?|carpenter\s+ants?|harvester\s+ants?|dampwood\s+termites?|predatory\s+stink\s*bugs?|pusley|betony|wax\s+scales?|red\s+scales?)\b/gi;
// Any other US state (or territory) named in targeting text is
// out-of-footprint by construction. "Virginia" and "Washington" are left
// out — both are common person names (Virginia runs the Waves office).
// Postal abbreviations. "Safe" ones are not English words and count after
// any word or at the start ("plano tx", "fresno, ca", "tx termite treatment",
// a slug's "/tx-termite-control/" once its dashes are spaces); ambiguous ones (in, or, me, ok, va —
// "wdo inspection va loan" is a real termite topic) count only after a comma.
const STATE_ABBR_SAFE = 'ak|az|ca|ct|dc|ga|ia|il|ks|ky|mn|nc|nd|nh|nj|nm|nv|ny|ri|sc|sd|tn|tx|ut|vt|wa|wi|wv|wy';
const STATE_ABBR_AMBIGUOUS = 'al|ar|co|de|hi|id|in|la|ma|md|me|mi|mo|ms|ne|oh|ok|or|pa|va';
// "mt" is also "Mount" ("mt dora", "mt pleasant"), so it is Montana only
// when it ends the phrase ("billings mt") or follows a comma ("Billings, MT").
const STATE_ABBR_TRAILING = 'mt';
// Service-intent words: "<place> pest control" / "<abbr> exterminator" is a
// geographic search phrase even without a preposition or a state suffix.
const SERVICE_INTENT = 'pest control|pest|pests|exterminator|exterminators|termite|termites|lawn care|lawn|mosquito|mosquitoes|rodent|rodents|wdo|fumigation|bed bugs?';
// Service nouns that may sit between the intent word and the place in the
// service-first form ("termite treatment austin"). Never a preposition —
// "pests in cocoa mulch" is a topic, and the preposition forms carry
// their own boundary rules.
const SERVICE_FILLER = 'treatment|treatments|service|services|company|companies|control|removal|inspection|inspections|cost|costs|price|prices|pricing|experts|specialists';
// Ambiguous abbreviations that are NOT English words: they also count in
// "<word> <abbr> <service>" ("boulder co pest control"). The pure English
// words (hi, in, me, oh, ok, or) never do — "pest control or exterminator".
const STATE_ABBR_SEMI = 'al|ar|co|de|id|la|ma|md|mi|mo|ms|ne|pa|va';
// Every single word of SERVICE_INTENT + SERVICE_FILLER (plus the geo
// prepositions) — words that can never be the "locality" of a place phrase.
// (Pest / lawn nouns too: "ants or termites" is a conjunction, not Oregon.)
const PEST_NOUNS = 'ant|ants|roach|roaches|cockroach|cockroaches|spider|spiders|flea|fleas|tick|ticks|bee|bees|wasp|wasps|hornet|hornets|rat|rats|mouse|mice|mosquito|mosquitoes|bug|bugs|insect|insects|weed|weeds|grub|grubs|snail|snails|moth|moths|silverfish|earwig|earwigs|scorpion|scorpions|gnat|gnats|fly|flies|beetle|beetles|aphid|aphids|whitefly|whiteflies|chinch|mold|fungus|fungi|grass|sod|lawns|trees|shrubs|palms';
const SERVICE_TOKENS = [...new Set(`${SERVICE_INTENT}|${SERVICE_FILLER}|${PEST_NOUNS}|in|near|around|serving|across|for|and|vs|versus|with|without|diy|me|you|us`.split('|').flatMap((w) => w.split(/\s+/)).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean))].join('|');
const STATE_ABBR_RE = new RegExp(
  `(?:^\\s*|\\b[a-z]+,?\\s+)(${STATE_ABBR_SAFE})\\b(?![a-z])`
  + `|\\b[a-z]+,?\\s+(${STATE_ABBR_TRAILING})(?=\\s*(?:$|[,:;|?!–—-]))`
  // Comma form: non-word abbreviations only — "Roof Rat, Norway Rat, or
  // Mouse?" is a list, and "in/me/ok/hi/oh" after a comma are English too.
  + `|,\\s*(${STATE_ABBR_SAFE}|${STATE_ABBR_SEMI}|${STATE_ABBR_TRAILING})\\b(?![a-z])`
  // "pest control in va" — a non-word ambiguous abbreviation right after a
  // geo preposition, at the end of the phrase ("pest control near me" and
  // "ants in or around" are not: me/or are English words).
  + `|\\b(?:in|near|around|serving|across)\\s+(${STATE_ABBR_SEMI}|${STATE_ABBR_TRAILING})(?=\\s*(?:$|[,:;|?!–—-]))`
  + `|\\b[a-z]+\\s+(${STATE_ABBR_SEMI})\\s+(?:${SERVICE_INTENT})\\b`
  // "al termite treatment" / "pa pest control laws" — a non-word ambiguous
  // abbreviation LEADING the text before a service ("in wall pest control"
  // and "or pest control" never: in/or are English words, not in SEMI).
  + `|^\\s*(${STATE_ABBR_SEMI})\\s+(?:(?:${SERVICE_FILLER})\\s+)?(?:${SERVICE_INTENT})\\b`
  // "pest control omaha ne" / "termite treatment boulder co" — service, an
  // optional service noun, a locality word, then a non-word ambiguous
  // abbreviation ending the phrase ("pest control near me": me ∉ SEMI).
  + `|\\b(?:${SERVICE_INTENT})\\s+(?:(?:${SERVICE_FILLER})\\s+)?[a-z]+\\s+(${STATE_ABBR_SEMI})(?=\\s*(?:$|[,:;|?!–—-]))`
  // Oregon: "or" is an English word, so it counts only between a LOCALITY
  // word (not itself a service/filler word) and service intent — "portland
  // or pest control", "salem or termite treatment" — or trailing after
  // "<service> <locality>" ("pest control portland or"). "pest control or
  // exterminator" and "termite treatment cost or price" stay clear.
  + `|\\b(?!(?:${SERVICE_TOKENS})\\b)[a-z]+,?\\s+(or)\\s+(?:(?:${SERVICE_FILLER})\\s+)?(?:${SERVICE_INTENT})\\b`
  + `|\\b(?:${SERVICE_INTENT})\\s+(?:(?:${SERVICE_FILLER})\\s+)?(?!(?:${SERVICE_TOKENS})\\b)[a-z]+,?\\s+(or)(?=\\s*(?:$|[,:;|?!–—-]))`,
  'i'
);
// Hillsborough County is split: its south end (SOUTH_HILLSBOROUGH_CITIES in
// config/locations.js) is served from Parrish; the rest is Tampa. County-wide
// targeting is out-of-area UNLESS one of those south-Hillsborough towns
// anchors it — a served city elsewhere ("Hillsborough County vs Sarasota
// County") does not. That is why the county stays OUT of the shared prose
// blocklist: "Ruskin, in south Hillsborough County" is a true claim.
const SPLIT_COUNTY_RE = /\bhillsborough county\b/i;
const FOOTPRINT_VERNACULAR_RE = /\b(?:saw\s+palmetto|palmetto\s+bugs?|laurel\s+oaks?|cherry\s+laurel|laurel\s+wilt)\b/gi;
let southHillsboroughCache;
function southHillsboroughRe() {
  if (southHillsboroughCache !== undefined) return southHillsboroughCache;
  try {
    const { SOUTH_HILLSBOROUGH_CITIES } = require('../../config/locations');
    southHillsboroughCache = cityRe(SOUTH_HILLSBOROUGH_CITIES || []);
  } catch { southHillsboroughCache = null; } // fail closed: the county always blocks
  return southHillsboroughCache;
}
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
  'Orlando', 'Lakeland', 'Orange',
  // Major metros that are also names / words (PR #3549 codex r11).
  'Jackson', 'Lincoln', 'Madison', 'Aurora', 'Mesa', 'Buffalo',
  'Arlington', 'Springfield', 'Salem', 'Eugene', 'Tyler', 'Garland', 'Irving',
  'Chandler', 'Gilbert', 'Glendale', 'Riverside', 'Independence', 'Columbia',
  'Montgomery', 'Concord', 'Providence', 'Manchester', 'Burlington', 'Dover',
  'Bend', 'Kent', 'Fremont', 'Pasadena', 'Burbank', 'Augusta', 'Macon',
  'Lafayette', 'Alexandria', 'Rochester', 'Lancaster', 'Warren', 'Sterling',
  'Henderson',
  // Foreign cities that are also names / words (PR #3549 codex r12).
  'London', 'Sydney', 'Paris', 'Rome', 'Victoria', 'Hamilton', 'Kingston',
  'Windsor', 'Cambridge', 'Oxford', 'Newcastle', 'Brighton', 'Adelaide',
  'Darwin', 'Halifax', 'Regina', 'Nice', 'Bath', 'Reading', 'Milton',
]);
// Washington and Virginia are common person names (Virginia runs the Waves
// office), so they count only with state context: "in/near Washington",
// "Washington state", or as the trailing geo of a query ("spokane
// washington") when the word before them is not a person-name cue.
// "Virginia termite treatment" / "Washington pest control" — the name
// directly before a service (optionally a service noun) is the state; "ask
// virginia about pest control" is not (about ≠ service word).
const NAME_STATE_RE = new RegExp(
  '\\b(?:in|near|around|across|serving)\\s+(washington|virginia)\\b|\\b(washington|virginia)\\s+state\\b'
  + '|\\b(?!(?:ask|meet|with|from|by|and|contact|call|text|email|thanks|thank|our|the|hi|hello|dear)\\b)[a-z]+,?\\s+(washington|virginia)\\s*$'
  // …or a governed pest noun ("Virginia ant control", "Washington spiders").
  + `|\\b(washington|virginia)\\s+(?:(?:${SERVICE_FILLER})\\s+)?(?:${SERVICE_INTENT}|${PEST_NOUNS})\\b`,
  'i'
);
// State names that are part of a plant / breed / species name, not a market:
// stripped before the state, abbreviation and context-place matchers.
const OUT_OF_STATE_EXEMPT_RE = /\b(?:texas\s+(?:sage|lantana|star\s+hibiscus|ranger|red\s+oak|persimmon|mountain\s+laurel|olive|ebony)|maine\s+coons?|california\s+(?:carpenter\s+bees?|poppy|poppies|king\s*snakes?|pepper\s+trees?|sycamores?|laurel|lilac)|kentucky\s+(?:bluegrass|coffee\s*trees?|wisteria)|carolina\s+(?:jasmine|jessamine|wren|cherry\s+laurel|silverbell)|arizona\s+(?:cypress|ash|bark\s+scorpions?)|louisiana\s+iris(?:es)?|mississippi\s+kites?|indiana\s+bats?|tennessee\s+warblers?|georgia\s+peach(?:es)?|alaska\s+cedars?|colorado\s+(?:blue\s+)?spruce|virginia\s+(?:creeper|pine|bluebells?|opossums?)|washington\s+(?:navel|hawthorn)|new\s+england\s+asters?|nevada\s+jointfir|oregon\s+grape)\b/gi;
// The guardrails own the metro-compound list (both scans must agree); a
// missing export means nothing is exempted (fail closed).
let geoCompoundCache;
function geoCompoundExemptRe() {
  if (geoCompoundCache !== undefined) return geoCompoundCache;
  try {
    const { GEO_COMPOUND_EXEMPT_RE } = require('./content-guardrails');
    geoCompoundCache = GEO_COMPOUND_EXEMPT_RE instanceof RegExp ? new RegExp(GEO_COMPOUND_EXEMPT_RE.source, 'gi') : /$^/g;
  } catch { geoCompoundCache = /$^/g; }
  return geoCompoundCache;
}
// Foreign targeting is out of footprint by construction: countries /
// regions, and the major foreign localities that appear in search demand.
// Foreign cities that are also names or words (London, Sydney, Paris, Rome,
// Victoria, Hamilton, Kingston, Windsor, Cambridge, Oxford, Newcastle,
// Brighton, Adelaide, Darwin, Halifax, Regina, Nice, Bath, Reading) live in
// CONTEXT_PLACE_NAMES and count only with geo/service context.
// Country / nation words inside species, plant and material names are not
// markets: stripped with the state-named species before the matchers.
const FOREIGN_EXEMPT_RE = /\b(?:norway\s+(?:rats?|spruces?|maples?)|turkey\s+(?:oaks?|vultures?|tail|mites?|gnats?)|wild\s+turkeys?|spanish\s+(?:moss|needles?|bayonets?|daggers?|lime)|french\s+drains?|italian\s+cypress|english\s+ivy|irish\s+moss|jamaica\s+dogwood|china\s+(?:rose|doll)|chile\s+peppers?|india\s+hawthorn|panama\s+hats?|greece\s+laurel|japan\s+(?:cedar|privet)|guatemala\s+rhubarb|brazil\s+nuts?|cuba\s+laurel|dubai\s+chocolate|peru\s+lily)\b/gi;
// Pesticide formulation suffixes (SC = suspension concentrate, CS, WP, WDG,
// …) after a governed product name are not state abbreviations — scrubbed
// before the abbreviation matchers. "Columbia SC pest control" still is.
const FORMULATION_EXEMPT_RE = /\b(?:termidor|taurus|medallion|torque|conserve|bifen|bifenthrin|suspend|fipro|tengard|cyzmic|onslaught|dominion|premise|altriset|transport|alpine|phantom|demand|talstar|tempo|celsius|advion|blindside|headway|prodiamine|dimension|arena|acelepryn|merit|safari|xylecore|specticle|certainty|manuscript|tribute|sedgehammer|quali-pro|lesco|adjourn|floramite|roundup\s+quikpro|quikpro|essentria|mavrik|avid|orthene|sevin|spinosad|conserve|eagle|heritage|banner\s+maxx|prostar|fame|pillar|velocity|monument|katana|revolver|negate|drive\s+xlr8|tenacity|speedzone|trimec|q4|barricade|pendulum|gallery|snapshot|ronstar|regalkade)\s+(?:sc|cs|wp|wsb|ec|wg|wdg|sg|me|ew|ulv|xt|zc|g|p|pro|total|ls|sl|sc\/ls|xlr8|maxx)\b|\b[a-z][a-z-]*\s+(?:sc|cs|wp|wdg|wg|ec|ls|sl)\s+(?:for|mosquito|mosquitoes|mite|mites|weed|weeds|insect|insects|termite|termites|lawn|turf|control|application|applications|rate|rates|label|mix|mixing|per|oz|ounces|gallon|gallons|spray|treatment|termiticide|insecticide|fungicide|herbicide|miticide)\b/gi;
// Nationwide domestic targeting is not footprint-anchored either.
// Bare "US" / "America" only in unambiguous nationwide forms ("in the US",
// "across America", "US pest control") — "let us help" / "American
// cockroach" are not geography.
const NATIONWIDE_RE = new RegExp(
  `\\b(?:united states|u\\.s\\.a?\\.?|usa|nationwide|america|all 50 states|every state)(?![a-z])`
  + `|\\b(?:in|across|throughout|around|serving|anywhere in)\\s+(?:the\\s+)?(?:us|u\\.s\\.|states)(?![a-z])`
  + `|\\bus\\s+(?:${SERVICE_INTENT})\\b`,
  'i'
);
// Chemical symbols and agronomic / measurement abbreviations that collide
// with postal codes (Ca, Mg, K, GA = gibberellic acid, CT values, …) — scrubbed
// before the abbreviation matchers when they carry that context.
const SCIENCE_EXEMPT_RE = /\b(?:(?:low|high|soil|leaf|tissue|available|excess|deficient|deficiency|deficiencies|adequate|optimal|foliar|calcium|magnesium|potassium|nitrogen|phosphorus|sulfur|iron|ppm|mg\/l|percent|%)\s+(?:ca|mg|k|n|p|s|fe|mn|zn|cu|b|mo|al|na|cl|co|ni)|(?:ca|mg|k|n|p|fe|mn|zn|cu|na|al|co|ni)\s+(?:levels?|deficienc(?:y|ies)|ratios?|content|uptake|availability|toxicity|sufficiency|in\s+(?:soil|soils|turf|lawns?|grass|leaves|plants?|tissue))|ga(?:3)?\s+(?:applications?|treatments?|sprays?|levels?|rates?|concentrations?|sensitivity)|ct\s+(?:values?|scans?|products?|calculations?|concentration))\b/gi;
const OUT_OF_COUNTRY_RE = /\b(canada|mexico|united kingdom|uk|u\.k\.|england|scotland|wales|northern ireland|ireland|australia|new zealand|india|pakistan|bangladesh|germany|france|spain|italy|portugal|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|greece|turkey|brazil|argentina|chile|colombia|peru|venezuela|costa rica|panama|guatemala|honduras|el salvador|nicaragua|dominican republic|haiti|jamaica|bahamas|bermuda|cayman islands|trinidad|barbados|cuba|south africa|nigeria|kenya|egypt|morocco|ghana|israel|saudi arabia|uae|dubai|abu dhabi|qatar|singapore|malaysia|indonesia|philippines|thailand|vietnam|japan|china|hong kong|taiwan|south korea|korea|toronto|vancouver|montreal|calgary|ottawa|edmonton|winnipeg|mississauga|brampton|surrey|quebec city|mexico city|cancun|tijuana|monterrey|guadalajara|puerto vallarta|sao paulo|rio de janeiro|buenos aires|bogota|lima|santiago|madrid|barcelona|lisbon|berlin|munich|frankfurt|amsterdam|brussels|zurich|vienna|stockholm|oslo|copenhagen|warsaw|athens|istanbul|dublin|edinburgh|glasgow|cardiff|belfast|leeds|liverpool|bristol|sheffield|birmingham uk|mumbai|delhi|new delhi|bangalore|bengaluru|chennai|hyderabad|kolkata|karachi|lahore|dhaka|manila|jakarta|bangkok|kuala lumpur|seoul|taipei|tokyo|osaka|shanghai|beijing|shenzhen|johannesburg|cape town|nairobi|lagos|cairo|tel aviv|riyadh|doha|brisbane|perth|melbourne australia|sydney australia|auckland|wellington|christchurch|nassau|kingston jamaica|montego bay|san juan)\b/i;
const OUT_OF_STATE_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|west virginia|wisconsin|wyoming|puerto rico)\b/i;

// Tokens that are geo qualifiers, not topic entities — excluded from the
// entity-ownership scan regardless of document frequency.
const STATE_NAME_SOURCE = OUT_OF_STATE_RE.source.slice(2, -2) + '|' + OUT_OF_COUNTRY_RE.source.slice(3, -3); // states + countries as "<Name>, <where>" suffixes
// "in/near <Name>" counts only at a phrase boundary — end of text, a comma,
// colon, dash, or a state suffix — so "pest control in mobile homes" and
// "pests in cocoa mulch" stay topics, while "pest control in Brandon" and
// "Ants in Cocoa: What to Do" are places.
// "in <Name> homes/neighborhoods/residents/…" is a place too — an audience
// suffix after a preposition + place name. "Mobile" is excluded from that
// branch: "pest control in mobile homes" is a housing type, not Mobile, AL.
const AUDIENCE_SUFFIX = 'homes|homeowners|households|residents|neighborhoods|neighbourhoods|communities|properties|yards|lawns|families|businesses|area';
const AUDIENCE_PLACE_NAMES = CONTEXT_PLACE_NAMES.filter((n) => n !== 'Mobile');
// "<Name> pest control" / "pest control <Name>" — the place-first and
// service-first search forms. Mobile ("mobile pest control service") and Sunrise ("sunrise mosquito
// activity") are excluded: both read as ordinary words before a service.
// (Reading too: "Reading pest control labels" is a gerund, not Reading, PA.)
const PLACE_FIRST_NAMES = CONTEXT_PLACE_NAMES.filter((n) => !['Mobile', 'Sunrise', 'Reading'].includes(n));
const CONTEXT_PLACE_RE = new RegExp(
  `\\b(?:in|near|around|serving|across)\\s+(${CONTEXT_PLACE_NAMES.map(escapeRe).join('|')})(?=\\s*(?:$|[,:;|–—-]|\\?|\\s+(?:fl|florida|${STATE_ABBR_SAFE}|${STATE_ABBR_AMBIGUOUS}|${STATE_ABBR_TRAILING}|${STATE_NAME_SOURCE})\\b))`
  + `|\\b(?:in|near|around|serving|across)\\s+(${AUDIENCE_PLACE_NAMES.map(escapeRe).join('|')})(?=\\s+(?:${AUDIENCE_SUFFIX})\\b)`
  + `|\\b(${PLACE_FIRST_NAMES.map(escapeRe).join('|')})\\s+(?:${SERVICE_INTENT})\\b`
  + `|\\b(?:${SERVICE_INTENT})\\s+(?:(?:${SERVICE_FILLER})\\s+)?(${PLACE_FIRST_NAMES.map(escapeRe).join('|')})\\b(?![a-z])`
  + `|\\b(${CONTEXT_PLACE_NAMES.map(escapeRe).join('|')}),?\\s+(?:fl|florida|${STATE_ABBR_SAFE}|${STATE_ABBR_AMBIGUOUS}|${STATE_ABBR_TRAILING}|${STATE_NAME_SOURCE})\\b(?![a-z])`,
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
    .map((n) => escapeRe(String(n).trim()).replace(/\\\./g, '\\.?').replace(/\s+/g, '\\s+')
      // Common abbreviations: "Ft Myers" / "Ft. Lauderdale" for Fort …,
      // "St Pete" for St. Petersburg (the prose guardrail aliases Fort the
      // same way).
      .replace(/^Fort\\s\+/, '(?:Fort|Ft\\.?)\\s+')
      .replace(/^St\\.\?\\s\+Petersburg$/, 'St\\.?\\s+Pete(?:rsburg)?'))
    .filter(Boolean);
  return alts.length ? new RegExp(`\\b(${alts.join('|')})\\b`, 'i') : null;
}

// Served localities that are also ordinary words: they anchor a topic only
// with geographic or service context ("in Osprey", "Osprey, FL", "Osprey pest
// control", "pest control Osprey") — "Osprey Nests and Pest Control in
// Florida" is a bird, and statewide.
const FOOTPRINT_CONTEXT_NAMES = Object.freeze(['Osprey']);
let footprintContextCache;
function footprintContextRe() {
  if (footprintContextCache !== undefined) return footprintContextCache;
  const names = FOOTPRINT_CONTEXT_NAMES.map(escapeRe).join('|');
  footprintContextCache = new RegExp(
    `\\b(?:in|near|around|serving|across)\\s+(${names})(?=\\s*(?:$|[,:;|–—-]|\\?|\\s+(?:fl|florida|and|or)\\b|\\s+(?:${AUDIENCE_SUFFIX})\\b))`
    + `|\\b(${names}),?\\s+(?:fl|florida)\\b(?![a-z])`
    + `|\\b(${names})\\s+(?:${SERVICE_INTENT})\\b`
    + `|\\b(?:${SERVICE_INTENT})\\s+(?:(?:${SERVICE_FILLER})\\s+)?(${names})\\b(?![a-z])`,
    'i'
  );
  return footprintContextCache;
}

// A SEMANTIC city value (blog_posts.city, brief.city) must BE a served
// locality or a footprint region — compared exactly after normalization
// (case, punctuation, a trailing FL / Florida), never by substring:
// "Venice Beach" and "Sarasota Springs" contain served names and are not
// served. Regex matching is for free-form targeting text only.
function normalizeCityValue(value) {
  return foldDiacritics(value)
    .toLowerCase()
    .replace(/[’'.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// The publisher owns the service-area vocabulary (frontmatter
// service_areas_tag): a semantic city is valid exactly when the publisher can
// map it to service areas (serviceAreasForCity — served localities resolve
// to their office's area, footprint regions to their areas). Fallback when
// the publisher is unavailable: the served-locality set + regions.
let servedSetCache = null;
function isServedCityValue(value) {
  const v = normalizeCityValue(value);
  if (!v) return false;
  try {
    const { serviceAreasForCity } = require('../content-astro/astro-publisher');
    if (typeof serviceAreasForCity === 'function') return serviceAreasForCity(value).length > 0;
  } catch { /* fall through */ }
  const region = REGIONAL_RE.exec(v);
  if (region && region[0] === v) return true;
  const locality = v.replace(/\s+(?:fl|florida)$/, '');
  if (!servedSetCache) servedSetCache = new Set(servedCities().map(normalizeCityValue));
  return servedSetCache.has(locality);
}

let footprintCache = null;
// Every served locality (the raw list — used to validate a semantic city
// field, where "Osprey" IS the town).
function servedCities() {
  footprintCities();
  return footprintAllCache;
}
let footprintAllCache = null;
function footprintCities() {
  if (footprintCache) return footprintCache;
  const names = new Set((CITIES || []).map((c) => String(c)));
  try {
    const { CITY_TO_LOCATION } = require('../../config/locations');
    for (const key of Object.keys(CITY_TO_LOCATION || {})) {
      names.add(key.replace(/\b\w/g, (ch) => ch.toUpperCase()));
    }
  } catch { /* scoring-config CITIES is the floor */ }
  footprintAllCache = [...names];
  const contextual = new Set(FOOTPRINT_CONTEXT_NAMES.map((n) => n.toLowerCase()));
  footprintCache = footprintAllCache.filter((n) => !contextual.has(n.toLowerCase()));
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
// Accents are folded (NFD, combining marks dropped) so "México", "São
// Paulo", "Montréal" match their matchers' ASCII spellings.
function foldDiacritics(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function classifyGeoScope(text) {
  const t = foldDiacritics(text);
  // Florida vernacular that contains a served-city name (the same scrub the
  // publisher's inferServiceAreas applies): not a footprint anchor.
  // State-named species / plants ("Texas sage", "Maine Coon"), metro-named
  // compounds ("San Jose scale", "Portland cement") and formulations are not
  // markets — scrubbed for BOTH the served-city and the out-of-area scans
  // ("Texas Mountain Laurel" is a plant, not Laurel, FL).
  const tg = t.replace(OUT_OF_STATE_EXEMPT_RE, ' ').replace(FOREIGN_EXEMPT_RE, ' ').replace(FORMULATION_EXEMPT_RE, ' ').replace(SCIENCE_EXEMPT_RE, ' ').replace(geoCompoundExemptRe(), ' ');
  const footprint = [
    ...findAll(cityRe(footprintCities()), tg.replace(FOOTPRINT_VERNACULAR_RE, ' ')),
    ...findAll(footprintContextRe(), tg),
  ];
  const out_of_area = [
    ...findAll(cityRe(outOfAreaCityList()), tg),
    ...findAll(OUT_OF_STATE_RE, tg),
    ...findAll(OUT_OF_COUNTRY_RE, tg),
    ...findAll(NATIONWIDE_RE, tg),
    ...findAll(NAME_STATE_RE, tg),
    ...findAll(CONTEXT_PLACE_RE, tg),
    ...findAll(STATE_ABBR_RE, tg).map((s) => s.toUpperCase()),
    ...(SPLIT_COUNTY_RE.test(t) && !southHillsboroughRe()?.test(t) ? ['Hillsborough County'] : []),
  ];
  const regional = findAll(REGIONAL_RE, t);
  const statewide = STATEWIDE_RE.test(t.replace(STATEWIDE_EXEMPT_RE, ' '));
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
function evaluateDraftTargeting(draft = {}, { index, category = null, service = null, city = null } = {}) {
  const framing = evaluateDraftFraming(draft);
  const fm = draft?.frontmatter || {};
  if (!framing.ok) {
    // The runner grants ONE feedback retry: report the ownership / slug
    // findings together with the framing failure so the retry can fix all
    // of it (geo findings from evaluate() would duplicate framing's — dropped).
    let extra = [];
    try {
      const own = evaluate(
        { actionType: 'new_supporting_blog', query: String(fm.primary_keyword || '').trim(), title: framing.checked.title, slug: framing.checked.slug, category: category || canonicalCategory(fm.category) || null, service, targeting: extraTargetingOf({ frontmatter: fm, body: draft?.body }) },
        { index, requireCorpus: false, ownershipOnly: true }
      );
      extra = (own.findings || []).filter((f) => f.code === CODES.CANNIBALIZES_EXISTING || f.code === CODES.SLUG_COLLIDES_LIVE);
    } catch { extra = []; }
    // Semantic-city failures too: the single retry must hear about a bad
    // brief / emitted city as well as the framing.
    const cityList = [...new Set([city, fm.city, ...(Array.isArray(fm.service_areas_tag) ? fm.service_areas_tag : [fm.service_areas_tag])].map((c) => String(c || '').trim()).filter(Boolean))];
    return { ...framing, findings: [...framing.findings, ...semanticCityFindings(cityList), ...extra], stage: 'framing' };
  }
  // The EMITTED category is authoritative (the publisher writes it); the
  // slug and the coarse service are fallbacks inside evaluate().
  const emittedCategory = category || canonicalCategory(fm.category) || null;
  const own = evaluate(
    { actionType: 'new_supporting_blog', query: String(fm.primary_keyword || '').trim(), title: framing.checked.title, slug: framing.checked.slug, category: emittedCategory, service, city: [city, fm.city, ...(Array.isArray(fm.service_areas_tag) ? fm.service_areas_tag : [fm.service_areas_tag])].filter(Boolean), targeting: extraTargetingOf({ frontmatter: fm, body: draft?.body }) },
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

// Topic-gated merges are serialized: the live-corpus ownership recheck and
// the merge itself are two operations, so two PRs claiming the same entity
// could both read the old corpus, both pass, and both merge. fn runs inside a
// transaction that holds a Postgres advisory lock for its duration (released
// with the transaction, even on throw). A busy lock throws
// TOPIC_MERGE_LOCK_BUSY — callers defer to their next tick.
const TOPIC_MERGE_LOCK_KEY = 20260827; // owner rulings date; one lock for every topic-gated merge
async function withTopicMergeLock(db, fn) {
  return db.transaction(async (trx) => {
    const res = await trx.raw('SELECT pg_try_advisory_xact_lock(?) AS locked', [TOPIC_MERGE_LOCK_KEY]);
    const locked = Array.isArray(res?.rows) ? res.rows[0]?.locked : res?.[0]?.locked;
    if (locked !== true) {
      const err = new Error('another topic-gated merge is in progress — retry next tick');
      err.code = 'TOPIC_MERGE_LOCK_BUSY';
      throw err;
    }
    return fn(trx);
  });
}

// A row already on the hub, or a legacy pre-Astro row the admin routes still
// carry as status='published' (no astro_status / astro_live_url), is an
// existing post: re-publishing it is a refresh, never a new sibling.
function isLiveRow(post = {}) {
  return post.astro_status === 'live' || post.astro_status === 'merged' || Boolean(post.astro_live_url)
    || post.status === 'published';
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
  const candidate = { actionType: 'new_supporting_blog', query: post.keyword || '', title: post.title || '', slug: slug ? `/${slug.replace(/^\/+|\/+$/g, '')}/` : '', city: post.city || '', category, targeting: extraTargetingOf({ body: post.content, meta_description: post.meta_description, secondary_keywords: post.secondary_keywords }) };
  // Two stages (the runner's pattern): geo first WITHOUT the corpus — a
  // deterministic geo block never fetches the live corpus and still returns
  // its verdict during a GitHub outage; only a geo-clean row loads it.
  if (!index) {
    const geoOnly = evaluate(candidate, { requireCorpus: false });
    if (!geoOnly.ok || geoOnly.skipped !== 'no_corpus') return geoOnly;
  }
  return evaluate(candidate, { index: index || await loadIndex(), requireCorpus: true });
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
  const out = { secondary_keywords: asStringList(data.secondary_keywords), headings: headingsOf(rest) };
  for (const key of TARGETING_SCALARS) out[key] = data[key] == null ? '' : String(data[key]).trim();
  return out;
}

// Every H2/H3 form the blog renderer accepts: ATX (## / ###), Setext (a line
// underlined with === or ---), and inline HTML/MDX (<h2>…</h2>, <h3>…</h3>).
function headingsOf(markdown) {
  const src = String(markdown || '');
  const out = [];
  const clean = (v) => String(v).replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim();
  let h;
  const atx = /^ {0,3}#{2,3}\s+(.+?)\s*#*\s*$/gm; // CommonMark allows ≤3 leading spaces
  while ((h = atx.exec(src)) !== null) out.push(clean(h[1]));
  const setext = /^(?![\s#>|-])(.+?)[ \t]*\n[ \t]*(?:=+|-{3,})[ \t]*$/gm;
  while ((h = setext.exec(src)) !== null) out.push(clean(h[1]));
  const html = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  while ((h = html.exec(src)) !== null) out.push(clean(h[2]));
  return out.filter(Boolean);
}

// The candidate-side counterpart of targetingText(): every field the corpus
// index treats as ownership evidence (meta description, secondary keywords,
// H2/H3 headings), from the frontmatter and/or a markdown body. Ownership is
// judged on these symmetrically; geo framing stays on title/slug/keyword.
function extraTargetingOf({ frontmatter = {}, body = '', meta_description = null, secondary_keywords = null } = {}) {
  const fromBody = parseTargetingFields(body);
  return [
    meta_description ?? frontmatter.meta_description ?? fromBody.meta_description,
    ...asStringList(secondary_keywords ?? frontmatter.secondary_keywords), ...fromBody.secondary_keywords,
    ...fromBody.headings,
  ].filter(Boolean).map((v) => String(v).trim()).join(' ');
}

function targetingText(fields) {
  return [
    fields.title, fields.slug.replace(/[-/]+/g, ' '), fields.primary_keyword,
    fields.meta_description, ...fields.secondary_keywords, ...fields.headings,
  ].filter(Boolean).join(' ');
}

function normalizeSlug(s) {
  // Same normalization as the publisher's slugPathFromFrontmatter: origin,
  // query and fragment dropped before the route is compared.
  const raw = String(s || '').replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].trim().toLowerCase();
  if (!raw) return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
}

function slugLeaf(url) {
  const parts = normalizeSlug(url).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
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
  // Every served locality (Osprey included — contextual matching is for the
  // geography classifier only): a town is never an owned topic entity.
  cityTokenCache = new Set(servedCities().flatMap((c) => tokenize(c)));
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
    .replace(/^ {0,3}#.*$/gm, ' ')
    // Setext (underlined) and inline HTML headings are headings too — Title
    // Case text that would otherwise count as capitalized prose.
    .replace(/^(?![\s#>|-])(.+?)[ \t]*\n[ \t]*(?:=+|-{3,})[ \t]*$/gm, ' ')
    .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, ' ')
    // List / blockquote markers are dropped so a bullet label ("- Warranty
    // details") starts its line: PROSE_WORD_RE's sentence-start alternatives
    // cannot see a marker (the word's `pre` is the space after it), so
    // repeated Title Case bullet labels would count as capitalized prose.
    .replace(/^[ \t]*(?:[-*+]|\d+[.)]|>)[ \t]+/gm, '')
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
    // Same normalization as tokenize(): possessive stripped, a hyphenated
    // brand ("Pestie-Pro") counted per part, short/stop parts dropped — so
    // the proper-noun keys are the tokens the targeting counts intersect.
    for (const part of word.split(/-+/)) {
      const tok = part.toLowerCase().replace(/[’']s$/, '').replace(/[’']/g, '');
      if (tok.length <= 2 || STOP_WORDS.has(tok)) continue;
      const s = stats.get(tok) || { cap: 0, low: 0 };
      if (/^[A-Z]/.test(part)) s.cap++; else s.low++;
      stats.set(tok, s);
    }
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

function semanticCityFindings(cities) {
  const bad = cities.filter((c) => !isServedCityValue(c));
  if (!bad.length) return [];
  return [{ severity: 'P0', code: CODES.GEO_OUT_OF_AREA, cities: bad, message: `Row city "${bad.join('", "')}" is not a served locality or Southwest Florida region. A post may not be localized to a place Waves cannot serve.` }];
}

/**
 * evaluate(candidate, { corpus | index, requireCorpus })
 *   candidate: { query, title, slug, city, category, service, targeting, actionType, pageType }
 *   `targeting` = meta description + secondary keywords + H2/H3 text (ownership only)
 * → { ok, applicable, findings, geo, entity_owners, corpus_size }
 * Throws only when a corpus is required for an applicable candidate and none
 * was supplied — the runner maps that to an engine fault, never a pass.
 */
function evaluate(candidate = {}, { corpus = null, index = null, requireCorpus = true, ownershipOnly = false } = {}) {
  const applicable = isApplicable(candidate);
  const base = { ok: true, applicable, findings: [], geo: null, entity_owners: [], corpus_size: 0 };
  if (!applicable) return { ...base, skipped: 'not_a_new_blog' };

  const query = String(candidate.query || '').trim();
  const title = String(candidate.title || '').trim();
  const slug = String(candidate.slug || '').trim();
  // A persisted row's city is handed to the writer verbatim ("City: Tampa"),
  // so it is targeting even when title/keyword/slug are generic. Every
  // populated semantic city source is validated independently (a brief city
  // must not mask a drifted emitted city).
  const cities = [...new Set((Array.isArray(candidate.city) ? candidate.city : [candidate.city]).map((c) => String(c || '').trim()).filter(Boolean))];
  const city = cities.join(' ');
  const geo = classifyGeoScope([query, title, slug.replace(/[-/]+/g, ' '), ...cities].filter(Boolean).join(' '));
  // Pre-draft, statewide is judged only on PINNED framing (an operator
  // working title or slug), each on its own. A bare query is demand — the
  // writer localizes it and evaluateDraftFraming judges the result.
  // (ownershipOnly: the caller already judged geo — evaluateDraftTargeting
  // collecting ownership findings next to a framing failure.)
  const findings = ownershipOnly ? [] : geoFindingsForParts([
    { text: query, where: 'Primary keyword', framing: false },
    { text: title, where: 'Pinned title', framing: true },
    { text: slug.replace(/[-/]+/g, ' '), where: 'Pinned slug', framing: true },
    ...cities.map((c) => ({ text: c, where: 'Row city', framing: false })),
  ]);
  // The city is a SEMANTIC field the writer is prompted with ("City:
  // Boise") — it must name a served locality or a footprint region, not
  // merely be absent from the curated out-of-area gazetteer.
  // Reported ALONGSIDE any geo finding: the runner grants one feedback
  // retry, so a recognized out-of-area city (Tampa) must not hide an
  // unrecognized one (Atlantis) until the second attempt. A city the geo
  // scan already named is not repeated.
  if (cities.length && !ownershipOnly) {
    const named = findings.flatMap((f) => f.cities || []).map((c) => String(c).toLowerCase());
    findings.push(...semanticCityFindings(cities.filter((c) => !named.some((n) => new RegExp(`(?:^|\\W)${escapeRe(n)}(?:\\W|$)`, 'i').test(c)))));
  }
  if (findings.length) return { ...base, ok: false, findings, geo };

  const idx = index || (corpus ? indexCorpus(corpus) : null);
  if (!idx) {
    if (requireCorpus) throw new Error('topic-targeting-gate: blog corpus required for entity-ownership check');
    return { ...base, geo, skipped: 'no_corpus' };
  }
  const selfUrl = normalizeSlug(slug);
  const selfLeaf = slugLeaf(selfUrl);
  // Only a LEAF-ONLY slug (no category segment) is written to the flat
  // src/content/blog/<leaf>.md and can overwrite a legacy file serving a
  // category-qualified URL; category-qualified candidates collide on the
  // exact route only (the publisher allows one leaf under many categories).
  const leafOnly = selfUrl.split('/').filter(Boolean).length === 1;
  // A NEW blog may not reuse a live post's URL — or its LEAF: the publisher
  // writes a leaf-only row slug to src/content/blog/<leaf>.md, which can
  // overwrite the legacy file serving the category-qualified URL. Either way
  // it reaches the update-in-place path without the refresh safeguards.
  // (Rows already live are exempted upstream by isLiveRow /
  // refresh_existing_page; nothing that enters evaluate() legitimately owns
  // an existing URL.)
  const collided = selfUrl ? idx.posts.find((post) => post.url === selfUrl || (leafOnly && selfLeaf && slugLeaf(post.url) === selfLeaf)) : null;
  if (collided) {
    findings.push({ severity: 'P0', code: CODES.SLUG_COLLIDES_LIVE, url: collided.url, message: `Slug ${selfUrl} collides with the LIVE post ${collided.url}${collided.url === selfUrl ? '' : ' (same leaf — the publisher writes one file per leaf)'}. A new blog may not reuse a live URL — grow the existing post as a refresh instead.` });
  }
  // Ownership is judged WITHIN a category: a chemical or species name can
  // legitimately anchor a termite post and a mosquito post. Unknown category
  // → compare against all (conservative).
  const category = String(candidate.category || categoryFromSlug(slug) || SERVICE_TO_CATEGORY[String(candidate.service || '').toLowerCase()] || '').toLowerCase() || null;
  const owners = new Map();
  // Entities come from every targeting field (keyword + title + slug): an
  // idea may carry a generic or empty keyword with the owned entity only in
  // its title ("Your New Home Came With Taexx"). Framing words in titles
  // ("actual", "explained") never trip it — an owner must be BUILT AROUND
  // the token (≥ OWNER_MIN_OCCURRENCES across its own targeting fields).
  const properNouns = idx.properNouns || new Set();
  const targeting = String(candidate.targeting || '').trim();
  const tokens = entityTokens([query, title, slug.replace(/[-/]+/g, ' '), targeting].filter(Boolean).join(' ')).filter((tok) => properNouns.has(tok));
  // Unknown candidate category (an unmapped tag): judge it against EVERY
  // category and union the owners. A global document frequency would let a
  // brand named across categories ("Advion" in termite + pest posts) exceed
  // RARE_ENTITY_DF_MAX and hide the one same-category post built around it.
  const categories = category ? [category] : [...new Set(idx.posts.map((p) => p.category).filter(Boolean))];
  if (!categories.length) categories.push(null);
  for (const cat of categories) {
    const pool = compatiblePosts(idx, cat);
    const df = dfForCategory(idx, cat);
    for (const tok of tokens) {
      const n = df.get(tok) || 0;
      if (n < 1 || n > RARE_ENTITY_DF_MAX) continue;
      for (const post of pool) {
        if ((post.counts.get(tok) || 0) < OWNER_MIN_OCCURRENCES) continue;
        const key = post.url || post.path || post.title;
        const entry = owners.get(key) || { url: post.url, title: post.title, entities: [] };
        if (!entry.entities.includes(tok)) entry.entities.push(tok);
        owners.set(key, entry);
      }
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
  withTopicMergeLock,
  TOPIC_MERGE_LOCK_KEY,
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
module.exports._internals = { CONTEXT_PLACE_NAMES, proseOf, parseTargetingFields, targetingText, headingsOf, entityTokens, dfForCategory, compatiblePosts, normalizeSlug, categoryFromSlug, footprintCities, outOfAreaCityList, SERVICE_TO_CATEGORY };
