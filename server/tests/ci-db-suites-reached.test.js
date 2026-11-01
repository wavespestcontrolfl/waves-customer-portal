/**
 * Every Postgres suite that skips itself without its database variable must
 * reach a CI step under which it actually runs.
 *
 * Sweep #7246 B1 (2026-10-31): 143 suites skipped in every CI job and still
 * showed green. Each one read its own variable (REPAIR_TEST_DATABASE_URL,
 * APP_TEST_DATABASE_URL, ...), and no CI step both named the suite and set
 * that variable. This test reads .github/workflows/tests.yml and fails when
 * such a suite is added. A suite that cannot run in CI yet is listed in
 * fixtures/ci-db-suites-not-run.json with its reason; the list may only
 * shrink, so wiring a listed suite in means removing its line.
 *
 * A suite's skip gates are its `cond ? describe : describe.skip` style
 * conditionals (describe, test or it). Each gate's condition is evaluated,
 * with the top-level declarations it reads, against the environment of every
 * CI command that names the file (by path, by a `grep -l '<text>'` lane whose
 * text the file contains, or in a node-spawned jest call). The suite reaches
 * CI when one command runs every gate that reads a database variable. A gate
 * that cannot be evaluated here (its declarations call require, say) counts
 * as running when the command sets one of the database variables it reads.
 * Deterministic, filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');
const acornWalk = require('acorn-walk');
const yaml = require('js-yaml');

const SERVER_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(SERVER_ROOT, '..', '.github', 'workflows', 'tests.yml');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'ci-db-suites-not-run.json');
// A variable that points a suite at a database or switches a database suite on.
const DB_VAR = /(?:DATABASE_URL|_DB_URL|_TEST_DB|_POSTGRES)$/;
const SUITE_PATH = /tests\/[\w./-]+\.test\.js/g;
// What a node-spawned step's generated `waves_qa_<32 hex>` database name stands for.
const SPAWNED_QA_NAME = `waves_qa_${'0'.repeat(32)}`;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name), out);
    else if (entry.name.endsWith('.test.js')) out.push(path.join(dir, entry.name));
  }
  return out;
}

const expand = (value, shellVars) => value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => shellVars[name] ?? '');

// Leading `NAME=value` words of a shell command, with $NAME taken from earlier lines.
function leadingEnv(line, shellVars) {
  const env = {};
  for (const token of line.trim().split(/\s+/)) {
    const assignment = token.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!assignment) break;
    env[assignment[1]] = expand(assignment[2], shellVars);
  }
  return env;
}

// The env object of a node-spawned run, evaluated with the script's own base URL
// and a stand-in for each generated waves_qa_ name.
function spawnedEnv(envBody, run, stepEnv) {
  const bindings = { process: { env: { ...stepEnv } } };
  const base = run.match(/const base = '([^']+)'/);
  if (base) bindings.base = base[1];
  for (const [, id] of run.matchAll(/const (\w+) = `waves_qa_\$\{randomBytes\(16\)\.toString\('hex'\)\}`/g)) bindings[id] = SPAWNED_QA_NAME;
  try {
    return vm.runInNewContext(`({ ...process.env,${envBody} })`, bindings, { timeout: 100 });
  } catch {
    return { ...stepEnv, ...Object.fromEntries([...envBody.matchAll(/([A-Z][A-Z0-9_]*):/g)].map((m) => [m[1], ''])) };
  }
}

// One entry per CI command that can run a suite: { env, files, grep, exclude }.
function ciCommands() {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const commands = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of (job.steps || []).flatMap((s) => s.parallel || [s])) {
      if (!step.run) continue;
      // GitHub sets CI=true on every runner.
      const stepEnv = { CI: 'true', ...workflow.env, ...job.env, ...step.env };
      const run = String(step.run);
      // run([...jest args...], { cwd: 'server', env: { ...process.env, VAR: `...`, VAR2: ... } })
      const spawned = [...run.matchAll(/run\(\[([^\]]*)\]\s*,\s*\{[^}]*?env:\s*\{\s*\.\.\.process\.env,([\s\S]*?)\}\s*\}\s*\)/g)];
      for (const [, args, envBody] of spawned) {
        commands.push({ env: spawnedEnv(envBody, run, stepEnv), files: new Set(args.match(SUITE_PATH) || []) });
      }
      if (spawned.length) continue;
      const shellVars = {};
      for (const line of run.replace(/\\\n/g, ' ').split('\n')) {
        const shellVar = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$/);
        if (shellVar) shellVars[shellVar[1]] = expand(shellVar[2], shellVars);
        const grepLane = line.match(/grep -l '([^']+)' tests\/\*\.test\.js/);
        const files = new Set(grepLane ? [] : line.match(SUITE_PATH) || []);
        if (!files.size && !grepLane) continue;
        commands.push({
          env: { ...stepEnv, ...leadingEnv(line, shellVars) },
          files,
          grep: grepLane && grepLane[1],
          exclude: [...line.matchAll(/grep -v ([\w.-]+)/g)].map((m) => m[1]),
        });
      }
    }
  }
  return commands;
}

function names(command, rel, source) {
  if (command.files.has(rel)) return true;
  return Boolean(command.grep) && /^tests\/[^/]+$/.test(rel) && source.includes(command.grep)
    && !command.exclude.some((name) => rel.includes(name));
}

const SUITE_FNS = new Set(['describe', 'test', 'it']);
const isSkipFn = (node) => node.type === 'MemberExpression' && !node.computed && node.property.name === 'skip'
  && node.object.type === 'Identifier' && SUITE_FNS.has(node.object.name);
const isRunFn = (node) => node.type === 'Identifier' && SUITE_FNS.has(node.name);

// Each `cond ? describe : describe.skip` (either order) in the file, as code that
// evaluates the condition after the top-level declarations it reads.
function skipGates(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true });
  const declarations = new Map();
  for (const statement of ast.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const d of statement.declarations) if (d.id.type === 'Identifier') declarations.set(d.id.name, statement);
    } else if (statement.type === 'FunctionDeclaration' && statement.id) {
      declarations.set(statement.id.name, statement);
    }
  }
  const gates = [];
  acornWalk.full(ast, (node) => {
    if (node.type !== 'ConditionalExpression') return;
    const skipWhenTrue = isSkipFn(node.consequent) && isRunFn(node.alternate);
    if (!skipWhenTrue && !(isRunFn(node.consequent) && isSkipFn(node.alternate))) return;
    const needed = new Set();
    const collect = (root) => acornWalk.full(root, (n) => {
      const statement = n.type === 'Identifier' && declarations.get(n.name);
      if (statement && !needed.has(statement)) { needed.add(statement); collect(statement); }
    });
    collect(node.test);
    const prelude = [...needed].sort((a, b) => a.start - b.start).map((s) => source.slice(s.start, s.end)).join('\n');
    const code = `${prelude}\n;(${source.slice(node.test.start, node.test.end)})`;
    const dbVars = [...new Set([...code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].filter((n) => DB_VAR.test(n));
    gates.push({ code, skipWhenTrue, dbVars });
  });
  return gates;
}

function gateRuns(gate, env) {
  try {
    if (gate.code === null) throw new Error('no condition to evaluate');
    const value = vm.runInNewContext(gate.code, { process: { env: { ...env } }, URL, decodeURIComponent }, { timeout: 100 });
    return gate.skipWhenTrue ? !value : Boolean(value);
  } catch {
    return gate.dbVars.some((name) => env[name] !== undefined);
  }
}

function suitesNotRun() {
  const commands = ciCommands();
  const notRun = [];
  for (const file of walk(path.join(SERVER_ROOT, 'tests'))) {
    const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    if (!/\b(?:describe|test|it)\.skip\b/.test(source)) continue;
    let gates = [];
    try { gates = skipGates(source).filter((gate) => gate.dbVars.length); } catch { gates = []; }
    if (!gates.length) {
      // No readable gate names a database variable: fall back to every one the file reads.
      const dbVars = [...new Set([...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].filter((n) => DB_VAR.test(n));
      if (!dbVars.length) continue;
      gates = [{ code: null, skipWhenTrue: false, dbVars }];
    }
    const reached = commands.some((command) => names(command, rel, source) && gates.every((gate) => gateRuns(gate, command.env)));
    if (!reached) notRun.push(rel);
  }
  return notRun.sort();
}

test('every self-skipping Postgres suite reaches a CI step under which it runs', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const notRun = suitesNotRun();
  const unlisted = notRun.filter((rel) => !Object.prototype.hasOwnProperty.call(baseline, rel));
  const stale = Object.keys(baseline).filter((rel) => !notRun.includes(rel));
  expect(unlisted.length
    ? 'These suites skip in every CI job. Name each one in .github/workflows/tests.yml on a step whose environment lets it run (or give it the exact `const SKIP = !process.env.DATABASE_URL` line):\n  '
      + unlisted.join('\n  ')
    : '').toBe('');
  expect(stale.length
    ? `These suites now run in CI or no longer exist. Remove them from ${path.relative(SERVER_ROOT, BASELINE_PATH)}:\n  ${stale.join('\n  ')}`
    : '').toBe('');
});

test('a gate is the skip condition, not every database variable the file mentions', () => {
  const source = [
    "const databaseUrl = process.env.NEW_IB_TEST_DATABASE_URL;",
    'const suite = databaseUrl ? describe : describe.skip;',
    "suite('x', () => { beforeAll(() => { process.env.DATABASE_URL = databaseUrl; }); });",
  ].join('\n');
  const [gate] = skipGates(source);
  expect(gate.dbVars).toEqual(['NEW_IB_TEST_DATABASE_URL']);
  expect(gateRuns(gate, { DATABASE_URL: 'postgresql://localhost/waves_test' })).toBe(false);
  expect(gateRuns(gate, { NEW_IB_TEST_DATABASE_URL: 'postgresql://localhost/waves_test' })).toBe(true);
  const audit = skipGates("(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('y', () => {});")[0];
  expect(gateRuns(audit, { DATABASE_URL: 'postgresql://localhost/waves_test' })).toBe(false);
  expect(gateRuns(audit, { DATABASE_URL: 'postgresql://localhost/waves_audit_ci' })).toBe(true);
});

test('the guard sees the lanes it relies on', () => {
  const commands = ciCommands();
  // The DB-gated lane's marker and at least one explicit file list.
  expect(commands.some((c) => c.grep === 'const SKIP = !process.env.DATABASE_URL')).toBe(true);
  expect(commands.filter((c) => c.files.size).length).toBeGreaterThan(10);
  expect(commands.some((c) => c.env.C360_TEST_DATABASE_URL === `postgresql://waves:waves@localhost:5432/${SPAWNED_QA_NAME}`
    && c.files.has('tests/customer360-workspace-postgres.test.js'))).toBe(true);
});
