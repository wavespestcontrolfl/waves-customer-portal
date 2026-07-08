'use strict';

/**
 * Add email support to referral_invites so the new email referral invite
 * (POST /api/referrals/invite-email) can cooldown-dedupe the same way the
 * SMS invite does today. The table was phone-only (20260415000022); an
 * email invite carries no phone, so:
 *   1. `phone` becomes nullable (email invites store email, not phone).
 *   2. a nullable `email` column + a matching (promoter_id, email, sent_at)
 *      index back the 24h cooldown lookup.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('referral_invites'))) return;

  const hasEmail = await knex.schema.hasColumn('referral_invites', 'email');
  await knex.schema.alterTable('referral_invites', (t) => {
    // Email invites have no phone; SMS invites keep writing it.
    t.string('phone', 32).nullable().alter();
    if (!hasEmail) {
      t.string('email', 254).nullable();
      t.index(['promoter_id', 'email', 'sent_at'], 'idx_referral_invites_promoter_email_time');
    }
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('referral_invites'))) return;
  const hasEmail = await knex.schema.hasColumn('referral_invites', 'email');
  await knex.schema.alterTable('referral_invites', (t) => {
    if (hasEmail) {
      t.dropIndex(['promoter_id', 'email', 'sent_at'], 'idx_referral_invites_promoter_email_time');
      t.dropColumn('email');
    }
    // Leave `phone` nullable on the way down — any email-invite rows would
    // violate a NOT NULL restore, and nullability is a harmless superset.
  });
};
