#!/usr/bin/env node
/**
 * ib-replay-export.js — READ-ONLY. Saves recent Intelligence Bar requests as
 * cases for ops/agents/ib-replay.js, with the bar's gate profile and live
 * field roster, in one file.
 *
 * For each request it reads ib_tasks (the question, page data, resolved
 * target and the saved conversation with every tool call and its answer)
 * and the cards the request made (ib_pending_actions). The session is read
 * only (readOnlyConn), checked before the first read. Production
 * deletes a saved request 30 days after it ran, so this file is the lasting
 * copy. It holds customer text, which the replay needs (the questions as
 * asked), by owner decision 2026-11-02 (an exception to the README's
 * convention 3 for this file only): --out must be outside the checkout, the
 * file is owner-only (0600), and it never goes into git or a shared place.
 *
 *   railway run --service Postgres -- railway run --service waves-customer-portal \
 *     node ops/agents/ib-replay-export.js --out ~/ib-replay/cases.json [--limit 40] [--days 30]
 *
 * Needs PG_CA_FILE (see ops/agents/second-tech-handover.js). The inner
 * `railway run` supplies the portal's variables; only the bar's gate and
 * model settings are saved (lib.profileFrom), never a credential.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./ib-replay-lib');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Enough saved requests to fill --limit after the ones with no tool or no
// confirmed outcome are left out.
const CANDIDATE_ROWS = 1000;

function parseArgs(argv) {
  const args = { limit: 40, days: 30, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--days') args.days = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a whole number above 0');
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 30) throw new Error('--days must be 1 to 30');
  args.out = lib.assertOutsideRepo(args.out, REPO_ROOT);
  return args;
}

// Admin bar requests that finished with an answer or a card; image requests
// cannot replay (images are never saved) and the tech and agent-estimate bars
// have their own tool sets.
const TASKS_SQL = `
  SELECT t.id, t.created_at, t.request, t.page_context, t.target, t.checkpoint, t.response,
         COALESCE(json_agg(json_build_object('tool_name', p.tool_name, 'params', p.params, 'status', p.status)
                  ORDER BY p.created_at) FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS cards
  FROM ib_tasks t
  LEFT JOIN ib_pending_actions p ON p.task_id = t.id
  WHERE t.created_at >= now() - make_interval(days => ?)
    AND t.state IN ('responded', 'awaiting_approval')
    AND jsonb_typeof(t.checkpoint) = 'array'
    AND COALESCE(t.request->>'had_images', 'false') <> 'true'
    AND COALESCE(t.request->>'context', '') NOT IN ('tech', 'agent_estimate')
  GROUP BY t.id
  ORDER BY t.created_at DESC
  LIMIT ?`;

async function main(argv) {
  const args = parseArgs(argv);
  if (!process.env.DATABASE_PUBLIC_URL) {
    throw new Error('DATABASE_PUBLIC_URL is not set: run via railway run --service Postgres -- railway run --service'
      + ' waves-customer-portal node ops/agents/ib-replay-export.js --out <file> (with PG_CA_FILE)');
  }
  const { readOnlyConn } = require('./second-tech-handover');
  const { applyAssignable } = require('../../server/services/technician-eligibility');
  const conn = readOnlyConn(process.env.DATABASE_PUBLIC_URL);
  try {
    // One pooled connection, made read-only as it opens: prove it before reading.
    const { rows: [session] } = await conn.raw('SHOW transaction_read_only');
    if (session?.transaction_read_only !== 'on') throw new Error('the session is not read-only; refusing to read');
    const { rows } = await conn.raw(TASKS_SQL, [args.days, CANDIDATE_ROWS]);
    const roster = (await applyAssignable(conn('technicians')).orderBy('name').select('name')).map((r) => r.name).filter(Boolean);
    const all = rows.map(lib.caseFromTask).filter(Boolean);
    const cases = lib.pickCases(all, args.limit);
    const file = { version: 1, exportedAt: new Date().toISOString(), days: args.days, profile: lib.profileFrom(process.env), roster, cases };
    fs.mkdirSync(path.dirname(args.out), { recursive: true, mode: 0o700 });
    lib.writePrivateFile(args.out, `${JSON.stringify(file, null, 1)}\n`);
    const kinds = (kind) => cases.filter((c) => c.kind === kind).length;
    console.log(`${rows.length} saved requests read; ${all.length} usable; ${cases.length} saved`
      + ` (${kinds('card')} card, ${kinds('read')} read); ${Object.keys(file.profile).length} settings; roster ${roster.length}.`);
    console.log(`Wrote ${args.out}`);
  } finally {
    await conn.destroy();
  }
}

module.exports = { parseArgs, TASKS_SQL };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
