/**
 * Estimator Engine — scope guards (GATE_ESTIMATOR_SCOPE_GUARDS, default
 * OFF; engine-family env-gate pattern, same value semantics as
 * GATE_ESTIMATOR_SMS_DRAFTS).
 *
 * Two production incidents motivated this module (2026-07-30):
 *  - A third-party coordinator texted logistics for an existing quarterly
 *    customer's already-booked visit ("this is <coordinator> with
 *    <customer> at <street address>, can you spray before Saturday") from
 *    a phone not on file. Every identity check in the SMS quote lane is
 *    sender-phone keyed, so the thread read as a new prospect and the
 *    engine drafted a one-time treatment for a property whose recurring
 *    plan already covers the pest — with no customer linked.
 *  - "are you available for power washing service" rang the owed-quote
 *    bell: the classifier is never told what Waves actually offers, and
 *    the prefilter matches the bare token "service".
 *
 * The fix is grounding, not more regex: give the pre-bell triage step the
 * Waves context it was missing — sender→customer match, message-address→
 * customer match (primary and secondary properties, confirmed against the
 * full normalized street), booked visits, the recent inbound thread, and
 * the offered-service list — plus a deterministic out-of-scope backstop
 * that runs before any model call. Everything here is fail-open AND
 * time-bounded: a guard failure or a slow database must degrade to
 * today's behavior (an extra bell), never block a real quote and never
 * hold the Twilio webhook.
 */

const logger = require('../logger');
const { last10 } = require('../external-phone');
const { sameStreetAddress, STREET_TOKEN_ALIASES, canonicalizeRouteTokens } = require('./address-compare');

// Pure directional tokens — shared by the city-boundary walk (a city may
// START with one: "North Port") and the variant filter (a street may END
// with one: "53rd Ave E", where truncating the E changes the street).
const DIRECTIONAL_TOKENS = new Set(['north', 'south', 'east', 'west', 'n', 's', 'e', 'w',
  'northeast', 'northwest', 'southeast', 'southwest', 'ne', 'nw', 'se', 'sw']);
const { CUSTOMER_STAGES, whereLiveCustomer } = require('../customer-stages');
// Canonical "not live coverage" status set (also excludes completed,
// no_show, skipped, and the phantom 'rescheduled' rows) — mirroring only
// 'cancelled' here would count dead rows as active recurring coverage.
const { TERMINAL_STATUSES } = require('../waveguard-existing-services');

function scopeGuardsEnabled() {
  const flag = process.env.GATE_ESTIMATOR_SCOPE_GUARDS;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// The Twilio webhook awaits triage before its TwiML response, alongside the
// classifier's own 3.5s cap — the whole grounding phase gets a hard budget
// so a saturated pool degrades to the ungrounded prompt, not a webhook
// timeout.
const TRIAGE_TIMEOUT_MS = 1200;

// Look back this far in sms_log when a coordinator splits context across
// texts (address in one message, the ask in the next).
const THREAD_WINDOW_HOURS = 48;
// Prompt display cap — how many labeled texts ride into the classifier.
const THREAD_WINDOW_LIMIT = 5;
// Fetch sanity bound, NOT a display limit: the burst partition (veto +
// grounding) runs in JS after the fetch, and a fetch capped at the display
// limit would truncate a 6+ message exchange's burst — losing exactly the
// in-burst text that carries the address or the out-of-scope ask.
const THREAD_FETCH_LIMIT = 25;
// The HARD scope veto only trusts the current exchange — texts this recent.
// A power-washing mention from yesterday must not deterministically kill
// today's vague-but-valid "can I get that quote?"; stale context is the
// grounded classifier's judgment call, not the regex's.
const VETO_BURST_MINUTES = 90;

// Services Waves does NOT offer, phrased as service REQUESTS (noun +
// action/service context), not bare nouns — "Jane Painter" introducing
// herself or a "Roofers Rd" street name must never trip the veto.
// Deliberately conservative — anything ambiguous falls through to the
// grounded classifier instead.
const OUT_OF_SCOPE_RE = new RegExp(
  [
    'power\\s*wash\\w*', 'pressure\\s*wash\\w*', 'soft\\s*wash\\w*',
    // No bare 'roofing': org names ("Gulf Coast Roofing" asking for a pest
    // quote) must not trip the veto — roof terms need request context like
    // every other trade noun.
    'roof(?:ing)?\\s*(?:repair|replace\\w*|clean\\w*|leak|work|job|quote|estimate)',
    '(?:need|want|looking\\s+for|find|hire|get)\\s+(?:a\\s+)?(?:new\\s+)?roof\\b',
    'gutter\\s*(?:clean\\w*|repair\\w*|guard)', 'clean\\w*\\s+(?:my|the|our)\\s+gutters',
    'painting\\s+(?:quote|estimate|job|work|service)s?',
    '(?:need|want|looking\\s+for|get)\\s+(?:some\\s+)?painting\\b',
    'paint\\s+(?:job|work|quote|estimate|my|the|our|interior|exterior|house|home)',
    'pool\\s*(?:clean\\w*|service|maint\\w*)',
    'window\\s*(?:clean\\w*|wash\\w*)', 'carpet\\s*clean\\w*', 'duct\\s*clean\\w*',
    // Trade nouns need request context too — "Joe Plumber" the person and
    // "Handyman Hardware" the store are not service requests.
    'hvac\\s+(?:service|repair|work|quote|install\\w*|maint\\w*|system|unit|tech)',
    'service\\s+(?:my|the|our)\\s+hvac', 'air\\s*conditioning\\s+(?:service|repair|work)',
    'plumbing\\s+(?:work|issue|problem|repair|leak|service|quote)',
    // Article optional: "need plumber" / "hire electrician" are requests
    // too; bare trade SURNAMES stay safe because the request verb is still
    // required ("Joe Plumber" has none).
    '(?:need|want|looking\\s+for|find|hire|recommend\\w*|get)\\s+(?:an?\\s+)?(?:plumber|electrician|handyman)',
    'electrical\\s*(?:work|repair)',
    'handyman\\s+(?:service|work|job)s?',
    'drywall\\s+(?:repair|work|patch\\w*|install\\w*|job|quote)',
    // Solar/lights/remodel need request context like every other trade —
    // "Gulf Coast Remodeling" or "Sunshine Solar Panels LLC" introducing
    // themselves while asking for OUR service must never trip the veto.
    'solar\\s*panel\\w*\\s+(?:install\\w*|clean\\w*|repair\\w*|service|quote|estimate)',
    '(?:need|want|looking\\s+for|get|hire|install\\w*)\\s+(?:new\\s+)?solar\\s*panels?\\b',
    'seal\\s*coat\\w*',
    'christmas\\s*light\\w*\\s+(?:install\\w*|hang\\w*|removal|remove\\w*|take\\s*down|service|quote|estimate)',
    '(?:hang|install\\w*|put\\s+up|take\\s+down)\\s+(?:(?:my|the|our)\\s+)?christmas\\s*lights?\\b',
    'remodel\\w*\\s+(?:quote|estimate|job|work|project|service)s?\\b',
    '(?:need|want|looking\\s+for|hire|get|planning)\\s+(?:a\\s+)?(?:remodel\\b|renovation\\b)',
    'remodel\\s+(?:my|the|our)\\b',
  ].join('|'),
  'i',
);

// Nouns that positively indicate a pest/lawn request. When one of these is
// present alongside an out-of-scope phrase ("power wash the patio and spray
// for ants"), the message stays with the classifier — the veto only fires
// on texts that request an out-of-scope service and mention nothing Waves
// treats.
const IN_SCOPE_RE = new RegExp(
  '\\b(?:pest\\w*|bugs?|ants?|roach\\w*|termites?|mosquito\\w*|rodents?|rats?|mice'
  + '|fleas?|bed\\s*bugs?|wasps?|hornets?|bees?|spiders?|scorpions?|ticks?|snakes?'
  + '|lawn|grass|weeds?|fertiliz\\w*|shrubs?|trees?|palms?|wdo|exterminat\\w*'
  // Generic treatment phrasing counts as in-scope: a mixed request ("spray
  // my yard and pressure wash the driveway") must reach the grounded
  // classifier, never die in the deterministic veto.
  + '|spray\\w*|treat\\w*|infest\\w*|yard)\\b',
  'i',
);

// Postgres regex patterns that match a stated unit VALUE as a real unit
// token — shared by the SQL discriminator; pure so tests can pin the
// semantics directly. \m/\M are Postgres word boundaries (≈ JS \b for
// alphanumerics), which is what keeps '6' from matching '16', '26', or the
// house number in '600 Palm Ave'.
const UNIT_DESIGNATOR_ALT = '(?:apt|apartment|unit|suite|ste|lot|spc|space|bldg|building|floor)';
function unitTokenPatterns(unitValue) {
  const v = String(unitValue).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return {
    // Whole-column match: optional designator/# then exactly the value.
    line2Pattern: `^\\s*(?:${UNIT_DESIGNATOR_ALT}\\.?\\s*#?\\s*|#\\s*)?${v}\\M\\s*$`,
    // In line1 the value counts only right after a designator or '#'.
    line1Pattern: `(?:\\m${UNIT_DESIGNATOR_ALT}\\.?\\s*#?\\s*|#\\s*)${v}\\M`,
  };
}

// Deterministic pre-LLM veto: the text asks for an out-of-scope home
// service and mentions nothing in Waves' domain. Cheap, zero-latency, and
// immune to the classifier's generosity.
function deterministicOutOfScope(text) {
  const t = String(text || '');
  return OUT_OF_SCOPE_RE.test(t) && !IN_SCOPE_RE.test(t);
}

// One shared "is this a street suffix/directional token" vocabulary for
// every no-comma locality decision (city boundary AND bare-ZIP binding).
// The suffix half is the CANONICAL comma-free boundary set from
// utils/address-normalizer (walk, point/pt, causeway/cswy, plaza/plz,
// ridge/rdg, …) — never a hand-maintained parallel list, which is exactly
// how the two earlier copies drifted. STREET_TOKEN_ALIASES adds the
// compare-time directionals (n/north, se/southeast, …) the normalizer's
// split set deliberately omits.
const { STREET_SPLIT_SUFFIXES, CITY_PREFIX_TOKENS, isStateZipPair } = require('../../utils/address-normalizer');

const ALL_STREET_SUFFIXES = new Set([
  ...STREET_SPLIT_SUFFIXES,
  ...Object.keys(STREET_TOKEN_ALIASES),
  ...Object.values(STREET_TOKEN_ALIASES),
]);

// Street-address candidates from free text: a street number followed by up
// to four street-name words. The trailing words may overshoot into prose
// ("… 100 Sample Loop before Saturday"), so `variants` lists every prefix
// ("Sample", "Sample Loop", "Sample Loop before", …) — the DB prefix query
// uses the first word, and confirmation accepts a row when ANY variant
// matches the row's full normalized street (address-compare owns
// suffix/directional normalization).
function extractAddressCandidates(text) {
  const src = String(text || '');
  // House numbers may be a single digit ("7 Palm Ave") and street names may
  // be numbered ("123 5th Ave") — the full-street confirmation downstream is
  // the precision gate, so the grammar here stays broad.
  // Up to seven street words ("100 Dr Martin Luther King Jr Blvd") — the
  // full-street confirmation requires complete equality, so a truncated
  // capture would permanently miss long street names.
  // Numbered ROUTES ("123 US 41", "123 State Road 64", "6812 US Highway
  // 301") carry an all-numeric street token — accepted only right after a
  // route designator (lookbehind), so a neighboring address's house number
  // ("100 Palm Ave and 200 Oak St") or prose numbers are never swallowed
  // into the street run, and the bare-number-pair guard below ("4 30
  // tomorrow") keeps its job on the FIRST word.
  // Separators are single-line ([^\S\r\n], never \s): grounding text joins
  // separate MESSAGES with newlines, and a \s separator let a message-final
  // number and the NEXT message's first word fuse into a phantom candidate
  // ("… 34285\nconfirming …" → '34285 confirming').
  const re = /\b(\d{1,6})[^\S\r\n]+([A-Za-z0-9][A-Za-z0-9'.-]*(?:[^\S\r\n]+(?:[A-Za-z][A-Za-z0-9'.-]*|(?<=\s(?:us|sr|cr|rte|rt|route|hwy|highway|road|rd)\s+)\d{1,4}\b)){0,6})/gi;
  let m;
  // Structural designators (lot/space/bldg/floor) come from the canonical
  // set in utils/address-normalizer.js. 'fl' is handled separately below —
  // it is BOTH the state marker and the floor designator, disambiguated by
  // the canonical isStateZipPair rule.
  const UNIT_WORD_RE = /^(?:apt|apartment|unit|suite|ste|lot|spc|space|bldg|building|floor|#)$/i;
  // Candidate-cap semantics: the 3-candidate cap applies to PLAUSIBLE
  // candidates only — ones whose street words carry a suffix/directional/
  // route token, or that bound a unit or locality. Numeric quote details
  // ("99 initial, 49 monthly, 4 quarterly visits") match the grammar but
  // never look like streets, and an enumerated skip-list can't cover every
  // pricing noun — under the old first-3 cap they crowded the real address
  // out. Implausible candidates are kept ONLY as a fallback when a message
  // yields nothing plausible ('100 Sample' alone still extracts; alongside
  // a plausible address it is dropped). A hard scan bound keeps the pass
  // cheap on pathological texts.
  const plausible = [];
  const implausible = [];
  const ROUTE_TOKENS = new Set(['us', 'sr', 'cr', 'rte', 'rt', 'route']);
  let scanned = 0;
  while (plausible.length < 3 && scanned < 40 && (m = re.exec(src)) !== null) {
    scanned += 1;
    // TOKENIZER-level punctuation normalization: trailing periods come off
    // every captured word ('N.' → 'N', 'Apt.' → 'Apt', 'Ste.' → 'Ste') so
    // every downstream consumer — prefixVariants alias expansion, the
    // UNIT_WORD_RE designator cut, unit capture, the SQL prefixes built
    // from firstWord — sees canonical tokens. Un-normalized, '100 N. Palm'
    // never fetched the row stored as '100 North Palm Avenue', and
    // 'Apt. 6' carried no unit at all, bypassing the exact-unit guard.
    // (Interior periods — decimals — are untouched.)
    const allWords = m[2].split(/\s+/).map((w) => w.replace(/\.+$/, ''));
    // Skip obvious non-addresses: durations ("24 hours", "2 pm"),
    // MEASUREMENT phrases ("2 bedrooms, 3 bathrooms, 1500 sqft" — each of
    // those consumed one of the three candidate slots and could push the
    // REAL address out entirely), and bare number-pairs ("4 30") — numbered
    // streets carry a suffix ("5th"). Skipped matches never count against
    // the 3-candidate emission cap, so a measurement-heavy message still
    // reaches the address further along. Rare streets that BEGIN with one
    // of these nouns ("100 Story Rd") lose extraction — the conservative
    // direction (no grounding ⇒ the standing bell, never a wrong link).
    if (/^(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|am|pm|beds?|bedrooms?|baths?|bathrooms?|sqft|sq|square|ft|feet|foot|stories|story|floors?|acres?|cars?|garages?|people|persons?|guests?|kids?|dogs?|cats?|pets?|rooms?)$/i.test(allWords[0])) continue;
    if (/^\d+$/.test(allWords[0])) continue;
    // The street-word run may have swallowed a unit designator ("100 Palm
    // Ave Apt 6" → words [Palm, Ave, Apt]) — cut the street at the FIRST
    // designator AFTER the first word. A street-LEADING designator word is
    // street TEXT, not a unit: "100 Space Coast Parkway" / "100 Building B
    // Way" must keep their full street run.
    const afterStreet = src.slice(m.index + m[0].length, m.index + m[0].length + 60);
    // 'fl' is a designator ONLY per the canonical isStateZipPair rule
    // (address-normalizer): followed by a ZIP-shaped value it is the STATE
    // marker ("FL 34285"); we additionally require a short floor-number
    // value (1-3 digits + optional letter) so terminal 'FL' and 'FL <city>'
    // stay the state marker. The value may live past the capture ('Fl' is
    // the last captured word, '2' stopped the run) — peek at the tail.
    const tailFirstToken = (afterStreet.match(/^[^\S\r\n]*#?[^\S\r\n]*([A-Za-z0-9-]{1,8})\b/) || [])[1] || null;
    const isFlFloor = (i) => {
      const next = allWords[i + 1] != null ? allWords[i + 1] : tailFirstToken;
      return !!next && !isStateZipPair('fl', String(next)) && /^\d{1,3}[a-z]?$/i.test(next);
    };
    const designatorIdx = allWords.findIndex((w, i) => {
      if (i === 0) return false;
      if (/^fl$/i.test(w)) return isFlFloor(i);
      return UNIT_WORD_RE.test(w);
    });
    const words = designatorIdx > 0 ? allWords.slice(0, designatorIdx) : allWords;
    // Unit forms: "Apt 6", "Unit B", "#6", "Lot 6". Two trusted shapes
    // ONLY: a designator swallowed into the street run (value straddles
    // into the tail), or a designator/# that STARTS the tail — an
    // unanchored search over the street words would read "Space Coast" as
    // a unit. A "#" further into the prose (ticket numbers, "order #12")
    // is never this address's unit. localitySrc advances past whatever the
    // unit consumed so the locality anchor still reaches the city/ZIP
    // ("Apt 6, Venice FL 34285").
    let unitWordRaw = null;
    let unitValue = null;
    let localitySrc = afterStreet;
    if (designatorIdx > 0) {
      unitWordRaw = allWords[designatorIdx];
      const straddle = allWords[designatorIdx + 1];
      if (straddle && /^[A-Za-z0-9-]{1,8}$/.test(straddle)) {
        // Value was captured into the street run too ("Unit B"). Any
        // REMAINING captured words after the value ("… Apt B Venice FL")
        // are locality material the tail no longer carries — rebuild the
        // locality source from them so the no-comma city/FL/ZIP parse
        // below still sees the city.
        unitValue = straddle;
        const remainder = allWords.slice(designatorIdx + 2).join(' ');
        if (remainder) localitySrc = `${remainder}${afterStreet}`;
      } else {
        const vm = afterStreet.match(/^\s*#?\s*([A-Za-z0-9-]{1,8})\b/);
        if (vm) {
          unitValue = vm[1];
          localitySrc = afterStreet.slice(vm[0].length);
        }
      }
    } else {
      // Tail 'Fl <floor>' first — kept out of the general alternation
      // because its value class must exclude ZIP-shaped tokens (', FL
      // 34285' is the state+ZIP tail, never Floor 34285).
      const flTail = afterStreet.match(/^[^\S\r\n]*,?[^\S\r\n]*fl\.?[^\S\r\n]+(\d{1,3}[a-z]?)\b(?!\d)/i);
      const am = (!flTail || isStateZipPair('fl', flTail[1]))
        ? afterStreet.match(/^\s*,?\s*(?:\b(apt|apartment|unit|suite|ste|lot|spc|space|bldg|building|floor)\.?\s*#?\s*|(#)\s*)([A-Za-z0-9-]{1,8})\b/i)
        : null;
      if (flTail && !isStateZipPair('fl', flTail[1])) {
        unitWordRaw = 'Fl';
        unitValue = flTail[1];
        localitySrc = afterStreet.slice(flTail[0].length);
      } else if (am) {
        unitWordRaw = am[1] || null;
        unitValue = am[3];
        localitySrc = afterStreet.slice(am[0].length);
      }
    }
    // An explicitly-stated unit rides on EVERY variant: sameStreetAddress
    // treats a missing unit as conservatively equal, so a unit-less variant
    // of "Apt 6" would happily ground against the customer in Apt 1. The
    // ORIGINAL designator word is preserved ("Lot 6", not "Apt 6") so the
    // normalizer compares like-for-like; the bare hash form reads as Apt.
    const unitWord = unitWordRaw ? unitWordRaw[0].toUpperCase() + unitWordRaw.slice(1).toLowerCase() : 'Apt';
    const unitSuffix = unitValue ? ` ${unitWord} ${unitValue}` : '';
    // Explicit locality after the street run — attached ONLY when anchored
    // AND validated: a comma-led city needs FL/Florida or a ZIP behind it
    // ("…, Bradenton FL" / "…, Venice 34285"), and a bare ZIP counts only
    // when it directly follows the street. Comma prose ("100 Palm Ave,
    // please") and unrelated numbers ("budget of 15000") must not become a
    // fake locality that rejects the real customer row.
    const locM = localitySrc.match(/^\s*,\s*([A-Za-z][A-Za-z .'-]{2,28}?)\s*,?\s*(\bFL\b|\bFlorida\b)?\s*(\d{5})?\b/i);
    let locality = '';
    if (locM && (locM[2] || locM[3])) {
      locality = `, ${locM[1].trim()}${locM[3] ? ` ${locM[3]}` : ''}`;
    } else {
      // Bare-ZIP form requires the comma ("…, 34285") — with street runs up
      // to seven words, a zip-like number after uncomma'd prose ("with a
      // budget of 15000") must stay unbound; a missing locality still
      // compares conservatively equal downstream.
      const zipDirect = localitySrc.match(/^\s*,\s*(\d{5})\b/);
      if (zipDirect) locality = `, ${zipDirect[1]}`;
    }
    if (!locality) {
      // No-comma forms: the street run swallows the city and FL marker
      // ("100 Palm Ave Venice FL [34285]"). When an FL marker is present,
      // rebuild the CITY from the words between the last street-SUFFIX
      // token and the marker — pure directionals are NOT boundaries, or
      // SWFL cities that start with one ("North Port", "North Venice")
      // would lose their first word. Fallback when no suffix exists: the
      // single word before FL. A trailing ZIP (never captured into the
      // street run — the route-number grammar requires a designator) rides
      // along when present.
      const zipNC = localitySrc.match(/^\s*(\d{5})\b/);
      const flIdx = words.findIndex((w) => /^(?:fl|florida)$/i.test(w));
      if (flIdx > 0) {
        // The shared suffix vocabulary MINUS pure directionals: a city that
        // starts with one ("North Port", "North Venice") would otherwise
        // lose its first word to the boundary.
        const suffixBoundary = new Set([...ALL_STREET_SUFFIXES].filter((t) => !DIRECTIONAL_TOKENS.has(t)));
        const boundaries = [];
        for (let i = 0; i < flIdx; i += 1) {
          if (suffixBoundary.has(String(words[i]).toLowerCase())) boundaries.push(i);
        }
        // Walk back off boundaries that are really CITY PREFIXES — "St
        // James City", "Lake Wales", "Key Largo" all start with a
        // suffix-shaped token, and taking the LAST one as the boundary
        // reconstructs "James City" and then rejects the stored row. Same
        // protection (and same stop-at-first rule, so the street keeps at
        // least its own suffix) as splitStreetAndCity in
        // utils/address-normalizer.
        let pos = boundaries.length - 1;
        while (pos > 0 && CITY_PREFIX_TOKENS.has(String(words[boundaries[pos]]).toLowerCase())) pos -= 1;
        let boundary = boundaries.length ? boundaries[pos] : -1;
        // A NUMERIC token right after the suffix is the route number, part
        // of the STREET ("123 State Road 64 Bradenton FL") — advance the
        // boundary past it or the city reconstructs as "64 Bradenton".
        while (boundary >= 0 && boundary + 1 < flIdx && /^\d+$/.test(String(words[boundary + 1]))) {
          boundary += 1;
        }
        const cityWords = boundary >= 0 ? words.slice(boundary + 1, flIdx) : words.slice(flIdx - 1, flIdx);
        const city = cityWords.join(' ').trim();
        if (city) locality = `, ${city}${zipNC ? ` ${zipNC[1]}` : ''}`;
      }
      if (!locality) {
        // The city+FL can also live in the TAIL when a unit expression
        // ended the street run ("100 Palm Ave Apt 6 Venice FL 34285" /
        // "#6 …"): after the unit strip, localitySrc begins directly with
        // the city — no comma anchor, and the words-based branch above
        // can't see it. Anchored: optional city words, then the FL marker,
        // then an optional ZIP; prose without an FL marker never matches.
        const ncM = localitySrc.match(/^\s*([A-Za-z][A-Za-z .'-]{1,28}?)?\s*\b(?:fl|florida)\b\s*(\d{5})?\b/i);
        if (ncM && (ncM[1] || ncM[2])) {
          const city = String(ncM[1] || '').trim();
          const zip = ncM[2] || '';
          locality = `, ${[city, zip].filter(Boolean).join(' ')}`;
        }
      }
      if (!locality && zipNC) {
        // ZIP-only fallback ("100 Palm Ave 34285", or FL forms where no
        // city could be rebuilt): bind the ZIP when the words carry an FL
        // marker or the last street word is a known suffix/directional —
        // never after swallowed prose ("with a budget of 15000" stays
        // unbound). Locality-by-ZIP is enough to reject a same-street row
        // in another city.
        const lastWord = String(words[words.length - 1] || '').toLowerCase();
        const hasFl = flIdx >= 0;
        // Same suffix vocabulary the city-boundary test uses — the
        // alias table alone omits Loop/Way/Trail/Cove/…, which dropped
        // the ZIP from "100 Sample Loop 34287".
        if (hasFl || ALL_STREET_SUFFIXES.has(lastWord)) locality = `, ${zipNC[1]}`;
      }
    }
    const candidate = {
      num: m[1],
      firstWord: words[0],
      // The second street word rides along so the prefix builder can
      // recognize two-word route designators ('State Road' → SR).
      secondWord: words[1] || null,
      locality,
      // The EXPLICIT unit the sender stated, surfaced so confirmation can
      // demand exact agreement and the DB query can discriminate on it.
      unit: unitValue ? `${unitWord} ${unitValue}` : null,
      unitValue: unitValue || null,
      // A prefix variant that TRUNCATES a following directional is dropped:
      // for '100 53rd Ave E' the shorter '100 53rd Ave' would match the
      // UNRELATED non-directional street — the full compare correctly
      // treats the trailing E as significant, and the truncated variant
      // bypasses exactly that check. Non-directional continuations keep
      // every prefix (prose overshoot still needs them).
      variants: words
        .map((_, i) => i)
        .filter((i) => i === words.length - 1 || !DIRECTIONAL_TOKENS.has(String(words[i + 1]).toLowerCase()))
        .map((i) => `${m[1]} ${words.slice(0, i + 1).join(' ')}${unitSuffix}`),
    };
    // Plausibility: a street token (suffix/directional/route designator),
    // or a bound unit/locality. See the cap-semantics note above the loop.
    const looksLikeStreet = words.some((w) => {
      const t = String(w).toLowerCase();
      return ALL_STREET_SUFFIXES.has(t) || ROUTE_TOKENS.has(t);
    }) || !!unitValue || !!locality;
    (looksLikeStreet ? plausible : implausible).push(candidate);
  }
  return plausible.length ? plausible : implausible.slice(0, 3);
}

// ILIKE prefixes for a candidate's first street word, expanded through the
// suffix/directional alias table — "100 N Palm" must fetch a row stored as
// "100 North Palm Avenue" (sameStreetAddress normalizes both at confirm
// time, but a prefix that never fetches the row never gets confirmed).
function prefixVariants(num, firstWord, secondWord = null) {
  const lower = String(firstWord || '').toLowerCase();
  const words = new Set([firstWord]);
  if (STREET_TOKEN_ALIASES[lower]) words.add(STREET_TOKEN_ALIASES[lower]);
  for (const [long, short] of Object.entries(STREET_TOKEN_ALIASES)) {
    if (short === lower) words.add(long);
  }
  // Numbered-route designators span SPELLINGS the alias table can't map
  // token-for-token: '123 State Road 64' must fetch rows stored '123 SR
  // 64' and vice versa (sameStreetAddress canonicalizes both at confirm
  // time, but a prefix that never fetches the row never gets confirmed).
  // Bare 'US' needs nothing — 'US%' already fetches 'US 41' and 'US
  // Highway 41'.
  const second = String(secondWord || '').toLowerCase();
  let routeKey = null;
  if (lower === 'sr' || (lower === 'state' && ['road', 'rd', 'route'].includes(second))) routeKey = 'sr';
  else if (lower === 'cr' || (lower === 'county' && ['road', 'rd'].includes(second))) routeKey = 'cr';
  else if (['route', 'rte', 'rt'].includes(lower)) routeKey = 'rt';
  const ROUTE_PREFIX_WORDS = { sr: ['SR', 'State'], cr: ['CR', 'County'], rt: ['Rt', 'Rte', 'Route'] };
  if (routeKey) ROUTE_PREFIX_WORDS[routeKey].forEach((w) => words.add(w));
  return [...words].map((w) => `${num} ${w}%`);
}

// A prefix-fetched row only counts as "this customer's property" when the
// message's street run truly matches the row's full normalized street —
// "100 Palm Ave" must not ground against a customer at "100 Palm St" — and,
// when the message states a locality, in the row's city/ZIP too. Compare
// both sides WITH their known localities: sameStreetAddress treats a
// missing city/ZIP as conservatively equal and a stated disagreement as a
// mismatch, which is exactly the wanted asymmetry.
function candidateMatchesRow(candidate, row) {
  // address_line2 carries the row's unit — include it so an explicit
  // candidate unit ("Apt 6") is compared against the row's explicit unit
  // ("Apt 1") instead of matching conservatively on the bare street.
  const line1 = [row.address_line1, row.address_line2].filter(Boolean).join(' ');
  const rowFull = [line1, [row.city, row.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  // When the sender STATED a unit, grounding must prove that unit. In
  // sameStreetAddress's default (duplicate-detection) mode a known unit
  // compares equal to a MISSING one — conservative there, wrong here: the
  // sole row at "100 Palm Ave" with a null address_line2 would ground an
  // explicit "100 Palm Ave Apt 6" and price the building instead of the
  // apartment. requireExactUnit makes known-vs-missing a mismatch.
  // Unit-less candidates keep the conservative behavior (a stated street
  // with no unit may legitimately match the row that carries one).
  const opts = candidate.unitValue ? { requireExactUnit: true } : undefined;
  return candidate.variants.some((v) => {
    try {
      return sameStreetAddress(`${v}${candidate.locality || ''}`, rowFull, opts);
    } catch (err) {
      return false;
    }
  });
}

async function loadTriageInner({ phone, triggerBody, deadline = Date.now() + TRIAGE_TIMEOUT_MS }) {
  const db = require('../../models/db');
  // Cooperative deadline: Promise.race in the wrapper bounds the RESPONSE,
  // this bounds the WORK — an expired budget stops issuing queries (and the
  // knex cancel-timeout aborts the in-flight one) instead of leaving an
  // abandoned query waterfall holding pool slots behind the webhook.
  const timeLeft = () => deadline - Date.now();
  const assertTime = () => {
    if (timeLeft() <= 50) {
      const err = new Error('triage_deadline');
      err.deadline = true;
      throw err;
    }
  };
  const bounded = (qb) => qb.timeout(Math.max(60, timeLeft()), { cancel: true });

  // COLLECT first, render after: an unscoped sender entry must not carry
  // visit evidence when the text also names a specific property — a booked
  // visit at property A listed on the sender line would still read as
  // existing-job evidence against a new quote at property B.
  const entries = [];
  const seenMatches = new Set();
  const addEntry = (customer, how, addressLine, scope = null) => {
    // FULL scoped stamp, not address_line1 alone: one customer can hold
    // several units on the same street line (Apt 1 and Apt 6 of the same
    // building), and an address-only key collapses them into one arbitrary
    // entry — the surviving scope would then price whichever DB row landed
    // first. With the full stamp both units survive as distinct entries,
    // which correctly drops groundedScope to null (multiple properties =
    // no single property to price) while both still ground the classifier.
    const matchKey = scope
      ? `${customer.id}|${[scope.address, scope.line2, scope.city, scope.zip].map((p) => p || '').join('|')}`
      : `${customer.id}|unscoped`;
    if (seenMatches.has(matchKey)) return;
    seenMatches.add(matchKey);
    entries.push({ customer, how, addressLine, scope });
  };

  if (phone) {
    assertTime();
    const { loadCustomerByPhone } = require('./context-builder');
    // Bounded like every other triage query, and matched against the
    // configured service-contact phone slots too — a spouse/tenant/manager
    // texting from an on-file contact number is an established identity.
    const senderMatch = await loadCustomerByPhone(phone, null, {
      timeoutMs: Math.max(60, timeLeft()),
      includeServiceContacts: true,
    });
    // Grounding requires a REAL customer: active === true (not merely "not
    // false" — the select may omit the column) AND an established customer
    // stage. The Twilio webhook creates an active pipeline_stage='new_lead'
    // customers row for first contacts right before this triage runs — a
    // prospect must never read as an existing customer here, or their own
    // quote request vetoes itself as an "existing job".
    if (senderMatch?.customer && !senderMatch.ambiguous
      && senderMatch.customer.active === true
      && CUSTOMER_STAGES.includes(senderMatch.customer.pipeline_stage)) {
      addEntry(senderMatch.customer, 'Sender phone matches');
    }
  }

  // Split-context threads: the address — or the service being asked about
  // ("Do you do power washing?" … "How much?") — may sit in an earlier text
  // of the same conversation, not the quote-flavored one that triggered
  // triage — and Waves' OWN outbound texts carry grounding context too
  // ("quarterly visit at 100 Palm booked Friday" is exactly what grounds a
  // coordinator's reply), so the fetch reads BOTH directions. The bodies
  // ride back to the caller: recentTexts (full window, direction-labeled)
  // for the classifier prompt, vetoTexts (current burst, INBOUND ONLY —
  // our own outbound wording like "we don't do power washing" must never
  // hard-veto the sender's next ask) for the deterministic veto. Customer
  // GROUNDING extracts addresses from the CURRENT exchange only (trigger +
  // burst, both directions) — yesterday's conversation about customer A's
  // property must not become grounding (or groundedCustomerId) for today's
  // quote about an unmatched property B.
  let recentTexts = [];
  let vetoTexts = [];
  let burstTexts = [];
  const digits = last10(phone);
  if (digits) {
    try {
      assertTime();
      const priorTexts = await bounded(db('sms_log')
        .where(function threadEitherDirection() {
          this.whereRaw("regexp_replace(coalesce(from_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`])
            .orWhereRaw("regexp_replace(coalesce(to_phone, ''), '\\D', '', 'g') LIKE ?", [`%${digits}`]);
        })
        .whereRaw(`created_at >= NOW() - INTERVAL '${THREAD_WINDOW_HOURS} hours'`)
        .orderBy('created_at', 'desc')
        .limit(THREAD_FETCH_LIMIT))
        .select('message_body', 'created_at', 'direction');
      const isInbound = (t) => String(t.direction || '').toLowerCase() === 'inbound';
      const body = (t) => String(t.message_body || '');
      // Prompt display cap applies AFTER the fetch; the burst partition
      // below always sees the full fetched window.
      recentTexts = priorTexts
        .filter((t) => body(t))
        .slice(0, THREAD_WINDOW_LIMIT)
        .map((t) => `[${isInbound(t) ? 'sender' : 'Waves'}] ${body(t)}`);
      const burstFloor = Date.now() - VETO_BURST_MINUTES * 60 * 1000;
      const inBurst = (t) => t.created_at && new Date(t.created_at).getTime() >= burstFloor;
      vetoTexts = priorTexts.filter((t) => isInbound(t) && inBurst(t)).map(body).filter(Boolean);
      burstTexts = priorTexts.filter(inBurst).map(body).filter(Boolean);
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage thread lookup failed: ${err.message}`);
    }
  }
  // Grounding is anchored to THIS request. Burst proximity is not property
  // attribution: if Waves recently texted an off-file manager about
  // customer A at 100 Palm Ave and the manager then asks for a NEW quote at
  // unmatched 200 Oak St, importing A's address from the burst would link
  // the draft (and A's membership) to a request that never mentioned A.
  // So: when the TRIGGER names any address, those are the only candidates.
  // Burst/outbound context is used ONLY to resolve an address the trigger
  // references implicitly ("the same place", "that property") — i.e. when
  // the trigger names none at all — and then only when the burst names
  // exactly ONE distinct address, so there is nothing to guess between.
  const triggerCandidates = extractAddressCandidates(String(triggerBody || ''));
  const burstCandidates = extractAddressCandidates(burstTexts.join('\n'));
  // Uniqueness is judged by NORMALIZED EQUIVALENCE, not raw strings —
  // 'Waves: 100 Palm Ave, Venice FL 34285' and the reply's '100 Palm
  // Avenue' are ONE property (sameStreetAddress semantics: alias-equal
  // streets; equal-or-missing locality and unit are compatible), while
  // '100 Palm Ave' vs '100 Palm St' — or genuinely conflicting cities —
  // stay two (⇒ no grounding, never an arbitrary pick). The street is cut
  // after its last suffix (+ route number) so prose swallowed into the
  // capture ("… Loop Friday" vs "… Loop Monday") doesn't split the same
  // address. When notation variants merge, the RICHER candidate (the one
  // carrying a unit/locality) survives — it gates confirmation better.
  // Canonical route designators that terminate a street when a number
  // follows ('SR 64', 'CR 675', 'US 41', 'Rt 41') — the suffix table alone
  // can't see them, so '100 SR 64 Bradenton FL' kept its city inside the
  // street key while '100 State Road 64, Bradenton FL' cut after 64, and
  // the SAME property double-counted, blocking shorthand grounding.
  const ROUTE_CUT_TOKENS = new Set(['sr', 'cr', 'us', 'rt', 'hwy']);
  const candidateAddrString = (c) => {
    const last = c.variants[c.variants.length - 1] || `${c.num} ${c.firstWord}`;
    // Route spellings canonicalize BEFORE the cut (shared with the street
    // compare) so both spellings key identically.
    const tokens = canonicalizeRouteTokens(last.toLowerCase().split(/\s+/));
    let cut = tokens.length;
    for (let i = tokens.length - 1; i > 0; i -= 1) {
      if (ALL_STREET_SUFFIXES.has(STREET_TOKEN_ALIASES[tokens[i]] || tokens[i])) {
        cut = i + 1;
        break;
      }
      if (ROUTE_CUT_TOKENS.has(tokens[i]) && /^\d+$/.test(tokens[i + 1] || '')) {
        cut = i + 2;
        break;
      }
    }
    if (cut < tokens.length && /^\d+$/.test(tokens[cut])) cut += 1;
    // variants already carry the unit suffix on every entry; the cut
    // dropped it, so re-attach the explicit unit before the locality.
    return `${tokens.slice(0, cut).join(' ')}${c.unit ? ` ${c.unit}` : ''}${c.locality || ''}`;
  };
  const distinctBurst = [];
  for (const c of burstCandidates) {
    const addr = candidateAddrString(c);
    const matchIdx = distinctBurst.findIndex((u) => {
      try {
        return sameStreetAddress(candidateAddrString(u), addr);
      } catch (err) {
        return false;
      }
    });
    if (matchIdx === -1) {
      distinctBurst.push(c);
    } else {
      // MERGE complementary detail field-wise — the pair already proved
      // compatible (sameStreetAddress: conflicts in unit or locality would
      // have kept them distinct), so each field is equal-or-missing. An
      // 'Apt 6' text plus a 'Venice FL' text is ONE property whose merged
      // candidate must carry BOTH: keeping just one candidate would run
      // shorthand grounding without exact-unit enforcement (or without the
      // locality bind). The unit-bearing candidate's variants carry the
      // unit suffix, so it anchors the merge.
      const u = distinctBurst[matchIdx];
      const base = c.unitValue ? c : u;
      distinctBurst[matchIdx] = {
        ...base,
        locality: u.locality || c.locality || '',
      };
    }
  }
  let groundingCandidates = [];
  if (triggerCandidates.length) groundingCandidates = triggerCandidates;
  else if (distinctBurst.length === 1) groundingCandidates = distinctBurst;

  // Fetch bound. The discriminating predicates below run SQL-side so the
  // named unit/locality cannot fall outside the slice, and one extra row is
  // fetched to DETECT saturation: an over-cap result means "too many
  // same-street candidates to attribute" — ambiguous, which red-lanes.
  // It must never read as "no customer" and fall through to a prospect draft.
  const ADDRESS_ROW_CAP = 25;
  let groundingOvercap = false;
  // Locality the sender stated, if any (", Venice 34285" / ", 34285").
  const localityOf = (cand) => {
    const m = String(cand.locality || '').match(/^,\s*(.*?)\s*(\d{5})?\s*$/);
    return { city: (m && m[1]) || '', zip: (m && m[2]) || '' };
  };
  // Narrow SQL-side on what the sender actually stated. Both filters are
  // NULL-TOLERANT in the direction confirmation is tolerant: a row with no
  // stored locality still compares conservatively equal downstream, so it
  // must survive the query. A stated UNIT is not tolerant — confirmation
  // now requires exact unit agreement, so unit-less rows cannot match and
  // excluding them here is what frees the cap for the row that can.
  const discriminate = (qb, cand, cols) => {
    if (cand.unitValue) {
      // TOKEN matching, never substrings: a bare ILIKE '%6' sweeps in
      // 'Apt 16'/'Apt 26', and matching line1 as a substring lets the
      // HOUSE NUMBER of '600 Palm Ave' satisfy 'Unit 6'.
      //  - line2 holds only the unit expression → anchored designator-
      //    tolerant equality ('6', 'Apt 6', '#6', 'Apt #6' forms);
      //  - line1 holds the street too → the value counts only as a token
      //    directly after a designator/#, never as street text.
      // \m/\M are Postgres regex word boundaries.
      const { line2Pattern, line1Pattern } = unitTokenPatterns(cand.unitValue);
      qb.where(function unitMatch() {
        this.whereRaw(`coalesce(${cols.line2}, '') ~* ?`, [line2Pattern])
          .orWhereRaw(`coalesce(${cols.line1}, '') ~* ?`, [line1Pattern]);
      });
    }
    const loc = localityOf(cand);
    if (loc.city || loc.zip) {
      qb.where(function localityMatch() {
        this.whereRaw(`coalesce(${cols.city}, '') = ''`)
          .orWhereRaw(`coalesce(${cols.zip}, '') = ''`);
        if (loc.city) this.orWhereRaw(`${cols.city} ILIKE ?`, [loc.city]);
        if (loc.zip) this.orWhereRaw(`coalesce(${cols.zip}, '') = ?`, [loc.zip]);
      });
    }
    return qb;
  };

  for (const cand of groundingCandidates) {
    const label = `Message thread names address "${cand.num} ${cand.firstWord}…" which matches`;
    const prefixes = prefixVariants(cand.num, cand.firstWord, cand.secondWord);
    assertTime();
    const rows = await bounded(discriminate(
      db('customers')
        .modify(whereLiveCustomer)
        .whereRaw('address_line1 ILIKE ANY(?)', [prefixes]),
      cand,
      { line1: 'address_line1', line2: 'address_line2', city: 'city', zip: 'zip' },
    )
      // Deterministic order so a capped slice is reproducible rather than
      // whatever the planner returned first.
      .orderBy('address_line1', 'asc')
      .orderBy('id', 'asc')
      .limit(ADDRESS_ROW_CAP + 1))
      .select('id', 'first_name', 'last_name', 'address_line1', 'address_line2', 'city', 'zip');
    if (rows.length > ADDRESS_ROW_CAP) {
      groundingOvercap = true;
      continue;
    }
    for (const row of rows) {
      if (candidateMatchesRow(cand, row)) {
        const shown = [row.address_line1, row.city].filter(Boolean).join(', ');
        addEntry(row, label, shown, {
          address: row.address_line1, line2: row.address_line2, city: row.city, zip: row.zip, isPrimary: true,
        });
      }
    }
    // Secondary properties: customers.address_line1 mirrors only the
    // PRIMARY address — a coordinator texting about a customer's rental or
    // seasonal property matches customer_properties instead. try/catch its
    // own query: a schema surprise here must not sink the primary path.
    try {
      assertTime();
      const propRows = await bounded(discriminate(
        db('customer_properties as cp')
          .join('customers as c', 'c.id', 'cp.customer_id')
          .where('c.active', true)
          .whereNull('c.deleted_at')
          .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
          // Sold/deactivated properties are somebody else's address now — a
          // new occupant's quote must not ground against the old owner.
          .where('cp.active', true)
          .whereRaw('cp.address_line1 ILIKE ANY(?)', [prefixes]),
        cand,
        {
          line1: 'cp.address_line1', line2: 'cp.address_line2', city: 'cp.city', zip: 'cp.zip',
        },
      )
        // Same discrimination + saturation detection as the customers query.
        .orderBy('cp.address_line1', 'asc')
        .orderBy('cp.id', 'asc')
        .limit(ADDRESS_ROW_CAP + 1))
        .select('c.id', 'c.first_name', 'c.last_name',
          'cp.address_line1 as address_line1', 'cp.address_line2 as address_line2', 'cp.city', 'cp.zip');
      if (propRows.length > ADDRESS_ROW_CAP) {
        groundingOvercap = true;
        propRows.length = 0;
      }
      for (const row of propRows) {
        if (candidateMatchesRow(cand, row)) {
          const shown = [row.address_line1, row.city].filter(Boolean).join(', ');
          addEntry(
            { id: row.id, first_name: row.first_name, last_name: row.last_name },
            label,
            `${shown} (secondary property)`,
            { address: row.address_line1, line2: row.address_line2, city: row.city, zip: row.zip, isPrimary: false },
          );
        }
      }
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage property lookup failed: ${err.message}`);
    }
  }

  // RENDER. Visits are scoped to the matched property using the FULL
  // booking stamp (line1+line2, city, zip) — Apt 1's visit is not evidence
  // about Apt 6, and the same street line in another city is a different
  // parcel. Unstamped legacy rows count only for primary-address matches.
  // An unscoped sender entry whose customer also has an address-scoped
  // entry carries NO visit list — the scoped line owns the booked-work
  // evidence for the property the text is actually about.
  const lines = [];
  const scopedIds = new Set(entries.filter((e) => e.scope).map((e) => e.customer.id));
  const stampFull = (line1, line2, city, zip) => [
    [line1, line2].filter(Boolean).join(' '),
    [city, zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  // Active recurring coverage — live rows only (TERMINAL_STATUSES is the
  // canonical exclusion from waveguard-existing-services; 'cancelled' alone
  // would count completed/skipped/phantom-rescheduled rows as coverage).
  // Coverage is PER ENTRY, not per customer: an address-scoped entry only
  // carries coverage stamped at THAT property (unstamped legacy rows count
  // only for the primary-address match, same rule as the visit path) — a
  // multi-property customer's plan at home must not read as coverage for
  // their rental. Unscoped (sender) entries keep customer-wide coverage, so
  // the cache keys by customerId + scope stamp.
  const coverageCache = new Map();
  const recurringCoverage = async (customerId, scope = null) => {
    const scopeFull = scope ? stampFull(scope.address, scope.line2, scope.city, scope.zip) : null;
    const cacheKey = `${customerId}|${scopeFull || 'unscoped'}`;
    if (coverageCache.has(cacheKey)) return coverageCache.get(cacheKey);
    let note = '';
    try {
      assertTime();
      const rows = await bounded(db('scheduled_services')
        .where({ customer_id: customerId, is_recurring: true })
        .whereNotIn('status', TERMINAL_STATUSES)
        // Wide sanity bound, NOT a display limit: the property filter runs
        // in JS below, so a tight SQL limit would let another property's
        // service combos crowd the matched property's coverage out of the
        // fetch (same crowd-out rule as the visit and address queries).
        .limit(100))
        .distinct('service_type',
          'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
      const scoped = !scope ? rows : rows.filter((r) => {
        if (r.service_address_line1) {
          try {
            return sameStreetAddress(
              stampFull(r.service_address_line1, r.service_address_line2, r.service_address_city, r.service_address_zip),
              scopeFull,
              // A UNIT scope must prove the unit — in default conservative
              // mode a unitless legacy recurring row matches any unit,
              // telling the classifier Apt 6 is covered by a building-level
              // row. Same rule as candidateMatchesRow.
              scope.line2 ? { requireExactUnit: true } : undefined,
            );
          } catch (err) {
            return false;
          }
        }
        return scope.isPrimary;
      });
      const types = [...new Set(scoped.map((r) => r.service_type).filter(Boolean))];
      if (types.length) {
        note = `; recurring services on file: ${types.slice(0, 5).join(', ')}`;
      }
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage coverage lookup failed: ${err.message}`);
    }
    coverageCache.set(cacheKey, note);
    return note;
  };
  for (const e of entries) {
    const name = `${e.customer.first_name || ''} ${e.customer.last_name || ''}`.trim() || 'existing customer';
    const shownAddress = e.addressLine || e.customer.address_line1 || 'address on file';
    const coverage = await recurringCoverage(e.customer.id, e.scope);
    if (!e.scope && scopedIds.has(e.customer.id)) {
      lines.push(`${e.how}: existing active customer ${name}, ${shownAddress}${coverage} (booked work listed under the matched property below)`);
      continue;
    }
    let visitNote = '';
    try {
      assertTime();
      // "booked" means OPEN work only — completed/skipped/superseded rows
      // are history, not coordination context.
      const visits = await bounded(db('scheduled_services')
        .where({ customer_id: e.customer.id })
        .whereIn('status', ['pending', 'confirmed', 'en_route', 'on_site'])
        .whereRaw("scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '30 days'")
        .orderBy('scheduled_date', 'asc')
        // Wide sanity bound, NOT a display limit — same rule as the
        // coverage query: the stamp discrimination needs normalization
        // (suffix/directional aliases) that SQL cannot express, so the
        // filter runs in JS below, and a tight SQL limit would let a
        // busy multi-property customer's other-parcel visits crowd the
        // matched property's visit out of the fetch.
        .limit(100))
        .select('service_type', 'scheduled_date', 'status',
          'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
      const scopeFull = e.scope
        ? stampFull(e.scope.address, e.scope.line2, e.scope.city, e.scope.zip)
        : null;
      const scoped = !e.scope ? visits : visits.filter((v) => {
        if (v.service_address_line1) {
          try {
            return sameStreetAddress(
              stampFull(v.service_address_line1, v.service_address_line2, v.service_address_city, v.service_address_zip),
              scopeFull,
              // A UNIT scope must prove the unit — a unitless legacy visit
              // stamp must not read as Apt 6's booked work (same rule as
              // candidateMatchesRow and recurringCoverage).
              e.scope.line2 ? { requireExactUnit: true } : undefined,
            );
          } catch (err) {
            return false;
          }
        }
        return e.scope.isPrimary;
      });
      if (scoped.length) {
        visitNote = ` — booked: ${scoped.slice(0, 3)
          .map((v) => `${v.service_type} ${String(v.scheduled_date).slice(0, 10)} (${v.status})`)
          .join('; ')}`;
      }
    } catch (err) {
      if (err.deadline) throw err;
      logger.warn(`[estimator-scope] triage visit lookup failed: ${err.message}`);
    }
    lines.push(`${e.how}: existing active customer ${name}, ${shownAddress}${coverage}${visitNote}`);
  }

  // Exactly ONE distinct existing customer across the sender and address
  // matches: safe to carry into the draft context so an off-file
  // coordinator's legitimate add-on quote links the estimate instead of
  // drafting as a prospect (customer_id null). Two or more distinct
  // customers (shared street prefix, sender ≠ addressed customer) stay
  // null — the composer must not guess which one the quote belongs to.
  const distinctIds = new Set(entries.map((e) => e.customer.id));
  const groundedCustomerId = distinctIds.size === 1 ? entries[0].customer.id : null;
  // The matched PROPERTY rides along with the customer: the draft context
  // must price the property the thread is about, not the customer's primary
  // profile (a secondary-property or Apt-6 match must not inherit Apt 1's
  // address and measurements). Exactly one address-scoped entry → its full
  // stamp; sender-only (unscoped) grounding or multiple matched properties
  // → null (no override, conservative).
  const scopedEntries = entries.filter((e) => e.scope);
  const groundedScope = groundedCustomerId && scopedEntries.length === 1
    ? scopedEntries[0].scope
    : null;
  // The text named MORE than one confirmed property (two units of one
  // customer, a home and a rental). Dropping groundedScope to null is not
  // enough on its own — the customer would still link and the draft would
  // price the PRIMARY parcel, silently picking one of the properties the
  // sender actually named. That needs a human, not a guessed parcel: the
  // signal rides out and red-lanes the context build.
  const groundedMultiScope = scopedEntries.length > 1;
  return {
    lines,
    matchedExistingCustomer: entries.length > 0,
    groundedCustomerId,
    groundedScope,
    // MORE than one distinct customer (sender's phone matches A while the
    // text names B's property): nobody's identity is safe to attach, so
    // the context build red-lanes instead of guessing.
    groundedConflict: distinctIds.size > 1,
    groundedMultiScope,
    // Too many same-street candidates to attribute the request to one of
    // them. Routed to the same red lane as the other ambiguity signals: an
    // over-cap fetch must never read as "no customer" and let the request
    // fall through to an unlinked prospect draft on somebody's property.
    groundedOvercap: groundingOvercap,
    recentTexts,
    vetoTexts,
  };
}

// Compact "what Waves knows" block for the triage classifier. Fail-open on
// error AND on the time budget: null → the caller uses the ungrounded
// prompt, exactly today's behavior. The deadline is shared with the inner
// loader so expiry stops the WORK, not just the response.
async function loadThreadTriageContext({ phone, triggerBody }) {
  let timer = null;
  try {
    const deadline = Date.now() + TRIAGE_TIMEOUT_MS;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), TRIAGE_TIMEOUT_MS);
    });
    const result = await Promise.race([loadTriageInner({ phone, triggerBody, deadline }), timeout]);
    if (!result) logger.warn('[estimator-scope] triage context timed out (falling back ungrounded)');
    return result;
  } catch (err) {
    logger.warn(`[estimator-scope] triage context failed (falling back ungrounded): ${err.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  scopeGuardsEnabled,
  deterministicOutOfScope,
  extractAddressCandidates,
  // The current-exchange window. Exported so the context build scopes an
  // ADDRESS-GROUNDED transcript to the same exchange triage grounded from.
  VETO_BURST_MINUTES,
  loadThreadTriageContext,
  _private: {
    OUT_OF_SCOPE_RE, IN_SCOPE_RE, candidateMatchesRow, loadTriageInner, TRIAGE_TIMEOUT_MS, prefixVariants, unitTokenPatterns,
  },
};
