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
const MODELS = require('../../config/models');
const ActionRegistry = require('./action-registry');

const SEARCH_BLOCK_TYPES = new Set(['server_tool_use', 'tool_search_tool_result']);

// Whether this request uses tool search: a FRESH request on the platform path,
// from a full-access login (never model input), with the gate on, on a model
// that does NOT think by default. A resumed task (/tasks/:id/resume,
// /tasks/:id/select-target) is never tool search.
//
// A model that thinks by default returns `thinking` blocks, and a history that
// holds search blocks AND thinking blocks cannot be rewritten for a resume: the
// docs (extended thinking, "Preserving thinking blocks") say "Pass every
// `thinking` block back to the API complete and unmodified, alongside the
// `tool_use` block it accompanied". The bar never sends a `thinking` parameter,
// so thinking blocks come only from the model's own default. With such a model
// the bar keeps the ordinary page list + discover_capabilities (as with the
// gate off), so a saved history never holds both kinds. The one predicate is
// MODELS.anthropicThinksByDefault (config/models.js, the list the max_tokens
// floor already uses); it is read at call time, and a registry mock without it
// reads as "does not think".
function toolSearchWanted(req, platformEnabled, actionScope, model) {
  return platformEnabled === true && actionScope.fullAccess === true && !req.ibResumedTask && ibToolSearchLive()
    && !(typeof MODELS.anthropicThinksByDefault === 'function' && MODELS.anthropicThinksByDefault(model));
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

// Off the search path a discover_capabilities result adds the definitions it
// found to `tools` at once (as it always did); a tool name appears once. On the
// search path nothing is added: the array never changes (toolResultContent).
function mergeDiscoveredTools(tools, definitions, toolSearch) {
  if (toolSearch) return tools;
  const present = new Set(tools.map(tool => tool.name));
  const added = [];
  for (const definition of definitions) {
    if (!present.has(definition.name)) { present.add(definition.name); added.push(definition); }
  }
  return added.length ? [...tools, ...added] : tools;
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
const isReference = block => block?.type === 'tool_reference';
const isThinkingBlock = block => block?.type === 'thinking' || block?.type === 'redacted_thinking';
const hasSearchBlock = message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(isSearchBlock);
const hasReferenceResult = message => message.role === 'user' && Array.isArray(message.content)
  && message.content.some(block => block?.type === 'tool_result' && Array.isArray(block.content) && block.content.some(isReference));
const needsStrip = message => hasSearchBlock(message) || hasReferenceResult(message);
const asBlocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

// True when a saved history holds an assistant turn with BOTH search blocks and
// thinking blocks. By construction it should never happen (toolSearchWanted is
// false for a model that thinks by default, and a request on a thinking model
// never has search blocks), but a task started under one model and resumed
// under another could meet it. Such a history cannot be rewritten (thinking
// blocks must go back unmodified), so the resume is refused (tasks.js
// continuationError) and stripServerSearchBlocks leaves it alone.
function hasSearchAndThinking(messages) {
  return (Array.isArray(messages) ? messages : []).some(message => hasSearchBlock(message) && message.content.some(isThinkingBlock));
}

// Applied wherever a saved checkpoint is loaded for a resume. Removes every
// `server_tool_use` and `tool_search_tool_result` block from every assistant
// message, resolved or not, and every `tool_reference` block from the content
// of every `tool_result` (a discover_capabilities result carries them on the
// search path; the resumed request runs on the ordinary list, where a reference
// would name a tool that is not deferred). An assistant message left with no
// content is dropped; two adjacent messages of the same role that this leaves
// are merged in order (a string becomes a text block). A trailing assistant
// message whose tool_use blocks have no tool_result is left to the existing
// resume code, exactly as for a task that never searched. Never mutates its
// input; the same array comes back when there is nothing to strip, or when the
// history is one it must not rewrite (hasSearchAndThinking).
//
// A tool_result on the search path holds tool_reference blocks ONLY (never
// mixed with other content, see toolResultContent). On a resume the references
// cannot stay (the resumed list is the ordinary one), so the result becomes the
// JSON a plain discover_capabilities result has, listing what was found as
// loaded. The resume code reads discovered tool names from exactly that shape
// (JSON.parse of `capabilities` with availability 'loaded'), so a tool found
// just before an interruption is still restored (when the login may use it).
const NO_RESULT_TEXT = 'The saved result had no text.';
function withoutReferences(block) {
  if (block?.type !== 'tool_result' || !Array.isArray(block.content) || !block.content.some(isReference)) return block;
  const rest = block.content.filter(part => !isReference(part));
  const names = block.content.filter(isReference).map(part => part.tool_name).filter(Boolean);
  if (rest.length === 0) {
    const found = { status: 'capabilities_found', capabilities: names.map(id => ({ id, availability: 'loaded' })) };
    return { ...block, content: names.length ? JSON.stringify(found) : NO_RESULT_TEXT };
  }
  return { ...block, content: rest.length === 1 && rest[0].type === 'text' ? rest[0].text : rest };
}

function strippedContent(message) {
  if (hasSearchBlock(message)) return message.content.filter(block => !isSearchBlock(block));
  return hasReferenceResult(message) ? message.content.map(withoutReferences) : message.content;
}

function stripServerSearchBlocks(messages) {
  if (!messages.some(needsStrip) || hasSearchAndThinking(messages)) return messages;
  const kept = [];
  for (const message of messages) {
    const content = strippedContent(message);
    if (Array.isArray(content) && content.length === 0) continue;
    const previous = kept[kept.length - 1];
    if (previous?.role === message.role) kept[kept.length - 1] = { ...previous, content: [...asBlocks(previous.content), ...asBlocks(content)] };
    else kept.push(content === message.content ? message : { ...message, content });
  }
  return kept;
}

// A tool search (server_tool_use) that has no result yet anywhere in the
// history. Doc (server-tools, "Mixing server tools and client tools in one
// turn"): the result can arrive in the NEXT response, and text after the
// client results would end the turn with the call unresolved.
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

// discover_capabilities on the search path. Docs (tool-search tool, "Custom tool
// search implementation"): "You can implement your own tool search logic ...
// by returning `tool_reference` blocks from a custom tool. When Claude calls
// your custom search tool, return a standard `tool_result` with
// `tool_reference` blocks in the content array", and "Every tool referenced
// must have a corresponding tool definition in the top-level `tools`
// parameter, normally with `defer_loading: true`." So on the search path the
// `tools` array NEVER changes during a request (the continuation needs the same
// tools): a found tool that is deferred in `tools` is expanded by the API from
// a reference in this result.
//
// References are NEVER mixed with other content. The live API answers a
// tool_result that holds both with 400 "Tool definitions/code execution
// functions cannot be mixed with other content" (smoke run, --discover-shape).
// So the content is one of two forms:
//  - references ONLY, when every capability the model has to READ is already a
//    tool: the deferred ones found, in discover()'s ranking order, at most
//    MAX_DISCOVER_REFERENCES. An eager tool needs no reference (its definition
//    is already in context), and a name absent from `tools` gets none.
//  - the plain JSON string otherwise: when the result holds any capability that
//    is not a loaded tool (an owner-workflow action, availability
//    `requires_existing_owner_workflow`), the model must read that answer, so it
//    gets the JSON and no references. The deferred tools named in that JSON are
//    then reached through the server tool search by name (the prompt line says
//    to search). Off the search path the content is always the JSON string.
// Only the JSON text is ever stored or logged: callers keep `result` for that.
const MAX_DISCOVER_REFERENCES = 5;
function toolResultContent(toolName, result, tools, toolSearch) {
  const text = JSON.stringify(result);
  if (!toolSearch || toolName !== ActionRegistry.DISCOVERY_TOOL.name) return text;
  const capabilities = Array.isArray(result?.capabilities) ? result.capabilities : [];
  if (capabilities.some(capability => capability?.availability !== 'loaded')) return text;
  const deferred = new Set(tools.filter(tool => tool.defer_loading === true).map(tool => tool.name));
  const references = capabilities.filter(capability => deferred.has(capability.id))
    .map(capability => ({ type: 'tool_reference', tool_name: capability.id }));
  return references.length ? references.slice(0, MAX_DISCOVER_REFERENCES) : text;
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
  hasSearchAndThinking, withTurnEndingText, hasPendingServerSearch, toolResultContent, toolSearchWanted, capabilitySearchLine, finishesTurn, appendRoundMessages, observeServerToolSearches, stripServerSearchBlocks, mergeDiscoveredTools, SEARCH_LINE, DISCOVER_LINE };
