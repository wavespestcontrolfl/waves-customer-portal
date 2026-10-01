/**
 * Tree & Shrub protocol month -> suggested products, for the T&S Fast
 * Complete sheet (GET /:serviceId/tree-shrub/fast-context).
 *
 * Transcribed from server/config/protocols.json `tree_shrub.visits[].primary`
 * (NOT `secondary`). These are SUGGESTIONS the tech taps — nothing here is
 * recorded as applied, and no amount is computed (owner ruling 2026-10-01).
 *
 * Catalog identity follows client/src/lib/pest-default-mix.js: each entry is an
 * EXACT anchored, case-insensitive name pattern. An entry whose pattern
 * matches zero or MORE THAN ONE active products_catalog row is skipped, never
 * substituted — a wrong product silently pre-filled on a pesticide record is
 * worse than a missing suggestion.
 *
 * Left out on purpose: "Mn Combo" (Feb, May, Sep, Nov) — it has no
 * products_catalog row, so there is nothing to suggest.
 */
const { etCalendarDayOf } = require('../utils/datetime-et');

const SNAPSHOT = { pattern: /^snapshot\s*2\.5\s*tg\b/i, method: 'granular_broadcast' };
const PALM_8_2_12 = { pattern: /^lesco\s+8-2-12\b/i, method: 'granular_broadcast' };
const ORNAMENTAL_13_0_13 = { pattern: /^lesco\s+13-0-13\b/i, method: 'granular_broadcast' };
const TRITEK = { pattern: /^tritek\s+spray\s+oil\s+emulsion\b/i, method: 'foliar_spray' };
const IRON_PLUS = { pattern: /^lesco\s+chelated\s+iron\s+plus$/i, method: 'foliar_spray' };
// Three package rows (1 gal / 1 qt / 2.5 gal) share this name, so this entry
// always resolves ambiguous and is skipped until the catalog carries one row.
const NUTRIROOT = { pattern: /^arborjet\s+nutriroot\b/i, method: 'soil_drench' };
const KONTOS = { pattern: /^kontos\b/i, method: 'foliar_spray' };
const MAINSPRING = { pattern: /^mainspring\s+gnl\b/i, method: 'foliar_spray' };
const DISTANCE = { pattern: /^distance\s+igr\b/i, method: 'foliar_spray' };
const KPHITE = { pattern: /^kphite\s+7lp\b/i, method: 'foliar_spray' };
const COPPER = { pattern: /^southern\s+ag\s+copper\s+fungicide\b/i, method: 'foliar_spray' };
const CYTOGRO = { pattern: /^cytogro\b/i, method: 'foliar_spray' };
const TALUS = { pattern: /^talus\s+70\s+df\b/i, method: 'foliar_spray' };
const ESPOMA_ACIDIFIER = { pattern: /^espoma\s+organic\s+soil\s+acidifier\b/i, method: 'granular_broadcast' };
const SEQUESTAR = { pattern: /^sequestar\s+6%\s+fe\s+eddha\b/i, method: 'soil_drench' };

// Index 1..12 = January..December.
const MONTH_PRODUCTS = {
  1: [SNAPSHOT, PALM_8_2_12, ORNAMENTAL_13_0_13],
  2: [TRITEK, IRON_PLUS, NUTRIROOT],
  3: [KONTOS, MAINSPRING, DISTANCE, KPHITE],
  4: [SNAPSHOT, PALM_8_2_12, ORNAMENTAL_13_0_13],
  5: [KONTOS, MAINSPRING, IRON_PLUS, PALM_8_2_12, ORNAMENTAL_13_0_13],
  6: [TRITEK, KPHITE, COPPER, IRON_PLUS],
  7: [SNAPSHOT],
  8: [MAINSPRING, DISTANCE, TRITEK, CYTOGRO, NUTRIROOT],
  9: [TALUS, DISTANCE, IRON_PLUS, TRITEK],
  10: [SNAPSHOT, PALM_8_2_12, ORNAMENTAL_13_0_13, KPHITE],
  11: [TRITEK, NUTRIROOT, ESPOMA_ACIDIFIER, SEQUESTAR],
  12: [PALM_8_2_12, CYTOGRO, SEQUESTAR],
};

// The visit's scheduled date is a calendar day (a DATE column read back as a
// UTC-midnight Date, or a string); its month is that ET calendar day's month.
function visitMonthET(scheduledDate) {
  if (!scheduledDate) return null;
  const day = etCalendarDayOf(scheduledDate);
  const month = Number(String(day).slice(5, 7));
  return month >= 1 && month <= 12 ? month : null;
}

/**
 * The visit date's protocol products resolved against the catalog rows:
 * [{ productId, method }]. Inactive rows never count toward a match, and an
 * entry with zero or several matching active rows is skipped.
 */
function resolveMonthProducts(scheduledDate, catalogRows) {
  const entries = MONTH_PRODUCTS[visitMonthET(scheduledDate)] || [];
  const rows = (Array.isArray(catalogRows) ? catalogRows : []).filter((row) => row && row.active !== false);
  const resolved = [];
  for (const entry of entries) {
    const matches = rows.filter((row) => entry.pattern.test(String(row.name || '').trim()));
    if (matches.length === 1) resolved.push({ productId: matches[0].id, method: entry.method });
  }
  return resolved;
}

module.exports = { MONTH_PRODUCTS, visitMonthET, resolveMonthProducts };
