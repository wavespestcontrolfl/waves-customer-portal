'use strict';

// Products the label bars from home lawns, checked by the lawn plan and the lawn closeout.
//
// Oxadiazon (Ronstar G, EPA 432-886, and the LESCO Ronstar fertilizer combos such as the 20-1-20)
// reads "Not for Use in Turfgrass on Residential Properties" / "Not for use on home lawns". It
// stays legal for landscape beds and ornamentals, so this is a LAWN rule, not a catalog-wide limit
// row: a product_limits row would also block it on a Tree & Shrub visit. Matching is by name and
// active ingredient, so a catalog row added later is covered without a migration.
//
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
function lawnProhibitedProductBlock(product) {
  if (!isProhibitedOnHomeLawns(product)) return null;
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
async function lawnProhibitedProductBlocks(database, submittedProducts = []) {
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

// The 400 body a fresh lawn closeout returns for those blocks.
function lawnProhibitedProductsBlockPayload(blocks) {
  return {
    error: 'A product on this lawn visit is not for home lawns',
    code: CODE,
    details: blocks.map((block) => block.message),
    blocks,
  };
}

module.exports = { lawnProhibitedProductsBlockPayload, CODE, isProhibitedOnHomeLawns, lawnProhibitedProductBlock, lawnProhibitedProductBlocks };
