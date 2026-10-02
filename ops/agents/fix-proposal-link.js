#!/usr/bin/env node
// MUTATES (dry-run default)
//
// fix-proposal-link.js — follow one ai_fix_proposals row through its fix
// (correction-loop scope 2026-10-02, piece 2). The Monday correction-loop
// lane runs it when it opens the PR, when Codex is clean on the head, when a
// replay run finishes, when the fix ships, and when it is reverted.
//
//   railway run --service Postgres node ops/agents/fix-proposal-link.js --list [--area=sms]
//   railway run --service Postgres node ops/agents/fix-proposal-link.js --id=<uuid|8-char-prefix> \
//     [--status=accepted|pr_open|shipped|reverted|dismissed|superseded|insufficient_evidence] \
//     [--pr=5601] [--pr-url=https://…] [--commit=<sha>] [--dev-run=<uuid>] [--holdout-run=<uuid>] \
//     [--shipped-version=<prompt version>] [--revert-pr=5620] [--by=<who>] [--execute]
//
// Without --execute every check runs (legal move, required stamps, unknown
// fields) and the change is printed; nothing is written. The legal moves and
// required stamps live in server/services/ai-incidents/fix-proposals.js, and
// the table's CHECK holds the same stamps. Output carries ids, cells, PR
// numbers and versions only — never incident text.
//
// DATABASE_URL is remapped before any server module loads (db.js opens its
// pool on require), the inventory-agent-undo.js pattern.
if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/fix-proposal-link.js --list');
    process.exit(2);
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
}

const path = require('path');
const { transitionProposal, STATUSES } = require(path.join(__dirname, '..', '..', 'server', 'services', 'ai-incidents', 'fix-proposals'));

// flag → [field, parse]; parse returns the stored value or throws.
const asPr = (flag) => (v) => {
  if (!/^\d+$/.test(v)) throw usageError(`--${flag} must be a PR number`);
  return Number(v);
};
const asRun = (flag) => (v) => {
  if (!UUID_RE.test(v)) throw usageError(`--${flag} must be a run uuid`);
  return v;
};
const asSha = (v) => {
  if (!/^[0-9a-f]{7,64}$/i.test(v)) throw usageError('--commit must be a git sha');
  return v;
};
const asText = (v) => v;
const STAMP_FLAGS = Object.freeze({
  pr: ['pr_number', asPr('pr')],
  'pr-url': ['pr_url', asText],
  commit: ['reviewed_commit', asSha],
  'dev-run': ['dev_run_id', asRun('dev-run')],
  'holdout-run': ['holdout_run_id', asRun('holdout-run')],
  'shipped-version': ['shipped_version', asText],
  'revert-pr': ['revert_pr_number', asPr('revert-pr')],
});
const OPTION_FLAGS = Object.freeze(['id', 'status', 'by', 'area']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usageError(message, exitCode = 2) {
  return Object.assign(new Error(message), { exitCode });
}

function parseArgs(argv) {
  const out = { fields: {} };
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw usageError(`unrecognized argument: ${a}`);
    const [, name, value] = m;
    if (name === 'execute' || name === 'list') { out[name] = true; continue; }
    if (value == null || value === '') throw usageError(`--${name} needs a value`);
    if (OPTION_FLAGS.includes(name)) { out[name] = value; continue; }
    if (!STAMP_FLAGS[name]) throw usageError(`unknown flag --${name}`);
    const [field, parse] = STAMP_FLAGS[name];
    out.fields[field] = parse(value);
  }
  if (out.status && !STATUSES.includes(out.status)) throw usageError(`--status must be one of ${STATUSES.join(', ')}`);
  return out;
}

// A full uuid, or an EXACT 8-character prefix that names one row.
async function resolveId(dbi, id) {
  if (UUID_RE.test(id)) return id;
  if (!/^[0-9a-f]{8}$/i.test(id)) throw usageError('--id must be a uuid or its first 8 characters');
  const rows = await dbi('ai_fix_proposals').whereRaw('id::text LIKE ?', [`${id.toLowerCase()}%`]).select('id').limit(2);
  if (rows.length !== 1) throw usageError(rows.length ? `--id=${id} matches more than one proposal` : `no proposal starts with ${id}`, 1);
  return rows[0].id;
}

function describe(row) {
  const bits = [
    String(row.id).slice(0, 8), row.status, `${row.area}:${row.surface}/${row.failure_mode}`,
    `fix=${row.fix_kind}`, `n=${row.evidence_count}`, `v=${row.prompt_version || '-'}`,
  ];
  if (row.pr_number) bits.push(`PR #${row.pr_number}`);
  if (row.reviewed_commit) bits.push(`commit ${String(row.reviewed_commit).slice(0, 10)}`);
  if (row.shipped_version) bits.push(`shipped ${row.shipped_version}`);
  if (row.supersedes) bits.push(`supersedes ${String(row.supersedes).slice(0, 8)}`);
  return bits.join('  ');
}

async function run({ dbi, argv, log = console.log }) {
  const args = parseArgs(argv);
  if (args.list) {
    const rows = await dbi('ai_fix_proposals')
      .modify((q) => { if (args.area) q.where({ area: args.area }); })
      .orderBy('created_at', 'desc')
      .limit(30);
    if (!rows.length) log('no fix proposals yet');
    for (const r of rows) log(describe(r));
    return { listed: rows.length };
  }
  if (!args.id) throw usageError('--id is required (or --list)');
  if (!args.status && !Object.keys(args.fields).length) throw usageError('nothing to change: pass --status and/or a stamp');
  const id = await resolveId(dbi, args.id);
  const updated = await transitionProposal({
    dbi, id, to: args.status, fields: args.fields, by: args.by || 'lane:correction-loop', dryRun: !args.execute,
  });
  log(`${args.execute ? 'UPDATED' : 'DRY RUN (add --execute to write)'}: ${describe(updated)}`);
  return { updated: Boolean(args.execute), row: updated };
}

module.exports = { parseArgs, resolveId, describe, run };

if (require.main === module) {
  const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
  run({ dbi: db, argv: process.argv.slice(2) })
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error(err.code ? `refused (${err.code}): ${err.message}` : err.message);
      try { await db.destroy(); } catch { /* already closed */ }
      process.exit(err.exitCode || 1);
    });
}
