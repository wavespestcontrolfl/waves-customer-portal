/**
 * Migration 070 — Mileage Log (Bouncie GPS integration)
 *
 * Creates the mileage_log table for IRS mileage deduction tracking.
 * Also adds reminder_sent_at to tax_filing_calendar for deadline alerting.
 */
exports.up = async function (knex) {

  // ── Mileage Log ───────────────────────────────────────────────
  await knex.schema.createTable('mileage_log', t => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('vehicle_id', 100);           // Bouncie vehicle IMEI
    t.string('vehicle_name', 100);
    t.date('trip_date').notNullable();
    t.text('start_address');
    t.text('end_address');
    t.decimal('distance_miles', 8, 2).notNullable();
    t.integer('duration_minutes');
    t.string('purpose', 20).defaultTo('business');  // business / personal / commute
    t.decimal('irs_rate', 6, 4).defaultTo(0.70);
    t.decimal('deduction_amount', 8, 2);             // distance_miles * irs_rate
    t.string('bouncie_trip_id', 100).unique();        // for dedup
    t.string('source', 20).defaultTo('bouncie');      // bouncie / manual
    t.text('notes');
    t.timestamps(true, true);

    t.index('trip_date');
    t.index('vehicle_id');
    t.index('purpose');
  });

  // ── Add reminder_sent_at to tax_filing_calendar ───────────────
  const hasCol = await knex.schema.hasColumn('tax_filing_calendar', 'reminder_sent_at');
  if (!hasCol) {
    await knex.schema.alterTable('tax_filing_calendar', t => {
      t.timestamp('reminder_sent_at');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('mileage_log');

  const hasCol = await knex.schema.hasColumn('tax_filing_calendar', 'reminder_sent_at');
  if (hasCol) {
    await knex.schema.alterTable('tax_filing_calendar', t => {
      t.dropColumn('reminder_sent_at');
    });
  }
};
