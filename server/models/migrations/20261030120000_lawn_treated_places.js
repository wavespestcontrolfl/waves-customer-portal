/**
 * Several places for one spot treatment (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-30: "the front, back, left, right,
 * cant this be multiple selections").
 *
 * One spray that went on the Front and the Back is ONE application, recorded once, at both places. Splitting it into a row
 * per place would make the yearly count read it as two applications (the count reads ledger rows, and a lawn-wide read has no
 * place filter), so the row keeps ONE row and names its places.
 *
 *   service_products.treated_places             varchar(24)[], nullable. The closed-list places (lawn-trouble-areas
 *   property_application_history.treated_places PLACES) the application went on, the first one picked first. NULL = no
 *                                               place on record: the row counts at EVERY place of its lawn, as before.
 *
 * treated_place (20261009110000) stays and is still written, as the FIRST of treated_places, so a reader that still reads
 * it keeps working. A row written before this migration carries a place only in treated_place: up() backfills
 * treated_places = ARRAY[treated_place] for those rows. The readers switch to treated_places, and read a row that has only
 * treated_place (written by a server that still runs the old code during a deploy) as that one place.
 *
 * The closed list is checked by the code, as for treated_place (those tables are large and shared).
 *
 * down() drops the two columns. They hold nothing a prior version read that treated_place does not: its first place.
 */
const TABLES = ['service_products', 'property_application_history'];

exports.up = async function up(knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'treated_places'))) {
      await knex.raw('ALTER TABLE ?? ADD COLUMN treated_places varchar(24)[]', [table]);
    }
    if (await knex.schema.hasColumn(table, 'treated_place')) {
      await knex.raw('UPDATE ?? SET treated_places = ARRAY[treated_place] WHERE treated_place IS NOT NULL AND treated_places IS NULL', [table]);
    }
  }
};

exports.down = async function down(knex) {
  for (const table of TABLES) {
    if ((await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, 'treated_places'))) {
      await knex.raw('ALTER TABLE ?? DROP COLUMN treated_places', [table]);
    }
  }
};
