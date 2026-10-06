// Which persisted container holds an estimate's CURRENT priced result, decided in one place
// for the pricing audit (estimate-pricing-audit.js) and the bermuda removal evidence reader
// (v1-legacy-mapper.js), so the two never disagree.
//
// The pick, in order:
//   1. Only one of `result` / `engineResult` exists, or they are the same object: that one.
//   2. A SERVER-authoritative reprice (estimate.pricing_authority 'SERVER') rewrote
//      `result` wholesale and left the earlier `engineResult` behind: `result` is the
//      authority, even when it prices nothing (an operator removed every service).
//   3. Otherwise `result` is the default, but an ancillary `result` that prices nothing
//      yields to a priced `engineResult` (a quote-wizard or agent-draft row persists its
//      priced services only at engineResult.lineItems and may carry a shadowing `result`).
//      "Prices something" is the caller's own detector (`hasPricedLines`): the audit passes
//      its line normalizers.
//   A revised draft that leaves a stale engineResult behind keeps `result`, because its
//   `result` prices something.
//
// With no detector (the proposal path, a caller that cannot detect) `result` wins whenever
// it exists.
function authoritativeEstimateResult(data, { pricingAuthority = null, hasPricedLines = null } = {}) {
  if (!data || typeof data !== 'object') return {};
  const { result, engineResult } = data;
  if (!result || !engineResult || result === engineResult) return result || engineResult || {};
  if (String(pricingAuthority || '').toUpperCase() === 'SERVER') return result;
  if (typeof hasPricedLines === 'function' && !hasPricedLines(result) && hasPricedLines(engineResult)) return engineResult;
  return result;
}

module.exports = { authoritativeEstimateResult };
