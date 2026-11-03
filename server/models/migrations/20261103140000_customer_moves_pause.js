'use strict';

/**
 * Moving PR 2b (owner Q4, 2026-11-02 "yes to all"; dark behind GATE_MOVING_PAUSE):
 * a customer who moves out before giving the new address has every plan at the
 * house left paused for up to 60 days, and gets one reminder text a week before
 * move-out (services/customer-moves.js, Move pause section).
 *  - pause_reminder_at: when the one reminder text was claimed (claimed before
 *    the send, so it goes at most once); pause_reminder_sent: whether the
 *    provider took it (NULL while unknown).
 *  - pause_state: 'paused' (the job stopped the old house's plans) or 'office'
 *    (it could not, and handed the pause to the office once); paused_at: when;
 *    pause_ends_on: the last day of a 'paused' move (move-out + 60);
 *    pause_note: what the office is told for an 'office' move.
 *  - closed_reason gains 'pause_expired': no new address by pause_ends_on.
 *  - sms_templates gains moving_address_reminder (guarded insert), GSM-7,
 *    two segments at most with the unshortened link.
 */
const KEY = 'moving_address_reminder';
// House layout (20261006220000): "Hi {first_name}," then the fact, a blank
// line, and the link behind a short label; "Waves" once; transactional to a
// customer, so no STOP line (docs/sms-stop-line-policy.md).
const BODY = 'Hi {first_name}, you move out on {move_out_date}. We pause your Waves visits after that until we have your new address.\n\nAdd it here: {moving_link}';
const OLD_REASONS = "('applied', 'cancelled', 'out_of_area')";
const NEW_REASONS = "('applied', 'cancelled', 'out_of_area', 'pause_expired')";

exports.up = async function up(knex) {
  await knex.schema.alterTable('customer_moves', (t) => {
    t.timestamp('pause_reminder_at', { useTz: true }).nullable();
    t.boolean('pause_reminder_sent').nullable();
    t.string('pause_state', 16).nullable();
    t.timestamp('paused_at', { useTz: true }).nullable();
    t.date('pause_ends_on').nullable();
    t.string('pause_note', 300).nullable();
  });
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_pause_state_check
    CHECK (pause_state IS NULL OR pause_state IN ('paused', 'office'))`);
  await knex.raw('ALTER TABLE customer_moves DROP CONSTRAINT IF EXISTS customer_moves_closed_reason_check');
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_closed_reason_check
    CHECK (closed_reason IS NULL OR closed_reason IN ${NEW_REASONS})`);

  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  const existing = await knex('sms_templates').where({ template_key: KEY }).first('id');
  if (existing) return;
  const row = { template_key: KEY, name: 'Moving: Address Reminder (a week before move-out)', body: BODY };
  if (cols.category) row.category = 'automations';
  if (cols.variables) row.variables = JSON.stringify(['first_name', 'move_out_date', 'moving_link']);
  if (cols.is_active) row.is_active = true;
  if (cols.created_at) row.created_at = new Date();
  if (cols.updated_at) row.updated_at = new Date();
  await knex('sms_templates').insert(row);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: KEY, body: BODY }).del();
  }
  await knex('customer_moves').where({ closed_reason: 'pause_expired' }).update({ closed_reason: 'cancelled' });
  await knex.raw('ALTER TABLE customer_moves DROP CONSTRAINT IF EXISTS customer_moves_closed_reason_check');
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_closed_reason_check
    CHECK (closed_reason IS NULL OR closed_reason IN ${OLD_REASONS})`);
  await knex.raw('ALTER TABLE customer_moves DROP CONSTRAINT IF EXISTS customer_moves_pause_state_check');
  await knex.schema.alterTable('customer_moves', (t) => {
    t.dropColumn('pause_reminder_at');
    t.dropColumn('pause_reminder_sent');
    t.dropColumn('pause_state');
    t.dropColumn('paused_at');
    t.dropColumn('pause_ends_on');
    t.dropColumn('pause_note');
  });
};

exports._copy = { KEY, BODY };
