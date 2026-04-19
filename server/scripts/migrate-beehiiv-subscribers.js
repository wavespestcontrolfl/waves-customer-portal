#!/usr/bin/env node
/**
 * Beehiiv → newsletter_subscribers reconcile.
 *
 * Reads a beehiiv subscriber CSV export, matches each row against customers
 * by email, and writes into the existing newsletter_subscribers table.
 *
 * Four buckets:
 *   - matched_active      beehiiv active   + customer exists  → active sub, customer_id set
 *   - matched_suppressed  beehiiv unsub    + customer exists  → unsubscribed sub, customer_id set
 *   - orphan_active       beehiiv active   + no customer      → active sub, customer_id NULL
 *   - orphan_suppressed   beehiiv unsub    + no customer      → unsubscribed sub, customer_id NULL
 *
 * The orphan_active bucket is the "in your orbit but never converted" list —
 * a lead pool Virginia can review for outreach.
 *
 * Safety:
 *   - default is dry-run (prints buckets, writes no rows)
 *   - --apply commits the inserts/updates
 *   - never downgrades an existing 'active' row to 'unsubscribed' unless the
 *     CSV explicitly says so (the local record is already-more-recent truth)
 *   - email comparisons are lowercase+trim on both sides
 *   - rows with no @ in the email are skipped (printed to `skipped_invalid_email`)
 *
 * A JSON report (per-row buckets + action taken) is written to the repo root
 * as `tmp-beehiiv-reconcile-<timestamp>.json`.
 *
 * Usage:
 *   node server/scripts/migrate-beehiiv-subscribers.js path/to/beehiiv-export.csv
 *   node server/scripts/migrate-beehiiv-subscribers.js path/to/beehiiv-export.csv --apply
 *
 * Expected CSV columns (case-insensitive, extra columns ignored):
 *   email          (required)
 *   status         (active|unsubscribed|inactive — defaults to active if blank)
 *   first_name     (optional; firstName also accepted)
 *   last_name      (optional; lastName also accepted)
 *   created        (optional; subscribed_at also accepted)
 *   unsubscribed_at (optional)
 */

const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const db = require('../models/db');

const APPLY = process.argv.includes('--apply');
const csvPath = process.argv.slice(2).find((a) => !a.startsWith('--'));

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function lcTrim(v) {
  return (v == null ? '' : String(v)).trim().toLowerCase();
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeStatus(raw) {
  const v = lcTrim(raw);
  if (!v) return 'active';
  // Beehiiv exports use: active, inactive, pending, unsubscribed.
  // Anything that isn't clearly "still opted in" counts as suppressed.
  if (v === 'active' || v === 'confirmed' || v === 'subscribed') return 'active';
  return 'unsubscribed';
}

async function reconcileRow(row) {
  const emailLc = lcTrim(pick(row, 'email', 'Email', 'EMAIL'));
  if (!emailLc || !emailLc.includes('@')) {
    return { bucket: 'skipped_invalid_email', email: emailLc || null };
  }

  const status = normalizeStatus(pick(row, 'status', 'Status'));
  const isActive = status === 'active';

  const firstName = pick(row, 'first_name', 'firstName', 'First Name', 'FirstName');
  const lastName = pick(row, 'last_name', 'lastName', 'Last Name', 'LastName');
  const subscribedAt = parseDate(pick(row, 'created', 'subscribed_at', 'created_at', 'Created'));
  const unsubscribedAt = parseDate(pick(row, 'unsubscribed_at', 'Unsubscribed At'));

  const customer = await db('customers')
    .whereRaw('LOWER(email) = ?', [emailLc])
    .first('id');
  const existing = await db('newsletter_subscribers')
    .whereRaw('LOWER(email) = ?', [emailLc])
    .first();

  const bucket = customer
    ? (isActive ? 'matched_active' : 'matched_suppressed')
    : (isActive ? 'orphan_active' : 'orphan_suppressed');

  if (!APPLY) {
    return {
      bucket,
      email: emailLc,
      hadCustomerMatch: !!customer,
      alreadyInList: !!existing,
      existingStatus: existing?.status || null,
      action: existing
        ? (isActive
            ? 'would_update_existing'
            : (existing.status !== 'unsubscribed' ? 'would_unsubscribe_existing' : 'no_change'))
        : 'would_insert',
    };
  }

  if (existing) {
    const update = {};
    if (!existing.customer_id && customer?.id) update.customer_id = customer.id;
    if (!existing.first_name && firstName) update.first_name = firstName;
    if (!existing.last_name && lastName) update.last_name = lastName;

    // Only beehiiv → unsub flips the local status. An existing 'active' row
    // that we created via /subscribe is more recent truth than the CSV; we
    // never downgrade it to 'unsubscribed' based on stale beehiiv state.
    if (!isActive && existing.status !== 'unsubscribed') {
      update.status = 'unsubscribed';
      update.unsubscribed_at = unsubscribedAt || new Date();
    }

    if (Object.keys(update).length === 0) {
      return { bucket, email: emailLc, action: 'no_change' };
    }
    update.updated_at = new Date();
    await db('newsletter_subscribers').where({ id: existing.id }).update(update);
    return { bucket, email: emailLc, action: 'updated', fields: Object.keys(update) };
  }

  const insertRow = {
    email: emailLc,
    customer_id: customer?.id || null,
    first_name: firstName,
    last_name: lastName,
    source: customer ? 'beehiiv_migration' : 'beehiiv_migration_orphan',
    status: isActive ? 'active' : 'unsubscribed',
    subscribed_at: subscribedAt || new Date(),
    unsubscribed_at: isActive ? null : (unsubscribedAt || new Date()),
  };
  await db('newsletter_subscribers').insert(insertRow);
  return { bucket, email: emailLc, action: 'inserted' };
}

async function run() {
  if (!csvPath) {
    fail(
      'Usage:\n' +
      '  node server/scripts/migrate-beehiiv-subscribers.js <beehiiv-export.csv>           # dry run\n' +
      '  node server/scripts/migrate-beehiiv-subscribers.js <beehiiv-export.csv> --apply   # commit\n'
    );
  }
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) fail(`CSV not found: ${abs}`);

  const raw = fs.readFileSync(abs, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  console.log(`\n[beehiiv-reconcile] Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`[beehiiv-reconcile] Source: ${abs}`);
  console.log(`[beehiiv-reconcile] Parsed ${rows.length} row(s)\n`);

  const buckets = {
    matched_active: [],
    matched_suppressed: [],
    orphan_active: [],
    orphan_suppressed: [],
    skipped_invalid_email: [],
  };

  for (const row of rows) {
    try {
      const res = await reconcileRow(row);
      if (!buckets[res.bucket]) buckets[res.bucket] = [];
      buckets[res.bucket].push(res);
    } catch (err) {
      console.error(`  ✖ Row failed (${row.email || '?'}): ${err.message}`);
    }
  }

  for (const [name, items] of Object.entries(buckets)) {
    console.log(`${name.padEnd(24)} ${items.length}`);
  }

  const reportPath = path.resolve(`tmp-beehiiv-reconcile-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    source: abs,
    generatedAt: new Date().toISOString(),
    totals: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    buckets,
  }, null, 2));
  console.log(`\nReport: ${reportPath}`);

  if (!APPLY) {
    console.log(`\n→ Re-run with --apply to commit inserts/updates.\n`);
  } else {
    console.log(`\n✓ Applied. Orphan-active (${buckets.orphan_active.length}) is the list\n` +
                `  Virginia should review — newsletter subs without a customer record.\n`);
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => { console.error('[beehiiv-reconcile] FATAL:', err); process.exit(1); });
}

module.exports = { run };
