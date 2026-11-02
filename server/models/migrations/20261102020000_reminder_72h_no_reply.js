/**
 * reminder_72h_no_reply_v1: the 72-hour reminder for a visit Auto-Dispatch
 * booked after the customer did not pick a day (Quick Move "let the customer
 * pick a day", GATE_QUICKMOVE_CUSTOMER_PICK, owner approved 2026-11-01).
 *
 * The hand-off text asked the customer to pick by 8 PM ET the next day. If
 * they did not, Auto-Dispatch placed the visit (it stamps
 * last_auto_dispatch_at later than customer_pick_by) and the 72-hour reminder
 * now says "we didn't hear back, so we scheduled it" instead of the plain
 * "your visit is ..." line. appointment-reminders.js picks this row only for
 * that case and falls back to reminder_72h when the row is missing, disabled
 * or does not render, so the condition is inert until a hand-off creates such
 * a visit.
 *
 * Same declared variables as reminder_72h (including {time}, which the sender
 * passes for admin edits), and a body ending with
 * {reschedule_line}{card_hold_policy_line} (the card-hold fee disclosure rides
 * on every held-booking reminder). For this row the sender puts "Want a
 * different time? " in front of the reschedule line, only when a link exists.
 *
 * Insert-if-absent: nothing rewrites it later, so an admin copy edit stays.
 * GSM-7 only (plain hyphen, straight apostrophe): one non-GSM character flips
 * the whole message to UCS-2 and halves the segment budget.
 */

const TEMPLATE_KEY = 'reminder_72h_no_reply_v1';
const BASE_KEY = 'reminder_72h';

const BODY = "Hi {first_name}, we didn't hear back, so we scheduled your Waves {service_type} for {day}, {date}, {window}.\n\n{reschedule_line}{card_hold_policy_line}";

const VARIABLES = ['first_name', 'service_type', 'day', 'date', 'time', 'window', 'reschedule_line', 'card_hold_policy_line'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  const base = await knex('sms_templates').where({ template_key: BASE_KEY }).first('category', 'sort_order');

  await knex('sms_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Reminder 72h - We Booked It (No Pick)',
    category: base?.category || 'service',
    body: BODY,
    variables: JSON.stringify(VARIABLES),
    sort_order: (base?.sort_order ?? 0) + 1,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
};

// Exported for the GSM-7 and render regressions in reminder-72h-no-reply.test.js.
exports._test = { BODY, VARIABLES };
