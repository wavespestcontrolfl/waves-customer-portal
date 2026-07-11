/**
 * Intelligence Bar — Sentry Error-Monitoring Ops Tools
 * server/services/intelligence-bar/sentry-ops-tools.js
 *
 * Read-only visibility into application errors: top unresolved issues,
 * issues that first appeared recently, and the latest-event detail for a
 * single issue. Sentry is the source of truth for app errors (Railway logs
 * rotate and drop stack traces), so "is something broken?" questions should
 * land here rather than on get_railway_logs.
 *
 * Auth: org auth token in SENTRY_API_TOKEN. Org/project default to the ids
 * embedded in the reporting DSN (server/instrument.js) so the token is the
 * only required configuration; SENTRY_ORG / SENTRY_PROJECT override them.
 *
 * There are NO write operations here — no resolving, assigning, or muting
 * issues. Anything that mutates Sentry state must go through the write-gate
 * mechanism (issue #1568) and is intentionally not built.
 */

const logger = require('../logger');

const SENTRY_API_BASE = process.env.SENTRY_API_BASE || 'https://sentry.io/api/0';
// Numeric ids from the reporting DSN in server/instrument.js — the API
// accepts ids anywhere a slug is accepted.
const DEFAULT_ORG = '4511171673849856';
const DEFAULT_PROJECT = '4511171681255425';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 336; // 14 days — Sentry statsPeriod ceiling for this use
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_TEXT_CHARS = 300;
const MAX_STACK_FRAMES = 5;

const SENTRY_OPS_TOOLS = [
  {
    name: 'get_sentry_top_issues',
    description: `Get the most frequent unresolved application errors from Sentry over a recent window (default 24h). This is the source of truth for app errors — prefer it over Railway logs for "is something broken?".
Use for: "any errors today?", "top errors this week", "is the app healthy?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max issues to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_sentry_new_issues',
    description: `Get unresolved Sentry issues that FIRST appeared within a recent window (default 24h) — new regressions, e.g. after a deploy.
Use for: "any new errors since the last deploy?", "did anything new break today?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `First-seen window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max issues to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_sentry_issue_detail',
    description: `Get detail for one Sentry issue by its short id (e.g. "WAVES-PORTAL-1A"): message, exception type/value, and the top stack frames of the latest event.
Use for: "show me that WAVES-PORTAL-1A error", "what's the stack trace on the top issue?"`,
    input_schema: {
      type: 'object',
      properties: {
        issue_short_id: { type: 'string', description: 'The Sentry short id shown in issue lists' },
      },
      required: ['issue_short_id'],
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Sentry access is not configured. Add the SENTRY_API_TOKEN service variable (a Sentry org auth token) in the Railway dashboard.';

function clampHours(hours) {
  return Math.min(Math.max(Number(hours) || DEFAULT_HOURS, 1), MAX_HOURS);
}

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function truncate(text) {
  if (typeof text !== 'string') return text;
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…[truncated]` : text;
}

async function sentryGet(path, params = {}) {
  const url = new URL(`${SENTRY_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SENTRY_API_TOKEN}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Sentry rejected the token — check SENTRY_API_TOKEN scope (org:read, project:read, event:read).');
    }
    if (!res.ok) throw new Error(`Sentry API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Sentry API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mapIssue(issue) {
  return {
    short_id: issue.shortId,
    title: truncate(issue.title),
    culprit: truncate(issue.culprit),
    level: issue.level,
    events: Number(issue.count) || 0,
    users_affected: issue.userCount || 0,
    first_seen: issue.firstSeen,
    last_seen: issue.lastSeen,
    link: issue.permalink,
  };
}

async function listIssues({ query, sort, hours, limit }) {
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const params = {
    query,
    sort,
    statsPeriod: `${hours}h`,
    limit,
  };
  const project = process.env.SENTRY_PROJECT || DEFAULT_PROJECT;
  if (project) params.project = project;
  const issues = await sentryGet(`/organizations/${org}/issues/`, params);
  return (Array.isArray(issues) ? issues : []).map(mapIssue);
}

async function getSentryTopIssues(input) {
  const hours = clampHours(input.hours);
  const limit = clampLimit(input.limit);
  const issues = await listIssues({ query: 'is:unresolved', sort: 'freq', hours, limit });
  return { window_hours: hours, issues, total: issues.length };
}

async function getSentryNewIssues(input) {
  const hours = clampHours(input.hours);
  const limit = clampLimit(input.limit);
  const issues = await listIssues({
    query: `is:unresolved age:-${hours}h`,
    sort: 'new',
    hours,
    limit,
  });
  return { first_seen_within_hours: hours, issues, total: issues.length };
}

async function getSentryIssueDetail(input) {
  const shortId = String(input.issue_short_id || '').trim();
  if (!shortId) throw new Error('issue_short_id is required.');
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const matches = await sentryGet(`/organizations/${org}/issues/`, {
    query: `shortId:${shortId}`,
    limit: 1,
  });
  const issue = Array.isArray(matches) ? matches[0] : null;
  if (!issue) throw new Error(`No Sentry issue found for short id "${shortId}".`);

  const event = await sentryGet(`/organizations/${org}/issues/${issue.id}/events/latest/`);
  const exception = (event?.entries || []).find(e => e.type === 'exception');
  const firstException = exception?.data?.values?.[0] || null;
  // Innermost frames are last in Sentry's ordering — take the tail.
  const frames = (firstException?.stacktrace?.frames || [])
    .slice(-MAX_STACK_FRAMES)
    .map(f => ({
      function: f.function || null,
      module: f.module || f.filename || null,
      line: f.lineNo ?? null,
    }));

  return {
    ...mapIssue(issue),
    latest_event: {
      message: truncate(event?.message || event?.title || null),
      exception_type: firstException?.type || null,
      exception_value: truncate(firstException?.value || null),
      innermost_frames: frames,
    },
  };
}

async function executeSentryOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state (no token yet), not a
  // failure — an { error } result would count against the shared admin
  // circuit breaker (see ops-tools.js for the full rationale).
  if (!process.env.SENTRY_API_TOKEN) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_sentry_top_issues': return await getSentryTopIssues(input);
      case 'get_sentry_new_issues': return await getSentryNewIssues(input);
      case 'get_sentry_issue_detail': return await getSentryIssueDetail(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:sentry-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { SENTRY_OPS_TOOLS, executeSentryOpsTool };
