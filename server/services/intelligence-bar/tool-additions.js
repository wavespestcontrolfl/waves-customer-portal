/**
 * Mid-conversation tool additions for the Intelligence Bar
 * (GATE_IB_TOOL_ADDITIONS, read at call time).
 *
 * The API renders `tools` first, so a request whose `tools` array differs from
 * the one before it reads nothing from the prompt cache. Off the tool search
 * path (a model that thinks by default, or a login without tool search), every
 * discover_capabilities round that found a tool used to add it to `tools`, and
 * the next round wrote the whole prompt again (tools + system + history) at
 * the cache-write price. On the call ledger (Oct 2026) each such round wrote
 * tens of thousands of tokens again and ran about three times slower than a
 * round that read its prefix from the cache.
 *
 * With the gate on, `tools` stays as sent for the whole request, and a found
 * tool is offered by a `role: "system"` message of `tool_addition` blocks that
 * carry its definition (platform.claude.com/docs/en/build-with-claude/
 * mid-conversation-system-messages, "Define tools in a message"; beta header
 * inline-tools-2026-09-15). The message goes in just before the next model
 * call, after the tool results it follows, and is never edited or removed
 * later: a sent system message is part of the cached prefix, and editing it
 * would also void the thinking blocks of every later assistant turn.
 *
 * Placement (the API refuses any other): right after a user turn (one that
 * carries tool results counts), before an assistant turn or at the end, and
 * never right after a paused assistant turn. The final round adds nothing: it
 * sends tool_choice none, so no tool can run there.
 *
 * Two readers cannot take the message and get the definitions folded back
 * into `tools` instead: the OpenAI backup (ib-openai-backup.js) and a resumed
 * request on a model that does not take mid-conversation tool changes.
 */
const MODELS = require('../../config/models');
const gates = require('../../config/feature-gates');

const INLINE_TOOLS_BETA = 'inline-tools-2026-09-15';

// Both read at call time. A test's whole-module mock that lacks a reader
// reads as off / unsupported, so the request keeps the merge into `tools`.
function modelTakesToolAdditions(model) {
  return typeof MODELS.anthropicSupportsMidConversationTools === 'function' && MODELS.anthropicSupportsMidConversationTools(model);
}

// On the platform path, off tool search, on a model that takes additions: a
// request uses them when the gate is on, or when it resumes a saved history
// (`saved`, the raw checkpoint) that already holds one. That task keeps the
// path it started on whatever the gate reads now (a rollback mid-task), since
// its saved thinking blocks were checked against the `tools` it sent.
function toolAdditionsWanted({ platformEnabled, toolSearch, model, saved }) {
  const live = typeof gates.ibToolAdditionsLive === 'function' && gates.ibToolAdditionsLive();
  const started = Array.isArray(saved) && saved.some(isAdditionMessage);
  return platformEnabled === true && toolSearch !== true && (live || started) && modelTakesToolAdditions(model);
}

const isAdditionMessage = message => message?.role === 'system' && Array.isArray(message.content)
  && message.content.some(block => block?.type === 'tool_addition');

// Every definition the history's addition messages carry, in order.
function addedDefinitions(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isAdditionMessage)
    .flatMap(message => message.content)
    .filter(block => block?.type === 'tool_addition' && block.tool?.type === 'tool_definition' && block.tool.definition?.name)
    .map(block => block.tool.definition);
}

function additionMessage(definitions) {
  return { role: 'system', content: definitions.map(definition => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition } })) };
}

// The SDK request options for one call: the beta header whenever the messages
// it sends hold an addition (a resumed history too, whatever the gate reads).
function requestOptions(messages) {
  return (Array.isArray(messages) ? messages : []).some(isAdditionMessage)
    ? { headers: { 'anthropic-beta': INLINE_TOOLS_BETA } }
    : undefined;
}

// `tools` with every added definition merged back in (a later definition of a
// name replaces an earlier one, as the API applies them) and the history
// without the addition messages: the shape for a reader that knows no
// tool_addition. A history with nothing to fold comes back as the same arrays.
function foldAdditions({ tools, messages, pending = [] }) {
  const definitions = [...addedDefinitions(messages), ...pending];
  if (!definitions.length) return { tools, messages };
  const merged = new Map((tools || []).map(tool => [tool.name, tool]));
  for (const definition of definitions) merged.set(definition.name, definition);
  return { tools: [...merged.values()], messages: messages.filter(message => !isAdditionMessage(message)) };
}

// A request that ended on a plain answer right after an addition message is
// saved ending on that system message (the final answer is not part of the
// saved messages), and a resume adds a user turn, which may not follow one
// (400). The resume drops it: nothing after it is saved, so no saved thinking
// block's prefix changes, and the tools it offered come back in a new
// addition after the continuation turn (restore). Any other history comes
// back as the same array.
function withoutTrailingAddition(messages) {
  return isAdditionMessage(messages[messages.length - 1]) ? messages.slice(0, -1) : messages;
}

// A resumed request whose saved history holds addition messages, on a model
// that cannot read them (the model setting changed since the save): the
// additions go back into `tools`. Any other request comes back unchanged.
function forModel({ tools, messages, model }) {
  if (modelTakesToolAdditions(model) || !messages.some(isAdditionMessage)) return { tools, messages };
  return foldAdditions({ tools, messages });
}

/**
 * One /query request's additions. `enabled` = toolAdditionsWanted() for it;
 * `messages` = the history it starts from (a resumed one may hold additions).
 *   offers(name)          the tool was added (sent or still waiting)
 *   queue(defs, tools)    on: keeps the definitions `tools` and the earlier
 *                         additions do not hold, for the next round, and returns
 *                         true; off: false (the caller merges into `tools`)
 *   restore(defs, tools)  a resume's tools to restore: on, queued like a find,
 *                         so `tools` stays as the original request sent it (the
 *                         saved thinking blocks were checked against it); off,
 *                         merged into `tools`, as before. Returns the tools to send.
 *   beforeCall(h, final)  the messages for the next model call: the waiting
 *                         definitions appended as one addition message when
 *                         the history lets one follow
 *   pending()             the waiting definitions (the OpenAI backup folds them)
 *   stop()                after a switch to the OpenAI backup: later finds
 *                         merge into `tools`, nothing waits
 */
function createRequestState({ enabled, messages }) {
  let on = enabled === true;
  let waiting = [];
  const added = new Set(addedDefinitions(messages).map(definition => definition.name));
  function queue(definitions, tools) {
    if (!on) return false;
    const present = new Set((tools || []).map(tool => tool.name));
    for (const definition of definitions) {
      if (present.has(definition.name) || added.has(definition.name)) continue;
      added.add(definition.name);
      waiting.push(definition);
    }
    return true;
  }
  return {
    offers: name => added.has(name),
    queue,
    restore(definitions, tools) {
      if (queue(definitions, tools)) return tools;
      return [...new Map([...tools, ...definitions].map(tool => [tool.name, tool])).values()];
    },
    beforeCall(history, finalRound) {
      if (!on || finalRound || !waiting.length || history[history.length - 1]?.role !== 'user') return history;
      const next = [...history, additionMessage(waiting)];
      waiting = [];
      return next;
    },
    pending: () => waiting,
    stop() { on = false; waiting = []; },
  };
}

module.exports = {
  INLINE_TOOLS_BETA,
  modelTakesToolAdditions,
  toolAdditionsWanted,
  isAdditionMessage,
  addedDefinitions,
  additionMessage,
  requestOptions,
  foldAdditions,
  withoutTrailingAddition,
  forModel,
  createRequestState,
};
