/**
 * Property-lookup attempt lifecycle (owner ruling 2026-08-11, unit-scope
 * guardrails PR1): every lookup ATTEMPT stamps the property_lookups row —
 * status 'pending' at start, a segmentable outcome at the end (resolved /
 * no_parcel / no_record / geocode_failed / incomplete_address /
 * new_construction_suspected / provider_timeout / unit_not_matched /
 * multiple_unit_matches). Before this, a lookup that failed ahead of
 * saveLookup left no row at all, so the unresolved population could not be
 * counted or segmented by failure reason.
 *
 * Attempt columns only — cached-data semantics (property_record,
 * expires_at, verified_overrides) are untouched, and a stamp-only stub row
 * still reads as a cache miss (getCachedLookup requires property_record).
 * Status stays an unconstrained varchar: the writer whitelists values, and
 * a CHECK would turn each future lane's new status into a migration.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('property_lookups');
  if (!hasTable) return;
  const addColumn = async (name, build) => {
    const has = await knex.schema.hasColumn('property_lookups', name);
    if (has) return;
    await knex.schema.alterTable('property_lookups', build);
  };
  await addColumn('last_attempt_at', (t) => t.timestamp('last_attempt_at', { useTz: true }).nullable());
  await addColumn('last_attempt_status', (t) => t.string('last_attempt_status', 40).nullable());
  await addColumn('last_attempt_reason', (t) => t.string('last_attempt_reason', 250).nullable());
  await addColumn('attempt_count', (t) => t.integer('attempt_count').notNullable().defaultTo(0));
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('property_lookups');
  if (!hasTable) return;
  const dropColumn = async (name) => {
    const has = await knex.schema.hasColumn('property_lookups', name);
    if (!has) return;
    await knex.schema.alterTable('property_lookups', (t) => t.dropColumn(name));
  };
  await dropColumn('last_attempt_at');
  await dropColumn('last_attempt_status');
  await dropColumn('last_attempt_reason');
  await dropColumn('attempt_count');
};
