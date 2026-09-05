#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readContext, availablePort, childEnvironment, identity } = require('./context');

async function doctor(context, { frontend = false, ports = true } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 9)) throw new Error('Node 20.9 or newer is required.');
  for (const dependency of ['vite', 'playwright', 'knex', '@waves/report-redaction']) {
    require.resolve(dependency, { paths: [context.root] });
  }
  if (ports) {
    for (const port of Object.values(context.ports)) {
      if (!await availablePort(port)) throw new Error(`Port ${port} is occupied. Run worktree:status; stop only the owning checkout.`);
    }
  }
  const env = childEnvironment(context, { database: !frontend });
  let migrations = 'not checked (frontend only)';
  if (!frontend) {
    const db = require('knex')({ client: 'pg', connection: env.DATABASE_URL,
      pool: { min: 0, max: 1 }, acquireConnectionTimeout: 5000 });
    try {
      const applied = await db('knex_migrations').select('name').timeout(5000, { cancel: true });
      const names = new Set(applied.map((row) => row.name));
      const pending = fs.readdirSync(path.join(context.root, 'server/models/migrations'))
        .filter((name) => name.endsWith('.js') && !names.has(name));
      if (pending.length) throw new Error(`${pending.length} pending migrations. Run npm run dev:migrate explicitly.`);
      migrations = 'current';
    } catch (error) {
      if (error.message.includes('pending migrations')) throw error;
      throw new Error('Dev database readiness failed. Check connectivity and run dev:migrate on the dedicated dev database.');
    } finally { await db.destroy(); }
  }
  return { ...identity(context), migrations, integrationCredentials: 'excluded', backgroundJobs: 'disabled' };
}

if (require.main === module) {
  Promise.resolve().then(() => doctor(readContext(), { frontend: process.argv.includes('--frontend') }))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { doctor };
