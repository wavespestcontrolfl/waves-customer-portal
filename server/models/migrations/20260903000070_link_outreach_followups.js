/**
 * Backlink Manager v2 — step 4 PR 3b: the outreach FOLLOW-UP (plan §6.4).
 *
 * One follow-up per placement, ever, +10 days after the initial pitch and only
 * if no reply. It is modelled on its OWN columns of seo_link_prospects — the
 * conversation lifecycle is carried by the outreach columns, never by `status`
 * (the Judge owns `status` from `placed` onward, and the initial send left the
 * row `contacted`):
 *
 *   follow_up_status       none → due → drafted → sending → sent
 *                          (send_error = ambiguous, reconciled like the first
 *                          send; skipped = a reply / bounce arrived, or the
 *                          worker declined)
 *   follow_up_due_at       initial send + 10d, stamped by the send finalize
 *   follow_up_subject/body the drafted follow-up (the recipient is the thread's
 *                          — outreach_to_email — never a second address)
 *   follow_up_send_token   the follow-up's own idempotency claim
 *   follow_up_attempted_at stamped at claim time; counted by dailySendCount
 *                          exactly like outreach_attempted_at, so a follow-up
 *                          consumes the policy cap and the hard cap
 *   follow_up_sent_at      Gmail confirmed the follow-up
 *   follow_up_skipped_reason  why a follow-up was skipped (reply / bounce /
 *                          worker note)
 *
 * Additive and reversible. No backfill: rows sent before this migration carry
 * no due date and never grow a follow-up (their silence is the owner's read).
 */
const TABLE = 'seo_link_prospects';
const CHECK = 'seo_link_prospects_follow_up_status_check';
const FOLLOW_UP_STATUSES = ['none', 'due', 'drafted', 'sending', 'sent', 'send_error', 'skipped'];

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn(TABLE, 'follow_up_status')) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.string('follow_up_status').notNullable().defaultTo('none');
    t.timestamp('follow_up_due_at');
    t.text('follow_up_subject');
    t.text('follow_up_body');
    t.text('follow_up_send_token');
    t.timestamp('follow_up_attempted_at');
    t.timestamp('follow_up_sent_at');
    t.text('follow_up_skipped_reason');
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (follow_up_status IN (${FOLLOW_UP_STATUSES.map((v) => `'${v}'`).join(', ')}))`);
  // the due sweep (the drafter's follow-up claim) and the cap count read these
  await knex.raw(`CREATE INDEX IF NOT EXISTS seo_link_prospects_follow_up_due_idx ON ${TABLE} (follow_up_status, follow_up_due_at)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn(TABLE, 'follow_up_status'))) return;
  await knex.raw(`DROP INDEX IF EXISTS seo_link_prospects_follow_up_due_idx`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('follow_up_status');
    t.dropColumn('follow_up_due_at');
    t.dropColumn('follow_up_subject');
    t.dropColumn('follow_up_body');
    t.dropColumn('follow_up_send_token');
    t.dropColumn('follow_up_attempted_at');
    t.dropColumn('follow_up_sent_at');
    t.dropColumn('follow_up_skipped_reason');
  });
};
