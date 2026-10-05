/**
 * Listing suite size (address-match round 1, PR 5b; owner ruling 2026-10-02:
 * a suite size published for THIS suite prices it automatically, draft stays
 * yellow). Dark behind GATE_LOOKUP_LISTING_SIZE.
 *
 * What it reads, and how AGENTS.md's rule ("an LLM proposes intent, it never
 * reaches a price field") holds: NO model is involved anywhere in this leg.
 *   1. Google search results through DataForSEO (`serpOrganic`, a vendor
 *      already contracted for SEO): for `site:loopnet.com` and
 *      `site:crexi.com`, then an open query, the result TITLE + DESCRIPTION
 *      text is read by plain code. LoopNet and Crexi answer 403 to every
 *      server fetch (probed 2026-10-05, robots.txt included), so their
 *      snippet is the only text of theirs this code ever sees, and it is
 *      never fetched from them.
 *   2. Pages on other hosts (a broker's site, a leasing page) are fetched
 *      once each, HTML only, bounded, and their text read the same way.
 *      PDF brochures are NOT read (no PDF text parser in the dependency set).
 *
 * A size counts only when it sits next to THIS suite on that text: the typed
 * street number must be present, and when a suite/unit is known the suite
 * token must be within a few dozen characters of the figure (otherwise the
 * figure must be within reach of the street number). A range ("1,200 - 2,400
 * SF") is never a suite size. Two different sizes for the same suite are a
 * conflict: no size, the caller falls to the next rung.
 *
 * Fail-open and bounded: the gate off, no SERP vendor, a vendor error, a
 * timeout, or nothing found all return null. Logs carry counts only, never an
 * address, business name or URL.
 */

const logger = require('../logger');
const { lookupListingSizeLive } = require('../../config/feature-gates');

const SOURCE = 'listing_verified_text';

// Hosts whose pages refuse every server fetch (403, challenge page): read
// their snippet only. Anything else may be fetched once.
const SNIPPET_ONLY_HOSTS = ['loopnet.com', 'crexi.com', 'showcase.com', 'cityfeet.com', 'commercialcafe.com',
  '42floors.com', 'propertyshark.com', 'commercialsearch.com', 'catylist.com', 'ten-x.com', 'zillow.com'];
// Hosts whose pages are not listings for one suite (directories, maps,
// social) — never fetched, never read.
const IGNORED_HOSTS = ['google.com', 'facebook.com', 'yelp.com', 'instagram.com', 'linkedin.com', 'youtube.com',
  'wikipedia.org', 'mapquest.com', 'bing.com', 'yellowpages.com', 'bbb.org'];

const DEFAULT_TIMEOUT_MS = 12000;
const PAGE_FETCH_TIMEOUT_MS = 6000;
const PAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_PAGES = 3;
const MAX_RESULTS_PER_QUERY = 10;
const MIN_SUITE_SQFT = 150;
const MAX_SUITE_SQFT = 100000;
// With a suite known, the typed street number must still precede the figure
// within this many characters: the listing block for THIS property.
const ADDRESS_REACH = 400;
// Two figures within this fraction of each other are the same size.
const SAME_SIZE_TOLERANCE = 0.1;

// Group 2 is an approximation mark between the number and the unit
// ("1,350 ± SF", "1,350 +/- SF", "1,350+ SF"): matched so the figure is
// seen whole, then refused as an estimate.
const SIZE_RE = /(\d{1,3}(?:,\d{3})+|\d{3,6})(\s*(?:\+\/-|±|\+))?\s*(?:sf|sq\.?\s*ft\.?|square\s+feet|sqft)\b/gi;
// "up to 2,400 SF", "from 1,350 SF", "approx. 1,400 SF": a bound or an
// estimate, not the suite's area.
// The same qualifiers right after the figure: "1,350 SF (approx.)",
// "1,350 SF +/-", "1,350 SF minimum", "1,350 SF or more".
// "between 1,200 and 2,400 SF", "between 1,200 SF and 2,400 SF": both
// endpoints are a range.
const BETWEEN_BEFORE_RE = /\bbetween\b[^.;|]{0,40}$/i;
const SPLIT_GROUP_BEFORE_RE = /(?<!(?:suites?|ste\.?|units?|bays?|spaces?|#)\s*#?\s*)\b\d{1,3}\s$/i;
const BOUND_AFTER_RE = /^\s*[(\[]?\s*(?:\+\/-|±|~|approx\.?|approximately|approximate|est\.?|estimated|minimum|maximum|min\b|max\b|or\s+(?:more|less)|and\s+up|more\s+or\s+less)/i;
const BOUND_BEFORE_RE = /\b(?:up\s+to|from|starting\s+at|as\s+low\s+as|as\s+much\s+as|minimum|maximum|min|max|approximately|approx\.?|estimated|est\.?|about|around|roughly|nearly|over|under|less\s+than|more\s+than)\s*$|[~±]\s*$/i;
// "1,200 - 2,400 SF", "1,200–2,400 SF", "1,200 to 2,400 sq ft": a range.
// "Suite 103 — 1,350 SF" is not: the figure before the dash is the suite.
const RANGE_BEFORE_RE = /(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:-|–|—|to)\s*$/i;
// "1,200 SF - 2,400 SF": the upper endpoint, with a unit on both ends.
const RANGE_UNIT_BEFORE_RE = /(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:sf|sq\.?\s*ft\.?|square\s+feet|sqft)\s*(?:-|–|—|to)\s*$/i;
const UNIT_BEFORE_DASH_RE = /(?:suite|ste\.?|unit|bay|space|#)\s*#?\s*[A-Za-z]?\d{1,5}[A-Za-z]?\s*(?:-|–|—|to)\s*$/i;
// Another street address ("9900 Other St") between the typed address and the
// figure: the figure belongs to that other property, not this one. A size
// ("1,350 sf"), a suite ("suite 103") or a range word is not an address.
// A street is a word ("Other St") or an ordinal ("51st St", "9th Ave").
const OTHER_ADDRESS_RE = /(^|[^0-9a-z,.])(\d{2,6})\s+(?:(?:n|s|e|w|ne|nw|se|sw)\s+)?(?!(?:sf|sq|sqft|square|suite|ste|unit|bay|space|to|and|or)\b)(?:[a-z]{2,}|\d{1,3}(?:st|nd|rd|th)\b)/gi;
// A one-digit house number ("1 Main Street") is an address only with a
// street-type word close behind it; "2 story", "3 units" are not.
const SHORT_ADDRESS_RE = /(^|[^0-9a-z,.#])(\d)\s+(?:(?:n|s|e|w|ne|nw|se|sw)\s+)?(?:[a-z0-9]+\s+){1,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|trl|trail|cir|circle|pl|place|ter|terrace|loop)\b/gi;
// The street's own word must follow the street number this closely for the
// pair to be THIS address ("4400 Test Commons Pkwy"), never the same number
// on another street ("4400 Other Street … Test Commons Pkwy" elsewhere).
const STREET_WORD_REACH = 28;
// How much text after the street number is read as the listing's street
// line for the full-street check (number + every street word, suffix
// canonicalized by the county normalizer).
const STREET_LINE_REACH = 48;
const DIRECTION_RE = /^(?:N|S|E|W|NE|NW|SE|SW)$/;
// A figure introduced as the building's, lot's or site's total is never a
// suite's size.
// Only explicit total words, close to the figure: "Oak Plaza Suite 103 —
// 1,350 SF" names a plaza without being its total.
const TOTAL_WORDS = '(?:building|bldg|total|gross|lot|land|site|parcel|gla|rba|rentable|acres?)';
const TOTAL_BEFORE_RE = new RegExp(`\\b${TOTAL_WORDS}\\b[^.;|]{0,24}$`, 'i');
// "25,000 SF total building area": the same words right after the figure.
// After the figure, the NOUN PHRASE it modifies (everything up to the first
// preposition or punctuation, however many modifiers: "25,000 SF grocery
// anchored neighborhood shopping center") names a total when it holds a
// total word or a center / plaza / complex noun. "1,350 SF retail space in a
// plaza" keeps its figure: its phrase is "retail space".
const TOTAL_AFTER_WORDS_RE = new RegExp(`\\b(?:${TOTAL_WORDS.slice(3, -1)}|shopping|center|centre|plaza|complex|development|campus|mall|strip|park|property|anchored)\\b`, 'i');
// A hyphen inside a word ("multi-tenant", "grocery-anchored") is part of the
// phrase; only a spaced hyphen or a dash ends it.
const SPACE_WORDS = new Set(['retail', 'office', 'restaurant', 'medical', 'dental', 'commercial', 'industrial', 'flex', 'warehouse',
  'showroom', 'salon', 'storefront', 'inline', 'in-line', 'endcap', 'end-cap', 'end', 'cap', 'corner', 'ground-floor', 'first-floor',
  'second-floor', 'street-level', 'space', 'suite', 'unit', 'bay', 'vacant', 'leasable', 'usable', 'rentable', 'net', 'now']);
const NOUN_PHRASE_END_RE = /[.,;:|()—–]|\s-\s|\b(?:in|at|of|on|with|for|near|by|to|from|and|is|are|was|available|located|within)\b/i;
function nounPhraseAfter(text) {
  const head = String(text || '').replace(/^\s*(?:of\s+)?/i, '');
  const end = head.search(NOUN_PHRASE_END_RE);
  return (end >= 0 ? head.slice(0, end) : head).split(/\s+/).slice(0, 10).join(' ');
}
// "located in a 25,000 SF …", "part of a …", "within a …": the figure that
// follows describes the surroundings, not the suite.
const CONTEXT_BEFORE_RE = /\b(?:located\s+in|situated\s+in|part\s+of|within|inside|anchored\s+by|in)\s+(?:a|an|the)\s*$/i;

function normalizeText(s) {
  return String(s || '')
    // Non-rendered element BODIES (scripts, styles, templates, serialized
    // app state, comments) are not listing text: removed whole, never read.
    .replace(/<(script|style|template|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' | ')
    .replace(/<(?:script|style|template|noscript)\b[^>]*>[\s\S]*$/gi, ' | ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:li|p|div|tr|td|th|h[1-6]|dd|dt|section|article)\s*>|<br\s*\/?>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    // A thousands group split by a non-breaking space ("1&nbsp;350") is one
    // figure, never its trailing digits.
    .replace(/(\d)(?:&nbsp;|&#160;|\u00a0)(\d{3})\b/g, '$1,$2')
    .replace(/&nbsp;|&#160;|\u00a0/g, ' ').replace(/&amp;/g, '&')
    // An abbreviation's period is not a sentence boundary ("Ste. 103", "sq. ft.").
    .replace(/\b(ste|st|ave|blvd|rd|dr|pkwy|hwy|ln|ct|cir|trl|no|fl|n|s|e|w|ne|nw|se|sw|sq|ft)\.(?=\s|$)/gi, '$1')
    .replace(/&mdash;|&#8212;/g, '—').replace(/&ndash;|&#8211;/g, '–')
    .replace(/\s+/g, ' ').trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function hostMatches(host, list) {
  return Boolean(host) && list.some((h) => host === h || host.endsWith(`.${h}`));
}

function normalizeUnitValue(raw) {
  const value = String(raw || '').trim()
    .replace(/^(?:suites?|ste\.?|units?|apt\.?|apartment|bays?|spaces?|spc\.?|rm\.?|room)\b\.?\s*/i, '')
    .replace(/^#\s*/, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  return /^[A-Z0-9][A-Z0-9/&+–—-]*$/.test(value) ? value : null;
}

function unitDesignatorWord(raw) {
  const m = String(raw || '').trim().match(/^(units?|bays?|spaces?|spc\.?|apt\.?|apartment)\b/i);
  if (!m) return 'suite';
  const w = m[1].toLowerCase().replace(/\.$/, '');
  if (w.startsWith('unit')) return 'unit';
  if (w.startsWith('bay')) return 'bay';
  if (w.startsWith('sp')) return 'space';
  return 'apt';
}

// Street number + first street word off the suite address parts.
function addressAnchors(address = {}) {
  const street = String(address.street || '').trim();
  const m = street.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  if (!m) return null;
  const number = m[1];
  const streetLine = m[2].replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = streetLine.split(' ').filter(Boolean);
  if (!words.length) return null;
  // A numbered route ("SR 70 E", "State Road 70", "FL-70", "US 41", "CR 675")
  // is known by its number: the roll, Google and a listing each spell the
  // prefix differently. An ordinary street is known by its first word that
  // is not a direction.
  const route = streetLine.match(/^(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?(?:SR|US|CR|FL|FL-|STATE\s+ROAD|STATE\s+RD|HIGHWAY|HWY|US\s+HWY|COUNTY\s+ROAD)\s*-?\s*(\d{1,4}[A-Za-z]?)\b/i);
  const streetWord = route ? route[1]
    : (words.find((w) => !/^(n|s|e|w|ne|nw|se|sw|north|south|east|west)$/i.test(w)) || words[0]);
  // The production parser (suiteAddressParts) returns the unit WITH its
  // designator ("Suite 103", "#12b", "Unit B", "Ste 103-104"): compare on
  // the value alone, in the same form unitMentions yields (a combined typed
  // unit keeps its separators, so it only ever matches the same combination).
  const unit = normalizeUnitValue(address.unit);
  const unitWord = unitDesignatorWord(address.unit);
  // The typed street as the county roll spells it ("SR 70 E", "TEST
  // COMMONS PKWY"), leading/trailing directions dropped: every remaining
  // word must follow the number on the text, in order.
  let streetWords = [];
  try {
    const { normalizeCountyStreetLine } = require('../property-lookup/ai-property-lookup');
    streetWords = normalizeCountyStreetLine(`${number} ${streetLine}`).split(' ').slice(1);
  } catch { streetWords = streetLine.toUpperCase().split(' '); }
  // Directions are compared separately: a listing may omit them, but one
  // that states a DIFFERENT direction is another property ("Test St W" is
  // not "Test St E").
  const streetDirections = new Set(streetWords.filter((w) => DIRECTION_RE.test(w)));
  streetWords = streetWords.filter((w) => !DIRECTION_RE.test(w));
  const zip = (String(address.zip || '').match(/\d{5}/) || [null])[0];
  return { number, streetLine, streetWord, streetWords, streetDirections, unit, unitWord, city: String(address.city || '').trim() || null, zip };
}

// Every suite/unit mention on the text: "Suite 103", "Ste. 103", "Unit B",
// "#103", "Bay 4". The figure's NEAREST mention must be THIS suite, so a
// neighbor's size listed on the same page ("Suite 105 2,000 SF") never counts.
// A combined designation ("Suite 103/104", "Suites 103 & 104", "Suite
// 103-104", "Suite 103 and 104") is its own unit, never suite 103 alone: its
// figure is the combined area.
// Separators: "/", "&", "-", "+", "and" always; "," only when the next
// number is not followed by a street word ("Suites 103, 104: 3,000 SF" is
// combined; "Ste 103, 14617 FL-70 E" is a suite then a house number).
// A continuation is never a size figure: "Suite 103 - 1,350 SF" is suite
// 103 and its size, "Suite 103-104" a combined suite.
const UNIT_MENTION_RE = /(?:\b(?:suites?|ste\.?|units?|bays?|spaces?)\s*#?\s*|#\s*)([A-Za-z]?\d{1,5}[A-Za-z]?|[A-Za-z])\b((?:\s*(?:\/|&|-|–|—|\+|and|to|,(?=\s*#?\s*(?:[A-Za-z]?\d{1,5}[A-Za-z]?|[A-Za-z])\b(?!\s+[a-z]{2,})))\s*#?\s*(?:[A-Za-z]?\d{1,5}[A-Za-z]?|[A-Za-z])\b(?!,\d)(?!\s*(?:sf|sq|square|sqft)\b))*)/gi;
function unitMentions(text) {
  const out = [];
  let m;
  UNIT_MENTION_RE.lastIndex = 0;
  while ((m = UNIT_MENTION_RE.exec(text))) {
    const extra = String(m[2] || '').replace(/\s+/g, '');
    out.push({ index: m.index, end: m.index + m[0].length, unit: (m[1] + extra).toUpperCase() });
  }
  return out;
}

function wholeWordIndex(text, token) {
  const re = new RegExp(`(^|[^0-9A-Za-z])${token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![0-9A-Za-z])`, 'i');
  const m = re.exec(text);
  return m ? m.index + m[1].length : -1;
}

/**
 * Every size figure in `text` that belongs to THIS suite. Pure.
 *
 * The text is read in BLOCKS (a sentence, a list item, a table cell: split on
 * periods, semicolons, pipes and block-level tags). A figure counts when:
 *   - the typed street number + full street (county spelling, directions
 *     agreeing) precedes it within reach with no other address in between
 *     (addressAnchorPositions, nearestAnchor);
 *   - it is a plain figure (150–100,000 sq ft; not a range endpoint or a
 *     bound; not a building / lot / center total) (figureIsPlain);
 *   - the postal ZIP, if any, from the anchor through the figure's block is
 *     the typed one (zipAgrees);
 *   - a suite is typed, the figure's block names exactly one suite and it is
 *     this one (blockOwnsFigure). With no suite typed there is no listing size.
 * @returns {number[]} square-foot values, in text order
 */
function extractSuiteSizes(text, anchors) {
  const t = normalizeText(text);
  if (!t || !anchors) return [];
  // A listing size needs a typed suite: with none, a figure on a page may be
  // any tenant's, and a business-name match is not strong enough to price on.
  const wanted = anchors.unit ? anchors.unit.toUpperCase() : null;
  if (!wanted) return [];
  const numberPositions = addressAnchorPositions(t, anchors);
  if (!numberPositions.length) return [];
  const out = [];
  let m;
  SIZE_RE.lastIndex = 0;
  while ((m = SIZE_RE.exec(t))) {
    const value = Number(m[1].replace(/,/g, ''));
    if (!(value >= MIN_SUITE_SQFT && value <= MAX_SUITE_SQFT)) continue;
    if (m[2]) continue; // "1,350 ± SF": an estimate
    // "1 350 SF": a thousands group split by a plain or thin space would
    // read as 350. A bare three-digit figure right after another short
    // number is refused, unless that number is the suite ("Suite 103 350 SF").
    if (/^\d{3}$/.test(m[1]) && SPLIT_GROUP_BEFORE_RE.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (!figureIsPlain(t, m.index, m[0].length)) continue;
    const addressAt = nearestAnchor(t, numberPositions, m.index, anchors, ADDRESS_REACH);
    if (addressAt < 0) continue;
    const block = figureBlock(t, m.index);
    if (!zipAgrees(t, addressAt, m.index, block.end, anchors)) continue;
    if (!blockOwnsFigure(block, m.index, wanted, anchors)) continue;
    out.push(value);
  }
  return out;
}

// Every mention of the street number that the street's own words follow
// (number + name, suffix canonicalized, direction agreeing).
function addressAnchorPositions(t, anchors) {
  if (wholeWordIndex(t, anchors.number) < 0) return [];
  const positions = [];
  const re = new RegExp(`(^|[^0-9A-Za-z])${anchors.number}(?![0-9A-Za-z])`, 'gi');
  const streetRe = new RegExp(`\\b${anchors.streetWord.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
  let m;
  while ((m = re.exec(t))) {
    const at = m.index + m[1].length;
    const tail = t.slice(at + anchors.number.length, at + anchors.number.length + STREET_WORD_REACH).split(/[.;|]/)[0];
    if (!streetRe.test(tail)) continue;
    const line = t.slice(at, at + anchors.number.length + STREET_LINE_REACH).split(/[.;|]/)[0];
    if (streetLineMatches(line, anchors)) positions.push(at);
  }
  return positions;
}

// A plain figure: not a range endpoint, not a bound ("up to"), not a
// building / lot / center total before or after it.
function figureIsPlain(t, idx, len) {
  const before = t.slice(Math.max(0, idx - 24), idx);
  const after = t.slice(idx + len, idx + len + 24);
  if (RANGE_UNIT_BEFORE_RE.test(before) || (RANGE_BEFORE_RE.test(before) && !UNIT_BEFORE_DASH_RE.test(before))
    || /^\s*(?:-|–|—|to)\s*\d/i.test(after)) return false;
  if (TOTAL_BEFORE_RE.test(t.slice(Math.max(0, idx - 48), idx))) return false;
  if (BOUND_BEFORE_RE.test(t.slice(Math.max(0, idx - 20), idx))) return false;
  if (BETWEEN_BEFORE_RE.test(t.slice(Math.max(0, idx - 44), idx))) return false;
  if (CONTEXT_BEFORE_RE.test(t.slice(Math.max(0, idx - 20), idx))) return false;
  if (BOUND_AFTER_RE.test(t.slice(idx + len, idx + len + 24))) return false;
  const phrase = nounPhraseAfter(t.slice(idx + len, idx + len + 120));
  if (TOTAL_AFTER_WORDS_RE.test(phrase)) return false;
  // What follows the figure must be nothing, or words that describe a space
  // ("retail space", "warehouse suite", "in-line retail space"). Anything
  // else ("per floor", "each", "floor plate", "of land") qualifies the
  // figure in a way this code does not understand: refused.
  if (!phrase.split(/\s+/).filter(Boolean).every((w) => SPACE_WORDS.has(w.toLowerCase()))) return false;
  return true;
}

// The nearest preceding anchor within reach, with no other street address
// between it and the figure; -1 when there is none.
function nearestAnchor(t, numberPositions, idx, anchors, reach) {
  let addressAt = -1;
  for (const p of numberPositions) if (p <= idx && p > addressAt) addressAt = p;
  if (addressAt < 0 || idx - addressAt > reach) return -1;
  if (otherAddressBetween(t, addressAt + anchors.number.length, idx, anchors)) return -1;
  return addressAt;
}

// The figure's own block: a sentence, a list item or a table cell.
function figureBlock(t, idx) {
  const start = Math.max(t.lastIndexOf('.', idx), t.lastIndexOf(';', idx), t.lastIndexOf('|', idx)) + 1;
  const nextEnds = [t.indexOf('. ', idx), t.indexOf(';', idx), t.indexOf('|', idx)].filter((i) => i >= 0);
  const end = nextEnds.length ? Math.min(...nextEnds) : t.length;
  return { start, end, text: t.slice(start, end) };
}

// Postal information anywhere from the anchoring address through the end
// of the figure's block ("… 2,000 SF, Tampa FL 33602") must be the typed
// ZIP (ZIP+4 on its first five digits); a span with no ZIP is not held to
// it. Judged per figure: another block naming the typed ZIP vouches for
// nothing here.
// The city too: a span that names a city before "FL" ("…, Sarasota FL") and
// it is not the typed one is another locality's listing, unless the span's
// ZIP is the typed ZIP (the ZIP is the stronger identity; Lakewood Ranch and
// Bradenton share ZIPs). A span naming no city is not held to it.
function zipAgrees(t, addressAt, idx, blockEnd, anchors) {
  const span = t.slice(addressAt, Math.max(idx, blockEnd));
  const zips = zipsIn(span, anchors.number);
  if (anchors.zip && zips.some((z) => z !== anchors.zip)) return false;
  if (anchors.zip && zips.includes(anchors.zip)) return true;
  return cityAgrees(span, anchors.city);
}

const CITY_BEFORE_STATE_RE = /\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2})\s*,?\s+(?:FL|Florida)\b/g;
// A span that names another US state after a place name ("Atlanta GA",
// "Mobile, AL") is not this address, typed city or not. Upper-case
// abbreviations only, so "in", "or", "me" in prose never read as states.
const OTHER_STATE_RE = /\b[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?\s*,?\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b(?=\s*(?:\d{5}|[,.;|)]|$|\s+(?:Suite|Ste|Unit|Bay|Space|#)))/;
const OTHER_STATE_NAME_RE = /\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West\s+Virginia|Wisconsin|Wyoming)\b(?=\s*(?:\d{5}|[,.;|)]|$|\s+(?:Suite|Ste|Unit|Bay|Space|#)))/;
function cityAgrees(span, city) {
  if (OTHER_STATE_RE.test(span) || OTHER_STATE_NAME_RE.test(span)) return false;
  const typed = String(city || '').trim().toLowerCase();
  if (!typed) return true;
  CITY_BEFORE_STATE_RE.lastIndex = 0;
  let m;
  let named = false;
  while ((m = CITY_BEFORE_STATE_RE.exec(span))) {
    named = true;
    if (m[1].toLowerCase().replace(/\s+/g, ' ').endsWith(typed)) return true;
  }
  return !named;
}

// The block names exactly one suite, this one, and the figure DIRECTLY
// follows a mention of it: only punctuation or spaces between them ("Suite
// 103 — 1,350 SF", "Suite 103: 1,350 SF", "Suite 103 1,350 SF"). Any word in
// between ("Suite 103 is housed inside this modern 25,000 SF warehouse",
// "Suite 103 — parking 4/1,000 SF") means the figure describes something
// else. This one positional rule replaces guessing at every phrasing.
const SEPARATORS_ONLY_RE = /^[\s:;,—–\-()…·•]*$/;
// The rest of THIS address may sit between them ("Suite 103, Bradenton, FL
// 34202 — 1,350 SF"): the typed city, the state and the typed ZIP are
// removed from the gap before it is judged.
function gapIsSeparatorsOnly(gap, anchors) {
  let rest = gap;
  if (anchors.city) rest = rest.replace(new RegExp(`\\b${anchors.city.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i'), ' ');
  rest = rest.replace(/\b(?:FL|Florida)\b/i, ' ');
  if (anchors.zip) rest = rest.replace(new RegExp(`\\b${anchors.zip}(?:-\\d{4})?\\b`), ' ');
  return SEPARATORS_ONLY_RE.test(rest);
}

function blockOwnsFigure(block, idx, wanted, anchors) {
  const mentions = unitMentions(block.text);
  const units = [...new Set(mentions.map((u) => u.unit))];
  if (units.length !== 1 || units[0] !== wanted) return false;
  return mentions.some((u) => {
    const end = block.start + u.end;
    return u.unit === wanted && end <= idx && idx - end <= 60 && gapIsSeparatorsOnly(block.text.slice(u.end, idx - block.start), anchors);
  });
}

function sameSize(a, b) {
  return Math.abs(a - b) <= SAME_SIZE_TOLERANCE * Math.max(a, b);
}

/**
 * One size out of every accepted figure, or null on a conflict.
 * @param {{value:number,url:string}[]} hits
 */
function settleSizes(hits) {
  if (!hits.length) return null;
  const groups = [];
  // A figure joins a group only when it agrees with EVERY member (min and
  // max), so three listings at 1,000 / 1,100 / 1,210 are a conflict whatever
  // order they arrive in.
  for (const hit of hits) {
    const g = groups.find((grp) => sameSize(grp.min, hit.value) && sameSize(grp.max, hit.value));
    if (g) { g.hits.push(hit); g.min = Math.min(g.min, hit.value); g.max = Math.max(g.max, hit.value); } else groups.push({ value: hit.value, min: hit.value, max: hit.value, hits: [hit] });
  }
  if (groups.length !== 1) return { conflict: groups.length };
  return { value: groups[0].value, url: groups[0].hits[0].url, count: groups[0].hits.length };
}

function buildQueries(anchors) {
  // The number is exact; the street is left unquoted so Google matches the
  // spelling a listing used ("SR 70", "State Road 70", "FL-70").
  const addr = `"${anchors.number}" ${anchors.streetLine}`;
  // The designator the operator typed ("Unit B", "Bay 4"; "#12" and "Ste"
  // read as "suite"), so Google returns listings indexed under it.
  const unit = anchors.unit ? ` "${anchors.unitWord || 'suite'} ${anchors.unit}"` : '';
  const city = anchors.city ? ` ${anchors.city}` : '';
  return [
    `${addr}${unit}${city} FL site:loopnet.com`,
    `${addr}${unit}${city} FL site:crexi.com`,
    `${addr}${unit}${city} FL lease "sq ft"`,
  ];
}

function streetLineMatches(line, anchors) {
  if (!anchors.streetWords || !anchors.streetWords.length) return true;
  let words;
  try {
    const { normalizeCountyStreetLine } = require('../property-lookup/ai-property-lookup');
    words = normalizeCountyStreetLine(line).split(' ').slice(1);
  } catch { words = line.toUpperCase().split(' ').slice(1); }
  const stop = words.findIndex((w) => /^(?:SUITE|STE|UNIT|BAY|SPACE|#)$/.test(w) || /^#/.test(w));
  const scope = stop >= 0 ? words.slice(0, stop) : words;
  // The street words must follow the number CONTIGUOUSLY (directions aside):
  // "4400 Test Other St" is not "4400 Test St".
  const core = scope.filter((w) => !DIRECTION_RE.test(w));
  if (core.length < anchors.streetWords.length) return false;
  for (let i = 0; i < anchors.streetWords.length; i += 1) {
    if (core[i] !== anchors.streetWords[i]) return false;
  }
  // A stated direction that is not the typed one: another property. The
  // text's direction tokens are read only through the last street word.
  let seen = 0;
  let at = 0;
  for (; at < scope.length && seen < anchors.streetWords.length; at += 1) if (!DIRECTION_RE.test(scope[at])) seen += 1;
  const stated = scope.slice(0, at + 1).filter((w) => DIRECTION_RE.test(w));
  if (stated.length && anchors.streetDirections && anchors.streetDirections.size
    && !stated.every((d) => anchors.streetDirections.has(d))) return false;
  if (stated.length && anchors.streetDirections && !anchors.streetDirections.size) return false;
  return true;
}

const SUITE_WORD_BEFORE_RE = /(?:suite|ste\.?|unit|bay|space|#)\s*#?\s*$/i;
// Five-digit groups in postal position: after "FL" always; after a bare
// comma only when no street word follows (", 14617 FL-70 E" is a house
// number). Never the typed house number itself, never a figure ("12000 SF").
function zipsIn(text, ownNumber) {
  const zips = [];
  for (const re of [/\bFL\s*,?\s*(\d{5})(?:-\d{4})?\b(?!\s*(?:sf|sq|square)\b)/gi, /,\s*(\d{5})(?:-\d{4})?\b(?!\s*(?:sf|sq|square)\b)(?!\s+(?!usa\b)[a-z])/gi]) {
    let z;
    while ((z = re.exec(text))) if (z[1] !== ownNumber) zips.push(z[1]);
  }
  return zips;
}

function otherAddressBetween(text, from, to, anchors) {
  const segment = text.slice(from, to);
  SHORT_ADDRESS_RE.lastIndex = 0;
  if (SHORT_ADDRESS_RE.test(segment)) return true;
  OTHER_ADDRESS_RE.lastIndex = 0;
  let m;
  while ((m = OTHER_ADDRESS_RE.exec(segment))) {
    // This address repeated is not another one; the same number on another
    // street is ("4400 Test Commons Pkwy. 4400 Other Street Suite 103 …").
    if (m[2] === anchors.number) {
      const at = m.index + m[1].length;
      if (streetLineMatches(segment.slice(at, at + anchors.number.length + STREET_LINE_REACH).split(/[.;]/)[0], anchors)) continue;
      return true;
    }
    // "Suite 103 Bradenton": a suite number before the city is not an address.
    const lead = segment.slice(Math.max(0, m.index + m[1].length - 12), m.index + m[1].length);
    if (SUITE_WORD_BEFORE_RE.test(lead)) continue;
    return true;
  }
  return false;
}

/**
 * One size out of every accepted figure, or null on a conflict.
 * @param {{value:number,url:string}[]} hits
 */
function organicItems(serpResponse) {
  const items = serpResponse?.tasks?.[0]?.result?.[0]?.items || serpResponse?.items || [];
  return items.filter((i) => i && i.type === 'organic' && i.url).slice(0, MAX_RESULTS_PER_QUERY)
    .map((i) => ({ url: i.url, host: hostOf(i.url), text: `${i.title || ''} ${i.description || ''}` }));
}

// Search-result URLs are untrusted: the page is read through the repo's
// SSRF-hardened fetcher (content-registry-live-status.js safeFetchImpl: DNS
// answers must be public, private literals refused, response size capped,
// redirects NOT followed), one redirect hop re-validated the same way, http(s)
// only, HTML only.
const PAGE_FETCH_HEADERS = { 'user-agent': 'WavesPropertyLookup/1.0 (+https://wavespestcontrol.com)', accept: 'text/html' };
// http(s) only, no credentials, and — since Node skips DNS (and the pinned
// fetcher's rejecting lookup) for an IP literal — no private literal,
// localhost or intranet name, judged BEFORE any request on every hop (a
// redirect is the classic way in).
function hopIsSafe(url, ssrf) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  return !ssrf.isBlockedHostname(parsed.hostname);
}

async function defaultFetchText(url, timeoutMs, { fetchImpl = null, maxHops = 1 } = {}) {
  const { safeFetchImpl } = require('../content/content-registry-live-status');
  const { _internals: ssrf } = require('../seo/contact-finder'); // isBlockedHostname: private IP literals, localhost, intranet names
  const impl = fetchImpl || safeFetchImpl;
  // One budget for every hop: a slow redirect and a slow page share it.
  const deadline = Date.now() + timeoutMs;
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    if (!hopIsSafe(current, ssrf)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    let res;
    try {
      res = await impl(current, { signal: controller.signal, headers: PAGE_FETCH_HEADERS, maxBytes: PAGE_MAX_BYTES });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location || hop === maxHops) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) return null;
    if (!/text\/html/i.test(String(res.headers.get('content-type') || ''))) return null;
    if (res.truncated) return null;
    return res.text();
  }
  return null;
}

function remaining(deadlineAt) {
  return Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : Infinity;
}

/**
 * @param {{address:{street,unit,city,zip}, businessNameHint?:string}} input
 * @param {{deadlineAt?:number, timeoutMs?:number, serp?:Function, fetchText?:Function, now?:Function}} opts
 * @returns {Promise<{value:number, source:string, confidence:string, url:string, evidence:object[]}|null>}
 */
async function resolveViaListing(input = {}, opts = {}) {
  if (!lookupListingSizeLive()) return null;
  const anchors = addressAnchors(input.address);
  if (!anchors) return null;
  // No suite typed: no listing size (see extractSuiteSizes), and no search.
  if (!anchors.unit) return null;
  const serp = opts.serp || ((keyword, { signal } = {}) => require('../seo/dataforseo').serpOrganic(keyword, 'Bradenton,Florida,United States', 'desktop', { signal }));
  const fetchText = opts.fetchText || defaultFetchText;
  const budgetMs = Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, remaining(opts.deadlineAt));
  if (budgetMs < 1500) return null;
  const stopAt = Date.now() + budgetMs;

  const search = await searchListings(anchors, serp, stopAt);
  const pages = await readPages(search.pageCandidates, anchors, fetchText, stopAt);
  const hits = [...search.hits, ...pages.hits];
  const settled = settleSizes(hits);
  if (!settled || settled.conflict) {
    logger.info(`[listing-size] no size: queries=${search.queriesRun} pages=${pages.pagesRead} figures=${hits.length}${settled?.conflict ? ` conflict=${settled.conflict}` : ''}`);
    return null;
  }
  const host = hostOf(settled.url);
  logger.info(`[listing-size] size found: queries=${search.queriesRun} pages=${pages.pagesRead} figures=${hits.length}`);
  return {
    value: settled.value,
    source: SOURCE,
    confidence: 'medium',
    url: settled.url,
    fetchedAt: new Date((opts.now || Date.now)()).toISOString(),
    evidence: [{
      source: SOURCE,
      detail: `public listing on ${host} names ${anchors.unit ? `suite ${anchors.unit}` : 'this address'} at ${settled.value.toLocaleString('en-US')} sq ft — confirm on site`,
      url: settled.url,
    }],
  };
}

// The search leg: up to three queries, each vendor call aborted at the
// deadline (never left running past the lookup) and its deadline timer
// cleared when the call wins. Snippets are read here; fetchable hosts are
// collected for readPages.
async function searchListings(anchors, serp, stopAt) {
  const hits = [];
  const pageCandidates = [];
  const seenUrls = new Set();
  const queries = buildQueries(anchors);
  let queriesRun = 0;
  for (let q = 0; q < queries.length; q += 1) {
    // The open query runs only when the listing sites gave nothing.
    if (q === 2 && (hits.length || pageCandidates.length)) break;
    if (Date.now() + 1500 > stopAt) break;
    const response = await serpWithDeadline(serp, queries[q], stopAt);
    queriesRun += 1;
    for (const item of organicItems(response)) {
      if (!item.host || hostMatches(item.host, IGNORED_HOSTS) || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      for (const value of extractSuiteSizes(item.text, anchors)) hits.push({ value, url: item.url });
      if (!hostMatches(item.host, SNIPPET_ONLY_HOSTS) && pageCandidates.length < MAX_PAGES) pageCandidates.push(item);
    }
  }
  return { hits, pageCandidates, queriesRun };
}

async function serpWithDeadline(serp, keyword, stopAt) {
  const controller = new AbortController();
  let timer = null;
  try {
    return await Promise.race([
      serp(keyword, { signal: controller.signal }),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.max(0, stopAt - Date.now())); }),
    ]);
  } catch (err) {
    logger.warn(`[listing-size] search failed: ${err.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The page leg: each fetchable candidate once, within what is left of the
// budget; an unreadable page is no evidence.
async function readPages(pageCandidates, anchors, fetchText, stopAt) {
  const hits = [];
  let pagesRead = 0;
  for (const item of pageCandidates) {
    const left = stopAt - Date.now();
    if (left < 1000) break;
    try {
      const html = await fetchText(item.url, Math.min(PAGE_FETCH_TIMEOUT_MS, left));
      pagesRead += 1;
      if (!html) continue;
      for (const value of extractSuiteSizes(html, anchors)) hits.push({ value, url: item.url });
    } catch { /* fail-open */ }
  }
  return { hits, pagesRead };
}

module.exports = {
  SOURCE,
  resolveViaListing,
  _private: { extractSuiteSizes, settleSizes, buildQueries, addressAnchors, organicItems, defaultFetchText, SNIPPET_ONLY_HOSTS, IGNORED_HOSTS, DEFAULT_TIMEOUT_MS },
};
