/**
 * Accept-card phone capture (owner 2026-10-04): provenance of a phone the
 * CUSTOMER typed on the estimate page (PUT /api/estimates/:token/contact-phone).
 *
 * estimates.customer_phone_typed (varchar 20) — the E.164 number that route
 * wrote to estimates.customer_phone, stored beside it in the same UPDATE.
 * Null on every estimate whose phone the office supplied. A typed phone proves
 * nothing about who typed it, so the accept phone matcher
 * (matchAcceptCustomerByPhone) never resolves it to an existing customer:
 * while customer_phone still equals customer_phone_typed (last ten digits),
 * any candidate is a contradiction and the accept is parked for the office.
 *
 * A column, not a key in estimate_data: several public routes rewrite that
 * whole blob from a pre-read snapshot (/preferences, /select-tier, /bond),
 * and a provenance stamp stored there could be overwritten while
 * customer_phone stayed. No reader or writer of estimate_data touches this.
 *
 * Additive, nullable, hasTable/hasColumn-guarded. No backfill: every existing
 * phone was supplied by the office.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (await knex.schema.hasColumn('estimates', 'customer_phone_typed')) return;
  await knex.schema.alterTable('estimates', (t) => {
    t.string('customer_phone_typed', 20);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (!(await knex.schema.hasColumn('estimates', 'customer_phone_typed'))) return;
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('customer_phone_typed');
  });
};
