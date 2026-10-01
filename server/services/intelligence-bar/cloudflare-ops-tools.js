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
 * purge_cloudflare_cache / retry_cloudflare_pages_build (IB scope expansion
 * item 1, owner ruling 2026-09-28) are the outside-write tools: structurally
 * two-step (write-gates.js OUTSIDE_WRITE_TOOL_NAMES), full-access-only
 * (ib-access.js ibFullAccess, enforced in routes/admin-intelligence-bar.js —
 * not here). Confirmed, each acts ONLY on the pinned identifiers
 * /confirm-action verified against the live preview's fingerprint
 * (`_verified_cloudflare_zone_id` / `_verified_cloudflare_project_name` +
 * `_verified_cloudflare_deployment_id`, threaded in by
 * admin-intelligence-bar.js) — never a re-resolve of zone_name/project_name
 * from the confirmed call's own input. CF_API_TOKEN needs Zone Cache Purge +
 * Account Pages Edit for the write calls to succeed; a 401/403 surfaces as a
 * plain "the token is read-only" error.
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
  {
    name: 'purge_cloudflare_cache',
    description: `Purge the ENTIRE Cloudflare edge cache for one zone (domain) — every cached asset re-fetches from origin on the next request. Owner login only, through a confirmation card.
Use for: "purge the cache for bradentonflpestcontrol.com", "flush the CDN, the old page is still showing"`,
    input_schema: {
      type: 'object',
      properties: {
        zone_name: { type: 'string', description: 'Zone (domain) to purge, e.g. "wavespestcontrol.com"' },
      },
      required: ['zone_name'],
    },
  },
  {
    name: 'retry_cloudflare_pages_build',
    description: `Retry the LATEST Cloudflare Pages deployment for one spoke-site project (only useful when it failed). Owner login only, through a confirmation card.
Use for: "retry the bradenton site build", "that Pages deploy failed, kick it off again"`,
    input_schema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Pages project name to retry, e.g. "bradenton-pest-control"' },
      },
      required: ['project_name'],
    },
  },
];

const READ_ONLY_TOKEN_MESSAGE = 'The Cloudflare token is read-only — it needs write scope (Zone Cache Purge, Account Pages Edit) before this action can commit.';

const NOT_CONFIGURED_MESSAGE = 'Cloudflare access is not configured. Add the CF_API_TOKEN service variable (a scoped Cloudflare API token) in the Railway dashboard.';

// `forWrite` picks the 401/403 message: a read missing a scope names the
// scopes reads need, a write missing scope names the write-only ones — same
// endpoint, different actionable text depending on which call failed.
async function cfRequest(path, { method = 'GET', body, forWrite = false } = {}) {
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
      const err = new Error(forWrite
        ? READ_ONLY_TOKEN_MESSAGE
        : 'Cloudflare rejected the token for this resource — CF_API_TOKEN may need an extra scope (Zone Read / Pages Read / Analytics Read).');
      err.status = res.status;
      if (forWrite) err.writeAccessRequired = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Cloudflare API returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (json.success === false) {
      const first = json.errors?.[0];
      // Cloudflare can report an authorization failure as a 2xx envelope with
      // success:false (10000 = authentication error, 9109 = unauthorized).
      if (forWrite && [10000, 9109].includes(Number(first?.code))) {
        const err = new Error(READ_ONLY_TOKEN_MESSAGE);
        err.writeAccessRequired = true;
        throw err;
      }
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

// Shared by the edge-error READ and (indirectly, via resolveZoneExact below)
// the cache-purge WRITE preview — both need the zone's real id/name, not
// just an operator-typed domain string. Reads may stay fuzzy; this one asks
// Cloudflare's own exact `name=` filter and is fine for a read.
async function resolveZone(zoneName) {
  const zonesJson = await cfRequest(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zone = (zonesJson.result || [])[0];
  if (!zone) throw new Error(`No Cloudflare zone found named "${zoneName}".`);
  return zone;
}

const MAX_SUGGESTIONS = 5;

// Exact (case-insensitive, trimmed) match ONLY — never a substring pick.
// Used by every write tool's target resolution (pre-push audit #5275): a
// fuzzy match could name one zone/project on the card while a later re-
// resolve of the same raw string picks a different one (ordering isn't
// guaranteed, and a new zone could start matching the same substring).
// Reads (getCloudflareZones / getCloudflarePagesBuilds) may keep their
// substring filter — this is for writes only. `%`/`_` in the input are
// compared as literal characters, never SQL/LIKE wildcards, so a typed
// wildcard can never widen the match.
function resolveExactOrRefuse(items, rawNeedle, { label, getName }) {
  const needle = String(rawNeedle || '').trim().toLowerCase();
  const exact = items.filter((item) => getName(item).trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Multiple Cloudflare ${label}s are exactly named "${rawNeedle}" — this should not happen; contact engineering. Candidates: ${exact.map(getName).join(', ')}.`);
  }
  const suggestions = items
    .filter((item) => getName(item).toLowerCase().includes(needle))
    .slice(0, MAX_SUGGESTIONS)
    .map(getName);
  const hint = suggestions.length ? ` Close matches: ${suggestions.join(', ')}.` : '';
  throw new Error(`No Cloudflare ${label} found exactly named "${rawNeedle}".${hint}`);
}

// Full zone list + our own exact filter — never Cloudflare's `name=` filter
// alone (undocumented exactness) and never the substring fallback the reads
// use. Returns the one zone the write can safely name and act on.
async function resolveZoneExact(zoneName) {
  const zonesJson = await cfRequest(`/zones?per_page=${MAX_ZONES}`);
  return resolveExactOrRefuse(zonesJson.result || [], zoneName, { label: 'zone', getName: (z) => z.name });
}

async function getCloudflareEdgeErrors(input) {
  const zoneName = String(input.zone_name || '').trim();
  if (!zoneName) throw new Error('zone_name is required.');
  const minutes = Math.min(Math.max(Number(input.minutes) || DEFAULT_ERROR_MINUTES, 5), MAX_ERROR_MINUTES);

  const zone = await resolveZone(zoneName);

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

// Unconfirmed: resolve the zone live so the card names the real zone, never
// purges anything. Confirmed: POSTs the purge to the pinned zone id. Full
// access is enforced by the route (ib-access.js).
async function purgeCloudflareCache(input) {
  const zoneName = String(input.zone_name || '').trim();
  if (!zoneName) throw new Error('zone_name is required.');
  if (input.confirmed !== true) {
    const zone = await resolveZoneExact(zoneName);
    return {
      preview: true,
      tool: 'purge_cloudflare_cache',
      // The pinned canonical identity (id + exact name) — never the
      // operator's raw string — is what the confirmed commit acts on.
      zone: { id: zone.id, zone: zone.name, status: zone.status, paused: Boolean(zone.paused) },
      note: `Purge the ENTIRE Cloudflare edge cache for "${zone.name}" — every cached asset re-fetches from origin on the next request.`,
    };
  }
  // Confirmed: act ONLY on the pinned zone id /confirm-action verified
  // against the live preview above — never re-resolve zone_name from this
  // call's own input, which is untrusted at this point.
  const pinnedZoneId = input._verified_cloudflare_zone_id;
  if (!pinnedZoneId) {
    return {
      error: 'Missing the verified zone identity for this confirmed action — ask again for a fresh confirmation card.',
      code: 'missing_verified_pin',
    };
  }
  await cfRequest(`/zones/${pinnedZoneId}/purge_cache`, { method: 'POST', body: { purge_everything: true }, forWrite: true });
  return { success: true, tool: 'purge_cloudflare_cache', zone_id: pinnedZoneId };
}

// Unconfirmed: resolve the project's latest deployment live so the card
// names the actual build that would be retried (and its current status),
// never retries anything. Confirmed: retries the pinned deployment id.
async function retryCloudflarePagesBuild(input) {
  const projectName = String(input.project_name || '').trim();
  if (!projectName) throw new Error('project_name is required.');
  if (input.confirmed !== true) {
    const accountId = process.env.CF_ACCOUNT_ID;
    if (!accountId) throw new Error('CF_ACCOUNT_ID is not set — required for Pages project lookups.');
    const json = await cfRequest(`/accounts/${accountId}/pages/projects?per_page=${MAX_PAGES_PROJECTS}`);
    const project = resolveExactOrRefuse(json.result || [], projectName, { label: 'Pages project', getName: (p) => p.name });
    const dep = project.latest_deployment || null;
    if (!dep) throw new Error(`Project "${project.name}" has no deployment to retry.`);
    return {
      preview: true,
      tool: 'retry_cloudflare_pages_build',
      project: project.name,
      deployment: {
        // The pinned exact deployment id — deployed_at (below) is stripped
        // from the fingerprint as a volatile `_at` field, so without this
        // the fingerprint bound to nothing distinguishing WHICH deployment
        // is "latest": a new push landing between preview and confirm would
        // go undetected as drift (codex r3 P1 on #5275).
        id: dep.id || null,
        latest_stage: dep.latest_stage?.name || null,
        latest_status: dep.latest_stage?.status || 'NONE',
        branch: dep.deployment_trigger?.metadata?.branch || null,
        deployed_at: dep.created_on || null,
      },
      note: `Retry the latest Cloudflare Pages deployment for "${project.name}" (currently ${dep.latest_stage?.status || 'NONE'}).`,
    };
  }
  // Confirmed: act ONLY on the pinned project name + deployment id
  // /confirm-action verified against the live preview above — never
  // re-resolve project_name or "latest deployment" from this call's own
  // input, which is untrusted at this point (a new push landing between
  // preview and confirm must not silently retry a DIFFERENT deployment).
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!accountId) throw new Error('CF_ACCOUNT_ID is not set — required for Pages project lookups.');
  const pinnedProject = input._verified_cloudflare_project_name;
  const pinnedDeploymentId = input._verified_cloudflare_deployment_id;
  if (!pinnedProject || !pinnedDeploymentId) {
    return {
      error: 'Missing the verified deployment identity for this confirmed action — ask again for a fresh confirmation card.',
      code: 'missing_verified_pin',
    };
  }
  const json = await cfRequest(
    `/accounts/${accountId}/pages/projects/${encodeURIComponent(pinnedProject)}/deployments/${encodeURIComponent(pinnedDeploymentId)}/retry`,
    { method: 'POST', forWrite: true },
  );
  return {
    success: true,
    tool: 'retry_cloudflare_pages_build',
    project: pinnedProject,
    retried_deployment_id: pinnedDeploymentId,
    new_deployment_id: json?.result?.id || null,
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
      case 'purge_cloudflare_cache': return await purgeCloudflareCache(input);
      case 'retry_cloudflare_pages_build': return await retryCloudflarePagesBuild(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Outside-write refusals can echo operator/model-supplied target text
    // (a zone, project, service, domain or assignee — possibly customer
    // text), so those log the tool and status only; the operator still gets
    // the full message (Codex r5 on #5275). Read tools keep full logs.
    if (require('./write-gates').OUTSIDE_WRITE_TOOL_NAMES.has(toolName)) {
      logger.error(`[intelligence-bar:cloudflare-ops] Tool ${toolName} failed (status=${err.status || 'n/a'})`);
    } else {
      logger.error(`[intelligence-bar:cloudflare-ops] Tool ${toolName} failed:`, err);
    }
    return { error: err.message, ...(err.writeAccessRequired ? { code: 'write_access_required' } : {}) };
  }
}

module.exports = { CLOUDFLARE_OPS_TOOLS, executeCloudflareOpsTool, cfRequest };
