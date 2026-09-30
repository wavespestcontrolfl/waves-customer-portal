/**
 * purchase-receipts/product-matcher.js — resolves a purchase line title (an
 * Amazon item, a SiteOne invoice line) to exactly one active catalog product,
 * or declines to guess.
 *
 * Order:
 *   1. Exact alias match (case/space-insensitive) against product_aliases,
 *      active product only.
 *   2. Catalog name contained in the title as whole words, with exactly one
 *      active hit (e.g. "Taurus SC" inside "Control Solutions Taurus SC
 *      Termiticide 78 oz").
 *   3. Otherwise unmatched — including when either step finds 2+ candidates
 *      (ambiguous). A personal/non-chemical item (Chromebook, shampoo,
 *      brass fittings) is expected to land here every time.
 *
 * Retired duplicate catalog rows (active=false) are never matched, whether
 * the hit would have come from their own name or an alias pointing at them.
 */
const db = require('../../models/db');

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every word of `needleNorm` must appear in `haystackNorm`, in order, as
// whole words — never as a substring of a longer word ("SC" must not match
// "SCatter").
function containsWholeWords(haystackNorm, needleNorm) {
  if (!needleNorm) return false;
  const words = needleNorm.split(' ').map(escapeRegExp);
  const pattern = new RegExp(`(?:^|\\s)${words.join('\\s+')}(?:\\s|$)`);
  return pattern.test(haystackNorm);
}

// Everything the matcher reads: active products, and each alias joined to
// its (active) product row. Split from the match itself so the read-only
// replay (ops/agents/inventory-agent-replay.js) can match against the
// catalog plus the changes it has proposed so far, with the same rules.
async function loadMatchCatalog(conn = db) {
  const aliasRows = await conn('product_aliases as pa')
    .join('products_catalog as pc', 'pc.id', 'pa.product_id')
    .where('pc.active', true)
    .select('pa.alias_name', 'pc.*');
  const products = await conn('products_catalog').where({ active: true }).select('*');
  return { aliasRows, products };
}

function matchTitleInCatalog(title, { aliasRows, products }) {
  const normTitle = normalizeForMatch(title);
  if (!normTitle) return { matched: false, reason: 'empty_title' };

  const aliasHits = aliasRows.filter((row) => normalizeForMatch(row.alias_name) === normTitle);
  const aliasProductIds = [...new Set(aliasHits.map((row) => row.id))];
  if (aliasProductIds.length === 1) return { matched: true, product: aliasHits[0], matchType: 'alias' };
  if (aliasProductIds.length > 1) return { matched: false, reason: 'ambiguous', matchType: 'alias', candidates: aliasProductIds };

  const containmentHits = products.filter((product) => containsWholeWords(normTitle, normalizeForMatch(product.name)));
  if (containmentHits.length === 1) return { matched: true, product: containmentHits[0], matchType: 'containment' };
  if (containmentHits.length > 1) {
    return { matched: false, reason: 'ambiguous', matchType: 'containment', candidates: containmentHits.map((p) => p.id) };
  }

  return { matched: false, reason: 'unmatched' };
}

async function matchTitleToProduct(title, conn = db) {
  if (!normalizeForMatch(title)) return { matched: false, reason: 'empty_title' };
  return matchTitleInCatalog(title, await loadMatchCatalog(conn));
}

module.exports = { matchTitleToProduct, matchTitleInCatalog, loadMatchCatalog, normalizeForMatch, containsWholeWords };
