'use strict';

/**
 * Embed the self-serve reschedule link in the appointment confirmation, 72h,
 * and 24h reminder texts via a {reschedule_line} clause variable (mirroring
 * tech_en_route's {track_clause}): the sender passes the whole rendered
 * clause — "Need a different time? Reschedule online: <short link>\n\n" — or
 * '' when no link could be minted, so the copy stays clean either way.
 *
 * Admin-edit preservation: the body is only rewritten when it still matches
 * the last-seeded copy (20260514000002). An admin-customized body is left
 * untouched — only the variables list gains 'reschedule_line' so the admin
 * template editor surfaces the new variable for them to place themselves.
 */

const UPDATES = [
  {
    template_key: 'appointment_confirmation',
    seededBody: 'Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\nQuestions or need to reschedule? Reply here.',
    newBody: 'Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\n{reschedule_line}Questions? Reply here.',
    variables: ['first_name', 'service_type', 'date', 'time', 'reschedule_line'],
  },
  {
    template_key: 'reminder_72h',
    seededBody: 'Hello {first_name}! Reminder: your {service_type} with Waves is scheduled for {day} at {time}. Your technician will arrive within a two-hour window of the start time.\n\nNeed to reschedule? Visit portal.wavespestcontrol.com or reply here.',
    newBody: 'Hello {first_name}! Reminder: your {service_type} with Waves is scheduled for {day} at {time}. Your technician will arrive within a two-hour window of the start time.\n\n{reschedule_line}Questions? Reply here.',
    variables: ['first_name', 'service_type', 'day', 'time', 'reschedule_line'],
  },
  {
    template_key: 'reminder_24h',
    seededBody: 'Hello {first_name}! Reminder: your {service_type} with Waves is tomorrow at {time}. Your technician will arrive within a two-hour window and text when 15 minutes out.\n\nQuestions or need to reschedule? Reply here.',
    newBody: 'Hello {first_name}! Reminder: your {service_type} with Waves is tomorrow at {time}. Your technician will arrive within a two-hour window and text when 15 minutes out.\n\n{reschedule_line}Questions? Reply here.',
    variables: ['first_name', 'service_type', 'time', 'reschedule_line'],
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();

  for (const u of UPDATES) {
    const existing = await knex('sms_templates')
      .where({ template_key: u.template_key })
      .first();
    if (!existing) continue;

    const patch = { variables: JSON.stringify(u.variables) };
    if (existing.body === u.seededBody) patch.body = u.newBody;
    if (cols.updated_at) patch.updated_at = new Date();

    await knex('sms_templates').where({ template_key: u.template_key }).update(patch);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();

  for (const u of UPDATES) {
    const existing = await knex('sms_templates')
      .where({ template_key: u.template_key })
      .first();
    if (!existing) continue;

    const patch = {
      variables: JSON.stringify(u.variables.filter((v) => v !== 'reschedule_line')),
    };
    if (existing.body === u.newBody) patch.body = u.seededBody;
    if (cols.updated_at) patch.updated_at = new Date();

    await knex('sms_templates').where({ template_key: u.template_key }).update(patch);
  }
};

exports.UPDATES = UPDATES;
