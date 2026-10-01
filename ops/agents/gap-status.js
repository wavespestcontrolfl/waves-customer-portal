#!/usr/bin/env node
// MUTATES (dry-run default) — set one Intelligence Bar gap report's status
// (new | building | fixed | by_design | dismissed). A session runs it when the
// owner says "build gap #12" (building), when that PR merges (fixed), or when
// the owner rules a gap by design or not worth building (by_design /
// dismissed). Closed statuses (fixed, by_design, dismissed) leave the gap out
// of list_gap_reports' default view; the recorder reopens a fixed gap to new
// (and rings the admin bell again) on its own if it happens again. Writes go through
// the service's one writer (server/services/agent-gap-reports.js setGapStatus).
//
//   railway run --service Postgres node ops/agents/gap-status.js --gap=12 --status=building            # dry run
//   railway run --service Postgres node ops/agents/gap-status.js --gap=12 --status=building --execute
//
// Run from the repo root. Output is the gap's number, kind, status and counts;
// its summary is already scrubbed of names and contact details, and is not
// printed here.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/gap-status.js …');
  process.exit(2);
}
// The app's knex reads DATABASE_URL; railway run injects the internal host,
// which is unreachable from a laptop — point it at the public URL.
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
// The public proxy needs TLS, and knex only turns ssl on when
// NODE_ENV=production — enable it unless the URL or PGSSLMODE already sets a
// mode (same as inventory-agent-undo.js).
if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { GAP_STATUSES, setGapStatus } = require(path.join(__dirname, '..', '..', 'server', 'services', 'agent-gap-reports'));

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const EXECUTE = process.argv.includes('--execute');
const gapId = Number.parseInt(arg('gap'), 10);
const status = arg('status');

if (!Number.isSafeInteger(gapId) || gapId < 1) {
  console.error('--gap=<gap number> is required');
  process.exit(2);
}
if (!GAP_STATUSES.includes(status)) {
  console.error(`--status must be one of: ${GAP_STATUSES.join(', ')}`);
  process.exit(2);
}

(async () => {
  const gap = await db('agent_gap_reports').where('id', gapId).first('id', 'kind', 'status', 'occurrences', 'last_seen_at');
  if (!gap) {
    console.error(`No gap #${gapId}`);
    process.exitCode = 1;
    return;
  }
  console.log(`gap #${gap.id} (${gap.kind}): status ${gap.status}, seen ${gap.occurrences}x, last ${new Date(gap.last_seen_at).toISOString()}`);
  if (gap.status === status) {
    console.log(`Already ${status}; nothing to change.`);
    return;
  }
  if (!EXECUTE) {
    console.log(`DRY RUN — would set gap #${gap.id} from ${gap.status} to ${status}. Re-run with --execute to apply.`);
    return;
  }
  const updated = await setGapStatus(gap.id, status);
  console.log(`Set gap #${updated.id} to ${updated.status}.`);
})()
  .catch((err) => {
    console.error(`gap-status failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
