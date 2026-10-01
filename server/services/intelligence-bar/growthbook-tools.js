/**
 * Intelligence Bar — GrowthBook Experimentation Tools
 * server/services/intelligence-bar/growthbook-tools.js
 *
 * Visibility into GrowthBook: running/stopped experiments and feature flags,
 * plus one write tool, set_growthbook_feature. The earlier standing rule —
 * GrowthBook changes happen only in the GrowthBook UI, never through
 * automation — was OVERRIDDEN by the owner on 2026-09-28 (Decision 5: GrowthBook
 * flag toggles may be made from the Intelligence Bar), so the bar may now
 * propose a flag toggle through the usual confirmation card (full-access login
 * only, write-gates.js OUTSIDE_WRITE_TOOL_NAMES).
 *
 * set_growthbook_feature is PREVIEW ONLY in this change: it reads the feature
 * (GET /api/v1/features/{id}) and shows the environment's current state, but
 * called with confirmed:true it refuses (code not_yet_implemented). The commit
 * path will call GrowthBook's documented toggle endpoint —
 * POST /api/v1/features/{id}/toggle with a body of
 * { environments: { "<env>": true|false }, reason: "<why>" } — which is NOT
 * called anywhere yet. (GrowthBook marks the v1 feature endpoints deprecated in
 * favor of /v2/features; v1 is what the owner asked for and what the existing
 * read tools use.)
 *
 * Auth: GROWTHBOOK_API_KEY. The reads work with a read-only secret key; a
 * toggle will need a key with write access. GROWTHBOOK_API_BASE overrides for
 * self-hosted.
 */

const logger = require('../logger');

const GROWTHBOOK_API_BASE = process.env.GROWTHBOOK_API_BASE || 'https://api.growthbook.io';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_RULES = 10;

const GROWTHBOOK_TOOLS = [
  {
    name: 'get_growthbook_experiments',
    description: `List GrowthBook experiments with status (running, stopped, draft), hypothesis, and variation names.
Use for: "what experiments are running?", "did the hub-variant test stop?", "experiment status"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max experiments (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
        offset: { type: 'number', description: 'Skip this many results — page forward with it when has_more is true so experiments past the first page are visible.' },
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
        offset: { type: 'number', description: 'Skip this many results — page forward with it when has_more is true.' },
      },
    },
  },
  {
    name: 'set_growthbook_feature',
    description: `Propose turning a GrowthBook feature flag ON or OFF in one environment (default production). Owner login only, through a confirmation card showing the flag's current state in that environment, its default value and how many targeting rules it has.
Use for: "turn the pricing-hub flag on in production", "switch off the X feature in GrowthBook"`,
    input_schema: {
      type: 'object',
      properties: {
        feature_id: { type: 'string', description: 'The GrowthBook feature key (id), exactly as shown by get_growthbook_features' },
        enabled: { type: 'boolean', description: 'true = turn the feature ON in the environment, false = turn it OFF' },
        environment: { type: 'string', description: "GrowthBook environment name (default 'production')" },
      },
      required: ['feature_id', 'enabled'],
    },
  },
];

const NOT_YET_IMPLEMENTED_MESSAGE = 'GrowthBook flag changes cannot be committed yet — this preview cannot be confirmed. The commit path ships in a follow-up PR.';
const FEATURE_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const ENVIRONMENT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_DEFAULT_VALUE_CHARS = 120;

const NOT_CONFIGURED_MESSAGE = 'GrowthBook access is not configured. Add the GROWTHBOOK_API_KEY service variable (a GrowthBook secret key — a read-only key is enough to look, toggling a flag will need write access) in the Railway dashboard.';

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function clampOffset(offset) {
  return Math.max(Number(offset) || 0, 0);
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
  const offset = clampOffset(input.offset);
  const json = await gbGet(`/api/v1/experiments?limit=${limit}&offset=${offset}`);
  const experiments = (json.experiments || []).map(e => ({
    id: e.id,
    name: e.name,
    status: e.status,
    hypothesis: e.hypothesis || null,
    variations: (e.variations || []).map(v => v.name),
    archived: Boolean(e.archived),
  }));
  // has_more true means results were truncated — page with `offset` to see the rest.
  return { experiments, total: experiments.length, offset, has_more: Boolean(json.hasMore) };
}

// The top-level defaultValue is the feature's base default, NOT what any
// environment actually serves — an environment can be disabled or override
// the value. Surface each environment's enabled flag + effective default so
// "is X on in production?" is answerable and not confused with the base value.
function mapEnvironments(environments, featureDefault) {
  if (!environments || typeof environments !== 'object') return {};
  const out = {};
  for (const [env, cfg] of Object.entries(environments)) {
    const rules = Array.isArray(cfg?.rules) ? cfg.rules : [];
    out[env] = {
      enabled: Boolean(cfg?.enabled),
      // Effective env default: the env override if it sets one, otherwise the
      // feature-level default (an enabled env without its own defaultValue
      // serves the base default — reporting null would misread it as off).
      default_value: cfg?.defaultValue ?? featureDefault ?? null,
      // A flag can be default-off yet SERVED on via a force/rollout/experiment
      // rule (or vice-versa), so summarize the rules — otherwise "is X on in
      // production?" would be answered from default_value alone and mislead.
      rules: rules.slice(0, MAX_RULES).map(r => ({
        type: r.type || null,
        description: r.description || null,
        enabled: r.enabled !== false,
        value: r.value ?? null,
        coverage: r.coverage ?? null,
        // Experiment rules carry served values in variations/weights, not
        // `value` — without these an A/B rule looks like an enabled null.
        variations: r.variations ?? null,
        weights: r.weights ?? null,
        // Preserve targeting predicates — otherwise a narrowly-scoped rule
        // (staff-only, saved-group, prerequisite-gated, or scheduled) reads as
        // generally applicable and "is X on in production?" gets a wrong answer.
        condition: r.condition ?? null,
        saved_group_targeting: r.savedGroupTargeting ?? null,
        prerequisites: r.prerequisites ?? null,
        schedule: r.scheduleRules ?? null,
      })),
      rule_count: rules.length,
    };
  }
  return out;
}

async function getGrowthbookFeatures(input) {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const json = await gbGet(`/api/v1/features?limit=${limit}&offset=${offset}`);
  const features = (json.features || []).map(f => ({
    id: f.id,
    value_type: f.valueType,
    default_value: f.defaultValue,
    environments: mapEnvironments(f.environments, f.defaultValue),
    tags: f.tags || [],
    archived: Boolean(f.archived),
  }));
  return { features, total: features.length, offset, has_more: Boolean(json.hasMore) };
}

// Running experiments with their latest analysis, shaped for the weekly BI
// briefing: one row per experiment, one row per goal metric × variation with
// users / numerator / mean / chance-to-beat-control, plus a readiness note
// (the smallest arm across EVERY goal metric) so the briefing never dresses
// up a 7-user split as a result. Field names are GrowthBook's own — numerator
// is a conversion count only for a binomial metric; for revenue / count /
// duration it is the aggregate value and mean the value per user — so the
// metric type rides along. Shares gbGet (key, base, timeout) with the two IB
// tools above. Results are whatever the last GrowthBook refresh computed
// (dateUpdated says when) — this does not trigger an analysis.
const MIN_USERS_PER_ARM = 100;

function summariseAnalysis(a) {
  if (!a) return null;
  return {
    numerator: a.numerator ?? null,
    mean: typeof a.mean === 'number' ? Number(a.mean.toFixed(4)) : null,
    percent_change: typeof a.percentChange === 'number' ? Number((a.percentChange * 100).toFixed(1)) : null,
    ci: [a.ciLow, a.ciHigh].every((n) => typeof n === 'number') ? [Number((a.ciLow * 100).toFixed(1)), Number((a.ciHigh * 100).toFixed(1))] : null,
    chance_to_beat_control: typeof a.chanceToBeatControl === 'number' ? Number(a.chanceToBeatControl.toFixed(3)) : null,
    note: a.errorMessage || null,
  };
}

async function listAll(path, key) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const json = await gbGet(`${path}?limit=100&offset=${offset}`);
    out.push(...(json[key] || []));
    if (!json.hasMore) return out;
  }
}

function isNotFound(err) {
  return /HTTP 404/.test(String(err && err.message));
}

async function getExperimentResultsSummary() {
  const [experiments, metricRows] = await Promise.all([listAll('/api/v1/experiments', 'experiments'), listAll('/api/v1/metrics', 'metrics')]);
  const metricType = new Map(metricRows.map((m) => [m.id, m.type || null]));
  const running = experiments.filter((e) => e.status === 'running' && !e.archived);
  const out = [];
  for (const e of running) {
    let r = null;
    try {
      const json = await gbGet(`/api/v1/experiments/${encodeURIComponent(e.id)}/results`);
      r = json.result || null;
    } catch (err) {
      // Only a never-refreshed experiment ("No results found", a plain 404) is
      // experiment state; an outage / auth / rate-limit failure must surface
      // as the tool's error, not masquerade as "no analysis yet".
      if (!isNotFound(err)) throw err;
    }
    const overall = r && Array.isArray(r.results) ? r.results.find((d) => !d.dimension) || r.results[0] : null;
    const metrics = overall && Array.isArray(overall.metrics) ? overall.metrics.map((m) => ({
      metric: m.metricName || m.metricId,
      type: metricType.get(m.metricId) || (String(m.metricId).startsWith('fact__') ? 'fact' : null),
      variations: (m.variations || []).map((v) => ({
        name: v.variationName || v.variationId,
        users: v.users ?? null,
        ...summariseAnalysis((v.analyses || [])[0]),
      })),
    })) : [];
    const armSizes = metrics.flatMap((m) => m.variations.map((v) => v.users || 0));
    const minArm = armSizes.length ? Math.min(...armSizes) : 0;
    const srm = overall && overall.checks && typeof overall.checks.srm === 'number' ? overall.checks.srm : null;
    out.push({
      id: e.id,
      name: e.name,
      tracking_key: e.trackingKey,
      started: (e.phases && e.phases.length && e.phases[e.phases.length - 1].dateStarted) || null,
      hypothesis: e.hypothesis || null,
      results_updated: r ? r.dateUpdated : null,
      total_users: overall ? overall.totalUsers ?? null : null,
      srm_warning: srm !== null && srm < 0.001,
      readiness: !r ? 'no analysis yet' : minArm < MIN_USERS_PER_ARM ? `too early — smallest arm has ${minArm} users (need ${MIN_USERS_PER_ARM}+)` : 'enough traffic to read',
      metrics,
    });
  }
  return { experiments: out, running: out.length };
}

// ── set_growthbook_feature (preview only) ──────────────────────────────────

function shortValue(v) {
  if (v === undefined || v === null) return null;
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > MAX_DEFAULT_VALUE_CHARS ? `${text.slice(0, MAX_DEFAULT_VALUE_CHARS)}…` : text;
}

async function setGrowthbookFeature(input) {
  if (input.confirmed === true) {
    return { error: NOT_YET_IMPLEMENTED_MESSAGE, code: 'not_yet_implemented' };
  }
  const featureId = typeof input.feature_id === 'string' ? input.feature_id.trim() : '';
  const environment = input.environment === undefined || input.environment === null || input.environment === ''
    ? 'production' : String(input.environment).trim();
  if (!FEATURE_ID_RE.test(featureId)) {
    return { error: 'feature_id must be a GrowthBook feature key (letters, digits, dots, dashes, underscores).', code: 'invalid_feature_id' };
  }
  if (!ENVIRONMENT_RE.test(environment)) {
    return { error: 'environment must be a GrowthBook environment name such as production.', code: 'invalid_environment' };
  }
  if (typeof input.enabled !== 'boolean') {
    return { error: 'enabled must be true (turn on) or false (turn off).', code: 'invalid_enabled' };
  }

  let json;
  try {
    json = await gbGet(`/api/v1/features/${encodeURIComponent(featureId)}`);
  } catch (err) {
    // A missing flag is an answer, not an outage.
    if (isNotFound(err)) return { error: 'GrowthBook has no feature with that key. Check the exact key with get_growthbook_features.', code: 'feature_not_found' };
    throw err;
  }
  const feature = json && json.feature;
  if (!feature || typeof feature !== 'object') throw new Error('GrowthBook returned no feature for that key.');
  if (feature.archived) {
    return { error: 'That GrowthBook feature is archived, so nothing was proposed.', code: 'feature_archived' };
  }
  const envs = feature.environments && typeof feature.environments === 'object' ? feature.environments : {};
  const envCfg = Object.prototype.hasOwnProperty.call(envs, environment) ? envs[environment] : null;
  if (!envCfg || typeof envCfg !== 'object') {
    return { error: `This feature has no "${environment}" environment. Environments: ${Object.keys(envs).join(', ') || 'none'}.`, code: 'environment_not_found' };
  }
  const priorEnabled = Boolean(envCfg.enabled);
  if (priorEnabled === input.enabled) {
    return {
      error: `Feature "${feature.id || featureId}" is already ${priorEnabled ? 'ON' : 'OFF'} in ${environment} — nothing to change.`,
      code: 'already_set',
    };
  }
  const word = (b) => (b ? 'ON' : 'OFF');
  const ruleCount = Array.isArray(envCfg.rules) ? envCfg.rules.length : 0;
  return {
    preview: true,
    tool: 'set_growthbook_feature',
    feature: feature.id || featureId,
    environment,
    current_state: word(priorEnabled),
    new_state: word(input.enabled),
    change: `Feature ${feature.id || featureId} in ${environment}: ${word(priorEnabled)} → ${word(input.enabled)}`,
    default_value: shortValue(envCfg.defaultValue ?? feature.defaultValue),
    rule_count: ruleCount,
    // Pins for the commit path: the toggle must refuse if the flag was edited
    // (anywhere, including the GrowthBook UI) after this card was shown. Named
    // without a trailing "_at" so the fingerprint keeps them (it strips volatile
    // timestamp keys).
    prior_enabled: priorEnabled,
    feature_version: feature.dateUpdated || null,
    revision_version: feature.revision && feature.revision.version !== undefined ? feature.revision.version : null,
    note: `Turn GrowthBook feature ${feature.id || featureId} ${word(input.enabled)} in ${environment} (currently ${word(priorEnabled)}). This preview cannot be confirmed yet.`,
  };
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
      case 'set_growthbook_feature': return await setGrowthbookFeature(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // The write tool's refusals can echo operator-supplied text (a feature key
    // or environment), so it logs the tool name only; reads keep full logs.
    if (require('./write-gates').OUTSIDE_WRITE_TOOL_NAMES.has(toolName)) {
      logger.error(`[intelligence-bar:growthbook] Tool ${toolName} failed`);
    } else {
      logger.error(`[intelligence-bar:growthbook] Tool ${toolName} failed:`, err);
    }
    return { error: err.message };
  }
}

module.exports = { GROWTHBOOK_TOOLS, executeGrowthbookTool, getExperimentResultsSummary, MIN_USERS_PER_ARM };
