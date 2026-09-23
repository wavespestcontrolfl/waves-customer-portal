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

const cityKey = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
// Street line with a trailing inline unit stripped ("1260 Example St Apt
// 4" → "1260 example st"), mirroring the server's unit-insensitive
// comparison: the audited house number is the same with or without it.
// A named designator may carry a '#' before its value ("Apt #4").
const UNIT_TAIL = /\s+(?:#|(?:apt|apartment|unit|ste|suite|bldg|building|lot|rm|room|fl|floor|spc|space)\.?\s*#?)\s*[a-z0-9-]+\s*$/i;
// Suffix aliases mirror the server's canonical forms (St == Street).
const SUFFIX_ALIASES = {
  street: 'st', avenue: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', boulevard: 'blvd',
  circle: 'cir', place: 'pl', terrace: 'ter', trail: 'trl', parkway: 'pkwy', highway: 'hwy', way: 'way',
};
const streetKeyNoUnit = (v) => lineKey(String(v || '').replace(UNIT_TAIL, ''))
  .split(' ')
  .map((token) => SUFFIX_ALIASES[token] || token)
  .join(' ');

function flagCoversLeadAddress(flag, lead) {
  const leadLine = streetKeyNoUnit(String(lead?.address || '').split(',')[0]);
  if (!leadLine || leadLine !== streetKeyNoUnit(flag.address_line1)) return false;
  // ZIP from the lead's zip column, else from the composed address's
  // state/ZIP tail — never the first five digits of the whole string,
  // which may be a five-digit house number.
  const a = zip5(flag.zip);
  const b = zip5(lead?.zip) || zip5(String(lead?.address || '').split(',').map((s) => s.trim()).find((seg) => /^[a-z]{2}\s*\d{5}(?:-\d{4})?$/i.test(seg) || /^\d{5}(?:-\d{4})?$/.test(seg)) || '');
  if (a && b && a !== b) return false;
  // City too (a ZIP-less lead can change city alone): the lead's city
  // column, else the second comma segment of its composed address.
  const leadCity = cityKey(lead?.city) || cityKey(String(lead?.address || '').split(',')[1]);
  const flagCity = cityKey(flag.city);
  return !flagCity || !leadCity || flagCity === leadCity;
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
