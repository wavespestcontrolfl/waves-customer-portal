'use strict';

const TABLE = 'email_messages';
const COLUMN = 'provider_handoff_attempt_token';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, (table) => table.string(COLUMN).nullable());
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (table) => table.dropColumn(COLUMN));
};
