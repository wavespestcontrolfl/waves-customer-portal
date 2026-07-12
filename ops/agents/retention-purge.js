// MUTATES (dry-run default): dismisses every pending_approval retention
// outreach draft (status -> rejected). No deletes. Reversible: written rows
// are tagged in approved_by, so they can be flipped back with
//   UPDATE retention_outreach SET status='pending_approval'
//   WHERE approved_by='<tag>';
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/retention-purge.js            # dry run
//   railway run --service Postgres node ops/agents/retention-purge.js --execute
//   ... --execute --tag audit-purge-2026-07-11                                   # explicit tag

// Fail closed: without this, pg falls back to libpq env defaults and the
// UPDATE could land in whatever local/dev database is reachable.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/retention-purge.js');
  process.exit(1);
}
const { Client } = require('pg');

const execute = process.argv.includes('--execute');
const tagIdx = process.argv.indexOf('--tag');
const tag = tagIdx > -1 && process.argv[tagIdx + 1]
  ? process.argv[tagIdx + 1]
  : `audit-purge-${new Date().toISOString().slice(0, 10)}`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const before = await c.query(`SELECT count(*)::int AS n FROM retention_outreach WHERE status='pending_approval'`);
  console.log(`pending_approval drafts: ${before.rows[0].n}`);

  if (!execute) {
    const byAge = await c.query(`SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS n
                                 FROM retention_outreach WHERE status='pending_approval'
                                 GROUP BY 1 ORDER BY 1`);
    byAge.rows.forEach(r => console.log(`  ${r.day.toISOString().slice(0, 10)}: ${r.n}`));
    console.log(`DRY RUN — would set status='rejected', approved_by='${tag}'. Re-run with --execute.`);
  } else {
    const r = await c.query(
      `UPDATE retention_outreach SET status='rejected', approved_by=$1, updated_at=now() WHERE status='pending_approval'`,
      [tag]
    );
    console.log(`updated: ${r.rowCount} (tag ${tag})`);
    const after = await c.query(`SELECT status, count(*)::int AS n FROM retention_outreach GROUP BY status ORDER BY status`);
    after.rows.forEach(row => console.log(`  ${row.status}: ${row.n}`));
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
