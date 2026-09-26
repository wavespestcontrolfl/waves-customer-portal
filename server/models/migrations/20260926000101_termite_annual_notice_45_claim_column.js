/**
 * Termite annual plan — renewal-notice ladder, slice 5 ("notice ladder").
 *
 * annual_prepay_terms.notice_45_claimed_at — the 15-minute claim column for
 * the 45-day rung (owner ruling §A2: 45 and 30 days before the cancellation
 * deadline, termite annual-plan terms only). notice_45_sent_at already
 * exists (20260924030001_termite_annual_plan_stamps.js) but nothing reads or
 * writes either column yet; this is the ONLY schema change the ladder needs
 * — the claim/witness pair matches notice_30_claimed_at / notice_30_sent_at
 * exactly (see 20260514000001_annual_prepay_terms.js), so
 * sendCustomerTermNotice's existing claim/release/mark-sent flow works for
 * 45 unchanged once noticeClaimColumnForDaysOut(45) resolves here.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_claimed_at')) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.timestamp('notice_45_claimed_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_claimed_at'))) return;
  await knex.schema.alterTable('annual_prepay_terms', (t) => {
    t.dropColumn('notice_45_claimed_at');
  });
};
