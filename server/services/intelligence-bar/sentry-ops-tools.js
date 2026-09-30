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
 * resolve_sentry_issue / ignore_sentry_issue / assign_sentry_issue (IB scope
 * expansion item 1, owner ruling 2026-09-28) are the outside-write tools:
 * structurally two-step (write-gates.js OUTSIDE_WRITE_TOOL_NAMES), full-
 * access-only (ib-access.js ibFullAccess, enforced in
 * routes/admin-intelligence-bar.js — not here). Unconfirmed, each looks the
 * issue up live and returns a preview naming its TITLE, not just the short
 * id. Confirmed, the executor acts ONLY on the pinned identifiers
 * /confirm-action verified against that live preview's fingerprint
 * (`_verified_sentry_issue_id` / `_verified_sentry_assignee_id`, threaded in
 * by admin-intelligence-bar.js) — it never re-resolves issue_short_id or
 * assignee from the confirmed call's own input. SENTRY_API_TOKEN needs
 * event:write + project:write for the PUT to succeed; a 401/403 surfaces as
 * a plain "the token is read-only" error rather than a bare HTTP failure.
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
  {
    name: 'resolve_sentry_issue',
    description: `Resolve a Sentry issue by its short id (e.g. "WAVES-PORTAL-1A") — marks it fixed. Owner login only, through a confirmation card.
Use for: "resolve WAVES-PORTAL-1A", "mark that error as fixed"`,
    input_schema: {
      type: 'object',
      properties: {
        issue_short_id: { type: 'string', description: 'The Sentry short id shown in issue lists' },
      },
      required: ['issue_short_id'],
    },
  },
  {
    name: 'ignore_sentry_issue',
    description: `Ignore (mute) a Sentry issue by its short id so it stops alerting. Owner login only, through a confirmation card.
Use for: "ignore WAVES-PORTAL-1A", "mute that error, it's expected"`,
    input_schema: {
      type: 'object',
      properties: {
        issue_short_id: { type: 'string', description: 'The Sentry short id shown in issue lists' },
      },
      required: ['issue_short_id'],
    },
  },
  {
    name: 'assign_sentry_issue',
    description: `Assign a Sentry issue by its short id to a Sentry org member — matched EXACTLY (case-insensitive) against their real Sentry username, account email, or display name; no match or more than one match refuses rather than guess. Owner login only, through a confirmation card.
Use for: "assign WAVES-PORTAL-1A to Adam", "who should look at that error?"`,
    input_schema: {
      type: 'object',
      properties: {
        issue_short_id: { type: 'string', description: 'The Sentry short id shown in issue lists' },
        assignee: { type: 'string', description: 'Sentry username, account email, or display name to assign the issue to' },
      },
      required: ['issue_short_id', 'assignee'],
    },
  },
];

const SENTRY_WRITE_ACTIONS = {
  resolve_sentry_issue: { verb: 'Resolve', past: 'resolved' },
  ignore_sentry_issue: { verb: 'Ignore', past: 'ignored' },
  assign_sentry_issue: { verb: 'Assign', past: 'assigned' },
};
const READ_ONLY_TOKEN_MESSAGE = 'The Sentry token is read-only — it needs write scope (event:write, project:write) before this action can commit.';

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

// The one PUT this module makes — resolve/ignore/assign, always on a
// pinned issue id from a fingerprint-verified preview (see writeSentryIssue).
// A 401/403 here means the token can read but not write, which is the
// expected state until SENTRY_API_TOKEN is reissued with event:write +
// project:write (the IB scope doc's token checklist) — surfaced as a plain,
// actionable message rather than a bare HTTP failure.
async function sentryPut(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SENTRY_API_BASE}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env.SENTRY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error(READ_ONLY_TOKEN_MESSAGE);
      err.status = res.status;
      err.writeAccessRequired = true;
      throw err;
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j?.detail ? `: ${j.detail}` : ''; } catch { /* body wasn't JSON */ }
      const err = new Error(`Sentry API returned HTTP ${res.status}${detail}`);
      err.status = res.status;
      throw err;
    }
    return await res.json().catch(() => ({}));
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

// Short ids resolve only via shortIdLookup with the bare id as the query —
// `shortId:` is not a recognized issue-search field. Shared by the detail
// read and every write tool's preview (both need the live issue to name it
// by TITLE, not just echo the id back).
async function resolveIssueByShortId(shortId) {
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const normalized = String(shortId || '').trim().toUpperCase();
  const matches = await sentryGet(`/organizations/${org}/issues/`, {
    query: normalized,
    shortIdLookup: 1,
    limit: 1,
  });
  const issue = Array.isArray(matches) ? matches[0] : null;
  // shortIdLookup silently degrades to a fuzzy full-text search when the
  // query is not a real short id, rather than erroring — verify the result
  // is an EXACT match before trusting it (pre-push audit #5275), or a
  // malformed/mistyped id could resolve to an unrelated issue.
  if (!issue || String(issue.shortId || '').toUpperCase() !== normalized) {
    throw new Error(`No Sentry issue found for short id "${shortId}".`);
  }
  return issue;
}

async function getSentryIssueDetail(input) {
  const shortId = String(input.issue_short_id || '').trim();
  if (!shortId) throw new Error('issue_short_id is required.');
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const issue = await resolveIssueByShortId(shortId);

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

// Exact (case-insensitive, trimmed) match against the REAL Sentry org member
// roster — never the operator's raw string as-typed, and never a fuzzy or
// substring match (same discipline as resolveRepoLabel in github-ops-tools.js
// and the fleet-domain resolution in seo-tools.js). Checked against username,
// account email, and display name; zero or several matches refuse rather than
// guess. A refusal never echoes the operator's input back — an account email
// must not reach logs/telemetry (codex r2 P2 on #5275; the route already
// taints/redacts the whole turn's prompt/response because this tool is in
// FULL_ACCESS_TWO_STEP_TOOL_NAMES, but a thrown Error's message also reaches
// the shared executeSentryOpsTool catch's logger.error, which does not get
// that redaction).
async function resolveSentryAssignee(rawAssignee) {
  const needle = String(rawAssignee).trim().toLowerCase();
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const members = await sentryGet(`/organizations/${org}/members/`, { per_page: 100 });
  const list = Array.isArray(members) ? members : [];
  const matches = list.filter((m) => {
    const email = String(m.email || m.user?.email || '').trim().toLowerCase();
    const username = String(m.user?.username || '').trim().toLowerCase();
    const name = String(m.name || m.user?.name || '').trim().toLowerCase();
    return (email && email === needle) || (username && username === needle) || (name && name === needle);
  });
  if (matches.length === 0) {
    throw new Error('No Sentry org member matches that assignee — use their exact Sentry username or account email.');
  }
  if (matches.length > 1) {
    throw new Error('More than one Sentry org member matches that assignee — use their exact Sentry username or account email to pick one.');
  }
  const member = matches[0];
  // Canonical id + display name only — STABLE fields fit for a preview that
  // gets fingerprinted at confirm, and never the member's email.
  return {
    id: member.user?.id || member.id,
    display_name: member.name || member.user?.name || member.user?.username || 'Sentry member',
  };
}

// The issue's current assignee, id + display name only — never their email
// (same discipline as resolveSentryAssignee's own preview fields). null when
// unassigned or assigned to a team rather than a person.
function currentAssigneeSummary(issue) {
  const assignedTo = issue.assignedTo;
  if (!assignedTo || assignedTo.type !== 'user') return null;
  return {
    id: assignedTo.id != null ? String(assignedTo.id) : null,
    name: assignedTo.name || 'Sentry member',
  };
}

// Shared preview/refuse-commit executor for resolve/ignore/assign — the
// structural two-step gate (write-gates.js OUTSIDE_WRITE_TOOL_NAMES). Full
// access is enforced by the route, not here (ib-access.js ibFullAccess).
async function writeSentryIssue(toolName, input) {
  const action = SENTRY_WRITE_ACTIONS[toolName];
  const shortId = String(input.issue_short_id || '').trim();
  if (!shortId) throw new Error('issue_short_id is required.');
  if (toolName === 'assign_sentry_issue' && !String(input.assignee || '').trim()) {
    throw new Error('assignee is required.');
  }
  // Unconfirmed: resolve the issue live so the card names it by TITLE, not
  // just the short id, and never mutates Sentry.
  if (input.confirmed !== true) {
    const issue = await resolveIssueByShortId(shortId);

    // Refuse a no-op transition (resolve on an already-resolved issue, ignore
    // on an already-ignored one) rather than propose a card that could only
    // report success without changing anything (codex r3 P2 on #5275; same
    // isToolFailure convention as the github-ops no-op refusals). action.past
    // is exactly the Sentry issue-status value the write would set.
    if (toolName !== 'assign_sentry_issue' && issue.status === action.past) {
      return {
        error: `Issue "${issue.title}" (${issue.shortId}) is already ${action.past} in Sentry.`,
        code: `already_${action.past}`,
      };
    }

    let assigneeMember = null;
    if (toolName === 'assign_sentry_issue') {
      assigneeMember = await resolveSentryAssignee(input.assignee);
      const current = currentAssigneeSummary(issue);
      if (current?.id && current.id === String(assigneeMember.id)) {
        return {
          error: `Issue "${issue.title}" (${issue.shortId}) is already assigned to ${assigneeMember.display_name} in Sentry.`,
          code: 'already_assigned',
        };
      }
    }

    const preview = {
      preview: true,
      tool: toolName,
      action: action.verb,
      // The pinned canonical identity (internal id + the exact short id) —
      // never a re-resolve of the operator's raw string — is what a future
      // commit path must act on. `status` is a STABLE field (changes only on
      // an explicit transition, never drifts the way event/user counters
      // do) bound into the preview/fingerprint so a status change between
      // preview and confirm (someone else resolved it meanwhile) is caught
      // as drift, not silently overwritten (codex r3 P2 on #5275).
      // Stable identity only. /confirm-action re-runs this preview and
      // compares its fingerprint, so live counters (events, users, last
      // seen) on an active issue would refuse every confirm as drifted.
      issue: {
        id: issue.id, short_id: issue.shortId, title: truncate(issue.title),
        culprit: truncate(issue.culprit), level: issue.level, link: issue.permalink,
        status: issue.status || null,
      },
      note: `${action.verb} "${issue.title}" (${issue.shortId}) in Sentry.`,
    };
    if (toolName === 'assign_sentry_issue') {
      // The pinned canonical member (id + display name) — never the
      // operator's raw string, and never their email — is what a future
      // commit path must assign to. current_assignee (also id + display name
      // only, no email) is the FROM half of the transition — null when
      // currently unassigned or assigned to a team.
      preview.assignee = { id: assigneeMember.id, name: assigneeMember.display_name };
      preview.current_assignee = currentAssigneeSummary(issue);
      preview.note = `Assign "${issue.title}" (${issue.shortId}) to ${assigneeMember.display_name} in Sentry.`;
    }
    return preview;
  }
  // Confirmed: act ONLY on the pinned identity /confirm-action verified
  // against the live preview above (_verified_sentry_issue_id /
  // _verified_sentry_assignee_id, threaded in by admin-intelligence-bar.js's
  // WRITE_TWO_STEP_TOOL_NAMES pinning) — never re-resolve issue_short_id or
  // assignee from this call's own input, which is untrusted at this point.
  const pinnedIssueId = input._verified_sentry_issue_id;
  if (!pinnedIssueId) {
    return {
      error: 'Missing the verified issue identity for this confirmed action — ask again for a fresh confirmation card.',
      code: 'missing_verified_pin',
    };
  }
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  if (toolName === 'assign_sentry_issue') {
    const pinnedAssigneeId = input._verified_sentry_assignee_id;
    if (!pinnedAssigneeId) {
      return {
        error: 'Missing the verified assignee identity for this confirmed action — ask again for a fresh confirmation card.',
        code: 'missing_verified_pin',
      };
    }
    await sentryPut(`/organizations/${org}/issues/${pinnedIssueId}/`, { assignedTo: `user:${pinnedAssigneeId}` });
    return { success: true, tool: toolName, issue_id: String(pinnedIssueId), assignee_id: String(pinnedAssigneeId) };
  }
  await sentryPut(`/organizations/${org}/issues/${pinnedIssueId}/`, { status: action.past });
  return { success: true, tool: toolName, issue_id: String(pinnedIssueId), status: action.past };
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
      case 'resolve_sentry_issue':
      case 'ignore_sentry_issue':
      case 'assign_sentry_issue':
        return await writeSentryIssue(toolName, input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Outside-write refusals can echo operator/model-supplied target text
    // (a zone, project, service, domain or assignee — possibly customer
    // text), so those log the tool and status only; the operator still gets
    // the full message (Codex r5 on #5275). Read tools keep full logs.
    if (require('./write-gates').OUTSIDE_WRITE_TOOL_NAMES.has(toolName)) {
      logger.error(`[intelligence-bar:sentry-ops] Tool ${toolName} failed (status=${err.status || 'n/a'})`);
    } else {
      logger.error(`[intelligence-bar:sentry-ops] Tool ${toolName} failed:`, err);
    }
    return { error: err.message, ...(err.writeAccessRequired ? { code: 'write_access_required' } : {}) };
  }
}

module.exports = { SENTRY_OPS_TOOLS, executeSentryOpsTool };
