/**
 * Estimator Engine — address comparison helpers, shared by the orchestrator
 * (re-gather decisions) and the draft builder (multi-property duplicate
 * guard). False negatives are cheap (an extra re-lookup / an extra draft the
 * operator dedupes); a false positive prices or suppresses the wrong parcel.
 */

const {
  parseRawAddress,
  splitStreetLineUnit,
  unitLineValueKey,
} = require('../../utils/address-normalizer');

const STREET_TOKEN_ALIASES = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct',
  boulevard: 'blvd', place: 'pl', circle: 'cir', terrace: 'ter', parkway: 'pkwy',
  highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

// The composer ADDING locality to a bare street is re-gather-worthy even
// when the street segment matches — the bare-street lookup can have resolved
// the wrong parcel on SWFL's repeated street names.
function addressAddsLocality(candidate, baseline) {
  const hasLocality = (s) => {
    const tail = String(s || '').split(',').slice(1).join(' ');
    return /\d{5}/.test(tail) || /[a-z]/i.test(tail.replace(/\bfl(orida)?\b/gi, ''));
  };
  return hasLocality(candidate) && !hasLocality(baseline);
}

// Full first-segment comparison (house number + entire street line) with
// suffix/directional normalization, then city/ZIP agreement: "123 Palm St" ≠
// "123 Palm Ave", and the same street in a different city/ZIP is a different
// parcel (SWFL street names repeat across cities).
// Numbered-route designators, canonicalized BEFORE the single-token alias
// map: 'State Road 64', 'State Rd 64', and 'SR 64' are the same route, as
// are 'US Highway 41' / 'US Hwy 41' / 'US 41' and 'Route 41' / 'Rte 41' /
// 'Rt 41'. Pair rewrites fire only on the exact designator pairs, so a
// street NAMED 'State St' or a token like 'us' inside a name is untouched —
// non-route addresses normalize byte-identically to before. NOTE: this
// module is shared beyond the estimator (estimate-membership-context,
// intelligence-bar estimate-tools) — changes here must run those suites.
const ROUTE_PAIR_REWRITES = [
  [['state', 'road'], 'sr'], [['state', 'rd'], 'sr'], [['state', 'route'], 'sr'],
  [['county', 'road'], 'cr'], [['county', 'rd'], 'cr'],
  [['us', 'highway'], 'us'], [['us', 'hwy'], 'us'],
];
const ROUTE_SINGLE_REWRITES = { route: 'rt', rte: 'rt' };
// A parsed "city" consisting of ONLY a directional token is a mis-split
// post-directional street suffix, never a locality.
const BARE_DIRECTIONAL_CITY = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
function canonicalizeRouteTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const pair = ROUTE_PAIR_REWRITES.find(([[a1, a2]]) => tokens[i] === a1 && tokens[i + 1] === a2);
    if (pair) {
      out.push(pair[1]);
      i += 1;
      continue;
    }
    out.push(ROUTE_SINGLE_REWRITES[tokens[i]] || tokens[i]);
  }
  return out;
}

function sameStreetAddress(a, b, { requireExactUnit = false, requireNamedUnit = false } = {}) {
  const normSegment = (s) => canonicalizeRouteTokens(String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean))
    .map((t) => STREET_TOKEN_ALIASES[t] || t)
    .join(' ');
  const parsed = (s) => parseRawAddress(String(s || ''));
  const streetAndUnit = (s) => {
    const firstSeg = String(s || '').split(',')[0].trim();
    let line = parsed(s).line1 || firstSeg;
    // parseRawAddress on a comma-free address treats a leading 5-digit
    // house number as the ZIP and strips it from line1 ("12345 Example
    // Trl" → line1 "Example Trl", zip "12345"). Restore the house number
    // so the bare form compares like-for-like with its ZIP-carrying form —
    // otherwise the same parcel reads as a different street and the
    // duplicate guard is bypassed.
    if (line && !/^\d/.test(line) && /^\d/.test(firstSeg)
      && firstSeg.toLowerCase().endsWith(String(line).toLowerCase())) {
      line = firstSeg;
    }
    // Comma-free NUMBERED ROUTES: the canonical parser splits at the
    // suffix and exiles the route number into city ('123 State Road 64' →
    // line1 '123 State Rd', city '64'). A short pure-number "city" is that
    // route number — re-attach it, it is street, not locality. (A real
    // trailing ZIP lands in .zip, never here; alphabetic cities are
    // untouched. Bare trailing unit numbers shift to the conservative
    // no-match direction, which the duplicate guard tolerates.)
    const parsedCity = String(parsed(s).city || '').trim();
    if (/^\d{1,4}$/.test(parsedCity)) {
      line = `${line} ${parsedCity}`;
    } else if (BARE_DIRECTIONAL_CITY.has(parsedCity.toLowerCase())) {
      // Comma-free POST-DIRECTIONAL streets get the same treatment: the
      // parser exiles the trailing directional into city ('100 53rd Ave E'
      // → line1 '100 53rd Ave', city 'E'). A "city" that IS a bare
      // directional token is that street's suffix — no FL city is named a
      // lone directional — and leaving it out made '100 53rd Ave E' compare
      // unequal to its own comma-carrying form.
      line = `${line} ${parsedCity}`;
    }
    const split = splitStreetLineUnit(line);
    return {
      street: normSegment(split.street),
      unit: unitLineValueKey(split.unit),
    };
  };
  const [aa, bb] = [streetAndUnit(a), streetAndUnit(b)];
  const [na, nb] = [aa.street, bb.street];
  if (!na || !nb || na !== nb) return false;
  // Property credentials are scoped to the exact priced unit: a building-
  // level lookup cannot authenticate an apartment/suite measurement, and a
  // credential for Apt A cannot authenticate Apt B. Duplicate detection uses
  // the default conservative mode below because one missing unit is not proof
  // that two active-service records are different properties.
  // requireNamedUnit is the stronger form, for a caller AUTHENTICATING a
  // unit rather than merely separating two of them: a unit credential needs
  // an actual unit to be scoped TO, and two addresses that both lack a unit
  // ID authenticate nothing — a building-level saved measurement would
  // otherwise compare "exactly equal" to an apartment quote that never
  // stated its unit, because unit-less === unit-less (codex pre-push r20
  // P1). Duplicate detection and re-gather decisions keep the conservative
  // default; only an explicit opt-in gets this.
  if (requireNamedUnit && !(aa.unit && bb.unit)) return false;
  if ((requireExactUnit || requireNamedUnit) && aa.unit !== bb.unit) return false;
  // A known-vs-unknown unit remains a possible duplicate and therefore
  // compares equal conservatively. Only two explicit, different unit IDs are
  // proven separate service addresses.
  if (aa.unit && bb.unit && aa.unit !== bb.unit) return false;
  // Last 5-digit token = ZIP — EXCEPT when it is the address's leading
  // house number ("12345 Tamiami Trl" with no real ZIP): treating the house
  // number as a ZIP made the same parcel compare unequal against its stored
  // ZIP-carrying form, bypassing the duplicate guard. A missing ZIP must
  // compare conservatively equal, per the design note above.
  const zip = (s) => {
    const str = String(s || '').trim();
    const m = str.match(/\b(\d{5})\b(?!.*\b\d{5}\b)/);
    if (!m) return null;
    if (m.index === 0 && !/^\d{5}$/.test(str)) return null;
    return m[1];
  };
  const [za, zb] = [zip(a), zip(b)];
  if (za && zb && za !== zb) return false;
  // Full-city equality, not token overlap — North Port vs Port Charlotte
  // share a token but are different parcels. Parsed cities can carry a
  // formatting-dependent state/ZIP tail ("Bradenton FL 34205" when the last
  // comma is missing) — strip those tokens or the same city compares
  // unequal across formats.
  const cityString = (s) => {
    const raw = String(parsed(s).city || '').trim();
    // A short pure-number "city" is a mis-split route number, and a bare
    // directional "city" is a mis-split post-directional (see the street
    // re-attach above) — never localities; comparing either against the
    // other side's real city would reject the same parcel.
    if (/^\d{1,4}$/.test(raw)) return '';
    if (BARE_DIRECTIONAL_CITY.has(raw.toLowerCase())) return '';
    return normSegment(raw)
      .split(' ')
      .filter(Boolean)
      .filter((t) => t !== 'fl' && t !== 'florida' && !/^\d{5}(\d{4})?$/.test(t))
      .join(' ');
  };
  const [ca, cb] = [cityString(a), cityString(b)];
  if (ca && cb && ca !== cb) return false;
  return true;
}

module.exports = {
  sameStreetAddress,
  addressAddsLocality,
  STREET_TOKEN_ALIASES,
  // Shared so street-key builders (scope-guards burst dedup) cut route
  // spellings identically to how this module compares them.
  canonicalizeRouteTokens,
};
