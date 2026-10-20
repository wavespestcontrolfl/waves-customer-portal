'use strict';

/**
 * Rules for the Intelligence Bar's OpenAI backup (GATE_IB_OPENAI_BACKUP; the
 * wire work is openai-tool-adapter.js). The /query route calls these at the one
 * place it calls the model; the loop, executors and confirmation cards do not
 * change.
 *
 * WHEN: only when the Anthropic call itself throws a provider error. A 400 is a
 * provider error only when it says the account is out of room (usage limit,
 * credit, billing): that was the 10-19 monthly-limit case. Any other 400 is a
 * request this server built wrongly, and a second provider would hide the bug.
 *
 * ONE PROVIDER PER SAVED TASK: a request that switched marks its saved task
 * `model_provider: 'openai_backup'` (in the task's `request`, IbTasks.markModelProvider,
 * written at the switch so even an interrupted request carries it). A resume of that task
 * continues on the backup, or, with the gate off, is refused as not resumable
 * (tasks.js continuationError) so the operator starts again. A saved history is
 * never sent half to each provider.
 */
const ToolSearch = require('./tool-search');
const ActionRegistry = require('./action-registry');
const apiToolDefinition = require('./tool-definition');
const { gapReportPromptLine } = require('../agent-gap-reports');

const BACKUP_PROVIDER = 'openai_backup';
const ANSWER_LINE = '(answered by the backup model)';

// A 400 that means the account is out of room, not that the request is malformed.
const OUT_OF_ROOM_RE = /usage limit|credit balance|billing|quota|spend limit|rate limit|regain access|insufficient|out of (credit|funds)/i;
const PROVIDER_STATUSES = new Set([401, 402, 403, 404, 408, 409, 429]);

function isProviderError(err) {
  if (!err) return false;
  const status = Number(err.status ?? err.statusCode);
  if (Number.isInteger(status) && status >= 100) {
    if (status >= 500 || PROVIDER_STATUSES.has(status)) return true;
    if (status === 400) return OUT_OF_ROOM_RE.test(String(err.message || '')) || OUT_OF_ROOM_RE.test(JSON.stringify(err.error || ''));
    return false;
  }
  // No HTTP status: the SDK's connection and timeout errors.
  const name = String(err.name || '');
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' || name === 'TimeoutError'
    || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(err.code || err.cause?.code || ''));
}

function taskOnBackup(task) {
  return task?.request?.model_provider === BACKUP_PROVIDER;
}

// Tools the request already loaded through tool search or discovery, by name:
// the ones the model called, the ones a search found and the ones a
// discover_capabilities result loaded. Read BEFORE the search blocks are stripped.
function loadedToolNames(messages) {
  const blocks = (Array.isArray(messages) ? messages : []).flatMap(m => (Array.isArray(m?.content) ? m.content : []));
  const invoked = blocks.filter(b => b?.type === 'tool_use').map(b => b.name);
  const referenced = blocks.filter(b => b?.type === 'tool_result' && Array.isArray(b.content))
    .flatMap(b => b.content.filter(part => part?.type === 'tool_reference').map(part => part.tool_name));
  const discoveryIds = new Set(blocks.filter(b => b?.type === 'tool_use' && b.name === ActionRegistry.DISCOVERY_TOOL.name).map(b => b.id));
  const discovered = blocks.filter(b => b?.type === 'tool_result' && discoveryIds.has(b.tool_use_id) && typeof b.content === 'string')
    .flatMap(b => { try { return JSON.parse(b.content)?.capabilities || []; } catch { return []; } })
    .filter(c => c?.availability === 'loaded').map(c => c.id);
  return [...new Set([...invoked, ...referenced, ...discovered, ...ToolSearch.searchReferencedNames(messages)].filter(Boolean))];
}

const usesToolSearch = tools => (tools || []).some(tool => tool?.defer_loading === true || (tool?.type && tool.type !== 'custom'));

/**
 * What the request runs on after the switch: { tools, messages, toolSearch }.
 * Tool search off: a request on the search path gets the ordinary page list
 * plus discover_capabilities, plus any tool it already loaded and the login may
 * still use. A request not on the search path keeps its tools. The history loses
 * the server search blocks; client tool_use / tool_result pairs stay.
 */
function backupRequestState({ tools, messages, context, actionScope }) {
  let nextTools = tools;
  if (usesToolSearch(tools)) {
    const loaded = loadedToolNames(messages).map(name => ActionRegistry.actions.get(name))
      .filter(action => action && ActionRegistry.allowed(action, actionScope)).map(action => apiToolDefinition(action.definition));
    const ordinary = ActionRegistry.initialTools(context, { ...actionScope, toolSearch: false }).map(apiToolDefinition);
    nextTools = [...new Map([...ordinary, ...loaded].map(tool => [tool.name, tool])).values()];
  }
  return { tools: nextTools, messages: ToolSearch.stripServerSearchBlocks(messages), toolSearch: false };
}

// The same prompt, with the two sentences that name the Anthropic tool search
// tool swapped for their discover_capabilities forms (the backup has no search).
function backupSystemPrompt(systemPrompt) {
  let text = String(systemPrompt || '').split(ToolSearch.SEARCH_LINE).join(ToolSearch.DISCOVER_LINE);
  const searchLine = gapReportPromptLine({ toolSearch: true });
  const discoverLine = gapReportPromptLine({ toolSearch: false });
  if (searchLine && searchLine !== discoverLine) text = text.split(searchLine).join(discoverLine);
  return text;
}

module.exports = { isProviderError, taskOnBackup, backupRequestState, backupSystemPrompt, loadedToolNames, BACKUP_PROVIDER, ANSWER_LINE };
