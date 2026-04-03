/**
 * Enhance estimates table with view_token, estimate_text, sms_text, category, onboarding link
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.text('estimate_text');
    t.text('sms_text');
    t.enu('category', ['RESIDENTIAL', 'COMMERCIAL']).defaultTo('RESIDENTIAL');
    t.string('estimate_slug', 100);
    t.uuid('onboarding_session_id').references('id').inTable('onboarding_sessions');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('estimate_text');
    t.dropColumn('sms_text');
    t.dropColumn('category');
    t.dropColumn('estimate_slug');
    t.dropColumn('onboarding_session_id');
  });
};
