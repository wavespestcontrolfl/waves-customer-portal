#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { rootDirectory, setup, readContext, identity } = require('./context');
const { checkRuntime } = require('./runtime');

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}).`);
}

async function main() {
  const [action, slug, destination] = process.argv.slice(2);
  const root = rootDirectory();
  if (action === 'create') {
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug || '')) throw new Error('Usage: npm run worktree:create -- <slug> [destination]');
    checkRuntime(root);
    const target = path.resolve(destination || path.join(root, '..', `wt-${slug}`));
    command('git', ['fetch', 'origin', 'main'], root);
    const revision = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim();
    checkRuntime(root, revision);
    command('git', ['worktree', 'add', '-b', `feat/${slug}`, target, revision], root);
    checkRuntime(target);
    command('npm', ['ci', '--no-audit', '--no-fund'], target);
    console.log(JSON.stringify(identity(await setup(target)), null, 2));
    return;
  }
  if (action === 'setup') {
    checkRuntime(root);
    console.log(JSON.stringify(identity(await setup()), null, 2));
    return;
  }
  if (!['status', 'stop'].includes(action)) throw new Error('Expected create, setup, status, or stop.');
  const context = readContext();
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${context.ports.control}/${action}`, {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${context.id}` }, signal: AbortSignal.timeout(2000),
    });
  } catch {
    if (action === 'stop') throw new Error('No matching managed runner found; no process was signalled.');
    console.log(JSON.stringify({ ...identity(context), running: false }, null, 2));
    return;
  }
  if (!response.ok) throw new Error('Port belongs to another runner; no process was signalled.');
  console.log(JSON.stringify(await response.json(), null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
