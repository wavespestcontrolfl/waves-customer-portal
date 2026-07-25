// notification_prefs.appointment_notify_primary flips to DEFAULT TRUE.
//
// Why: 20260506000002 created it `defaultTo(false)` — opt-IN. That default
// failed silently. getAppointmentContacts only texts the account holder when
// no on-location contact is named (the `!contacts.length` safety net), so the
// moment someone named a spouse, the holder dropped off appointment texts with
// no signal to them or to the owner. Five real accounts hit it by 2026-07-24.
// The holder is always a legitimate recipient of their own appointment info, so
// inclusion is now the default and only an EXPLICIT false opts them out.
//
// SCOPE — this migration changes the default for FUTURE rows only. Verified
// against prod 2026-07-24: 1139 rows are an explicit `false`, 8 are `true`,
// ZERO are NULL. So nothing about existing customers changes on deploy, and
// the 1139 `false` rows REMAIN EXPOSED to the original trap — the moment one of
// them adds an on-location contact, that stored false drops the holder again.
//
// Those 1139 are almost certainly the old default rather than deliberate
// opt-outs (no account carrying a `false` has any on-location contact, so the
// value has never had an observable effect for them — the `!contacts.length`
// safety net texted them regardless). A backfill to true would therefore be a
// no-op today AND would disarm the landmine, but it is a 1139-row write to live
// customer rows, so it is the owner's call and is deliberately NOT done here.
// Raw SET DEFAULT rather than knex's `.alter()`: `.alter()` re-emits the whole
// column definition (type + nullability) and would DROP NOT NULL if anyone adds
// it later. Only the default is changing here, so change only the default.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'appointment_notify_primary'))) return;
  await knex.raw('ALTER TABLE notification_prefs ALTER COLUMN appointment_notify_primary SET DEFAULT true');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'appointment_notify_primary'))) return;
  await knex.raw('ALTER TABLE notification_prefs ALTER COLUMN appointment_notify_primary SET DEFAULT false');
};
