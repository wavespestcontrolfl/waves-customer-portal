'use strict';

/**
 * Helpers for the Anthropic API's tool search on the Intelligence Bar's
 * full-access path (GATE_IB_TOOL_SEARCH; shape built in action-registry.js
 * initialTools). Pure helpers the /query tool loop calls; they hold the rules
 * so the loop itself gains no branches.
 *
 * API facts these rely on (Anthropic tool search docs):
 *  - The model's search runs on Anthropic's side. The assistant content then
 *    holds `server_tool_use` (id srvtoolu_..., name tool_search_tool_bm25) and
 *    `tool_search_tool_result` blocks. They are NOT `tool_use` blocks: the
 *    loop never executes them and never sends a `tool_result` for them.
 *  - The assistant content is passed back UNCHANGED, with the same tools.
 *  - A search with no match returns an empty `tool_references` list, not an
 *    error; an error result carries `tool_search_tool_result_error`.
 *  - A turn may end with stop_reason `pause_turn`; the assistant content is
 *    sent back as is and the request continues.
 */
const { ibToolSearchLive } = require('../../config/feature-gates');
const ActionRegistry = require('./action-registry');

const SEARCH_BLOCK_TYPES = new Set(['server_tool_use', 'tool_search_tool_result']);

function savedBlocks(resumedTask) {
  const messages = Array.isArray(resumedTask?.checkpoint) ? resumedTask.checkpoint : [];
  return messages.flatMap(message => (Array.isArray(message.content) ? message.content : []));
}

// Whether this request uses tool search. Needs the platform path and a
// full-access login (never model input). A resumed task keeps the shape its
// saved history already uses, whatever the gate reads now: history holding
// tool-search blocks keeps the search tool and the deferred tools (the API
// would otherwise get search blocks with no search tool); history holding
// discover_capabilities calls stays on the discover list. Only a history with
// neither follows the gate.
function toolSearchWanted(req, platformEnabled, actionScope) {
  if (!platformEnabled || actionScope.fullAccess !== true) return false;
  const blocks = savedBlocks(req.ibResumedTask);
  if (blocks.some(block => SEARCH_BLOCK_TYPES.has(block.type))) return true;
  const discovered = blocks.some(block => block.type === 'tool_use' && block.name === ActionRegistry.DISCOVERY_TOOL.name);
  return ibToolSearchLive() && !discovered;
}

// The system prompt sentence that tells the model how to reach other tools.
// Deterministic for the same page + login + gate state: the prompt is part of
// the cached prefix.
const DISCOVER_LINE = 'Use discover_capabilities to load tools from any other domain before saying a capability is unavailable.';
const SEARCH_LINE = 'Every admin capability is available to you through the tool search tool: customers and properties, schedule and dispatch, estimates, invoices and billing, leads, texts, calls and email, inventory, reviews, dashboards and reports, SEO and content, banking and tax, and outside services. Search with a short description of what you need before saying a capability is unavailable.';
function capabilitySearchLine(toolSearch) {
  return toolSearch ? SEARCH_LINE : DISCOVER_LINE;
}

// A turn that stops with pause_turn and no client tool call is not finished:
// the loop continues with the assistant content as is.
function finishesTurn(response, toolUses) {
  return toolUses.length === 0 && response.stop_reason !== 'pause_turn';
}

// The messages after a round: the assistant content unchanged, then the
// client tool results. A round with no client tool call (a paused turn) has
// no results message; an empty user message would be rejected.
function appendRoundMessages(messages, response, results) {
  const assistant = { role: 'assistant', content: response.content };
  return results.length ? [...messages, assistant, { role: 'user', content: results }] : [...messages, assistant];
}

// Feeds the gap collector from the server-side search, in the shape its
// discovery() hook already reads for discover_capabilities: found = the
// referenced tools, nothing found = capability_unimplemented. An error result
// records nothing.
function observeServerToolSearches(content, gapCollector) {
  if (!gapCollector) return;
  const queries = new Map(content.filter(block => block.type === 'server_tool_use').map(block => [block.id, block.input?.query]));
  for (const block of content) {
    const references = block.type === 'tool_search_tool_result' ? block.content?.tool_references : null;
    if (!Array.isArray(references)) continue;
    const capabilities = references.map(reference => ActionRegistry.actions.get(reference?.tool_name)).filter(Boolean)
      .map(action => ({ id: action.id, domain: action.domain }));
    gapCollector.discovery({ query: queries.get(block.tool_use_id) },
      { status: capabilities.length ? 'capabilities_found' : 'capability_unimplemented', capabilities });
  }
}

module.exports = { toolSearchWanted, capabilitySearchLine, finishesTurn, appendRoundMessages, observeServerToolSearches, SEARCH_LINE, DISCOVER_LINE };
