// The Anthropic API rejects a tool definition carrying keys it does not
// know (`400 tools.N.custom._contracts: Extra inputs are not permitted`).
// Tool modules may carry underscore-prefixed metadata for the contract gate
// (`_contracts`, `_sideEffects`, `_sonnetBacked` — read by
// server/contract-tests/registry.js); that metadata never leaves the process.
function apiToolDefinition(tool) {
  return Object.fromEntries(Object.entries(tool).filter(([key]) => !key.startsWith('_')));
}

module.exports = apiToolDefinition;
