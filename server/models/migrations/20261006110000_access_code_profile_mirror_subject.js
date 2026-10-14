/**
 * Access codes, one list: the mirror's receipt is derived state the sweep
 * rebuilds from the profile at any time. Its customer column is renamed
 * `subject_id` and loses its foreign key, so the schema-driven customer merge
 * (and its undo) never moves, folds or journals it: a merge or an undo changes
 * the profile, and the next sweep re-mirrors from what is there. (20261006100000
 * is frozen.) The rows are dropped here so every customer is mirrored afresh.
 */

exports.up = async function up(knex) {
  await knex.raw('DELETE FROM access_code_profile_mirror');
  await knex.raw('ALTER TABLE access_code_profile_mirror DROP CONSTRAINT IF EXISTS access_code_profile_mirror_customer_id_foreign');
  await knex.raw(`DO $$ DECLARE c text; BEGIN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'access_code_profile_mirror'::regclass AND contype = 'f' LOOP
      EXECUTE format('ALTER TABLE access_code_profile_mirror DROP CONSTRAINT %I', c);
    END LOOP; END $$`);
  await knex.raw('ALTER TABLE access_code_profile_mirror RENAME COLUMN customer_id TO subject_id');
};

exports.down = async function down(knex) {
  await knex.raw('DELETE FROM access_code_profile_mirror');
  await knex.raw('ALTER TABLE access_code_profile_mirror RENAME COLUMN subject_id TO customer_id');
  await knex.raw('ALTER TABLE access_code_profile_mirror ADD CONSTRAINT access_code_profile_mirror_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE');
};
