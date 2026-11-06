/**
 * Cash forecast inputs: the numbers the owner types for the 13-week cash forecast.
 *
 * cash_forecast_items holds planned money going out that no ledger shows yet: insurance, health
 * cover, a tax set-aside, ads, a card payoff plan, a hire. Each row has an amount in cents, how
 * often it repeats (once, weekly, biweekly, monthly), a first date and an optional last date.
 * A removed item is set inactive, never deleted, so an earlier forecast can be explained.
 *
 * cash_forecast_settings holds exactly one row (id = 1): the lowest cash balance the owner wants
 * to stay above (floor_cents, NULL until the owner sets it, so the forecast never invents a floor) and
 * last year's receipts by month (last_year_receipts, keys "YYYY-MM", values whole cents), which
 * the forecast uses to shape the season.
 *
 * entered_by / updated_by reference technicians(id): the admin routes set req.technicianId from
 * the technicians table (middleware/admin-auth.js), the same as payroll_simple_ira_elections.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('cash_forecast_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('kind').notNullable();
    t.text('label').notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.text('cadence').notNullable();
    t.date('first_date').notNullable();
    t.date('last_date').nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.uuid('entered_by').nullable().references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE cash_forecast_items
    ADD CONSTRAINT cash_forecast_items_kind_check CHECK (kind IN ('insurance','health','tax_account','ads','card_payoff','hire','other')),
    ADD CONSTRAINT cash_forecast_items_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
    ADD CONSTRAINT cash_forecast_items_amount_check CHECK (amount_cents > 0 AND amount_cents <= 100000000),
    ADD CONSTRAINT cash_forecast_items_cadence_check CHECK (cadence IN ('once','weekly','biweekly','monthly')),
    ADD CONSTRAINT cash_forecast_items_dates_check CHECK (last_date IS NULL OR last_date >= first_date)`);

  await knex.schema.createTable('cash_forecast_settings', (t) => {
    t.specificType('id', 'smallint').primary().defaultTo(1);
    t.bigInteger('floor_cents').nullable();
    t.jsonb('last_year_receipts').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.uuid('updated_by').nullable().references('id').inTable('technicians');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE cash_forecast_settings
    ADD CONSTRAINT cash_forecast_settings_single_row_check CHECK (id = 1),
    ADD CONSTRAINT cash_forecast_settings_floor_check CHECK (floor_cents IS NULL OR (floor_cents >= 0 AND floor_cents <= 100000000)),
    ADD CONSTRAINT cash_forecast_settings_receipts_check CHECK (jsonb_typeof(last_year_receipts) = 'object')`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('cash_forecast_settings');
  await knex.schema.dropTableIfExists('cash_forecast_items');
};
