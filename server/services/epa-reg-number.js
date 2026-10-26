'use strict';

// One rule for "this product has a real EPA registration number". The catalog stores the placeholders "N/A", "None",
// "Not EPA" and "Not EPA-registered fertilizer" for products that carry no registration; none of them is a number.
// Shared by the inventory label-readiness check (routes/admin-inventory.js), the Bid kit Product List
// (services/bid-kit-product-list.js) and the inventory agent's new-product intake (purchase-receipts/inventory-agent.js), so they
// never disagree about which products are registered pesticides.
function validEpaRegNumber(value) {
  const text = String(value || '').trim();
  return !!text && !/^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(text);
}

// A category that must carry an EPA registration number (a row here with the "N/A" placeholder makes the list incomplete).
// Adjuvants are left out on purpose: they carry no registration.
const PESTICIDE_CATEGORIES = new Set([
  'insecticide', 'herbicide', 'fungicide', 'termiticide', 'rodenticide', 'miticide', 'nematicide', 'pgr', 'igr',
  'bait', 'mole bait', 'termite bait', 'mosquito',
]);
// A category NAMING a pesticide class also counts: the catalog has compound names ("termiticide / insecticide") and a growth
// regulator can be filed as "insect growth regulator" or "plant growth regulator". "termite monitoring" names none of them.
const PESTICIDE_CATEGORY_WORDS = /\b(insecticide|herbicide|fungicide|termiticide|rodenticide|miticide|nematicide|larvicide|pgr|igr|growth regulator|bait|mosquito)\b/;
const isPesticideCategory = (category) => {
  const name = String(category || '').trim().toLowerCase();
  return PESTICIDE_CATEGORIES.has(name) || PESTICIDE_CATEGORY_WORDS.test(name);
};

module.exports = { validEpaRegNumber, PESTICIDE_CATEGORIES, PESTICIDE_CATEGORY_WORDS, isPesticideCategory };
