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
    zip: zip5(address?.zip) || null,
    flagged_at: new Date().toISOString(),
  };
}

const zip5 = (v) => (String(v || '').match(/\d{5}/) || [''])[0];
const lineKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
  return !ca || !cb || ca === cb;
}

// A lookup-stage snapshot (leads.extracted_data written by
// public-property-lookup) answers for THIS address only: same street line
// and, where both carry one, the same ZIP. A visitor who changed the
// address between the two stages gets no carried-over flag.
function snapshotCoversAddress(snapshot, address) {
  const prior = snapshot?.address;
  if (!prior || typeof prior !== 'object' || !address) return false;
  if (!lineKey(prior.line1) || lineKey(prior.line1) !== lineKey(address.line1)) return false;
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
    zip: zip5(flag.zip) || null,
    flagged_at: typeof flag.flagged_at === 'string' ? flag.flagged_at : new Date().toISOString(),
  };
}

module.exports = { deriveAddressUnverified, snapshotCoversAddress, recoverAddressUnverified };
