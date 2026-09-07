/**
 * Per-tech Twilio line (Field Team Program, Phase 0 item 3).
 *
 * `technicians.twilio_number` holds the E.164 of the registry line
 * (server/config/twilio-numbers.js `fieldTech`) a technician answers on.
 * One line belongs to at most one technician — the partial unique index is
 * the DB fence behind the Team tab's in-transaction check. Nullable: most
 * rows (office staff, placeholders) never get a line.
 */
const INDEX = 'technicians_twilio_number_unique';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'twilio_number'))) {
    await knex.schema.alterTable('technicians', (t) => {
      t.string('twilio_number', 20).nullable();
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON technicians (twilio_number) WHERE twilio_number IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  if (await knex.schema.hasColumn('technicians', 'twilio_number')) {
    await knex.schema.alterTable('technicians', (t) => {
      t.dropColumn('twilio_number');
    });
  }
};
