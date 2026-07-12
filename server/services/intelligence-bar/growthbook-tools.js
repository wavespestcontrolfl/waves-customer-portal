/**
 * Intelligence Bar — GrowthBook Experimentation Tools
 * server/services/intelligence-bar/growthbook-tools.js
 *
 * Read-only visibility into GrowthBook: running/stopped experiments and
 * feature flags. Reads only — the standing rule is that GrowthBook changes
 * happen in the GrowthBook UI by the owner, never through automation, so
 * this module deliberately has no mutation surface at all.
 *
 * Auth: GROWTHBOOK_API_KEY (a read-only secret key is sufficient and
 * preferred). GROWTHBOOK_API_BASE overrides for self-hosted.
 */

const logger = require('../logger');

const GROWTHBOOK_API_BASE = process.env.GROWTHBOOK_API_BASE || 'https://api.growthbook.io';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const GROWTHBOOK_TOOLS = [
  {
    name: 'get_growthbook_experiments',
    description: `List GrowthBook experiments with status (running, stopped, draft), hypothesis, and variation names.
Use for: "what experiments are running?", "did the hub-variant test stop?", "experiment status"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max experiments (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_growthbook_features',
    description: `List GrowthBook feature flags with their type, default value, and tags.
Use for: "what feature flags exist in GrowthBook?", "is the pricing-hub flag on by default?"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max features (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'GrowthBook access is not configured. Add the GROWTHBOOK_API_KEY service variable (a read-only GrowthBook secret key) in the Railway dashboard.';

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

async function gbGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GROWTHBOOK_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${process.env.GROWTHBOOK_API_KEY}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('GrowthBook rejected the key — check GROWTHBOOK_API_KEY.');
    }
    if (!res.ok) throw new Error(`GrowthBook API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`GrowthBook API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getGrowthbookExperiments(input) {
  const limit = clampLimit(input.limit);
  const json = await gbGet(`/api/v1/experiments?limit=${limit}`);
  const experiments = (json.experiments || []).map(e => ({
    id: e.id,
    name: e.name,
    status: e.status,
    hypothesis: e.hypothesis || null,
    variations: (e.variations || []).map(v => v.name),
    archived: Boolean(e.archived),
  }));
  return { experiments, total: experiments.length, has_more: Boolean(json.hasMore) };
}

async function getGrowthbookFeatures(input) {
  const limit = clampLimit(input.limit);
  const json = await gbGet(`/api/v1/features?limit=${limit}`);
  const features = (json.features || []).map(f => ({
    id: f.id,
    value_type: f.valueType,
    default_value: f.defaultValue,
    tags: f.tags || [],
    archived: Boolean(f.archived),
  }));
  return { features, total: features.length, has_more: Boolean(json.hasMore) };
}

async function executeGrowthbookTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.GROWTHBOOK_API_KEY) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_growthbook_experiments': return await getGrowthbookExperiments(input);
      case 'get_growthbook_features': return await getGrowthbookFeatures(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:growthbook] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { GROWTHBOOK_TOOLS, executeGrowthbookTool };
