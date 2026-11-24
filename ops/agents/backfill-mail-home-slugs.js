// MUTATES (dry-run default; pass --execute to write)
//
// Give the live new-home postcard homes saved before short addresses existed their slug
// (mail_prospects.page_slug, e.g. "101-example"; mailer step 2d-2). New homes get theirs in the save
// (prospect-store saveProspect); this is the one-time catch-up after the page_slug migration deploys.
//
// - Scope: list_key 'new_home', status eligible / held_back, page_slug NULL. Oldest first, so the older of two
//   homes on the same street keeps the plain slug.
// - A slug is never changed once set. A home whose address gives none, or whose plain and ZIP forms are both
//   taken, stays NULL (its card prints the QR code only).
// - Dry run: prints how many homes have no slug and the prospect ids it would assign (never a slug or address). --execute writes through
//   prospect-store backfillPageSlugs (the same assignment as the save), batch by batch.
// - No customer comms, no paid calls.
//
// Run from the repo root:
//   railway run --service waves-customer-portal -- env -u RAILWAY_TOKEN railway run --service Postgres -- \
//     node ops/agents/backfill-mail-home-slugs.js [--execute]
// (the outer run gives the app's env; the inner one the database's public URL, so the Mac can reach it)

const path = require('path');

const EXECUTE = process.argv.includes('--execute');
const server = (p) => path.join(__dirname, '..', '..', 'server', p);

async function main() {
  const db = require(server('models/db'));
  const { slugCandidates } = require(server('services/mail/home-slug'));
  const { backfillPageSlugs } = require(server('services/mail/prospect-store'));
  try {
    const rows = await db('mail_prospects')
      .where({ list_key: 'new_home' })
      .whereIn('status', ['eligible', 'held_back'])
      .whereNull('page_slug')
      .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
      .select('id', 'address_line1', 'zip');
    const withCandidate = rows.filter((r) => slugCandidates({ addressLine1: r.address_line1, zip: r.zip }).length);
    console.log(`Homes with no slug: ${rows.length} (${withCandidate.length} have an address that gives one)`);
    // Prospect ids and counts only: a slug is the house number, street and ZIP, so it is never printed.
    const withZipForm = withCandidate.filter((r) => slugCandidates({ addressLine1: r.address_line1, zip: r.zip }).length > 1).length;
    console.log(`  ${withZipForm} of them have a ZIP form to fall back on`);
    for (const r of withCandidate.slice(0, 20)) console.log(`  would assign prospect ${r.id}`);
    if (!EXECUTE) { console.log('Dry run: nothing written. Pass --execute to assign.'); return; }
    const total = { tried: 0, assigned: 0, withoutSlug: 0 };
    let after = null;
    do {
      const batch = await backfillPageSlugs({ limit: 200, after });
      total.tried += batch.tried; total.assigned += batch.assigned; total.withoutSlug += batch.withoutSlug;
      after = batch.next;
    } while (after);
    console.log(`Assigned ${total.assigned} of ${total.tried}; ${total.withoutSlug} left without a slug.`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => { console.error(`backfill-mail-home-slugs failed: ${err.code || err.name || 'error'}`); process.exitCode = 1; });
