/**
 * review_requests.email_leg_owed_at — a composer "Both" ask whose email
 * half is still owed and SAFE to attempt (GH Codex #3856 r8 P1/P2).
 *
 * Quick Links → Email after a Both whose email leg failed re-sends the
 * SAME inline row's email copy instead of a fresh ask the 30-day cooldown
 * would refuse. That retry path must only match asks that actually
 * requested an email leg — never a Text-only composer ask or a completion-
 * SMS ask — and never one whose email may already have reached the
 * provider. The claim stamps it (Both → claimed_at, otherwise null); a
 * real email send or an uncertain (post-dispatch) failure clears it.
 * Nullable — every existing row is null and matches nothing.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_requests'))) return;
  if (await knex.schema.hasColumn('review_requests', 'email_leg_owed_at')) return;
  await knex.schema.alterTable('review_requests', (t) => {
    t.timestamp('email_leg_owed_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_requests'))) return;
  if (!(await knex.schema.hasColumn('review_requests', 'email_leg_owed_at'))) return;
  await knex.schema.alterTable('review_requests', (t) => {
    t.dropColumn('email_leg_owed_at');
  });
};
