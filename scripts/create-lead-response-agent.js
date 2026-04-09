#!/usr/bin/env node

/**
 * Create the Waves lead response Managed Agent.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/create-lead-response-agent.js
 *
 * Add output to .env: LEAD_AGENT_ID=agent_xxx
 */

const { LEAD_RESPONSE_AGENT_CONFIG } = require('../server/services/lead-response-agent-config');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

async function createAgent() {
  console.log('Creating Lead Response Agent...\n');

  const res = await fetch('https://api.anthropic.com/v1/agents', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(LEAD_RESPONSE_AGENT_CONFIG),
  });

  if (!res.ok) { console.error(`API error ${res.status}:`, await res.text()); process.exit(1); }

  const agent = await res.json();
  console.log(`Agent ID:  ${agent.id}`);
  console.log(`Name:      ${agent.name}`);
  console.log(`Tools:     ${agent.tools?.length || 0}`);
  console.log(`\nAdd to .env:\n  LEAD_AGENT_ID=${agent.id}\n`);
}

createAgent().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
