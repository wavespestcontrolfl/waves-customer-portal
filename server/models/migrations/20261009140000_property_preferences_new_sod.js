/**
 * property_preferences: the new-sod record. Waves does not install sod; the
 * office records sod someone else laid, and lawn visits then hold some product
 * classes on the one standard lawn program while it roots
 * (server/services/lawn-sod-holds.js).
 *
 *   sod_laid_on   date         the calendar day the sod went down
 *   sod_covers    varchar(8)   'whole' | 'part'
 *   sod_area      varchar(120) the named area when part
 *   sod_rooted_on date         the day a technician confirmed "mowed twice, sod
 *                              does not lift" (written by a later change; stored
 *                              now so this migration is not re-cut)
 *
 * Additive, nullable, no default, no backfill, hasTable/hasColumn guarded. The
 * dates are plain `date` columns: a calendar fact read in America/New_York, so
 * there is no timezone to leak. The four columns are one fact about one home and
 * are set, cleared, kept or dropped together (NEW_SOD_COLUMNS).
 */
const TABLE = 'property_preferences';
const COVERS_CHECK = 'property_preferences_sod_covers_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const [hasLaid, hasCovers, hasArea, hasRooted] = await Promise.all(
    ['sod_laid_on', 'sod_covers', 'sod_area', 'sod_rooted_on'].map((c) => knex.schema.hasColumn(TABLE, c)),
  );
  if (!hasLaid || !hasCovers || !hasArea || !hasRooted) {
    await knex.schema.alterTable(TABLE, (t) => {
      if (!hasLaid) t.date('sod_laid_on').nullable();
      if (!hasCovers) t.string('sod_covers', 8).nullable();
      if (!hasArea) t.string('sod_area', 120).nullable();
      if (!hasRooted) t.date('sod_rooted_on').nullable();
    });
  }
  // NULL passes a CHECK, so no row needs a value. Dropped first so a re-run is safe.
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${COVERS_CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${COVERS_CHECK} CHECK (sod_covers IN ('whole', 'part'))`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${COVERS_CHECK}`);
  const present = [];
  for (const column of ['sod_rooted_on', 'sod_area', 'sod_covers', 'sod_laid_on']) {
    if (await knex.schema.hasColumn(TABLE, column)) present.push(column);
  }
  if (!present.length) return;
  await knex.schema.alterTable(TABLE, (t) => {
    for (const column of present) t.dropColumn(column);
  });
};
