#!/usr/bin/env node
/**
 * Import Square Appointments from .ics (iCal) calendar exports
 *
 * Parses VEVENT entries from Google Calendar .ics files exported from
 * Square Appointments. Extracts customer name, phone, email, address,
 * service type, duration, price, and date/time.
 *
 * Usage:
 *   node scripts/import-ical-appointments.js [--dry-run] [--file path/to/file.ics]
 *
 * Without --file, imports from /tmp/ical_extract/*.ics (excluding contact@ calendar)
 * With --dry-run, parses and reports but does not write to the database.
 */

const fs = require('fs');
const path = require('path');
const knex = require('knex');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');
const FILE_ARG = process.argv.find((a, i) => process.argv[i - 1] === '--file');
const DEFAULT_DIR = '/tmp/ical_extract';

const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/waves_portal';

// ---------------------------------------------------------------------------
// iCal parser
// ---------------------------------------------------------------------------

function parseIcsFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // RFC 5545: unfold continuation lines (lines starting with space/tab)
  const content = raw.replace(/\r?\n[ \t]/g, '');
  const blocks = content.split('BEGIN:VEVENT');
  const events = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const ev = parseEvent(block);
    if (ev) events.push(ev);
  }
  return events;
}

function getField(block, name) {
  const re = new RegExp(`^${name}[;:](.*)$`, 'm');
  const m = block.match(re);
  if (!m) return null;
  // Handle value params like DTSTART;TZID=America/New_York:20250705T160000
  let val = m[1];
  if (val.includes(':') && !val.startsWith('http')) {
    val = val.split(':').pop();
  }
  return val.trim();
}

function parseIcsDate(dtStr) {
  if (!dtStr) return null;
  // Format: 20250705T200000Z or 20250705T160000
  const m = dtStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : ''}`;
  return new Date(iso);
}

function parseEvent(block) {
  const dtStartRaw = getField(block, 'DTSTART');
  const dtEndRaw = getField(block, 'DTEND');
  const summary = getField(block, 'SUMMARY');
  const location = getField(block, 'LOCATION');
  const status = getField(block, 'STATUS');
  const uid = getField(block, 'UID');

  // Get DESCRIPTION (may have escaped chars)
  const descMatch = block.match(/^DESCRIPTION:(.*)/m);
  const description = descMatch ? descMatch[1] : '';

  const dtStart = parseIcsDate(dtStartRaw);
  const dtEnd = parseIcsDate(dtEndRaw);
  if (!dtStart) return null;

  // Skip non-appointment entries (timezone defs, etc.)
  if (!summary) return null;

  // Parse the description to extract customer details
  // Format: "*** Square boilerplate...\n\nhttps://...\n\nName\nPhone - Email\nService - Duration [- $Price]\n"
  const descText = description
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\\\/g, '\\');

  const lines = descText.split('\n').map(l => l.trim()).filter(Boolean);

  // Find the customer info lines (after the URL line)
  let customerName = summary || '';
  let phone = null;
  let email = null;
  let serviceType = null;
  let duration = null;
  let price = null;

  // Look for the phone/email line: "(xxx) xxx-xxxx - email@example.com" or "+1xxxxx - email"
  for (const line of lines) {
    const phoneEmailMatch = line.match(/^([+()\d\s-]{7,})\s*-\s*(\S+@\S+)$/);
    if (phoneEmailMatch) {
      phone = phoneEmailMatch[1].trim();
      email = phoneEmailMatch[2].trim();
      continue;
    }
    // Phone only
    const phoneOnly = line.match(/^([+()\d\s-]{10,})$/);
    if (phoneOnly && !phone) {
      phone = phoneOnly[1].trim();
      continue;
    }
    // Service type line: "Pest Control Service - 1 hour - $117" or "Pest Control Service - 1 hour - Free"
    const svcMatch = line.match(/^(.+?)\s*-\s*(\d+\s*(?:hour|min)\w*)\s*(?:-\s*(?:\$?([\d,.]+)|Free))?$/i);
    if (svcMatch) {
      serviceType = svcMatch[1].trim();
      duration = svcMatch[2].trim();
      price = svcMatch[3] ? parseFloat(svcMatch[3].replace(/,/g, '')) : null;
      continue;
    }
    // Service type without duration: just check for known service keywords
    if (!serviceType && /(?:pest|lawn|rodent|termite|mosquito|bed bug|wildlife|inspection|waveguard|waves|tree|shrub|aeration|mud dauber)/i.test(line)) {
      // Strip trailing " - 1 hour - Free" etc if present
      serviceType = line.replace(/\s*-\s*\d+\s*(?:hour|min)\w*.*$/i, '').trim();
    }
  }

  // Parse duration to minutes
  let durationMinutes = 60; // default
  if (duration) {
    const hMatch = duration.match(/(\d+)\s*hour/i);
    const mMatch = duration.match(/(\d+)\s*min/i);
    durationMinutes = (hMatch ? parseInt(hMatch[1]) * 60 : 0) + (mMatch ? parseInt(mMatch[1]) : 0);
  } else if (dtStart && dtEnd) {
    durationMinutes = Math.round((dtEnd - dtStart) / 60000);
  }

  // Parse location
  let address = null;
  if (location) {
    address = location.replace(/\\,/g, ',').replace(/\\\\/g, '\\').trim();
  }

  // Normalize service type
  if (!serviceType || serviceType === customerName) {
    serviceType = 'Pest Control Service'; // default
  }

  // Determine status mapping
  let apptStatus = 'completed'; // historical default
  const now = new Date();
  if (dtStart > now) {
    apptStatus = status === 'CANCELLED' ? 'cancelled' : 'pending';
  } else if (status === 'CANCELLED') {
    apptStatus = 'cancelled';
  }

  return {
    uid,
    customer_name: customerName,
    phone,
    email,
    address,
    service_type: serviceType,
    duration_minutes: durationMinutes,
    price,
    scheduled_date: dtStart,
    scheduled_end: dtEnd,
    status: apptStatus,
    ical_status: status,
    source_calendar: 'square_appointments',
  };
}

// ---------------------------------------------------------------------------
// Normalize phone to E.164-ish for matching
// ---------------------------------------------------------------------------
function normalizePhone(ph) {
  if (!ph) return null;
  const digits = ph.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

// ---------------------------------------------------------------------------
// Database import
// ---------------------------------------------------------------------------

async function importToDatabase(events, db) {
  // Ensure scheduled_services table exists
  if (!(await db.schema.hasTable('scheduled_services'))) {
    console.log('  scheduled_services table does not exist — creating...');
    await db.schema.createTable('scheduled_services', t => {
      t.uuid('id').primary().defaultTo(db.raw("gen_random_uuid()"));
      t.uuid('customer_id');
      t.uuid('technician_id');
      t.date('scheduled_date').notNullable();
      t.time('window_start');
      t.time('window_end');
      t.string('service_type', 100).notNullable();
      t.string('status', 20).defaultTo('pending');
      t.text('notes');
      t.boolean('customer_confirmed').defaultTo(false);
      t.timestamp('confirmed_at');
      t.string('source', 50).defaultTo('ical_import');
      t.string('square_booking_id', 100);
      t.integer('estimated_duration_minutes');
      t.timestamps(true, true);
      t.index(['customer_id', 'scheduled_date']);
    });
  }

  // Ensure import tracking columns
  const hasSource = await db.schema.hasColumn('scheduled_services', 'source');
  if (!hasSource) {
    await db.schema.alterTable('scheduled_services', t => {
      t.string('source', 50).defaultTo('admin');
    });
  }
  const hasIcalUid = await db.schema.hasColumn('scheduled_services', 'ical_uid');
  if (!hasIcalUid) {
    await db.schema.alterTable('scheduled_services', t => {
      t.string('ical_uid', 200);
      t.index('ical_uid');
    });
  }

  // Ensure ical_appointments archive table for raw data
  if (!(await db.schema.hasTable('ical_appointments'))) {
    await db.schema.createTable('ical_appointments', t => {
      t.increments('id').primary();
      t.string('ical_uid', 200).unique();
      t.string('customer_name', 200);
      t.string('phone', 30);
      t.string('email', 200);
      t.text('address');
      t.string('service_type', 200);
      t.integer('duration_minutes');
      t.decimal('price', 10, 2);
      t.timestamp('scheduled_date');
      t.timestamp('scheduled_end');
      t.string('status', 20);
      t.string('ical_status', 20);
      t.string('source_calendar', 50);
      t.uuid('matched_customer_id');
      t.uuid('scheduled_service_id');
      t.timestamp('imported_at').defaultTo(db.fn.now());
      t.index('scheduled_date');
      t.index('matched_customer_id');
      t.index('phone');
      t.index('email');
    });
  }

  // Load existing customers for matching
  console.log('  Loading customers for matching...');
  const customers = await db('customers').select('id', 'name', 'email', 'phone', 'address');
  const customerByEmail = {};
  const customerByPhone = {};
  const customerByName = {};
  for (const c of customers) {
    if (c.email) customerByEmail[c.email.toLowerCase()] = c;
    if (c.phone) customerByPhone[normalizePhone(c.phone)] = c;
    if (c.name) customerByName[c.name.toLowerCase().trim()] = c;
  }
  console.log(`  ${customers.length} customers loaded for matching`);

  // Check for already-imported UIDs
  const existingUids = new Set();
  try {
    const rows = await db('ical_appointments').select('ical_uid');
    rows.forEach(r => existingUids.add(r.ical_uid));
  } catch (e) { /* table may not exist yet */ }

  let imported = 0, skipped = 0, matched = 0, unmatched = 0;
  const unmatchedList = [];
  const batchSize = 100;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    const icalRows = [];
    const schedRows = [];

    for (const ev of batch) {
      if (existingUids.has(ev.uid)) {
        skipped++;
        continue;
      }

      // Match customer
      let customerId = null;
      if (ev.email && customerByEmail[ev.email.toLowerCase()]) {
        customerId = customerByEmail[ev.email.toLowerCase()].id;
      } else if (ev.phone && customerByPhone[normalizePhone(ev.phone)]) {
        customerId = customerByPhone[normalizePhone(ev.phone)].id;
      } else if (ev.customer_name && customerByName[ev.customer_name.toLowerCase().trim()]) {
        customerId = customerByName[ev.customer_name.toLowerCase().trim()].id;
      }

      if (customerId) matched++;
      else {
        unmatched++;
        unmatchedList.push({ name: ev.customer_name, phone: ev.phone, email: ev.email });
      }

      // Format times
      const schedDate = ev.scheduled_date.toISOString().slice(0, 10);
      const windowStart = ev.scheduled_date.toTimeString().slice(0, 5);
      const windowEnd = ev.scheduled_end ? ev.scheduled_end.toTimeString().slice(0, 5) : null;

      icalRows.push({
        ical_uid: ev.uid,
        customer_name: ev.customer_name,
        phone: ev.phone,
        email: ev.email,
        address: ev.address,
        service_type: ev.service_type,
        duration_minutes: ev.duration_minutes,
        price: ev.price,
        scheduled_date: ev.scheduled_date,
        scheduled_end: ev.scheduled_end,
        status: ev.status,
        ical_status: ev.ical_status,
        source_calendar: ev.source_calendar,
        matched_customer_id: customerId,
      });

      schedRows.push({
        customer_id: customerId,
        scheduled_date: schedDate,
        window_start: windowStart,
        window_end: windowEnd,
        service_type: ev.service_type,
        status: ev.status,
        notes: [
          ev.customer_name,
          ev.address || '',
          ev.price ? `$${ev.price}` : '',
          `Imported from Square Appointments`
        ].filter(Boolean).join(' | '),
        source: 'ical_import',
        ical_uid: ev.uid,
        estimated_duration_minutes: ev.duration_minutes,
      });

      imported++;
    }

    if (icalRows.length > 0) {
      // Insert into archive table
      await db('ical_appointments').insert(icalRows).onConflict('ical_uid').ignore();

      // Insert into scheduled_services
      for (const row of schedRows) {
        try {
          const [inserted] = await db('scheduled_services').insert(row).returning('id');
          // Update ical_appointments with the scheduled_service_id
          if (inserted) {
            await db('ical_appointments')
              .where('ical_uid', row.ical_uid)
              .update({ scheduled_service_id: inserted.id });
          }
        } catch (err) {
          // Skip duplicates or constraint errors
          if (!err.message.includes('duplicate') && !err.message.includes('unique')) {
            console.error(`  Error inserting ${row.ical_uid}: ${err.message}`);
          }
        }
      }
    }

    if ((i + batchSize) % 500 === 0 || i + batchSize >= events.length) {
      console.log(`  Progress: ${Math.min(i + batchSize, events.length)}/${events.length}`);
    }
  }

  return { imported, skipped, matched, unmatched, unmatchedList };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Square Appointments iCal Import ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE IMPORT'}\n`);

  // Collect .ics files
  let files = [];
  if (FILE_ARG) {
    files = [FILE_ARG];
  } else {
    const dir = DEFAULT_DIR;
    if (!fs.existsSync(dir)) {
      console.error(`Directory not found: ${dir}`);
      console.error('Extract the .ical.zip first or use --file path/to/file.ics');
      process.exit(1);
    }
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.ics') && !f.startsWith('contact@'))
      .map(f => path.join(dir, f));
  }

  console.log(`Files to import: ${files.length}`);
  files.forEach(f => console.log(`  ${path.basename(f)}`));
  console.log();

  // Parse all events
  let allEvents = [];
  const seenUids = new Set();

  for (const file of files) {
    console.log(`Parsing: ${path.basename(file)}`);
    const events = parseIcsFile(file);
    console.log(`  ${events.length} events parsed`);

    // Deduplicate across files by UID
    let dupes = 0;
    for (const ev of events) {
      if (seenUids.has(ev.uid)) {
        dupes++;
        continue;
      }
      seenUids.add(ev.uid);
      allEvents.push(ev);
    }
    if (dupes) console.log(`  ${dupes} duplicates across calendars skipped`);
  }

  console.log(`\nTotal unique events: ${allEvents.length}`);

  // Sort by date
  allEvents.sort((a, b) => a.scheduled_date - b.scheduled_date);

  // Stats
  const now = new Date();
  const historical = allEvents.filter(e => e.scheduled_date <= now).length;
  const future = allEvents.filter(e => e.scheduled_date > now).length;
  const cancelled = allEvents.filter(e => e.ical_status === 'CANCELLED').length;

  console.log(`  Historical (past): ${historical}`);
  console.log(`  Future (upcoming): ${future}`);
  console.log(`  Cancelled: ${cancelled}`);

  // Date range
  const earliest = allEvents[0]?.scheduled_date;
  const latest = allEvents[allEvents.length - 1]?.scheduled_date;
  console.log(`  Date range: ${earliest?.toISOString().slice(0,10)} → ${latest?.toISOString().slice(0,10)}`);

  // Service type breakdown
  const svcCounts = {};
  allEvents.forEach(e => { svcCounts[e.service_type] = (svcCounts[e.service_type] || 0) + 1; });
  console.log('\nService type breakdown:');
  Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).forEach(([svc, count]) => {
    console.log(`  ${count.toString().padStart(5)} × ${svc}`);
  });

  if (DRY_RUN) {
    console.log('\n--- DRY RUN complete. No database changes made. ---');
    console.log('Run without --dry-run to import into the database.');

    // Show sample records
    console.log('\nSample records:');
    for (const ev of allEvents.slice(0, 5)) {
      console.log(`  ${ev.scheduled_date.toISOString().slice(0,10)} | ${ev.customer_name} | ${ev.phone || 'no phone'} | ${ev.service_type} | ${ev.status}`);
    }
    process.exit(0);
  }

  // Live import
  console.log('\nConnecting to database...');
  const db = knex({
    client: 'pg',
    connection: DB_URL,
    pool: { min: 1, max: 5 },
  });

  try {
    await db.raw('SELECT 1');
    console.log('  Connected.\n');

    const result = await importToDatabase(allEvents, db);

    console.log('\n=== Import Complete ===');
    console.log(`  Imported:  ${result.imported}`);
    console.log(`  Skipped:   ${result.skipped} (already imported)`);
    console.log(`  Matched:   ${result.matched} (linked to existing customer)`);
    console.log(`  Unmatched: ${result.unmatched} (no customer match — stored in ical_appointments)`);

    if (result.unmatchedList.length > 0) {
      console.log(`\nFirst 20 unmatched customers:`);
      for (const u of result.unmatchedList.slice(0, 20)) {
        console.log(`  ${u.name} | ${u.phone || 'no phone'} | ${u.email || 'no email'}`);
      }
    }
  } catch (err) {
    console.error('Database error:', err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
