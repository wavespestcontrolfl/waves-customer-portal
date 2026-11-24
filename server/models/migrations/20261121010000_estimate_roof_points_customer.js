'use strict';

/**
 * estimate_roof_points.customer_id: who a frozen roof points copy is for (owner ruling 2026-11-20, choice 4A).
 * The send writes the customer who holds the estimate at that send (null = the estimate had none). The customer page
 * shows the copy only while the estimate has that same holder, so a copy frozen for a lead, or for customer A, is never
 * shown to a customer the estimate gets later; the next send freezes a copy for that customer.
 *   - ON DELETE CASCADE: a deleted customer's copies go with the customer, so null only ever means "frozen for no
 *     customer". A duplicate merge repoints the column with every other customer_id (customer-dedupe.js).
 *   - A copy written before this column exists reads as "frozen for no customer": it is not shown on an estimate that
 *     has a customer until the next send. The table ships in the same release, so production has no such row.
 * Additive and idempotent; the down drops the column.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('estimate_roof_points', 'customer_id')) return;
  await knex.schema.alterTable('estimate_roof_points', (table) => {
    table.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('CASCADE');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('estimate_roof_points', 'customer_id'))) return;
  await knex.schema.alterTable('estimate_roof_points', (table) => {
    table.dropColumn('customer_id');
  });
};
