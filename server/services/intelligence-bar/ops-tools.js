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
 * redeploy_railway_service / restart_railway_service (IB scope expansion
 * item 1, owner ruling 2026-09-28) are the outside-write tools: structurally
 * two-step (write-gates.js OUTSIDE_WRITE_TOOL_NAMES), full-access-only
 * (ib-access.js ibFullAccess, enforced in routes/admin-intelligence-bar.js —
 * not here). Confirmed, each acts ONLY on the pinned identifiers
 * /confirm-action verified against the live preview's fingerprint
 * (`_verified_railway_service_id` / `_verified_railway_deployment_id`,
 * threaded in by admin-intelligence-bar.js) — never a re-resolve of
 * service_name from the confirmed call's own input. Redeploy calls Railway's
 * `serviceInstanceRedeploy(serviceId, environmentId)` mutation; restart calls
 * `deploymentRestart(id)` on the pinned latest-deployment id — Railway's
 * restart mutation targets a DEPLOYMENT, not a service, so restart pins the
 * deployment id rather than the service id (verified live against the
 * Railway public API schema via `railway api describe`). RAILWAY_TOKEN needs
 * write access for either mutation to succeed; a 401/403 (or a permission-
 * shaped GraphQL error) surfaces as a plain "the token is read-only" error.
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
  {
    name: 'redeploy_railway_service',
    description: `Redeploy a Railway service from its latest successful image (a fresh deploy of what is already built, not a rebuild). Owner login only, through a confirmation card.
Use for: "redeploy the server", "kick the portal service", "roll the deploy again"`,
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service to redeploy (default: the portal server service)' },
      },
    },
  },
  {
    name: 'restart_railway_service',
    description: `Restart a Railway service's running instance (no new deploy — the same build, process restarted). Owner login only, through a confirmation card.
Use for: "restart the server", "bounce the portal service", "it's hung, restart it"`,
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Service to restart (default: the portal server service)' },
      },
    },
  },
];

const READ_ONLY_TOKEN_MESSAGE = 'The Railway token cannot deploy or restart — it needs write access (a token with deploy/restart permission) before this action can commit.';
// GraphQL reports an authorization failure as HTTP 200 + errors[]; match the
// message shapes Railway uses for it.
const RAILWAY_PERMISSION_ERROR_RE = /not authorized|unauthori[sz]ed|forbidden|permission|access denied|insufficient/i;

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

async function railwayGraphQL(query, variables = {}, { forWrite = false } = {}) {
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
    if (forWrite && (res.status === 401 || res.status === 403)) {
      const err = new Error(READ_ONLY_TOKEN_MESSAGE);
      err.status = res.status;
      err.writeAccessRequired = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Railway API returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (json.errors && json.errors.length) {
      if (forWrite && RAILWAY_PERMISSION_ERROR_RE.test(String(json.errors[0].message || ''))) {
        const err = new Error(READ_ONLY_TOKEN_MESSAGE);
        err.writeAccessRequired = true;
        throw err;
      }
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
// READ-only fuzzy fallback (substring) — the write tools use
// resolveServiceExact below instead (pre-push audit #5275).
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

const MAX_SERVICE_SUGGESTIONS = 5;

// Exact (case-insensitive, trimmed) match ONLY when a name is given — never
// the substring fallback resolveService uses (pre-push audit #5275): a
// fuzzy match could name one service on the card while a later re-resolve
// of the same raw string picks a different one. The no-name defaults
// (RAILWAY_SERVICE_ID, the only service) are unchanged — those are
// deterministic, not a guess. `%`/`_` in the input are literal characters.
async function resolveServiceExact(serviceName) {
  const { services } = await getServiceInstances();
  if (!services.length) throw new Error('No services found in the Railway environment.');

  if (serviceName) {
    const needle = String(serviceName).trim().toLowerCase();
    const exact = services.filter(s => (s.serviceName || '').trim().toLowerCase() === needle);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`Multiple Railway services are exactly named "${serviceName}" — this should not happen; contact engineering. Candidates: ${exact.map(s => s.serviceName).join(', ')}.`);
    }
    const suggestions = services
      .filter(s => (s.serviceName || '').toLowerCase().includes(needle))
      .slice(0, MAX_SERVICE_SUGGESTIONS)
      .map(s => s.serviceName);
    const hint = suggestions.length ? ` Close matches: ${suggestions.join(', ')}.` : ` Available: ${services.map(s => s.serviceName).join(', ')}`;
    throw new Error(`No Railway service found exactly named "${serviceName}".${hint}`);
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
  // Map serviceId → name so every row can be attributed to a service — a
  // failed deploy in a multi-service environment is useless without knowing
  // which service failed.
  let nameById;
  if (input.service_name) {
    const service = await resolveService(input.service_name);
    deploymentsInput.serviceId = service.serviceId;
    serviceLabel = service.serviceName;
    nameById = { [service.serviceId]: service.serviceName };
  } else {
    const { services } = await getServiceInstances();
    nameById = Object.fromEntries(services.map(s => [s.serviceId, s.serviceName]));
  }
  const data = await railwayGraphQL(
    `query deployments($input: DeploymentListInput!, $first: Int!) {
      deployments(input: $input, first: $first) {
        edges { node { id status createdAt serviceId } }
      }
    }`,
    { input: deploymentsInput, first: limit },
  );
  const deployments = (data?.deployments?.edges || []).map(e => ({
    id: e.node.id,
    service: nameById[e.node.serviceId] || e.node.serviceId || null,
    status: e.node.status,
    created_at: e.node.createdAt,
  }));
  return { service: serviceLabel, deployments, total: deployments.length };
}

async function getRailwayLogs(input) {
  // Always resolve the deployment through the environment-scoped service
  // path — never accept a caller-supplied deployment id. A raw id would let a
  // broadly-scoped account token (RAILWAY_API_TOKEN) read logs from a
  // deployment outside this portal's project/environment.
  const service = await resolveService(input.service_name);
  const serviceLabel = service.serviceName;
  const deploymentId = service.latestDeployment?.id;
  if (!deploymentId) throw new Error(`Service "${service.serviceName}" has no deployment to read logs from.`);

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
    service: serviceLabel,
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

// Shared preview/commit for redeploy/restart — the structural
// two-step gate (write-gates.js OUTSIDE_WRITE_TOOL_NAMES). Full access is
// enforced by the route, not here (ib-access.js ibFullAccess).
async function writeRailwayService(toolName, input) {
  if (input.confirmed !== true) {
    const service = await resolveServiceExact(input.service_name);
    return {
      preview: true,
      tool: toolName,
      // The pinned canonical identity (id + exact name) — never the
      // operator's raw string — is what the confirmed commit acts on.
      service: {
        id: service.serviceId,
        service: service.serviceName,
        // The pinned exact deployment id — deployed_at (below) is stripped
        // from the fingerprint as a volatile `_at` field, so without this
        // the fingerprint bound to nothing distinguishing WHICH deployment
        // is "latest": a new deploy landing between preview and confirm
        // would go undetected as drift (codex r3 P1 on #5275).
        latest_deployment_id: service.latestDeployment?.id || null,
        latest_deployment_status: service.latestDeployment?.status || 'NONE',
        deployed_at: service.latestDeployment?.createdAt || null,
      },
      note: toolName === 'redeploy_railway_service'
        ? `Redeploy "${service.serviceName}" from its latest successful image (currently ${service.latestDeployment?.status || 'NONE'}).`
        : `Restart "${service.serviceName}"'s running instance — no new deploy, the same build restarts.`,
    };
  }
  // Confirmed: act ONLY on the pinned service id + latest-deployment id that
  // /confirm-action verified against the live preview above — never
  // re-resolve service_name from this call's own input (untrusted here).
  const pinnedServiceId = input._verified_railway_service_id;
  const pinnedDeploymentId = input._verified_railway_deployment_id;
  if (!pinnedServiceId) {
    return {
      error: 'Missing the verified service identity for this confirmed action — ask again for a fresh confirmation card.',
      code: 'missing_verified_pin',
    };
  }
  // Re-read the environment and re-assert the pin under this call: the
  // service must still exist and its latest deployment must still be the one
  // the card showed. A deploy that landed in the gap means the card's
  // "currently <status>" is stale — refuse rather than act on a newer build.
  const { environmentId } = await resolveIds();
  const { services } = await getServiceInstances();
  const live = services.find((s) => s.serviceId === pinnedServiceId);
  if (!live || (live.latestDeployment?.id || null) !== (pinnedDeploymentId || null)) {
    return {
      error: 'The Railway service changed after the card was shown (a new deployment landed or the service is gone). Ask again for a fresh confirmation card.',
      code: 'target_changed',
      preview_changed: true,
    };
  }
  if (toolName === 'redeploy_railway_service') {
    await railwayGraphQL(
      `mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }`,
      { serviceId: pinnedServiceId, environmentId },
      { forWrite: true },
    );
    return { success: true, tool: toolName, service_id: pinnedServiceId, redeployed_from_deployment_id: pinnedDeploymentId || null };
  }
  // Restart targets a DEPLOYMENT (Railway has no service-level restart
  // mutation), so it needs a deployment to bounce.
  if (!pinnedDeploymentId) {
    return {
      error: `Service "${live.serviceName}" has no deployment to restart.`,
      code: 'no_deployment',
    };
  }
  await railwayGraphQL(
    `mutation deploymentRestart($id: String!) { deploymentRestart(id: $id) }`,
    { id: pinnedDeploymentId },
    { forWrite: true },
  );
  return { success: true, tool: toolName, service_id: pinnedServiceId, restarted_deployment_id: pinnedDeploymentId };
}

async function executeOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state (no token yet), not a
  // failure. Returning an { error } result here would count against the
  // SHARED admin circuit breaker (the /query loop records any result.error as
  // a tool failure), so a few Infra Check clicks before the token is set could
  // trip the breaker and fast-fail unrelated Intelligence Bar tools. Surface a
  // benign, non-error result instead.
  if (!getAuthHeaders()) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_railway_status': return await getRailwayStatus();
      case 'get_railway_deployments': return await getRailwayDeployments(input);
      case 'get_railway_logs': return await getRailwayLogs(input);
      case 'get_railway_variable_names': return await getRailwayVariableNames(input);
      case 'redeploy_railway_service':
      case 'restart_railway_service':
        return await writeRailwayService(toolName, input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Outside-write refusals can echo operator/model-supplied target text
    // (a zone, project, service, domain or assignee — possibly customer
    // text), so those log the tool and status only; the operator still gets
    // the full message (Codex r5 on #5275). Read tools keep full logs.
    if (require('./write-gates').OUTSIDE_WRITE_TOOL_NAMES.has(toolName)) {
      logger.error(`[intelligence-bar:ops] Tool ${toolName} failed (status=${err.status || 'n/a'})`);
    } else {
      logger.error(`[intelligence-bar:ops] Tool ${toolName} failed:`, err);
    }
    return { error: err.message, ...(err.writeAccessRequired ? { code: 'write_access_required' } : {}) };
  }
}

module.exports = { OPS_TOOLS, executeOpsTool };
