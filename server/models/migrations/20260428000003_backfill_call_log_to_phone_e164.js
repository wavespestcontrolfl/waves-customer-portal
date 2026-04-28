/**
 * One-time backfill: normalize call_log.to_phone to E.164.
 *
 * Background — admin-import-sheets.js historically inserted call_log
 * rows with to_phone copied straight from the Google Sheet column
 * ('9413187612', '(941) 318-7612', etc). lead_sources.twilio_phone_number
 * is seeded as '+19413187612', so the dashboard's calls-by-source JOIN
 * exact-string-matched only the Twilio-webhook rows and surfaced the
 * legacy rows under "Unmapped — 19413187612" alongside the real GBP —
 * Lakewood Ranch entry.
 *
 * PR #370 patched the JOIN to be regex-tolerant
 * (RIGHT(REGEXP_REPLACE(..., '\D', '', 'g'), 10)) and fixed the
 * importer to write E.164 going forward. This migration normalizes the
 * existing rows so a follow-up PR can revert the JOIN to a plain
 * equality match.
 *
 * Skipped rows:
 *   - to_phone IS NULL (no source number captured)
 *   - to_phone already starts with '+' (already E.164)
 *   - digit-stripped value < 10 chars (garbage / partial numbers; keep
 *     the original string for debugging rather than fabricate a fake)
 *
 * Intentionally non-destructive: down is a no-op because the original
 * raw strings are lost after up runs and no operator decision should
 * depend on getting them back.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) {
    // Table doesn't exist on this environment — older fixture DB,
    // disposable scratch — nothing to backfill.
    return;
  }

  const result = await knex.raw(`
    UPDATE call_log
    SET to_phone = '+1' || RIGHT(REGEXP_REPLACE(to_phone, '\\D', '', 'g'), 10)
    WHERE to_phone IS NOT NULL
      AND to_phone NOT LIKE '+%'
      AND LENGTH(REGEXP_REPLACE(to_phone, '\\D', '', 'g')) >= 10
  `);

  // pg returns rowCount on the underlying QueryResult; surface it in
  // the migration log so a deploy operator can sanity-check the count.
  // eslint-disable-next-line no-console
  console.log(`[backfill_call_log_to_phone_e164] normalized ${result?.rowCount ?? 0} row(s)`);
};

exports.down = async function down() {};
