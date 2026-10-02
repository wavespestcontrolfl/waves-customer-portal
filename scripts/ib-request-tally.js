#!/usr/bin/env node
/**
 * Intelligence Bar request tally (PR 0 of the ten-workflow scope, D4).
 *
 * READ ONLY. Counts which tools the bar actually called over the last N days,
 * so the ten workflows can be ranked by observed use without reading any
 * request text. It prints:
 *   - tool calls grouped by tool and by day, per operator id
 *   - failure counts per tool from tool_health_events
 *
 * It never selects, prints or exports the prompt or response columns of
 * intelligence_bar_queries, nor error_message from tool_health_events.
 * Operator ids are ids only; a value that looks like an email is replaced by a
 * short hash label. The whole run is one READ ONLY transaction.
 *
 * Run it against production through Railway (the owner runs this; it needs the
 * production DATABASE_URL, which is why it is not run in CI):
 *
 *   railway run node scripts/ib-request-tally.js
 *   railway run node scripts/ib-request-tally.js --days 30
 *   railway run node scripts/ib-request-tally.js --json > ib-tally.json
 *
 * Limits to keep in mind when reading the numbers:
 *   - one row per bar turn; tool_calls holds the tools called in that turn, so
 *     tool counts are not request counts
 *   - operator_id is a nullable column the bar route does not populate today,
 *     so expect a single "(none)" operator unless that changes
 *   - public estimate Q&A rows share the table and appear as the tool
 *     public_estimate_ask; ignore them for workflow ranking
 */
require('dotenv').config();

const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;
const HEALTH_SOURCES = ['intelligence-bar', 'tech-intelligence-bar'];

// Neither statement names the prompt or response columns.
const CALLS_SQL = `
  select
    to_char((q.created_at at time zone 'America/New_York')::date, 'YYYY-MM-DD') as day,
    case
      when q.operator_id is null or btrim(q.operator_id) = '' then '(none)'
      when q.operator_id like '%@%' then 'masked-' || left(md5(q.operator_id), 8)
      else q.operator_id
    end as operator_id,
    tc.elem ->> 'name' as tool,
    count(*)::int as calls
  from intelligence_bar_queries q
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(q.tool_calls) = 'array' then q.tool_calls else '[]'::jsonb end
  ) as tc(elem)
  where q.created_at >= now() - make_interval(days => ?)
    and jsonb_typeof(tc.elem) = 'object'
    and tc.elem ->> 'name' is not null
  group by 1, 2, 3
  order by 1, 2, 4 desc, 3
`;

const TURNS_SQL = `
  select
    to_char((q.created_at at time zone 'America/New_York')::date, 'YYYY-MM-DD') as day,
    case
      when q.operator_id is null or btrim(q.operator_id) = '' then '(none)'
      when q.operator_id like '%@%' then 'masked-' || left(md5(q.operator_id), 8)
      else q.operator_id
    end as operator_id,
    count(*)::int as turns,
    (count(*) filter (
      where jsonb_typeof(q.tool_calls) is distinct from 'array' or jsonb_array_length(q.tool_calls) = 0
    ))::int as turns_without_tools
  from intelligence_bar_queries q
  where q.created_at >= now() - make_interval(days => ?)
  group by 1, 2
  order by 1, 2
`;

const FAILURES_SQL = `
  select
    e.tool_name as tool,
    count(*)::int as events,
    (count(*) filter (where e.success = false))::int as failures,
    (count(*) filter (where e.circuit_open))::int as circuit_open
  from tool_health_events e
  where e.created_at >= now() - make_interval(days => ?)
    and e.source = any(?)
  group by 1
  order by failures desc, events desc, 1
`;

function parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--days') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
      out.days = n;
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function summarize(calls, turns, failures) {
  const byTool = {};
  const byOperator = {};
  for (const r of calls) {
    byTool[r.tool] = (byTool[r.tool] || 0) + r.calls;
    byOperator[r.operator_id] = byOperator[r.operator_id] || { turns: 0, calls: 0, tools: {}, days: {} };
    const op = byOperator[r.operator_id];
    op.calls += r.calls;
    op.tools[r.tool] = (op.tools[r.tool] || 0) + r.calls;
    op.days[r.day] = op.days[r.day] || {};
    op.days[r.day][r.tool] = r.calls;
  }
  for (const t of turns) {
    byOperator[t.operator_id] = byOperator[t.operator_id] || { turns: 0, calls: 0, tools: {}, days: {} };
    byOperator[t.operator_id].turns += t.turns;
  }
  const toolRank = Object.entries(byTool).map(([tool, count]) => ({ tool, calls: count })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  return { tool_rank: toolRank, operators: byOperator, failures };
}

function formatText(report) {
  const lines = [];
  lines.push(`Intelligence Bar request tally, last ${report.days} days (read only, no prompt or response text)`);
  lines.push(`Generated ${report.generated_at}`);
  lines.push('');
  lines.push('Tool calls, all operators');
  for (const r of report.summary.tool_rank) lines.push(`  ${String(r.calls).padStart(6)}  ${r.tool}`);
  if (!report.summary.tool_rank.length) lines.push('  (no tool calls in the window)');
  for (const [op, data] of Object.entries(report.summary.operators).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('');
    lines.push(`Operator ${op}: ${data.turns} turns, ${data.calls} tool calls`);
    const days = Object.keys(data.days).sort();
    for (const day of days) {
      const tools = Object.entries(data.days[day]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      lines.push(`  ${day}  ${tools.map(([t, n]) => `${t} x${n}`).join(', ')}`);
    }
  }
  lines.push('');
  lines.push('Failures per tool (tool_health_events)');
  if (!report.summary.failures.length) lines.push('  (no health events in the window)');
  for (const f of report.summary.failures) lines.push(`  ${String(f.failures).padStart(5)} failed / ${String(f.events).padStart(6)} events  ${f.tool}${f.circuit_open ? `  (circuit open on ${f.circuit_open})` : ''}`);
  return lines.join('\n');
}

async function collect(db, days) {
  return db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const calls = (await trx.raw(CALLS_SQL, [days])).rows;
    const turns = (await trx.raw(TURNS_SQL, [days])).rows;
    const failures = (await trx.raw(FAILURES_SQL, [days, HEALTH_SOURCES])).rows;
    return { calls, turns, failures };
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('Usage: node scripts/ib-request-tally.js [--days N] [--json]');
    process.exit(2);
  }
  if (args.help) {
    console.log('Usage: node scripts/ib-request-tally.js [--days N] [--json]\nRead only. Run through `railway run` for production counts.');
    return;
  }
  const db = require('../server/models/db');
  try {
    const { calls, turns, failures } = await collect(db, args.days);
    const report = { days: args.days, generated_at: new Date().toISOString(), calls, turns, summary: summarize(calls, turns, failures) };
    console.log(args.json ? JSON.stringify(report, null, 2) : formatText(report));
  } finally {
    await db.destroy();
  }
}

module.exports = { parseArgs, summarize, formatText, CALLS_SQL, TURNS_SQL, FAILURES_SQL, HEALTH_SOURCES, DEFAULT_DAYS };

if (require.main === module) {
  main().catch((err) => {
    // code only: a knex message can carry compiled SQL and parameters
    console.error(`ib-request-tally failed (${err.code || err.name || 'error'})`);
    process.exit(1);
  });
}
