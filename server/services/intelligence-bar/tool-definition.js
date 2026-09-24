// The Anthropic API rejects a tool definition carrying keys it does not
// know (`400 tools.N.custom._contracts: Extra inputs are not permitted`).
// Tool modules may carry underscore-prefixed metadata for the contract gate
// (`_contracts`, `_sideEffects`, `_sonnetBacked` — read by
// server/contract-tests/registry.js); that metadata never leaves the process.
//
// It also rejects `oneOf` / `anyOf` / `allOf` at the TOP LEVEL of
// input_schema (`400 tools.N.custom.input_schema: input_schema does not
// support oneOf, allOf, or anyOf at the top level`) — every Intelligence Bar
// query that loaded compare_vendor_pricing 500'd on 2026-09-22. Those
// combinators stay in the module's schema, where the action registry still
// compiles them into the server-side validator; only the wire copy loses them.
const TOP_LEVEL_COMBINATORS = ['oneOf', 'anyOf', 'allOf'];

function apiToolDefinition(tool) {
  const definition = Object.fromEntries(Object.entries(tool).filter(([key]) => !key.startsWith('_')));
  if (definition.input_schema && TOP_LEVEL_COMBINATORS.some(key => key in definition.input_schema)) {
    definition.input_schema = Object.fromEntries(
      Object.entries(definition.input_schema).filter(([key]) => !TOP_LEVEL_COMBINATORS.includes(key)),
    );
  }
  return definition;
}

module.exports = apiToolDefinition;
