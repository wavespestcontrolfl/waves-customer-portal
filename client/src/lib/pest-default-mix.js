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
// totals — 2.5 fl oz of Crosscheck (see below), 1.6 fl oz of Taurus SC (see
// below), 0.25 oz of surfactant.
//
// Owner ruling 2026-11-19: Taurus SC is 1.6 fl oz per 4-gal tank = 0.03%, the
// label's 0.4 fl oz/gal rate (EPA 53883-279: 0.03% up to 4 times a calendar
// year). The surfactant (0.25) is unchanged.
//
// Owner 2026-11-25 (protocols page, D21 "fix the label failures"): Crosscheck
// Plus goes from 4 fl oz to 2.5 fl oz per 4-gal tank. Its label (EPA 10404-120)
// allows at most 1 fl oz per 1,000 sq ft. The shared tank goes out at the
// Taurus label's volume, 2 qt per 160 ft of a 2-ft band = 1.5625 gal per
// 1,000 sq ft, so 4 fl oz per tank put down 1.56 fl oz per 1,000. The most the
// tank may carry is 0.64 fl oz per gallon (2.56 per tank); 2.5 is the amount a
// tech can measure under it (0.98 fl oz per 1,000). The page's own figure, 2.6
// per tank, is 3% over the label at that volume.
//
// Owner ruling 2026-11-18: the house bifenthrin is now LESCO Crosscheck Plus
// (EPA 10404-120) instead of Atticus Talak 7.9 F. Talak stays a valid catalog
// product for old records and leftover stock; it is no longer pre-selected.
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
  { pattern: /^taurus\s*sc\b/i, totalAmount: 1.6 },
  { pattern: /^lesco\s*cross-?check\s*plus\b/i, totalAmount: 2.5 },
  { pattern: /^lesco\s*90\s*\/?\s*10\s*non-?ionic\s+surfactant$/i, totalAmount: 0.25 },
];

// Everything the mix must NOT seed on: other service lines (lawn, T&S,
// mosquito, termite — combos included, mirroring the alias list's combo
// exclusion), the specialty pest lanes that keep their own product flows
// (rodent, bed bug, flea/tick, bee/wasp, roach cleanouts, ant jobs), and
// the visits the canonical alias set deliberately excludes — initial
// visits and inspections, and the trap-only retainer plans (owner 2026-11-19:
// a trap check applies no spray, so "Monthly Trap-Only Retainer Service" must
// not pick up the monthly general-pest vocabulary below).
const NON_MIX_SERVICE_RE =
  /lawn|turf|grass|\bsod\b|fertil|weed|aerat|dethatch|mosquito|termite|wdo|tree|shrub|\bpalms?\b|rodent|\brats?\b|\bmice\b|\bmouse\b|\bmoles?\b|bed\s*bug|\bfleas?\b|\bticks?\b|\bbees?\b|wasp|roach|\bants?\b|cleanout|exclusion|\binitial\b|inspection|\btrap|retainer/i;

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
  /general pest|quarterly|bi-?monthly|\bmonthly\b|recurring pest|one[-\s]?time\s+pest\s+control/i;
// "Semi-annual" counts as the server's general pest card does: with "pest" in the name, under a general pest key, or as a
// WHOLE bare name ("Semi-Annual Service") with no key (KEYLESS_GENERAL_PEST_RE).
const SEMIANNUAL_RE = /semi ?annual/;

// The mix belongs on recurring general-pest maintenance visits and pest
// re-services ONLY. Callers on an un-gated surface pass the whole
// schedule row (name tokens exclude the other lines); the recap lane is
// additionally server-gated to the pest_control category.
// The general pest catalog keys (server protocol-matcher.js, the general pest rule's serviceKeys, less the two the name
// test above always excludes: the initial cleanout and pest + rodent).
// The server's keylessNames for the general pest card (protocol-matcher.js), the same set on the same normalized name
// (lower case, every run of other characters one space): a WHOLE bare name on a visit with no key.
const KEYLESS_GENERAL_PEST_RE = /^(re service|reservice|callback|semi annual|semiannual|recurring)( service| visit)?$/;
const GENERAL_PEST_KEYS = new Set([
  "pest_general_quarterly", "pest_general_monthly", "pest_general_bimonthly", "pest_general_semiannual",
  "one_time_pest_control", "pest_re_service",
]);

export function isPestDefaultMixVisit(service) {
  const raw =
    service?.serviceTypeRaw || service?.serviceType || service?.service_type || "";
  const s = String(raw).toLowerCase();
  if (NON_MIX_SERVICE_RE.test(s)) return false;
  const key = String(
    service?.completionProfile?.serviceKey
      || service?.serviceKey
      || service?.service_key_snapshot
      || "",
  ).toLowerCase();
  // A booked Waves Assessment (key lawn_inspection) is a walk with no product under any name, "Quarterly Service" too.
  if (key === "lawn_inspection") return false;
  // A re-service counts as the server's general pest card does (protocol-matcher.js): its name says pest, or its key is a
  // general pest service, or the WHOLE name is a bare "Re-Service" / "Callback" with no key at all. A callback booking whose
  // name and key say nothing ("Courtesy Visit"), or a bare "Re-Service" under another service's key, has no card on the
  // server (no_protocol, owner pick D18): inspection only, nothing prefilled.
  const name = s.replace(/[^a-z0-9]+/g, " ").trim();
  const pestWork = /\bpest\b/.test(name) || GENERAL_PEST_KEYS.has(key);
  const keylessGeneral = !key && KEYLESS_GENERAL_PEST_RE.test(name);
  const isReservice = (service?.isCallback === true || /re ?service|callback/.test(name)) && pestWork;
  const semiannual = SEMIANNUAL_RE.test(name) && pestWork;
  if (keylessGeneral || isReservice || semiannual || RECURRING_GENERAL_PEST_RE.test(s)) return true;
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
