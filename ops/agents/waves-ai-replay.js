#!/usr/bin/env node
// READ-ONLY
//
// waves-ai-replay.js — how the SMS house-voice agent ("Waves AI") answered real customer texts, beside
// what a person sent and the nightly judge's verdict. Phase 0 of the portal Waves AI scope (owner
// 2026-11-05): the accuracy read before Waves AI answers in portal chat. Reads message_drafts (drafter
// house_voice, backfill cohorts excluded) and shadow_draft_judgments. No model call, no send, no write
// to the database. Scoring lives in server/services/eval/waves-ai-replay.js (unit-tested).
//
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node ops/agents/waves-ai-replay.js [--days=30] [--limit=2000] [--json] [--out=<dir outside the repo>]
//
// stdout: counts and rates only, never message text — overall, by intent and by prompt version (unsafe
// rate, as-good-or-better rate, average judge score, could-send rate), the links and actions the drafts
// asked for, and how many cancel / refund / charge requests the drafts handed to the office.
// --out writes <dir>/cases.jsonl: one redacted case per draft (customer text, Waves AI draft, the
// person's reply, verdict, actions) for a side-by-side read. Customer text, so the folder must be
// outside the repository (the session scratchpad); delete it when done.
if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/waves-ai-replay.js');
    process.exit(2);
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  process.env.LOG_LEVEL = 'error';
}

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { summarize, caseOf } = require(path.join(REPO_ROOT, 'server', 'services', 'eval', 'waves-ai-replay'));

const DRAFTER = 'house_voice';

function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

function parseArgs(argv) {
  const value = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const days = value('days') == null ? 30 : Number(value('days'));
  if (!(Number.isInteger(days) && days >= 1 && days <= 365)) throw usageError('--days must be a whole number from 1 to 365');
  const limit = value('limit') == null ? 2000 : Number(value('limit'));
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 20000)) throw usageError('--limit must be a whole number from 1 to 20000');
  const out = value('out');
  if (argv.includes('--out')) throw usageError('--out needs a folder: --out=<dir outside the repo>');
  return { days, limit, json: argv.includes('--json'), out: out ? assertOutsideRepo(out) : null };
}

// Real path of the nearest existing ancestor plus the rest, so a folder that does not exist yet still
// compares on real paths (a symlinked scratchpad cannot smuggle the folder back into the repo).
function canonical(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head)) {
    tail.unshift(path.basename(head));
    const parent = path.dirname(head);
    if (parent === head) break;
    head = parent;
  }
  return path.join(fs.realpathSync(head), ...tail);
}

// Customer text never lands inside the repository: compared on real paths, by whole path components.
function assertOutsideRepo(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(canonical(REPO_ROOT), canonical(resolved));
  const inside = rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
  if (inside) throw usageError('--out must be outside the repository (use the session scratchpad)');
  return resolved;
}

async function loadRows(dbi, { since, limit, withText }) {
  const cols = ['d.id', 'd.created_at', 'd.intent', 'd.prompt_version', 'd.intended_actions', 'j.verdict', 'j.scores', 'j.could_send', 'j.human_replied'];
  // The restricted-request count reads the customer's text in memory; it is printed only as a count.
  cols.push('d.inbound_message');
  if (withText) cols.push('d.draft_response', 'j.human_reply_text', 'c.first_name', 'c.last_name');
  const q = dbi('message_drafts as d')
    .leftJoin('shadow_draft_judgments as j', 'j.draft_id', 'd.id')
    .where('d.drafter', DRAFTER)
    .where('d.created_at', '>=', since)
    // Backfill cohorts draft today's facts onto old texts (sms-graduation.js): not how it answers live.
    .where((w) => w.whereNull('d.prompt_version').orWhere('d.prompt_version', 'not like', '%backfill'))
    .orderBy('d.created_at', 'desc')
    .limit(limit)
    .select(cols);
  if (withText) q.leftJoin('customers as c', 'c.id', 'd.customer_id');
  return q;
}

const pct = (r) => (r == null ? '    -' : `${(100 * r).toFixed(1)}%`.padStart(6));

function line(label, g) {
  return `  ${String(label).slice(0, 34).padEnd(34)} drafts ${String(g.drafts).padStart(5)}  graded ${String(g.graded).padStart(4)}`
    + `  unsafe ${pct(g.unsafe_rate)}  as-good ${pct(g.as_good_or_better_rate)}  could-send ${pct(g.could_send_rate)}`
    + `  score ${g.avg_overall == null ? '  -' : String(g.avg_overall).padStart(4)}${g.small_sample ? '  (small sample)' : ''}`;
}

function formatReport(s, { days, truncated }) {
  const out = [
    `Waves AI (SMS house-voice agent) on real customer texts, last ${days} days${truncated ? ' (row limit reached: raise --limit)' : ''}`,
    'unsafe = invented fact, price quote or unsafe commitment, over graded drafts. as-good = judged equal to or better than the person.',
    'could-send = the person could have sent the AI draft as is or with an edit (stricter judge only).',
    '',
    line('all texts', s.overall),
    '',
    'By kind of question:',
    ...s.by_intent.map((g) => line(g.key, g)),
    '',
    'By drafter version:',
    ...s.by_prompt_version.map((g) => line(g.key, g)),
    '',
    'Links and actions the drafts asked for (drafts per action):',
    ...(s.actions.length ? s.actions.map((a) => `  ${a.action.padEnd(40)} ${String(a.drafts).padStart(5)}`) : ['  none']),
    '',
    `Cancel / refund / charge requests: ${s.restricted.requests}  handed to the office: ${s.restricted.escalated}  not handed over: ${s.restricted.not_escalated}`,
  ];
  return out.join('\n');
}

async function run({ dbi, argv, now = new Date(), log = console.log }) {
  const args = parseArgs(argv);
  const since = new Date(now.getTime() - args.days * 86400000);
  const rows = await loadRows(dbi, { since, limit: args.limit, withText: !!args.out });
  const summary = summarize(rows, { since: since.toISOString(), until: now.toISOString() });
  const truncated = rows.length >= args.limit;
  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    const file = path.join(args.out, 'cases.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(caseOf(r))).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
    console.error(`wrote ${rows.length} redacted cases to ${file} — customer text: delete the folder when done`);
  }
  log(args.json ? JSON.stringify({ ...summary, days: args.days, truncated }, null, 2) : formatReport(summary, { days: args.days, truncated }));
  return summary;
}

module.exports = { parseArgs, assertOutsideRepo, formatReport, run };

if (require.main === module) {
  const db = require(path.join(REPO_ROOT, 'server', 'models', 'db'));
  run({ dbi: db, argv: process.argv.slice(2) })
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error(err.message);
      try { await db.destroy(); } catch { /* already closed */ }
      process.exit(err.exitCode || 1);
    });
}
