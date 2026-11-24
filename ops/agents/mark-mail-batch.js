// MUTATES with --execute (dry-run default: read only)
//
// Record which new-home postcard homes were mailed (mail_prospects.mailed_at / mail_batch / mailed_price; mailer step 3)
// and write the data for the price labels.
//
// - Eligible homes: list new_home, status eligible (a held-back home gets no card), price settled as priced, not yet
//   mailed. --ids a,b,c limits the run to those prospect ids.
// - Dry run: prints how many homes would be marked and each one's id and monthly price. Nothing is written.
// - --execute --batch <name>: marks them in ONE transaction: mailed_at = now, the batch name, and a frozen snapshot of the
//   price the label prints. A batch name is used once: a second run with the same name marks nothing (homes priced later
//   go in a new batch, so a label export of a batch is always the run that was printed), a mailed home is never touched
//   again, and the table refuses any later change to its price. The price hold on the label (60 days) counts from this day.
// - --labels <out.json> (read only unless --execute is also given): writes, for the homes of --batch (or, with no --batch,
//   the homes a dry run would mark), [{ name, price, perApplication, slug, token, textNumber, setupFee }] for the label print tool:
//   name = the buyers as the label shows them, price = the monthly price (whole dollars bare), perApplication = the price
//   of one application (annual / 4, from whole cents; 4 a year), textNumber = the office line of the home's city or ZIP,
//   setupFee = the one-time fee or null. No hold date until booking honors the printed price. The file holds buyer names and page tokens: it is written 0600; keep it out of the repo.
//   Labels come ONLY from a named batch that is already marked (--labels needs --batch): print what was marked, so a home
//   priced between a preview and the mark can never be marked mailed without a card, and the hold date matches the label.
// - No customer comms, no paid calls.
//
// Run from the repo root:
//   railway run --service waves-customer-portal -- env -u RAILWAY_TOKEN railway run --service Postgres -- \
//     sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" exec node ops/agents/mark-mail-batch.js "$@"' _ [--execute --batch <name>] [--ids a,b,c] [--labels <out.json>]
// (the outer run gives the app's env; the inner one the database's public URL, passed in as DATABASE_URL so the Mac can reach it)

const fs = require('fs');
const path = require('path');

const server = (p) => path.join(__dirname, '..', '..', 'server', p);
const args = process.argv.slice(2);
const usage = (message) => Object.assign(new Error(message), { code: 'USAGE' });
const VALUE_FLAGS = ['--batch', '--ids', '--labels'];
const BARE_FLAGS = ['--execute'];

// Every argument must be a known flag or the value of one: "--ids=<uuid>" or a misspelled "--id" must never be ignored, or the
// run would go on without the filter and mark every eligible home.
function checkArgs() {
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    if (seen.has(args[i])) throw usage(`${args[i]} is given twice`); // the second would be ignored
    seen.add(args[i]);
    if (VALUE_FLAGS.includes(args[i])) i += 1; // its value; value() checks it is there
    else if (!BARE_FLAGS.includes(args[i])) throw usage(`unknown argument "${args[i].split('=')[0]}": flags are --execute, --batch <name>, --ids <a,b,c>, --labels <file>`);
  }
}
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw usage(`${name} needs a value`);
  return v;
};

// The label file holds buyer names and page tokens: it must never land inside any git checkout or worktree, where it
// could be committed. The real path of its folder (symlinks followed) is checked: neither it nor any parent may hold .git.
function checkLabelsPath(labelsPath) {
  const outside = 'must point outside any git checkout (it holds buyer names and page tokens), e.g. ~/mail-labels/batch.json';
  const name = path.basename(labelsPath);
  if (!name || name === '.' || name === '..') throw usage('--labels must name a file');
  let dir;
  // The folder as given, with every symlink and ".." resolved by the file system (not by string), so the checked folder
  // is the one written to.
  try { dir = fs.realpathSync(path.dirname(labelsPath)); } catch { throw usage(`--labels folder does not exist: create it first; it ${outside}`); }
  const repo = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  for (let d = dir; ; d = path.dirname(d)) {
    if (d === repo || fs.existsSync(path.join(d, '.git'))) throw usage(`--labels ${outside}`);
    if (path.dirname(d) === d) break;
  }
  return path.join(dir, name);
}

function parseArgs() {
  checkArgs();
  const execute = flag('--execute');
  const batch = value('--batch');
  // A flag that is present must carry a real value: an empty one (a shell variable that expanded to nothing) must never read
  // as "no filter" and widen the run to every eligible home.
  const idsText = value('--ids');
  const ids = idsText === undefined ? undefined : idsText.split(',').map((s) => s.trim()).filter(Boolean);
  const labelsArg = value('--labels');
  if (ids && !ids.length) throw usage('--ids is empty: give prospect ids, or leave the flag out');
  if (labelsArg !== undefined && !labelsArg.trim()) throw usage('--labels is empty: give an output file');
  if (batch !== undefined && !batch.trim()) throw usage('--batch is empty: give a batch name');
  if (execute && !batch) throw usage('--execute needs --batch <name>');
  if (labelsArg !== undefined && !batch) throw usage('--labels needs --batch <name>: labels are printed from a marked batch only');
  // The checked, canonical destination is the one written: the temp file and the rename both use it.
  const labelsPath = labelsArg === undefined ? undefined : checkLabelsPath(labelsArg);
  return { execute, batch, ids, labelsPath };
}

function checkDatabaseUrl() {
  // The script uses DATABASE_URL exactly as given and never swaps in another variable: the command in the header passes
  // the public URL explicitly. It must be a real PostgreSQL URL with a host and a database; a private Railway host (not
  // reachable from the Mac) is refused with the command to use.
  let target;
  try { target = new URL(String(process.env.DATABASE_URL || '').trim()); } catch { target = null; }
  if (!target || !['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || target.pathname.length < 2) {
    throw Object.assign(new Error('DATABASE_URL must name one PostgreSQL database: run the command in the header'), { code: 'DB_URL' });
  }
  if (/\.railway\.internal$/.test(target.hostname)) {
    throw Object.assign(new Error('DATABASE_URL is the private Railway host: run the command in the header, which passes the public URL'), { code: 'DB_URL' });
  }
}

async function main() {
  const { execute, batch, ids, labelsPath } = parseArgs();

  // From the Mac the private database host does not resolve: use the public URL the Postgres service provides, and
  // stop with a clear message when only the private one is set.
  checkDatabaseUrl();
  const db = require(server('models/db'));
  const { wouldMark, markBatch, labelsFor } = require(server('services/mail/mailed-record'));
  try {
    if (execute) {
      const result = await markBatch({ batch, ids });
      if (result.batchExists) console.log(`Batch "${batch}" already exists: nothing marked. A batch name is used once; pick a new name for new homes.`);
      else console.log(`Marked ${result.marked.length} home(s) as mailed in batch "${batch}".`);
      if (result.notMailable.length) console.log(`  ${result.notMailable.length} id(s) not marked (not eligible, not priced, or already mailed)`);
    } else if (!labelsPath) {
      // The same answer --execute would give: a used batch name marks nothing.
      if (batch && await db('mail_prospects').where({ mail_batch: batch }).first('id')) {
        console.log(`Batch "${batch}" already exists: --execute would mark nothing. A batch name is used once; pick a new name for new homes.`);
        return;
      }
      const { homes, notMailable } = await wouldMark({ ids });
      console.log(`Homes ready to mark as mailed: ${homes.length}`);
      for (const h of homes.slice(0, 200)) console.log(`  would mark prospect ${h.id}: $${h.monthly} a month (annual ${h.annual}, setup ${h.setupFee})`);
      if (homes.length > 200) console.log(`  ... and ${homes.length - 200} more`);
      if (notMailable.length) console.log(`  ${notMailable.length} of the given ids are not ready (not eligible, not priced, or already mailed)`);
      console.log('Dry run: nothing written. Pass --execute --batch <name> to mark.');
    }
    if (labelsPath) {
      const { labels, nameCheck, officeByDefault } = await labelsFor({ batch, ids });
      // A mistyped batch or an id filter that matches nothing must never replace a print file with an empty list.
      if (!labels.length) {
        throw usage(`no marked homes in batch "${batch}"${ids ? ' for those ids' : ''}: nothing written (run --execute --batch <name> first)`);
      }
      // A new 0600 file renamed into place: an existing file keeps its old permissions when it is written over, and this one
      // holds buyer names and page tokens.
      const tmp = `${labelsPath}.${process.pid}.tmp`;
      let created = false;
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        created = true;
        try { fs.writeFileSync(fd, `${JSON.stringify(labels, null, 2)}\n`); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, labelsPath);
        created = false; // renamed into place: nothing left to clean up
      } finally {
        // A failed write or rename must not leave buyer names and page tokens in a stray temp file.
        if (created) fs.rmSync(tmp, { force: true });
      }
      console.log(`Wrote ${labels.length} label row(s) for batch "${batch}".`);
      if (nameCheck.length) console.log(`  Look at the name of ${nameCheck.length} home(s) before printing: ${nameCheck.join(', ')}`);
      if (officeByDefault.length) console.log(`  No city or ZIP named an office for ${officeByDefault.length} home(s) (Lakewood Ranch line used): ${officeByDefault.join(', ')}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  const shown = err.code === 'USAGE' || err.code === 'DB_URL' || err.name === 'TypeError';
  console.error(`mark-mail-batch failed: ${err.code || err.name || 'error'}${shown ? ` (${err.message})` : ''}`);
  process.exitCode = 1;
});
