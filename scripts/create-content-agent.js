#!/usr/bin/env node

/**
 * Create the Waves blog content Managed Agent.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/create-content-agent.js
 *
 * On success, prints the agent_id. Add it to your .env as:
 *   CONTENT_AGENT_ID=agent_xxx
 */

const { CONTENT_AGENT_CONFIG } = require('../server/services/content/content-agent-config');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY env var');
  process.exit(1);
}

async function createAgent() {
  console.log('Creating Content Agent: waves-content-engine...\n');

  const res = await fetch('https://api.anthropic.com/v1/agents', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(CONTENT_AGENT_CONFIG),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`API error ${res.status}:`, err);
    process.exit(1);
  }

  const agent = await res.json();
  console.log('Content Agent created!\n');
  console.log(`  Agent ID:  ${agent.id}`);
  console.log(`  Name:      ${agent.name}`);
  console.log(`  Model:     ${agent.model}`);
  console.log(`  Tools:     ${agent.tools?.length || 0} configured`);
  console.log(`\nAdd to .env:\n`);
  console.log(`  CONTENT_AGENT_ID=${agent.id}`);
  console.log('');
}

createAgent().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
