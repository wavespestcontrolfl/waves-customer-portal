// The property lookup's county-roll house-number audit, as a lead-level
// flag. The address panel already raises a HIGH `address` verify flag when
// the county roll cannot match the typed house number (or the geocoder
// snapped it to a neighbour), but the quote intake never read it: live
// 2026-09-14, a typo'd house number that does not exist on an established
// street became the lead AND the customer address, and the estimate went
// out to it. Both intake stages persist this on the lead's extracted_data
// (public-property-lookup at the authoritative lookup, public-quote at
// calculate), always from a SERVER-trusted profile, never the client's
// `enriched` payload. Only the audit's own numbers ride along — the nearest
// numbers are context for the callback, not corrections. Returns null when
// the roll vouched for the number or never answered (a GIS outage yields
// no audit at all).
function deriveAddressUnverified(enriched, address = null) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  const flag = flags.find((f) => f && f.field === 'address' && f.priority === 'HIGH' && f.reason);
  if (!flag) return null;
  const audit = enriched?.addressAudit && typeof enriched.addressAudit === 'object' ? enriched.addressAudit : {};
  const nearest = Array.isArray(audit.nearestNumbers)
    ? audit.nearestNumbers.map(String).filter(Boolean).slice(0, 5)
    : [];
  return {
    source: 'county_roll',
    reason: String(flag.reason).slice(0, 600),
    county: audit.county || null,
    house_number: audit.houseNumber != null ? String(audit.houseNumber) : null,
    street_exists: typeof audit.streetExists === 'boolean' ? audit.streetExists : null,
    nearest_numbers: nearest,
    // The address the roll judged, so a later address edit on the lead
    // (customer-address fanout, an operator) retires the flag on display
    // without every correction path having to know about it (codex r2 P2).
    address_line1: String(address?.line1 || '').trim() || null,
    city: String(address?.city || '').trim() || null,
    state: String(address?.state || '').trim().toUpperCase().slice(0, 2) || null,
    zip: zip5(address?.zip) || null,
    flagged_at: new Date().toISOString(),
  };
}

const zip5 = (v) => (String(v || '').match(/\d{5}/) || [''])[0];
const lineKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Street line with any inline unit stripped ("1260 Example St Apt 4" →
// "1260 example st"): the audited house number is the same with or
// without the unit, on every comparison (pre-push audit P1).
// …with the street suffix canonicalized (St == Street, Dr == Drive) so a
// spelling difference between the two stages never reads as a different
// premise (pre-push audit P1).
const streetKeyNoUnit = (v) => {
  const { splitStreetLineUnit, normalizeStreetLine } = require('../utils/address-normalizer');
  const text = String(v || '');
  return lineKey(normalizeStreetLine(splitStreetLineUnit(text).street || text));
};
const cityKey = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');

// Same premise: same street line and, where both sides carry one, the same
// ZIP and the same city — the public route accepts a ZIP-less address, and
// a street name that repeats across cities is exactly the audit's own
// warning (codex #4667 r3 P2).
function sameLocality(a, b) {
  const za = zip5(a?.zip);
  const zb = zip5(b?.zip);
  if (za && zb && za !== zb) return false;
  const ca = cityKey(a?.city);
  const cb = cityKey(b?.city);
  if (ca && cb && ca !== cb) return false;
  // State too — the route accepts an explicit state (codex r4 P2).
  const sa = String(a?.state || '').trim().toUpperCase();
  const sb = String(b?.state || '').trim().toUpperCase();
  return !sa || !sb || sa === sb;
}

// A lookup-stage snapshot (leads.extracted_data written by
// public-property-lookup) answers for THIS address only: same street line
// and, where both carry one, the same ZIP. A visitor who changed the
// address between the two stages gets no carried-over flag.
function snapshotCoversAddress(snapshot, address) {
  const prior = snapshot?.address;
  if (!prior || typeof prior !== 'object' || !address) return false;
  if (!streetKeyNoUnit(prior.line1) || streetKeyNoUnit(prior.line1) !== streetKeyNoUnit(address.line1)) return false;
  return sameLocality(prior, address);
}

// The persisted flag off a lead snapshot, shape-checked: the only source a
// later stage may recover from. Never the snapshot's `enriched` — after a
// /calculate that is the client's own submission.
function recoverAddressUnverified(snapshot) {
  const flag = snapshot?.address_unverified;
  if (!flag || typeof flag !== 'object' || flag.source !== 'county_roll' || typeof flag.reason !== 'string' || !flag.reason) return null;
  return {
    source: 'county_roll',
    reason: flag.reason.slice(0, 600),
    county: typeof flag.county === 'string' ? flag.county.slice(0, 40) : null,
    house_number: flag.house_number != null ? String(flag.house_number).slice(0, 12) : null,
    street_exists: typeof flag.street_exists === 'boolean' ? flag.street_exists : null,
    nearest_numbers: Array.isArray(flag.nearest_numbers) ? flag.nearest_numbers.map(String).filter(Boolean).slice(0, 5) : [],
    address_line1: typeof flag.address_line1 === 'string' ? flag.address_line1.slice(0, 120) : null,
    city: typeof flag.city === 'string' ? flag.city.slice(0, 60) : null,
    state: typeof flag.state === 'string' ? flag.state.trim().toUpperCase().slice(0, 2) || null : null,
    zip: zip5(flag.zip) || null,
    flagged_at: typeof flag.flagged_at === 'string' ? flag.flagged_at : new Date().toISOString(),
  };
}

// Does a stored flag describe THIS address? Judged on the flag's own
// stamped street/locality — never the snapshot's `address`, which a
// prefill attach or a later stage has already overwritten with the new
// address (pre-push audit P1). An older flag with no stamp is trusted for
// the snapshot's address by the caller's snapshot check.
function flagCoversAddress(flag, address) {
  if (!flag || typeof flag !== 'object' || !address) return false;
  if (!flag.address_line1) return true;
  if (streetKeyNoUnit(flag.address_line1) !== streetKeyNoUnit(address.line1)) return false;
  return sameLocality(flag, address);
}

// Two DISPLAY addresses ("<street line>, <City>, FL <zip>") name the same
// premise: same street line with any unit stripped, same locality where
// both carry one. A unit added on a repeat run is the same audited house
// number (pre-push audit P1). Either side missing a street → false.
// `requireLocality`: BOTH sides must carry a city and a ZIP and they must
// agree — the cross-lead publication withdrawal uses this stricter form,
// so a street-only submission can never match a published estimate for
// that street in some other town (pre-push audit P1).
function samePremiseDisplay(a, b, { requireLocality = false } = {}) {
  // The normalizer may emit the unit as its OWN comma segment ("…St, Apt
  // 4, Parrish, FL 34219"): the city is the first later segment that is
  // neither a unit line nor the "FL 34219" tail (pre-push audit P1).
  const UNIT_SEGMENT = /^(?:#|apt|apartment|unit|ste|suite|bldg|building|lot|rm|room|fl|floor|spc|space)\b/i;
  const STATE_ZIP_SEGMENT = /^[a-z]{2}\s*\d{5}(?:-\d{4})?$/i;
  const parse = (text) => {
    const parts = String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
    const street = parts[0] || '';
    const city = parts.slice(1).find((part) => !UNIT_SEGMENT.test(part) && !STATE_ZIP_SEGMENT.test(part)) || '';
    // ZIP from the state/ZIP (or bare ZIP) segment only — the first five
    // digits of the whole string may be a five-digit house number
    // (pre-push audit P1).
    const tail = parts.slice(1).find((part) => STATE_ZIP_SEGMENT.test(part) || /^\d{5}(?:-\d{4})?$/.test(part)) || '';
    return { street: streetKeyNoUnit(street), city, zip: zip5(tail) };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x.street || x.street !== y.street) return false;
  if (requireLocality && (!cityKey(x.city) || !cityKey(y.city) || !x.zip || !y.zip)) return false;
  return sameLocality(x, y);
}

// Did the county roll ANSWER on this profile? The audit object is present
// whenever the roll replied (match or not); a GIS outage yields no audit
// at all (auditAddressHouseNumber). Only an answer may clear a prior flag.
// A county-backed record whose house number agreed with the typed one
// skips the audit (property-lookup-v2 runs it only when county evidence is
// missing or the record's number disagrees) — that is a vouch, not an
// outage, and must clear a prior flag (pre-push audit P1). The profile
// says which via addressVerdict; older cached profiles fall back to the
// audit object alone.
function countyRollAnswered(enriched) {
  if (!enriched || typeof enriched !== 'object') return false;
  if (enriched.addressAudit && typeof enriched.addressAudit === 'object') return true;
  return enriched.addressVerdict === 'audited' || enriched.addressVerdict === 'county_record';
}

// The flag this run should persist: a fresh verdict when the roll answered,
// else the prior server-written flag for the same address. A transient
// outage on a recalculation must not erase an authoritative earlier
// warning and mint a self-book link for a still-unverified address
// (codex #4667 r5 P1). `prior` is already address-matched by the caller.
function nextAddressUnverified({ enriched = null, profileFound = false, prior = null } = {}) {
  const derived = profileFound ? deriveAddressUnverified(enriched) : null;
  if (derived) return derived;
  if (profileFound && countyRollAnswered(enriched)) return null;
  return prior || null;
}

// The server-owned verdict each intake stage records for the address it
// judged: 'flagged' (a flag stands — fresh or carried), 'clean' (the roll
// answered and vouched), 'unanswered' (no county signal). A CLEAN verdict
// is what supersedes older lead, draft and withdrawn-publication
// warnings for the same premise — record-less clean lookups are never
// cached, so without it the next /calculate would treat the cache miss as
// missing evidence and recover a stale flag (pre-push audit P1).
function buildAddressVerdict({ flag = null, enriched = null, profileFound = false, address = null } = {}) {
  const status = flag ? 'flagged' : (profileFound && countyRollAnswered(enriched) ? 'clean' : 'unanswered');
  return {
    status,
    address_line1: String(address?.line1 || '').trim() || null,
    city: String(address?.city || '').trim() || null,
    state: String(address?.state || '').trim().toUpperCase().slice(0, 2) || null,
    zip: zip5(address?.zip) || null,
    at: new Date().toISOString(),
  };
}

// Does a snapshot's stored verdict say THIS premise is clean?
function cleanVerdictCovers(snapshot, address) {
  const verdict = snapshot?.address_verdict;
  if (!verdict || typeof verdict !== 'object' || verdict.status !== 'clean' || !verdict.address_line1) return false;
  return flagCoversAddress({ ...verdict, reason: 'clean' }, address);
}

module.exports = { deriveAddressUnverified, snapshotCoversAddress, recoverAddressUnverified, countyRollAnswered, nextAddressUnverified, flagCoversAddress, samePremiseDisplay, buildAddressVerdict, cleanVerdictCovers };
