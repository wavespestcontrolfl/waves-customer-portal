/**
 * Supersedes 20260928020000_sms_preview_photo_content_signature.js — that
 * migration cannot be edited, renamed, or deleted (already pushed; the
 * preview database already ran it, and Railway tracks by filename per
 * waves-db SKILL.md §4). The MMS-thumbnail feature that was going to read
 * and write `photo_content_signature` was pulled out of
 * feat/report-photos-20260928 (owner decision 2026-09-28 — six pre-push
 * rounds kept finding new facets of it, and it drew scope away from the
 * actual ask, photos in the report STORY). Nothing in this codebase reads
 * or writes the column any more (verified: `git grep -n
 * photo_content_signature -- server client` hits only the old migration and
 * this one). Rather than touch the frozen file, this drops the now-unused
 * column outright, reversibly.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_report_notification_assets'))) return;
  if (!(await knex.schema.hasColumn('service_report_notification_assets', 'photo_content_signature'))) return;
  await knex.schema.alterTable('service_report_notification_assets', (t) => {
    t.dropColumn('photo_content_signature');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_report_notification_assets'))) return;
  if (await knex.schema.hasColumn('service_report_notification_assets', 'photo_content_signature')) return;
  await knex.schema.alterTable('service_report_notification_assets', (t) => {
    t.text('photo_content_signature');
  });
};
