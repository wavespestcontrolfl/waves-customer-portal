/**
 * Technician and vehicle cost cards (L11a, owner rulings 2026-10-26: "we need
 * real actual calculation, this ($35) was a number I just thought").
 *
 * Two effective-dated tables. A card is never updated in place; a change is a
 * new row (a trigger refuses UPDATE). The card in effect on a date is the row
 * with the greatest effective_date <= that date, tie: newest created_at, then
 * id (the company_financials rule). Before the first card there is no card.
 *
 * technician_cost_cards: what one technician costs the company per worked
 * hour. kind 'w2' works the cost up from technicians.pay_rate (wages, employer
 * taxes, health money, retirement, workers' comp, paid days off); kind
 * 'imputed' states an hourly rate directly (an owner who draws no wage).
 * vehicle_equipment_id names the vehicle the technician drives.
 *
 * vehicle_cost_cards: the yearly fixed cost of one vehicle (equipment row) and
 * its cost per mile.
 *
 * Nothing reads these tables unless GATE_TECH_COST_RATES is on (job-costing.js
 * and /api/admin/cost-cards). Additive: no existing row or column changes.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('technician_cost_cards', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.date('effective_date').notNullable();
    t.text('kind').notNullable();
    t.decimal('imputed_hourly_rate', 10, 2).nullable();
    t.decimal('paid_hours_per_week', 5, 2).notNullable().defaultTo(40);
    t.decimal('paid_hours_per_day', 4, 2).notNullable().defaultTo(10);
    t.decimal('health_money_monthly', 10, 2).notNullable().defaultTo(0);
    t.decimal('retirement_pct', 5, 2).notNullable().defaultTo(0);
    t.decimal('workers_comp_pct', 5, 2).notNullable().defaultTo(0);
    t.decimal('paid_days_off_per_year', 5, 1).notNullable().defaultTo(0);
    t.uuid('vehicle_equipment_id').nullable().references('id').inTable('equipment').onDelete('RESTRICT');
    t.text('note').nullable();
    t.uuid('created_by').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['technician_id', 'effective_date'], 'technician_cost_cards_tech_date_idx');
  });
  await knex.raw(`ALTER TABLE technician_cost_cards
    ADD CONSTRAINT technician_cost_cards_kind_check CHECK (kind IN ('w2', 'imputed')),
    ADD CONSTRAINT technician_cost_cards_imputed_check CHECK (
      (kind <> 'imputed' OR (imputed_hourly_rate IS NOT NULL AND imputed_hourly_rate > 0))
      AND (imputed_hourly_rate IS NULL OR (imputed_hourly_rate >= 0 AND imputed_hourly_rate <= 1000))),
    ADD CONSTRAINT technician_cost_cards_hours_week_check CHECK (paid_hours_per_week > 0 AND paid_hours_per_week <= 168),
    ADD CONSTRAINT technician_cost_cards_hours_day_check CHECK (paid_hours_per_day > 0 AND paid_hours_per_day <= 24),
    ADD CONSTRAINT technician_cost_cards_health_check CHECK (health_money_monthly >= 0 AND health_money_monthly <= 100000),
    ADD CONSTRAINT technician_cost_cards_retirement_check CHECK (retirement_pct >= 0 AND retirement_pct <= 100),
    ADD CONSTRAINT technician_cost_cards_workers_comp_check CHECK (workers_comp_pct >= 0 AND workers_comp_pct <= 100),
    ADD CONSTRAINT technician_cost_cards_days_off_check CHECK (paid_days_off_per_year >= 0 AND paid_days_off_per_year <= 120),
    ADD CONSTRAINT technician_cost_cards_note_check CHECK (note IS NULL OR char_length(note) <= 500)`);

  await knex.schema.createTable('vehicle_cost_cards', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('equipment_id').notNullable().references('id').inTable('equipment').onDelete('RESTRICT');
    t.date('effective_date').notNullable();
    t.decimal('loss_of_value_per_year', 10, 2).notNullable().defaultTo(0);
    t.decimal('insurance_per_year', 10, 2).notNullable().defaultTo(0);
    t.decimal('loan_interest_per_year', 10, 2).notNullable().defaultTo(0);
    t.decimal('other_fixed_per_year', 10, 2).notNullable().defaultTo(0);
    t.decimal('fuel_per_mile', 6, 4).notNullable().defaultTo(0);
    t.decimal('upkeep_per_mile', 6, 4).notNullable().defaultTo(0);
    t.text('note').nullable();
    t.uuid('created_by').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['equipment_id', 'effective_date'], 'vehicle_cost_cards_equipment_date_idx');
  });
  await knex.raw(`ALTER TABLE vehicle_cost_cards
    ADD CONSTRAINT vehicle_cost_cards_amounts_check CHECK (
      loss_of_value_per_year >= 0 AND insurance_per_year >= 0 AND loan_interest_per_year >= 0
      AND other_fixed_per_year >= 0 AND fuel_per_mile >= 0 AND upkeep_per_mile >= 0),
    ADD CONSTRAINT vehicle_cost_cards_note_check CHECK (note IS NULL OR char_length(note) <= 500)`);

  // A card is history: a change is a new row, never an UPDATE.
  await knex.raw(`CREATE FUNCTION refuse_cost_card_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'cost cards are never changed in place; add a new card';
    END;
    $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER technician_cost_cards_no_update BEFORE UPDATE ON technician_cost_cards
    FOR EACH ROW EXECUTE FUNCTION refuse_cost_card_update()`);
  await knex.raw(`CREATE TRIGGER vehicle_cost_cards_no_update BEFORE UPDATE ON vehicle_cost_cards
    FOR EACH ROW EXECUTE FUNCTION refuse_cost_card_update()`);
};

exports.down = async function down(knex) {
  // Cards the owner entered are cost evidence: preserve them and roll forward.
  for (const table of ['technician_cost_cards', 'vehicle_cost_cards']) {
    if (await knex.schema.hasTable(table) && await knex(table).first('id')) {
      throw new Error(`${table} holds cards. Preserve the schema and roll forward; do not delete it.`);
    }
  }
  await knex.schema.dropTableIfExists('vehicle_cost_cards');
  await knex.schema.dropTableIfExists('technician_cost_cards');
  await knex.raw('DROP FUNCTION IF EXISTS refuse_cost_card_update()');
};
