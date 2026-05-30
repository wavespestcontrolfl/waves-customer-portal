#!/usr/bin/env node

/**
 * Create or update the Waves backlink strategy Managed Agent.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/create-backlink-strategy-agent.js
 *   ANTHROPIC_API_KEY=sk-ant-xxx BACKLINK_STRATEGY_AGENT_ID=agent_xxx node scripts/create-backlink-strategy-agent.js
 *
 * Add output to .env: BACKLINK_STRATEGY_AGENT_ID=agent_xxx
 */

const { BACKLINK_STRATEGY_AGENT_CONFIG } = require('../server/services/seo/backlink-strategy-agent-config');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

async function syncAgent() {
  const agentId = process.env.BACKLINK_STRATEGY_AGENT_ID;
  const updating = Boolean(agentId);
  console.log(`${updating ? 'Updating' : 'Creating'} Backlink Strategy Agent...\n`);

  const res = await fetch(`https://api.anthropic.com/v1/agents${updating ? `/${agentId}` : ''}`, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(BACKLINK_STRATEGY_AGENT_CONFIG),
  });

  if (!res.ok) { console.error(`API error ${res.status}:`, await res.text()); process.exit(1); }

  const agent = await res.json();
  console.log(`Agent ID:  ${agent.id}`);
  console.log(`Name:      ${agent.name}`);
  console.log(`Tools:     ${agent.tools?.length || 0}`);
  if (updating) {
    console.log('\nBACKLINK_STRATEGY_AGENT_ID is already set; config has been synchronized.\n');
  } else {
    console.log(`\nAdd to .env / Railway:\n  BACKLINK_STRATEGY_AGENT_ID=${agent.id}\n`);
  }
}

syncAgent().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
