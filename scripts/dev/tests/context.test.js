'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { childEnvironment, setup, readContext } = require('../context');

test('managed child environment excludes inherited credentials and command injection', () => {
  const root = path.resolve(__dirname, '../../..');
  process.env.STRIPE_SECRET_KEY = 'must-not-inherit';
  process.env.NODE_OPTIONS = '--require=must-not-load';
  process.env.RAILWAY_DEPLOYMENT_ID = 'must-not-inherit';
  try {
    const env = childEnvironment({ root, id: 'test', ports: { api: 31001, client: 31002 }, jwtSecret: 'test' });
    for (const key of ['STRIPE_SECRET_KEY', 'NODE_OPTIONS', 'RAILWAY_DEPLOYMENT_ID', 'DATABASE_URL']) assert.equal(env[key], undefined);
    assert.equal(env.WAVES_LOCAL_DEV, '1');
    assert.equal(env.GATE_CRON_JOBS, 'false');
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.NODE_OPTIONS;
    delete process.env.RAILWAY_DEPLOYMENT_ID;
  }
});

test('database credentials require explicit nonproduction classification and never appear in errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-dev-context-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'test']);
  fs.mkdirSync(path.join(root, '.tmp/dev'), { recursive: true });
  const context = { root, ports: { api: 31001, client: 31002 }, jwtSecret: 'test' };
  const file = path.join(root, '.tmp/dev/database.env');
  try {
    fs.writeFileSync(file, 'DATABASE_URL=postgres://test:secret@example.invalid/test\nWAVES_DATABASE_ENVIRONMENT=production\n');
    assert.throws(() => childEnvironment(context, { database: true }), /Production is forbidden/);
    fs.writeFileSync(file, 'DATABASE_URL=secret-malformed-url\nWAVES_DATABASE_ENVIRONMENT=preview\n');
    assert.throws(() => childEnvironment(context, { database: true }), /^Error: Invalid dev DATABASE_URL\.$/);
    fs.writeFileSync(file, 'DATABASE_URL=postgres://test:secret@example.invalid/test\nWAVES_DATABASE_ENVIRONMENT=preview\nSTRIPE_SECRET_KEY=ignored\n');
    const env = childEnvironment(context, { database: true });
    assert.equal(env.DATABASE_URL, 'postgres://test:secret@example.invalid/test');
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh worktrees receive distinct stable port blocks and private state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-dev-ports-'));
  const second = path.join(root, 'second');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'test']);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'second', second]);
  try {
    const a = await setup(root);
    const b = await setup(second);
    assert.equal(new Set([...Object.values(a.ports), ...Object.values(b.ports)]).size, 8);
    assert.deepEqual(await setup(root), a);
    assert.equal(fs.statSync(path.join(root, '.tmp/dev/context.json')).mode & 0o777, 0o600);
    assert.deepEqual(readContext(second), b);
    const moved = path.join(root, 'moved');
    execFileSync('git', ['-C', root, 'worktree', 'move', second, moved]);
    assert.throws(() => readContext(moved), /Checkout moved/);
    const third = path.join(root, 'third');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'third', third]);
    const c = await setup(third);
    assert.equal(new Set([...Object.values(b.ports), ...Object.values(c.ports)]).size, 8);
    const repaired = await setup(moved);
    assert.equal(repaired.root, fs.realpathSync(moved));
    assert.equal(repaired.id, b.id);
    assert.deepEqual(repaired.ports, b.ports);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner identifies its checkout, rejects foreign stop requests, and releases its ports', { timeout: 30000 }, async () => {
  const { spawn } = require('node:child_process');
  const sourceRoot = path.resolve(__dirname, '../../..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'waves-runner-test-')));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'test']);
  fs.cpSync(path.join(sourceRoot, 'scripts/dev'), path.join(root, 'scripts/dev'), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, '.nvmrc'), path.join(root, '.nvmrc'));
  fs.mkdirSync(path.join(root, 'client'));
  fs.copyFileSync(path.join(sourceRoot, 'client/vite.config.js'), path.join(root, 'client/vite.config.js'));
  fs.cpSync(path.join(sourceRoot, 'shared'), path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client/preview-estimate.html'), '<!doctype html><title>Runner fixture</title>');
  // This disposable test fixture only reads the installed dependencies.
  fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const context = await setup(root);
  const databaseFile = path.join(root, '.tmp/dev/database.env');
  fs.writeFileSync(databaseFile, 'DATABASE_URL=fixture-must-not-egress', { flag: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/dev/run.js', 'client'], { cwd: root, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const base = `http://127.0.0.1:${context.ports.control}`;
  try {
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${context.id}` } });
        if (response.ok) { status = await response.json(); break; }
      } catch { /* startup */ }
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status?.root, root, output);
    assert.equal(status?.pid, child.pid, 'Never control a runner this test did not spawn');
    const foreign = await fetch(`${base}/stop`, { method: 'POST', headers: { Authorization: 'Bearer another-worktree' } });
    assert.equal(foreign.status, 404);
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { page = await fetch(`http://127.0.0.1:${context.ports.client}/preview-estimate.html`); if (page.ok) break; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(page?.status, 200, output);
    for (const file of ['context.json', 'database.env']) {
      const response = await fetch(`http://127.0.0.1:${context.ports.client}/@fs/${root}/.tmp/dev/${file}`);
      assert.equal(response.status, 403, `${file} must never be served by Vite`);
    }
    const stop = await fetch(`${base}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${context.id}` } });
    assert.equal(stop.status, 200);
    assert.equal(await exited, 0, output);
    const { availablePort } = require('../context');
    assert.equal(await availablePort(context.ports.client), true);
    assert.equal(await availablePort(context.ports.control), true);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
