'use strict';

// Products the label bars from home lawns, checked by the lawn plan and the lawn closeout.
//
// Oxadiazon (Ronstar G, EPA 432-886, and the LESCO Ronstar fertilizer combos such as the 20-1-20)
// reads "Not for Use in Turfgrass on Residential Properties" / "Not for use on home lawns". It
// stays legal for landscape beds and ornamentals, so this is a LAWN rule, not a catalog-wide limit
// row: a product_limits row would also block it on a Tree & Shrub visit. Matching is by name and
// active ingredient, so a catalog row added later is covered without a migration.
//
// Residential only: the label bars home lawns, not commercial turf (Ronstar G is registered for
// commercial turf and landscapes). A customer whose property_type is commercial or business is not
// blocked; residential, an unknown type and no type are (the safe side).
// Turf use, not pricing: the pricing classifier (commercial-helpers.js) calls HOA and multifamily common
// areas and apartments "commercial", but people live on that turf and the label bars residential
// properties. So a type is commercial here only when the pricing classifier says so AND the stored type
// names nothing residential. "office", "warehouse", "medical_office", "retail", "commercial", "business"
// pass; "hoa_common_area_residential", "multifamily_common_area_residential", "residential_hoa",
// "residential_common_area", "apartment", blank and unknown types do not (the safe side).
const RESIDENTIAL_TURF = /resident|hoa|multi[\s_-]?family|apartment|condo|town\s?home|townhouse|duplex|common[\s_-]?area|single[\s_-]?family|\bhome\b/i;
const isCommercialProperty = (propertyType) => {
  const type = String(propertyType || '');
  if (!type.trim() || RESIDENTIAL_TURF.test(type)) return false;
  return require('./pricing-engine/commercial-helpers').isCommercialProperty({ propertyType });
};

// The yearly count caps, intervals and blackouts live in product_limits (application-limits.js);
// this module only answers "may this product be on a lawn visit at all".

const OXADIAZON = /\b(ronstar|oxadiazon)\b/i;

const CODE = 'lawn_product_not_for_home_lawns';

function isProhibitedOnHomeLawns(product) {
  if (!product || typeof product !== 'object') return false;
  return [product.name, product.display_name, product.common_name, product.active_ingredient, product.productName]
    .some((value) => OXADIAZON.test(String(value || '')));
}

// null when the product is allowed, else the block the plan and the closeout show.
// `propertyType` is the customer's property_type; commercial turf is allowed.
function lawnProhibitedProductBlock(product, { propertyType } = {}) {
  if (!isProhibitedOnHomeLawns(product) || isCommercialProperty(propertyType)) return null;
  const name = product.name || product.display_name || product.productName || 'This product';
  return {
    code: CODE,
    type: CODE,
    severity: 'block',
    productName: name,
    message: `${name} contains oxadiazon. The label says it is not for use on home lawns. Do not use it on a lawn visit.`,
  };
}

// The closeout side: the submitted products (catalog ids, and any free-text name) against the
// catalog. Returns the blocks, [] when none.
async function lawnProhibitedProductBlocks(database, submittedProducts = [], { propertyType } = {}) {
  if (isCommercialProperty(propertyType)) return [];
  const list = Array.isArray(submittedProducts) ? submittedProducts : [];
  const blocks = [];
  const seen = new Set();
  const push = (block) => { if (block && !seen.has(block.productName)) { seen.add(block.productName); blocks.push(block); } };
  for (const submitted of list) push(lawnProhibitedProductBlock({ productName: submitted?.productName || submitted?.name }));
  const ids = [...new Set(list.map((entry) => entry?.productId).filter(Boolean))];
  if (ids.length) {
    const rows = await database('products_catalog').whereIn('id', ids).select('id', 'name', 'display_name', 'active_ingredient');
    for (const row of rows) push(lawnProhibitedProductBlock(row));
  }
  return blocks;
}

// The property type of the TREATED property. A visit with a linked customer_properties row is judged on THAT
// row alone (a customer can own a home and a commercial lot): its type when it has one; a missing row, or a
// row with no type, or a failed read, fails closed ('residential': Ronstar stays blocked; a failed read is
// logged). The customer's own property_type (`fallback`, already on the visit's row, or read by `customerId`)
// answers ONLY for a visit with no linked property. undefined when nothing says: the caller treats it as
// residential too.
const FAILED_READ_TYPE = 'residential';
async function treatedPropertyType(database, { propertyId, customerId, fallback } = {}) {
  const { savepointRead } = require('../utils/savepoint-read');
  const failed = (table, err) => {
    require('./logger').warn(`[lawn-prohibited-products] ${table} property type read failed (treated as residential): ${err.message}`);
    return FAILED_READ_TYPE;
  };
  if (propertyId) {
    try {
      const property = await savepointRead(database, (k) => k('customer_properties').where({ id: propertyId }).first('property_type'));
      return String(property?.property_type || '').trim() ? property.property_type : FAILED_READ_TYPE;
    } catch (err) { return failed('customer_properties', err); }
  }
  if (fallback !== undefined) return fallback;
  if (!customerId) return undefined;
  try {
    return (await savepointRead(database, (k) => k('customers').where({ id: customerId }).first('property_type')))?.property_type;
  } catch (err) { return failed('customers', err); }
}

// The 400 body a fresh lawn closeout returns for those blocks.
function lawnProhibitedProductsBlockPayload(blocks) {
  return {
    error: 'A product on this lawn visit is not for home lawns',
    code: CODE,
    details: blocks.map((block) => block.message),
    blocks,
  };
}

// The lawn closeout's check, in one place: only while GATE_LAWN_V13 is live (read at call time, like the
// plan-side check; gate off is the pre-v13 closeout, byte for byte), for a lawn visit that lists products.
// Returns the blocks to refuse the closeout with, [] when the closeout may go on.
async function lawnCloseoutProhibitedBlocks(database, svc, products) {
  if (require('../config/feature-gates').lawnV13Live?.() !== true) return [];
  if (!Array.isArray(products) || !products.length) return [];
  const propertyType = await treatedPropertyType(database, { propertyId: svc.property_id, customerId: svc.customer_id, fallback: svc.property_type });
  return lawnProhibitedProductBlocks(database, products, { propertyType });
}

module.exports = { lawnCloseoutProhibitedBlocks, treatedPropertyType, isCommercialProperty, lawnProhibitedProductsBlockPayload, CODE, isProhibitedOnHomeLawns, lawnProhibitedProductBlock, lawnProhibitedProductBlocks };
