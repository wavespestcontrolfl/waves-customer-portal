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
function deriveAddressUnverified(enriched) {
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
    flagged_at: new Date().toISOString(),
  };
}

const zip5 = (v) => (String(v || '').match(/\d{5}/) || [''])[0];
const lineKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A lookup-stage snapshot (leads.extracted_data written by
// public-property-lookup) answers for THIS address only: same street line
// and, where both carry one, the same ZIP. A visitor who changed the
// address between the two stages gets no carried-over flag.
function snapshotCoversAddress(snapshot, address) {
  const prior = snapshot?.address;
  if (!prior || typeof prior !== 'object' || !address) return false;
  if (!lineKey(prior.line1) || lineKey(prior.line1) !== lineKey(address.line1)) return false;
  const a = zip5(prior.zip);
  const b = zip5(address.zip);
  return !a || !b || a === b;
}

module.exports = { deriveAddressUnverified, snapshotCoversAddress };
