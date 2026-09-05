#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readContext, childEnvironment, identity } = require('./context');
const { doctor } = require('./doctor');
const { checkRuntime } = require('./runtime');

async function main() {
  const context = readContext();
  const mode = process.argv[2] || 'app';
  if (!['app', 'client', 'debug', 'migrate'].includes(mode)) throw new Error('Expected app, client, debug, or migrate.');
  checkRuntime(context.root);
  const options = process.argv.slice(3);
  if (options.length && !(mode === 'migrate' && options.length === 1 && options[0] === '--remote')) throw new Error('Only dev:migrate supports --remote.');
  const env = childEnvironment(context, { database: mode !== 'client' });
  if (mode === 'migrate') {
    const started = Date.now();
    console.error('Applying pending migrations to the selected nonproduction database. Initial setup can take several minutes.');
    const heartbeat = setInterval(() => {
      console.error(`Migrations still running (${Math.floor((Date.now() - started) / 1000)}s elapsed).`);
    }, 30000);
    heartbeat.unref();
    try {
      process.exitCode = options.includes('--remote') ? await require('./remote-migrate').remoteMigration(context, env) :
        await new Promise((resolve) => {
          const child = spawn(process.execPath, ['node_modules/knex/bin/cli.js', 'migrate:latest', '--knexfile', 'server/knexfile.js'],
            { cwd: context.root, env, stdio: 'inherit' });
          child.once('error', () => resolve(1));
          child.once('exit', (code) => resolve(code ?? 1));
        });
    } finally { clearInterval(heartbeat); }
    return;
  }
  const report = await doctor(context, { frontend: mode === 'client' });
  const started = identity(context);
  const children = [];
  let stopping = false;
  const control = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.authorization !== `Bearer ${context.id}`) { res.writeHead(404).end(); return; }
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...started, running: true, mode, pid: process.pid }));
    } else if (req.method === 'POST' && req.url === '/stop') {
      res.end(JSON.stringify({ stopped: true, id: context.id }));
      stop(0);
    } else res.writeHead(404).end();
  });
  function stop(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) child.kill('SIGTERM');
    control.close();
    setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  }
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(context.ports.control, '127.0.0.1', resolve);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
  function launch(args, cwd) {
    const child = options.includes('--remote') ? require('./remote-migrate').remoteMigration(context, env) : spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
    children.push(child);
    child.on('error', () => stop(1));
    child.on('exit', (code) => { if (!stopping) stop(code || 1); });
  }
  if (mode !== 'client') {
    const args = mode === 'debug' ? [`--inspect=127.0.0.1:${context.ports.inspector}`] : [];
    launch([...args, 'server/index.js'], context.root);
  }
  launch([path.join(context.root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(context.ports.client), '--strictPort'],
    path.join(context.root, 'client'));
  console.log(JSON.stringify({ ...report, url: env.CLIENT_URL, mode }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
