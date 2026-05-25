exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE data_hygiene_proposals
      DROP CONSTRAINT IF EXISTS data_hygiene_proposals_status_check
  `);
  await knex.raw(`
    ALTER TABLE data_hygiene_proposals
      ADD CONSTRAINT data_hygiene_proposals_status_check
      CHECK (status IN ('pending','auto_applied','approved','rejected','superseded','stale','reverted'))
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE data_hygiene_proposals
      DROP CONSTRAINT IF EXISTS data_hygiene_proposals_status_check
  `);
  await knex.raw(`
    ALTER TABLE data_hygiene_proposals
      ADD CONSTRAINT data_hygiene_proposals_status_check
      CHECK (status IN ('pending','auto_applied','approved','rejected','superseded','stale'))
  `);
};
