/**
 * Re-key neighborhood_access_filings on the CANONICAL value — the value as
 * fileNeighborhoodCode files it: trimmed, and for a keypad code (digits with
 * an optional leading/trailing # or *) with its inner whitespace removed.
 *
 * 20261002110000 seeded the ledger hashing btrim(value) and matched an
 * existing entry by EITHER form, so a resaved "# 1234" read as a new value
 * (and could re-file a code the office retired as "#1234"), and an
 * instruction like "12 34" was recorded as filed against keypad 1234 although
 * no instruction row exists. The sweep now hashes the canonical value; this:
 *   1. rehashes every ledger row that recorded the customer's CURRENT value
 *      (the old hash of today's value) to its canonical hash;
 *   2. deletes a current-value row whose neighborhood holds no entry for that
 *      value in its own form (keypad → code, instruction → instructions), so
 *      the sweep files it properly.
 * Rows for an older value are left alone: they already differ from the
 * current value and the sweep picks those customers up anyway.
 *
 * The expressions are inlined (a migration must not import code that may
 * change later) and mirror VALUE_HASH_SQL in services/neighborhood-access.js.
 * No "?" anywhere: knex reads one in raw SQL as a binding.
 *
 * down() is a documented no-op: the old hashes are not worth restoring, and
 * 20261002100000's down() drops the table.
 */

const TRIMMED = "regexp_replace(pp.neighborhood_gate_code, '^\\s+|\\s+$', '', 'g')";
const IS_KEYPAD = `${TRIMMED} ~ '^[#*]{0,1}\\s*\\d{3,8}\\s*[#*]{0,1}$'`;
const CANONICAL = `CASE WHEN ${IS_KEYPAD} THEN regexp_replace(${TRIMMED}, '\\s+', '', 'g') ELSE ${TRIMMED} END`;
const sha = (expr) => `encode(sha256(convert_to(${expr}, 'UTF8')), 'hex')`;
const OLD_HASH = sha('btrim(pp.neighborhood_gate_code)');
const NEW_HASH = sha(CANONICAL);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access_filings'))) return;
  await knex.raw(`
    UPDATE neighborhood_access_filings f
    SET value_hash = ${NEW_HASH}
    FROM property_preferences pp
    WHERE pp.customer_id = f.customer_id
      AND btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''
      AND f.value_hash = ${OLD_HASH}
  `);
  await knex.raw(`
    DELETE FROM neighborhood_access_filings f
    USING property_preferences pp
    WHERE pp.customer_id = f.customer_id
      AND btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''
      AND f.value_hash = ${NEW_HASH}
      AND f.neighborhood_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM neighborhood_access a
        WHERE a.neighborhood_id = f.neighborhood_id
          AND CASE WHEN ${IS_KEYPAD}
                   THEN lower(a.code) = lower(${CANONICAL})
                   ELSE a.instructions = ${TRIMMED} END
      )
  `);
};

exports.down = async function down() {
  // No-op by design — see the header.
};
