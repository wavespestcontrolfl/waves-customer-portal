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
  return [clean(parts.line1), clean(parts.city), region].filter(Boolean).join(', ');
}

export default formatAddress;
