/**
 * recipient_optin.followup_armed_at — when a later booking re-armed an
 * already-confirmed on-site contact's follow-up on its visit
 * (recipient-optin rearmOnSiteFollowUp). The follow-up's 14-day retry cap runs
 * from this instead of the original YES. Additive and nullable; NULL = the
 * follow-up belongs to the YES itself.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('recipient_optin', 'followup_armed_at'))) {
    await knex.schema.alterTable('recipient_optin', (t) => {
      t.timestamp('followup_armed_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('recipient_optin', 'followup_armed_at')) {
    await knex.schema.alterTable('recipient_optin', (t) => {
      t.dropColumn('followup_armed_at');
    });
  }
};
