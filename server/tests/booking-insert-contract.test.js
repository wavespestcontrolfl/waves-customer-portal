/**
 * Booking insert-site contract — mechanical enforcement of "no new bare
 * scheduled_services inserts" (Tier 2 booking-consolidation track).
 *
 * Every production INSERT into scheduled_services must either go through
 * the booking contract (services/booking/create-scheduled-service.js) or
 * be one of the frozen legacy sites below. The inventory freezes each
 * site's FINGERPRINT — the normalized `('scheduled_services')…insert(<arg
 * head>` expression — as a per-file multiset, not a bare count: with
 * counts alone, converting one legacy insert while adding a different
 * bare insert in the same file would net to zero and slip a new parallel
 * booking writer past the guard (GH Codex #3702 P2). Entries may only be
 * REMOVED as writers adopt the contract; a diff that adds or edits a
 * fingerprint is a policy violation, not a fix for this test — an
 * intentional rework of a legacy insert adopts the contract instead. A
 * stale entry (site no longer present) also fails, so the map always
 * mirrors reality.
 *
 * Matcher shape: each `('scheduled_services')` table ref (the string may
 * sit on its own line inside the call) is followed through its COMPLETE
 * chained expression — balanced parentheses, string-safe, comments
 * skipped — so a chain of any length or line count that ends in
 * `.insert(` is caught; a bounded line window was evadable by padding the
 * chain (GH Codex #3702 r3 P1).
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(SERVER_ROOT, '..');

// Directories that never hold production insert sites. Migrations and
// seeds write historical/demo data by design; tests exercise mocks.
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'seeds', 'coverage', 'dist', 'fixtures']);

// The contract module itself — the ONLY file allowed to hold a bare
// insert. Exempting the whole services/booking directory would let a new
// sibling module become a parallel booking mechanism (GH Codex P2).
const CONTRACT_MODULE = 'server/services/booking/create-scheduled-service.js';

// Frozen 2026-09-01 inventory: 26 sites, 14 files, keyed by fingerprint
// multiset. Shrink-only.
const FROZEN_LEGACY_INSERT_SITES_2026_09 = {
  'server/routes/admin-schedule.js': [
    "scheduled_services').insert(insertData",   // POST / parent
    "scheduled_services').insert(childData",    // POST / recurring children
    "scheduled_services').insert(boosterData",  // POST / booster months
    "scheduled_services').insert(childData",    // update-details child spawn
    "scheduled_services').insert(data",         // series extension (visit-count top-up)
    "scheduled_services').insert(nextData",     // auto-extend on completion
    "scheduled_services').insert(data",         // recurring-alert extend
    "scheduled_services').insert(data",         // recurring-alert convert_ongoing
  ],
  'server/routes/booking.js': ["scheduled_services').insert({"],            // createSelfBooking
  'server/routes/admin-dispatch.js': ["scheduled_services').insert(insertData"], // completion-CTA follow-up
  'server/routes/admin-leads.js': ["scheduled_services').insert(insertData"],    // lead → appointment conversion
  'server/services/slot-reservation.js': ["scheduled_services').insert({"], // estimate slot hold (customer_id NULL by design)
  'server/services/health-alerts.js': ["scheduled_services').insert({"],    // complimentary visit action
  'server/services/availability.js': ["scheduled_services').insert({"],     // AI-assistant confirmBooking
  'server/services/recurring-appointment-seeder.js': [                      // seedFollowUpsForParent (locked/unlocked arms)
    "scheduled_services').insert(rows",
    "scheduled_services').insert(rows",
  ],
  'server/services/annual-prepay-renewals.js': [                            // timed + windowless coverage rows
    "scheduled_services').insert(buildInsert(scheduledDate, windowStart)",
    "scheduled_services').insert(buildInsert(scheduledDate, null)",
    "scheduled_services').insert(buildInsert(scheduledDate, null)",
  ],
  'server/services/intelligence-bar/tools.js': ["scheduled_services').insert({"], // create_appointment
  'server/services/estimate-converter.js': [                                // standalone companion + main unit
    "scheduled_services').insert(standaloneRow",
    "scheduled_services').insert(row",
  ],
  'server/services/voice-agent/relay-booking.js': ["scheduled_services').insert(insertRow"], // commitVoiceBooking
  'server/services/call-recording-processor.js': [                          // follow-up savepoint + idempotent booking
    "scheduled_services').insert({",
    "scheduled_services').insert(insertData",
  ],
  'scripts/import-ical-appointments.js': ["scheduled_services').insert(row"], // legacy import script
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Fingerprint = the normalized expression from the table ref through the
// insert argument's head token — stable under comment/whitespace churn
// around the site, distinct enough that a swapped-in different insert
// reads as a NEW fingerprint.
function fingerprintOf(scope) {
  const m = scope.match(/^[\s\S]*?\.insert\s*\(\s*(\{|[A-Za-z0-9_.$]+(\([^)]*\))?)?/);
  return (m ? m[0] : scope).replace(/\s+/g, ' ').trim();
}

// Advance past whitespace and // and /* */ comments.
function skipTrivia(source, i) {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    return i;
  }
}

// Consume one balanced (...) span starting at an opening paren, skipping
// string literals (a ')' inside a string can't end it early) AND comments
// (an apostrophe inside a comment — "the customer's rental" — must not
// open a phantom string that swallows the rest of the file).
function balancedParens(source, i) {
  let depth = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i += 1;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
    }
    i += 1;
  }
  return i;
}

// Collect scheduled_services insert-site fingerprints in one file by
// walking each table ref's ENTIRE chained expression.
function collectInsertSites(source) {
  const out = [];
  const re = /['"`]scheduled_services['"`]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    // The ref must be the argument of a call: the next non-trivia char
    // closes it (this also catches a table string on its own line).
    let i = skipTrivia(source, m.index + m[0].length);
    if (source[i] !== ')') continue;
    i += 1;
    let chain = "scheduled_services')";
    // Follow the chain: .method(<balanced args>) repeated, trivia between
    // links skipped (and excluded from the fingerprint).
    for (;;) {
      const j = skipTrivia(source, i);
      if (source[j] !== '.') break;
      const nm = /^[A-Za-z0-9_$]+/.exec(source.slice(j + 1));
      if (!nm) break;
      const parenStart = skipTrivia(source, j + 1 + nm[0].length);
      if (source[parenStart] !== '(') break;
      const end = balancedParens(source, parenStart);
      chain += `.${nm[0]}${source.slice(parenStart, end)}`;
      i = end;
    }
    if (/\.insert\s*\(/.test(chain)) out.push(fingerprintOf(chain));
  }
  return out;
}

function relRepo(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

// Multiset diff: entries in `a` not matched one-for-one in `b`.
function multisetMissing(a, b) {
  const pool = [...b];
  const missing = [];
  for (const item of a) {
    const idx = pool.indexOf(item);
    if (idx === -1) missing.push(item);
    else pool.splice(idx, 1);
  }
  return missing;
}

describe('booking insert-site contract', () => {
  const files = [...walk(SERVER_ROOT), ...walk(path.join(REPO_ROOT, 'scripts'))];
  const found = new Map(); // repo-relative path -> fingerprint multiset
  for (const file of files) {
    const rel = relRepo(file);
    if (rel === CONTRACT_MODULE) continue;
    const sites = collectInsertSites(fs.readFileSync(file, 'utf8'));
    if (sites.length > 0) found.set(rel, sites);
  }

  test('the matcher recognizes every insert shape it claims to (self-check)', () => {
    expect(collectInsertSites("await trx('scheduled_services').insert(insertData).returning('*');")).toEqual(["scheduled_services').insert(insertData"]);
    expect(collectInsertSites("const [r] = await sp('scheduled_services')\n  .insert({\n    customer_id: id,\n  })")).toEqual(["scheduled_services').insert({"]);
    expect(collectInsertSites("await trx('scheduled_services')\n  .insert(insertData)\n  .onConflict('idempotency_key')\n  .ignore()")).toEqual(["scheduled_services').insert(insertData"]);
    // A LONG chain (any number of links/lines before .insert) is caught —
    // the bounded 3-line window this replaces was evadable by padding.
    expect(collectInsertSites("await trx('scheduled_services')\n  .where({ a: 1 })\n  .whereNull('b')\n  // pad\n  .whereIn('c', [1, 2])\n  .orderBy('d')\n  .limit(1)\n  .insert(sneaky)")).toEqual(["scheduled_services').where({ a: 1 }).whereNull('b').whereIn('c', [1, 2]).orderBy('d').limit(1).insert(sneaky"]);
    // A table argument split across lines is still a ref.
    expect(collectInsertSites("await db(\n  'scheduled_services'\n).insert(x)")).toEqual(["scheduled_services').insert(x"]);
    // A read chained near the ref must NOT count…
    expect(collectInsertSites("await trx('scheduled_services').where({ id }).first();")).toEqual([]);
    // …nor an insert into a DIFFERENT table on the next line.
    expect(collectInsertSites("await trx('scheduled_services').where({ id }).update({ a: 1 });\nawait trx('lead_activities').insert({ b: 2 });")).toEqual([]);
  });

  test('no NEW or MODIFIED scheduled_services insert sites outside the booking contract', () => {
    const violations = [];
    for (const [rel, sites] of found) {
      const frozen = FROZEN_LEGACY_INSERT_SITES_2026_09[rel];
      if (frozen === undefined) {
        violations.push(`${rel}: ${sites.length} site(s) — new file. Route the insert through ${CONTRACT_MODULE}.`);
        continue;
      }
      const extra = multisetMissing(sites, frozen);
      if (extra.length) {
        violations.push(`${rel}: unrecognized insert site(s) [${extra.join(' | ')}] — new or reworked. Adopt the contract; never add or edit a frozen fingerprint.`);
      }
    }
    if (violations.length) {
      throw new Error(
        'Bare scheduled_services insert(s) found outside the booking contract:\n'
        + `  ${violations.join('\n  ')}\n`
        + 'Use createScheduledService / completeScheduledServiceInsert from '
        + `${CONTRACT_MODULE}.`,
      );
    }
  });

  test('the frozen inventory mirrors reality (stale entries must be removed)', () => {
    const stale = [];
    for (const [rel, frozen] of Object.entries(FROZEN_LEGACY_INSERT_SITES_2026_09)) {
      const gone = multisetMissing(frozen, found.get(rel) || []);
      if (gone.length) {
        stale.push(`${rel}: frozen site(s) no longer present [${gone.join(' | ')}] — remove them from the map in the same PR.`);
      }
    }
    if (stale.length) throw new Error(`Frozen insert inventory is stale:\n  ${stale.join('\n  ')}`);
  });
});
