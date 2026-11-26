/**
 * call_sound_check_spend — what each call sound check attempt reserved and then cost (services/call-sound-check.js),
 * one row per claim. The daily spend cap sums this table, not call_log: a call row can be deleted (a call marked
 * spam is), and the money Google already billed for it must still count toward its ET day. No foreign key on
 * purpose, for the same reason. Estimates from the portal's price table, not Google's bill.
 */

const TABLE = 'call_sound_check_spend';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.bigIncrements('id').primary();
    t.uuid('call_id').notNullable();
    t.date('day').notNullable();
    t.decimal('reserved_usd', 12, 6).notNullable();
    t.decimal('spent_usd', 12, 6);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('settled_at', { useTz: true });
    t.index(['day']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
