// Book at the Table (GATE_IN_PERSON_CARD, owner 2026-11-02): a card request minted
// for a customer at the table whose estimate staff accepted with no recorded terms
// is marked here. While the flag is set and the terms are not recorded, the secure
// page asks the customer to accept the estimate terms and the card save and the
// annual-prepay choice are refused server-side (409 terms_required).
// Additive and idempotent; rows that never get the flag (every texted request) stay
// false and behave exactly as before.
const TABLE = 'appointment_card_requests';
const COLUMN = 'in_person_terms_required';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.boolean(COLUMN).notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN);
  });
};
