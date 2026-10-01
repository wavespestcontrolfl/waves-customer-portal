/**
 * Intelligence Bar — Needs Me Tool
 * server/services/intelligence-bar/needs-me-tools.js
 *
 * One read tool over server/services/needs-me.js, the same reader behind
 * GET /api/admin/needs-me: everything open (admin alerts and the dashboard's
 * standing conditions), each item with its area, severity, link, subject,
 * done-when and who may act (docs/admin-notifications.md).
 */

const logger = require('../logger');
const { listNeedsMe, decodeCursor } = require('../needs-me');
const { AREAS, WHO, cutAtWord } = require('../admin-alert-compose');

const MAX_ITEMS = 100;
const HEADLINE_CHARS = 80;
const WHY_CHARS = 140;
const DETAIL_CHARS = 600; // an engineering digest's diagnosis can live only in detail; report_link has the rest

const NEEDS_ME_TOOLS = [
  {
    name: 'needs_me',
    description: `Everything open that needs a person or Claude: unresolved admin alerts and the dashboard's standing counts, newest first, broken before needs-you. Each item says its area, what it is about (subject), what clears it (done_when), the link where the fix is made, and who may act: "person" decides, "claude" may fix alone, "either" means Claude drafts and a person approves. Items with derived=true come from older alerts, so area, who and subject are inferred; done_when is unknown for those. An alert's detail, when present, is the full finding (an engineering digest's diagnosis may live only there).
Use for: "what needs me?", "what's open?", "what can Claude fix on its own?", "what's open in billing?"`,
    input_schema: {
      type: 'object',
      properties: {
        who: { type: 'string', enum: WHO, description: 'Only items this actor may resolve. Exact: "claude" returns only what Claude may fix alone; "either" (Claude drafts, a person approves) is its own value.' },
        area: { type: 'string', enum: AREAS, description: 'Only items in this area.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ITEMS, description: `How many items to return (default 25, most urgent first).` },
        after: { type: 'string', description: 'The next_cursor from a previous call, to read the next page. Omit for the first page.' },
      },
    },
  },
];

// The bar renders text, so each item keeps what a reader acts on and drops the
// internals (dedupe keys, member ids, read state).
function toBarItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    area: item.area,
    severity: item.severity,
    who: item.who,
    headline: cutAtWord(item.headline || '', HEADLINE_CHARS),
    why: item.why ? cutAtWord(item.why, WHY_CHARS) : null,
    ...(item.detail ? { detail: cutAtWord(item.detail, DETAIL_CHARS) } : {}),
    link: item.link,
    ...(item.reportLink ? { report_link: item.reportLink } : {}),
    subject: item.subject || null,
    done_when: item.doneWhen,
    ...(item.count != null ? { count: item.count } : {}),
    ...(item.amount != null ? { amount: item.amount } : {}),
    derived: item.derived,
    ...(item.activityOnly ? { activity_only: true } : {}),
    created_at: item.createdAt,
  };
}

async function needsMe(input = {}) {
  try {
    const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), MAX_ITEMS) : 25;
    // The legacy bar path skips schema validation: an unknown filter would
    // silently match nothing and read as "nothing open".
    if (input.who != null && !WHO.includes(input.who)) return { error: `who must be one of: ${WHO.join(', ')}` };
    if (input.area != null && !AREAS.includes(input.area)) return { error: `area must be one of: ${AREAS.join(', ')}` };
    const after = input.after ? decodeCursor(input.after) : null;
    if (input.after && !after) return { error: 'after must be the next_cursor from a previous needs_me call' };
    const result = await listNeedsMe({ who: input.who, area: input.area, limit, after });
    return {
      generated_at: result.generatedAt,
      total_open: result.total,
      returned: result.items.length,
      counts: result.counts,
      // Known work, then (on the last pages) raw older alerts nothing classifies:
      // they may or may not need anyone, so they are listed apart and never
      // counted in total_open.
      items: result.items.filter((item) => !item.unsorted).map(toBarItem),
      unsorted: result.items.filter((item) => item.unsorted).map(toBarItem),
      unsorted_total: result.unsortedTotal,
      warnings: result.warnings,
      next_cursor: result.next,
      note: 'Never resolve a "person" item. A "claude" item may be fixed without asking, and the fix is reported afterward. "unsorted" items are older alerts with no work/FYI label: read the link before calling one work.',
    };
  } catch (err) {
    logger.error(`[intelligence-bar:needs-me] needs_me failed (${err.code || err.name || 'error'})`);
    return { error: 'Could not read what is open' };
  }
}

async function executeNeedsMeTool(toolName, input) {
  switch (toolName) {
    case 'needs_me': return needsMe(input);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { NEEDS_ME_TOOLS, executeNeedsMeTool };
