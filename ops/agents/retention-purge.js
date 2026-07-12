// MUTATES (dry-run default): dismisses every pending_approval retention
// outreach draft (status -> rejected). No deletes. Reversible: written rows
// are tagged in approved_by with a per-run ET timestamp tag, so ONE batch
// can be flipped back with
//   UPDATE retention_outreach SET status='pending_approval', approved_by=NULL
//   WHERE approved_by='<tag printed by the run>';
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/retention-purge.js            # dry run
//   railway run --service Postgres node ops/agents/retention-purge.js --execute
//   ... --execute --tag audit-purge-2026-07-11-adhoc                             # pin a tag

// Fail closed: without this, pg falls back to libpq env defaults and the
// UPDATE could land in whatever local/dev database is reachable.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/retention-purge.js');
  process.exit(1);
}
const { Client } = require('pg');

const execute = process.argv.includes('--execute');
const tagIdx = process.argv.indexOf('--tag');
// ET wall-clock plus a random suffix: unique per run (a date-only or UTC
// tag would be shared across same-day runs and one day ahead on ET
// evenings; the suffix covers concurrent starts and the DST fold hour) so
// the tag-based rollback isolates exactly one batch.
const etStamp = new Date()
  .toLocaleString('sv-SE', { timeZone: 'America/New_York' })
  .replace(' ', 'T')
  .replace(/:/g, '');
const suffix = require('crypto').randomBytes(3).toString('hex');
const tag = tagIdx > -1 && process.argv[tagIdx + 1]
  ? process.argv[tagIdx + 1]
  : `audit-purge-${etStamp}-${suffix}`;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const before = await c.query(`SELECT count(*)::int AS n FROM retention_outreach WHERE status='pending_approval'`);
  console.log(`pending_approval drafts: ${before.rows[0].n}`);

  if (!execute) {
    // Print exactly the rows that would change (ids only — no PII).
    const rows = await c.query(`SELECT id, created_at::date AS day FROM retention_outreach
                                WHERE status='pending_approval' ORDER BY created_at, id`);
    rows.rows.forEach(r => console.log(`  id=${r.id} created=${r.day.toISOString().slice(0, 10)}  pending_approval -> rejected`));
    console.log(`DRY RUN — ${rows.rows.length} rows above would get status='rejected' and a per-run tag like '${tag}'. Re-run with --execute (the execute run prints ITS tag — that tag is the rollback key).`);
  } else {
    // An explicit --tag must not collide with a prior batch or the printed
    // rollback would restore more than this run.
    const reused = await c.query(`SELECT 1 FROM retention_outreach WHERE approved_by=$1 LIMIT 1`, [tag]);
    if (reused.rows.length) {
      console.error(`FATAL tag '${tag}' is already used by an earlier batch — pick a fresh --tag.`);
      process.exit(1);
    }
    const r = await c.query(
      `UPDATE retention_outreach SET status='rejected', approved_by=$1, updated_at=now() WHERE status='pending_approval'`,
      [tag]
    );
    console.log(`updated: ${r.rowCount}`);
    console.log(`batch tag: ${tag}`);
    console.log(`rollback:  UPDATE retention_outreach SET status='pending_approval', approved_by=NULL WHERE approved_by='${tag}';`);
    const after = await c.query(`SELECT status, count(*)::int AS n FROM retention_outreach GROUP BY status ORDER BY status`);
    after.rows.forEach(row => console.log(`  ${row.status}: ${row.n}`));
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
