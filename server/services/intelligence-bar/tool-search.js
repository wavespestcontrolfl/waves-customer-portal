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

// Server tool calls (server_tool_use) with no result block yet, across the
// whole history. Doc (server-tools, "Mixing server tools and client tools in
// one turn"): "Detect the state by looking for a `server_tool_use` block whose
// `id` has no matching result block". A result pairs with its call by
// tool_use_id, and it may sit in a LATER assistant message.
function pendingServerToolIds(messages) {
  const open = new Set();
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'server_tool_use') open.add(block.id);
      else if (block.type !== 'tool_result' && block.tool_use_id) open.delete(block.tool_use_id);
    }
  }
  return open;
}

// Item 1. Doc: "A `server_tool_use` block and its result block pair up by
// `tool_use_id`, not by position: in this flow they arrive in two different
// responses, and the `server_tool_use` block is not repeated in the second
// one. On later requests, keep the whole exchange in your `messages` array in
// order: ... and then the next response as another `assistant` message."
// A terminal response (no client tool call) that carries the result of a
// search still open in the history is therefore kept in the messages that get
// checkpointed; otherwise the saved history holds a call with no result and a
// resume is rejected. Any other terminal response is not stored, as before.
function withTerminalResponse(messages, response, toolSearch) {
  if (!toolSearch) return messages;
  const open = pendingServerToolIds(messages);
  const resolves = response.content.some(block => block.type === 'tool_search_tool_result' && open.has(block.tool_use_id));
  return resolves ? [...messages, { role: 'assistant', content: response.content }] : messages;
}

// Item 6. Doc (server-tools, "The server-side loop and pause_turn"): "Pass the
// paused response back as-is in a subsequent request"; and (mixing section)
// "The follow-up user message must contain nothing except `tool_result`
// blocks. A block added after the results, such as text, tells the API that
// the assistant turn is over", which fails with a 400 for an unresolved server
// tool call. So a saved history that ends with an assistant message holding an
// unresolved server tool call (a paused turn) is sent unchanged, and the
// resume's continuation turn (it carries the Confirm receipts, so it cannot be
// dropped) is held in `held.turn` until a response has resolved the call. The
// round after that adds it as a text block behind the client tool results
// (text after tool_result blocks is ordinary tool use). Any other history gets
// the continuation as a normal user message.
function withResumeTurn(messages, turn, toolSearch, held) {
  const last = messages[messages.length - 1];
  if (toolSearch && last?.role === 'assistant' && pendingServerToolIds(messages).size > 0) {
    held.turn = turn;
    return messages;
  }
  return [...messages, { role: 'user', content: turn }];
}

// The messages after a round: the assistant content unchanged, then the
// client tool results. A round with no client tool call (a paused turn) has
// no results message; an empty user message would be rejected. A held resume
// turn (above) rides behind the results once nothing is left unresolved.
function appendRoundMessages(messages, response, results, held = {}) {
  const withAssistant = [...messages, { role: 'assistant', content: response.content }];
  if (held.turn && results.length && pendingServerToolIds(withAssistant).size === 0) {
    const turn = held.turn;
    held.turn = null;
    return [...withAssistant, { role: 'user', content: [...results, { type: 'text', text: turn }] }];
  }
  return results.length ? [...withAssistant, { role: 'user', content: results }] : withAssistant;
}

// Item 3. Doc (tool-search, "Continuing the conversation"): "send the same
// `tools` array: the search tool plus every deferred definition." The tools
// array on the search path is exactly what initialTools returns; the history's
// tool_reference blocks expand the tools. The generic resume restoration
// (re-adding definitions of tools the saved history used) would overwrite a
// deferred entry with a non-deferred copy, so it is skipped here.
function mergeRestoredTools(tools, restored, toolSearch) {
  return toolSearch ? tools : [...new Map([...tools, ...restored].map(tool => [tool.name, tool])).values()];
}

// Item 2. A search's result can arrive in a later response than its call
// (item 1), so the queries live in one map for the whole request, seeded from
// the saved history on resume.
function seedSearchQueries(resumedTask) {
  return new Map(savedBlocks(resumedTask).filter(block => block.type === 'server_tool_use').map(block => [block.id, block.input?.query]));
}

// Item 4. A saved task whose history holds search blocks needs the tool-search
// tools to continue. A login that no longer has full access cannot get them
// and the API cannot expand the history, so the resume ends here with a plain
// refusal in the same { error, code } shape claimResume uses (409), before the
// task is claimed and before any model call.
const ACCESS_CHANGED = 'This saved request used owner-only tools and this login no longer has them. Start the request again.';
function resumeAccessRefusal(task, fullAccess) {
  if (fullAccess === true || !savedBlocks(task).some(block => SEARCH_BLOCK_TYPES.has(block.type))) return null;
  return { error: ACCESS_CHANGED, code: 'access_changed' };
}

// Feeds the gap collector from the server-side search, in the shape its
// discovery() hook already reads for discover_capabilities: found = the
// referenced tools, nothing found = capability_unimplemented. An error result
// records nothing. `queries` maps a search call id to its query for the whole
// request (items 1 and 2).
function observeServerToolSearches(content, gapCollector, queries = new Map()) {
  if (!gapCollector) return;
  for (const block of content) if (block.type === 'server_tool_use') queries.set(block.id, block.input?.query);
  for (const block of content) {
    const references = block.type === 'tool_search_tool_result' ? block.content?.tool_references : null;
    if (!Array.isArray(references)) continue;
    const capabilities = references.map(reference => ActionRegistry.actions.get(reference?.tool_name)).filter(Boolean)
      .map(action => ({ id: action.id, domain: action.domain }));
    gapCollector.discovery({ query: queries.get(block.tool_use_id) },
      { status: capabilities.length ? 'capabilities_found' : 'capability_unimplemented', capabilities });
  }
}

// The API rejects a tool_reference with no matching definition in `tools`
// (400 "Tool reference 'x' not found in available tools"). A saved search
// result, or one from an earlier round, can name a tool the rebuilt list no
// longer holds (a gate turned off, access changed). Applied to the messages
// sent on every request: the reference entries naming a tool that is not in
// `tools` are dropped. The block itself and its server_tool_use stay (an empty
// tool_references list is a valid "nothing found" result). Returns new objects
// only where something changed, the same array otherwise; stored messages are
// never mutated. Calling the removed tool from memory is still refused by the
// existing guards (allowed(), capability_not_loaded, permission_denied). This
// code never puts tool_reference content in a client tool_result block, so
// those are not touched.
function isStaleSearchResult(block, available) {
  return block?.type === 'tool_search_tool_result' && Array.isArray(block.content?.tool_references)
    && block.content.tool_references.some(reference => !available.has(reference?.tool_name));
}

function withoutMissingReferences(block, available) {
  return { ...block, content: { ...block.content,
    tool_references: block.content.tool_references.filter(reference => available.has(reference?.tool_name)) } };
}

function dropMissingToolReferences(messages, tools) {
  const available = new Set(tools.map(tool => tool.name));
  let changed = false;
  const result = messages.map(message => {
    if (!Array.isArray(message.content) || !message.content.some(block => isStaleSearchResult(block, available))) return message;
    changed = true;
    return { ...message, content: message.content.map(block => (isStaleSearchResult(block, available) ? withoutMissingReferences(block, available) : block)) };
  });
  return changed ? result : messages;
}

module.exports = { pendingServerToolIds, withTerminalResponse, withResumeTurn, mergeRestoredTools, seedSearchQueries, resumeAccessRefusal, dropMissingToolReferences, toolSearchWanted, capabilitySearchLine, finishesTurn, appendRoundMessages, observeServerToolSearches, SEARCH_LINE, DISCOVER_LINE };
