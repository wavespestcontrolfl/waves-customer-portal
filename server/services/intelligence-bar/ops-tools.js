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
 *
 * set_railway_gate (owner ruling 2026-09-28, Decision 5: GATE_* changes may
 * be made from the bar) proposes setting ONE known GATE_* variable on the
 * portal's own production service to 'true' or 'false'. The preview reads
 * the one variable's live value and never returns, logs or pins any other
 * variable's value. Confirmed, it acts ONLY on the `_verified_railway_*`
 * pins (service, environment, gate name, value, prior state): it re-resolves
 * the production target and refuses unless the ids still match, re-reads the
 * variable and refuses unless its prior state is unchanged (a non-boolean
 * prior compares by keyed digest), then calls Railway's
 * `variableUpsert(input: { projectId, environmentId, serviceId, name, value })`
 * with deploys left on — Railway redeploys the portal with the new value
 * (verified against the public API schema via `railway api describe`).
 * Railway has no conditional write, so the re-read narrows the race window
 * but cannot close it. A read-only token refuses as write_access_required.
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
  {
    name: 'set_railway_gate',
    description: `Propose setting ONE known feature gate (a GATE_* variable) to the literal value 'true' or 'false' on the portal's production service in Railway. Owner login only, through a confirmation card showing the current value, the new value, what the gate controls and what the new value means. Railway redeploys the portal when a variable changes (a brief restart). Only gates the portal already knows AND has a description for are accepted — a made-up name, a mode gate or an undocumented gate is refused (those change in the Railway dashboard).
The value is the RAW variable value, not "on/off". Some gates are inverted: a name ending in _OFF, _DISABLE, _DISABLED or _KILL_SWITCH means 'true' turns the named thing OFF (GATE_LATE_PAYMENT_CHECKER_OFF=true disables the late-payment checker). Map what the operator wants to HAPPEN through the gate's meaning; if it is unclear which value they want, ask before proposing.
Use for: "set GATE_X to true", "turn the Y feature on" (after mapping it to the right value), "flip the gate for Z"`,
    input_schema: {
      type: 'object',
      properties: {
        gate_name: { type: 'string', description: 'The gate variable name, e.g. GATE_SOMETHING (capitals, digits and underscores)' },
        value: { type: 'string', enum: ['true', 'false'], description: "The literal variable value to set. For an inverted gate (name ends in _OFF / _DISABLE / _DISABLED / _KILL_SWITCH) 'true' DISABLES the named thing." },
      },
      required: ['gate_name', 'value'],
    },
  },
];

const GATE_NAME_RE = /^GATE_[A-Z0-9_]+$/;
const PORTAL_SERVICE_NAME = 'waves-customer-portal';
const MAX_GATE_SUGGESTIONS = 5;

const READ_ONLY_TOKEN_MESSAGE = 'The Railway token cannot make this change — it needs write access (deploy/restart and variable changes) before this action can commit.';
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

// ── set_railway_gate ────────────────────────────────────────

// The ONLY service this tool may touch: the portal's own production service.
// Never a caller-supplied service — the environment must be named
// "production" and the service is the one Railway injects as
// RAILWAY_SERVICE_ID (or, off-Railway, the one service named
// waves-customer-portal). Anything else refuses.
async function resolvePortalProductionTarget() {
  const { projectId, environmentId } = await resolveIds();
  const { environmentName, services } = await getServiceInstances();
  if (String(environmentName || '').trim().toLowerCase() !== 'production') {
    throw new Error('Gate changes are only available on the production environment, and this Railway token is not scoped to it.');
  }
  let service = process.env.RAILWAY_SERVICE_ID
    ? services.find((s) => s.serviceId === process.env.RAILWAY_SERVICE_ID)
    : null;
  if (!service) {
    const named = services.filter((s) => (s.serviceName || '').trim().toLowerCase() === PORTAL_SERVICE_NAME);
    if (named.length === 1) [service] = named;
  }
  if (!service) throw new Error('Could not identify the portal service in the production environment, so no gate change was proposed.');
  return {
    projectId,
    environment: { id: environmentId, name: environmentName },
    service: { id: service.serviceId, name: service.serviceName },
  };
}

// Reads the variables map for the portal service and extracts the ONE
// requested key. Railway returns the whole name→value map (secrets
// included) and has no single-variable read, so the map stays inside this
// function: nothing but the one gate's own value leaves it, and it is never
// logged.
async function readOneVariable(target, name) {
  const data = await railwayGraphQL(
    `query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { projectId: target.projectId, environmentId: target.environment.id, serviceId: target.service.id },
  );
  const vars = data?.variables;
  if (!vars || typeof vars !== 'object') throw new Error('Railway returned no variables for the portal service.');
  return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
}

// A keyed digest, so the commit path can tell "still the same non-boolean
// value" without the value ever being displayed, pinned or logged.
function valueDigest(raw) {
  return require('crypto')
    .createHmac('sha256', process.env.JWT_SECRET || 'ib-gate-prior-value')
    .update(String(raw)).digest('hex').slice(0, 16);
}

// The prior state a card pins and a confirm re-checks: its kind, the value
// only when it is plain 'true' / 'false', and a keyed digest (never the
// value) when it is anything else.
function describePrior(raw) {
  if (raw === undefined || raw === null) return { prior_kind: 'unset', prior_value: null, prior_value_digest: null };
  if (raw === 'true' || raw === 'false') return { prior_kind: 'boolean', prior_value: raw, prior_value_digest: null };
  return { prior_kind: 'non_boolean', prior_value: null, prior_value_digest: valueDigest(raw) };
}

// How the runtime reads a set value: true (on), false (off), or null when
// that cannot be said for sure. 'true' / 'false' read the same under every
// reader. Any other value is judged only for a gate this portal reads solely
// through gateEnvValue ('1' / 'true' / 'on', any case); a strict or mixed
// gate could be read differently by another module, so it stays unknown.
function gateReadsOn(reader, raw) {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (reader === 'loose') return ['1', 'true', 'on'].includes(String(raw).toLowerCase());
  return null;
}

function knownGateOrRefusal(rawName) {
  const catalog = require('../../config/feature-gates').knownGateCatalog();
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const entry = GATE_NAME_RE.test(name) ? catalog.get(name) : null;
  if (entry) return { entry };
  // Never echo the operator's raw string; only names from the portal's own
  // gate list are offered back.
  const needle = String(rawName || '').trim().toUpperCase().replace(/^GATE_/, '');
  const close = needle.length >= 3
    ? [...catalog.keys()].filter((n) => n.includes(needle)).sort().slice(0, MAX_GATE_SUGGESTIONS)
    : [];
  return {
    refusal: {
      error: `That is not a feature gate this portal knows, so nothing was proposed (a new variable is never created from here).${close.length ? ` Close matches: ${close.join(', ')}.` : ''}`,
      code: 'unknown_gate',
    },
  };
}

// Which known gates the bar may flip, checked at preview AND at confirm:
// only a plain on/off gate (a mode gate — shadow / auto / a timestamp — or one
// whose reading cannot be verified is changed in the Railway dashboard), and
// only one with a description on file, so the card can say what it does
// (Codex r2 on #5514: no approving a money or messaging gate blind).
function gateNotFlippable(entry) {
  if (!entry.boolean) {
    return {
      error: entry.kind === 'mode'
        ? `${entry.name} takes a mode or timestamp, not just on/off — change it in the Railway dashboard.`
        : `${entry.name} is a known gate, but the portal's code does not show it is a plain on/off switch, so it cannot be flipped from here — change it in the Railway dashboard.`,
      code: 'not_a_boolean_gate',
    };
  }
  if (!entry.description) {
    return {
      error: `${entry.name} has no description in the portal's gate list, so the bar cannot show what it does and will not flip it — change it in the Railway dashboard (or add its line to the header of server/config/feature-gates.js).`,
      code: 'no_gate_description',
    };
  }
  return null;
}

async function setRailwayGate(input) {
  if (input.confirmed === true) return commitRailwayGate(input);
  const known = knownGateOrRefusal(input.gate_name);
  if (known.refusal) return known.refusal;
  const { entry } = known;
  if (input.value !== 'true' && input.value !== 'false') {
    return { error: "value must be exactly 'true' or 'false'.", code: 'invalid_value' };
  }
  const refusal = gateNotFlippable(entry);
  if (refusal) return refusal;

  const target = await resolvePortalProductionTarget();
  const raw = await readOneVariable(target, entry.name);
  const prior = describePrior(raw);
  const currentKind = prior.prior_kind;
  const priorValue = prior.prior_value;

  // Judge "already set" the way the runtime reads this gate, so '1' / 'on' /
  // 'TRUE' under a gateEnvValue reader count as on (a no-op, not a change
  // and a redeploy). The non-boolean value itself is never echoed.
  const readsOn = gateReadsOn(entry.reader, raw);
  if (currentKind !== 'unset' && readsOn !== null && String(readsOn) === input.value) {
    return {
      already_set: true,
      code: 'already_set',
      message: currentKind === 'boolean'
        ? `${entry.name} is already set to ${priorValue} in production — nothing to change.`
        : `${entry.name} already reads as ${input.value} in production (the portal's own parsing of its current value) — nothing to change.`,
    };
  }
  const currentLabel = currentKind === 'boolean' ? priorValue
    : currentKind === 'unset' ? 'unset' : 'set to a non-boolean value';
  return {
    preview: true,
    tool: 'set_railway_gate',
    gate: entry.name,
    controls: entry.description,
    current_value: currentLabel,
    new_value: input.value,
    change: `${entry.name}: ${currentLabel} → ${input.value}`,
    // Only the literal variable change — never a synthesized ON/OFF claim
    // (Codex r3 on #5489): a gate can have prerequisites or a shadow mode, so
    // what a value does is whatever the code reading it does (see `controls`).
    // An inverted-looking name (…_OFF) gets a caution, not a claim.
    meaning: `Sets the Railway variable ${entry.name} to '${input.value}'. What that does is decided by the code that reads it — see "controls" above; it does not by itself mean the feature is ${input.value === 'true' ? 'on' : 'off'}.${entry.inverted ? " The name suggests 'true' turns something OFF." : ''}`,
    inverted: entry.inverted === true,
    redeploy_notice: 'Railway redeploys the portal when a variable changes, so the portal restarts briefly.',
    // The pinned target and prior state (compare-and-swap inputs for the
    // commit path, which must refuse if any of them changed).
    target: {
      service_id: target.service.id,
      service: target.service.name,
      environment_id: target.environment.id,
      environment: target.environment.name,
    },
    ...prior,
    note: `Set ${entry.name} to ${input.value} on the portal's production service (currently ${currentLabel}).`,
  };
}

const GATE_CHANGED_MESSAGE = 'The gate changed after the card was shown (its value or the portal service is no longer what the card named). Nothing was written — ask again for a fresh confirmation card.';

// Confirmed set_railway_gate: acts ONLY on the pins /confirm-action derived
// from the fingerprint-verified live preview — never on gate_name / value
// from this call's own input (untrusted here).
async function commitRailwayGate(input) {
  const name = input._verified_railway_gate_name;
  const value = input._verified_railway_gate_value;
  const serviceId = input._verified_railway_service_id;
  const environmentId = input._verified_railway_environment_id;
  if (!name || !serviceId || !environmentId || !input._verified_railway_gate_prior_kind || !['true', 'false'].includes(value)) {
    return {
      error: 'Missing the verified gate change for this confirmed action — ask again for a fresh confirmation card.',
      code: 'missing_verified_pin',
    };
  }
  // The gate must still be a known, described, plain on/off gate (a later
  // deploy could have retired it, shown it takes a mode, or dropped its doc).
  const entry = require('../../config/feature-gates').knownGateCatalog().get(name);
  const refusal = entry ? gateNotFlippable(entry) : { error: `${name} is no longer a gate this portal knows, so nothing was written.`, code: 'unknown_gate' };
  if (refusal) return refusal;
  const target = await resolvePortalProductionTarget();
  // Compare-and-swap (best effort): the same service + environment, and the
  // live prior state exactly as the card pinned it.
  const live = target.service.id === serviceId && target.environment.id === environmentId
    ? describePrior(await readOneVariable(target, name))
    : null;
  if (!live
    || live.prior_kind !== input._verified_railway_gate_prior_kind
    || live.prior_value !== (input._verified_railway_gate_prior ?? null)
    || live.prior_value_digest !== (input._verified_railway_gate_prior_digest ?? null)) {
    return { error: GATE_CHANGED_MESSAGE, code: 'target_changed', preview_changed: true };
  }
  try {
    await railwayGraphQL(
      `mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
      { input: { projectId: target.projectId, environmentId, serviceId, name, value } },
      { forWrite: true },
    );
  } catch (err) {
    // Only a permission refusal proves nothing changed. Any other error once
    // the request went out (timeout, drop, 5xx, even a GraphQL error raised
    // after the variable saved) may have applied it — never report "failed".
    if (err.writeAccessRequired) throw err;
    return {
      outcome_unknown: true,
      warning: `Railway did not confirm the change to ${name}. Check the variable in the Railway dashboard before trying again.`,
    };
  }
  return {
    success: true,
    tool: 'set_railway_gate',
    gate: name,
    value,
    service_id: serviceId,
    environment_id: environmentId,
    redeploy_notice: 'Railway is redeploying the portal with the new value; it restarts briefly and the change takes effect once the new deploy is live.',
  };
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
      case 'set_railway_gate': return await setRailwayGate(input);
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
