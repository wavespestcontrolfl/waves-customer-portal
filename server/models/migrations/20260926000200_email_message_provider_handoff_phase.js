'use strict';

const TABLE = 'email_messages';
const COLUMN = 'provider_handoff_phase';
const CONSTRAINT = 'email_messages_provider_handoff_phase_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.string(COLUMN, 16).nullable();
    });
  }
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${CONSTRAINT}'
          AND conrelid = '${TABLE}'::regclass
      ) THEN
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT ${CONSTRAINT}
          CHECK (${COLUMN} IS NULL OR ${COLUMN} IN ('pending', 'started', 'rejected'));
      END IF;
    END $$
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn(COLUMN);
    });
  }
};
