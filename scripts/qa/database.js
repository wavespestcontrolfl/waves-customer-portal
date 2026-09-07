#!/usr/bin/env node
'use strict';
// MUTATES: explicitly creates a private QA database in the selected dev cluster.
// No Railway service is created. Verify the selected cluster is dev/preview
// before configuring database.env; its label cannot prove remote identity.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
  const selection = `${file}.${randomUUID()}.tmp`;
  let created = false;
  let backupCreated = false;
  try {
    if (fs.existsSync(backup)) throw new Error('cluster.env already exists; verify the selected cluster before provisioning again.');
    const exists = await db('pg_database').where({ datname: name }).first('datname');
    if (exists) throw new Error('QA database already exists but is not selected; verify ownership before reusing it.');
    url.pathname = `/${name}`;
    fs.writeFileSync(selection, `WAVES_DATABASE_ENVIRONMENT=test\nDATABASE_URL=${url.href}\n`, { mode: 0o600, flag: 'wx' });
    await db.raw('CREATE DATABASE ?? TEMPLATE template0', [name]);
    created = true;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    backupCreated = true;
    fs.chmodSync(backup, 0o600);
    fs.renameSync(selection, file);
  } catch (error) {
    if (created) {
      // Only this invocation's newly created database is eligible. Do not
      // force-disconnect clients or drop a database rejected by the guard.
      try { await db.raw('DROP DATABASE ??', [name]); }
      catch { throw new Error('QA selection failed and database rollback failed; verify the private database and retained cluster backup before retrying.'); }
      if (backupCreated) fs.unlinkSync(backup);
    }
    throw error;
  } finally {
    try { fs.rmSync(selection, { force: true }); }
    finally { await db.destroy(); }
  }
  console.log(`Created ${name}; run npm run dev:migrate explicitly. The deployed preview uses its original database.`);
})().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
