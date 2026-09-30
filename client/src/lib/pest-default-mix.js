// client/src/lib/pest-default-mix.js
//
// Default tank mix for recurring general-pest, ONE-TIME pest, and pest
// re-service (callback) completions. Originally owner 2026-08-29 (Taurus
// SC + Talstar P + a non-ionic surfactant); superseded by the owner
// ruling 2026-09-26, which (a) swaps Talstar P for Atticus Talak 7.9 F —
// "Talstar P" is inactive in the prod catalog, Talak is the real
// bifenthrin now carried — (b) names the exact surfactant row, LESCO
// 90/10 Nonionic Surfactant (the old bare "Non-ionic Surfactant" catalog
// row it matched no longer exists as such), and (c) extends coverage to
// the one-time pest control visit, which the 2026-08-29 list deliberately
// left off. The visit STARTS with all three recorded, at the house
// totals — 4 oz of each concentrate, 0.25 oz of surfactant.
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
  { pattern: /^atticus\s*talak\b/i, totalAmount: 4 },
  { pattern: /^lesco\s*90\s*\/?\s*10\s*non-?ionic\s+surfactant$/i, totalAmount: 0.25 },
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
// "Pest Control Service", the lawn combo — all still fail this gate.
// "one-time pest control" is a SEPARATE, narrower addition (owner
// 2026-09-26): the admin-created One-Time Pest Control Service catalog
// row now gets the same mix, without loosening the bare "Pest Control
// Service" LABEL exclusion above (still no product-line naming to key
// off a bare name) — isPestDefaultMixVisit below covers the common bare-
// label case separately, by the row's stable catalog key instead.
const RECURRING_GENERAL_PEST_RE =
  /general pest|quarterly|bi-?monthly|\bmonthly\b|semi-?annual|recurring pest|one[-\s]?time\s+pest\s+control/i;

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
  if (isReservice || RECURRING_GENERAL_PEST_RE.test(s)) return true;
  // The stable catalog key, not the label (Codex r3 P2, PR #5049): an
  // admin-created One-Time Pest Control Service job is often scheduled
  // under the bare "Pest Control Service" label (admin-schedule.js's
  // EDIT_FALLBACK_SERVICES scheduler fallback + legacy rows) — the label
  // test above deliberately keeps excluding that bare name, since it
  // carries no product-line naming to key off. The catalog KEY is
  // unambiguous, so it gets the mix regardless of label; every specialty
  // exclusion above (NON_MIX_SERVICE_RE, checked first against the label)
  // still wins, and a specialty visit never carries this key anyway — each
  // has its own distinct one (tick_control, bee_wasp_removal, …). Checked
  // across every field a caller's dispatch-shaped service object might
  // carry it under.
  const key = String(
    service?.completionProfile?.serviceKey
      || service?.serviceKey
      || service?.service_key_snapshot
      || "",
  ).toLowerCase();
  return key === "one_time_pest_control";
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
