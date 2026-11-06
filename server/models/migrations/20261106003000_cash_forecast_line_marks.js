/**
 * Cash forecast step 2c: the owner's business or household mark for each repeating bill.
 *
 * The forecast finds a bill the bank feed shows about once a month (services/cash-forecast/engine.js
 * findRepeating) and names it by its merchant key, one or two words of capital letters ("ACME
 * CLOUD"). The owner marks each one business or household once (decision 2 A: "for labels"). A mark
 * is a label only: it never changes the forecast's numbers. Clearing a mark deletes its row.
 *
 * updated_by references technicians(id), like cash_forecast_settings.updated_by: the admin routes set
 * req.technicianId from the technicians table (middleware/admin-auth.js).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('cash_forecast_line_marks', (t) => {
    t.text('key').primary();
    t.text('mark').notNullable();
    t.uuid('updated_by').nullable().references('id').inTable('technicians');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE cash_forecast_line_marks
    ADD CONSTRAINT cash_forecast_line_marks_key_check CHECK (char_length(key) BETWEEN 2 AND 80),
    ADD CONSTRAINT cash_forecast_line_marks_mark_check CHECK (mark IN ('business','household'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('cash_forecast_line_marks');
};
