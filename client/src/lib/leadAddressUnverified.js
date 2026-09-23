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
  // The flag names the address the roll judged; once the lead's address
  // moved on (a correction fanout, an operator edit), the ask is stale and
  // must not send staff to reconfirm a replaced address. An older flag
  // with no stamped address still shows.
  if (flag.address_line1 && !flagCoversLeadAddress(flag, lead)) return null;
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

const lineKey = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const zip5 = (v) => (String(v || '').match(/\d{5}/) || [''])[0];

function flagCoversLeadAddress(flag, lead) {
  const leadLine = lineKey(String(lead?.address || '').split(',')[0]);
  if (!leadLine || leadLine !== lineKey(flag.address_line1)) return false;
  const a = zip5(flag.zip);
  const b = zip5(lead?.zip) || zip5(lead?.address);
  return !a || !b || a === b;
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
