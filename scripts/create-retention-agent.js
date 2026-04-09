#!/usr/bin/env node
const { RETENTION_AGENT_CONFIG } = require('../server/services/retention-agent-config');
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

async function createAgent() {
  console.log('Creating Retention Agent...\n');
  const res = await fetch('https://api.anthropic.com/v1/agents', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY, 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01', 'content-type': 'application/json',
    },
    body: JSON.stringify(RETENTION_AGENT_CONFIG),
  });
  if (!res.ok) { console.error(`API error ${res.status}:`, await res.text()); process.exit(1); }
  const agent = await res.json();
  console.log(`Agent ID:  ${agent.id}\nName:      ${agent.name}\nTools:     ${agent.tools?.length || 0}`);
  console.log(`\nAdd to .env:\n  RETENTION_AGENT_ID=${agent.id}\n`);
}

createAgent().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
