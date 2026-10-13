'use strict';

/**
 * Helpers for the Anthropic API's tool search on the Intelligence Bar's
 * full-access path (GATE_IB_TOOL_SEARCH; shape built in action-registry.js
 * initialTools). Pure helpers the /query tool loop calls; they hold the rules
 * so the loop itself gains no branches.
 *
 * ONE RULE FOR SAVED TASKS: a resumed task never uses tool search. Tool search
 * lives inside one live request (several rounds). Whatever is saved at the end
 * of a request (the checkpoint) is stripped of the search blocks when it is
 * loaded (stripServerSearchBlocks), and the resumed request runs on the
 * ordinary tool list with discover_capabilities. That removes every way a
 * saved history can hold a search call without its result, a result that names
 * a tool that is gone, or a paused turn the API must be sent back as is.
 *
 * API facts these rely on (Anthropic tool search docs):
 *  - The model's search runs on Anthropic's side. The assistant content then
 *    holds `server_tool_use` (id srvtoolu_..., name tool_search_tool_bm25) and
 *    `tool_search_tool_result` blocks. They are NOT `tool_use` blocks: the
 *    loop never executes them and never sends a `tool_result` for them.
 *  - Within a live request the assistant content is passed back UNCHANGED,
 *    with the same tools.
 *  - A search with no match returns an empty `tool_references` list, not an
 *    error; an error result carries `tool_search_tool_result_error`.
 *  - A turn may end with stop_reason `pause_turn`; the assistant content is
 *    sent back as is and the request continues.
 */
const { ibToolSearchLive } = require('../../config/feature-gates');
const ActionRegistry = require('./action-registry');

const SEARCH_BLOCK_TYPES = new Set(['server_tool_use', 'tool_search_tool_result']);

// Whether this request uses tool search: a FRESH request on the platform path,
// from a full-access login (never model input), with the gate on. A resumed
// task (/tasks/:id/resume, /tasks/:id/select-target) is never tool search.
function toolSearchWanted(req, platformEnabled, actionScope) {
  return platformEnabled === true && actionScope.fullAccess === true && !req.ibResumedTask && ibToolSearchLive();
}

// The system prompt sentence that tells the model how to reach other tools.
// Deterministic for the same page + login + gate state: the prompt is part of
// the cached prefix.
const DISCOVER_LINE = 'Use discover_capabilities to load tools from any other domain before saying a capability is unavailable.';
const SEARCH_LINE = 'Every admin capability is available to you through the tool search tool: customers and properties, schedule and dispatch, estimates, invoices and billing, leads, texts, calls and email, inventory, reviews, dashboards and reports, SEO and content, banking and tax, and outside services. Search with a short description of what you need. If the search finds nothing, call discover_capabilities once before saying a capability is unavailable: it also knows owner-workflow actions that are not tools.';
function capabilitySearchLine(toolSearch) {
  return toolSearch ? SEARCH_LINE : DISCOVER_LINE;
}

// A turn that stops with pause_turn and no client tool call is not finished:
// the loop continues with the assistant content as is.
function finishesTurn(response, toolUses) {
  return toolUses.length === 0 && response.stop_reason !== 'pause_turn';
}

// discover_capabilities stays eager on the search path (the route to actions
// that are not callable tools, such as owner-workflow ones). A tool it finds
// must be callable on the next round, so its schema has to be loaded: a
// deferred definition stays hidden from the model until a search references
// it. A found tool that is deferred is therefore REPLACED in place by its
// loaded definition; a found tool that is not in `tools` yet is appended. A
// tool name appears once either way.
function mergeDiscoveredTools(tools, definitions) {
  const found = new Map(definitions.map(definition => [definition.name, definition]));
  const present = new Set(tools.map(tool => tool.name));
  let changed = false;
  const merged = tools.map((tool) => {
    if (tool.defer_loading !== true || !found.has(tool.name)) return tool;
    changed = true;
    return found.get(tool.name);
  });
  for (const [name, definition] of found) {
    if (!present.has(name)) { merged.push(definition); changed = true; }
  }
  return changed ? merged : tools;
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
// records nothing. `queries` maps a search call id to its query for the whole
// request: with a client tool in the same turn the result arrives in a LATER
// response than the call (server-tools doc, "Mixing server tools and client
// tools in one turn": "they arrive in two different responses, and the
// `server_tool_use` block is not repeated in the second one").
function observeServerToolSearches(content, gapCollector, queries = new Map()) {
  if (!gapCollector) return;
  for (const block of content) if (block.type === 'server_tool_use') queries.set(block.id, block.input?.query);
  for (const block of content) {
    const references = block.type === 'tool_search_tool_result' ? block.content?.tool_references : null;
    if (!Array.isArray(references)) continue;
    const capabilities = references.map(reference => ActionRegistry.actions.get(reference?.tool_name)).filter(Boolean)
      .map(action => ({ id: action.id, domain: action.domain }));
    gapCollector.discovery({ query: queries.get(block.tool_use_id) },
      { status: capabilities.length ? 'capabilities_found' : 'capability_unimplemented', capabilities }, { fromToolSearch: true });
  }
}

const isSearchBlock = block => SEARCH_BLOCK_TYPES.has(block?.type);
const hasSearchBlock = message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(isSearchBlock);
const asBlocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

// Applied wherever a saved checkpoint is loaded for a resume. Removes every
// `server_tool_use` and `tool_search_tool_result` block from every assistant
// message, resolved or not; an assistant message left with no content is
// dropped; two adjacent messages of the same role that this leaves are merged
// in order (a string becomes a text block). A trailing assistant message whose
// tool_use blocks have no tool_result is left to the existing resume code,
// exactly as for a task that never searched. Never mutates its input; the same
// array comes back when there is nothing to strip.
//
// An assistant turn that holds `thinking` / `redacted_thinking` blocks must go
// back to the API unchanged, or not carry them: a signed thinking block inside
// a modified turn is rejected (400). So every assistant message this function
// REWRITES (blocks removed, or merged with a neighbor) also loses its thinking
// blocks. Messages it does not touch keep theirs.
const isThinkingBlock = block => block?.type === 'thinking' || block?.type === 'redacted_thinking';
const withoutThinking = content => asBlocks(content).filter(block => !isThinkingBlock(block));

function strippedContent(message) {
  if (!hasSearchBlock(message)) return message.content;
  return message.content.filter(block => !isSearchBlock(block) && !isThinkingBlock(block));
}

function mergedContent(previous, content, role) {
  const parts = [asBlocks(previous.content), asBlocks(content)];
  return (role === 'assistant' ? parts.map(withoutThinking) : parts).flat();
}

function stripServerSearchBlocks(messages) {
  if (!messages.some(hasSearchBlock)) return messages;
  const kept = [];
  for (const message of messages) {
    const content = strippedContent(message);
    if (Array.isArray(content) && content.length === 0) continue;
    const previous = kept[kept.length - 1];
    if (previous?.role === message.role) kept[kept.length - 1] = { ...previous, content: mergedContent(previous, content, message.role) };
    else kept.push(content === message.content ? message : { ...message, content });
  }
  return kept;
}

// A tool search (server_tool_use) that has no result yet anywhere in the
// history. Doc (server-tools, "Mixing server tools and client tools in one
// turn"): the result can arrive in the NEXT response, and the continuation
// must "keep the same `tools` array", so nothing may change the array while one
// is pending.
function hasPendingServerSearch(messages) {
  const open = new Set();
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'server_tool_use') open.add(block.id);
      else if (block.type === 'tool_search_tool_result') open.delete(block.tool_use_id);
    }
  }
  return open.size > 0;
}

// What discover_capabilities found. Off the search path the definitions merge
// at once (as before). On the search path they are HELD and merged only at a
// round boundary where no server search is pending (releaseHeld).
function holdDiscovered(tools, held, definitions, toolSearch) {
  return toolSearch ? { tools, held: [...held, ...definitions] } : { tools: mergeDiscoveredTools(tools, definitions), held };
}

// Called before every request: merge the held definitions once nothing is pending.
function releaseHeld(tools, held, messages) {
  if (held.length === 0 || hasPendingServerSearch(messages)) return { tools, held };
  return { tools: mergeDiscoveredTools(tools, held), held: [] };
}

// The discover result says the found tools are "loaded". When a server search is
// still pending in this turn the definitions arrive one step later, so the
// result says not to call them in this step.
const HELD_NOTE = 'A tool search is still running in this turn, so the tools listed here become callable only after it finishes. Do not call them in this step.';
function discoverResult(result, messages, toolSearch) {
  return toolSearch && hasPendingServerSearch(messages) ? { ...result, note: `${result.note} ${HELD_NOTE}` } : result;
}

// Text added after client tool results ends the assistant turn. While a
// server search of that turn is still unresolved, the API rejects that (400),
// so the step-limit note is not added then; `tool_choice: none` still applies.
function withTurnEndingText(messages, text) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content) || hasPendingServerSearch(messages)) return messages;
  return [...messages.slice(0, -1), { ...last, content: [...last.content, { type: 'text', text }] }];
}

module.exports = {
  withTurnEndingText, hasPendingServerSearch, holdDiscovered, releaseHeld, discoverResult, toolSearchWanted, capabilitySearchLine, finishesTurn, appendRoundMessages, observeServerToolSearches, stripServerSearchBlocks, mergeDiscoveredTools, SEARCH_LINE, DISCOVER_LINE };
