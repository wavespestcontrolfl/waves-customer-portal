/**
 * Intelligence Bar — Managed Agents Ops Tools
 * server/services/intelligence-bar/managed-agents-ops-tools.js
 *
 * Read-only visibility into the autonomous Anthropic Managed Agents fleet
 * (BI briefing, blog content engine, backlink strategy, lead response,
 * customer assistant): recent sessions with status and token usage. The
 * portal's crons create these sessions itself (see bi-agent.js) — this tool
 * answers "did last night's runs succeed?" without opening the Console.
 *
 * Same raw-HTTP pattern and beta header as bi-agent.js (the installed SDK
 * predates the beta sessions surface). Read-only: sessions are LISTED,
 * never created, messaged, archived, or deleted. Session titles are
 * app-authored and can reference leads/customers — the tool is in the
 * route's PII redaction set.
 */

const logger = require('../logger');

const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
const BETA_HEADER = 'managed-agents-2026-04-01';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TITLE_LENGTH = 120;

// Known portal agents, labeled by the env vars their session managers use.
const KNOWN_AGENTS = [
  { env: 'BI_AGENT_ID', label: 'Weekly BI Briefing' },
  { env: 'CONTENT_AGENT_ID', label: 'Blog Content Engine' },
  { env: 'CONTENT_WRITER_AGENT_ID', label: 'Content Writer' },
  { env: 'CONTENT_REFRESHER_AGENT_ID', label: 'Content Refresher' },
  { env: 'CONTENT_META_REWRITER_AGENT_ID', label: 'Meta Rewriter' },
  { env: 'BACKLINK_STRATEGY_AGENT_ID', label: 'Backlink Strategy' },
  { env: 'LEAD_AGENT_ID', label: 'Lead Response' },
  { env: 'MANAGED_AGENT_ID', label: 'Customer Assistant' },
];

const MANAGED_AGENTS_OPS_TOOLS = [
  {
    name: 'get_managed_agent_runs',
    description: `Recent Anthropic Managed Agent sessions (BI briefing, blog engine, backlink, lead response, customer assistant): status (running / idle = finished or awaiting input / terminated = terminal error), timing, and token usage, labeled by agent. The "did last night's autonomous runs succeed?" check.
Use for: "did the BI briefing run?", "any agent sessions stuck or terminated?", "what did the blog engine do overnight?"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max sessions to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Anthropic API access is not configured. ANTHROPIC_API_KEY must be set in the Railway dashboard.';

function agentLabels() {
  const byId = new Map();
  for (const { env, label } of KNOWN_AGENTS) {
    const id = process.env[env];
    if (id) byId.set(id, label);
  }
  return byId;
}

async function getManagedAgentRuns(input) {
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/sessions?limit=${limit}`, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Anthropic rejected the key — check ANTHROPIC_API_KEY.');
    }
    if (!res.ok) throw new Error(`Anthropic API returned HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Anthropic API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const labels = agentLabels();
  const sessions = (json?.data || []).map(session => {
    const agentId = session.agent?.id || (typeof session.agent === 'string' ? session.agent : null);
    return {
      id: session.id,
      agent: (agentId && labels.get(agentId)) || null,
      agent_id: agentId,
      title: session.title ? String(session.title).slice(0, MAX_TITLE_LENGTH) : null,
      status: session.status,
      created_at: session.created_at || null,
      updated_at: session.updated_at || null,
      usage: session.usage
        ? { input_tokens: session.usage.input_tokens ?? null, output_tokens: session.usage.output_tokens ?? null }
        : null,
    };
  });
  const byStatus = {};
  for (const s of sessions) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  return {
    sessions,
    total: sessions.length,
    by_status: byStatus,
    note: 'idle = finished or awaiting input; terminated = terminal error state; running = active now. Sessions the agent-id map cannot label (agent: null) belong to unlisted or ad-hoc agents. Investigating a session happens in the Anthropic Console, never through this tool.',
  };
}

async function executeManagedAgentsOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.ANTHROPIC_API_KEY) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_managed_agent_runs': return await getManagedAgentRuns(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:managed-agents-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { MANAGED_AGENTS_OPS_TOOLS, executeManagedAgentsOpsTool };
