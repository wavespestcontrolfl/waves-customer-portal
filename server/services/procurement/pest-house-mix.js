/**
 * procurement/pest-house-mix.js — the per-visit pest tank mix, for buying.
 *
 * The close-out prefills each general-pest visit with three products at fixed
 * totals. That mix lives in client/src/lib/pest-default-mix.js (owner rulings
 * 2026-09-26, 2026-11-18, 2026-11-19, 2026-11-25) and the Vite bundle cannot
 * import from the server, so this is a server copy of the same amounts and the
 * same identity rules. server/tests/pest-house-mix-drift.test.js reads the
 * client file and fails when the two differ; change both together.
 *
 * Why not a server classifier: protocol-matcher's "general_pest" reason also
 * matches inspections, initial cleanouts, the bare "Pest Control Service" label
 * and bee/wasp names, and detectServiceLine returns "pest" for every unclassified
 * name. Neither is the rule the close-out applies, and a buy list must count the
 * visits that will actually record the mix. The client's isPestDefaultMixVisit is
 * that rule, so it is mirrored here and the drift test runs both over one table.
 */
const { convertInventoryQuantity } = require('../inventory-units');

// Amounts are fl oz per visit. The client file states the totals only; its
// header comments give the unit. `floor`: an everyday liquid the owner keeps one
// container's worth of (owner 2026-11-27); the surfactant is not one.
const PEST_HOUSE_MIX = Object.freeze([
  { key: 'taurus_sc', pattern: /^taurus\s*sc\b/i, totalAmount: 1.6, unit: 'fl_oz', floor: true },
  { key: 'crosscheck_plus', pattern: /^lesco\s*cross-?check\s*plus\b/i, totalAmount: 2.5, unit: 'fl_oz', floor: true },
  { key: 'surfactant', pattern: /^lesco\s*90\s*\/?\s*10\s*non-?ionic\s+surfactant$/i, totalAmount: 0.25, unit: 'fl_oz', floor: false },
]);

// Everything the mix must not seed on (client NON_MIX_SERVICE_RE, verbatim).
const NON_MIX_SERVICE_RE =
  /lawn|turf|grass|\bsod\b|fertil|weed|aerat|dethatch|mosquito|termite|wdo|tree|shrub|\bpalms?\b|rodent|\brats?\b|\bmice\b|\bmouse\b|\bmoles?\b|bed\s*bug|\bfleas?\b|\bticks?\b|\bbees?\b|wasp|roach|\bants?\b|cleanout|exclusion|\binitial\b|inspection|\btrap|retainer/i;
// The recurring general-pest vocabulary (client RECURRING_GENERAL_PEST_RE, verbatim).
const RECURRING_GENERAL_PEST_RE =
  /general pest|quarterly|bi-?monthly|\bmonthly\b|semi-?annual|recurring pest|one[-\s]?time\s+pest\s+control/i;

/**
 * True when this booked visit will record the house mix at close-out. Takes a
 * scheduled_services row: { service_type, is_callback, service_key_snapshot },
 * plus what its completion profile says (the buy list reads it): profile_service_key
 * (the catalog key the visit resolves to, which the close-out checks before the row's
 * own snapshot) and typed_findings (a typed form never opens on the mix; neither does
 * the bed bug visit, SchedulePage isTypedFindings / isBedBugVisit).
 */
function isPestHouseMixVisit(visit) {
  const name = String(visit?.service_type || '').toLowerCase();
  const key = String(visit?.profile_service_key || visit?.service_key_snapshot || '').toLowerCase();
  if (visit?.typed_findings === true || key === 'bed_bug_treatment') return false;
  if (NON_MIX_SERVICE_RE.test(name)) return false;
  const isReservice = visit?.is_callback === true || /re-?service|callback/.test(name);
  if (isReservice || RECURRING_GENERAL_PEST_RE.test(name)) return true;
  // A bare "Pest Control Service" label carries no product line; the catalog key does.
  return key === 'one_time_pest_control';
}

/**
 * The catalog row for each mix entry: first row matching its identity wins, no
 * row claimed twice, a missing row is skipped (never substituted). Returns
 * [{ entry, product, perVisit }] with perVisit in the product's own stock unit
 * (null when the units do not convert) plus the entries nothing matched.
 */
function resolveHouseMix(products) {
  const used = new Set();
  const matched = [];
  const missing = [];
  for (const entry of PEST_HOUSE_MIX) {
    const product = (products || []).find((p) => p && !used.has(p.id) && entry.pattern.test(String(p.name || '').trim()));
    if (!product) { missing.push(entry); continue; }
    used.add(product.id);
    matched.push({ entry, product, perVisit: convertInventoryQuantity(entry.totalAmount, entry.unit, product.inventory_unit) });
  }
  return { matched, missing };
}

module.exports = { PEST_HOUSE_MIX, NON_MIX_SERVICE_RE, RECURRING_GENERAL_PEST_RE, isPestHouseMixVisit, resolveHouseMix };
