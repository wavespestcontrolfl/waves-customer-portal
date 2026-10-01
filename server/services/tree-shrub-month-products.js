/**
 * Tree & Shrub protocol month -> suggested products, for the T&S Fast
 * Complete sheet (GET /:serviceId/tree-shrub/fast-context).
 *
 * Read from the canonical protocol, server/config/protocols.json
 * `tree_shrub.visits[]`: the visit for the month and its `primary` lines
 * (NOT `secondary`). An edit to a month's primary text changes the
 * suggestions; a primary line naming a product this table cannot place fails
 * tree-shrub-month-products.test.js. These are SUGGESTIONS the tech taps —
 * nothing is recorded as applied, and no amount is computed (owner ruling
 * 2026-10-01).
 *
 * Why not the job card's protocol-text matcher (job-card.js
 * resolveProtocolLines): on the T&S lines it picks T-Zone SE (a turf
 * herbicide) for "13-0-13 ornamental fertilizer" and misses 8-2-12, Kontos
 * and the copper line. A wrong product pre-filled on a pesticide record is
 * worse than a missing one, so each product here is a protocol `token` (how
 * the protocol text names it) plus an EXACT anchored catalog `pattern`
 * (client/src/lib/pest-default-mix.js's identity rule): zero or several
 * active matching catalog rows skip the suggestion, never substitute.
 */
const { etCalendarDayOf } = require('../utils/datetime-et');

const PROTOCOL_PRODUCTS = [
  { token: /\bsnapshot\b/i, pattern: /^snapshot\s*2\.5\s*tg\b/i, method: 'granular_broadcast' },
  { token: /\b8-2-12\b/, pattern: /^lesco\s+8-2-12\b/i, method: 'granular_broadcast' },
  { token: /\b13-0-13\b/, pattern: /^lesco\s+13-0-13\b/i, method: 'granular_broadcast' },
  { token: /\btritek\b/i, pattern: /^tritek\s+spray\s+oil\s+emulsion\b/i, method: 'foliar_spray' },
  // "Iron Plus", and June's "Fe/Mn micros" line (the same chelated Fe + Mn).
  { token: /\biron\s+plus\b|\bfe\/mn\s+micros\b/i, pattern: /^lesco\s+chelated\s+iron\s+plus$/i, method: 'foliar_spray' },
  // Three package rows (1 gal / 1 qt / 2.5 gal) share this name, so it resolves
  // ambiguous and is skipped until the catalog carries one row.
  { token: /\bnutriroot\b/i, pattern: /^arborjet\s+nutriroot\b/i, method: 'soil_drench' },
  { token: /\bkontos\b/i, pattern: /^kontos\b/i, method: 'foliar_spray' },
  { token: /\bmainspring\b/i, pattern: /^mainspring\s+gnl\b/i, method: 'foliar_spray' },
  { token: /\bdistance\b/i, pattern: /^distance\s+igr\b/i, method: 'foliar_spray' },
  { token: /\bkphite\b/i, pattern: /^kphite\s+7lp\b/i, method: 'foliar_spray' },
  { token: /\bcopper\b/i, pattern: /^southern\s+ag\s+copper\s+fungicide\b/i, method: 'foliar_spray' },
  { token: /\bcytogro\b/i, pattern: /^cytogro\b/i, method: 'foliar_spray' },
  { token: /\btalus\b/i, pattern: /^talus\s+70\s+df\b/i, method: 'foliar_spray' },
  { token: /\bacidifier\b/i, pattern: /^espoma\s+organic\s+soil\s+acidifier\b/i, method: 'granular_broadcast' },
  { token: /\bsequestar\b/i, pattern: /^sequestar\s+6%\s+fe\s+eddha\b/i, method: 'soil_drench' },
];

// Primary lines that name no product to suggest: scouting and reporting work,
// the blackout reminder, and "Mn Combo" (no products_catalog row).
const NON_PRODUCT_LINE = /^(scout\b|sarasota\/manatee:\s*zero|annual health report|mn combo\b)/i;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function primaryLines(visit) {
  return String(visit?.primary || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

// The protocol products a month's primary lines name, in line order.
function monthProtocolProducts(month, protocols = require('../config/protocols.json')) {
  const visit = (protocols?.tree_shrub?.visits || []).find((v) => v.month === MONTH_NAMES[month - 1]);
  const out = [];
  for (const line of primaryLines(visit)) {
    // "Annual health report with … Snapshot history" names a product it does
    // not apply.
    if (NON_PRODUCT_LINE.test(line)) continue;
    for (const product of PROTOCOL_PRODUCTS) {
      if (product.token.test(line) && !out.includes(product)) out.push(product);
    }
  }
  return out;
}

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
function resolveMonthProducts(scheduledDate, catalogRows, protocols) {
  const month = visitMonthET(scheduledDate);
  const entries = month ? monthProtocolProducts(month, protocols) : [];
  const rows = (Array.isArray(catalogRows) ? catalogRows : []).filter((row) => row && row.active !== false);
  const resolved = [];
  for (const entry of entries) {
    const matches = rows.filter((row) => entry.pattern.test(String(row.name || '').trim()));
    if (matches.length === 1) resolved.push({ productId: matches[0].id, method: entry.method });
  }
  return resolved;
}

module.exports = { PROTOCOL_PRODUCTS, NON_PRODUCT_LINE, primaryLines, monthProtocolProducts, visitMonthET, resolveMonthProducts };
