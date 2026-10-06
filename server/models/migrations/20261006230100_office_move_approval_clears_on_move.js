/**
 * Any change to a visit's date or start clears its office move approval
 * (codex P1 #6039 r1). Matching the stored instant alone let an approval
 * revive when a visit moved away and later came back to the same start.
 * The approval belongs to the one start the office approved, once.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION clear_office_move_approval_on_move() RETURNS trigger AS $$
    BEGIN
      NEW.office_move_approved_for := NULL;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_clear_office_move_approval ON scheduled_services');
  await knex.raw(`
    CREATE TRIGGER scheduled_services_clear_office_move_approval
      BEFORE UPDATE OF scheduled_date, window_start ON scheduled_services
      FOR EACH ROW
      WHEN (OLD.office_move_approved_for IS NOT NULL
        AND (OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
          OR OLD.window_start IS DISTINCT FROM NEW.window_start))
      EXECUTE FUNCTION clear_office_move_approval_on_move()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS scheduled_services_clear_office_move_approval ON scheduled_services');
  await knex.raw('DROP FUNCTION IF EXISTS clear_office_move_approval_on_move()');
};
