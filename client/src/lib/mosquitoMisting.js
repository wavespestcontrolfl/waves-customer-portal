// Mosquito misting system on the staff estimator (GATE_MOSQUITO_MISTING).
//
// The server owns the whole table. GET /admin/pricing-config/mosquito_misting_pricing
// carries `featureAvailable` (the gate, read per request) and a `misting`
// descriptor: tier and solution labels plus the input limits. No price and no
// default quote value is written here, so a price edit in the Pricing Logic
// panel reaches the screen without a deploy.
//
// The form keeps five text fields. A blank field is left out of the request and
// the engine applies its own default (the included nozzle count, no risers, the
// default tier and solution). What the operator typed goes out as typed: the
// engine refuses a fractional or out-of-range count with a reason and never
// rounds it into a different quote, so this file does not round either.

export const NO_MISTING = Object.freeze({ available: false, tiers: [], solutions: [], limits: {} });

// Only the form defaults that are not blank. Refills per year starts at the
// engine's standard of four; the server rejects anything outside its limits.
export const MISTING_FORM_DEFAULTS = Object.freeze({
  svcMisting: false,
  mistingTier: "",
  mistingNozzles: "",
  mistingRisers: "",
  mistingSolution: "",
  mistingRefillsPerYear: "4",
});

function labelled(list) {
  return Array.isArray(list)
    ? list.filter((item) => item && typeof item.key === "string" && typeof item.label === "string")
    : [];
}

// Explicit true only, like every other gate read on this screen: a 404, a failed
// read or an older server that omits the field keeps the section hidden.
export function readMistingAvailability(row) {
  const block = row?.misting;
  const tiers = labelled(block?.tiers);
  const solutions = labelled(block?.solutions);
  const available = row?.featureAvailable === true && block?.enabled === true && tiers.length > 0 && solutions.length > 0;
  if (!available) return NO_MISTING;
  return { available, tiers, solutions, limits: block.limits && typeof block.limits === "object" ? block.limits : {} };
}

// `options.mosquitoMisting` for the calculate and save requests. Empty when the
// toggle is off, so the payload is then byte-identical to one from before this
// feature. The toggle alone decides: a reopened estimate that carries the system
// while the gate is down still posts it, and the server refuses it loudly
// (MOSQUITO_MISTING_GATED) instead of the plan and install vanishing on a
// regenerate (pre-push P1). The second argument is kept for call sites.
export function mistingOption(form, _availability) {
  if (!form?.svcMisting) return {};
  const pairs = [
    ["tier", form.mistingTier],
    ["nozzles", form.mistingNozzles],
    ["risers", form.mistingRisers],
    ["solution", form.mistingSolution],
    ["refillsPerYear", form.mistingRefillsPerYear],
  ];
  const picked = {};
  for (const [key, raw] of pairs) {
    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    if (text !== "") picked[key] = text;
  }
  return { mosquitoMisting: picked };
}

// The blank choice of a select: the server's own default, named by its label.
export function defaultMistingLabel(list, defaultKey) {
  const found = list.find((item) => item.key === defaultKey);
  return found ? `Default: ${found.label}` : "Default";
}
