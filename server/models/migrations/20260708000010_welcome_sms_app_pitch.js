'use strict';

/**
 * Welcome SMS (auto_new_recurring): point the account-management pitch at the
 * app page — wavespestcontrol.com/app — instead of the raw portal URL. The
 * /app page carries both store badges AND the web-portal link, so one URL
 * serves phone and desktop; transactional links elsewhere are untouched
 * (universal links, #2496, make those open the installed app at the OS level).
 *
 * Targeted sentence swap, not a wholesale overwrite: only the exact seeded
 * pitch sentence (20260516000011) is replaced, so an admin-edited body — or
 * the STOP line the 20260706000010 normalization appended — passes through
 * untouched. Variant bodies override the base at render (getTemplate prefers
 * variant.body), so variants get the same swap. down() reverses it.
 */

const OLD_PITCH = 'You can also manage your account at portal.wavespestcontrol.com to view your upcoming appointments, reschedule services, request re-services, view invoices, and more.';
// GSM-7 only (no em-dash/smart quotes) — one non-GSM char re-encodes the whole
// message as UCS-2 and doubles the segment count.
const NEW_PITCH = 'Manage everything in the free Waves app: upcoming visits, live tech tracking, easy rescheduling, invoices, and more. Get it at wavespestcontrol.com/app';

async function swapPitch(knex, from, to) {
  const now = new Date();

  if (await knex.schema.hasTable('sms_templates')) {
    const row = await knex('sms_templates')
      .where({ template_key: 'auto_new_recurring' })
      .first();
    if (row && typeof row.body === 'string' && row.body.includes(from)) {
      await knex('sms_templates')
        .where({ id: row.id })
        .update({ body: row.body.split(from).join(to), updated_at: now });
    }
  }

  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants')
      .where({ template_key: 'auto_new_recurring' })
      .select('id', 'body');
    for (const variant of variants) {
      if (typeof variant.body === 'string' && variant.body.includes(from)) {
        await knex('sms_template_variants')
          .where({ id: variant.id })
          .update({ body: variant.body.split(from).join(to), updated_at: now });
      }
    }
  }

  if (await knex.schema.hasTable('automation_templates')) {
    const automation = await knex('automation_templates')
      .where({ key: 'new_recurring' })
      .first();
    if (automation && typeof automation.sms_template === 'string' && automation.sms_template.includes(from)) {
      const cols = await knex('automation_templates').columnInfo();
      const update = { sms_template: automation.sms_template.split(from).join(to) };
      if (cols.updated_at) update.updated_at = now;
      await knex('automation_templates').where({ key: 'new_recurring' }).update(update);
    }
  }
}

exports.up = async function up(knex) {
  await swapPitch(knex, OLD_PITCH, NEW_PITCH);
};

exports.down = async function down(knex) {
  await swapPitch(knex, NEW_PITCH, OLD_PITCH);
};

exports.OLD_PITCH = OLD_PITCH;
exports.NEW_PITCH = NEW_PITCH;
