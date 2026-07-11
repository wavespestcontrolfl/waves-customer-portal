/**
 * referral_promoters.merged_into_promoter_id — code-alias support for
 * customer merges.
 *
 * When a duplicate customer with its own referral enrollment merges away,
 * the loser's /r/:code links are already in the wild (SMS/email invites).
 * Deleting the row would strand them: the public resolver looks promoters up
 * by referral_code and only attributes clicks/rewards on that path. Instead,
 * the merge keeps the loser row as a RETIRED ALIAS — customer_id nulled (the
 * portal loads one promoter per customer via .first()), status 'merged',
 * balances folded into the winner — and this column points the resolver at
 * the surviving promoter so in-flight invites keep earning credit there.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('referral_promoters'))) return;
  if (await knex.schema.hasColumn('referral_promoters', 'merged_into_promoter_id')) return;
  await knex.schema.alterTable('referral_promoters', (t) => {
    t.integer('merged_into_promoter_id').nullable();
    t.index('merged_into_promoter_id');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('referral_promoters'))) return;
  if (!(await knex.schema.hasColumn('referral_promoters', 'merged_into_promoter_id'))) return;
  await knex.schema.alterTable('referral_promoters', (t) => {
    t.dropColumn('merged_into_promoter_id');
  });
};
