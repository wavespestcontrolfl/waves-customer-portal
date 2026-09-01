/**
 * Booking insert-site contract — mechanical enforcement of "no new bare
 * scheduled_services inserts" (Tier 2 booking-consolidation track).
 *
 * Every production INSERT into scheduled_services must either go through
 * the booking contract (services/booking/create-scheduled-service.js) or
 * be one of the frozen legacy sites below. The legacy inventory is a
 * frozen per-file COUNT snapshot: counts may only DECREASE as writers
 * adopt the contract (remove/lower the entry in the same PR), and no file
 * may ever be added or increased — a diff that grows
 * FROZEN_LEGACY_INSERT_SITES_2026_09 is a policy violation, not a fix for
 * this test. A stale entry (file no longer inserting) also fails, so the
 * map always mirrors reality.
 *
 * Matcher shape: a `('scheduled_services')` table ref with `.insert(`
 * either on the same line or within the next 3 lines (the
 * call-recording-processor and seeder sites chain across lines). Comments
 * are not stripped — the sites are call expressions, and a commented-out
 * insert should be deleted, not hidden from the scanner.
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

// Frozen 2026-09-01 inventory: 26 sites, 14 files. Shrink-only.
const FROZEN_LEGACY_INSERT_SITES_2026_09 = {
  'server/routes/admin-schedule.js': 8,       // POST / parent+children+boosters, update-details spawn, extends, recurring-alert extend/convert
  'server/routes/booking.js': 1,              // createSelfBooking
  'server/routes/admin-dispatch.js': 1,       // completion-CTA follow-up
  'server/routes/admin-leads.js': 1,          // lead → appointment conversion
  'server/services/slot-reservation.js': 1,   // estimate slot hold (customer_id NULL by design)
  'server/services/health-alerts.js': 1,      // complimentary visit action
  'server/services/availability.js': 1,       // AI-assistant confirmBooking
  'server/services/recurring-appointment-seeder.js': 2, // seedFollowUpsForParent (locked/unlocked arms)
  'server/services/annual-prepay-renewals.js': 3,       // timed + windowless coverage rows
  'server/services/intelligence-bar/tools.js': 1,       // create_appointment
  'server/services/estimate-converter.js': 2,           // standalone companion + main unit
  'server/services/voice-agent/relay-booking.js': 1,    // commitVoiceBooking
  'server/services/call-recording-processor.js': 2,     // idempotent booking + follow-up savepoint
  'scripts/import-ical-appointments.js': 1,             // legacy import script
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

// Count scheduled_services insert call sites in one file.
function countInsertSites(source) {
  const lines = source.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/['"`]scheduled_services['"`]\s*\)/.test(lines[i])) continue;
    const windowText = lines.slice(i, i + 4).join('\n');
    // Anchor the .insert( to THIS table ref: same line after the ref, or a
    // chained call on the following lines before any other table ref.
    const afterRef = windowText.slice(windowText.indexOf('scheduled_services'));
    const nextRef = afterRef.slice(20).search(/['"`]\w+['"`]\s*\)/);
    const scope = nextRef === -1 ? afterRef : afterRef.slice(0, 20 + nextRef);
    if (/\.insert\s*\(/.test(scope)) count += 1;
  }
  return count;
}

function relRepo(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

describe('booking insert-site contract', () => {
  const files = [...walk(SERVER_ROOT), ...walk(path.join(REPO_ROOT, 'scripts'))];
  const found = new Map(); // repo-relative path -> count
  for (const file of files) {
    const rel = relRepo(file);
    if (rel === CONTRACT_MODULE) continue;
    const n = countInsertSites(fs.readFileSync(file, 'utf8'));
    if (n > 0) found.set(rel, n);
  }

  test('the matcher recognizes every insert shape it claims to (self-check)', () => {
    expect(countInsertSites("await trx('scheduled_services').insert(insertData).returning('*');")).toBe(1);
    expect(countInsertSites("const [r] = await sp('scheduled_services')\n  .insert({\n    customer_id: id,\n  })")).toBe(1);
    expect(countInsertSites("await trx('scheduled_services')\n  .insert(insertData)\n  .onConflict('idempotency_key')\n  .ignore()")).toBe(1);
    // A read chained near the ref must NOT count…
    expect(countInsertSites("await trx('scheduled_services').where({ id }).first();")).toBe(0);
    // …nor an insert into a DIFFERENT table on the next line.
    expect(countInsertSites("await trx('scheduled_services').where({ id }).update({ a: 1 });\nawait trx('lead_activities').insert({ b: 2 });")).toBe(0);
  });

  test('no NEW scheduled_services insert sites outside the booking contract', () => {
    const violations = [];
    for (const [rel, n] of found) {
      const frozen = FROZEN_LEGACY_INSERT_SITES_2026_09[rel];
      if (frozen === undefined) {
        violations.push(`${rel}: ${n} site(s) — new file. Route the insert through services/booking/create-scheduled-service.js.`);
      } else if (n > frozen) {
        violations.push(`${rel}: ${n} site(s), frozen at ${frozen}. New inserts go through the booking contract.`);
      }
    }
    if (violations.length) {
      throw new Error(
        'Bare scheduled_services insert(s) found outside the booking contract:\n'
        + `  ${violations.join('\n  ')}\n`
        + 'Use createScheduledService / completeScheduledServiceInsert from '
        + 'server/services/booking/create-scheduled-service.js. Never add to the frozen map.',
      );
    }
  });

  test('the frozen inventory mirrors reality (stale or shrunk entries must be updated)', () => {
    const stale = [];
    for (const [rel, frozen] of Object.entries(FROZEN_LEGACY_INSERT_SITES_2026_09)) {
      const n = found.get(rel) || 0;
      if (n < frozen) {
        stale.push(`${rel}: frozen at ${frozen} but ${n} found — shrink the frozen entry in the same PR (remove it at 0).`);
      }
    }
    if (stale.length) throw new Error(`Frozen insert inventory is stale:\n  ${stale.join('\n  ')}`);
  });
});
