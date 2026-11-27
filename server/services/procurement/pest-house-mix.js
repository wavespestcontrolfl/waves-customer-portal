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
// The recurring general-pest vocabulary (client RECURRING_GENERAL_PEST_RE, verbatim; semi-annual is its own rule below).
const RECURRING_GENERAL_PEST_RE =
  /general pest|quarterly|bi-?monthly|\bmonthly\b|recurring pest|one[-\s]?time\s+pest\s+control/i;
// The close-out's no-card rule (client pest-default-mix.js, owner pick D18, PR #8672): "semi-annual" counts with "pest" in the
// name or under a general pest key; a WHOLE bare name ("Re-Service", "Callback", "Semi-Annual Service", "Recurring Service") counts
// only on a visit with no key at all. Same expressions, same key set (protocol-matcher.js general pest rule), same precedence.
const SEMIANNUAL_RE = /semi ?annual/;
const KEYLESS_GENERAL_PEST_RE = /^(re service|reservice|callback|semi annual|semiannual|recurring)( service| visit)?$/;
const NO_MIX_KEYS = new Set(['bed_bug_treatment', 'lawn_inspection']);
const GENERAL_PEST_KEYS = new Set([
  'pest_general_quarterly', 'pest_general_monthly', 'pest_general_bimonthly', 'pest_general_semiannual',
  'one_time_pest_control', 'pest_re_service',
]);

/**
 * True when this booked visit will record the house mix at close-out. Takes a
 * scheduled_services row: { service_type, is_callback, service_key_snapshot },
 * plus what its completion profile says (the buy list reads it): profile_service_key
 * (the catalog key the visit resolves to, which the close-out checks before the row's
 * own snapshot) and typed_findings (a typed form never opens on the mix; neither does
 * the bed bug visit, SchedulePage isTypedFindings / isBedBugVisit).
 */
function isPestHouseMixVisit(visit) {
  const v = visit || {};
  const raw = String(v.service_type || '').toLowerCase();
  const key = String(v.profile_service_key || v.service_key_snapshot || '').toLowerCase();
  // An internal-only completion (a consultation) opens no mix; it is excluded before anything is classified. A typed form
  // and the bed bug visit never open on it; a booked Waves Assessment is a walk with no product under any name.
  if ([v.internal_only, v.typed_findings].includes(true) || NO_MIX_KEYS.has(key) || NON_MIX_SERVICE_RE.test(raw)) return false;
  const name = raw.replace(/[^a-z0-9]+/g, ' ').trim();
  const pestWork = /\bpest\b/.test(name) || GENERAL_PEST_KEYS.has(key);
  const answers = [
    !key && KEYLESS_GENERAL_PEST_RE.test(name),
    [v.is_callback === true, /re ?service|callback/.test(name)].some(Boolean) && pestWork,
    SEMIANNUAL_RE.test(name) && pestWork,
    RECURRING_GENERAL_PEST_RE.test(raw),
  ];
  // A bare "Pest Control Service" label carries no product line; the catalog key does.
  return answers.some(Boolean) || key === 'one_time_pest_control';
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

module.exports = { PEST_HOUSE_MIX, NON_MIX_SERVICE_RE, RECURRING_GENERAL_PEST_RE, SEMIANNUAL_RE, KEYLESS_GENERAL_PEST_RE, GENERAL_PEST_KEYS, isPestHouseMixVisit, resolveHouseMix };
