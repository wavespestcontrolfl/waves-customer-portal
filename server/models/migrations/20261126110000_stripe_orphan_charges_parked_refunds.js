/**
 * stripe_orphan_charges.parked_refunds (production share PR 3a): the identity of every refund the statement webhook parks on one row.
 * A statement charge's pre-settlement partial refund is parked under the bare PaymentIntent with ON CONFLICT DO NOTHING, so a SECOND partial
 * refund left no trace on the row and no signal could tell them apart. The webhook now appends { refundId, cents } to this jsonb list on
 * conflict (same row, same key, same resolution flow). NULL = a row written before this column (or by another writer): its refunds cannot be told
 * apart, which the production share keeps treating as "unclear" (production-share-refunds.js).
 */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE stripe_orphan_charges ADD COLUMN IF NOT EXISTS parked_refunds jsonb NULL');
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE stripe_orphan_charges DROP COLUMN IF EXISTS parked_refunds');
};
