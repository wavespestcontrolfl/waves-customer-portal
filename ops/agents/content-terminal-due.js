#!/usr/bin/env node
// READ-ONLY — the website posts that are due for the terminal writer
// (GATE_CONTENT_WRITER_TERMINAL; server/services/content/terminal-writer.js).
// Prints one JSON object: `due` (each with the branch its PR must use),
// `inProgress` (an open PR exists), `merged` (the next 9:00 AM run marks them
// done) and the caps. Writes nothing: it never claims or completes a queue row.
// Works with the gate on or off.
//
//   railway run --service waves-customer-portal -- railway run --service Postgres -- node ops/agents/content-terminal-due.js
//
// The nested run supplies GITHUB_TOKEN (portal) and DATABASE_PUBLIC_URL
// (Postgres). Queue rows hold search queries and page URLs, no customer data.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/content-terminal-due.js');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { terminalWriterWork } = require(path.join(__dirname, '..', '..', 'server', 'services', 'content', 'terminal-writer'));

const FIELDS = ['id', 'branch', 'pr_url', 'action_type', 'bucket', 'query', 'page_url', 'service', 'city', 'score', 'signal_metadata'];
const slim = (rows) => rows.map((r) => Object.fromEntries(FIELDS.filter((f) => r[f] != null).map((f) => [f, r[f]])));

(async () => {
  try {
    const { due, inProgress, merged, caps } = await terminalWriterWork({ complete: false });
    console.log(JSON.stringify({ due: slim(due), inProgress: slim(inProgress), merged: slim(merged), caps }, null, 2));
  } catch (err) {
    console.error(`content-terminal-due failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
