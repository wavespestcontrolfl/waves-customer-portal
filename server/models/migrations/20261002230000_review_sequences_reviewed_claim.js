/**
 * Review-ask "already posted" evidence (GATE_REVIEW_ASK_TECH_VOICE, owner
 * ruling 2026-10-01: a customer text saying they already left a review holds
 * the remaining asks).
 *
 *   reviewed_claim — { quote, at } from the customer's own text, written on
 *                    every open cadence of the customer when the claim is
 *                    confirmed. A cadence that stays open for a later private
 *                    check-in reads it before each ask (no second model call)
 *                    and the series-final guard counts it as engagement; a
 *                    temporary decision record would be overwritten.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (!(await knex.schema.hasColumn('review_sequences', 'reviewed_claim'))) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.jsonb('reviewed_claim').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (await knex.schema.hasColumn('review_sequences', 'reviewed_claim')) {
    await knex.schema.alterTable('review_sequences', (t) => { t.dropColumn('reviewed_claim'); });
  }
};
