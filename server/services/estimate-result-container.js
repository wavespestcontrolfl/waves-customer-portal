// Which persisted container holds an estimate's CURRENT priced result.
//
// A revised or server-repriced estimate rewrites `estimate_data.result` wholesale and leaves
// the earlier `engineResult` behind, so when `result` exists it is the authority and
// `engineResult` is stale. Only a shape with no `result` (a quote-wizard or agent-draft row
// that persists its priced services at engineResult.lineItems) is read from `engineResult`.
// The pricing audit (estimate-pricing-audit.js) and the bermuda removal evidence reader
// (v1-legacy-mapper.js) both pick their container here, so they never disagree.
function authoritativeEstimateResult(data) {
  if (!data || typeof data !== 'object') return {};
  return data.result || data.engineResult || {};
}

module.exports = { authoritativeEstimateResult };
