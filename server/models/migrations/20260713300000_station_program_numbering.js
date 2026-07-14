/**
 * Per-program station numbering (station-map rodent generalization).
 *
 * termite_stations gains rodent rows (program='rodent' — exterior rodent
 * bait stations, the sibling of the termite map). Station numbers must be
 * per-PROGRAM so a property reads "termite stations 1–14" and "rodent
 * stations 1–8", not one interleaved sequence: the unique moves from
 * (customer_id, station_number) to (customer_id, program, station_number).
 *
 * Data-safe by construction: existing rows were unique per customer, so
 * they are trivially unique per (customer, program). Numbers still never
 * reuse within a program (allocation spans retired rows, unchanged).
 */

async function constraintExists(knex, name) {
  const row = await knex('pg_constraint').where({ conname: name }).first('conname');
  return Boolean(row);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) return;
  if (await constraintExists(knex, 'termite_stations_customer_id_station_number_unique')) {
    await knex.schema.alterTable('termite_stations', (t) => {
      t.dropUnique(['customer_id', 'station_number'], 'termite_stations_customer_id_station_number_unique');
    });
  }
  if (!(await constraintExists(knex, 'termite_stations_customer_id_program_station_number_unique'))) {
    await knex.schema.alterTable('termite_stations', (t) => {
      t.unique(['customer_id', 'program', 'station_number'], {
        indexName: 'termite_stations_customer_id_program_station_number_unique',
      });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) return;
  if (await constraintExists(knex, 'termite_stations_customer_id_program_station_number_unique')) {
    await knex.schema.alterTable('termite_stations', (t) => {
      t.dropUnique(['customer_id', 'program', 'station_number'], 'termite_stations_customer_id_program_station_number_unique');
    });
  }
  // NOTE: down re-tightens to the original per-customer unique — valid only
  // while no customer carries both programs (true before this migration
  // ships; a post-rollback dataset with rodent rows would need renumbering
  // first, which is the standard down-migration data caveat).
  if (!(await constraintExists(knex, 'termite_stations_customer_id_station_number_unique'))) {
    await knex.schema.alterTable('termite_stations', (t) => {
      t.unique(['customer_id', 'station_number'], {
        indexName: 'termite_stations_customer_id_station_number_unique',
      });
    });
  }
};
