/**
 * newsletter_sends.proof_refused_at — a DISTINCT durable marker that a proof
 * was sent and the owner's approval reply was then REFUSED (validation now
 * fails, the live event recheck failed, or the draft was edited after the
 * proof). The Pest Insider proof catch-up reads it to re-proof a corrected
 * draft after its day-10 cutoff.
 *
 * It cannot be borrowed from proof_approval_email_id: cancel-schedule and the
 * scheduler's revert-to-draft clear proof_approved_at but leave that id, so a
 * cancelled approved schedule would look like a refusal. Every writer that
 * clears proof_approved_at now clears proof_refused_at too; a fresh approval
 * clears it as well.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_sends'))) return;
  if (!(await knex.schema.hasColumn('newsletter_sends', 'proof_refused_at'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.timestamp('proof_refused_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('newsletter_sends'))) return;
  if (await knex.schema.hasColumn('newsletter_sends', 'proof_refused_at')) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.dropColumn('proof_refused_at');
    });
  }
};
