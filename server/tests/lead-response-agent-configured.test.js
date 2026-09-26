/**
 * isLeadAgentConfigured (services/lead-response-agent.js) — the same three
 * env checks processLead makes before opening a session, exported so the
 * lead webhook can decide ahead of time whether the standard
 * lead_auto_reply_biz reply should send immediately (agent off) or wait on
 * the agent's own outcome (agent configured). Read once at module load,
 * same as the constants processLead itself uses.
 */

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'LEAD_AGENT_ID', 'LEAD_AGENT_ENVIRONMENT_ID', 'ANTHROPIC_ENVIRONMENT_ID'];

function loadWithEnv(overrides) {
  jest.resetModules();
  const saved = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, overrides);
  const mod = require('../services/lead-response-agent');
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  return mod;
}

test('all three present → configured', () => {
  const mod = loadWithEnv({ ANTHROPIC_API_KEY: 'key', LEAD_AGENT_ID: 'agent-1', LEAD_AGENT_ENVIRONMENT_ID: 'env-1' });
  expect(mod.isLeadAgentConfigured()).toBe(true);
});

test('ANTHROPIC_ENVIRONMENT_ID fallback also counts as configured', () => {
  const mod = loadWithEnv({ ANTHROPIC_API_KEY: 'key', LEAD_AGENT_ID: 'agent-1', ANTHROPIC_ENVIRONMENT_ID: 'env-1' });
  expect(mod.isLeadAgentConfigured()).toBe(true);
});

test.each([
  ['missing ANTHROPIC_API_KEY', { LEAD_AGENT_ID: 'agent-1', LEAD_AGENT_ENVIRONMENT_ID: 'env-1' }],
  ['missing LEAD_AGENT_ID', { ANTHROPIC_API_KEY: 'key', LEAD_AGENT_ENVIRONMENT_ID: 'env-1' }],
  ['missing both environment id vars', { ANTHROPIC_API_KEY: 'key', LEAD_AGENT_ID: 'agent-1' }],
  ['nothing set', {}],
])('%s → not configured', (_label, overrides) => {
  const mod = loadWithEnv(overrides);
  expect(mod.isLeadAgentConfigured()).toBe(false);
});
