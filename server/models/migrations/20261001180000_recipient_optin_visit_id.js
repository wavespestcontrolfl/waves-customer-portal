/**
 * recipient_optin.visit_id — the booked visit an on-site opt-in ask is about
 * (#5467: the call pipeline asks the on-site person only once a confirmed
 * visit has landed). The undispatched-ask recovery sweep re-checks this visit
 * and re-sends the ask while it is still confirmed and ahead, or releases the
 * row to ask_failed once it is not. NULL for every portal / explicit-consent
 * ask. Additive and nullable; no backfill.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('recipient_optin', 'visit_id'))) {
    await knex.schema.alterTable('recipient_optin', (t) => {
      t.uuid('visit_id').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('recipient_optin', 'visit_id')) {
    await knex.schema.alterTable('recipient_optin', (t) => {
      t.dropColumn('visit_id');
    });
  }
};
