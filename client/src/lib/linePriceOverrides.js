// Per-line operator price overrides for the admin estimate builder.
//
// The engine (`applyLinePriceOverrides` in estimate-engine.js) accepts
// `options.linePriceOverrides = { [service]: { price, reason } }` and replaces
// the engine price of any priced one-time / specialty line with the typed
// amount (owner ask 2026-10-09: a carpenter-ant job the engine priced at $240
// that is worth $400). The form keeps the operator's raw entries keyed by
// engine service key; these helpers turn them into the request payload and
// list which lines of a generated estimate can be overridden.

const ROACH_LINE = "pest_initial_roach"; // has its own fee-override input

function parsePositiveNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Lines on a generated estimate that accept an override: priced (not quote-
// required, not an included $0 row), one-time or specialty, with an engine
// service key. The roach fee line keeps its dedicated input.
export function overridableLines(estimate) {
  const oneTime = Array.isArray(estimate?.oneTime?.items) ? estimate.oneTime.items : [];
  const specialty = Array.isArray(estimate?.specItems) ? estimate.specItems : [];
  const seen = new Set();
  const out = [];
  for (const item of [...oneTime, ...specialty]) {
    const service = String(item?.service || "").trim();
    if (!service || service === ROACH_LINE || seen.has(service)) continue;
    if (item.quoteRequired || item.onProg) continue;
    const price = Number(item.price);
    if (!(price > 0)) continue;
    seen.add(service);
    out.push({
      service,
      name: item.name || service,
      price,
      enginePrice: item.priceOverridden ? Number(item.enginePrice) : price,
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
