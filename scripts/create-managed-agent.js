#!/usr/bin/env node

/**
 * Create (or update) the Waves customer assistant Managed Agent.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/create-managed-agent.js
 *
 * On success, prints the agent_id. Add it to your .env as:
 *   MANAGED_AGENT_ID=agent_xxx
 */

const { AGENT_CONFIG } = require('../server/services/ai-assistant/managed-agent-config');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY env var');
  process.exit(1);
}

async function createAgent() {
  console.log('Creating Managed Agent: waves-customer-assistant...\n');

  const res = await fetch('https://api.anthropic.com/v1/agents', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(AGENT_CONFIG),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`API error ${res.status}:`, err);
    process.exit(1);
  }

  const agent = await res.json();
  console.log('Agent created successfully!\n');
  console.log(`  Agent ID:  ${agent.id}`);
  console.log(`  Name:      ${agent.name}`);
  console.log(`  Model:     ${agent.model}`);
  console.log(`  Tools:     ${agent.tools?.length || 0} configured`);
  console.log(`\nAdd this to your .env:\n`);
  console.log(`  MANAGED_AGENT_ID=${agent.id}`);
  console.log('');
}

createAgent().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
