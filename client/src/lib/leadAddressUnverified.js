// The quote intake's county-roll house-number flag (server/routes/public-quote
// deriveAddressUnverified), read off a lead row for the lead card. The lead's
// extracted_data arrives as jsonb or a JSON string depending on the endpoint.
export function leadAddressUnverified(lead) {
  let data = lead?.extracted_data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const flag = data?.address_unverified;
  if (!flag || typeof flag !== 'object' || !flag.reason) return null;
  const nearest = Array.isArray(flag.nearest_numbers)
    ? flag.nearest_numbers.map(String).filter(Boolean)
    : [];
  return {
    reason: String(flag.reason),
    county: flag.county || null,
    houseNumber: flag.house_number || null,
    nearestNumbers: nearest,
  };
}

// One line for the card: the audit's OWN reason (a missing number, a number
// the roll lists only in another ZIP, or a geocoder snap to a neighbour are
// different asks — paraphrasing them into "no such number" would mislead
// the callback), followed by what to do about it.
export function leadAddressUnverifiedNotice(lead) {
  const flag = leadAddressUnverified(lead);
  if (!flag) return null;
  const reason = flag.reason.trim().replace(/\s+/g, ' ');
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return `Address unverified — ${sentence} Confirm the address on the callback before sending an estimate.`;
}
