/**
 * rain_out_customer_pick_v1: the Quick Move "let the customer pick a day" text
 * (GATE_QUICKMOVE_CUSTOMER_PICK, owner approved 2026-11-01).
 *
 * The office or the technician hands a recurring plan visit to the customer:
 * the visit leaves today's route and the customer gets this ONE text with their
 * /reschedule/:token link and the deadline to pick (8 PM ET the next day).
 * If they do not pick, Auto-Dispatch books the visit and the existing 72-hour
 * reminder tells them.
 *
 * Rollout mirrors the other Quick Move rows (20260730600000,
 * 20260811000020): a NEW row, inserted only when absent, and nothing rewrites
 * it later, so an admin copy edit stays.
 *   - the code renders this row only for a hand-off, which is itself dark
 *     until GATE_QUICKMOVE_CUSTOMER_PICK is flipped;
 *   - an existing-but-disabled row is the ops kill switch: the hand-off is
 *     refused before anything moves (the visit never leaves the route
 *     without its text);
 *   - a rolled-back migration (row absent) behaves the same way.
 *
 * GSM-7 only (plain hyphen, straight apostrophes): one non-GSM character
 * flips the whole message to UCS-2 and halves the 2-segment budget every
 * Quick Move text is held to. A representative render is 292 characters (two
 * segments); when a long name pushes a render past two segments, the send
 * drops the closing " Questions? Reply here." first. Both are tested in
 * rain-out-customer-pick.test.js.
 */

const TEMPLATE_KEY = 'rain_out_customer_pick_v1';

const BODY = "Hi {first_name} - {reason_lead}, so we need to move your {service_type}. Pick a new time here: {pick_url}\n\nPlease pick by {pick_by}. If we don't hear back, we'll book the best open time and text you. Questions? Reply here.";

const VARIABLES = ['first_name', 'reason_lead', 'service_type', 'pick_url', 'pick_by'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  const custom = await knex('sms_templates').where({ template_key: 'rain_out_moved_custom_v1' }).first('sort_order');

  await knex('sms_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Quick Move - Customer Picks a Day',
    category: 'service',
    body: BODY,
    variables: JSON.stringify(VARIABLES),
    sort_order: (custom?.sort_order ?? 12) + 1,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
};

// Exported for the GSM-7 encoding regression in rain-out-customer-pick.test.js.
exports._test = { BODY };
