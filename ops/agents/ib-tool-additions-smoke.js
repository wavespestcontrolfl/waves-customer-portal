#!/usr/bin/env node
/**
 * ib-tool-additions-smoke.js — READ-ONLY, FREE
 *
 * One live check of the Intelligence Bar's tool-addition request shape
 * (GATE_IB_TOOL_ADDITIONS, server/services/intelligence-bar/tool-additions.js).
 * It uses Anthropic's token counting endpoint only (messages.countTokens),
 * which is free and runs no model, so nothing is generated and nothing is
 * billed. It writes nothing: no database, no customer data, no gate flips.
 *
 * It builds the request the route sends on the round after a
 * discover_capabilities call that found a tool: the owner's ordinary dashboard
 * tools (no tool search: the bar's model thinks by default), a synthetic
 * question, the discover call, its real discover() result as the tool_result,
 * then the addition message the route's own helpers build
 * (createRequestState().queue + beforeCall), with the moving cache marker on
 * its last block and the beta header from requestOptions(). It counts that
 * request and the same request without the addition message, and prints:
 *   - success and both token counts (the difference is the added
 *     definitions), or the API error (a 400 means the shape is wrong);
 *   - the added tool names.
 *
 * Usage (from the repo root; the key comes from the environment only):
 *   railway run node ops/agents/ib-tool-additions-smoke.js --execute
 * Without --execute it prints the request shape (counts, no API call).
 * On a model that takes no mid-conversation tool changes it prints that and
 * exits 0 without an API call. Exit 1 = an API error.
 */
const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('../../server/config/models');
const ActionRegistry = require('../../server/services/intelligence-bar/action-registry');
const apiToolDefinition = require('../../server/services/intelligence-bar/tool-definition');
const ToolAdditions = require('../../server/services/intelligence-bar/tool-additions');

// The model is resolved exactly as the route does (`MODEL` in
// server/routes/admin-intelligence-bar.js, not exported).
const MODEL = process.env.INTELLIGENCE_BAR_MODEL || MODELS.FLAGSHIP;
const SCOPE = { role: 'admin', context: 'dashboard', fullAccess: true };
const QUERY = 'review stats';

function buildRequest() {
  const tools = ActionRegistry.initialTools('dashboard', { ...SCOPE, toolSearch: false }).map(apiToolDefinition);
  const discovered = ActionRegistry.discover({ query: QUERY }, SCOPE);
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'Show me the review stats for this month.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_smoke_1', name: 'discover_capabilities', input: { query: QUERY } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_smoke_1', content: JSON.stringify(discovered.result) }] },
  ];
  const state = ToolAdditions.createRequestState({ enabled: true, messages: history });
  state.queue(discovered.definitions.map(apiToolDefinition), tools);
  const messages = state.beforeCall(history, false);
  // The route's moving breakpoint (withCacheBreakpoint): the last block of the last message.
  const last = messages[messages.length - 1];
  const marked = [...messages.slice(0, -1), { ...last, content: [...last.content.slice(0, -1), { ...last.content[last.content.length - 1], cache_control: { type: 'ephemeral' } }] }];
  const system = [{ type: 'text', text: 'You are the Waves Intelligence Bar (shape check).', cache_control: { type: 'ephemeral', ttl: '1h' } }];
  return { tools, system, messages: marked, control: history };
}

async function count(client, label, body) {
  try {
    const result = await client.messages.countTokens({ model: MODEL, ...body }, ToolAdditions.requestOptions(body.messages));
    console.log(`${label}: success, ${result.input_tokens} input tokens`);
    return result.input_tokens;
  } catch (error) {
    console.log(`${label}: API error (status ${error.status ?? 'none'}): ${error.message}`);
    return null;
  }
}

async function main() {
  const { tools, system, messages, control } = buildRequest();
  const added = ToolAdditions.addedDefinitions(messages).map(definition => definition.name);
  console.log(`model ${MODEL}; ${tools.length} tools; added by message: ${added.join(', ') || '(none)'}`);
  if (!ToolAdditions.modelTakesToolAdditions(MODEL)) {
    console.log('this model takes no mid-conversation tool changes: the bar keeps the merge; nothing to check');
    return 0;
  }
  if (!added.length) {
    console.log(`discover('${QUERY}') found no tool outside the dashboard list; nothing to check`);
    return 0;
  }
  if (!process.argv.includes('--execute')) {
    console.log(`${messages.length} messages (last: role ${messages[messages.length - 1].role}); pass --execute to count (free)`);
    return 0;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const withAddition = await count(client, 'with the addition message', { tools, system, messages });
  const without = await count(client, 'without it (control)', { tools, system, messages: control });
  if (withAddition == null || without == null) return 1;
  console.log(`the addition message adds ${withAddition - without} input tokens`);
  return 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error.stack || error); process.exit(1); });
