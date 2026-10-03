#!/usr/bin/env node
// MUTATES (dry-run default for record / carry; export writes local files only)
//
// correction-replay.js — the correction loop's replay step, with NO provider
// call (owner ruling 2026-10-02). Three subcommands:
//
//   export --proposal=<id|8-char> --split=dev|holdout --out=<dir outside the repo>
//       Writes <dir>/cases.jsonl (one frozen case per incident, customer
//       identifiers redacted: the customer's text, the facts the drafter was
//       given, the draft, the person's reply,
//       the quotes both readers verified, what the replay leaves out),
//       <dir>/system-prompt-<v|base>.txt (the drafter's system prompt as THIS
//       checkout renders it under the process's gates with the voice profile
//       each draft was written under: run it from the fix branch), and
//       <dir>/results-template.json. Only prompt-wording cells replay: a
//       facts-block gap (the new fact is not in the frozen facts), a few-shot
//       leak and a verifier miss are refused. Claude Code subagents re-draft each case
//       from system-prompt.txt + the case's user_prompt and grade it
//       (fixed | reproduces | inconclusive). Customer text: the dir must be
//       outside the repository (the session scratchpad).
//   record --file=<results.json> [--execute [--delete-export]]
//       Validates and stores a run: { proposal_id, split, method, purpose
//       (fix | recurrence), code_ref,
//       prompt_version, drafter_model, notes, results: [{ incident_key,
//       verdict, reason }] }. A fix's holdout run needs a passed dev run on
//       the same code_ref and version, and stamps the proposal; a recurrence
//       check (dev cases, a newer version) needs neither and is what carry reads.
//       A holdout export needs the proposal's current dev run passed on this
//       checkout's commit and prompt version.
//   carry --proposal=<id|8-char> --run=<holdout run uuid> --version=<live prompt version> [--execute]
//       Carries a proposal to the live version when that recurrence check (dev
//       cases) still reproduces the mistake (owner ruling Q2).
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
const BOOLEAN_FLAGS = Object.freeze(['execute', 'delete-export']);

function usageError(message, exitCode = 2) {
  return Object.assign(new Error(message), { exitCode });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw usageError(`first argument must be one of ${COMMANDS.join(', ')}`);
  const out = { command };
  for (const a of rest) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw usageError(`unrecognized argument: ${a}`);
    const [, name, value] = m;
    if (BOOLEAN_FLAGS.includes(name)) {
      if (value !== undefined) throw usageError(`--${name} takes no value`);
      out[name === 'delete-export' ? 'deleteExport' : name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      if (!value) throw usageError(`--${name} needs a value`);
      out[name] = value;
    } else {
      throw usageError(`unknown flag --${name}`);
    }
  }
  return out;
}

// The real path of `p`: its deepest existing ancestor resolved through any
// symlink, plus the parts that do not exist yet.
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

// Customer text never lands inside the repository: compared on real paths,
// by whole path components (a folder named "..replay" is still inside).
function assertOutsideRepo(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(canonical(REPO_ROOT), canonical(resolved));
  const inside = rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
  if (inside) throw usageError('--out must be outside the repository (use the session scratchpad)');
  return resolved;
}

// The commit the prompts are rendered from. A checkout with uncommitted
// changes to tracked files renders prompts HEAD does not describe, so its
// code_ref would vouch for the wrong candidate: refused.
function gitHead() {
  const { execFileSync } = require('child_process');
  const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (dirty) throw usageError('the checkout has uncommitted changes: commit the candidate first, so code_ref names exactly what is replayed');
  return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

const EXPORT_MARKER = '.correction-replay-export.json';

async function runExport({ dbi, args, log, drafter, codeRefOf = gitHead }) {
  if (!args.proposal || !args.split || !args.out) throw usageError('export needs --proposal, --split and --out');
  const dir = assertOutsideRepo(args.out);
  // A dedicated folder: cleanup later removes exactly what this export wrote.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw usageError(`--out ${dir} must be a new or empty folder`);
  const id = await resolveId(dbi, args.proposal);
  const d = drafter || require(path.join(REPO_ROOT, 'server', 'services', 'sms-shadow-drafter'));
  // The code and prompt version this checkout replays: what the exported
  // prompts are rendered from, and what a holdout export must match.
  const codeRef = codeRefOf();
  const promptVersion = d.currentPromptVersion();
  const { proposal, cases, missing } = await exportCases({ dbi, proposalId: id, split: args.split, codeRef, promptVersion });
  if (!cases.length) throw usageError(`the proposal has no ${args.split} cases to export${missing.length ? ` (${missing.length} without a stored draft)` : ''}`, 1);
  // One system prompt per voice profile the drafts were written under, as
  // THIS checkout renders it with that profile's stored text.
  const versions = [...new Set(cases.map((c) => c.voice_profile_version).filter((v) => v != null))];
  const profiles = versions.length
    ? await dbi('voice_profiles').whereIn('version', versions).select('version', 'profile_text')
    : [];
  const profileText = new Map(profiles.map((p) => [Number(p.version), p.profile_text]));
  fs.mkdirSync(dir, { recursive: true });
  const promptFiles = new Map();
  const promptFileFor = (version) => {
    const name = version == null ? 'system-prompt-base.txt' : `system-prompt-v${version}.txt`;
    if (!promptFiles.has(name)) {
      fs.writeFileSync(path.join(dir, name), d.buildSystemPromptWithProfile(version == null ? '' : profileText.get(version)).system);
      promptFiles.set(name, true);
    }
    return name;
  };
  const lines = cases.map((c) => {
    const lost = c.voice_profile_version != null && !profileText.has(c.voice_profile_version);
    return JSON.stringify({
      ...c,
      system_prompt_file: promptFileFor(lost ? null : c.voice_profile_version),
      replay_omits: lost ? [...c.replay_omits, 'voice_profile'] : c.replay_omits,
      user_prompt: d.buildUserPromptFromFacts(c.facts_block, c.inbound_message, {
        // Exactly as stored: the prompt compares it to the drafter's own names.
        intent: c.intent || 'GENERAL',
        ...(c.approved_reply ? { approvedReply: c.approved_reply } : {}),
      }, c.scheduling_intent),
    });
  });
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  fs.writeFileSync(path.join(dir, 'results-template.json'), `${JSON.stringify({
    proposal_id: proposal.id,
    split: args.split,
    method: 'subagent',
    purpose: 'fix',
    code_ref: codeRef,
    prompt_version: promptVersion,
    drafter_model: '<subagent model>',
    notes: null,
    results: cases.map((c) => ({ incident_key: c.incident_key, verdict: null, reason: null })),
  }, null, 2)}\n`);
  const written = ['cases.jsonl', 'results-template.json', ...promptFiles.keys()];
  fs.writeFileSync(path.join(dir, EXPORT_MARKER), `${JSON.stringify({ proposal_id: proposal.id, split: args.split, files: written })}\n`);
  log(`exported ${cases.length} ${args.split} case(s) of ${String(proposal.id).slice(0, 8)} (${proposal.surface}/${proposal.failure_mode}) to ${dir}`);
  log('  customer text is redacted, but names of other people can remain: keep this folder in the session scratchpad and remove it with `record --execute --delete-export` once the run is stored');
  if (missing.length) log(`  ${missing.length} incident(s) had no stored draft and were skipped`);
  return { exported: cases.length, missing: missing.length };
}

// Owner ruling 2026-10-02: exported cases may sit in the session scratchpad
// (never the repo) only until the run is recorded. Removes the folder only
// when it is an export folder (it holds cases.jsonl) outside the repository.
function removeExportDir(dir, resultsFile, log) {
  assertOutsideRepo(dir);
  const markerPath = path.join(dir, EXPORT_MARKER);
  if (!fs.existsSync(markerPath)) throw usageError(`${dir} is not an export folder (no ${EXPORT_MARKER}); nothing deleted`);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  // Only the files this export wrote (plus the graded results file beside
  // them), by plain name; the folder goes only if nothing else is left.
  const names = [...(marker.files || []), path.basename(resultsFile), EXPORT_MARKER].filter((n) => n === path.basename(n));
  for (const name of new Set(names)) fs.rmSync(path.join(dir, name), { force: true });
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
  log(`deleted the exported cases in ${dir}`);
}

async function runRecord({ dbi, args, log }) {
  if (args.deleteExport && !args.execute) throw usageError('--delete-export runs only with --execute (after the run is stored)');
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
    purpose: body.purpose || 'fix',
    codeRef: body.code_ref,
    promptVersion: body.prompt_version || null,
    drafterModel: body.drafter_model || null,
    notes: body.notes || null,
    results: (body.results || []).filter((r) => r && r.verdict != null),
    by: args.by || 'lane:correction-loop',
    dryRun: !args.execute,
  });
  if (args.deleteExport && args.execute) removeExportDir(path.dirname(path.resolve(args.file)), args.file, log);
  log(`${args.execute ? 'RECORDED' : 'DRY RUN (add --execute to write)'}: ${run.purpose} ${run.split} run ${run.id ? String(run.id).slice(0, 8) : '(new)'} ${run.status} — ${run.fixed_count} fixed, ${run.reproduces_count} reproduce, ${run.inconclusive_count} inconclusive of ${run.case_count}; exact production model: no`);
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

async function run({ dbi, argv, log = console.log, drafter, codeRefOf }) {
  const args = parseArgs(argv);
  if (args.command === 'export') return runExport({ dbi, args, log, drafter, codeRefOf });
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
