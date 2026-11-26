// MUTATES (dry-run default; pass --execute to write)
//
// Make sure the reserved short_codes rows that COUNT printed review-QR scans exist (server/routes/review-geo-link.js).
// The route redirects whether or not a row exists; a missing row only means the scan is not counted.
//
// - One row per office: `review-<office id>` for every office in config/locations.js (the /rv card link).
// - One row per technician named with --tech: `review-tech-<slug>` (the /rv/<slug> badge link).
//   Repeat the flag for several: --tech adam --tech maria. A slug is lowercase, ^[a-z][a-z0-9-]{1,30}$.
// - Inserts ONLY missing rows (kind 'review', click_count 0). It never updates or deletes a row, so a row that
//   already holds clicks is untouched. The target_url column is informational: the route never reads it (the
//   redirect always comes from config/locations.js). Offices store their Google review URL; a tech row stores
//   the fallback office's Google review URL (never /rv/<slug>, so the /l/<code> alias cannot count a scan twice).
// - Prints codes and counts only. No customer data, no customer comms, no paid calls.
//
// Run from the repo root:
//   railway run --service waves-customer-portal -- env -u RAILWAY_TOKEN railway run --service Postgres -- \
//     node ops/agents/ensure-review-count-codes.js [--tech adam ...] [--execute]
// (the outer run gives the app's env; the inner one the database's public URL, so the Mac can reach it)

const path = require('path');

const server = (p) => path.join(__dirname, '..', '..', 'server', p);

// Pure: the rows this run wants, from the offices and the --tech values. Throws on a bad slug.
function planRows({ offices, techs, techSlugRe, fallbackOfficeId }) {
  const wanted = [];
  // A tech row points at a Google review form, never at /rv/<slug>: the public /l/<code> alias would otherwise
  // count a scan on /l, then redirect into /rv/<slug> and count the same tech again.
  const fallback = offices.find((o) => o.id === fallbackOfficeId) || offices[0];
  const fallbackReviewUrl = fallback.googleReviewUrl;
  for (const office of offices) {
    wanted.push({ code: `review-${office.id}`, target_url: office.googleReviewUrl });
  }
  const seen = new Set();
  for (const raw of techs) {
    const slug = String(raw).trim().toLowerCase();
    if (!techSlugRe.test(slug)) {
      throw Object.assign(new Error('a --tech value is not a valid slug (lowercase letters, digits, dashes; starts with a letter; 2 to 31 characters)'), { code: 'BAD_TECH' });
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    wanted.push({ code: `review-tech-${slug}`, target_url: fallbackReviewUrl });
  }
  return wanted;
}

// --tech <slug> and --tech=<slug>, repeatable, plus --execute. A flag with no value or any other argument is an error.
function parseTechArgs(argv) {
  const techs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tech') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw Object.assign(new Error('--tech needs a value'), { code: 'BAD_TECH' });
      techs.push(next);
      i += 1;
    } else if (arg.startsWith('--tech=')) {
      techs.push(arg.slice('--tech='.length));
    } else if (arg !== '--execute') {
      // A typo (--excute, --tech-adam) must stop the run, never provision a partial set.
      throw Object.assign(new Error('unknown argument: use only --tech <slug>, --tech=<slug> and --execute'), { code: 'BAD_TECH' });
    }
  }
  return techs;
}

async function main() {
  const argv = process.argv.slice(2);
  const techs = parseTechArgs(argv); // throws on any unknown argument before the database is touched
  const EXECUTE = argv.includes('--execute');

  // From the Mac the private database host does not resolve: use the public URL the Postgres service provides, and
  // stop with a clear message when only the private one is set. Set BEFORE any server module loads the database model.
  // An explicitly chosen non-private DATABASE_URL is kept; the public URL only replaces a missing or private one.
  const current = process.env.DATABASE_URL || '';
  if (process.env.DATABASE_PUBLIC_URL && (!current || /\.railway\.internal\b/.test(current))) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  }
  if (/\.railway\.internal\b/.test(process.env.DATABASE_URL || '')) {
    throw Object.assign(new Error('only the private database URL is set: run it with the nested Postgres command above'), { code: 'PRIVATE_DB_URL' });
  }

  const { WAVES_LOCATIONS } = require(server('config/locations'));
  const { TECH_SLUG_RE, REVIEW_GEO_FALLBACK_OFFICE_ID } = require(server('routes/review-geo-link'));
  const wanted = planRows({ offices: WAVES_LOCATIONS, techs, techSlugRe: TECH_SLUG_RE, fallbackOfficeId: REVIEW_GEO_FALLBACK_OFFICE_ID });

  const db = require(server('models/db'));
  try {
    const existing = await db('short_codes').whereIn('code', wanted.map((w) => w.code)).select('code', 'click_count');
    const have = new Map(existing.map((r) => [r.code, r.click_count]));
    const missing = wanted.filter((w) => !have.has(w.code));
    for (const w of wanted) {
      console.log(have.has(w.code) ? `  have    ${w.code} (${have.get(w.code)} clicks)` : `  missing ${w.code}`);
    }
    console.log(`Wanted ${wanted.length}: ${wanted.length - missing.length} exist, ${missing.length} missing.`);
    if (!EXECUTE) { console.log('Dry run: nothing written. Pass --execute to insert the missing rows.'); return; }
    let inserted = 0;
    for (const w of missing) {
      // onConflict ignore: a row made by a parallel run is left alone, and no row is ever updated.
      const rows = await db('short_codes')
        .insert({ code: w.code, target_url: w.target_url, kind: 'review' })
        .onConflict('code').ignore()
        .returning('code');
      if (rows.length) { inserted += 1; console.log(`  inserted ${w.code}`); }
    }
    console.log(`Inserted ${inserted} of ${missing.length} missing.`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const known = err.code === 'PRIVATE_DB_URL' || err.code === 'BAD_TECH';
    console.error(`ensure-review-count-codes failed: ${err.code || err.name || 'error'}${known ? ` (${err.message})` : ''}`);
    process.exitCode = 1;
  });
}

module.exports = { planRows, parseTechArgs };
