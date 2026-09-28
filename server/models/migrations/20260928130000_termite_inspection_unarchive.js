/**
 * Follow-up to 20260928110000 (frozen once pushed): activating the Termite
 * Inspection Service must also un-archive it. The service listing and the
 * scheduling dropdown both exclude archived rows (service-library.js), so an
 * archived row stays unbookable even when is_active is true.
 *
 * down() is a no-op: this is a catalog data correction, and a rollback must
 * never undo later catalog administration.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('services', 'is_archived'))) return;
  await knex('services')
    .where({ service_key: 'termite_inspection', is_active: true })
    .update({ is_archived: false, updated_at: new Date() });
};

exports.down = async function () {};
