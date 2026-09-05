#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readContext, availablePort, childEnvironment, identity } = require('./context');
const { checkRuntime } = require('./runtime');

async function doctor(context, { frontend = false, ports = true, remote = false } = {}) {
  if (frontend && remote) throw new Error('Use --frontend or --remote, not both.');
  const nodeVersion = checkRuntime(context.root);
  for (const dependency of ['vite', 'playwright', 'knex', '@waves/report-redaction']) {
    try { require.resolve(dependency, { paths: [context.root] }); }
    catch { throw new Error('Missing development dependencies. Run npm ci in this worktree, then retry dev:doctor.'); }
  }
  if (ports) {
    for (const port of Object.values(context.ports)) {
      if (!await availablePort(port)) throw new Error(`Port ${port} is occupied. Run worktree:status; stop only the owning checkout.`);
    }
  }
  const env = childEnvironment(context, { database: !frontend });
  if (remote) {
    const { prepareRemoteMigration } = require('./remote-migrate');
    const { args, nodePath, target } = prepareRemoteMigration(context, env);
    // Print only the scoped command, never the database URL returned by preflight.
    const runtimeCommand = ['railway', ...args, '--', 'env', '-u', 'NODE_OPTIONS', nodePath, '--version']
      .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
    return { ...identity(context), nodeVersion, remote: {
      configuration: 'verified', environment: target.environmentName, deploymentId: target.deploymentId,
      database: 'worktree name and service endpoint verified; connectivity and migrations not checked',
      sshAndRuntime: 'not checked',
      nextSteps: ['railway ssh keys list',
        `Run ${runtimeCommand}; confirm Node ${fs.readFileSync(path.join(context.root, '.nvmrc'), 'utf8').trim()} (minimum 20.9). If needed, select an installed matching binary with nodePath in .tmp/dev/remote.json.`,
        'npm run dev:migrate -- --remote', 'npm run dev:doctor'],
    } };
  }
  let migrations = 'not checked (frontend only)';
  if (!frontend) {
    const db = require('knex')({ client: 'pg', connection: env.DATABASE_URL,
      pool: { min: 0, max: 1 }, acquireConnectionTimeout: 5000 });
    try {
      const applied = await db('knex_migrations').select('name').timeout(5000, { cancel: true });
      const names = new Set(applied.map((row) => row.name));
      const pending = fs.readdirSync(path.join(context.root, 'server/models/migrations'))
        .filter((name) => name.endsWith('.js') && !names.has(name));
      if (pending.length) throw new Error(`${pending.length} pending migrations. Run npm run dev:migrate explicitly, or npm run dev:doctor -- --remote to check the faster remote setup.`);
      migrations = 'current';
    } catch (error) {
      if (error.message.includes('pending migrations')) throw error;
      throw new Error('Dev database readiness failed. Check connectivity and run dev:migrate on the dedicated dev database.');
    } finally { await db.destroy(); }
  }
  return { ...identity(context), nodeVersion, migrations, integrationCredentials: 'excluded', backgroundJobs: 'disabled' };
}

if (require.main === module) {
  Promise.resolve().then(() => {
    const options = process.argv.slice(2);
    if (options.some((option) => !['--frontend', '--remote'].includes(option))) throw new Error('Usage: npm run dev:doctor -- [--frontend | --remote]');
    return doctor(readContext(), { frontend: options.includes('--frontend'), remote: options.includes('--remote') });
  })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { doctor };
