#!/usr/bin/env node
/**
 * Beehiiv → newsletter_subscribers reconcile.
 *
 * Reads a beehiiv subscriber CSV export, matches each row against customers
 * by email, and writes into the existing newsletter_subscribers table.
 *
 * Five buckets:
 *   - matched_active            beehiiv active + customer exists → active sub, customer_id set
 *   - matched_suppressed        beehiiv unsub + customer exists → unsubscribed sub, customer_id set
 *   - orphan_active             beehiiv active + no customer → active sub, customer_id NULL
 *   - orphan_suppressed         beehiiv unsub + no customer → unsubscribed sub, customer_id NULL
 *   - fresh_consent_protected   beehiiv says unsub but local row is active AND its source
 *                               indicates post-beehiiv consent (quote wizard, /subscribe, etc).
 *                               Guard skips the downgrade — local consent is fresher.
 *
 * The orphan_active bucket is the "in your orbit but never converted" list —
 * a lead pool Virginia can review for outreach. The fresh_consent_protected
 * bucket is the "guard saved us" audit trail — empty on first-run against a
 * clean table, non-empty signals that the script is running against data that
 * accumulated real opt-ins after the beehiiv export.
 *
 * Safety:
 *   - default is dry-run (prints buckets, writes no rows)
 *   - --apply commits the inserts/updates
 *   - never downgrades an existing 'active' row sourced from our own forms
 *     (see POST_BEEHIIV_CONSENT_SOURCES below) to 'unsubscribed' based on CSV
 *     state — those users re-opted in after leaving beehiiv
 *   - email comparisons are lowercase+trim on both sides
 *   - rows with no @ in the email are skipped (printed to `skipped_invalid_email`)
 *   - heuristic warning + interactive y/N prompt if the customers table has
 *     fewer than CSV_rows/10 rows (usually means DATABASE_URL is pointed at
 *     a dev/empty DB by accident). Non-TTY stdin auto-declines, so cron/CI
 *     runs fail closed instead of silently writing against the wrong DB.
 *   - report filename gets `-LOCAL` suffix and JSON gets `"environment":
 *     "local"` when DATABASE_URL points at localhost/127.0.0.1 — makes
 *     stray report files obviously-not-prod on inspection.
 *   - --apply against a localhost DATABASE_URL requires --apply-local too.
 *     Speed-bump on writes only; reads (dry-run) stay frictionless.
 *
 * A JSON report (per-row buckets + action taken) is written to the repo root
 * as `tmp-beehiiv-reconcile-<timestamp>[-LOCAL].json`.
 *
 * Usage:
 *   node server/scripts/migrate-beehiiv-subscribers.js path/to/beehiiv-export.csv                       # dry run
 *   node server/scripts/migrate-beehiiv-subscribers.js path/to/beehiiv-export.csv --apply               # commit (prod)
 *   node server/scripts/migrate-beehiiv-subscribers.js path/to/beehiiv-export.csv --apply --apply-local # commit (local)
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
const APPLY_LOCAL = process.argv.includes('--apply-local');
const csvPath = process.argv.slice(2).find((a) => !a.startsWith('--'));

// Environment detection — drives filename/JSON labeling (layer 2) and the
// --apply-local gate (layer 3). Intentionally loose regex so any form of
// loopback (localhost, 127.0.0.1, ::1) trips the guards.
const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_LOCAL_DB = /localhost|127\.0\.0\.1|\[::1\]/.test(DATABASE_URL);
const ENV_LABEL = IS_LOCAL_DB ? 'local' : 'remote';

// Source strings that mean "this row came from our own forms after the beehiiv
// era." Active rows from these sources are protected from the CSV-driven
// downgrade — their consent is fresher than anything the beehiiv export knows.
// Keep this list in sync with source values written by public-newsletter.js,
// public-quote.js, and any future customer-facing signup endpoint.
const POST_BEEHIIV_CONSENT_SOURCES = new Set([
  'quote_wizard',           // public-quote.js /calculate consent dual-write
  'quote_wizard_deferred',  // QuotePage.jsx result-other CTA
  'public_form',            // public-newsletter.js /subscribe default
  'website',                // newsletter.js legacy /subscribe default
  'public_subscribe',       // forward-looking
  'portal_signup',          // forward-looking
]);

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// Interactive y/N — used by the heuristic DB-mismatch guard (layer 1).
// Default No. Non-TTY stdin (cron, CI, piped invocations) auto-declines so
// the script fails closed instead of silently writing against the wrong DB.
function confirmYN(question) {
  if (!process.stdin.isTTY) {
    console.error('   (non-TTY stdin — auto-declining)');
    return Promise.resolve(false);
  }
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test((answer || '').trim()));
    });
  });
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

  // Guard: if the CSV says unsub but the local row is active AND sourced from
  // one of our own post-beehiiv forms, the local row is fresher consent. Skip
  // the downgrade and route the row into fresh_consent_protected so Virginia
  // has an audit trail of protected rows.
  const wouldDowngrade = !isActive && existing && existing.status === 'active';
  const hasFreshLocalConsent = existing && POST_BEEHIIV_CONSENT_SOURCES.has(existing.source);
  const guardProtects = wouldDowngrade && hasFreshLocalConsent;

  const naturalBucket = customer
    ? (isActive ? 'matched_active' : 'matched_suppressed')
    : (isActive ? 'orphan_active' : 'orphan_suppressed');
  const bucket = guardProtects ? 'fresh_consent_protected' : naturalBucket;

  if (!APPLY) {
    return {
      bucket,
      email: emailLc,
      hadCustomerMatch: !!customer,
      alreadyInList: !!existing,
      existingStatus: existing?.status || null,
      existingSource: existing?.source || null,
      action: guardProtects
        ? 'would_protect_fresh_consent'
        : existing
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

    // CSV-driven downgrade: flip active → unsubscribed, BUT only for rows
    // that weren't created by our own post-beehiiv signup paths. Those rows
    // represent consent captured after the beehiiv export was taken, so the
    // CSV's unsub state is stale by definition.
    if (wouldDowngrade && !hasFreshLocalConsent) {
      update.status = 'unsubscribed';
      update.unsubscribed_at = unsubscribedAt || new Date();
    }

    if (guardProtects) {
      return { bucket, email: emailLc, action: 'protected_fresh_consent', existingSource: existing.source };
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
      '  node server/scripts/migrate-beehiiv-subscribers.js <beehiiv-export.csv>                        # dry run\n' +
      '  node server/scripts/migrate-beehiiv-subscribers.js <beehiiv-export.csv> --apply                # commit (prod)\n' +
      '  node server/scripts/migrate-beehiiv-subscribers.js <beehiiv-export.csv> --apply --apply-local  # commit (local)\n'
    );
  }
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) fail(`CSV not found: ${abs}`);

  // Layer 3 — speed-bump on local-DB writes. Reads (dry-run) always allowed.
  if (APPLY && IS_LOCAL_DB && !APPLY_LOCAL) {
    fail(
      'Refusing to --apply against a localhost DATABASE_URL without --apply-local.\n' +
      '  If this is intentional (writing to a dev/test DB on purpose), re-run with:\n' +
      '    node server/scripts/migrate-beehiiv-subscribers.js <csv> --apply --apply-local'
    );
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  console.log(`\n[beehiiv-reconcile] Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`[beehiiv-reconcile] Environment: ${ENV_LABEL}`);
  console.log(`[beehiiv-reconcile] Source: ${abs}`);
  console.log(`[beehiiv-reconcile] Parsed ${rows.length} row(s)\n`);

  // Layer 1 — heuristic DB-mismatch warning. If the customers table is
  // absurdly small relative to the CSV, DATABASE_URL is probably pointing
  // at the wrong DB. Prompt before doing anything destructive. Threshold
  // is intentionally loose (1:10 ratio) — a true prod DB has hundreds to
  // thousands of customers; a dev DB has a handful.
  const { count: custCountRaw } = await db('customers').count('* as count').first();
  const customersTotal = Number(custCountRaw);
  if (rows.length >= 10 && customersTotal < rows.length / 10) {
    console.error(
      `\n⚠  DB mismatch warning: CSV has ${rows.length} rows but customers table has only ${customersTotal}.\n` +
      `   This usually means DATABASE_URL is pointing at a dev/local DB instead of prod.`
    );
    const ok = await confirmYN('   Proceed anyway? [y/N] ');
    if (!ok) fail('Aborted — DB mismatch not confirmed.');
  }

  const buckets = {
    matched_active: [],
    matched_suppressed: [],
    orphan_active: [],
    orphan_suppressed: [],
    fresh_consent_protected: [],
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

  const envSuffix = IS_LOCAL_DB ? '-LOCAL' : '';
  const reportPath = path.resolve(`tmp-beehiiv-reconcile-${Date.now()}${envSuffix}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    environment: ENV_LABEL,
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
