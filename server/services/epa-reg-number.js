'use strict';

// One rule for "this product has a real EPA registration number". The catalog stores the placeholders "N/A", "None",
// "Not EPA" and "Not EPA-registered fertilizer" for products that carry no registration; none of them is a number.
// Shared by the inventory label-readiness check (routes/admin-inventory.js) and the Bid kit Product List
// (services/bid-kit-product-list.js), so the two never disagree about which products are registered pesticides.
function validEpaRegNumber(value) {
  const text = String(value || '').trim();
  return !!text && !/^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(text);
}

module.exports = { validEpaRegNumber };
