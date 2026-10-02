/**
 * neighborhood_access_filings — the gate-code filing sweep's ledger (gate-code
 * directory PR 2). One row per customer: a hash of the neighborhood gate code
 * value it last filed (never the code itself) and where it went.
 *
 * The sweep files a customer only when their current code hashes differently
 * from this row (or there is no row), so:
 *  - a save is never missed because its transaction committed after a pass
 *    started (no time watermark to fall behind);
 *  - an unrelated preference edit (pets, irrigation) is not "new evidence", so
 *    a code the office retired is never filed again from a profile that still
 *    holds it;
 *  - a filing that could not finish (county lookup failed, no pin yet, more
 *    than one property) writes no row and is simply retried next pass.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('neighborhood_access_filings')) return;
  await knex.schema.createTable('neighborhood_access_filings', (t) => {
    t.uuid('customer_id').primary().references('id').inTable('customers').onDelete('CASCADE');
    t.string('value_hash', 64).notNullable(); // sha256 hex of the trimmed code value
    t.uuid('neighborhood_id').references('id').inTable('neighborhoods').onDelete('SET NULL');
    t.string('outcome', 20).notNullable(); // filed | duplicate | filed_conflict
    t.timestamp('filed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('neighborhood_access_filings');
};
