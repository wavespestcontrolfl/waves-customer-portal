/**
 * Allow service_records.status = 'incomplete' for completion-first visits
 * that need an office handoff without customer invoice/SMS/review side effects.
 */

exports.up = async function (knex) {
  await knex.raw(
    'ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_status_check'
  );
  await knex.raw(`
    ALTER TABLE service_records
      ADD CONSTRAINT service_records_status_check
      CHECK (status IN ('scheduled','in_progress','completed','cancelled','incomplete'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(
    'ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_status_check'
  );
  await knex.raw(`
    ALTER TABLE service_records
      ADD CONSTRAINT service_records_status_check
      CHECK (status IN ('scheduled','in_progress','completed','cancelled'))
  `);
};
