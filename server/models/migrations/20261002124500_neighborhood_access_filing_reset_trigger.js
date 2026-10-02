/**
 * Clear a customer's neighborhood_access_filings row the moment their saved
 * neighborhood gate code changes — at write time, by every writer (office,
 * portal, call, text, Intelligence Bar, any added later), with no hook in each.
 *
 * The 15-minute sweep only sees the current value, so an A → blank → A (or
 * A → B → A) edit between two passes looked like no change: the old ledger row
 * still matched and a directory entry the office retired in the meantime was
 * never filed again. With this trigger the ledger row is gone after any real
 * change, and the next pass files the current value.
 *
 * "Real change" compares the CANONICAL value (trimmed; a keypad code with its
 * inner whitespace removed — the form fileNeighborhoodCode files and
 * VALUE_HASH_SQL in services/neighborhood-access.js hashes), so a formatting-only
 * resave ("#1234" → "# 1234") and an unrelated preference edit leave the row.
 * The expression is inlined (a migration must not import code that may change).
 * No "?" anywhere: knex reads one in raw SQL as a binding.
 */

const canonical = (col) => {
  const trimmed = `regexp_replace(${col}, '^\\s+|\\s+$', '', 'g')`;
  return `CASE WHEN ${trimmed} ~ '^[#*]{0,1}\\s*\\d{3,8}\\s*[#*]{0,1}$'
    THEN regexp_replace(${trimmed}, '\\s+', '', 'g') ELSE ${trimmed} END`;
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access_filings'))) return;
  await knex.raw(`
    CREATE OR REPLACE FUNCTION neighborhood_access_filing_reset() RETURNS trigger AS $$
    BEGIN
      -- Each side parenthesized: a bare CASE after IF is read as a plpgsql CASE statement.
      IF (${canonical('OLD.neighborhood_gate_code')}) IS DISTINCT FROM (${canonical('NEW.neighborhood_gate_code')}) THEN
        DELETE FROM neighborhood_access_filings WHERE customer_id = NEW.customer_id;
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);
  await knex.raw('DROP TRIGGER IF EXISTS neighborhood_access_filing_reset ON property_preferences');
  await knex.raw(`
    CREATE TRIGGER neighborhood_access_filing_reset
    AFTER UPDATE OF neighborhood_gate_code ON property_preferences
    FOR EACH ROW EXECUTE FUNCTION neighborhood_access_filing_reset()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS neighborhood_access_filing_reset ON property_preferences');
  await knex.raw('DROP FUNCTION IF EXISTS neighborhood_access_filing_reset()');
};
