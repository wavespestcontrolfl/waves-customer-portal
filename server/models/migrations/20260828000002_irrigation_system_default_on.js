/**
 * Irrigation ON by default (owner ruling 2026-08-27).
 *
 * The portal's "Irrigation system" toggle is retired; the portal presents
 * every property as irrigated and stamps irrigation_system = true on any
 * irrigation write. Only the column DEFAULT moves here — no row is rewritten.
 *
 * Why no backfill: the column defaulted to false, so a stored false is
 * indistinguishable from a deliberate "off" set through the old toggle —
 * and that toggle never cleared the schedule fields, so "has irrigation
 * inputs" does not prove the system is on either (GH codex P0 on #3557: a
 * customer who entered a schedule and then chose off would be flipped back
 * with no way to undo it). The lawn report and Monday email keep honouring a
 * stored false (derived figure suppressed; the email's system-off ask routes
 * the customer to reply to us). A legacy-false row heals itself the first
 * time the customer edits anything under Irrigation — the route stamps true
 * — which is the customer affirming the system, not a guess.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_system'))) return;
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT true');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_system'))) return;
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT false');
};
