/**
 * Owner token for the campaign 'sending' claim (Codex P1, PR #2840 r2).
 *
 * The stale-claim lease frees a 'sending' row whose updated_at stops moving,
 * but the ORIGINAL worker may merely be stuck in one slow SendGrid request —
 * it wakes up after recovery reclaims the row and both workers mail the same
 * outstanding recipients. Every claim (first send, resume, stale reclaim)
 * now stamps its own sending_claim_token; the per-chunk heartbeat doubles as
 * an ownership check, so a worker that lost its claim stops before mailing
 * another chunk instead of racing the new owner.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('newsletter_sends', 'sending_claim_token');
  if (!hasCol) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.uuid('sending_claim_token');
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('newsletter_sends', 'sending_claim_token');
  if (hasCol) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.dropColumn('sending_claim_token');
    });
  }
};
