/**
 * Every Postgres suite that skips itself without its database variable must
 * reach a CI step that sets that variable.
 *
 * Sweep #7246 B1 (2026-10-31): 143 suites skipped in every CI job and still
 * showed green. Each one read its own variable (REPAIR_TEST_DATABASE_URL,
 * APP_TEST_DATABASE_URL, ...), and no CI step both named the suite and set
 * that variable. This test reads .github/workflows/tests.yml and fails when
 * such a suite is added. A suite that cannot run in CI yet is listed in
 * fixtures/ci-db-suites-not-run.json with its reason; the list may only
 * shrink, so wiring a listed suite in means removing its line.
 *
 * "Reaches" means a command names the file (by path, by a `grep -l '<text>'`
 * lane whose text the file contains, or in a node-spawned jest call) and that
 * command's environment sets one of the database variables the file reads.
 * Deterministic, filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SERVER_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(SERVER_ROOT, '..', '.github', 'workflows', 'tests.yml');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'ci-db-suites-not-run.json');
// A variable that points a suite at a database or switches a database suite on.
const DB_VAR = /(?:DATABASE_URL|_DB_URL|_TEST_DB|_POSTGRES)$/;
const SUITE_PATH = /tests\/[\w./-]+\.test\.js/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name), out);
    else if (entry.name.endsWith('.test.js')) out.push(path.join(dir, entry.name));
  }
  return out;
}

function leadingEnv(line) {
  const env = {};
  for (const token of line.trim().split(/\s+/)) {
    const assignment = token.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!assignment) break;
    env[assignment[1]] = true;
  }
  return env;
}

// One entry per CI command that can run a suite: { env, files, grep, exclude }.
function ciCommands() {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  const commands = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of (job.steps || []).flatMap((s) => s.parallel || [s])) {
      if (!step.run) continue;
      const stepEnv = { ...workflow.env, ...job.env, ...step.env };
      const run = String(step.run);
      // run([...jest args...], { cwd: 'server', env: { ...process.env, VAR: ... } })
      const spawned = [...run.matchAll(/run\(\[([^\]]*)\]\s*,\s*\{[^}]*env:\s*\{\s*\.\.\.process\.env,\s*([A-Z][A-Z0-9_]*):/g)];
      for (const [, args, name] of spawned) {
        commands.push({ env: { ...stepEnv, [name]: true }, files: new Set(args.match(SUITE_PATH) || []) });
      }
      if (spawned.length) continue;
      for (const line of run.replace(/\\\n/g, ' ').split('\n')) {
        const grepLane = line.match(/grep -l '([^']+)' tests\/\*\.test\.js/);
        const files = new Set(grepLane ? [] : line.match(SUITE_PATH) || []);
        if (!files.size && !grepLane) continue;
        commands.push({
          env: { ...stepEnv, ...leadingEnv(line) },
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

function suitesNotRun() {
  const commands = ciCommands();
  const notRun = [];
  for (const file of walk(path.join(SERVER_ROOT, 'tests'))) {
    const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    if (!/\b(?:describe|test|it)\.skip\b/.test(source)) continue;
    const vars = [...new Set([...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))]
      .filter((name) => DB_VAR.test(name));
    if (!vars.length) continue;
    const reached = commands.some((command) => names(command, rel, source)
      && vars.some((name) => command.env[name] !== undefined));
    if (!reached) notRun.push(rel);
  }
  return notRun.sort();
}

test('every self-skipping Postgres suite reaches a CI step that sets its database variable', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const notRun = suitesNotRun();
  const unlisted = notRun.filter((rel) => !Object.prototype.hasOwnProperty.call(baseline, rel));
  const stale = Object.keys(baseline).filter((rel) => !notRun.includes(rel));
  expect(unlisted.length
    ? 'These suites skip in every CI job. Name each one in .github/workflows/tests.yml on a step that sets the database variable it reads (or give it the exact `const SKIP = !process.env.DATABASE_URL` line):\n  '
      + unlisted.join('\n  ')
    : '').toBe('');
  expect(stale.length
    ? `These suites now run in CI or no longer exist. Remove them from ${path.relative(SERVER_ROOT, BASELINE_PATH)}:\n  ${stale.join('\n  ')}`
    : '').toBe('');
});

test('the guard sees the lanes it relies on', () => {
  const commands = ciCommands();
  // The DB-gated lane's marker and at least one explicit file list.
  expect(commands.some((c) => c.grep === 'const SKIP = !process.env.DATABASE_URL')).toBe(true);
  expect(commands.filter((c) => c.files.size).length).toBeGreaterThan(10);
  expect(commands.some((c) => c.env.C360_TEST_DATABASE_URL && c.files.has('tests/customer360-workspace-postgres.test.js'))).toBe(true);
});
