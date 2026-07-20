// Backfill scheduled_services.appointment_type for rows created before the
// series generators stamped it at insert (#2901). The tag was only ever
// written by AppointmentTagger's post-insert hook on parent bookings, so
// series siblings, boosters, auto-extends, and alert extends landed NULL —
// 1,034 of 1,460 prod rows (71%) as of 2026-07-20.
//
// Pure column UPDATE through the SAME classifier live bookings use (single
// source of truth — no duplicated rules). Fires no side effects: prep/welcome
// automations live in the tagger hook, which this migration deliberately does
// not call. Idempotent — only NULL rows are touched, so a re-run or a row
// tagged organically between deploys is left alone. updated_at is left
// untouched on purpose (a backfill is not an edit).
//
// Expected prod distribution (read-only dry run 2026-07-20): 1,034 rows —
// pest_general 786, lawn 107, general 88 (legacy Square-era labels fall back
// to 'general' exactly as the live classifier would), tree_shrub 21,
// termite_treatment 15, wdo_inspection 10, bed_bug 3, mosquito 3, cockroach 1.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'appointment_type'))) return;

  const tagger = require('../../services/appointment-tagger');

  const rows = await knex('scheduled_services')
    .whereNull('appointment_type')
    .distinct('service_type');

  const typesByTag = new Map();
  for (const { service_type: serviceType } of rows) {
    const { tag } = tagger.classifyAppointmentType(serviceType);
    if (!typesByTag.has(tag)) typesByTag.set(tag, []);
    typesByTag.get(tag).push(serviceType);
  }

  for (const [tag, serviceTypes] of typesByTag) {
    const named = serviceTypes.filter((t) => t != null);
    if (named.length) {
      await knex('scheduled_services')
        .whereNull('appointment_type')
        .whereIn('service_type', named)
        .update({ appointment_type: tag });
    }
    if (serviceTypes.some((t) => t == null)) {
      await knex('scheduled_services')
        .whereNull('appointment_type')
        .whereNull('service_type')
        .update({ appointment_type: tag });
    }
  }
};

// Irreversible by design: after the backfill there is no way to tell a
// backfilled tag from one the tagger stamped organically, and reverting
// would re-open the NULL gap #2901 closed going forward. No-op.
exports.down = async function down() {};
