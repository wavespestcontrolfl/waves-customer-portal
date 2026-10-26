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
 * GATE_PRODUCT_INTAKE_GUARD (dark): step 2 declines a lone containment hit when the
 * title carries a product-line word the product's own name lacks ("Dismiss NXT" vs
 * "Dismiss"). It only ever removes a match; alias matches are never guarded.
 *
 * Retired duplicate catalog rows (active=false) are never matched, whether
 * the hit would have come from their own name or an alias pointing at them.
 */
const db = require('../../models/db');
const { productIntakeGuardLive } = require('../../config/feature-gates');

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
// Each alias joined to its ACTIVE product row.
async function loadActiveAliasRows(conn = db) {
  return conn('product_aliases as pa')
    .join('products_catalog as pc', 'pc.id', 'pa.product_id')
    .where('pc.active', true)
    .select('pa.alias_name', 'pc.*');
}

async function loadMatchCatalog(conn = db) {
  const aliasRows = await loadActiveAliasRows(conn);
  const products = await conn('products_catalog').where({ active: true }).select('*');
  return { aliasRows, products };
}

// The active products an alias names exactly (case/space/punctuation-
// insensitive), one row per product. The one alias rule, shared by the
// purchase matcher below and the tech Intelligence Bar's product lookup.
function activeProductsForAlias(title, aliasRows) {
  const normTitle = normalizeForMatch(title);
  if (!normTitle) return [];
  const byId = new Map();
  for (const row of aliasRows || []) {
    if (normalizeForMatch(row.alias_name) === normTitle && !byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

// Product-line words and formulation codes that make a product a DIFFERENT product when a title carries them and the
// catalog name does not ("Dismiss NXT" is not "Dismiss"; "Gentrol Complete EC3" is not "Gentrol"). Reviewed by hand; add a
// word here only when it names a product line or formulation. Generic descriptors (liquid, concentrate, granular, broad,
// spectrum, bait, spray, insecticide ...) are never listed: nearly every title has them.
const VARIANT_WORDS = new Set([
  'complete', 'plus', 'pro', 'max', 'maxx', 'xtra', 'extra', 'ultra', 'select', 'magnum', 'nxt',
  'duo', 'trio', 'he', 'xt', 'xts', 'xp', 'xl', 'gold', 'advanced', 'elite', 'prime', 'forte', 'evolution',
  'ii', 'iii', 'iv', 'ec', 'ec3', 'sc', 'cs', 'g', 'gr', 'wg',
  'wdg', 'wsg', 'wp', 'sl', 'ew', 'me', 'fc', 'pt', 'df', 'dg', 'rtu', 'aerosol', 'dust', 'foam',
]);

// The title words (normalized) that are variant words, are not among the product's own name words, and do not directly
// follow a number token (a word right after a number is a unit or a size: "30 g", "4 x 30 g"). Unique, in title order. Pure.
function variantWordsMissingFromName(titleNorm, nameWords) {
  const own = new Set(nameWords || []);
  const words = String(titleNorm || '').split(' ').filter(Boolean);
  const found = [];
  words.forEach((word, index) => {
    if (!VARIANT_WORDS.has(word) || own.has(word) || found.includes(word)) return;
    if (index > 0 && /^\d+$/.test(words[index - 1])) return;
    found.push(word);
  });
  return found;
}

function matchTitleInCatalog(title, { aliasRows, products }) {
  const normTitle = normalizeForMatch(title);
  if (!normTitle) return { matched: false, reason: 'empty_title' };

  const aliasProducts = activeProductsForAlias(title, aliasRows);
  if (aliasProducts.length === 1) return { matched: true, product: aliasProducts[0], matchType: 'alias' };
  if (aliasProducts.length > 1) return { matched: false, reason: 'ambiguous', matchType: 'alias', candidates: aliasProducts.map((row) => row.id) };

  const containmentHits = products.filter((product) => containsWholeWords(normTitle, normalizeForMatch(product.name)));
  if (containmentHits.length === 1) {
    if (productIntakeGuardLive()) {
      const variantWords = variantWordsMissingFromName(normTitle, normalizeForMatch(containmentHits[0].name).split(' '));
      if (variantWords.length) {
        return { matched: false, reason: 'variant_word', matchType: 'containment', candidates: [containmentHits[0].id], variantWords };
      }
    }
    return { matched: true, product: containmentHits[0], matchType: 'containment' };
  }
  if (containmentHits.length > 1) {
    return { matched: false, reason: 'ambiguous', matchType: 'containment', candidates: containmentHits.map((p) => p.id) };
  }

  return { matched: false, reason: 'unmatched' };
}

async function matchTitleToProduct(title, conn = db) {
  if (!normalizeForMatch(title)) return { matched: false, reason: 'empty_title' };
  return matchTitleInCatalog(title, await loadMatchCatalog(conn));
}

module.exports = { matchTitleToProduct, matchTitleInCatalog, loadMatchCatalog, loadActiveAliasRows, activeProductsForAlias, normalizeForMatch, containsWholeWords, VARIANT_WORDS, variantWordsMissingFromName };
