#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { checkRuntime } = require('./runtime');
const { childEnvironment } = require('./context');
const { assertNonproduction, PROJECT_ID } = require('./remote-migrate');

function validateRequest(request, remote) {
  assertNonproduction(remote.RAILWAY_ENVIRONMENT_ID, remote.RAILWAY_ENVIRONMENT_NAME);
  for (const [key, name] of Object.entries({ projectId: 'RAILWAY_PROJECT_ID', environmentId: 'RAILWAY_ENVIRONMENT_ID',
    serviceId: 'RAILWAY_SERVICE_ID', deploymentId: 'RAILWAY_DEPLOYMENT_ID', sha: 'RAILWAY_GIT_COMMIT_SHA' })) {
    if (!request[key] || request[key] !== remote[name]) throw new Error('Remote deployment identity/commit mismatch.');
  }
  if (request.projectId !== PROJECT_ID || !/^[a-f0-9]{40}$/.test(request.sha) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.worktreeId || '')) {
    throw new Error('Invalid remote migration identity.');
  }
  if (!/^[a-f0-9-]{36}$/.test(request.nonce || '')) throw new Error('Invalid completion nonce.');
  const url = new URL(request.databaseUrl);
  if (url.search || url.hash || !['postgres:', 'postgresql:'].includes(url.protocol) || !/^[a-z0-9-]+\.railway\.internal$/.test(url.hostname) ||
      url.pathname !== `/waves_qa_${request.worktreeId.replaceAll('-', '')}`) throw new Error('Remote database is not a private worktree database.');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw new Error('Remote migration input is too large.');
  }
  const request = JSON.parse(input);
  validateRequest(request, process.env);
  checkRuntime(process.cwd());
  if (fs.existsSync('.env')) throw new Error('Remote migration refuses a checkout with an .env file.');
  const context = { root: process.cwd(), id: request.worktreeId, ports: {}, jwtSecret: 'local-migration-only' };
  const env = childEnvironment(context, { sha: request.sha });
  env.DATABASE_URL = request.databaseUrl;
  const child = spawn(process.execPath, ['node_modules/knex/bin/cli.js', 'migrate:latest', '--knexfile', 'server/knexfile.js'],
    { cwd: context.root, env, stdio: 'ignore' });
  // Knex diagnostics may contain SQL/bindings. Only the exit status crosses SSH.
  child.on('error', () => { console.error('Remote Knex could not start.'); process.exitCode = 1; });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
    console.log(code === 0 ? JSON.stringify({ remoteMigration: 'complete', nonce: request.nonce }) :
      'Remote migration failed. The private database may have pending migrations; inspect it before retrying.');
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => child.kill(signal));
}

if (require.main === module) main().catch(() => { console.error('Remote migration preflight failed; Knex was not started.'); process.exitCode = 1; });
module.exports = { validateRequest };
