/**
 * Customer-facing "Property" text for emails and notices.
 *
 * customers.profile_label is an internal nickname ("Primary", "Rental",
 * "Additional property"), not something a customer reads as an address. 1,483
 * customers carry the generic "Primary", and appointment emails that led with
 * the label showed "Property: Primary" instead of where the visit is. The
 * street address always wins; the nickname is only a fallback when no street
 * address exists.
 */

function clean(value) {
  return String(value || '').trim();
}

// "123 Main St Apt 4, Bradenton, FL 34205" — null when there is no street line.
function propertyStreetAddress(row = {}) {
  const line1 = clean(row.address_line1);
  if (!line1) return null;
  const street = [line1, clean(row.address_line2)].filter(Boolean).join(' ');
  return [street, cityStateZip(row)].filter(Boolean).join(', ');
}

// "123 Main St Apt 4" — the street line alone (subjects and headings that name
// a property without the city/state/zip). null when there is no street line.
function propertyStreetLine(row = {}) {
  const line1 = clean(row.address_line1);
  if (!line1) return null;
  return [line1, clean(row.address_line2)].filter(Boolean).join(' ');
}

function cityStateZip(row = {}) {
  const stateZip = [clean(row.state), clean(row.zip)].filter(Boolean).join(' ');
  return [clean(row.city), stateZip].filter(Boolean).join(', ');
}

// Street address first; then whatever city/state/zip exists; then the
// nickname (profile_label, or a saved property's `label`); then a generic
// word. A row with a city but no street must not fall back to "Primary".
function propertyDisplayLabel(row = {}) {
  return propertyStreetAddress(row)
    || cityStateZip(row)
    || clean(row.profile_label)
    || clean(row.label)
    || 'Service property';
}

module.exports = { propertyStreetAddress, propertyStreetLine, propertyDisplayLabel };
