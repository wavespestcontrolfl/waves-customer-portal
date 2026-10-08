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
const COMMERCIAL_PROPERTY = /^(commercial|business)$/i;
const isCommercialProperty = (propertyType) => COMMERCIAL_PROPERTY.test(String(propertyType || '').trim());

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

// The property type of the TREATED property: the visit's linked customer_properties row when the
// visit has one and the row says (a customer can own a home and a commercial lot), else the
// customer's own property_type (`fallback`, already on the visit's row, or read by `customerId`).
// undefined when nothing says (no row, no type): an ABSENT answer, the caller treats it as residential.
// A FAILED read is not an absent one: the linked property may be the residential one while the customer's
// own type is commercial, so a failed read fails closed ('residential': Ronstar stays blocked) and is logged.
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
      if (property?.property_type) return property.property_type;
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
