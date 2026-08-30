// client/src/lib/pest-default-mix.js
//
// Default tank mix for recurring general-pest and pest re-service
// (callback) completions (owner 2026-08-29): the visit STARTS with
// Taurus SC, Talstar P, and the non-ionic surfactant recorded, with the
// house totals — 4 oz of each concentrate, 0.25 oz of surfactant.
//
// Single source of truth for BOTH completion surfaces (codex P1 on
// #3611): the full CompletionPanel (admin dispatch) seeds complete
// product rows with the totals; ServiceRecapModal (the tech portal's
// primary pest completion, also the admin quick lane) pre-selects the
// same three products — its payload records rates only, so the totals
// live on the full form. Everything stays editable/deselectable on both.

// Matching is by EXACT catalog identity — an entry whose row is missing
// (renamed/retired) is skipped, never substituted (codex P1 on #3611: a
// broad /surfactant/ fallback could silently auto-record the LESCO lawn
// surfactant as the applied chemical at the pest total).
export const PEST_DEFAULT_MIX = [
  { pattern: /^taurus\s*sc\b/i, totalAmount: 4 },
  { pattern: /^talstar\s*p\b/i, totalAmount: 4 },
  { pattern: /^non-?ionic\s+surfactant$/i, totalAmount: 0.25 },
];

// Everything the mix must NOT seed on: other service lines (lawn, T&S,
// mosquito, termite — combos included, mirroring the alias list's combo
// exclusion), the specialty pest lanes that keep their own product flows
// (rodent, bed bug, flea/tick, bee/wasp, roach cleanouts, ant jobs), and
// the visits the canonical alias set deliberately excludes — initial
// visits and inspections.
const NON_MIX_SERVICE_RE =
  /lawn|turf|grass|\bsod\b|fertil|weed|aerat|dethatch|mosquito|termite|wdo|tree|shrub|\bpalms?\b|rodent|\brats?\b|\bmice\b|\bmouse\b|\bmoles?\b|bed\s*bug|\bfleas?\b|\bticks?\b|\bbees?\b|wasp|roach|\bants?\b|cleanout|exclusion|\binitial\b|inspection/i;

// The recurring general-pest vocabulary mirrors the canonical alias set
// in migration 20260514000009 (all three naming generations, the legacy
// bare-cadence forms, and "Recurring Pest Control"); the alias list's
// exclusions — "General Pest Control (Initial)", the bare one-time
// "Pest Control Service", the lawn combo — all fail this gate too.
const RECURRING_GENERAL_PEST_RE =
  /general pest|quarterly|bi-?monthly|\bmonthly\b|semi-?annual|recurring pest/i;

// The mix belongs on recurring general-pest maintenance visits and pest
// re-services ONLY. Callers on an un-gated surface pass the whole
// schedule row (name tokens exclude the other lines); the recap lane is
// additionally server-gated to the pest_control category.
export function isPestDefaultMixVisit(service) {
  const raw =
    service?.serviceTypeRaw || service?.serviceType || service?.service_type || "";
  const s = String(raw).toLowerCase();
  if (NON_MIX_SERVICE_RE.test(s)) return false;
  const isReservice =
    service?.isCallback === true || /re-?service|callback/.test(s);
  return isReservice || RECURRING_GENERAL_PEST_RE.test(s);
}

// Resolve the mix against the loaded catalog: first row matching each
// entry's identity wins, no row claimed twice, missing entries skipped.
export function pestDefaultMixSelections(products) {
  const rows = Array.isArray(products) ? products : [];
  const used = new Set();
  const selections = [];
  for (const entry of PEST_DEFAULT_MIX) {
    const match = rows.find(
      (p) => p && !used.has(p.id) && entry.pattern.test(String(p.name || "").trim()),
    );
    if (match) {
      used.add(match.id);
      selections.push({ product: match, totalAmount: entry.totalAmount });
    }
  }
  return selections;
}
