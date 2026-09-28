/**
 * Intelligence Bar — Gap Report Tools
 * server/services/intelligence-bar/gap-report-tools.js
 *
 * One read tool over agent_gap_reports (server/models/migrations/
 * 20260928160000_agent_gap_reports.js): gap reports — what the bar could
 * not do this week, grouped by domain, for deciding what to build next.
 * The rows are written by the server, never by a model tool: the route's
 * per-request collector (server/services/agent-gap-reports.js).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const ROW_CAP = 50;
const CLOSED_STATUSES = ['fixed', 'by_design', 'dismissed'];

const GAP_REPORT_TOOLS = [
  {
    name: 'list_gap_reports',
    description: `Gap reports: things the Intelligence Bar could not do (a missing capability, a tool that failed, or a blocked action), recorded automatically when the bar told the operator it could not do something. Grouped by domain, most-hit first — use this to see what to build next.
Use for: "show gap reports", "what has the bar not been able to do?", "what should we build next?"`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: `How many days back to look (default ${DEFAULT_DAYS}).` },
        include_closed: { type: 'boolean', description: 'Include gaps already marked fixed, by_design, or dismissed (default false).' },
      },
    },
  },
];

function normalizedDays(value) {
  const n = Number.isInteger(value) ? value : parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
}

function toGap(row) {
  return {
    // bigint id comes back from pg as a string; coerce for a caller that
    // compares it or renders "gap #<id>".
    gap_id: Number(row.id),
    kind: row.kind,
    wanted: row.summary,
    tried: row.attempted || null,
    tool: row.closest_tool || null,
    times_seen: row.occurrences,
    first_seen: etDateString(new Date(row.first_seen_at)),
    last_seen: etDateString(new Date(row.last_seen_at)),
    status: row.status,
  };
}

function groupByDomain(rows) {
  const byDomain = new Map();
  for (const row of rows) {
    const domain = row.domain || 'other';
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(row);
  }
  const groups = [...byDomain.entries()].map(([domain, domainRows]) => {
    const gaps = [...domainRows].sort((a, b) => (b.occurrences - a.occurrences)
      || (new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime()));
    const total = domainRows.reduce((sum, row) => sum + (row.occurrences || 0), 0);
    return { domain, total, gaps: gaps.map(toGap) };
  });
  groups.sort((a, b) => b.total - a.total);
  return groups.map(({ domain, gaps }) => ({ domain, gaps }));
}

async function listGapReports(input = {}) {
  try {
    const days = normalizedDays(input.days);
    const includeClosed = input.include_closed === true;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const query = db('agent_gap_reports')
      .where('last_seen_at', '>=', cutoff)
      .orderBy('occurrences', 'desc')
      .orderBy('last_seen_at', 'desc')
      .limit(ROW_CAP);
    if (!includeClosed) query.whereNotIn('status', CLOSED_STATUSES);
    const rows = await query;
    return {
      window_days: days,
      total: rows.length,
      groups: groupByDomain(rows),
      note: 'Refer to gaps by number, e.g. gap #12.',
    };
  } catch (err) {
    logger.error('[intelligence-bar:gap-report] list_gap_reports failed:', err);
    return { error: err.message };
  }
}

async function executeGapReportTool(toolName, input) {
  switch (toolName) {
    case 'list_gap_reports': return listGapReports(input);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { GAP_REPORT_TOOLS, executeGapReportTool };
