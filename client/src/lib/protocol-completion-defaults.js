// client/src/lib/protocol-completion-defaults.js
//
// Owner ruling 2026-09-26: the Complete Service drawer's product list
// should start prefilled with a visit's default products (label-default
// rates, tech adjusts) for a non-lawn spray/granule/bait service — "the
// default products used are Alpine WSG, Gentrol IGR, and the Advion
// cockroach gel — these need to be defaults".
//
// This is the generic sibling of lib/pest-default-mix.js: the SERVER
// resolves which products a visit gets (protocols.json visit-level
// completionDefaultProducts → none — see server/services/completion-
// product-defaults.js), already mapped to active catalog rows, each with
// its own protocol-specified application method when the visit's lineMeta
// names one; this module only maps that response onto the CompletionPanel's
// already-loaded catalog and turns it into selection rows, exactly like
// lawnPlanSelections / pestDefaultMixSelections do for their own sources.
//
// Programs the client already prefills through their OWN mechanism stay
// out of this hook's way, so a visit is never seeded twice from two
// sources:
//   - lawn: lawn-completion-defaults.js / lawn-completion.js (governed plan)
//   - pest: pest-default-mix.js — a client-side pattern match against the
//     SAME server-curated product names (Taurus SC / Atticus Talak 7.9 F /
//     LESCO 90/10 Nonionic Surfactant, or the roach mix), kept as its own
//     mechanism rather than switched to this fetch-based one.
// Today this hook effectively seeds cockroach visits; it applies to any
// other program the owner later adds a completionDefaultProducts list to.
const OWNED_ELSEWHERE_PROGRAM_KEYS = new Set(['lawn', 'pest']);

// True when GET /admin/dispatch/:serviceId/default-products returned
// products this hook should seed — a non-empty list from a program no
// other client mechanism already owns, AND from the curated protocol
// visit specifically (source: 'protocol_visit' — the only non-empty
// source the resolver returns; 'excluded_lawn' and 'none' both answer no
// products). A program the owner hasn't curated yet (mosquito, termite,
// tree & shrub, rodent, bed bug, palm) simply seeds nothing until
// protocols.json gets its own completionDefaultProducts list.
export function shouldApplyProtocolCompletionDefaults(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.source !== 'protocol_visit') return false;
  if (OWNED_ELSEWHERE_PROGRAM_KEYS.has(response.programKey)) return false;
  return Array.isArray(response.products) && response.products.length > 0;
}

// Maps the server's resolved products onto the CALLER's already-loaded
// catalog rows (by id — never re-derived from the name, so the client and
// server always agree on which row this is) and builds each selection
// through the caller's own buildSelectedProduct, so rate-prefill,
// application-method inference, and every other per-row derivation stay
// identical to a manual "add product" tap — EXCEPT the method itself,
// which the protocol visit's own lineMeta can override (item.
// completionApplicationMethod — e.g. Alpine WSG's crack-and-crevice work
// -> 'spot_treatment', never the catalog-inferred 'perimeter_spray',
// which would wrongly demand linear footage for an interior placement).
// Passed into buildSelectedProduct itself, not patched onto its result
// after the fact, so every derivation THAT method drives (rate, area
// unit/value) is computed consistently from the start. A server product
// with no matching CLIENT catalog row (a permissions gap, a load that
// raced the fetch) is skipped, never guessed.
export function protocolCompletionDefaultSelections(response, clientProducts, buildSelectedProduct) {
  if (!shouldApplyProtocolCompletionDefaults(response) || typeof buildSelectedProduct !== 'function') return [];
  const rows = Array.isArray(clientProducts) ? clientProducts : [];
  const selections = [];
  for (const item of response.products) {
    const product = rows.find((row) => String(row.id) === String(item?.id));
    if (!product) continue;
    const selection = buildSelectedProduct(product, { applicationMethodOverride: item?.completionApplicationMethod || undefined });
    selections.push({
      ...selection,
      // Snapshot needs its weed rate; palms need individual canopy widths.
      // Clear catalog shortcuts before an area/tank calculator can reuse one.
      ...(item.requiresDoseSelection ? {
        requiresDoseSelection: true,
        rate: '', totalAmount: '', totalAmountManual: false,
        amountUnit: 'lb', rateUnit: item.treeShrubKey === 'snapshot' ? 'lb' : 'lb/palm',
        catalogRateUnit: item.treeShrubKey === 'snapshot' ? 'lb' : 'lb/palm',
        carrierGallons: '', maxLabelRatePer1000: item.treeShrubKey === 'snapshot' ? 4.6 : null,
      } : {}),
      // Provenance flag only — no visible tag renders from it today (the
      // product-card UI has no cheap per-line badge slot), but it lets a
      // later change key off "this row came from the protocol default"
      // without re-deriving that from the response.
      protocolDefaultProduct: true,
    });
  }
  return selections;
}
