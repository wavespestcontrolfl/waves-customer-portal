/**
 * Booking insert-site contract — mechanical enforcement of "no new bare
 * scheduled_services inserts" (Tier 2 booking-consolidation track).
 *
 * Every production INSERT into scheduled_services must either go through
 * the booking contract (services/booking/create-scheduled-service.js) or
 * be one of the frozen legacy sites below. The inventory freezes each
 * site's FINGERPRINT — the statement prefix (call-site identity: the
 * assignment/return context on the ref's line) plus the normalized
 * `('scheduled_services')…insert(<arg head>` expression — as a per-file
 * multiset, not a bare count: with
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
    "[svc] = await trx( scheduled_services').insert(insertData",
    "const [childRow] = await trx( scheduled_services').insert(childData",
    "const [boosterRow] = await trx( scheduled_services').insert(boosterData",
    "const [childRow] = await trx( scheduled_services').insert(childData",
    "const [row] = await trx( scheduled_services').insert(data",
    "const [autoExtRow] = await conn( scheduled_services').insert(nextData",
    "const [row] = await trx( scheduled_services').insert(data",
    "const [row] = await trx( scheduled_services').insert(data",
  ],
  'server/routes/booking.js': [
    "const [scheduledRow] = await trx( scheduled_services').insert({",
  ],
  'server/routes/admin-dispatch.js': [
    "return trx( scheduled_services').insert(insertData",
  ],
  'server/routes/admin-leads.js': [
    "const [appt] = await trx( scheduled_services').insert(insertData",
  ],
  'server/services/slot-reservation.js': [
    "const [row] = await trx( scheduled_services').insert({",
  ],
  'server/services/health-alerts.js': [
    "return trx( scheduled_services').insert({",
  ],
  'server/services/availability.js': [
    "const [scheduledRow] = await trx( scheduled_services').insert({",
  ],
  'server/services/recurring-appointment-seeder.js': [
    "? await (async () => { await lockCustomerComms(conn, parent.customer_id); return conn( scheduled_services').insert(rows",
    ": await withCustomerCommsLock(conn, parent.customer_id, (trx) => trx( scheduled_services').insert(rows",
  ],
  'server/services/annual-prepay-renewals.js': [
    "const [row] = await trx( scheduled_services').insert(buildInsert(scheduledDate, windowStart)",
    "[created] = await conn( scheduled_services').insert(buildInsert(scheduledDate, null)",
    "return trx( scheduled_services').insert(buildInsert(scheduledDate, null)",
  ],
  'server/services/intelligence-bar/tools.js': [
    "const [created] = await trx( scheduled_services').insert({",
  ],
  'server/services/estimate-converter.js': [
    "const inserted = await trx( scheduled_services').insert(standaloneRow",
    "const inserted = await trx( scheduled_services').insert(row",
  ],
  'server/services/voice-agent/relay-booking.js': [
    "const [created] = await trx( scheduled_services').insert(insertRow",
  ],
  'server/services/call-recording-processor.js': [
    "const [fuRow] = await sp( scheduled_services').insert({",
    "const [created] = await trx( scheduled_services').insert(insertData",
  ],
  'scripts/import-ical-appointments.js': [
    "const [inserted] = await db( scheduled_services').insert(row",
  ],
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

// The statement text on the ref's line BEFORE the match — call-site
// identity, so two byte-identical insert expressions in one file still
// carry distinct fingerprints (the assignment/return context differs) and
// a migrated site can't cancel against a newly added twin
// (GH Codex #3702 r4 P2). For a table string on its own line, the
// previous non-blank line carries the identity.
function statementPrefix(source, refIndex) {
  let lineStart = source.lastIndexOf('\n', refIndex - 1) + 1;
  let prefix = source.slice(lineStart, refIndex).trim();
  if (!prefix) {
    const prevEnd = lineStart - 1;
    const prevStart = source.lastIndexOf('\n', prevEnd - 1) + 1;
    prefix = source.slice(prevStart, prevEnd).trim();
  }
  return prefix.replace(/\s+/g, ' ');
}

// Collect scheduled_services insert-site fingerprints in one file by
// walking each table ref's ENTIRE chained expression. A builder stored in
// a variable first (`const visits = trx('scheduled_services'); await
// visits.insert(...)`) is followed through the alias: every later
// `<alias>.insert(` in the file counts as a site (GH Codex #3702 r4 P2).
function collectInsertSites(source) {
  const out = [];
  // Raw SQL inserts are sites too — a knex.raw('INSERT INTO
  // scheduled_services …') must not slip past a builder-only scan
  // (GH Codex r5 P1).
  const rawRe = /INSERT\s+INTO\s+["'`]?scheduled_services\b/gi;
  let rawM;
  while ((rawM = rawRe.exec(source)) !== null) {
    // Comment mentions are not sites (the iCal script documents its own
    // insert in prose).
    const lineStart = source.lastIndexOf('\n', rawM.index - 1) + 1;
    const line = source.slice(lineStart, rawM.index);
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    out.push(`${statementPrefix(source, rawM.index)} raw:INSERT INTO scheduled_services`.trim());
  }
  const re = /['"`]scheduled_services['"`]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    // Table-LAST builder forms: trx.insert(data).into('scheduled_services')
    // / .table('scheduled_services') put the insert BEFORE the table ref,
    // so the forward chain walk below never sees it (GH Codex r5 P1). The
    // statement's text up to the ref carries the .insert( in that shape.
    const before = source.slice(Math.max(0, m.index - 12), m.index);
    if (/\.(into|table)\s*\($/.test(before)) {
      const prefix = statementPrefix(source, m.index);
      if (/\.insert\s*\(/.test(prefix)) {
        out.push(`${prefix} table-last:scheduled_services`.trim());
      }
      continue;
    }
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
    const prefix = statementPrefix(source, m.index);
    if (/\.insert\s*\(/.test(chain)) {
      out.push(`${prefix} ${fingerprintOf(chain)}`.trim());
      continue;
    }
    // No insert on the fluent chain — if the builder was captured in a
    // variable, chase later .insert( calls through that alias.
    const assign = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/.exec(statementPrefix(source, m.index));
    if (assign) {
      const alias = assign[1];
      const aliasRe = new RegExp(`\\b${alias}\\s*\\.\\s*insert\\s*\\(\\s*(\\{|[A-Za-z0-9_.$]+)?`, 'g');
      let am;
      while ((am = aliasRe.exec(source)) !== null) {
        out.push(`${statementPrefix(source, am.index)} alias:${am[0].replace(/\s+/g, ' ')}`.trim());
      }
    }
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
    expect(collectInsertSites("await trx('scheduled_services').insert(insertData).returning('*');")).toEqual(["await trx( scheduled_services').insert(insertData"]);
    expect(collectInsertSites("const [r] = await sp('scheduled_services')\n  .insert({\n    customer_id: id,\n  })")).toEqual(["const [r] = await sp( scheduled_services').insert({"]);
    expect(collectInsertSites("await trx('scheduled_services')\n  .insert(insertData)\n  .onConflict('idempotency_key')\n  .ignore()")).toEqual(["await trx( scheduled_services').insert(insertData"]);
    // A LONG chain (any number of links/lines before .insert) is caught —
    // the bounded 3-line window this replaces was evadable by padding.
    expect(collectInsertSites("await trx('scheduled_services')\n  .where({ a: 1 })\n  // pad\n  .whereIn('c', [1, 2])\n  .orderBy('d')\n  .limit(1)\n  .insert(sneaky)")[0]).toContain('.insert(sneaky');
    // A table argument split across lines is still a ref.
    expect(collectInsertSites("await db(\n  'scheduled_services'\n).insert(x)")).toEqual(["await db( scheduled_services').insert(x"]);
    // A builder captured in a variable is followed through the alias
    // (GH Codex r4 P2 — the fluent-chain-only scan missed it).
    expect(collectInsertSites("const visits = trx('scheduled_services');\nawait doStuff();\nawait visits.insert(data);")).toEqual(["await alias:visits.insert(data"]);
    // Two byte-identical insert EXPRESSIONS in different statements carry
    // distinct call-site identities (GH Codex r4 P2 — a migrated site must
    // not cancel against a newly added twin).
    const twins = collectInsertSites("const [a] = await trx('scheduled_services').insert(insertData);\nreturn trx('scheduled_services').insert(insertData);");
    expect(new Set(twins).size).toBe(2);
    // Table-last forms and raw SQL are caught (GH Codex r5 P1).
    expect(collectInsertSites("await trx.insert(data).into('scheduled_services');")).toEqual(["await trx.insert(data).into( table-last:scheduled_services"]);
    expect(collectInsertSites("await trx.insert(data).table('scheduled_services');")).toEqual(["await trx.insert(data).table( table-last:scheduled_services"]);
    expect(collectInsertSites("await db.raw(`INSERT INTO scheduled_services (a) VALUES (?)`, [1]);")).toEqual(["await db.raw(` raw:INSERT INTO scheduled_services"]);
    // …but a table-last READ does not.
    expect(collectInsertSites("await trx.select('*').from('x').table('scheduled_services');")).toEqual([]);
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
