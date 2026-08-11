/**
 * rain_out_moved_custom_v1: dispatcher-authored Quick Move SMS.
 *
 * Owner direction (2026-08-11, from a real dispatch case where the property
 * limited vendor entry after 6 PM): the preset reason templates stay exactly
 * as they are, but some moves have a cause no preset covers. For those
 * the dispatcher picks the Custom reason and writes the FRONT of the text
 * themselves; the system supplies the move line + reschedule link at the
 * end. Hard requirement: the assembled SMS must fit 2 segments — commit()
 * renders this template pre-move and rejects a third segment.
 *
 * Rollout mirrors the v3 pattern (20260730600000): a NEW row, no
 * cross-version render hazard —
 *   - the code renders this rung only for reasonCode 'custom', which is
 *     itself dark until GATE_QUICKMOVE_CUSTOM_REASON is flipped;
 *   - an existing-but-disabled row is the ops kill switch: commit() rejects
 *     the custom move pre-commit (custom_message_unavailable) instead of
 *     silently moving the visit without the message that IS the reason;
 *   - a rolled-back migration (row absent) behaves the same way.
 * Admin copy edits made to this row after seeding are preserved (nothing
 * rewrites it).
 */

const TEMPLATE_KEY = 'rain_out_moved_custom_v1';

// GSM-7 only — a non-GSM char flips the whole message to UCS-2 and shrinks
// the 2-segment budget from 306 chars to 134, defeating the segment cap this
// rung ships with. House style for SMS dashes is the plain hyphen. Encoding
// is regression-tested in rain-out.test.js.
const BODY = "Hi {first_name} - {custom_message}\n\nWe've moved your {service_type} to {new_option}.{link_clause}";

const VARIABLES = ['first_name', 'custom_message', 'service_type', 'new_option', 'link_clause'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  const v3 = await knex('sms_templates').where({ template_key: 'rain_out_moved_v3' }).first('sort_order');

  await knex('sms_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Quick Move - Custom Message (Front) + New Time',
    category: 'service',
    body: BODY,
    variables: JSON.stringify(VARIABLES),
    sort_order: (v3?.sort_order ?? 11) + 1,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
};

// Exported for the GSM-7 encoding regression in rain-out.test.js.
exports._test = { BODY };
