/**
 * Seed neighborhood_access_filings from what the PR 1 backfill already filed,
 * before the sweep (GATE_NEIGHBORHOOD_ACCESS) first runs.
 *
 * The ledger (20261002100000) started empty, so a first sweep would treat every
 * coded customer as unfiled; fileNeighborhoodCode ignores retired entries, so a
 * code the office retired after the backfill would be filed again as active.
 * Here, a customer whose ONE active property is linked to a neighborhood that
 * already holds an entry for their current value — any status, retired
 * included, keypad or instruction — is recorded as filed for that value. The
 * hash is the same SQL expression the sweep uses (never the code itself).
 *
 * down() is a documented no-op: the rows are the ledger's own record of
 * existing filings, and 20261002100000's down() drops the table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access_filings'))) return;
  await knex.raw(`
    INSERT INTO neighborhood_access_filings (customer_id, value_hash, neighborhood_id, outcome)
    SELECT pp.customer_id,
           encode(sha256(convert_to(btrim(pp.neighborhood_gate_code), 'UTF8')), 'hex'),
           p.neighborhood_id,
           'filed'
    FROM property_preferences pp
    JOIN customers c ON c.id = pp.customer_id AND c.deleted_at IS NULL
    JOIN customer_properties p ON p.customer_id = pp.customer_id AND p.active
    WHERE btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''
      AND p.neighborhood_id IS NOT NULL
      AND (SELECT count(*) FROM customer_properties p2 WHERE p2.customer_id = pp.customer_id AND p2.active) = 1
      AND EXISTS (
        SELECT 1 FROM neighborhood_access a
        WHERE a.neighborhood_id = p.neighborhood_id
          AND (lower(a.code) = lower(regexp_replace(btrim(pp.neighborhood_gate_code), '\\s+', '', 'g'))
               OR a.instructions = btrim(pp.neighborhood_gate_code))
      )
    ON CONFLICT (customer_id) DO NOTHING
  `);
};

exports.down = async function down() {
  // No-op by design — see the header.
};
