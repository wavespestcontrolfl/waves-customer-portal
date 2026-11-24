// MUTATES with --execute (dry-run default: read only)
//
// Record which new-home postcard homes were mailed (mail_prospects.mailed_at / mail_batch / mailed_price; mailer step 3)
// and write the data for the price labels.
//
// - Eligible homes: list new_home, status eligible (a held-back home gets no card), price settled as priced, not yet
//   mailed. --ids a,b,c limits the run to those prospect ids.
// - Dry run: prints how many homes would be marked and each one's id and monthly price. Nothing is written.
// - --execute --batch <name>: marks them in ONE transaction: mailed_at = now, the batch name, and a frozen snapshot of the
//   price the label prints. A second run marks nothing: a mailed home is never touched again, and the table refuses any
//   later change to its price. The price hold on the label (60 days) counts from this day.
// - --labels <out.json> (read only unless --execute is also given): writes, for the homes of --batch (or, with no --batch,
//   the homes a dry run would mark), [{ name, price, slug, token, textNumber, heldUntil }] for the label print tool:
//   name = the buyers as the label shows them, price = the monthly price (whole dollars bare), textNumber = the
//   office line of the home's city or ZIP, heldUntil = "Mon D". The file holds buyer names: keep it out of the repo.
// - No customer comms, no paid calls.
//
// Run from the repo root:
//   railway run --service waves-customer-portal -- env -u RAILWAY_TOKEN railway run --service Postgres -- \
//     node ops/agents/mark-mail-batch.js [--execute --batch <name>] [--ids a,b,c] [--labels <out.json>]
// (the outer run gives the app's env; the inner one the database's public URL, so the Mac can reach it)

const fs = require('fs');
const path = require('path');

const server = (p) => path.join(__dirname, '..', '..', 'server', p);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const usage = (message) => Object.assign(new Error(message), { code: 'USAGE' });
const value = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw usage(`${name} needs a value`);
  return v;
};

async function main() {
  const execute = flag('--execute');
  const batch = value('--batch');
  const idsText = value('--ids');
  const ids = idsText ? idsText.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const labelsPath = value('--labels');
  if (execute && !batch) throw usage('--execute needs --batch <name>');

  // From the Mac the private database host does not resolve: use the public URL the Postgres service provides, and
  // stop with a clear message when only the private one is set.
  if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (/\.railway\.internal\b/.test(process.env.DATABASE_URL || '')) {
    throw Object.assign(new Error('only the private database URL is set: run it with the nested Postgres command above'), { code: 'PRIVATE_DB_URL' });
  }
  const db = require(server('models/db'));
  const { wouldMark, markBatch, labelsFor } = require(server('services/mail/mailed-record'));
  try {
    if (execute) {
      const result = await markBatch({ batch, ids });
      console.log(`Marked ${result.marked.length} home(s) as mailed in batch "${batch}".`);
      if (result.notMailable.length) console.log(`  ${result.notMailable.length} id(s) not marked (not eligible, not priced, or already mailed)`);
    } else if (!labelsPath || !batch) {
      const { homes, notMailable } = await wouldMark({ ids });
      console.log(`Homes ready to mark as mailed: ${homes.length}`);
      for (const h of homes.slice(0, 200)) console.log(`  would mark prospect ${h.id}: $${h.monthly} a month (annual ${h.annual}, setup ${h.setupFee})`);
      if (homes.length > 200) console.log(`  ... and ${homes.length - 200} more`);
      if (notMailable.length) console.log(`  ${notMailable.length} of the given ids are not ready (not eligible, not priced, or already mailed)`);
      console.log('Dry run: nothing written. Pass --execute --batch <name> to mark.');
    }
    if (labelsPath) {
      const { labels, nameCheck, officeByDefault } = await labelsFor({ batch, ids });
      fs.writeFileSync(labelsPath, `${JSON.stringify(labels, null, 2)}\n`, { mode: 0o600 });
      console.log(`Wrote ${labels.length} label row(s) for ${batch ? `batch "${batch}"` : 'the homes a dry run would mark'}.`);
      if (nameCheck.length) console.log(`  Look at the name of ${nameCheck.length} home(s) before printing: ${nameCheck.join(', ')}`);
      if (officeByDefault.length) console.log(`  No city or ZIP named an office for ${officeByDefault.length} home(s) (Lakewood Ranch line used): ${officeByDefault.join(', ')}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  const shown = err.code === 'USAGE' || err.code === 'PRIVATE_DB_URL' || err.name === 'TypeError';
  console.error(`mark-mail-batch failed: ${err.code || err.name || 'error'}${shown ? ` (${err.message})` : ''}`);
  process.exitCode = 1;
});
