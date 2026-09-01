/**
 * spam-block-orphan-filter-sweep.js — MUTATES (dry-run by default)
 *
 * Deletes the Gmail auto-trash filters that the blocked_email_senders
 * dedupe migration (20260831000040) recorded in
 * blocked_email_senders_dedupe_orphans: losing duplicate rows carried their
 * own gmail_filter_id, and a migration cannot call the Gmail API — so the
 * filters stay active but unreachable by every unblock path until this
 * sweep removes them (GH r18 P1 on #3648). A filter Gmail reports 404 for
 * is already gone and just gets stamped.
 *
 * Dry run prints exactly which ledger rows / filter ids would be cleaned.
 * `--execute` deletes each filter via the server's gmail-client and stamps
 * cleaned_at. Idempotent: cleaned rows are never re-processed.
 *
 * Run from the repo root (needs the server's env for DB + Gmail auth):
 *   node ops/agents/spam-block-orphan-filter-sweep.js [--execute]
 */

const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const db = require('../../server/models/db');
  const hasLedger = await db.schema.hasTable('blocked_email_senders_dedupe_orphans');
  if (!hasLedger) {
    console.log('No blocked_email_senders_dedupe_orphans table — the dedupe migration has not run here. Nothing to do.');
    return 0;
  }
  const rows = await db('blocked_email_senders_dedupe_orphans').whereNull('cleaned_at').orderBy('recorded_at');
  if (!rows.length) {
    console.log('Ledger clean — no orphaned Gmail filters awaiting cleanup.');
    return 0;
  }
  console.log(`${rows.length} orphaned filter(s) awaiting cleanup${EXECUTE ? '' : ' (DRY RUN — pass --execute to delete them)'}:`);
  for (const r of rows) {
    // Scope only — never print full addresses beyond what the operator
    // needs to recognize the entry (these are spam senders, not customers).
    const scope = r.email_address ? `sender ${r.email_address}` : `domain @${r.domain}`;
    console.log(`  filter ${r.gmail_filter_id} (${scope}, recorded ${r.recorded_at?.toISOString?.() || r.recorded_at})`);
    if (!EXECUTE) continue;
    try {
      const gmailClient = require('../../server/services/email/gmail-client');
      const auth = await gmailClient.getAuthClient();
      if (!auth) {
        console.log('    SKIP — Gmail auth unavailable; rerun when it is.');
        continue;
      }
      const { google } = require('googleapis');
      const gmail = google.gmail({ version: 'v1', auth });
      try {
        await gmail.users.settings.filters.delete({ userId: 'me', id: r.gmail_filter_id });
        console.log('    deleted');
      } catch (err) {
        if (err && (err.code === 404 || err.status === 404)) {
          console.log('    already gone (404) — stamping cleaned');
        } else {
          console.log(`    FAILED: ${err.message} — left in the ledger for a rerun`);
          continue;
        }
      }
      await db('blocked_email_senders_dedupe_orphans').where({ id: r.id }).update({ cleaned_at: new Date() });
    } catch (err) {
      console.log(`    FAILED: ${err.message} — left in the ledger for a rerun`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error(err.message); process.exit(1); });
