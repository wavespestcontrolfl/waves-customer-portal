#!/usr/bin/env node
/**
 * ib-tool-search-smoke.js — READ-ONLY
 *
 * One live check of the Intelligence Bar's tool-search request shape
 * (GATE_IB_TOOL_SEARCH, server/services/intelligence-bar/action-registry.js
 * initialTools with toolSearch). It writes nothing: no database, no customer
 * data, no gate flips. It calls the Anthropic API ONCE (twice with --resume-shape), so it needs --execute.
 *
 * It builds the real full-access tools array for the dashboard page (page tools
 * eager, the API's tool search tool, every other allowed tool with
 * defer_loading), sends one non-streaming messages.create with the model the
 * Intelligence Bar uses (INTELLIGENCE_BAR_MODEL, else MODELS.FLAGSHIP) and a
 * fixed synthetic prompt, and prints:
 *   - success, or the API error message (a 400 means the request shape is wrong);
 *   - stop_reason and the block types in the response;
 *   - the search queries and the tool_references the search returned;
 *   - usage: input, cache write, cache read.
 * The prompt asks the model to search and name a tool, not to call it, so no
 * tool ever runs.
 *
 * max_tokens goes through anthropicMaxTokens() (1024 asked; the helper only
 * raises it for thinking-floor models, which an Opus tier needs). This is an
 * ops script, not a server call site: the ledgerCall wrapper that
 * llm-call-ledger-coverage.test.js enforces on server code is deliberately not
 * used, so this one call is not recorded in the LLM ledger.
 *
 * Usage (from the repo root; the key comes from the environment only):
 *   railway run node ops/agents/ib-tool-search-smoke.js --execute
 *   railway run node ops/agents/ib-tool-search-smoke.js --execute --resume-shape
 * --resume-shape adds a second request built the way a resume builds it: the
 * assistant content of call 1 with the search blocks stripped
 * (stripServerSearchBlocks), a plain user text turn, and the ordinary tools
 * list (no search tool, no defer_loading). Both requests are synthetic text.
 * Without --execute it prints the tools shape (counts, no API call).
 */
const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('../../server/config/models');
const { anthropicMaxTokens, anthropicEffortConfig } = require('../../server/services/llm/anthropic-wire');
const ActionRegistry = require('../../server/services/intelligence-bar/action-registry');
const apiToolDefinition = require('../../server/services/intelligence-bar/tool-definition');
const { stripServerSearchBlocks } = require('../../server/services/intelligence-bar/tool-search');

// The model is resolved exactly as the route does (the `MODEL` constant in
// server/routes/admin-intelligence-bar.js, not exported):
//   const MODEL = process.env.INTELLIGENCE_BAR_MODEL || MODELS.FLAGSHIP;
function resolveModel() {
  return process.env.INTELLIGENCE_BAR_MODEL
    ? { model: process.env.INTELLIGENCE_BAR_MODEL, source: 'INTELLIGENCE_BAR_MODEL' }
    : { model: MODELS.FLAGSHIP, source: 'MODELS.FLAGSHIP' };
}

const PROMPT = "Which tool would list the technicians' timesheets? Search for it and name it; do not call it.";

function buildTools() {
  return ActionRegistry.initialTools('dashboard', { role: 'admin', context: 'dashboard', fullAccess: true, toolSearch: true })
    .map(apiToolDefinition);
}

function describeContent(content) {
  const searches = content.filter((block) => block.type === 'server_tool_use').map((block) => block.input?.query);
  const references = content.filter((block) => block.type === 'tool_search_tool_result')
    .map((block) => block.content?.tool_references?.map((ref) => ref.tool_name) ?? `error: ${block.content?.error_code}`);
  return { types: content.map((block) => block.type), searches, references };
}

// One request, printed. Returns the response, or null after printing the API error.
async function send(client, label, model, source, body) {
  try {
    const response = await client.messages.create({
      model,
      ...anthropicEffortConfig(model),
      max_tokens: anthropicMaxTokens(model, 1024),
      ...body,
    });
    const { types, searches, references } = describeContent(response.content);
    const usage = response.usage || {};
    console.log(`${label} result: success (model ${model}, from ${source})`);
    console.log(`${label} stop_reason: ${response.stop_reason}`);
    console.log(`${label} block types: ${types.join(', ')}`);
    console.log(`${label} search queries: ${JSON.stringify(searches)}`);
    console.log(`${label} tool_references: ${JSON.stringify(references)}`);
    console.log(`${label} usage: input ${usage.input_tokens ?? 0}, cache write ${usage.cache_creation_input_tokens ?? 0}, cache read ${usage.cache_read_input_tokens ?? 0}, output ${usage.output_tokens ?? 0}`);
    return response;
  } catch (error) {
    console.log(`${label} result: API error (status ${error.status ?? 'none'}): ${error.message}`);
    return null;
  }
}

// What a resumed task sends (a resumed task never uses tool search): the saved
// assistant content with the search blocks stripped, a plain user turn, and the
// ORDINARY dashboard tool list (page list + discover_capabilities).
function resumeRequest(first) {
  const messages = stripServerSearchBlocks([
    { role: 'user', content: PROMPT },
    { role: 'assistant', content: first.content },
    { role: 'user', content: 'Thanks. Reply with the single word OK.' },
  ]);
  const tools = ActionRegistry.initialTools('dashboard', { role: 'admin', context: 'dashboard', fullAccess: true }).map(apiToolDefinition);
  return { tools, messages };
}

async function main() {
  const tools = buildTools();
  const deferred = tools.filter((tool) => tool.defer_loading === true).length;
  console.log(`tools: ${tools.length} (eager ${tools.length - deferred}, deferred ${deferred}), ${JSON.stringify(tools).length} bytes`);
  if (!process.argv.includes('--execute')) {
    console.log('dry run: no API call. Re-run with --execute to send one request (add --resume-shape for a second, resume-shaped one).');
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (run under `railway run`).');
    return 2;
  }
  const { model, source } = resolveModel();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const first = await send(client, 'call 1', model, source, { tools, messages: [{ role: 'user', content: PROMPT }] });
  if (!first) return 1;
  if (!process.argv.includes('--resume-shape')) return 0;
  if (first.content.some((block) => block.type === 'tool_use')) {
    console.log('call 2 skipped: call 1 ended with a client tool call, so no resume shape can be built from it.');
    return 1;
  }
  const second = await send(client, 'call 2 (resume shape)', model, source, resumeRequest(first));
  return second ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
