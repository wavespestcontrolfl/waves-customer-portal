#!/usr/bin/env node
/**
 * ib-tool-search-smoke.js — READ-ONLY
 *
 * One live check of the Intelligence Bar's tool-search request shape
 * (GATE_IB_TOOL_SEARCH, server/services/intelligence-bar/action-registry.js
 * initialTools with toolSearch). It writes nothing: no database, no customer
 * data, no gate flips. It calls the Anthropic API ONCE, so it needs --execute.
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
 * Without --execute it prints the tools shape (counts, no API call).
 */
const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('../../server/config/models');
const { anthropicMaxTokens, anthropicEffortConfig } = require('../../server/services/llm/anthropic-wire');
const ActionRegistry = require('../../server/services/intelligence-bar/action-registry');
const apiToolDefinition = require('../../server/services/intelligence-bar/tool-definition');

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

async function main() {
  const tools = buildTools();
  const deferred = tools.filter((tool) => tool.defer_loading === true).length;
  console.log(`tools: ${tools.length} (eager ${tools.length - deferred}, deferred ${deferred}), ${JSON.stringify(tools).length} bytes`);
  if (!process.argv.includes('--execute')) {
    console.log('dry run: no API call. Re-run with --execute to send one request.');
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (run under `railway run`).');
    return 2;
  }
  const { model, source } = resolveModel();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const response = await client.messages.create({
      model,
      ...anthropicEffortConfig(model),
      max_tokens: anthropicMaxTokens(model, 1024),
      tools,
      messages: [{ role: 'user', content: PROMPT }],
    });
    const { types, searches, references } = describeContent(response.content);
    const usage = response.usage || {};
    console.log(`result: success (model ${model}, from ${source})`);
    console.log(`stop_reason: ${response.stop_reason}`);
    console.log(`block types: ${types.join(', ')}`);
    console.log(`search queries: ${JSON.stringify(searches)}`);
    console.log(`tool_references: ${JSON.stringify(references)}`);
    console.log(`usage: input ${usage.input_tokens ?? 0}, cache write ${usage.cache_creation_input_tokens ?? 0}, cache read ${usage.cache_read_input_tokens ?? 0}, output ${usage.output_tokens ?? 0}`);
    return 0;
  } catch (error) {
    console.log(`result: API error (status ${error.status ?? 'none'}): ${error.message}`);
    return 1;
  }
}

main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
