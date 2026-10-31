// Build a single-line display address from address parts, dropping any empty
// piece so a missing zip never renders as "Sarasota, FL null" and a missing
// city never leaves a dangling comma ("123 Main St, , FL 34231"). State + zip
// stay glued together ("FL 34231"); everything else is comma-joined.
//
// Mirrors server/utils/address-normalizer.js#formatAddress (separate bundle, so
// the 6-line helper is intentionally duplicated rather than shared).
export function formatAddress(parts = {}) {
  const clean = (value) => (value == null ? '' : String(value).trim());
  const region = [clean(parts.state), clean(parts.zip)].filter(Boolean).join(' ');
  return [clean(parts.line1), clean(parts.line2), clean(parts.city), region]
    .filter(Boolean)
    .join(', ');
}

// A trailing ZIP (not a 5-digit unit such as "Apt 12345") or state means the
// line already names its locality; a country after it does not count.
const COUNTRY_TAIL = /,?\s*(?:USA|U\.S\.A\.?|United States(?: of America)?)\s*$/i;
const ZIP_TAIL = /(?:^|[\s,])((?:apt|apartment|unit|ste|suite|lot|bldg|building|rm|room)\s*|#\s*)?\d{5}(?:-\d{4})?\s*$/i;
const STATE_TAIL = /\b(?:FL|Florida)\s*$/i;
function endsInLocality(line) {
  const text = line.replace(COUNTRY_TAIL, '');
  const zip = ZIP_TAIL.exec(text);
  return (zip && !zip[1]) || STATE_TAIL.test(text);
}

// A lead's service address in the shape a customer's has ("street, city, FL
// ZIP"), for the estimate tool and its property lookup: with the street line
// alone the geocoder guesses the city and the county-roll check cannot scope
// to the ZIP. Leads keep city and zip in their own columns and have no state
// column (every lead is in Florida). A web-form lead already holds the whole
// one-line address in `address`, so a line that ends in a ZIP or the state is
// returned as it is.
export function leadServiceAddress(lead) {
  const clean = (value) => (value == null ? '' : String(value).trim());
  const line = clean(lead?.address);
  const city = clean(lead?.city);
  const zip = clean(lead?.zip);
  if (!line || endsInLocality(line) || (!city && !zip)) return line;
  const lastSegment = line.split(',').pop().trim().toLowerCase();
  return formatAddress({ line1: line, city: lastSegment === city.toLowerCase() ? '' : city, state: 'FL', zip });
}

export default formatAddress;
