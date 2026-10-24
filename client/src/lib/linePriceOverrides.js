// Per-line operator price overrides for the admin estimate builder.
//
// The engine (`applyLinePriceOverrides` in estimate-engine.js) accepts
// `options.linePriceOverrides = { [service]: { price, reason } }` and replaces
// the engine price of any priced one-time / specialty line with the typed
// amount (owner ask 2026-10-09: a carpenter-ant job the engine priced at $240
// that is worth $400). The form keeps the operator's raw entries keyed by
// engine service key; these helpers turn them into the request payload and
// list which lines of a generated estimate can be overridden.

function parsePositiveNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Lines on a generated estimate that accept an override: the ones the engine
// stamped `priceOverridable` (a priced one-time / specialty line it can
// replace — never recurring, retainer, quote-required or the roach fee line).
// A row the mapper builds from a nested engine field (the misting
// installation) carries no stamp: its key matches no engine line.
export function overridableLines(estimate) {
  const oneTime = Array.isArray(estimate?.oneTime?.items) ? estimate.oneTime.items : [];
  const specialty = Array.isArray(estimate?.specItems) ? estimate.specItems : [];
  const seen = new Set();
  const out = [];
  for (const item of [...oneTime, ...specialty]) {
    const service = String(item?.service || "").trim();
    if (!service || item.priceOverridable !== true || seen.has(service)) continue;
    const price = Number(item.price);
    if (!(price > 0)) continue;
    seen.add(service);
    out.push({
      service,
      name: item.name || service,
      price,
      // A total-priced line (flea_package) keeps its engine number as engineTotal.
      enginePrice: item.priceOverridden ? Number(item.enginePrice ?? item.engineTotal) : price,
      priceOverridden: item.priceOverridden === true,
      reason: item.priceOverrideReason || "",
    });
  }
  return out;
}

// Turns the form's raw entries into the `linePriceOverrides` request option.
// Blank entries are dropped; a present-but-invalid amount is an error so the
// operator never regenerates believing a typed number applied (same rule as
// the roach fee override).
export function buildLinePriceOverridesPayload(entries) {
  const payload = {};
  for (const [service, entry] of Object.entries(entries && typeof entries === "object" ? entries : {})) {
    const raw = String(entry?.price ?? "").trim();
    if (!raw) continue;
    const price = parsePositiveNumber(raw);
    if (!price) {
      return {
        payload: null,
        error: `Price override for ${entry?.name || service} must be a positive dollar amount — clear it to use the engine price.`,
      };
    }
    payload[service] = { price, reason: String(entry?.reason || "").trim() };
  }
  return { payload: Object.keys(payload).length ? payload : null, error: null };
}
