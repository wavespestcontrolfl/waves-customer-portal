/**
 * Migration — widen referral_code columns from varchar(12) to varchar(20).
 *
 * The referral engine generates promoter codes as `WAVES-XXXXXXXX` (14 chars; up to
 * 18 on the rare 5x-collision fallback path) and stores them in
 * referral_promoters.referral_code, which is varchar(20). The same code is also written
 * to two other columns that were still varchar(12):
 *
 *   • customers.referral_code  — enrollPromoter() denormalizes the code here, so any
 *     never-enrolled customer who opened the Refer tab hit
 *     `value too long for type character varying(12)`:
 *         GET /api/referrals -> enrollPromoter() -> 500 Internal server error
 *
 *   • referrals.referral_code  — submitReferral() inserts promoter.referral_code here
 *     (server/services/referral-engine.js), so submitting a referral could 500 the
 *     same way.
 *
 * Widening both to varchar(20) matches referral_promoters and unblocks enrollment and
 * referral submission. Additive and safe — no existing data is truncated. Idempotent:
 * ALTER COLUMN TYPE to the same/compatible type is a harmless no-op on re-run.
 *
 * Found via the App Store reviewer demo account (a freshly-created customer) which took
 * the create-promoter path and surfaced the error in Sentry.
 */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE customers ALTER COLUMN referral_code TYPE varchar(20)');
  await knex.raw('ALTER TABLE referrals ALTER COLUMN referral_code TYPE varchar(20)');
};

exports.down = async function down(knex) {
  // Reverse to the prior width. Safe only while no stored referral_code exceeds 12
  // characters (post-deploy, generated codes are 14+, so a rollback would require
  // clearing/truncating those values first).
  await knex.raw('ALTER TABLE referrals ALTER COLUMN referral_code TYPE varchar(12)');
  await knex.raw('ALTER TABLE customers ALTER COLUMN referral_code TYPE varchar(12)');
};
