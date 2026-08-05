// MUTATES (dry-run default): runs the email bounce→transcript rescue
// (server/services/email-bounce-rescue.js) over every ACTIVE bounce
// suppression, or applies one previously-suggested rescue by ledger id.
//
// Dry run prints, per address: the owner, the winning evidence tier, the
// candidate, and what --execute WOULD do (auto-apply vs suggest vs nothing).
// --execute writes exactly that: tier-A/B fixes auto-apply (customers +
// leads email, audit interaction, admin bell); decode-tier candidates
// become 'suggested' ledger rows + an ACT: email each.
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/bounce-rescue-backfill.js                 # dry run
//   railway run --service Postgres node ops/agents/bounce-rescue-backfill.js --execute
//   railway run --service Postgres node ops/agents/bounce-rescue-backfill.js --apply=<rescue-id> --execute
//
// NOTE on email side effects: suggestion emails send via the portal email
// service, whose SMTP credentials are NOT in the Postgres service env — in
// this local-ops context those sends fail soft and the same content prints
// to stdout, which the operator running this script is already reading.

// Fail closed: without this, pg falls back to libpq env defaults and writes
// could land in whatever local/dev database is reachable.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/bounce-rescue-backfill.js');
  process.exit(1);
}
// The injected DATABASE_URL points at postgres.railway.internal (unreachable
// from a local machine); route knex at the public proxy BEFORE any require
// touches the knexfile.
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.PGSSLMODE = process.env.PGSSLMODE || 'no-verify';

const path = require('path');
const db = require(path.join(__dirname, '../../server/models/db'));
const rescue = require(path.join(__dirname, '../../server/services/email-bounce-rescue'));

const execute = process.argv.includes('--execute');
const applyArg = process.argv.find((a) => a.startsWith('--apply='));

(async () => {
  if (applyArg) {
    const rescueId = applyArg.split('=')[1];
    // Dry run loads and revalidates the ledger row and prints the EXACT
    // change --execute would make (owner, field, bounced -> candidate,
    // current validation verdict) — never trust a pasted id blind.
    const preview = await rescue.previewSuggestedRescue(rescueId);
    console.log(`${execute ? 'EXECUTE' : 'DRY RUN'} preview: ${JSON.stringify(preview, null, 1)}`);
    if (preview.error || !execute) {
      if (!execute && !preview.error) console.log('\nDry run — nothing written. Re-run with --execute to apply the change above.');
      await db.destroy();
      process.exit(preview.error ? 1 : 0);
    }
    const result = await rescue.applySuggestedRescue(rescueId, { appliedBy: 'operator-backfill' });
    console.log(JSON.stringify(result));
    await db.destroy();
    process.exit(result.error ? 1 : 0);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('NOTE: ANTHROPIC_API_KEY not in this env — the LLM decode tier is disabled for this run; deterministic tiers still apply.\n');
  }
  const sups = await db('email_suppressions')
    .where({ status: 'active', suppression_type: 'bounce' })
    .orderBy('suppressed_at', 'desc')
    .select('email', 'suppressed_at');
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'}: ${sups.length} active bounce suppression(s)\n`);

  const tally = {};
  for (const s of sups) {
    const result = await rescue.rescueBouncedAddress(s.email, {
      dryRun: !execute,
      appliedBy: 'backfill',
    });
    const label = result.status || result.skipped || 'unknown';
    tally[label] = (tally[label] || 0) + 1;
    const detail = result.candidate
      ? ` -> ${result.candidate} [${result.tier}]${result.reason ? ` (${result.reason})` : ''}`
      : result.skipped ? ` (${result.skipped})` : '';
    console.log(`${s.email}: ${label}${detail}`);
  }
  console.log(`\nSummary: ${JSON.stringify(tally)}`);
  if (!execute) console.log('Dry run — nothing was written or sent. Re-run with --execute to act.');
  await db.destroy();
})().catch(async (e) => {
  console.error('backfill failed:', e.message);
  try { await db.destroy(); } catch { /* already closed */ }
  process.exit(1);
});
