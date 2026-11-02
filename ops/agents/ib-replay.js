#!/usr/bin/env node
/**
 * ib-replay.js — the Intelligence Bar replay test (first-tool check). It
 * sends saved bar requests (ops/agents/ib-replay-export.js) through the real
 * bar route on this Mac and checks the FIRST tool the model picks against the
 * tool the bar picked when the request ran. Use it before a change to the
 * bar's tools, gates or model: run once as live today, once with the change
 * (--set), then compare.
 *
 *   IB_REPLAY_DATABASE_URL=postgresql://localhost/ib_replay \
 *     node ops/agents/ib-replay.js run --cases ~/ib-replay/cases.json --out ~/ib-replay/before.json \
 *     [--set GATE_X=true ...] [--limit 40] [--max-usd 10] [--execute]
 *   node ops/agents/ib-replay.js compare ~/ib-replay/before.json ~/ib-replay/after.json
 *
 * The case file holds customer text (see ib-replay-export.js); the result
 * file holds tool names, verdicts, token counts and cost only.
 *
 * Without --execute nothing leaves this Mac: each case builds the bar's first
 * model request and stops there ($0; it proves the setup). With --execute each
 * case makes ONE paid model call with ANTHROPIC_API_KEY (Claude Opus 5.5:
 * about $3-4 for 40 cases), and the run stops starting cases once the
 * estimated spend reaches --max-usd (default 10).
 *
 * What the replay holds fixed:
 *  - Environment: everything except PATH, HOME, TMPDIR, TZ and LANG is dropped
 *    before any server module loads; then the export's gate profile and --set
 *    apply. Owner-direct writes, the OpenAI backup and the credit-key pool are
 *    forced off, and the checkout's .env is never read (WAVES_LOCAL_DEV=1).
 *  - Database: a dedicated localhost database named ib_replay*, migrated to
 *    this checkout (DATABASE_URL=<it> npm run db:migrate). The run sets its
 *    field roster to the exported one (the bar's rules name it) and writes its
 *    own task, thread and ledger rows there.
 *  - Login: the owner's admin login with full access (a local technicians row).
 *  - The named customer: the target the request resolved to when it ran, so
 *    no customer record is needed here.
 *  - Model calls: a case's first call is the measured one. It and every later
 *    call get a final text answer back, so the bar never runs a tool.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./ib-replay-lib');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO_ROOT, 'server');
const fromServer = (...parts) => path.join(SERVER, ...parts);
const OWNER_ID = '00000000-0000-4000-8000-00000000ba11';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, set: [], limit: 40, maxUsd: 10, execute: false, files: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--cases') args.cases = rest[++i];
    else if (arg === '--out') args.out = rest[++i];
    else if (arg === '--set') args.set.push(rest[++i]);
    else if (arg === '--limit') args.limit = Number(rest[++i]);
    else if (arg === '--max-usd') args.maxUsd = Number(rest[++i]);
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else args.files.push(arg);
  }
  // A non-number budget would never be reached, so it would never stop a run.
  if (!Number.isFinite(args.maxUsd) || args.maxUsd <= 0) throw new Error('--max-usd must be a number above 0');
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a whole number above 0');
  return args;
}

// --set GATE_X=true changes one bar setting for this run (the new setup).
function overrides(list) {
  return Object.fromEntries(list.map((item) => {
    const at = String(item || '').indexOf('=');
    const key = at > 0 ? item.slice(0, at) : '';
    if (!key || !Object.keys(lib.profileFrom({ [key]: '' })).length) {
      throw new Error(`--set takes a bar setting as KEY=value (GATE_*, MODEL_*, INTELLIGENCE_BAR_*, IB_*): ${item}`);
    }
    return [key, item.slice(at + 1)];
  }));
}

// A final text answer: the bar ends the request without running a tool.
function stopReply(model) {
  return {
    id: 'msg_ib_replay', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'Replay stop.' }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function measure(state, params, send) {
  const run = state.current;
  if (!run || (run.calls += 1) > 1) return stopReply(params.model);
  run.model = params.model;
  run.toolCount = Array.isArray(params.tools) ? params.tools.length : 0;
  if (!send) return stopReply(params.model);
  // --max-usd counts spend from list prices, so a model with no price is never sent.
  if (!lib.PRICES[params.model]) {
    run.error = `no list price for ${params.model} in ib-replay-lib.js`;
    return stopReply(params.model);
  }
  let response;
  try {
    response = await send(params);
  } catch (err) {
    run.error = String(err.message || err).slice(0, 200);
    throw err;
  }
  run.usage = response.usage || null;
  const call = (response.content || []).find((block) => block.type === 'tool_use');
  run.actual = call ? { name: call.name, input: call.input || {} } : null;
  return stopReply(params.model);
}

// Every Anthropic client the bar's code creates answers through measure().
// Only the first call of a case with --execute reaches the API.
function installModel(state, execute) {
  const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [SERVER] });
  const Real = require(sdkPath);
  class ReplayAnthropic extends Real {
    constructor(options) {
      super(options);
      for (const resource of [this.messages, this.beta?.messages].filter(Boolean)) {
        const create = resource.create.bind(resource);
        resource.create = (params, options) => measure(state, params, execute ? (p) => create(p, options) : null);
        resource.stream = () => { throw new Error('ib-replay: streaming is not replayed'); };
      }
    }
  }
  // The SDK's named exports are getters, so they are redefined, not assigned.
  for (const name of ['Anthropic', 'default']) Object.defineProperty(ReplayAnthropic, name, { value: ReplayAnthropic });
  require.cache[sdkPath].exports = ReplayAnthropic;
}

// The owner's admin login with full access (ib-access.js), as a local row.
function installLogin(email) {
  const technician = { id: OWNER_ID, name: 'Replay owner', email, role: 'admin' };
  const auth = require(fromServer('middleware', 'admin-auth'));
  auth.adminAuthenticate = (req, _res, next) => {
    Object.assign(req, { technician, technicianId: OWNER_ID, techRole: 'admin' });
    next();
  };
  auth.requireTechOrAdmin = (_req, _res, next) => next();
  return technician;
}

// The named customer resolves to what the request resolved to when it ran.
function installTarget(state) {
  const TaskContext = require(fromServer('services', 'intelligence-bar', 'task-context'));
  TaskContext.resolve = async () => state.current?.target || {};
}

async function prepareDatabase(db, roster, owner) {
  const latest = fs.readdirSync(fromServer('models', 'migrations')).filter((f) => /^\d+_.+\.js$/.test(f)).sort().pop();
  if (!(await db('knex_migrations').where({ name: latest }).first())) {
    throw new Error(`the replay database is behind this checkout (no ${latest}): run DATABASE_URL=<it> npm run db:migrate`);
  }
  await db('technicians').update({ field_dispatchable: false });
  for (const name of roster) {
    const updated = await db('technicians').where({ name }).update({ employment_status: 'active', field_dispatchable: true });
    if (!updated) await db('technicians').insert({ name, employment_status: 'active', field_dispatchable: true });
  }
  await db('technicians').insert({ id: owner.id, name: owner.name, email: owner.email, role: 'admin' }).onConflict('id').ignore();
}

function requestBody(c) {
  return {
    prompt: c.prompt,
    conversationHistory: c.conversationHistory,
    context: c.context,
    pageData: c.pageData,
    ...(c.selectedTarget ? { selected_target: c.selectedTarget } : {}),
    session_id: crypto.randomUUID(),
    request_key: `ib-replay-${crypto.randomUUID()}`,
  };
}

async function replayCase(base, state, c, execute) {
  state.current = { calls: 0, target: c.target };
  const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody(c)) });
  const body = await res.json().catch(() => null);
  const run = state.current;
  state.current = null;
  const score = run.error ? { verdict: 'model_error', sameInput: false }
    : !run.calls ? { verdict: 'no_model_call', sameInput: false }
      : execute ? lib.scoreFirstTool(c.firstTool, run.actual) : { verdict: 'dry_ok', sameInput: false };
  // Tool names, verdicts and counts only: a result file holds no customer text.
  return {
    id: c.id, kind: c.kind, expected: c.firstTool.name, actual: run.actual?.name ?? null,
    ...score, status: res.status, error: run.error || (res.ok ? null : String(body?.error || body?.message || '').slice(0, 200)),
    tools: run.toolCount ?? null, model: run.model ?? null, usage: run.usage ?? null,
    costUsd: run.usage ? lib.costUsd(run.model, run.usage) : null,
  };
}

async function runCases(args) {
  const file = JSON.parse(fs.readFileSync(lib.assertOutsideRepo(args.cases, REPO_ROOT), 'utf8'));
  const out = lib.assertOutsideRepo(args.out, REPO_ROOT);
  const set = overrides(args.set);
  if (args.execute && !process.env.ANTHROPIC_API_KEY) throw new Error('--execute needs ANTHROPIC_API_KEY');
  const env = lib.replayEnv(process.env, { ...file.profile, ...set }, {
    databaseUrl: process.env.IB_REPLAY_DATABASE_URL, apiKey: args.execute ? process.env.ANTHROPIC_API_KEY : null,
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);

  const state = { current: null };
  installModel(state, args.execute);
  const owner = installLogin(require(fromServer('services', 'intelligence-bar', 'ib-access')).fullAccessAllowlist()[0]);
  installTarget(state);
  const db = require(fromServer('models', 'db'));
  const express = require(require.resolve('express', { paths: [SERVER] }));
  const results = [];
  let server = null;
  try {
    await prepareDatabase(db, file.roster || [], owner);
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/bar', require(fromServer('routes', 'admin-intelligence-bar')));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/bar`;
    let spent = 0;
    for (const c of file.cases.slice(0, args.limit)) {
      if (args.execute && spent >= args.maxUsd) {
        results.push({ id: c.id, kind: c.kind, expected: c.firstTool.name, actual: null, verdict: 'skipped_budget', sameInput: false });
        continue;
      }
      const result = await replayCase(base, state, c, args.execute);
      spent += result.costUsd || 0;
      results.push(result);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  }
  const spentUsd = Number(results.reduce((sum, r) => sum + (r.costUsd || 0), 0).toFixed(4));
  const report = { version: 1, mode: 'first-tool', ranAt: new Date().toISOString(), execute: args.execute, set, cases: path.resolve(args.cases), spentUsd, results };
  lib.writePrivateFile(out, `${JSON.stringify(report, null, 1)}\n`);
  for (const r of results) console.log(`${String(r.id).slice(0, 8)}  ${r.kind.padEnd(4)}  ${r.expected} -> ${r.actual || '-'}  ${r.verdict}${r.error ? `  (${r.status} ${r.error})` : ''}`);
  const count = (verdict) => results.filter((r) => r.verdict === verdict).length;
  console.log(args.execute
    ? `pass ${count('pass')} of ${results.length}; spent about $${spentUsd.toFixed(2)}. Wrote ${out}`
    : `dry run: ${count('dry_ok')} of ${results.length} built a model request; no model was called. Wrote ${out}`);
}

function compareFiles(args) {
  if (args.files.length !== 2) throw new Error('compare takes two result files: before after');
  const [before, after] = args.files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const report = lib.compareRuns(before, after);
  console.log(`pass before ${report.passBefore}, after ${report.passAfter}, of ${report.rows.length} cases in both runs`);
  for (const r of report.changed) {
    console.log(`${String(r.id).slice(0, 8)}  ${r.kind.padEnd(4)}  ${r.expected}: ${r.before} -> ${r.after} (now ${r.afterTool || 'no tool'})`);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'run') return runCases(args);
  if (args.command === 'compare') return compareFiles(args);
  throw new Error('usage: ib-replay.js run --cases <file> --out <file> [--set KEY=value] [--limit N] [--max-usd N] [--execute] | compare <before> <after>');
}

module.exports = { parseArgs, overrides, stopReply, measure };

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), (err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
