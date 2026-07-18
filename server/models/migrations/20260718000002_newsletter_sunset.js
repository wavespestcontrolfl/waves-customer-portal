/**
 * Newsletter inactivity sunset — hygiene columns on newsletter_subscribers
 * (newsletter-sunset.js weekly job, dark behind GATE_NEWSLETTER_SUNSET).
 *
 *   reengagement_flagged_at — stamped when the job tags a subscriber
 *     'reengagement_due' (90d of zero opens/clicks/quiz answers across ≥6
 *     delivered campaigns); cleared when they engage again or resubscribe.
 *   deactivated_at / deactivated_reason — stamped when the job flips
 *     status to 'inactive' after the win-back grace window passes with no
 *     engagement. status is a plain string column on this table (no CHECK
 *     constraint), so the new value needs no constraint change.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  const hasFlagged = await knex.schema.hasColumn('newsletter_subscribers', 'reengagement_flagged_at');
  if (!hasFlagged) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.timestamp('reengagement_flagged_at');
      t.timestamp('deactivated_at');
      t.string('deactivated_reason');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  const hasFlagged = await knex.schema.hasColumn('newsletter_subscribers', 'reengagement_flagged_at');
  if (hasFlagged) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.dropColumn('reengagement_flagged_at');
      t.dropColumn('deactivated_at');
      t.dropColumn('deactivated_reason');
    });
  }
};
