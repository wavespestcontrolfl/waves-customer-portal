'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');

function runAs(version, code) {
  return spawnSync(process.execPath, ['-e', `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n${code}`],
    { cwd: root, encoding: 'utf8' });
}

test('runtime accepts the CI major with the existing minimum and rejects older or newer majors', () => {
  for (const version of ['20.9.0', '20.20.2']) {
    const result = runAs(version, "require('./scripts/dev/runtime').checkRuntime(process.cwd())");
    assert.equal(result.status, 0, result.stderr);
  }
  for (const version of ['18.20.0', '20.8.1', '22.0.0', '26.8.1']) {
    const result = runAs(version, "require('./scripts/dev/runtime').checkRuntime(process.cwd())");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nvm install && nvm use/);
    assert.match(result.stderr, new RegExp(`Node ${version.replaceAll('.', '\\.')}`));
  }
});

test('doctor rejects a mismatched runtime before dependency, port or database checks', () => {
  const result = runAs('26.8.1', `require('./scripts/dev/doctor').doctor({root:process.cwd()})
    .catch(error => { console.error(error.message); process.exitCode = 1; });`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match this checkout's Node 20/);
});

test('worktree creation rejects a mismatched runtime before fetch, branch creation or install', () => {
  const result = runAs('26.8.1', `require('node:child_process').spawnSync = () => { throw new Error('UNEXPECTED MUTATION'); };
    process.argv = [process.execPath, 'scripts/dev/worktree.js', 'create', 'runtime-test'];
    require('./scripts/dev/worktree');`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match this checkout's Node 20/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED MUTATION/);
});


test('migration rejects an unsupported runtime before reading database credentials or spawning Knex', () => {
  const result = runAs('26.8.1', `
    const context = require('./scripts/dev/context');
    context.readContext = () => ({ root: process.cwd() });
    context.childEnvironment = () => { throw new Error('UNEXPECTED DATABASE READ'); };
    require('node:child_process').spawn = () => { throw new Error('UNEXPECTED KNEX'); };
    process.argv = [process.execPath, 'scripts/dev/run.js', 'migrate'];
    require('./scripts/dev/run');`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match this checkout's Node 20/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED/);
});

test('creation checks the fetched revision before creating a branch or worktree', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-runtime-revision-'));
  try {
    execFileSync('git', ['init', '-q', fixture]);
    fs.writeFileSync(path.join(fixture, '.nvmrc'), '22\n');
    execFileSync('git', ['-C', fixture, 'add', '.nvmrc']);
    execFileSync('git', ['-C', fixture, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'runtime fixture']);
    execFileSync('git', ['-C', fixture, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    fs.writeFileSync(path.join(fixture, '.nvmrc'), '20\n');
    const result = runAs('20.20.2', `
      require('./scripts/dev/context').rootDirectory = () => ${JSON.stringify(fixture)};
      require('node:child_process').spawnSync = (command, args) => {
        if (command === 'git' && args.join(' ') === 'fetch origin main') return { status: 0 };
        throw new Error('UNEXPECTED MUTATION');
      };
      process.argv = [process.execPath, 'scripts/dev/worktree.js', 'create', 'runtime-test'];
      require('./scripts/dev/worktree');`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node 22 development runtime/);
    assert.match(result.stderr, /nvm install 22 && nvm use 22/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED MUTATION/);
    assert.equal(execFileSync('git', ['-C', fixture, 'branch', '--list', 'feat/runtime-test'], { encoding: 'utf8' }), '');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
