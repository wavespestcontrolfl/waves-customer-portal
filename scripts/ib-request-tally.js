#!/usr/bin/env node
/**
 * Intelligence Bar request tally (PR 0 of the ten-workflow scope, D4).
 *
 * READ ONLY. Counts which tools the bar actually called over the last N days,
 * so the ten workflows can be ranked by observed use without reading any
 * request text. It prints:
 *   - tool calls grouped by tool and by day, per operator id
 *   - proposal-phase and read failure counts per tool from tool_health_events
 *   - confirmed-write outcomes per tool from ib_pending_actions
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
 *   - operator_id is written by the bar route since #5591 (October 2, 2026);
 *     turns before that show as the "(none)" operator
 *   - public estimate Q&A rows share the table (a turn that called
 *     public_estimate_ask); they are customer traffic, not operator turns, and
 *     are left out of every count here
 *   - tool_health_events records a carded write when it is PROPOSED (and a
 *     read when it runs); the write that runs after Confirm records no health
 *     event. Confirmed-write failures (a rejected text, a stale write, a
 *     database error) come from ib_pending_actions instead, classified with the
 *     same executionOutcome the bar uses. A consumed row with no stored result
 *     counts as outcome_unknown.
 */
require('dotenv').config();

const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;
const HEALTH_SOURCES = ['intelligence-bar', 'tech-intelligence-bar'];
// Customer estimate questions share intelligence_bar_queries; drop those turns.
// tool_calls is nullable: `not (null and ...)` is NULL and would drop the row, so the
// public-estimate test is compared with `is distinct from true` and a NULL or
// non-array value stays in as the tool-free turn it is.
const NOT_PUBLIC_ESTIMATE = `(jsonb_typeof(q.tool_calls) = 'array' and q.tool_calls @> '[{"name": "public_estimate_ask"}]'::jsonb) is distinct from true`;

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
    and ${NOT_PUBLIC_ESTIMATE}
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
    and ${NOT_PUBLIC_ESTIMATE}
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

// Confirmed carded writes. Only the outcome flags of `result` leave the
// database (never its text), so executionOutcome can classify each row the
// way the bar's recovery path does.
const CONFIRMED_SQL = `
  select
    a.tool_name as tool,
    case when a.result is null or jsonb_typeof(a.result) <> 'object' then null
    else jsonb_strip_nulls(jsonb_build_object(
      'outcome_unknown', a.result -> 'outcome_unknown',
      'pending_confirmation', a.result -> 'pending_confirmation',
      'preview', a.result -> 'preview',
      'proposal', a.result -> 'proposal',
      'dry_run', a.result -> 'dry_run',
      'blocked', a.result -> 'blocked',
      'failed', a.result -> 'failed',
      'success', a.result -> 'success',
      'partial', a.result -> 'partial',
      'state', a.result -> 'state',
      'error', case when coalesce(a.result ->> 'error', '') not in ('', 'false', 'null') then true end,
      'warning', case when coalesce(a.result ->> 'warning', '') not in ('', 'false', 'null') then true end,
      'keys', case when a.result = '{}'::jsonb then null else true end
    )) end as flags
  from ib_pending_actions a
  where a.status = 'confirmed'
    and coalesce(a.consumed_at, a.updated_at) >= now() - make_interval(days => ?)
`;

// Outcomes that count as a failed confirmed write. awaiting_approval cannot
// follow a confirm, so it is reported with the unknowns.
const CONFIRMED_FAILED = new Set(['failed', 'blocked']);
const CONFIRMED_OK = new Set(['completed', 'partially_completed', 'provider_accepted']);

function classifyConfirmed(rows, outcomeOf = require('../server/services/intelligence-bar/outcomes').executionOutcome) {
  const byTool = {};
  for (const r of rows) {
    // `keys` only marks a non-empty result; it is not an outcome flag. A
    // non-empty result with no flags stays non-empty so it classifies as
    // outcome_unknown, exactly as the full result would.
    const { keys, ...flags } = r.flags && typeof r.flags === 'object' ? r.flags : {};
    const result = keys ? (Object.keys(flags).length ? flags : { other: true }) : null;
    const outcome = outcomeOf(result);
    const t = byTool[r.tool] = byTool[r.tool] || { tool: r.tool, confirmed: 0, succeeded: 0, failed: 0, unknown: 0 };
    t.confirmed += 1;
    if (CONFIRMED_OK.has(outcome)) t.succeeded += 1;
    else if (CONFIRMED_FAILED.has(outcome)) t.failed += 1;
    else t.unknown += 1;
  }
  return Object.values(byTool).sort((a, b) => b.failed - a.failed || b.confirmed - a.confirmed || a.tool.localeCompare(b.tool));
}

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

function summarize(calls, turns, failures, confirmed = []) {
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
  return { tool_rank: toolRank, operators: byOperator, failures, confirmed };
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
  lines.push('Read and proposal-phase failures per tool (tool_health_events; a carded write is counted when proposed, not when confirmed)');
  if (!report.summary.failures.length) lines.push('  (no health events in the window)');
  for (const f of report.summary.failures) lines.push(`  ${String(f.failures).padStart(5)} failed / ${String(f.events).padStart(6)} events  ${f.tool}${f.circuit_open ? `  (circuit open on ${f.circuit_open})` : ''}`);
  lines.push('');
  lines.push('Confirmed-write outcomes per tool (ib_pending_actions, after the operator pressed Confirm)');
  const confirmed = report.summary.confirmed || [];
  if (!confirmed.length) lines.push('  (no confirmed writes in the window)');
  for (const c of confirmed) lines.push(`  ${String(c.failed).padStart(5)} failed / ${String(c.unknown).padStart(4)} unknown / ${String(c.confirmed).padStart(6)} confirmed  ${c.tool}`);
  return lines.join('\n');
}

async function collect(db, days) {
  return db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const calls = (await trx.raw(CALLS_SQL, [days])).rows;
    const turns = (await trx.raw(TURNS_SQL, [days])).rows;
    const failures = (await trx.raw(FAILURES_SQL, [days, HEALTH_SOURCES])).rows;
    const confirmedRows = (await trx.raw(CONFIRMED_SQL, [days])).rows;
    return { calls, turns, failures, confirmed: classifyConfirmed(confirmedRows) };
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
    const { calls, turns, failures, confirmed } = await collect(db, args.days);
    const report = { days: args.days, generated_at: new Date().toISOString(), calls, turns, summary: summarize(calls, turns, failures, confirmed) };
    console.log(args.json ? JSON.stringify(report, null, 2) : formatText(report));
  } finally {
    await db.destroy();
  }
}

module.exports = { NOT_PUBLIC_ESTIMATE, parseArgs, summarize, formatText, classifyConfirmed, CALLS_SQL, TURNS_SQL, FAILURES_SQL, CONFIRMED_SQL, HEALTH_SOURCES, DEFAULT_DAYS };

if (require.main === module) {
  main().catch((err) => {
    // code only: a knex message can carry compiled SQL and parameters
    console.error(`ib-request-tally failed (${err.code || err.name || 'error'})`);
    process.exit(1);
  });
}
