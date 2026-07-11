/**
 * Intelligence Bar — Railway Infrastructure Ops Tools
 * server/services/intelligence-bar/ops-tools.js
 *
 * Read-only visibility into the Railway deployment the portal runs on:
 * per-service deploy status, recent deployments, runtime logs, and
 * environment-variable NAMES (values are never fetched into a response).
 *
 * Uses the Railway public GraphQL API (backboard.railway.com/graphql/v2)
 * authenticated with a project token in RAILWAY_TOKEN (scoped to one
 * project + environment). RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID /
 * RAILWAY_SERVICE_ID are injected by Railway at runtime; when absent
 * (local dev) the ids are discovered via the projectToken query.
 *
 * There are NO write operations here — no restarts, no redeploys, no
 * variable changes. Anything that mutates infrastructure must go through
 * the write-gate mechanism (issue #1568) and is intentionally not built.
 */

const logger = require('../logger');

const RAILWAY_GRAPHQL_URL = process.env.RAILWAY_GRAPHQL_URL || 'https://backboard.railway.com/graphql/v2';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 500;
const MAX_LOG_MESSAGE_CHARS = 500;
const MAX_DEPLOYMENTS = 25;

const OPS_TOOLS = [
  {
    name: 'get_railway_status',
    description: `Get the live Railway infrastructure status: every service in the environment with its latest deployment status (SUCCESS, FAILED, CRASHED, BUILDING, DEPLOYING, REMOVED...) and when it deployed.
Use for: "is the portal up?", "did the last deploy succeed?", "infrastructure status", "what's running on Railway?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_railway_deployments',
    description: `List recent Railway deployments (newest first) with status and timestamp. Optionally filter to one service by name.
Use for: "recent deploys", "when did we last deploy?", "any failed deployments this week?"`,
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service name to filter by (omit for all services in the environment)' },
        limit: { type: 'number', description: `Max deployments to return (default 10, max ${MAX_DEPLOYMENTS})` },
      },
    },
  },
  {
    name: 'get_railway_logs',
    description: `Get runtime logs from a Railway deployment (defaults to the latest deployment of the portal's own service). Supports Railway's log filter syntax — e.g. "@level:error" for errors only, or a plain search term.
Use for: "any errors in the logs?", "show me the last 100 log lines", "search the logs for Stripe", "what happened around 6am?"`,
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service to read logs from (default: the portal server service)' },
        deployment_id: { type: 'string', description: 'Specific deployment id (default: the latest deployment)' },
        filter: { type: 'string', description: 'Railway log filter, e.g. "@level:error" or a search term' },
        since_minutes: { type: 'number', description: 'Only logs from the last N minutes' },
        limit: { type: 'number', description: `Max log lines (default ${DEFAULT_LOG_LINES}, max ${MAX_LOG_LINES})` },
      },
    },
  },
  {
    name: 'get_railway_variable_names',
    description: `List the NAMES of environment variables configured on a Railway service — values are never returned. Useful to check whether a variable (e.g. a model override or feature gate) is set in production.
Use for: "is MODEL_DEEP set in prod?", "what env vars does the server have?", "is the GATE_IB_UI_CONFIRM flag configured?"`,
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service to inspect (default: the portal server service)' },
      },
    },
  },
];

// Discovered ids are cached for the process lifetime — a project token maps
// to exactly one project + environment, so they cannot change under us.
let cachedTokenIds = null;

const NOT_CONFIGURED_MESSAGE = 'Railway access is not configured. Add the RAILWAY_TOKEN service variable (a Railway project token) in the Railway dashboard.';

function getAuthHeaders() {
  if (process.env.RAILWAY_TOKEN) {
    // Project token — scoped to one project + environment.
    return { 'Project-Access-Token': process.env.RAILWAY_TOKEN };
  }
  if (process.env.RAILWAY_API_TOKEN) {
    // Account/team token (broader scope) — supported but not the default setup.
    return { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` };
  }
  return null;
}

async function railwayGraphQL(query, variables = {}) {
  const authHeaders = getAuthHeaders();
  if (!authHeaders) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(RAILWAY_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Railway API returned HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error(`Railway API error: ${json.errors[0].message}`);
    }
    return json.data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Railway API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Project + environment ids: Railway injects RAILWAY_PROJECT_ID and
// RAILWAY_ENVIRONMENT_ID into every service at runtime. Off-Railway (local
// dev) a project token can discover its own scope via the projectToken query.
async function resolveIds() {
  if (process.env.RAILWAY_PROJECT_ID && process.env.RAILWAY_ENVIRONMENT_ID) {
    return {
      projectId: process.env.RAILWAY_PROJECT_ID,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    };
  }
  if (cachedTokenIds) return cachedTokenIds;
  if (!process.env.RAILWAY_TOKEN) {
    // No project token: either nothing is configured at all, or an
    // account token is set without the ids it needs for scoping.
    throw new Error(process.env.RAILWAY_API_TOKEN
      ? 'RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_ID are required when using RAILWAY_API_TOKEN.'
      : NOT_CONFIGURED_MESSAGE);
  }
  const data = await railwayGraphQL('query { projectToken { projectId environmentId } }');
  if (!data?.projectToken?.projectId) {
    throw new Error('Could not resolve the Railway project from the token.');
  }
  cachedTokenIds = {
    projectId: data.projectToken.projectId,
    environmentId: data.projectToken.environmentId,
  };
  return cachedTokenIds;
}

async function getServiceInstances() {
  const { environmentId } = await resolveIds();
  const data = await railwayGraphQL(
    `query environment($id: String!) {
      environment(id: $id) {
        id
        name
        serviceInstances {
          edges { node { serviceId serviceName latestDeployment { id status createdAt } } }
        }
      }
    }`,
    { id: environmentId },
  );
  const env = data?.environment;
  if (!env) throw new Error('Railway environment not found — check the token scope.');
  return {
    environmentName: env.name,
    services: (env.serviceInstances?.edges || []).map(e => e.node),
  };
}

// Resolve which service a query targets: explicit name match first, then the
// service the portal itself runs as (RAILWAY_SERVICE_ID), then the only
// service if there is just one. Ambiguity returns the list to choose from.
async function resolveService(serviceName) {
  const { services } = await getServiceInstances();
  if (!services.length) throw new Error('No services found in the Railway environment.');

  if (serviceName) {
    const needle = String(serviceName).toLowerCase();
    const match = services.find(s => (s.serviceName || '').toLowerCase() === needle)
      || services.find(s => (s.serviceName || '').toLowerCase().includes(needle));
    if (!match) {
      throw new Error(`No Railway service matching "${serviceName}". Available: ${services.map(s => s.serviceName).join(', ')}`);
    }
    return match;
  }
  if (process.env.RAILWAY_SERVICE_ID) {
    const own = services.find(s => s.serviceId === process.env.RAILWAY_SERVICE_ID);
    if (own) return own;
  }
  if (services.length === 1) return services[0];
  throw new Error(`Multiple Railway services — specify service_name. Available: ${services.map(s => s.serviceName).join(', ')}`);
}

async function getRailwayStatus() {
  const { environmentName, services } = await getServiceInstances();
  return {
    environment: environmentName,
    services: services.map(s => ({
      service: s.serviceName,
      latest_deployment_status: s.latestDeployment?.status || 'NONE',
      deployed_at: s.latestDeployment?.createdAt || null,
    })),
    total_services: services.length,
  };
}

async function getRailwayDeployments(input) {
  const { projectId, environmentId } = await resolveIds();
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), MAX_DEPLOYMENTS);
  const deploymentsInput = { projectId, environmentId };
  let serviceLabel = 'all services';
  if (input.service_name) {
    const service = await resolveService(input.service_name);
    deploymentsInput.serviceId = service.serviceId;
    serviceLabel = service.serviceName;
  }
  const data = await railwayGraphQL(
    `query deployments($input: DeploymentListInput!, $first: Int!) {
      deployments(input: $input, first: $first) {
        edges { node { id status createdAt } }
      }
    }`,
    { input: deploymentsInput, first: limit },
  );
  const deployments = (data?.deployments?.edges || []).map(e => ({
    id: e.node.id,
    status: e.node.status,
    created_at: e.node.createdAt,
  }));
  return { service: serviceLabel, deployments, total: deployments.length };
}

async function getRailwayLogs(input) {
  let deploymentId = input.deployment_id;
  let serviceLabel = null;
  if (!deploymentId) {
    const service = await resolveService(input.service_name);
    serviceLabel = service.serviceName;
    deploymentId = service.latestDeployment?.id;
    if (!deploymentId) throw new Error(`Service "${service.serviceName}" has no deployment to read logs from.`);
  }

  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
  const variables = { deploymentId, limit };
  let params = '$deploymentId: String!, $limit: Int!';
  let args = 'deploymentId: $deploymentId, limit: $limit';
  if (input.filter) {
    variables.filter = String(input.filter);
    params += ', $filter: String!';
    args += ', filter: $filter';
  }
  if (input.since_minutes) {
    variables.startDate = new Date(Date.now() - Number(input.since_minutes) * 60 * 1000).toISOString();
    params += ', $startDate: DateTime!';
    args += ', startDate: $startDate';
  }

  const data = await railwayGraphQL(
    `query deploymentLogs(${params}) {
      deploymentLogs(${args}) { timestamp message severity }
    }`,
    variables,
  );
  const logs = (data?.deploymentLogs || []).map(l => ({
    timestamp: l.timestamp,
    severity: l.severity,
    message: typeof l.message === 'string' && l.message.length > MAX_LOG_MESSAGE_CHARS
      ? `${l.message.slice(0, MAX_LOG_MESSAGE_CHARS)}…[truncated]`
      : l.message,
  }));
  return {
    ...(serviceLabel ? { service: serviceLabel } : {}),
    deployment_id: deploymentId,
    filter: input.filter || null,
    lines: logs,
    total: logs.length,
  };
}

async function getRailwayVariableNames(input) {
  const { projectId, environmentId } = await resolveIds();
  const service = await resolveService(input.service_name);
  const data = await railwayGraphQL(
    // The variables query returns a name→value JSON map. Only the NAMES leave
    // this function — values are secrets and must never reach the model,
    // the response payload, or the logs.
    `query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { projectId, environmentId, serviceId: service.serviceId },
  );
  const names = Object.keys(data?.variables || {}).sort();
  return {
    service: service.serviceName,
    variable_names: names,
    total: names.length,
    note: 'Names only — values are never exposed through the Intelligence Bar.',
  };
}

async function executeOpsTool(toolName, input = {}) {
  try {
    switch (toolName) {
      case 'get_railway_status': return await getRailwayStatus();
      case 'get_railway_deployments': return await getRailwayDeployments(input);
      case 'get_railway_logs': return await getRailwayLogs(input);
      case 'get_railway_variable_names': return await getRailwayVariableNames(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { OPS_TOOLS, executeOpsTool };
