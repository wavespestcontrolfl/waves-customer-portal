#!/usr/bin/env node
// MUTATES (dry-run default for record / carry; export writes local files only)
//
// correction-replay.js — the correction loop's replay step, with NO provider
// call (owner ruling 2026-10-02). Three subcommands:
//
//   export --proposal=<id|8-char> --split=dev|holdout --out=<dir outside the repo>
//       Writes <dir>/cases.jsonl (one frozen case per incident: the customer's
//       text, the facts the drafter was given, the draft, the person's reply,
//       the quotes both readers verified), <dir>/system-prompt.txt (the
//       drafter's system prompt as THIS checkout renders it under the
//       process's gates: run it from the fix branch), and
//       <dir>/results-template.json. Claude Code subagents re-draft each case
//       from system-prompt.txt + the case's user_prompt and grade it
//       (fixed | reproduces | inconclusive). Customer text: the dir must be
//       outside the repository (the session scratchpad).
//   record --file=<results.json> [--execute]
//       Validates and stores a run: { proposal_id, split, method, code_ref,
//       prompt_version, drafter_model, notes, results: [{ incident_key,
//       verdict, reason }] }. A holdout run needs a passed dev run on the same
//       code_ref. Stamps the proposal's dev_run_id / holdout_run_id.
//   carry --proposal=<id|8-char> --run=<holdout run uuid> --version=<live prompt version> [--execute]
//       Carries a proposal to the live version when that holdout run still
//       reproduces the mistake (owner ruling Q2).
//
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node ops/agents/correction-replay.js export --proposal=1a2b3c4d --split=dev --out=$SCRATCH/replay-1a2b3c4d
//
// Nested run: the inner portal run supplies the GATE_* values the system
// prompt depends on. Output to the terminal carries ids, counts and statuses
// only.
if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/correction-replay.js …');
    process.exit(2);
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
}

const fs = require('fs');
const path = require('path');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { exportCases, recordReplayRun, carryForward } = require(path.join(REPO_ROOT, 'server', 'services', 'ai-incidents', 'replay-runs'));
const { resolveId } = require('./fix-proposal-link');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS = Object.freeze(['export', 'record', 'carry']);
const VALUE_FLAGS = Object.freeze(['proposal', 'split', 'out', 'file', 'run', 'version', 'by']);

function usageError(message, exitCode = 2) {
  return Object.assign(new Error(message), { exitCode });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw usageError(`first argument must be one of ${COMMANDS.join(', ')}`);
  const out = { command };
  for (const a of rest) {
    const m = a.match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) throw usageError(`unrecognized argument: ${a}`);
    const [, name, value] = m;
    if (name === 'execute') {
      if (value !== undefined) throw usageError('--execute takes no value');
      out.execute = true;
    } else if (VALUE_FLAGS.includes(name)) {
      if (!value) throw usageError(`--${name} needs a value`);
      out[name] = value;
    } else {
      throw usageError(`unknown flag --${name}`);
    }
  }
  return out;
}

// Customer text never lands inside the repository.
function assertOutsideRepo(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(REPO_ROOT, resolved);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw usageError('--out must be outside the repository (use the session scratchpad)');
  return resolved;
}

async function runExport({ dbi, args, log, drafter }) {
  if (!args.proposal || !args.split || !args.out) throw usageError('export needs --proposal, --split and --out');
  const dir = assertOutsideRepo(args.out);
  const id = await resolveId(dbi, args.proposal);
  const { proposal, cases, missing } = await exportCases({ dbi, proposalId: id, split: args.split });
  const d = drafter || require(path.join(REPO_ROOT, 'server', 'services', 'sms-shadow-drafter'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = cases.map((c) => JSON.stringify({
    ...c,
    user_prompt: d.buildUserPromptFromFacts(c.facts_block, c.inbound_message, { intent: String(c.intent || 'GENERAL').toUpperCase() }, false),
  }));
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  fs.writeFileSync(path.join(dir, 'system-prompt.txt'), d.buildSystemPrompt());
  fs.writeFileSync(path.join(dir, 'results-template.json'), `${JSON.stringify({
    proposal_id: proposal.id,
    split: args.split,
    method: 'subagent',
    code_ref: '<git sha of the checkout that rendered system-prompt.txt>',
    prompt_version: d.currentPromptVersion(),
    drafter_model: '<subagent model>',
    notes: null,
    results: cases.map((c) => ({ incident_key: c.incident_key, verdict: null, reason: null })),
  }, null, 2)}\n`);
  log(`exported ${cases.length} ${args.split} case(s) of ${String(proposal.id).slice(0, 8)} (${proposal.surface}/${proposal.failure_mode}) to ${dir}`);
  if (missing.length) log(`  ${missing.length} incident(s) had no stored draft and were skipped`);
  return { exported: cases.length, missing: missing.length };
}

async function runRecord({ dbi, args, log }) {
  if (!args.file) throw usageError('record needs --file');
  let body;
  try {
    body = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'));
  } catch (err) {
    throw usageError(`cannot read ${args.file}: ${err.message}`);
  }
  if (!UUID_RE.test(String(body.proposal_id || ''))) throw usageError('proposal_id must be a uuid');
  const { run } = await recordReplayRun({
    dbi,
    proposalId: body.proposal_id,
    split: body.split,
    method: body.method,
    codeRef: body.code_ref,
    promptVersion: body.prompt_version || null,
    drafterModel: body.drafter_model || null,
    notes: body.notes || null,
    results: (body.results || []).filter((r) => r && r.verdict != null),
    by: args.by || 'lane:correction-loop',
    dryRun: !args.execute,
  });
  log(`${args.execute ? 'RECORDED' : 'DRY RUN (add --execute to write)'}: ${run.split} run ${run.id ? String(run.id).slice(0, 8) : '(new)'} ${run.status} — ${run.fixed_count} fixed, ${run.reproduces_count} reproduce, ${run.inconclusive_count} inconclusive of ${run.case_count}; exact production model: no`);
  return { recorded: Boolean(args.execute), run };
}

async function runCarry({ dbi, args, log }) {
  if (!args.proposal || !args.run || !args.version) throw usageError('carry needs --proposal, --run and --version');
  if (!UUID_RE.test(args.run)) throw usageError('--run must be a run uuid');
  const id = await resolveId(dbi, args.proposal);
  const out = await carryForward({ dbi, proposalId: id, runId: args.run, promptVersion: args.version, by: args.by || 'lane:correction-loop', dryRun: !args.execute });
  log(`${args.execute ? 'CARRIED' : 'DRY RUN (add --execute to write)'}: ${String(id).slice(0, 8)} → ${out.carried.id ? String(out.carried.id).slice(0, 8) : '(new)'} on ${args.version}, ${out.carried.evidence_count} incidents`);
  return out;
}

async function run({ dbi, argv, log = console.log, drafter }) {
  const args = parseArgs(argv);
  if (args.command === 'export') return runExport({ dbi, args, log, drafter });
  if (args.command === 'record') return runRecord({ dbi, args, log });
  return runCarry({ dbi, args, log });
}

module.exports = { parseArgs, assertOutsideRepo, run };

if (require.main === module) {
  const db = require(path.join(REPO_ROOT, 'server', 'models', 'db'));
  run({ dbi: db, argv: process.argv.slice(2) })
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error(err.code ? `refused (${err.code}): ${err.message}` : err.message);
      try { await db.destroy(); } catch { /* already closed */ }
      process.exit(err.exitCode || 1);
    });
}
