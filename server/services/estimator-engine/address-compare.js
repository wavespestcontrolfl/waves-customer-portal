/**
 * Estimator Engine — address comparison helpers, shared by the orchestrator
 * (re-gather decisions) and the draft builder (multi-property duplicate
 * guard). False negatives are cheap (an extra re-lookup / an extra draft the
 * operator dedupes); a false positive prices or suppresses the wrong parcel.
 */

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
function sameStreetAddress(a, b) {
  const normSegment = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_TOKEN_ALIASES[t] || t)
    .join(' ');
  const first = (s) => normSegment(String(s || '').split(',')[0]);
  const [na, nb] = [first(a), first(b)];
  if (!na || !nb || na !== nb) return false;
  const zip = (s) => (String(s || '').match(/\b(\d{5})\b(?!.*\b\d{5}\b)/) || [])[1] || null;
  const [za, zb] = [zip(a), zip(b)];
  if (za && zb && za !== zb) return false;
  // Full-city equality, not token overlap — North Port vs Port Charlotte
  // share a token but are different parcels.
  const cityString = (s) => normSegment(String(s || '').split(',').slice(1).join(' '))
    .split(' ')
    .filter((t) => t && t !== 'fl' && t !== 'florida' && !/^\d+$/.test(t))
    .join(' ');
  const [ca, cb] = [cityString(a), cityString(b)];
  if (ca && cb && ca !== cb) return false;
  return true;
}

module.exports = { sameStreetAddress, addressAddsLocality };
