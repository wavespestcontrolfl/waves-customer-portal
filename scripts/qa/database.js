#!/usr/bin/env node
'use strict';
// MUTATES: explicitly creates a private QA database in the selected dev cluster.
// No Railway service is created. Verify the selected cluster is dev/preview
// before configuring database.env; its label cannot prove remote identity.
const fs = require('node:fs');
const path = require('node:path');
const { readContext, childEnvironment } = require('../dev/context');

(async () => {
  const context = readContext();
  const env = childEnvironment(context, { database: true });
  const name = `waves_qa_${context.id.replaceAll('-', '')}`;
  const url = new URL(env.DATABASE_URL);
  if (url.pathname === `/${name}`) { console.log('This worktree already selects its private QA database.'); return; }
  const db = require('knex')({ client: 'pg', connection: env.DATABASE_URL, pool: { min: 0, max: 1 } });
  const file = path.join(context.root, '.tmp/dev/database.env');
  const backup = path.join(context.root, '.tmp/dev/cluster.env');
  try {
    if (fs.existsSync(backup)) throw new Error('cluster.env already exists; verify the selected cluster before provisioning again.');
    const exists = await db('pg_database').where({ datname: name }).first('datname');
    if (exists) throw new Error('QA database already exists but is not selected; verify ownership before reusing it.');
    await db.raw('CREATE DATABASE ?? TEMPLATE template0', [name]);
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    url.pathname = `/${name}`;
    fs.writeFileSync(file, `WAVES_DATABASE_ENVIRONMENT=test\nDATABASE_URL=${url.href}\n`, { mode: 0o600 });
    console.log(`Created ${name}; run npm run dev:migrate explicitly. The deployed preview uses its original database.`);
  } finally { await db.destroy(); }
})().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
