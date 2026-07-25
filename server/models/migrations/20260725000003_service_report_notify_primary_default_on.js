// notification_prefs.service_report_notify_primary flips to DEFAULT TRUE.
//
// Sibling of 20260725000001. Same bug, same shape:
// getServiceReportEmailRecipients only emailed the account holder while NO
// distinct on-location contact EMAIL existed (the `!recipients.length` safety
// net), so adding a contact email silently stopped the holder's own service
// reports.
//
// This path was MORE exposed than the appointment one: unlike
// getAppointmentContacts it never checked serviceContactsConsented, so it
// dropped the holder even on rows with no consent artifact. Three accounts were
// live in that state on 2026-07-24 (verified read-only) and are repaired by the
// companion backfill 20260725000004.
//
// Raw SET DEFAULT rather than knex `.alter()`: `.alter()` re-emits the whole
// column definition (type + nullability). Only the default is changing.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'service_report_notify_primary'))) return;
  await knex.raw('ALTER TABLE notification_prefs ALTER COLUMN service_report_notify_primary SET DEFAULT true');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'service_report_notify_primary'))) return;
  await knex.raw('ALTER TABLE notification_prefs ALTER COLUMN service_report_notify_primary SET DEFAULT false');
};
