/**
 * Intelligence Bar — Cloudflare Edge Ops Tools
 * server/services/intelligence-bar/cloudflare-ops-tools.js
 *
 * Read-only visibility into the Cloudflare edge in front of the hub and the
 * 15-site spoke fleet: zone status, Pages build status per project, and
 * edge 5xx rates for a zone.
 *
 * Auth: reuses the CF_API_TOKEN (+ CF_ACCOUNT_ID for Pages) already
 * configured for the content-astro Pages poller. If the token lacks a scope
 * a tool needs (e.g. Analytics Read for edge errors), that tool surfaces the
 * permission error and the others keep working — extend the token in the
 * Cloudflare dashboard rather than minting a second one.
 *
 * There are NO write operations here — no cache purges, DNS changes, or
 * deployment retries. Anything that mutates edge state must go through the
 * write-gate mechanism (issue #1568) and is intentionally not built.
 */

const logger = require('../logger');

const CF_API_BASE = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_ERROR_MINUTES = 60;
const MAX_ERROR_MINUTES = 24 * 60;
const MAX_ZONES = 50;
const MAX_PAGES_PROJECTS = 25;

const CLOUDFLARE_OPS_TOOLS = [
  {
    name: 'get_cloudflare_zones',
    description: `List the Cloudflare zones (domains) on the account with their status — active, paused, pending. Covers the hub and all spoke-site domains.
Use for: "are all the domains healthy?", "is bradenton site's zone active?", "any paused zones?"`,
    input_schema: {
      type: 'object',
      properties: {
        zone_name: { type: 'string', description: 'Filter to one zone by (partial) domain name' },
      },
    },
  },
  {
    name: 'get_cloudflare_pages_builds',
    description: `Get the latest deployment status for Cloudflare Pages projects (the spoke-site fleet): build stage, success/failure, and when it deployed.
Use for: "did the spoke builds finish?", "any failed Pages builds?", "when did the bradenton site last deploy?"`,
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Filter to one Pages project by (partial) name' },
      },
    },
  },
  {
    name: 'get_cloudflare_edge_errors',
    description: `Get edge traffic health for one zone over a recent window (default 60 min): total requests and 5xx responses served at the edge. Uses Cloudflare's sampled analytics dataset.
Use for: "is the site throwing errors at the edge?", "traffic spike or attack on the hub?"`,
    input_schema: {
      type: 'object',
      properties: {
        zone_name: { type: 'string', description: 'Zone (domain) to inspect, e.g. "wavespestcontrol.com"' },
        minutes: { type: 'number', description: `Look-back window in minutes (default ${DEFAULT_ERROR_MINUTES}, max ${MAX_ERROR_MINUTES})` },
      },
      required: ['zone_name'],
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Cloudflare access is not configured. Add the CF_API_TOKEN service variable (a scoped Cloudflare API token) in the Railway dashboard.';

async function cfRequest(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Cloudflare rejected the token for this resource — CF_API_TOKEN may need an extra scope (Zone Read / Pages Read / Analytics Read).');
    }
    if (!res.ok) throw new Error(`Cloudflare API returned HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false) {
      const first = json.errors?.[0];
      throw new Error(`Cloudflare API error: ${first?.message || 'unknown error'}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Cloudflare API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getCloudflareZones(input) {
  const json = await cfRequest(`/zones?per_page=${MAX_ZONES}`);
  let zones = (json.result || []).map(z => ({
    zone: z.name,
    status: z.status,
    paused: Boolean(z.paused),
  }));
  if (input.zone_name) {
    const needle = String(input.zone_name).toLowerCase();
    zones = zones.filter(z => z.zone.toLowerCase().includes(needle));
  }
  return { zones, total: zones.length };
}

async function getCloudflarePagesBuilds(input) {
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!accountId) throw new Error('CF_ACCOUNT_ID is not set — required for Pages project lookups.');
  const json = await cfRequest(`/accounts/${accountId}/pages/projects?per_page=${MAX_PAGES_PROJECTS}`);
  let projects = (json.result || []).map(p => {
    const dep = p.latest_deployment || null;
    return {
      project: p.name,
      latest_stage: dep?.latest_stage?.name || null,
      latest_status: dep?.latest_stage?.status || 'NONE',
      branch: dep?.deployment_trigger?.metadata?.branch || null,
      deployed_at: dep?.created_on || null,
    };
  });
  if (input.project_name) {
    const needle = String(input.project_name).toLowerCase();
    projects = projects.filter(p => p.project.toLowerCase().includes(needle));
  }
  const failing = projects.filter(p => p.latest_status === 'failure').length;
  return { projects, total: projects.length, failing_builds: failing };
}

async function getCloudflareEdgeErrors(input) {
  const zoneName = String(input.zone_name || '').trim();
  if (!zoneName) throw new Error('zone_name is required.');
  const minutes = Math.min(Math.max(Number(input.minutes) || DEFAULT_ERROR_MINUTES, 5), MAX_ERROR_MINUTES);

  const zonesJson = await cfRequest(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = (zonesJson.result || [])[0];
  if (!zone) throw new Error(`No Cloudflare zone found named "${zoneName}".`);

  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const graphql = await cfRequest('/graphql', {
    method: 'POST',
    body: {
      query: `query edgeHealth($tag: string!, $since: Time!) {
        viewer {
          zones(filter: { zoneTag: $tag }) {
            total: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since }, limit: 1) { count }
            errors: httpRequestsAdaptiveGroups(filter: { datetime_geq: $since, edgeResponseStatus_geq: 500 }, limit: 1) { count }
          }
        }
      }`,
      variables: { tag: zone.id, since },
    },
  });
  if (Array.isArray(graphql.errors) && graphql.errors.length) {
    throw new Error(`Cloudflare analytics error: ${graphql.errors[0].message}`);
  }
  const zoneData = graphql.data?.viewer?.zones?.[0] || {};
  const total = zoneData.total?.[0]?.count || 0;
  const errors = zoneData.errors?.[0]?.count || 0;
  return {
    zone: zone.name,
    window_minutes: minutes,
    requests: total,
    edge_5xx: errors,
    error_rate_pct: total ? Number(((errors / total) * 100).toFixed(2)) : 0,
    note: 'Sampled analytics dataset — treat counts as estimates.',
  };
}

async function executeCloudflareOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.CF_API_TOKEN) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_cloudflare_zones': return await getCloudflareZones(input);
      case 'get_cloudflare_pages_builds': return await getCloudflarePagesBuilds(input);
      case 'get_cloudflare_edge_errors': return await getCloudflareEdgeErrors(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:cloudflare-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { CLOUDFLARE_OPS_TOOLS, executeCloudflareOpsTool };
